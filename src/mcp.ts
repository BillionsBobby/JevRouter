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

const MCP_PROTOCOL_VERSION = "2024-11-05";

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
    let requestId = 1;
    let pending: { id: number; method: "initialize" | "tools/list" } = { id: requestId, method: "initialize" };
    const tools: McpTool[] = [];
    const seenCursors = new Set<string>();
    const timer = setTimeout(() => finish(new Error(`MCP discovery timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error, tools?: McpTool[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };

    const write = (message: Record<string, unknown>) => {
      if (!settled) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };

    const requestTools = (cursor?: string) => {
      requestId += 1;
      pending = { id: requestId, method: "tools/list" };
      write({ id: requestId, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
    };

    const handleMessage = (line: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        finish(new Error("MCP server returned malformed JSON-RPC"));
        return;
      }
      if (message.id !== pending.id) return;
      if (isRecord(message.error)) {
        const detail = typeof message.error.message === "string" ? message.error.message : "unknown JSON-RPC error";
        finish(new Error(`MCP ${pending.method} failed: ${detail}`));
        return;
      }
      if (!isRecord(message.result)) {
        finish(new Error(`MCP ${pending.method} response has no result object`));
        return;
      }

      if (pending.method === "initialize") {
        if (message.result.protocolVersion !== MCP_PROTOCOL_VERSION) {
          finish(new Error(`MCP server selected unsupported protocol version ${String(message.result.protocolVersion)}`));
          return;
        }
        if (!isRecord(message.result.capabilities)) {
          finish(new Error("MCP initialize response has no capabilities object"));
          return;
        }
        write({ method: "notifications/initialized", params: {} });
        if (!isRecord(message.result.capabilities.tools)) {
          finish(undefined, []);
          return;
        }
        requestTools();
        return;
      }

      if (!Array.isArray(message.result.tools)) {
        finish(new Error("MCP tools/list response has no tools array"));
        return;
      }
      for (const [index, value] of message.result.tools.entries()) {
        if (!isRecord(value) || typeof value.name !== "string" || !value.name) {
          finish(new Error(`MCP tools/list returned an invalid tool at index ${index}`));
          return;
        }
        tools.push({
          name: value.name,
          description: typeof value.description === "string" ? value.description : undefined,
          inputSchema: isRecord(value.inputSchema) ? value.inputSchema as JsonSchema : undefined,
        });
      }
      if (!Object.prototype.hasOwnProperty.call(message.result, "nextCursor")) {
        finish(undefined, tools);
        return;
      }
      if (typeof message.result.nextCursor !== "string") {
        finish(new Error("MCP tools/list nextCursor must be a string"));
        return;
      }
      if (seenCursors.has(message.result.nextCursor)) {
        finish(new Error(`MCP tools/list cursor cycle detected for ${message.result.nextCursor}`));
        return;
      }
      seenCursors.add(message.result.nextCursor);
      requestTools(message.result.nextCursor);
    };

    const consumeBuffer = (final = false) => {
      const lines = buffer.split("\n");
      buffer = final ? "" : lines.pop() ?? "";
      const complete = lines;
      for (const line of complete) {
        if (!line.trim() || settled) continue;
        handleMessage(line);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      consumeBuffer();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      consumeBuffer(true);
      if (!settled) {
        const outcome = signal ? `signal ${signal}` : `code ${String(code)}`;
        finish(new Error(`MCP server exited with ${outcome} before discovery completed`));
      }
    });
    child.stdin.on("error", (error) => finish(error));
    write({ id: requestId, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "jevrouter", version: "0.1.0" } } });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
