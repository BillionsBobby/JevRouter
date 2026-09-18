import { join } from "node:path";
import { CapabilityRegistry, loadPolicyFile, normalizeCapability } from "./manifest.js";
import { JevRouter } from "./router.js";
import { createProvider } from "./runtime.js";
import { saveDecision } from "./store.js";
import type { CapabilityManifest, RouteInput } from "./types.js";

export interface RouteCommandOptions { provider?: string; policy?: string; }
type Progress = (message: string) => void;

export async function runRouteRequest(payload: unknown, root: string, options: RouteCommandOptions = {}, progress: Progress = () => {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a route request object");
  const input = payload as RouteInput;
  if (typeof input.request !== "string" || !input.request.trim()) throw new Error("request must be a non-empty string describing this task");
  if (input.context !== undefined && (!input.context || typeof input.context !== "object" || Array.isArray(input.context))) throw new Error("context must be an object");
  if (input.candidates !== undefined && !Array.isArray(input.candidates)) throw new Error("candidates must be an array");
  if (input.actor_permissions !== undefined && (!Array.isArray(input.actor_permissions) || input.actor_permissions.some(x => typeof x !== "string"))) throw new Error("actor_permissions must be an array of strings");
  const candidates = input.candidates === undefined
    ? await new CapabilityRegistry(join(root, ".jevrouter/capabilities")).list()
    : input.candidates.map((candidate, index) => normalizeCapability(candidate, `candidates[${index}]`));
  if (candidates.length === 0) throw new Error("No candidates: pass this Agent's real capabilities using --stdin or --candidates-file. Jev was not called.");
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error("Candidate IDs must be unique");
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
