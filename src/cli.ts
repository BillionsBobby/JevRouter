#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityRegistry, defaultPolicy, loadPolicyFile, normalizeCapability } from "./manifest.js";
import { discoverMcpConfig } from "./mcp.js";
import { discoverClis, discoverDsh, discoverSkills } from "./discovery.js";
import { JevRouter } from "./router.js";
import { createProvider } from "./runtime.js";
import { saveDecision } from "./store.js";
import type { CapabilityManifest, RouteInput } from "./types.js";
import { startMcpServer } from "./mcp-server.js";
import { doctorAgents, resolveHostCommand, setupAgents } from "./agent-setup.js";
import { parse } from "yaml";
import { probeJev, runPlanRequest, runRouteRequest } from "./route-command.js";
import { ensureAgentCredentials } from "./credentials.js";
import { collectDashboardStats, startDashboardServer } from "./dashboard.js";
import { recordExecutionEvent, type FeedbackEventType } from "./events.js";

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
    if (command === "feedback") return await feedback(rest);
    if (command === "stats") return await stats(rest);
    if (command === "serve") return await serve(rest);
    if (command === "dashboard") return await dashboard(rest);
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
  await mkdir(join(root, ".jevrouter", "events"), { recursive: true });
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
  let payload: Record<string, unknown>;
  if (args.includes("--stdin")) {
    if (process.stdin.isTTY) throw new Error("--stdin requires a piped JSON request");
    payload = JSON.parse(await readText(process.stdin)) as Record<string, unknown>;
  } else {
    const request = option(args, "--request");
    const candidatesFile = option(args, "--candidates-file");
    const inlineCandidates = option(args, "--candidates");
    if (inlineCandidates && candidatesFile) throw new Error("Use --candidates or --candidates-file, not both");
    let candidates: unknown;
    if (candidatesFile || inlineCandidates) {
      const parsed = parse(candidatesFile ? await readFile(candidatesFile, "utf8") : inlineCandidates!);
      candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
      if (!Array.isArray(candidates)) throw new Error("Candidates must be an array or { candidates: [...] }");
    }
    const input = option(args, "--input");
    const context = option(args, "--context");
    payload = { request, candidates, input: input === undefined ? undefined : JSON.parse(input), context: context === undefined ? undefined : JSON.parse(context), actor: option(args, "--actor"), actor_permissions: option(args, "--actor-permissions")?.split(",").filter(Boolean) };
  }
  const result = await runRouteRequest(payload, root, { provider: option(args, "--provider"), policy: option(args, "--policy") }, message => console.error(message));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.error ? 1 : result.status === "selected" ? 0 : 2;
}

async function readText(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 1_000_000) throw new Error("Input exceeds 1 MB");
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function plan(args: string[]): Promise<void> {
  let payload: Record<string, unknown>;
  if (args.includes("--stdin")) {
    if (process.stdin.isTTY) throw new Error("--stdin requires a piped JSON request");
    payload = JSON.parse(await readText(process.stdin)) as Record<string, unknown>;
  } else {
    const request = option(args, "--request");
    const candidatesFile = option(args, "--candidates-file");
    const inlineCandidates = option(args, "--candidates");
    if (inlineCandidates && candidatesFile) throw new Error("Use --candidates or --candidates-file, not both");
    let candidates: unknown;
    if (candidatesFile || inlineCandidates) {
      const parsed = parse(candidatesFile ? await readFile(candidatesFile, "utf8") : inlineCandidates!);
      candidates = Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown[] } | null)?.candidates;
      if (!Array.isArray(candidates)) throw new Error("Candidates must be an array or { candidates: [...] }");
    }
    const steps = option(args, "--steps") === undefined ? undefined : Number(option(args, "--steps"));
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) throw new Error("--steps must be a positive integer");
    const diversityPenalty = option(args, "--diversity-penalty") === undefined ? undefined : Number(option(args, "--diversity-penalty"));
    if (diversityPenalty !== undefined && Number.isNaN(diversityPenalty)) throw new Error("--diversity-penalty must be a number");
    payload = {
      request, candidates, steps,
      mode: option(args, "--mode"),
      sequence: option(args, "--sequence"),
      diversity_penalty: diversityPenalty,
      group_by: option(args, "--group-by"),
      decompose: option(args, "--decompose"),
      state_detail: option(args, "--state-detail"),
      thread_context: args.includes("--thread-context") ? true : undefined,
      context: option(args, "--context") === undefined ? undefined : JSON.parse(option(args, "--context")!),
      actor: option(args, "--actor"),
      actor_permissions: option(args, "--actor-permissions")?.split(",").filter(Boolean),
    };
  }
  const result = await runPlanRequest(payload, root, { provider: option(args, "--provider"), policy: option(args, "--policy") }, message => console.error(message));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.steps.some((step: { error?: unknown }) => step.error) ? 1
    : result.steps.some((step: { status: string }) => step.status !== "selected") ? 2 : 0;
}

