import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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

export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateSafeId(id: string, fieldName = "decision ID"): void {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid ${fieldName}: path traversal detected for "${id}"`);
  }
  if (!SAFE_ID_REGEX.test(id)) {
    throw new Error(`Invalid ${fieldName} format: "${id}". Must contain only alphanumeric characters, underscores, or dashes.`);
  }
}

const SENSITIVE_KEY_REGEX = /(?:key|token|secret|password|passwd|auth|bearer|credential)/i;
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
  validateSafeId(decisionId, "decision ID");

  const decisionsDir = resolve(root, ".jevrouter", "decisions");
  const decisionPath = resolve(decisionsDir, `${decisionId}.json`);
  if (!decisionPath.startsWith(decisionsDir + (decisionsDir.endsWith(sep) ? "" : sep))) {
    throw new Error(`Invalid decision ID: path traversal detected for "${decisionId}"`);
  }

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

export function validateTimestamp(timestamp: string): number {
  if (typeof timestamp !== "string" || timestamp.trim() === "") {
    throw new Error(`Invalid timestamp: "${timestamp}". Expected a valid ISO-8601 date string.`);
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: "${timestamp}". Expected a valid ISO-8601 date string.`);
  }
  return parsed;
}

const decisionQueues = new Map<string, Promise<unknown>>();

export interface EventLockDeps {
  mkdir?: (path: any, options?: any) => Promise<any>;
  readFile?: (path: any, options?: any) => Promise<any>;
  writeFile?: (path: any, data: any, options?: any) => Promise<any>;
  rename?: (oldPath: any, newPath: any) => Promise<any>;
  rm?: (path: any, options?: any) => Promise<any>;
  stat?: (path: any) => Promise<any>;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

async function claimAbandonedDir(dir: string, ownerPath: string, timeoutMs: number, deps?: EventLockDeps): Promise<boolean> {
  const fsStat = deps?.stat ?? stat;
  const fsMkdir = deps?.mkdir ?? mkdir;
  const fsReadFile = deps?.readFile ?? readFile;
  const fsRename = deps?.rename ?? rename;
  const fsRm = deps?.rm ?? rm;
  const lockPid = deps?.pid ?? process.pid;

  const initialStat = await fsStat(dir).catch(() => null);
  if (!initialStat) return false;
  const initialMtime = initialStat.mtimeMs;
  if (!(await isAbandonedLock(dir, ownerPath, timeoutMs, deps))) {
    return false;
  }

  // Pre-claim synchronization: acquire internal claim marker without exposing an absent canonical path
  const claimLock = join(dir, ".claim");
  try {
    await fsMkdir(claimLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const claimStat = await fsStat(claimLock);
        if (Date.now() - claimStat.mtimeMs > 1000) {
          await fsRm(claimLock, { recursive: true, force: true }).catch(() => {});
        }
      } catch {}
      return false;
    }
    throw error;
  }

