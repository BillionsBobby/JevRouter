import { join } from "node:path";
import { CapabilityRegistry, loadPolicyFile, normalizeCapability } from "./manifest.js";
import { JevRouter } from "./router.js";
import { createProvider } from "./runtime.js";
import { saveDecision, savePlan } from "./store.js";
import type { CapabilityManifest, PlanMode, PlanStrategy, RouteInput } from "./types.js";

export interface RouteCommandOptions { provider?: string; policy?: string; }
type Progress = (message: string) => void;

interface CandidatesPayload {
  request?: unknown;
  candidates?: unknown;
  actor_permissions?: unknown;
  context?: unknown;
}

async function resolveCandidates(payload: CandidatesPayload, root: string, warn: Progress = () => {}): Promise<CapabilityManifest[]> {
  if (payload.candidates !== undefined && !Array.isArray(payload.candidates)) throw new Error("candidates must be an array");
  const candidates = payload.candidates === undefined
    ? await new CapabilityRegistry(join(root, ".jevrouter/capabilities")).list()
    : payload.candidates.map((candidate, index) => normalizeCapability(candidate, `candidates[${index}]`, warn));
  if (candidates.length === 0) throw new Error("No candidates: pass this Agent's real capabilities using --stdin or --candidates-file. Jev was not called.");
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error("Candidate IDs must be unique");
  return candidates;
}

