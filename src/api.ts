import { CapabilityRegistry, defaultPolicy, normalizeCapability } from "./manifest.js";
import { createProvider as runtimeProvider } from "./runtime.js";
import { JevRouter } from "./router.js";
import type { CapabilityInput, CapabilityManifest, JevProvider, JevRawResponse, JevRouteQuestion, PlanMode, PlanStrategy, RouteInput, RoutePlanResult, RouteResult, RouterPolicy, StateValue } from "./types.js";

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

export interface EvaluateInput {
  /** Content to evaluate: a string, JSON object, or array of text values (Jev is text-only). */
  state: StateValue;
  /** Question batch keyed by name; Choice criteria default to `candidates` when omitted. */
  questions: Record<string, JevRouteQuestion>;
  /** Optional candidates used as Choice criteria when a question has no explicit criteria. */
  candidates?: CapabilityInput[];
  model?: string;
}

/**
 * Direct typed-decision entrypoint over all three Jev primitives (Choice,
 * Score, Noul). One provider call answers every question against the same
 * state; use getChoiceAnswer/getScoreAnswer/getNoulAnswer to read typed
 * answers out of the raw response.
 */
export async function evaluate(input: EvaluateInput, options: RouteOptions = {}): Promise<JevRawResponse> {
  const candidates = (options.candidates ?? input.candidates ?? []).map((candidate, index) => normalizeCapability(candidate, `candidates[${index}]`));
  const provider = createProvider(options);
  return provider.decide({ state: input.state, candidates, questions: input.questions, model: input.model });
}

export function createSdkProvider(options: RouteOptions = {}): JevProvider {
  return createProvider(options);
}

function createProvider(options: RouteOptions): JevProvider {
  return runtimeProvider(options.provider, options);
}