  let isLiveClaim = false;
  const claimPath = `${dir}-claim-${lockPid}-${requestId("claim")}`;
  try {
    // Re-verify ownership while holding the claim marker before relocating anything:
    // If a pid file is present, ensure it is still abandoned (dead PID).
    try {
      const ownerStr = await fsReadFile(ownerPath, "utf8");
      const owner = Number(ownerStr);
      if (Number.isInteger(owner) && owner > 0) {
        if (deps?.isProcessAlive ? deps.isProcessAlive(owner) : isAlivePid(owner)) {
          return false; // Live owner!
        }
      }
    } catch (readErr) {
      if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") throw readErr;
      if (Date.now() - initialMtime <= timeoutMs) {
        return false;
      }
    }

    try {
      await fsRename(dir, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }

    const claimedOwner = join(claimPath, "pid");
    let isClaimedAbandoned = false;
    try {
      const ownerStr = await fsReadFile(claimedOwner, "utf8");
      const owner = Number(ownerStr);
      if (Number.isInteger(owner) && owner > 0) {
        isClaimedAbandoned = !(deps?.isProcessAlive ? deps.isProcessAlive(owner) : isAlivePid(owner));
      }
    } catch (readErr) {
      if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
        isClaimedAbandoned = Date.now() - initialMtime > timeoutMs;
      }
    }

    if (!isClaimedAbandoned) {
      isLiveClaim = true;
      try {
        await fsRename(claimPath, dir);
      } catch {
        // Restoration failed (e.g. ENOTEMPTY because canonical path already exists).
        // PRESERVE the live claim — do NOT remove claimPath in finally.
      }
      return false;
    }

    // Lock was abandoned and successfully claimed: remove claim directory
    await fsRm(claimPath, { recursive: true, force: true }).catch(() => {});
    return true;
  } finally {
    if (!isLiveClaim) {
      await fsRm(claimPath, { recursive: true, force: true }).catch(() => {});
    }
    await fsRm(claimLock, { recursive: true, force: true }).catch(() => {});
  }
}

