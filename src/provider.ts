import type {
  CapabilityManifest,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevRawResponse,
  JevRouteQuestion,
  JevScoreAnswer,
  JevProvider,
  JevRouteRequest,
} from "./types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp, sha256 } from "./utils.js";

export const DEFAULT_TOOL_QUESTION = "tool";
export const DEFAULT_QUESTION_INSTRUCTIONS = "Which single capability should handle this request? Choose only from the supplied options.";

/** Build the questions payload: the caller-supplied batch, or the single default tool question.
 * Supports all three Jev primitives (Choice, Score, Noul) per the TypeSafe docs. */
function buildQuestions(request: JevRouteRequest): Record<string, Record<string, unknown>> {
  const requested: Record<string, JevRouteQuestion> = request.questions ?? { [DEFAULT_TOOL_QUESTION]: {} };
  return Object.fromEntries(
    Object.entries(requested).map(([key, question]) => {
      const type = question.type ?? "choice";
      if (type === "score") {
        if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
          throw new Error(`questions.${key}: score questions require a non-empty criteria array of ordered levels`);
        }
        return [key, { type: "score", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS, criteria: question.criteria }];
      }
      if (type === "noul") {
        const payload: Record<string, unknown> = { type: "noul", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS };
        if (question.criteria !== undefined) payload.criteria = question.criteria;
        return [key, payload];
      }
      const criteria = question.criteria ?? Object.fromEntries(
        request.candidates.map((candidate) => [candidate.id, describeCapability(candidate)]),
      );
      if (Object.keys(criteria).length === 0) {
        throw new Error(`questions.${key}: choice questions need at least one criterion (supply candidates or an explicit criteria map)`);
      }
      return [key, { type: "choice", instructions: question.instructions ?? DEFAULT_QUESTION_INSTRUCTIONS, criteria }];
    }),
  );
}

export class JevProviderError extends Error {
  constructor(
    public readonly code: "jev_auth_error" | "jev_timeout" | "jev_malformed_response" | "jev_http_error",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "JevProviderError";
  }
}

export interface HttpJevProviderOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  // IPv4 loopback: 127.0.0.0/8 (127.0.0.1 - 127.255.255.255)
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/.test(host)) {
    return true;
  }
  return false;
}

export function validateEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid Jev endpoint URL: "${endpoint}". Endpoints must be valid HTTPS URLs or HTTP on loopback.`);
  }

  if (url.protocol === "https:") {
    return endpoint;
  }

  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return endpoint;
  }

  throw new Error(`Insecure Jev endpoint rejected: "${endpoint}". Configured endpoints must use HTTPS to safeguard credentials, unless connecting to loopback (localhost, 127.0.0.1, [::1]).`);
}

export class HttpJevProvider implements JevProvider {
  readonly name = "typesafe";
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpJevProviderOptions) {
    this.endpoint = validateEndpoint(options.endpoint ?? "https://api.typesafe.ai/v1/systemone");
    this.model = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: request.state,
        model: request.model ?? this.model,
        questions: buildQuestions(request),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new JevProviderError("jev_timeout", `Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw new JevProviderError("jev_http_error", error instanceof Error ? error.message : String(error));
    });

    if (response.status === 401 || response.status === 403) {
      throw new JevProviderError("jev_auth_error", "Jev provider rejected the API key", response.status);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new JevProviderError("jev_http_error", `Jev provider returned HTTP ${response.status}: ${body.slice(0, 240)}`, response.status);
    }
    const raw = (await response.json()) as unknown;
    if (!isJevRawResponse(raw)) throw new JevProviderError("jev_malformed_response", "Jev response is not an object");
    return raw;
  }
}

/** OpenRouter's native Decisions adapter. It uses the same typed request/response
 * shape as TypeSafe's endpoint, but through OpenRouter's alpha decisions route. */
