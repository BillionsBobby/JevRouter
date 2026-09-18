#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityRegistry, defaultPolicy, loadPolicyFile, normalizeCapability } from "./manifest.js";
import { discoverMcpConfig } from "./mcp.js";
import { discoverClis, discoverDsh, discoverSkills } from "./discovery.js";
import { JevRouter } from "./router.js";
import { createProvider } from "./runtime.js";
import { saveDecision, savePlan } from "./store.js";
import type { CapabilityManifest, RouteInput } from "./types.js";
import { startMcpServer } from "./mcp-server.js";
import { doctorAgents, setupAgents } from "./agent-setup.js";

const root = process.cwd();
const registry = new CapabilityRegistry(join(root, ".jevrouter", "capabilities"));

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "init") return await init();
    if (command === "capability") return await capability(rest);
    if (command === "discover") return await discover(rest);
    if (command === "decision") return await decision(rest);
    if (command === "route") return await route(rest);
    if (command === "plan") return await plan(rest);
    if (command === "serve") return await serve(rest);
    if (command === "serve-mcp") return await serveMcp(rest);
    if (command === "agent") return await agent(rest);
    printHelp();
  } catch (error) {
    console.error(`jevrouter: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function init(): Promise<void> {
  await mkdir(join(root, ".jevrouter", "capabilities"), { recursive: true });
  await mkdir(join(root, ".jevrouter", "decisions"), { recursive: true });
  await writeIfMissing(join(root, ".jevrouter", "policy.json"), `${JSON.stringify(defaultPolicy, null, 2)}\n`);
  console.log("Initialized .jevrouter/ (existing files were preserved)");
}

async function capability(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const source = rest[0];
    if (!source) throw new Error("usage: jevrouter capability add <manifest.json|yaml>");
    console.log(await registry.add(source));
    return;
  }
  if (subcommand === "list") {
    console.log(JSON.stringify(await registry.list(), null, 2));
    return;
  }
  throw new Error("usage: jevrouter capability add|list");
}

async function discover(args: string[]): Promise<void> {
  const discovered: CapabilityManifest[] = [];
  const mcpPath = option(args, "--mcp");
  const skillsPath = option(args, "--skills");
  const dshPath = option(args, "--dsh");
  const cliNames = option(args, "--cli");
  if (!mcpPath && !skillsPath && !dshPath && !cliNames) throw new Error("usage: jevrouter discover [--skills <dir>] [--mcp <mcp.json>] [--cli git,docker] [--dsh <dir-or-file>]");
  if (skillsPath) discovered.push(...await discoverSkills(skillsPath));
  if (mcpPath) discovered.push(...await discoverMcpConfig(mcpPath));
  if (cliNames) discovered.push(...await discoverClis(cliNames.split(",")));
  if (dshPath) discovered.push(...await discoverDsh(dshPath));
  for (const manifest of discovered) {
    const path = join(root, ".jevrouter", "capabilities", `${manifest.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    await writeIfMissing(path, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(path);
  }
  if (discovered.length === 0) console.log("No capabilities discovered");
}

async function route(args: string[]): Promise<void> {
  const request = option(args, "--request");
  if (!request) throw new Error("usage: jevrouter route --request \"...\" [--provider demo|typesafe]");
  const policy = await loadPolicyFile(option(args, "--policy") ?? join(root, ".jevrouter", "policy.json"));
  const provider = createProvider(option(args, "--provider"));
  const candidates = await registry.list();
  const actorPermissions = option(args, "--actor-permissions")?.split(",").map((value) => value.trim()).filter(Boolean);
  const actor = option(args, "--actor");
  const inputText = option(args, "--input");
  const input = inputText === undefined ? undefined : JSON.parse(inputText);
  const result = await new JevRouter(provider, policy).route({ request, actor, actor_permissions: actorPermissions, input }, candidates);
  const outputPath = await saveDecision(result);
  console.log(JSON.stringify({ ...result, saved_to: outputPath }, null, 2));
}

async function plan(args: string[]): Promise<void> {
  const request = option(args, "--request");
  if (!request) throw new Error("usage: jevrouter plan --request \"...\" [--steps 5] [--mode batch|serial] [--sequence argmax|beam] [--diversity-penalty 1.0] [--group-by server|type] [--decompose rule] [--state-detail names|targets] [--provider demo|typesafe|openrouter]");
  const steps = option(args, "--steps") === undefined ? undefined : Number(option(args, "--steps"));
  const mode = option(args, "--mode");
  if (mode !== undefined && mode !== "batch" && mode !== "serial") throw new Error("--mode must be batch or serial");
  if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) throw new Error("--steps must be a positive integer");
  const sequence = option(args, "--sequence");
  if (sequence !== undefined && sequence !== "argmax" && sequence !== "beam") throw new Error("--sequence must be argmax or beam");
  const diversityPenalty = option(args, "--diversity-penalty") === undefined ? undefined : Number(option(args, "--diversity-penalty"));
  if (diversityPenalty !== undefined && Number.isNaN(diversityPenalty)) throw new Error("--diversity-penalty must be a number");
  const groupBy = option(args, "--group-by");
  if (groupBy !== undefined && groupBy !== "server" && groupBy !== "type") throw new Error("--group-by must be server or type");
  const decompose = option(args, "--decompose");
  if (decompose !== undefined && decompose !== "rule") throw new Error("--decompose only supports the built-in rule splitter from the CLI");
  const stateDetail = option(args, "--state-detail");
  if (stateDetail !== undefined && stateDetail !== "names" && stateDetail !== "targets") throw new Error("--state-detail must be names or targets");
  const policy = await loadPolicyFile(option(args, "--policy") ?? join(root, ".jevrouter", "policy.json"));
  const provider = createProvider(option(args, "--provider"));
  const candidates = await registry.list();
  const actorPermissions = option(args, "--actor-permissions")?.split(",").map((value) => value.trim()).filter(Boolean);
  const actor = option(args, "--actor");
  const result = await new JevRouter(provider, policy).plan({ request, actor, actor_permissions: actorPermissions }, candidates, {
    steps, mode,
    sequence, diversity_penalty: diversityPenalty,
    group_by: groupBy, decompose: decompose as "rule" | undefined,
    state_detail: stateDetail,
  });
  const outputPath = await savePlan(result);
  console.log(JSON.stringify({ ...result, saved_to: outputPath }, null, 2));
}

async function decision(args: string[]): Promise<void> {
  if (args[0] !== "show" || !args[1]) throw new Error("usage: jevrouter decision show <decision-id>");
  const path = join(root, ".jevrouter", "decisions", args[1].endsWith(".json") ? args[1] : `${args[1]}.json`);
  console.log(await readFile(path, "utf8"));
}

async function serve(args: string[]): Promise<void> {
  const port = Number(option(args, "--port") ?? 8787);
  const policy = await loadPolicyFile(option(args, "--policy") ?? join(root, ".jevrouter", "policy.json"));
  const provider = createProvider(option(args, "--provider"));
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true, provider: provider.name });
      if (request.method === "GET" && request.url === "/capabilities") return sendJson(response, 200, await registry.list());
      if (request.method === "POST" && request.url === "/route") {
        const payload = JSON.parse(await readBody(request)) as RouteInput;
        if (!payload.request || typeof payload.request !== "string") return sendJson(response, 400, { error: "request is required" });
        const candidates = payload.candidates?.map((candidate, index) => normalizeCapability(candidate, `request.candidates[${index}]`)) ?? await registry.list();
        const result = await new JevRouter(provider, policy).route(payload, candidates);
        await saveDecision(result);
        return sendJson(response, 200, result);
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`JevRouter listening at http://127.0.0.1:${port}`));
}

