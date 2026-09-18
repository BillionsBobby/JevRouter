import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentTarget = "codex" | "claude" | "all";
export type AgentProvider = "typesafe" | "openrouter";

export interface AgentSetupResult {
  agent: "codex" | "claude";
  path: string;
  status: "created" | "updated" | "existing";
}

export interface AgentDoctorResult {
  agent: "codex" | "claude";
  configured: boolean;
  instruction_file: string;
  mcp_file: string;
  key_available: boolean;
  issues: string[];
}

const serverPackage = process.env.JEVROUTER_PACKAGE ?? "github:BillionsBobby/JevRouter";
const serverArgs = ["-y", serverPackage, "serve-mcp"];
const keyNames = ["JEV_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;
const instructionMarker = "<!-- jevrouter:agent-routing -->";
const routingInstructions = `${instructionMarker}
# JevRouter routing

Before choosing a meaningful model, Tool, Skill, CLI, Subagent, or DSH capability, call the JevRouter MCP tool 'jev_route' with the user's current request and the available candidate descriptors. Prefer native function-tool descriptors when available.

Follow the returned status: execute only the returned 'selected' capability when status is 'selected' or after required confirmation; stop, ask for clarification, or fall back explicitly on 'needs_confirmation' and 'no_decision'. Jev probabilities express uncertainty, not permission. Do not bypass a filtered capability or silently replace a no-decision result.

${instructionMarker}`;

export async function setupAgents(target: AgentTarget, root = process.cwd(), provider?: AgentProvider): Promise<AgentSetupResult[]> {
  const keyName = resolveKeyName(provider);
  const targets = target === "all" ? (["codex", "claude"] as const) : ([target] as const);
  const results: AgentSetupResult[] = [];
  for (const agent of targets) {
    results.push(agent === "codex" ? await setupCodex(root, keyName) : await setupClaude(root, keyName));
  }
  return results;
}

export function renderClaudeServer(provider?: AgentProvider): Record<string, unknown> {
  const keyName = resolveKeyName(provider);
  return {
    command: "npx",
    args: serverArgs,
    env: { [keyName]: `\${${keyName}}` },
  };
}

export function renderCodexConfigBlock(provider?: AgentProvider): string {
  const keyName = resolveKeyName(provider);
  return `[mcp_servers.jevrouter]\ncommand = "npx"\nargs = ["-y", "${serverPackage}", "serve-mcp"]\nenv_vars = ["${keyName}"]\nmodel_instructions_file = "jevrouter-instructions.md"\n`;
}

export function renderRoutingInstructions(): string {
  return `${routingInstructions}\n`;
}

export async function doctorAgents(target: AgentTarget, root = process.cwd()): Promise<AgentDoctorResult[]> {
  const targets = target === "all" ? (["codex", "claude"] as const) : ([target] as const);
  const keyAvailable = keyNames.some((name) => Boolean(process.env[name]));
  return Promise.all(targets.map(async (agent) => {
    const mcpFile = join(root, agent === "codex" ? ".codex/config.toml" : ".mcp.json");
    const instructionFile = join(root, agent === "codex" ? ".codex/jevrouter-instructions.md" : "CLAUDE.md");
    const issues: string[] = [];
    const [mcp, instructions] = await Promise.all([readIfExists(mcpFile), readIfExists(instructionFile)]);
    if (!mcp) issues.push(`missing ${mcpFile}`);
    if (!mcp?.includes("jevrouter")) issues.push(`MCP entry jevrouter not found in ${mcpFile}`);
    if (!instructions?.includes(instructionMarker)) issues.push(`routing instructions not found in ${instructionFile}`);
    if (!keyAvailable) issues.push("no JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY in the current environment");
    return { agent, configured: issues.length === 0, instruction_file: instructionFile, mcp_file: mcpFile, key_available: keyAvailable, issues };
  }));
}

async function setupClaude(root: string, keyName: typeof keyNames[number]): Promise<AgentSetupResult> {
  const path = join(root, ".mcp.json");
  const server = renderClaudeServer(keyName === "OPENROUTER_API_KEY" ? "openrouter" : "typesafe");
  const instructionPath = join(root, "CLAUDE.md");
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    const servers = current.mcpServers ?? {};
    await ensureInstructions(instructionPath);
    if (servers.jevrouter) return { agent: "claude", path, status: "existing" };
    await writeFile(path, `${JSON.stringify({ ...current, mcpServers: { ...servers, jevrouter: server } }, null, 2)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return appendJsonServer(path, server);
    });
    return { agent: "claude", path, status: "updated" };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} exists but is not valid JSON; add jevrouter manually without overwriting it`);
    await writeFile(path, `${JSON.stringify({ mcpServers: { jevrouter: server } }, null, 2)}\n`, { flag: "wx" });
    await ensureInstructions(instructionPath);
    return { agent: "claude", path, status: "created" };
  }
}

async function appendJsonServer(path: string, server: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
  if (current.mcpServers?.jevrouter) return;
  await writeFile(path, `${JSON.stringify({ ...current, mcpServers: { ...(current.mcpServers ?? {}), jevrouter: server } }, null, 2)}\n`);
}

async function setupCodex(root: string, keyName: typeof keyNames[number]): Promise<AgentSetupResult> {
  const directory = join(root, ".codex");
  const path = join(directory, "config.toml");
  await mkdir(directory, { recursive: true });
  const block = renderCodexConfigBlock(keyName === "OPENROUTER_API_KEY" ? "openrouter" : "typesafe");
  await writeIfMissing(join(directory, "jevrouter-instructions.md"), renderRoutingInstructions());
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

async function ensureInstructions(path: string): Promise<void> {
  try {
    const current = await readFile(path, "utf8");
    if (current.includes(instructionMarker)) return;
    await appendFile(path, `${current.endsWith("\n") ? "\n" : "\n\n"}${routingInstructions}\n`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, `${routingInstructions}\n`, { flag: "wx" });
  }
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveKeyName(provider?: AgentProvider): typeof keyNames[number] {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "typesafe") return "TYPESAFE_API_KEY";
  if (process.env.OPENROUTER_API_KEY && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) return "OPENROUTER_API_KEY";
  if (process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY) return "TYPESAFE_API_KEY";
  return "JEV_API_KEY";
}
