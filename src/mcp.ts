import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { CapabilityManifest, JsonSchema } from "./types.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/**
 * Small stdio MCP discovery adapter. It only performs initialize/tools/list;
 * tool execution stays outside the MVP decision path.
 */
export async function discoverMcpConfig(filePath: string, timeoutMs = 8_000): Promise<CapabilityManifest[]> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
  const servers = parsed.mcpServers ?? {};
  const result: CapabilityManifest[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    const tools = await listMcpTools(config, timeoutMs);
    for (const tool of tools) {
      result.push({
        id: `mcp.${serverName}.${tool.name}`,
        name: tool.name,
        type: "mcp_tool",
        version: "discovered",
        description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
        verification: { status: "discovered", source: "mcp_discovery" },
        input_schema: tool.inputSchema,
        permissions: [`mcp:${serverName}:read`],
        risk: { level: "medium", categories: ["external_tool"] },
        availability: { available: true, healthcheck: true },
        execution: { mode: "mcp", target: serverName, dry_run: true },
        policy: { requires_confirmation: true },
        metadata: { source: "mcp_discovery", server: serverName },
      });
    }
  }
  return result;
}

async function listMcpTools(config: McpServerConfig, timeoutMs: number): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`MCP discovery timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error, tools?: McpTool[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: McpTool[] }; error?: { message?: string } };
          if (message.id === 2) {
            if (message.error) finish(new Error(message.error.message ?? "MCP tools/list failed"));
            else finish(undefined, message.result?.tools ?? []);
          }
        } catch {
          finish(new Error("MCP server returned malformed JSON-RPC"));
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`MCP server exited with code ${code}`));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "jevrouter", version: "0.1.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}
