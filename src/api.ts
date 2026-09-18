import { CapabilityRegistry, defaultPolicy, normalizeCapability } from "./manifest.js";
import { CachedJevProvider, DemoProvider, HttpJevProvider, OpenRouterJevProvider } from "./provider.js";
import { JevRouter } from "./router.js";
import type { CapabilityInput, CapabilityManifest, JevProvider, PlanMode, PlanStrategy, RouteInput, RoutePlanResult, RouteResult, RouterPolicy } from "./types.js";

export interface RouteOptions {
  candidates?: CapabilityInput[];
  capabilityDir?: string;
  apiKey?: string;
  provider?: "typesafe" | "openrouter" | "demo";
  endpoint?: string;
  model?: string;
  policy?: RouterPolicy;
  cache?: boolean;
}

export interface PlanOptions extends RouteOptions, PlanStrategy {
  steps?: number;
  mode?: PlanMode;
}

/**
 * One-call SDK entrypoint. Pass candidates directly, or let it load the local
 * .jevrouter/capabilities registry. API keys are read from the environment.
 */
export async function route(input: RouteInput, options: RouteOptions = {}): Promise<RouteResult> {
  const rawCandidates = options.candidates ?? input.candidates ?? await new CapabilityRegistry(options.capabilityDir ?? ".jevrouter/capabilities").list();
  const candidates = rawCandidates.map((candidate, index) => normalizeCapability(candidate, `candidates[${index}]`));
  const provider = createProvider(options);
  return new JevRouter(provider, { ...defaultPolicy, ...(options.policy ?? {}) }).route(input, candidates);
}

/**
 * Multi-step plan entrypoint. Same provider/policy wiring as route().
 * Batch mode: one provider call answering all step questions (candidate count
 * must not exceed single_stage_max_candidates). Serial mode: one routing
 * decision per step, with earlier selections fed forward in the state.
 */
export async function plan(input: RouteInput, options: PlanOptions = {}): Promise<RoutePlanResult> {
  const rawCandidates = options.candidates ?? input.candidates ?? await new CapabilityRegistry(options.capabilityDir ?? ".jevrouter/capabilities").list();
  const candidates = rawCandidates.map((candidate, index) => normalizeCapability(candidate, `candidates[${index}]`));
  const provider = createProvider(options);
  return new JevRouter(provider, { ...defaultPolicy, ...(options.policy ?? {}) }).plan(input, candidates, {
    steps: options.steps,
    mode: options.mode,
    sequence: options.sequence,
    diversity_penalty: options.diversity_penalty,
    group_by: options.group_by,
    decompose: options.decompose,
    thread_context: options.thread_context,
    state_detail: options.state_detail,
    plan_hint: options.plan_hint,
  });
}

export function createSdkProvider(options: RouteOptions = {}): JevProvider {
  return createProvider(options);
}

function createProvider(options: RouteOptions): JevProvider {
  const apiKey = resolveApiKey(options);
  let provider: JevProvider;
  if (options.provider === "demo" || (!apiKey && !options.provider)) {
    provider = new DemoProvider();
  } else {
    if (!apiKey) throw new Error("Set JEV_API_KEY/TYPESAFE_API_KEY or pass apiKey");
    const openrouter = options.provider === "openrouter" || (!options.provider && Boolean(process.env.OPENROUTER_API_KEY) && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY);
    provider = openrouter
      ? new OpenRouterJevProvider(apiKey, options.model ?? "~typesafe/jev-latest")
      : new HttpJevProvider({ apiKey, endpoint: options.endpoint, model: options.model ?? "jev-latest" });
  }
  return options.cache === false || process.env.JEV_ROUTER_CACHE === "0" ? provider : new CachedJevProvider(provider);
}

function resolveApiKey(options: RouteOptions): string | undefined {
  if (options.apiKey) return options.apiKey;
  if (options.provider === "openrouter") return process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY;
  if (options.provider === "typesafe") return process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  return process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;
}