export class OpenRouterJevProvider implements JevProvider {
  readonly name: string;
  readonly model: string;
  constructor(
    private readonly apiKey: string,
    model = "~typesafe/jev-latest",
    private readonly timeoutMs = 20_000,
  ) {
    this.model = model;
    this.name = `openrouter:${model}`;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/jevrouter/jevrouter",
        "X-OpenRouter-Title": "JevRouter",
      },
      body: JSON.stringify({
        state: request.state,
        model: request.model ?? this.model,
        questions: buildQuestions(request),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new JevProviderError("jev_timeout", `OpenRouter request timed out after ${this.timeoutMs}ms`);
      throw new JevProviderError("jev_http_error", error instanceof Error ? error.message : String(error));
    });
    if (response.status === 401 || response.status === 403) throw new JevProviderError("jev_auth_error", "OpenRouter rejected the API key", response.status);
    if (!response.ok) throw new JevProviderError("jev_http_error", `OpenRouter returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`, response.status);
    const envelope = (await response.json()) as Record<string, unknown>;
    const answers = envelope.answers;
    if (!answers || typeof answers !== "object") throw new JevProviderError("jev_malformed_response", "OpenRouter Decisions response has no answers");
    return {
      ...envelope,
      model: typeof envelope.model === "string" ? envelope.model : this.model,
      answers: answers as Record<string, unknown>,
      usage: envelope.usage as Record<string, unknown> | undefined,
      _openrouter: { id: envelope.id, provider: "openrouter", model: envelope.model },
    };
  }
}

/** Persistent local cache keyed by the exact provider input and candidate snapshot. */
export class CachedJevProvider implements JevProvider {
  readonly name: string;
  constructor(
    private readonly inner: JevProvider,
    private readonly directory = ".jevrouter/.cache",
  ) {
    this.name = inner.name;
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const effectiveModel = request.model ?? this.inner.model ?? null;
    const key = sha256({
      provider: this.inner.name,
      model: effectiveModel,
      state: request.state,
      candidates: request.candidates,
      questions: request.questions ?? null,
    });
    const path = join(this.directory, `${key.slice("sha256:".length)}.json`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as JevRawResponse;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const response = await this.inner.decide(request);
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify(response)}\n`, { flag: "wx" });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return response;
  }
}

/** Offline provider for local demos. It is intentionally labelled and must not be treated as Jev. */
export class DemoProvider implements JevProvider {
  readonly name = "jevrouter-demo";
  readonly model = "jevrouter-demo";

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    const requestTokens = tokenize(stateToText(request.state));
    const requested: Record<string, JevRouteQuestion> = request.questions ?? { [DEFAULT_TOOL_QUESTION]: {} };
    const answers = Object.fromEntries(Object.entries(requested).map(([key, question]) => {
      if ((question.type ?? "choice") === "choice") {
        const criteria = question.criteria ?? Object.fromEntries(
          request.candidates.map((candidate) => [candidate.id, describeCapability(candidate)]),
        );
        if (Object.keys(criteria).length === 0) {
          throw new Error(`questions.${key}: choice questions need at least one criterion (supply candidates or an explicit criteria map)`);
        }
        const rawScores = Object.entries(criteria).map(([id, criterion]) => ({
          id,
          score: [...requestTokens].filter((token) => tokenize(stateToText(criterion)).has(token)).length + 0.01,
        }));
        const total = rawScores.reduce((sum, item) => sum + item.score, 0);
        const probabilities = Object.fromEntries(rawScores.map(({ id, score }) => [id, score / total]));
        const choice = [...rawScores].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id ?? "";
        const top = choice ? probabilities[choice] : 0;
        const confidence = rawScores.length <= 1
          ? 1
          : clamp((top - 1 / rawScores.length) / Math.max(1 - 1 / rawScores.length, 0.0001));
        const choiceAnswer: JevChoiceAnswer = { type: "choice", choice, probabilities, confidence };
        return [key, choiceAnswer];
      }
      if (question.type === "score") {
        const levels = Array.isArray(question.criteria) ? question.criteria : [];
        if (levels.length === 0) {
          throw new Error(`questions.${key}: score questions require a non-empty criteria array of ordered levels`);
        }
        const levelScores = levels.map((level) => [...requestTokens].filter((token) => tokenize(stateToText(level)).has(token)).length + 0.01);
        const levelTotal = levelScores.reduce((sum, score) => sum + score, 0);
        const levelProbabilities = Object.fromEntries(levelScores.map((score, index) => [String(index), levelTotal ? score / levelTotal : 0]));
        const expected = levelScores.reduce((sum, score, index) => sum + index * (levelTotal ? score / levelTotal : 0), 0);
        return [key, { type: "score", score: expected, probabilities: levelProbabilities, confidence: 1, legend: Object.fromEntries(levels.map((level, index) => [String(index), level])) }];
      }
      if (question.type === "noul") {
        const criteria = question.criteria ?? { true: "true", false: "false" };
        const trueScore = [...requestTokens].filter((token) => tokenize(stateToText(criteria.true)).has(token)).length + 0.01;
        const falseScore = [...requestTokens].filter((token) => tokenize(stateToText(criteria.false)).has(token)).length + 0.01;
        return [key, { type: "noul", noul: clamp(trueScore / (trueScore + falseScore)) }];
      }
      throw new Error(`questions.${key}: unsupported question type`);
    }));
    return {
      model: "jevrouter-demo",
      answers,
      usage: { input_tokens: stateToText(request.state).length, output_tokens: 0 },
    };
  }
}

function stateToText(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state) ?? String(state);
}

export function getChoiceAnswer(raw: JevRawResponse, key: string = DEFAULT_TOOL_QUESTION): JevChoiceAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "choice" || typeof value.choice !== "string" || !value.probabilities || typeof value.probabilities !== "object") {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Choice answer`);
  }
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value.probabilities as Record<string, unknown>)) {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new JevProviderError("jev_malformed_response", `Invalid probability for ${key}`);
    }
    probabilities[key] = probability;
  }
  const confidence = typeof value.confidence === "number" ? value.confidence : Math.max(...Object.values(probabilities), 0);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new JevProviderError("jev_malformed_response", "Invalid confidence");
  }
  return { ...(value as JevChoiceAnswer), type: "choice", choice: value.choice, probabilities, confidence };
}