export async function withEventFileLock<T>(eventsDir: string, fn: () => Promise<T>, deps?: EventLockDeps): Promise<T> {
  const fsMkdir = deps?.mkdir ?? mkdir;
  const fsReadFile = deps?.readFile ?? readFile;
  const fsWriteFile = deps?.writeFile ?? writeFile;
  const fsRm = deps?.rm ?? rm;
  const lockPid = deps?.pid ?? process.pid;

  const lockDir = join(eventsDir, ".write-lock");
  const ownerPath = join(lockDir, "pid");
  const recoveryDir = join(eventsDir, ".write-lock-recovery");
  const recoveryOwnerPath = join(recoveryDir, "pid");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fsMkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await isAbandonedLock(lockDir, ownerPath, 30_000, deps)) {
      // Safe recovery ownership: claim abandoned recovery lock atomically
      await claimAbandonedDir(recoveryDir, recoveryOwnerPath, 1000, deps);

      let acquiredRecovery = false;
      try {
        await fsMkdir(recoveryDir);
        await fsWriteFile(recoveryOwnerPath, String(lockPid));
        acquiredRecovery = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (acquiredRecovery) {
        try {
          const currentRecoveryOwner = await fsReadFile(recoveryOwnerPath, "utf8").catch(() => null);
          if (currentRecoveryOwner === String(lockPid)) {
            await claimAbandonedDir(lockDir, ownerPath, 30_000, deps);
          }
        } finally {
          const currentRecoveryOwner = await fsReadFile(recoveryOwnerPath, "utf8").catch(() => null);
          if (currentRecoveryOwner === String(lockPid)) {
            await fsRm(recoveryDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for execution feedback writer");
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  try {
    await fsWriteFile(ownerPath, String(lockPid));
    return await fn();
  } finally {
    const currentLockOwner = await fsReadFile(ownerPath, "utf8").catch(() => null);
    if (currentLockOwner === String(lockPid)) {
      await fsRm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

async function isAbandonedLock(lockDir: string, ownerPath: string, timeoutMs = 30_000, deps?: EventLockDeps): Promise<boolean> {
  const fsReadFile = deps?.readFile ?? readFile;
  const fsStat = deps?.stat ?? stat;
  try {
    const owner = Number(await fsReadFile(ownerPath, "utf8"));
    if (Number.isInteger(owner) && owner > 0) {
      if (deps?.isProcessAlive ? deps.isProcessAlive(owner) : isAlivePid(owner)) {
        return false;
      }
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return Date.now() - (await fsStat(lockDir)).mtimeMs > timeoutMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Serialize asynchronous operations per decision to prevent race conditions
 * when checking and appending event transitions.
 */
export function withDecisionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = decisionQueues.get(lockKey) ?? Promise.resolve();
  const next = (async () => {
    await previous.catch(() => {});
    return await fn();
  })();

  decisionQueues.set(lockKey, next);
  return next.finally(() => {
    if (decisionQueues.get(lockKey) === next) {
      decisionQueues.delete(lockKey);
    }
  });
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

  validateSafeId(params.decision_id, "decision ID");
  if (params.plan_id !== undefined) {
    validateSafeId(params.plan_id, "plan ID");
  }
  if (params.event_id !== undefined) {
    validateSafeId(params.event_id, "event ID");
  }

  const details = params.details === undefined ? undefined : JSON.parse(JSON.stringify(params.details)) as unknown;
  if (details !== undefined) assertNoSecrets(details);

  const timestamp = params.timestamp ?? new Date().toISOString();
  const timestampMs = validateTimestamp(timestamp);

  const lockKey = `${resolve(root)}:${params.decision_id}`;
  return withDecisionLock(lockKey, async () => {
    const eventsDir = join(root, ".jevrouter", "events");
    await mkdir(eventsDir, { recursive: true });
    return withEventFileLock(eventsDir, async () => {
      await assertDecisionExists(params.decision_id, root);
      const existingEvents = await getExecutionEventsForDecision(params.decision_id, root);
      const currentState = resolveDecisionExecutionState(existingEvents);
      if (!VALID_FEEDBACK_TRANSITIONS[currentState].includes(params.type)) {
        throw new Error(
          `Invalid event transition: cannot transition from "${currentState}" to "${params.type}" for decision "${params.decision_id}"`,
        );
      }

      if (existingEvents.length > 0) {
        const lastEvent = existingEvents[existingEvents.length - 1];
        const lastTime = Date.parse(lastEvent.timestamp);
        if (Number.isFinite(lastTime) && timestampMs < lastTime) {
          throw new Error(
            `Invalid event timestamp: timestamp "${timestamp}" cannot be earlier than previous event "${lastEvent.type}" timestamp "${lastEvent.timestamp}" for decision "${params.decision_id}"`,
          );
        }
      }

      const envelope: FeedbackEventEnvelope = {
        event_id: params.event_id ?? requestId("evt"),
        decision_id: params.decision_id,
        ...(params.plan_id ? { plan_id: params.plan_id } : {}),
        type: params.type,
        timestamp,
        ...(details !== undefined ? { details: details as Record<string, unknown> } : {}),
      };

      const eventsFile = join(eventsDir, "events.jsonl");
      let separator = "";
      try {
        const fileStat = await stat(eventsFile);
        if (fileStat.size > 0) {
          const handle = await open(eventsFile, "r");
          try {
            const buffer = Buffer.alloc(1);
            const { bytesRead } = await handle.read(buffer, 0, 1, fileStat.size - 1);
            if (bytesRead > 0 && buffer[0] !== 0x0a) {
              separator = "\n";
            }
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await appendFile(eventsFile, `${separator}${JSON.stringify(envelope)}\n`, "utf8");
      return envelope;
    });
  });
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

  const indexedEvents: Array<{ event: FeedbackEventEnvelope; order: number }> = [];
  let order = 0;
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
            indexedEvents.push({ event: parsed, order: order++ });
          }
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  indexedEvents.sort((a, b) => {
    const left = Date.parse(a.event.timestamp);
    const right = Date.parse(b.event.timestamp);
    const leftTime = Number.isFinite(left) ? left : Infinity;
    const rightTime = Number.isFinite(right) ? right : Infinity;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return a.order - b.order;
  });

  return indexedEvents.map((item) => item.event);
}

/** Get all feedback events for a specific decision_id in chronological order. */
export async function getExecutionEventsForDecision(
  decisionId: string,
  root = process.cwd(),
): Promise<FeedbackEventEnvelope[]> {
  validateSafeId(decisionId, "decision ID");
  const all = await readExecutionEvents(root);
  return all.filter((e) => e.decision_id === decisionId);
}