async function serveMcp(args: string[]): Promise<void> {
  const policy = await loadPolicyFile(option(args, "--policy") ?? join(root, ".jevrouter", "policy.json"));
  await startMcpServer({ registry, policy, provider: createProvider(option(args, "--provider")) });
}

async function agent(args: string[]): Promise<void> {
  if (args[0] === "doctor") {
    const target = option(args, "--agent") as "codex" | "claude" | "all" | undefined;
    if (!target || !["codex", "claude", "all"].includes(target)) throw new Error("usage: jevrouter agent doctor --agent codex|claude|all");
    console.log(JSON.stringify(await doctorAgents(target), null, 2));
    return;
  }
  if (args[0] !== "setup") throw new Error("usage: jevrouter agent setup|doctor --agent codex|claude|all");
  const target = option(args, "--agent") as "codex" | "claude" | "all" | undefined;
  if (!target || !["codex", "claude", "all"].includes(target)) throw new Error("--agent must be codex, claude, or all");
  const provider = option(args, "--provider") as "typesafe" | "openrouter" | undefined;
  if (provider !== undefined && provider !== "typesafe" && provider !== "openrouter") throw new Error("--provider must be typesafe or openrouter");
  const results = await setupAgents(target, process.cwd(), provider);
  for (const result of results) console.log(`${result.agent}: ${result.status} ${result.path}`);
  console.log("Export one of JEV_API_KEY, TYPESAFE_API_KEY, or OPENROUTER_API_KEY, then restart the Agent. Keys are not written to these files.");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("request body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  console.log(`JevRouter — local, policy-aware routing for Agent tools

Commands:
  init
  capability add <manifest.json|yaml>
  capability list
  discover [--skills <dir>] [--mcp <mcp.json>] [--cli git,docker] [--dsh <dir-or-file>]
  decision show <decision-id>
  route --request "..." [--input '{"query":"..."}'] [--actor-permissions read,write] [--provider demo|typesafe|openrouter]
  plan --request "..." [--steps 5] [--mode batch|serial] [--provider demo|typesafe|openrouter]
  serve [--port 8787] [--provider demo|typesafe|openrouter]
  serve-mcp [--provider demo|typesafe|openrouter]  stdio MCP server for Agents
  agent setup --agent codex|claude|all [--provider typesafe|openrouter]  configure the Agent MCP entrypoint
  agent doctor --agent codex|claude|all      verify configuration, instructions, and key availability

Environment:
  TYPESAFE_API_KEY or JEV_API_KEY   official Jev API key
  OPENROUTER_API_KEY                OpenRouter Jev endpoint
  JEV_API_URL                        override the official endpoint
`);
}

void main();