export async function runRouteRequest(payload: unknown, root: string, options: RouteCommandOptions = {}, progress: Progress = () => {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a route request object");
  const input = payload as RouteInput;
  if (typeof input.request !== "string" || !input.request.trim()) throw new Error("request must be a non-empty string describing this task");
  if (input.context !== undefined && (!input.context || typeof input.context !== "object" || Array.isArray(input.context))) throw new Error("context must be an object");
  if (input.actor_permissions !== undefined && (!Array.isArray(input.actor_permissions) || input.actor_permissions.some(x => typeof x !== "string"))) throw new Error("actor_permissions must be an array of strings");
  const candidates = await resolveCandidates(input, root, progress);
  const provider = createProvider(options.provider ?? process.env.JEV_ROUTER_PROVIDER, { cache: false });
  const policy = await loadPolicyFile(options.policy ?? join(root, ".jevrouter/policy.json"));
  progress(`JevRouter START provider=${provider.name} candidates=${candidates.length}`);
  const started = performance.now();
  const result = await new JevRouter(provider, policy).route(input, candidates);
  const runtime = { source: provider.name === "jevrouter-demo" ? "demo" : "live", provider_response_received: result.raw_jev !== null, elapsed_ms: Math.round(performance.now() - started), cache: false };
  const receipt = { ...result, runtime, routing_input: { request: input.request, context: input.context, candidate_ids: candidates.map(c => c.id) } };
  const saved_to = await saveDecision(receipt, join(root, ".jevrouter/decisions"));
  progress(`JevRouter END status=${result.status} decision_id=${result.decision_id} selected=${result.decision.selected ?? "none"}`);
  return { ...receipt, saved_to };
}

export interface PlanRequestPayload extends CandidatesPayload {
  steps?: unknown;
  mode?: unknown;
  sequence?: unknown;
  diversity_penalty?: unknown;
  group_by?: unknown;
  decompose?: unknown;
  thread_context?: unknown;
  state_detail?: unknown;
  plan_hint?: unknown;
}

/** plan() 的 CLI/stdin 载荷入口：与 runRouteRequest 相同的候选解析、校验与回执语义。 */
export async function runPlanRequest(payload: unknown, root: string, options: RouteCommandOptions = {}, progress: Progress = () => {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a plan request object");
  const input = payload as PlanRequestPayload;
  if (typeof input.request !== "string" || !input.request.trim()) throw new Error("request must be a non-empty string describing this task");
  if (input.context !== undefined && (!input.context || typeof input.context !== "object" || Array.isArray(input.context))) throw new Error("context must be an object");
  if (input.actor_permissions !== undefined && (!Array.isArray(input.actor_permissions) || input.actor_permissions.some(x => typeof x !== "string"))) throw new Error("actor_permissions must be an array of strings");
  const steps = input.steps === undefined ? undefined : Number(input.steps);
  if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) throw new Error("steps must be a positive integer");
  const mode = input.mode as PlanMode | undefined;
  if (mode !== undefined && !["batch", "serial"].includes(mode)) throw new Error("mode must be batch or serial");
  const sequence = input.sequence as PlanStrategy["sequence"];
  if (sequence !== undefined && !["argmax", "beam"].includes(sequence)) throw new Error("sequence must be argmax or beam");
  const diversityPenalty = input.diversity_penalty === undefined ? undefined : Number(input.diversity_penalty);
  if (diversityPenalty !== undefined && (Number.isNaN(diversityPenalty) || diversityPenalty < 0)) throw new Error("diversity_penalty must be a non-negative number");
  const groupBy = input.group_by as PlanStrategy["group_by"];
  if (groupBy !== undefined && !["server", "type"].includes(groupBy)) throw new Error("group_by must be server or type");
  const decompose = input.decompose as PlanStrategy["decompose"];
  if (decompose !== undefined && decompose !== "rule") throw new Error("decompose from CLI/stdin only supports the built-in rule splitter");
  const stateDetail = input.state_detail as PlanStrategy["state_detail"];
  if (stateDetail !== undefined && !["names", "targets"].includes(stateDetail)) throw new Error("state_detail must be names or targets");
  if (input.plan_hint !== undefined && (!Array.isArray(input.plan_hint) || input.plan_hint.some(x => typeof x !== "string"))) throw new Error("plan_hint must be an array of strings");
  const threadContext = input.thread_context === undefined ? undefined : Boolean(input.thread_context);
  const candidates = await resolveCandidates(input, root, progress);
  const provider = createProvider(options.provider ?? process.env.JEV_ROUTER_PROVIDER, { cache: false });
  const policy = await loadPolicyFile(options.policy ?? join(root, ".jevrouter/policy.json"));
  progress(`JevRouter START provider=${provider.name} candidates=${candidates.length} mode=${mode ?? (decompose ? "decompose" : "serial")} steps=${steps ?? 3}`);
  const started = performance.now();
  const result = await new JevRouter(provider, policy).plan(
    { request: input.request as string, context: input.context as RouteInput["context"], actor: (input as RouteInput).actor, actor_permissions: input.actor_permissions as string[] | undefined },
    candidates,
    { steps, mode, sequence, diversity_penalty: diversityPenalty, group_by: groupBy, decompose, state_detail: stateDetail, thread_context: threadContext, plan_hint: input.plan_hint as string[] | undefined },
  );
  const usage = collectPlanUsage(result);
  const runtime = { source: provider.name === "jevrouter-demo" ? "demo" : "live", provider_response_received: result.steps.some(s => s.raw_jev !== null || result.raw_jev !== null), elapsed_ms: Math.round(performance.now() - started), cache: false, usage };
  const receipt = { ...result, runtime, routing_input: { request: input.request, context: input.context, candidate_ids: candidates.map(c => c.id) } };
  const saved_to = await savePlan(receipt, join(root, ".jevrouter/plans"));
  const selected = result.steps.map(s => s.decision.selected ?? "none").join(",");
  progress(`JevRouter END plan_id=${result.plan_id} steps=${result.steps.length} selected=${selected}`);
  return { ...receipt, saved_to };
}

function collectPlanUsage(result: { steps: { raw_jev: unknown }[]; raw_jev: unknown }): Record<string, number> {
  const totals = { input_tokens: 0, output_tokens: 0, cost: 0 };
  const envelopes = result.raw_jev ? [result.raw_jev] : result.steps.map(s => s.raw_jev);
  for (const raw of envelopes) {
    const usage = (raw as { usage?: Record<string, number> } | null)?.usage ?? {};
    totals.input_tokens += usage.input_tokens ?? 0;
    totals.output_tokens += usage.output_tokens ?? 0;
    totals.cost += usage.cost ?? 0;
  }
  return totals;
}

/** A labelled connection check with two fixed options. It never claims to route a user task. */
export async function probeJev(provider?: string, progress: Progress = () => {}) {
  const client = createProvider(provider, { cache: false });
  if (client.name === "jevrouter-demo") throw new Error("Connection check requires a real provider");
  const candidates: CapabilityManifest[] = [
    { id: "ready", name: "Ready", type: "skill", description: "Select when the state says READY" },
    { id: "not_ready", name: "Not ready", type: "skill", description: "Select when the state says NOT READY" },
  ];
  progress(`JevRouter CHECK start provider=${client.name}`);
  const result = await new JevRouter(client).route({ request: "Connection check: state is READY. Select ready." }, candidates);
  if (result.error || result.decision.selected !== "ready") throw new Error(`Jev connection check failed (${result.error?.code ?? result.status}); no Agent configuration installed`);
  progress(`JevRouter CHECK passed decision_id=${result.decision_id}`);
  return { source: "live", purpose: "connection_check", decision_id: result.decision_id, provider: client.name, model: result.raw_jev?.model, usage: result.raw_jev?.usage };
}