async function decision(args: string[]): Promise<void> {
  if (args[0] !== "show" || !args[1]) throw new Error("usage: jevrouter decision show <decision-id>");
  const path = join(root, ".jevrouter", "decisions", args[1].endsWith(".json") ? args[1] : `${args[1]}.json`);
  console.log(await readFile(path, "utf8"));
}

async function feedback(args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i++;
    } else {
      positionals.push(args[i]);
    }
  }
  const [decisionId, eventType] = positionals;
  if (!decisionId || !eventType) {
    throw new Error("usage: jevrouter feedback <decision-id> <event-type> [--details JSON] [--plan <plan-id>]");
  }
  const rawDetails = option(args, "--details");
  let details: Record<string, unknown> | undefined;
  if (rawDetails) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDetails);
    } catch {
      throw new Error("--details must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("--details must be a JSON object");
    }
    details = parsed as Record<string, unknown>;
  }
  const planId = option(args, "--plan");
  const event = await recordExecutionEvent({
    decision_id: decisionId,
    type: eventType as FeedbackEventType,
    plan_id: planId,
    details,
  }, root);
  console.log(JSON.stringify(event, null, 2));
}

async function stats(args: string[]): Promise<void> {
  const isJson = args.includes("--json");
  const dashboardStats = await collectDashboardStats(root);
  if (isJson) {
    console.log(JSON.stringify(dashboardStats, null, 2));
    return;
  }
  const dec = dashboardStats.decisions;
  const exec = dashboardStats.execution;
  console.log(`JevRouter Stats (${dashboardStats.source.root})
Decisions: ${dec.total} (selected: ${dec.by_status.selected ?? 0}, no_decision: ${dec.by_status.no_decision ?? 0}, needs_confirmation: ${dec.by_status.needs_confirmation ?? 0})
Latency: p50 ${dec.p50_elapsed_ms ?? "-"}ms, p95 ${dec.p95_elapsed_ms ?? "-"}ms
Execution: ${exec.outcome} (succeeded: ${exec.succeeded}, failed: ${exec.failed}, started: ${exec.started}, cancelled: ${exec.cancelled}, rerouted: ${exec.rerouted}, not_started: ${exec.not_started})
Plans: ${dashboardStats.plans.total} (${dashboardStats.plans.steps} steps)`);
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
        const candidates = payload.candidates?.map((candidate, index) => normalizeCapability(candidate, `request.candidates[${index}]`, message => console.error(message))) ?? await registry.list();
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

async function dashboard(args: string[]): Promise<void> {
  const port = Number(option(args, "--port") ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be between 1 and 65535");
  const server = await startDashboardServer(root, port);
  console.log(`JevRouter dashboard at http://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => server.once("close", resolve));
}

async function serveMcp(args: string[]): Promise<void> {
  const policy = await loadPolicyFile(option(args, "--policy") ?? join(root, ".jevrouter", "policy.json"));
  await startMcpServer({ registry, policy, provider: createProvider(option(args, "--provider")) });
}

async function agent(args: string[]): Promise<void> {
  const action = args[0];
  if (!["setup", "doctor", "start"].includes(action)) throw new Error("usage: jevrouter agent setup|doctor|start [--agent codex|claude|cursor|all]");
  const target = (option(args, "--agent") ?? "all") as "codex" | "claude" | "cursor" | "all";
  if (!["codex", "claude", "cursor", "all"].includes(target)) throw new Error("--agent must be codex, claude, cursor, or all");
  if (action === "start" && target === "all") throw new Error("agent start requires --agent codex, --agent claude, or --agent cursor");
  const provider = option(args, "--provider") as "typesafe" | "openrouter" | undefined;
  if (provider !== undefined && !["typesafe", "openrouter"].includes(provider)) throw new Error("--provider must be typesafe or openrouter");
  if (action === "doctor") {
    const results = await doctorAgents(target, root, provider);
    const live = args.includes("--live") ? await probeJev(provider, m => console.error(m)) : null;
    console.log(JSON.stringify({ configuration: results, live }, null, 2));
    if (results.some(r => !r.configured)) process.exitCode = 1;
    return;
  }
  const resolvedProvider = args.includes("--skip-check") ? provider : await ensureAgentCredentials(provider);
  const check = args.includes("--skip-check") ? null : await probeJev(resolvedProvider, m => console.error(m));
  const results = await setupAgents(target, root, resolvedProvider, { withMcp: args.includes("--with-mcp") });
  console.log(JSON.stringify({ status: "installed", check, files: results }, null, 2));
  console.error("JevRouter READY. Use $jevrouter in Codex, /jevrouter in Claude Code, or @jevrouter in Cursor. Keep the key exported in the Agent environment. Setup does not route later tasks by itself.");
  if (action === "start") {
    if (target === "all") throw new Error("agent start requires --agent codex, --agent claude, or --agent cursor");
    const prompt = option(args, "--request");
    const hostArgs = prompt ? ["--", prompt] : [];
    const command = resolveHostCommand(target);
    console.error(`JevRouter START host=${target} (key inherited; no key stored)`);
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, hostArgs, { cwd: root, env: process.env, stdio: "inherit", shell: false });
      child.once("error", () => reject(new Error(`${target} is not installed or could not start. Skill installed; launch the host after installing it.`)));
      child.once("exit", code => resolve(code ?? 1));
    });
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
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
  route --stdin | --request "..." [--candidates-file ./candidates.json] [--candidates JSON] [--input '{"query":"..."}'] [--actor-permissions read,write] [--provider demo|typesafe|openrouter]
  plan --stdin | --request "..." [--candidates-file ./candidates.json] [--candidates JSON] [--steps 5] [--mode batch|serial]
       [--sequence argmax|beam] [--diversity-penalty 1.0] [--group-by server|type] [--decompose rule] [--thread-context]
       [--state-detail names|targets] [--provider demo|typesafe|openrouter]
  feedback <decision-id> <event-type> [--details JSON] [--plan <plan-id>]
  stats [--json]
  serve [--port 8787] [--provider demo|typesafe|openrouter]
  dashboard [--port 8788]  local read-only receipt dashboard (no Jev key required)
  serve-mcp [--provider demo|typesafe|openrouter]  stdio MCP server for Agents
  agent setup [--agent codex|claude|cursor|all] [--provider typesafe|openrouter] [--skip-check] [--with-mcp]
  agent start --agent codex|claude|cursor [--request "..."]  check Jev, install Skill, launch host
  agent doctor [--agent codex|claude|cursor|all] [--live]   configuration check; optional real Jev probe

Environment:
  TYPESAFE_API_KEY or JEV_API_KEY   official Jev API key
  OPENROUTER_API_KEY                OpenRouter Jev endpoint
  JEV_API_URL                        override the official endpoint
`);
}

void main();
