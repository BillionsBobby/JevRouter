import { appendFile, mkdir, readFile, writeFile, lstat, copyFile } from "node:fs/promises";
import { constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { providerConfiguration } from "./runtime.js";
import type { KeyName } from "./runtime.js";

export type AgentTarget = "codex" | "claude" | "cursor" | "all";
export type AgentProvider = "typesafe" | "openrouter";

export const AGENT_HOST_COMMANDS: Record<"codex" | "claude" | "cursor", readonly string[]> = {
  codex: ["codex"],
  claude: ["claude"],
  cursor: ["agent", "cursor-agent"],
};

export function resolveHostCommand(target: "codex" | "claude" | "cursor", env: NodeJS.ProcessEnv = process.env): string {
  const commands = AGENT_HOST_COMMANDS[target];
  const pathVar = env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = pathVar.split(separator).filter(Boolean);

  for (const dir of dirs) {
    for (const command of commands) {
      for (const ext of extensions) {
        try {
          const stat = statSync(join(dir, command + ext));
          if (stat.isFile()) return command;
        } catch {
          // not found in this dir, continue
        }
      }
    }
  }
  return commands[0];
}
export interface AgentSetupOptions { withMcp?: boolean }
export interface AgentSetupResult {
  agent: "codex" | "claude" | "cursor";
  path: string;
  status: "created" | "updated" | "existing";
  skill_file: string;
  provider_key: string;
}
export interface AgentDoctorResult {
  agent: "codex" | "claude" | "cursor";
  configured: boolean;
  instruction_file: string;
  skill_file: string;
  mcp_file: string | null;
  key_available: boolean;
  provider_key: string;
  issues: string[];
  scope: "local_configuration_only";
}
interface Integration {
  version: 2;
  provider: AgentProvider;
  key: KeyName;
  cli: string;
  with_mcp: boolean;
}
const marker = "<!-- jevrouter:skill-cli-v2 -->";
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const integrationPath = (root: string) => join(root, ".jevrouter/integration-v2.json");
const skillDirectory = (agent: "codex" | "claude" | "cursor", root: string) => {
  if (agent === "codex") return join(root, ".agents/skills/jevrouter");
  if (agent === "cursor") return join(root, ".cursor/skills/jevrouter");
  return join(root, ".claude/skills/jevrouter");
};
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export function renderJevRouterSkill(command = "node bin/jevrouter.mjs"): string {
  return readFileSync(new URL("../skills/jevrouter/SKILL.md", import.meta.url), "utf8").replaceAll("{{JEVROUTER_COMMAND}}", command);
}

export function renderRoutingInstructions(skill = ".agents/skills/jevrouter/SKILL.md"): string {
  return `\n${marker}\n## JevRouter\nBefore the first meaningful choice between tools, models, or subagents, read ${skill} and run its CLI routing procedure on the actual task and available candidates. Announce the start, report the returned decision_id/status, then perform the host-authorized selected step. Re-route when observations change the next choice. Skip trivial chat and a sole user-specified operation. If Jev is unavailable, disclose the failure and explicit fallback; never imply that setup alone routed this task. Higher-priority instructions and host permissions still apply.\n${marker}\n`;
}

function launchArgs(provider?: AgentProvider): string[] {
  return [cliPath, "serve-mcp", "--provider", providerConfiguration(provider).provider];
}
export function renderClaudeServer(provider?: AgentProvider): Record<string, unknown> {
  const { key } = providerConfiguration(provider);
  return { command: process.execPath, args: launchArgs(provider), env: { [key]: "${" + key + "}" } };
}
export function renderCodexConfigBlock(provider?: AgentProvider): string {
  const { key } = providerConfiguration(provider);
  return `[mcp_servers.jevrouter]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(launchArgs(provider))}\nenv_vars = [${JSON.stringify(key)}]\n`;
}

/** Skill and project instructions are the default. No MCP or base-prompt replacement is required. */
export async function setupAgents(target: AgentTarget = "all", root = process.cwd(), provider?: AgentProvider, options: AgentSetupOptions = {}): Promise<AgentSetupResult[]> {
  const targets = targetAgents(target);
  root = resolve(root);
  const selected = providerConfiguration(provider);
  if (selected.provider === "demo") throw new Error("Agent setup requires a real Jev provider");
  await lstat(cliPath); // Reject source-only installs before writing host config.
  const integration: Integration = { version: 2, provider: selected.provider, key: selected.key, cli: cliPath, with_mcp: options.withMcp === true };
  await writeNewOrSame(integrationPath(root), JSON.stringify(integration, null, 2) + "\n");
  const results: AgentSetupResult[] = [];
  for (const agent of targets) {
    const directory = skillDirectory(agent, root);
    const helper = join(directory, "scripts/route.mjs");
    const helperCode = `import { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nconst result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), env: { ...process.env, JEV_ROUTER_PROVIDER: ${JSON.stringify(selected.provider)} }, stdio: 'inherit' });\nif (result.error) console.error('JevRouter launcher failed: ' + result.error.message);\nprocess.exit(result.status ?? 1);\n`;
    await writeNewOrSame(helper, helperCode);
    const skill = join(directory, "SKILL.md");
    await writeNewOrSame(skill, renderJevRouterSkill(`node ${shellQuote(helper)}`));
    const instructions = await instructionPath(agent, root);
    const block = renderRoutingInstructions(skill);
    const current = await readOptional(instructions);
    let status: AgentSetupResult["status"] = "existing";
    if (!current?.includes(block.trim())) {
      if (current?.includes(marker)) throw new Error(`JevRouter instructions differ in ${instructions}; existing content preserved`);
      if (current !== null) {
        // Preserve an exact backup, then append: never truncate user instructions.
        await copyFile(instructions, `${instructions}.jevrouter-backup-${randomUUID()}`, constants.COPYFILE_EXCL);
        await appendFile(instructions, block);
        status = "updated";
      } else {
        await writeNewOrSame(instructions, block);
        status = "created";
      }
    }
    if (options.withMcp) await setupMcp(agent, root, selected.provider);
    results.push({ agent, path: instructions, status, skill_file: skill, provider_key: selected.key });
  }
  return results;
}

/** Read-only structural checks. This does not claim host loading or API authentication. */
export async function doctorAgents(target: AgentTarget = "all", root = process.cwd(), provider?: AgentProvider): Promise<AgentDoctorResult[]> {
  const targets = targetAgents(target);
  root = resolve(root);
  let integration: Integration | null = null;
  const receipt = await readOptional(integrationPath(root));
  try { integration = receipt ? JSON.parse(receipt) as Integration : null; } catch { /* reported below */ }
  const selected = providerConfiguration(provider);
  return Promise.all(targets.map(async agent => {
    const issues: string[] = [];
    if (!integration || integration.version !== 2) issues.push("Run agent setup to install the Skill + CLI integration");
    if (provider && integration && selected.provider !== integration.provider) issues.push("Requested provider differs from installed provider");
    const key = integration?.key ?? selected.key;
    const keyAvailable = Boolean(process.env[key]?.trim());
    if (!keyAvailable) issues.push(`Export ${key} in the Agent process environment`);
    const instructions = await instructionPath(agent, root);
    const skill = join(skillDirectory(agent, root), "SKILL.md");
    const helper = join(skillDirectory(agent, root), "scripts/route.mjs");
    if (!(await readOptional(instructions))?.includes(renderRoutingInstructions(skill).trim())) issues.push(`Missing active project routing rule: ${instructions}`);
    if (!(await readOptional(skill))?.includes("name: jevrouter")) issues.push(`Missing Skill: ${skill}`);
    if (!(await readOptional(helper))?.includes(integration?.cli ?? cliPath)) issues.push(`Missing or stale CLI helper: ${helper}`);
    try { if (integration) await lstat(integration.cli); } catch { issues.push("Installed CLI is no longer present; reinstall JevRouter"); }
    const mcpFile = integration?.with_mcp ? mcpPath(agent, root) : null;
    if (mcpFile) {
      const config = await readOptional(mcpFile);
      if (!config?.includes(integration!.cli) || !config.includes(key)) issues.push(`Missing or stale optional MCP configuration: ${mcpFile}`);
    }
    return { agent, configured: issues.length === 0, instruction_file: instructions, skill_file: skill, mcp_file: mcpFile, key_available: keyAvailable, provider_key: key, issues, scope: "local_configuration_only" as const };
  }));
}

function mcpPath(agent: "codex" | "claude" | "cursor", root: string): string {
  if (agent === "codex") return join(root, ".codex/config.toml");
  if (agent === "cursor") return join(root, ".cursor/mcp.json");
  return join(root, ".mcp.json");
}

async function setupMcp(agent: "codex" | "claude" | "cursor", root: string, provider: AgentProvider): Promise<void> {
  // An existing config may be owned by the user. Write a proposal rather than replacing it.
  const path = mcpPath(agent, root);
  const desired = agent === "codex" ? renderCodexConfigBlock(provider) : JSON.stringify({ mcpServers: { jevrouter: renderClaudeServer(provider) } }, null, 2) + "\n";
  await writeNewOrSame(path, desired);
}
async function instructionPath(agent: "codex" | "claude" | "cursor", root: string): Promise<string> {
  if (agent === "claude") return join(root, "CLAUDE.md");
  if (agent === "cursor") return join(root, ".cursorrules");
  return (await readOptional(join(root, "AGENTS.override.md")))?.trim() ? join(root, "AGENTS.override.md") : join(root, "AGENTS.md");
}
function targetAgents(target: AgentTarget): Array<"codex" | "claude" | "cursor"> {
  if (!["codex", "claude", "cursor", "all"].includes(target)) throw new Error("agent must be codex, claude, cursor, or all");
  return target === "all" ? ["codex", "claude", "cursor"] : [target];
}
async function readOptional(path: string): Promise<string | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to modify or follow symlink: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeNewOrSame(path: string, text: string): Promise<void> {
  const current = await readOptional(path);
  if (current === text) return;
  await mkdir(dirname(path), { recursive: true });
  if (current !== null) {
    const proposal = `${path}.jevrouter-proposed-${randomUUID()}`;
    await writeFile(proposal, text, { flag: "wx", mode: 0o600 });
    throw new Error(`Existing file preserved: ${path}. Review the proposed configuration: ${proposal}`);
  }
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
}