export function getScoreAnswer(raw: JevRawResponse, key: string): JevScoreAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "score" || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0) {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Score answer`);
  }
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1)) {
    throw new JevProviderError("jev_malformed_response", `Invalid confidence for answers.${key}`);
  }
  return { ...(value as JevScoreAnswer), type: "score", score: value.score };
}

export function getNoulAnswer(raw: JevRawResponse, key: string): JevNoulAnswer {
  const answer = raw.answers?.[key];
  if (!answer || typeof answer !== "object") throw new JevProviderError("jev_malformed_response", `Jev response is missing answers.${key}`);
  const value = answer as Record<string, unknown>;
  if (value.type !== "noul" || typeof value.noul !== "number" || !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) {
    throw new JevProviderError("jev_malformed_response", `answers.${key} is not a Noul answer`);
  }
  return { ...(value as JevNoulAnswer), type: "noul", noul: value.noul };
}

function isJevRawResponse(value: unknown): value is JevRawResponse {
  return Boolean(value && typeof value === "object");
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function describeCapability(candidate: CapabilityManifest): string {
  const metadata = candidate.metadata ?? {};
  const keys = ["provider", "model", "latency_class", "cost_class", "context_tokens", "max_steps", "budget_tokens", "tags"];
  const hints = keys
    .filter((key) => metadata[key] !== undefined)
    .map((key) => `${key}=${String(metadata[key])}`)
    .join(", ");
  return `${candidate.name}: ${candidate.description} [type=${candidate.type}${hints ? `; ${hints}` : ""}]`;
}
