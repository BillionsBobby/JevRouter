import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentTarget = "codex" | "claude" | "all";

export interface AgentSetupResult {
  agent: "codex" | "claude";
  path: string;
  status: "created" | "updated" | "existing";
}

const serverArgs = ["-y", "jevrouter", "serve-mcp"];

export async function setupAgents(target: AgentTarget, root = process.cwd()): Promise<AgentSetupResult[]> {
  const targets = target === "all" ? (["codex", "claude"] as const) : ([target] as const);
  const results: AgentSetupResult[] = [];
  for (const agent of targets) {
    results.push(agent === "codex" ? await setupCodex(root) : await setupClaude(root));
  }
  return results;
}

export function renderClaudeServer(): Record<string, unknown> {
  return {
    command: "npx",
    args: serverArgs,
    env: { JEV_API_KEY: "${JEV_API_KEY}" },
  };
}

export function renderCodexConfigBlock(): string {
  return `[mcp_servers.jevrouter]\ncommand = "npx"\nargs = ["-y", "jevrouter", "serve-mcp"]\nenv_vars = ["JEV_API_KEY"]\n`;
}

async function setupClaude(root: string): Promise<AgentSetupResult> {
  const path = join(root, ".mcp.json");
  const server = renderClaudeServer();
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    const servers = current.mcpServers ?? {};
    if (servers.jevrouter) return { agent: "claude", path, status: "existing" };
    await writeFile(path, `${JSON.stringify({ ...current, mcpServers: { ...servers, jevrouter: server } }, null, 2)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return appendJsonServer(path, server);
    });
    return { agent: "claude", path, status: "updated" };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} exists but is not valid JSON; add jevrouter manually without overwriting it`);
    await writeFile(path, `${JSON.stringify({ mcpServers: { jevrouter: server } }, null, 2)}\n`, { flag: "wx" });
    return { agent: "claude", path, status: "created" };
  }
}

async function appendJsonServer(path: string, server: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
  if (current.mcpServers?.jevrouter) return;
  await writeFile(path, `${JSON.stringify({ ...current, mcpServers: { ...(current.mcpServers ?? {}), jevrouter: server } }, null, 2)}\n`);
}

async function setupCodex(root: string): Promise<AgentSetupResult> {
  const directory = join(root, ".codex");
  const path = join(directory, "config.toml");
  await mkdir(directory, { recursive: true });
  const block = renderCodexConfigBlock();
  try {
    const current = await readFile(path, "utf8");
    if (/\[mcp_servers\.jevrouter\]/.test(current)) return { agent: "codex", path, status: "existing" };
    await appendFile(path, `${current.endsWith("\n") ? "\n" : "\n\n"}${block}`);
    return { agent: "codex", path, status: "updated" };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, `# JevRouter project MCP configuration\n${block}`, { flag: "wx" });
    return { agent: "codex", path, status: "created" };
  }
}
