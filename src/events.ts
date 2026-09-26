import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FeedbackEventEnvelope, FeedbackEventType } from "./types.js";
import { requestId } from "./utils.js";

export type { FeedbackEventEnvelope, FeedbackEventType };

export const FEEDBACK_EVENT_TYPES: readonly FeedbackEventType[] = [
  "handoff_accepted",
  "execution_started",
  "execution_succeeded",
  "execution_failed",
  "execution_cancelled",
  "rerouted",
  "task_completed",
] as const;

export const VALID_FEEDBACK_TRANSITIONS: Record<FeedbackEventType | "not_started", readonly FeedbackEventType[]> = {
  not_started: ["handoff_accepted", "execution_started", "execution_cancelled", "rerouted"],
  handoff_accepted: ["execution_started", "execution_cancelled", "rerouted"],
  execution_started: ["execution_succeeded", "execution_failed", "execution_cancelled", "rerouted"],
  execution_succeeded: ["task_completed", "rerouted"],
  execution_failed: ["rerouted"],
  execution_cancelled: ["rerouted"],
  rerouted: ["execution_started", "execution_cancelled", "rerouted"],
  task_completed: [],
};

const SENSITIVE_KEY_REGEX = /(?:^|[_-])(?:key|token|secret|password|passwd|auth(?:orization)?|bearer|credential)(?:[_-]|$)/i;
const SENSITIVE_VALUE_REGEX = /(?:bearer\s+[a-zA-Z0-9_\-\.]+|sk-[a-zA-Z0-9_\-]{16,}|ghp_[a-zA-Z0-9]{20,})/i;

/** Validate that event details are a plain object and do not contain sensitive tokens or secret keys. */
export function assertNoSecrets(value: unknown, path = "details"): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Execution feedback details must be a plain JSON object, received ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  assertNoNestedSecrets(value, path);
}

function assertNoNestedSecrets(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === "string" && SENSITIVE_VALUE_REGEX.test(item)) {
        throw new Error(
          `Execution feedback details must not contain sensitive tokens or credentials (detected sensitive value at ${path}[${index}])`,
        );
      }
      if (item && typeof item === "object") {
        assertNoNestedSecrets(item, `${path}[${index}]`);
      }
    });
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      throw new Error(`Execution feedback details must not contain sensitive keys or tokens (rejected key: "${key}" at ${path}.${key})`);
    }
    if (typeof val === "string" && SENSITIVE_VALUE_REGEX.test(val)) {
      throw new Error(`Execution feedback details must not contain sensitive tokens or credentials (detected sensitive value at ${path}.${key})`);
    }
    if (val && typeof val === "object") {
      assertNoNestedSecrets(val, `${path}.${key}`);
    }
  }
}

/** Check if a decision ID exists in .jevrouter/decisions or as part of a plan in .jevrouter/plans. */
export async function assertDecisionExists(decisionId: string, root = process.cwd()): Promise<void> {
  const decisionPath = join(root, ".jevrouter", "decisions", `${decisionId}.json`);
  try {
    await stat(decisionPath);
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Also check if this decision is part of any plan in .jevrouter/plans
  const planDir = join(root, ".jevrouter", "plans");
  try {
    const files = await readdir(planDir);
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const content = await readFile(join(planDir, file), "utf8");
        const parsed = JSON.parse(content) as { steps?: Array<{ decision_id?: string }> };
        if (Array.isArray(parsed.steps) && parsed.steps.some((s) => s.decision_id === decisionId)) {
          return;
        }
      } catch {
        // Skip unparseable plan file
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  throw new Error(`Decision "${decisionId}" not found in .jevrouter/decisions/ or .jevrouter/plans/. Ensure routing decision was executed and saved.`);
}

/** Compute the latest effective state of a decision from its chronological events. */
export function resolveDecisionExecutionState(events: FeedbackEventEnvelope[]): FeedbackEventType | "not_started" {
  let currentState: FeedbackEventType | "not_started" = "not_started";
  for (const event of events) {
    const allowed: readonly FeedbackEventType[] = VALID_FEEDBACK_TRANSITIONS[currentState];
    if (allowed.includes(event.type)) {
      currentState = event.type;
    }
  }
  return currentState;
}

export interface RecordExecutionEventOptions {
  decision_id: string;
  type: FeedbackEventType;
  plan_id?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
  event_id?: string;
}

/**
 * Record an append-only execution feedback event into .jevrouter/events/events.jsonl.
 * Validates decision existence, state transitions, and secret-free details.
 */
export async function recordExecutionEvent(
  params: RecordExecutionEventOptions,
  root = process.cwd(),
): Promise<FeedbackEventEnvelope> {
  if (!FEEDBACK_EVENT_TYPES.includes(params.type)) {
    throw new Error(`Unknown event type "${params.type}". Allowed types: ${FEEDBACK_EVENT_TYPES.join(", ")}`);
  }

  if (params.details !== undefined) {
    assertNoSecrets(params.details);
  }

  await assertDecisionExists(params.decision_id, root);

  const existingEvents = await getExecutionEventsForDecision(params.decision_id, root);
  const currentState = resolveDecisionExecutionState(existingEvents);

  const allowedTransitions = VALID_FEEDBACK_TRANSITIONS[currentState];
  if (!allowedTransitions.includes(params.type)) {
    throw new Error(
      `Invalid event transition: cannot transition from "${currentState}" to "${params.type}" for decision "${params.decision_id}"`,
    );
  }

  const envelope: FeedbackEventEnvelope = {
    event_id: params.event_id ?? requestId("evt"),
    decision_id: params.decision_id,
    ...(params.plan_id ? { plan_id: params.plan_id } : {}),
    type: params.type,
    timestamp: params.timestamp ?? new Date().toISOString(),
    ...(params.details ? { details: params.details } : {}),
  };

  const eventsDir = join(root, ".jevrouter", "events");
  await mkdir(eventsDir, { recursive: true });
  await appendFile(join(eventsDir, "events.jsonl"), `${JSON.stringify(envelope)}\n`, "utf8");

  return envelope;
}

/** Read all execution feedback events from .jevrouter/events/*.jsonl. */
export async function readExecutionEvents(root = process.cwd()): Promise<FeedbackEventEnvelope[]> {
  const eventsDir = join(root, ".jevrouter", "events");
  let fileNames: string[];
  try {
    fileNames = await readdir(eventsDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const events: FeedbackEventEnvelope[] = [];
  for (const name of fileNames.filter((f) => f.endsWith(".jsonl")).sort()) {
    try {
      const content = await readFile(join(eventsDir, name), "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as FeedbackEventEnvelope;
          if (parsed && typeof parsed === "object" && typeof parsed.decision_id === "string" && typeof parsed.type === "string") {
            events.push(parsed);
          }
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return events;
}

/** Get all feedback events for a specific decision_id in chronological order. */
export async function getExecutionEventsForDecision(
  decisionId: string,
  root = process.cwd(),
): Promise<FeedbackEventEnvelope[]> {
  const all = await readExecutionEvents(root);
  return all.filter((e) => e.decision_id === decisionId);
}
