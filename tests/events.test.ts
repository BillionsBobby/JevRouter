import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertDecisionExists,
  assertNoSecrets,
  FEEDBACK_EVENT_TYPES,
  getExecutionEventsForDecision,
  readExecutionEvents,
  recordExecutionEvent,
  resolveDecisionExecutionState,
  validateSafeId,
  validateTimestamp,
  VALID_FEEDBACK_TRANSITIONS,
  withEventFileLock,
  type EventLockDeps,
} from "../src/events.js";
import { collectDashboardStats } from "../src/dashboard.js";
import type { FeedbackEventEnvelope, RouteResult } from "../src/types.js";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jevrouter-events-test-"));
  await mkdir(join(root, ".jevrouter", "decisions"), { recursive: true });
  await mkdir(join(root, ".jevrouter", "plans"), { recursive: true });
  await mkdir(join(root, ".jevrouter", "events"), { recursive: true });

  const dummyDecision: Partial<RouteResult> = {
    decision_id: "dec_12345",
    request_id: "req_12345",
    status: "selected",
    mode: "decision_only",
    decision: {
      kind: "choice",
      question: "tool",
      selected: "git_status",
      jev_choice: "git_status",
      candidates: [],
    },
    fallback: { type: null, reason: null },
    execution: { enabled: false, status: "not_started" },
    provenance: { jev_provider: "demo", candidate_snapshot_hash: "hash", policy_hash: "policy" },
    raw_jev: null,
  };

  await writeFile(
    join(root, ".jevrouter", "decisions", "dec_12345.json"),
    JSON.stringify(dummyDecision, null, 2),
    "utf8",
  );

  return root;
}

test("rejects recording feedback for unknown decision IDs", async () => {
  const root = await createFixture();
  try {
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "nonexistent_dec", type: "execution_started" },
          root,
        ),
      /Decision "nonexistent_dec" not found in \.jevrouter\/decisions\/ or \.jevrouter\/plans\//,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows valid lifecycle transitions from handoff to task_completed", async () => {
  const root = await createFixture();
  try {
    const decId = "dec_12345";

    // 1. handoff_accepted
    const ev1 = await recordExecutionEvent({ decision_id: decId, type: "handoff_accepted" }, root);
    assert.equal(ev1.decision_id, decId);
    assert.equal(ev1.type, "handoff_accepted");

    // 2. execution_started
    const ev2 = await recordExecutionEvent({ decision_id: decId, type: "execution_started" }, root);
    assert.equal(ev2.type, "execution_started");

    // 3. execution_succeeded
    const ev3 = await recordExecutionEvent(
      { decision_id: decId, type: "execution_succeeded", details: { exit_code: 0, duration_ms: 45 } },
      root,
    );
    assert.equal(ev3.type, "execution_succeeded");

    // 4. task_completed
    const ev4 = await recordExecutionEvent({ decision_id: decId, type: "task_completed" }, root);
    assert.equal(ev4.type, "task_completed");

    // Verify chronological reading
    const events = await getExecutionEventsForDecision(decId, root);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((e) => e.type), [
      "handoff_accepted",
      "execution_started",
      "execution_succeeded",
      "task_completed",
    ]);

    // Resolved state is task_completed
    assert.equal(resolveDecisionExecutionState(events), "task_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid state transitions", async () => {
  const root = await createFixture();
  try {
    const decId = "dec_12345";

    // Cannot jump directly from not_started to execution_succeeded
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: decId, type: "execution_succeeded" }, root),
      /Invalid event transition: cannot transition from "not_started" to "execution_succeeded"/,
    );

    // Cannot jump directly to task_completed
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: decId, type: "task_completed" }, root),
      /Invalid event transition: cannot transition from "not_started" to "task_completed"/,
    );

    // Start execution then complete task
    await recordExecutionEvent({ decision_id: decId, type: "execution_started" }, root);
    await recordExecutionEvent({ decision_id: decId, type: "execution_succeeded" }, root);
    await recordExecutionEvent({ decision_id: decId, type: "task_completed" }, root);

    // Once task_completed (terminal), cannot transition to anything
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: decId, type: "rerouted" }, root),
      /Invalid event transition: cannot transition from "task_completed" to "rerouted"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports failure, cancellation, and rerouting transitions", async () => {
  const root = await createFixture();
  try {
    const decId = "dec_12345";

    await recordExecutionEvent({ decision_id: decId, type: "execution_started" }, root);
    await recordExecutionEvent(
      { decision_id: decId, type: "execution_failed", details: { exit_code: 1, error_message: "tool failed" } },
      root,
    );

    // Can transition from failed to rerouted
    const reroute = await recordExecutionEvent({ decision_id: decId, type: "rerouted" }, root);
    assert.equal(reroute.type, "rerouted");

    const events = await getExecutionEventsForDecision(decId, root);
    assert.equal(resolveDecisionExecutionState(events), "rerouted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoSecrets rejects sensitive keys and secret values", () => {
  // Sensitive keys (snake_case and camelCase)
  assert.throws(
    () => assertNoSecrets({ api_key: "abc" }),
    /rejected key: "api_key"/,
  );
  assert.throws(
    () => assertNoSecrets({ apiKey: "abc" }),
    /rejected key: "apiKey"/,
  );
  assert.throws(
    () => assertNoSecrets({ auth_token: "xyz" }),
    /rejected key: "auth_token"/,
  );
  assert.throws(
    () => assertNoSecrets({ accessToken: "xyz" }),
    /rejected key: "accessToken"/,
  );
  assert.throws(
    () => assertNoSecrets({ nested: { password: "123" } }),
    /rejected key: "password"/,
  );
  assert.throws(
    () => assertNoSecrets({ nested: { userPassword: "123" } }),
    /rejected key: "userPassword"/,
  );
  assert.throws(
    () => assertNoSecrets({ client_secret: "shhh" }),
    /rejected key: "client_secret"/,
  );
  assert.throws(
    () => assertNoSecrets({ clientSecret: "shhh" }),
    /rejected key: "clientSecret"/,
  );
  assert.throws(
    () => assertNoSecrets({ credentials: "secret" }),
    /rejected key: "credentials"/,
  );

  // Sensitive values
  assert.throws(
    () => assertNoSecrets({ authorization_header: "Bearer secret-token-value-here" }),
    /rejected key: "authorization_header"/,
  );
  assert.throws(
    () => assertNoSecrets({ message: "error with Bearer eyJhbGciOi..." }),
    /detected sensitive value/,
  );
  assert.throws(
    () => assertNoSecrets({ debug: ["s", "k", "-mocksecrettoken123456789"].join("") }),
    /detected sensitive value/,
  );
  // Fine-grained GitHub PAT values
  const fineGrainedPat = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
  assert.throws(
    () => assertNoSecrets({ stdout: fineGrainedPat }),
    /detected sensitive value/,
  );
  assert.throws(
    () => assertNoSecrets({ nested: { output: fineGrainedPat } }),
    /detected sensitive value/,
  );
  assert.throws(
    () => assertNoSecrets({ items: ["ok", fineGrainedPat] }),
    /detected sensitive value/,
  );

  // Safe details are accepted
  assert.doesNotThrow(() =>
    assertNoSecrets({
      exit_code: 0,
      stdout: "Files changed: 3",
      duration_ms: 120,
      counts: { lines: 10, files: 2 },
    }),
  );

  // Reject non-object roots (primitives and arrays)
  assert.throws(
    () => assertNoSecrets("Bearer secret-token"),
    /must be a plain JSON object/,
  );
  assert.throws(
    () => assertNoSecrets(["Bearer secret-token"]),
    /must be a plain JSON object/,
  );
  assert.throws(
    () => assertNoSecrets(42),
    /must be a plain JSON object/,
  );
  assert.throws(
    () => assertNoSecrets(null),
    /must be a plain JSON object/,
  );
});

test("recordExecutionEvent rejects non-object details (primitives, arrays, null)", async () => {
  const root = await createFixture();
  try {
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: "Bearer secret-token" as unknown as Record<string, unknown> },
          root,
        ),
      /Execution feedback details must be a plain JSON object/,
    );
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: ["item"] as unknown as Record<string, unknown> },
          root,
        ),
      /Execution feedback details must be a plain JSON object/,
    );
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: null as unknown as Record<string, unknown> },
          root,
        ),
      /Execution feedback details must be a plain JSON object/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recordExecutionEvent rejects fine-grained GitHub PAT values before append", async () => {
  const root = await createFixture();
  try {
    const patVal = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);

    // Plain value
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: { stdout: patVal } },
          root,
        ),
      /detected sensitive value/,
    );

    // Nested object
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: { nested: { output: patVal } } },
          root,
        ),
      /detected sensitive value/,
    );

    // Nested array
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_started", details: { items: ["ok", patVal] } },
          root,
        ),
      /detected sensitive value/,
    );

    // Assert rejection happened before append: events.jsonl must remain empty / nonexistent
    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes decision IDs stored inside plan files", async () => {
  const root = await createFixture();
  try {
    const plan = {
      plan_id: "plan_step_test",
      mode: "serial",
      steps: [
        {
          step: 1,
          decision_id: "dec_from_plan_step_1",
          status: "selected",
        },
      ],
    };
    await writeFile(
      join(root, ".jevrouter", "plans", "plan_step_test.json"),
      JSON.stringify(plan, null, 2),
      "utf8",
    );

    const event = await recordExecutionEvent(
      {
        decision_id: "dec_from_plan_step_1",
        plan_id: "plan_step_test",
        type: "handoff_accepted",
      },
      root,
    );
    assert.equal(event.decision_id, "dec_from_plan_step_1");
    assert.equal(event.plan_id, "plan_step_test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates dashboard stats execution counts dynamically based on events", async () => {
  const root = await createFixture();
  try {
    // Initially without events: not_started, outcome: not_collected
    const initialStats = await collectDashboardStats(root);
    assert.equal(initialStats.execution.not_started, 1);
    assert.equal(initialStats.execution.outcome, "not_collected");

    // Record execution_started: started moves to 1, outcome becomes partial
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    const startedStats = await collectDashboardStats(root);
    assert.equal(startedStats.execution.started, 1);
    assert.equal(startedStats.execution.outcome, "collected");

    // Record execution_succeeded: succeeded moves to 1
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_succeeded" }, root);
    const succeededStats = await collectDashboardStats(root);
    assert.equal(succeededStats.execution.succeeded, 1);
    assert.equal(succeededStats.execution.started, 0);
    assert.equal(succeededStats.execution.outcome, "collected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI feedback and stats commands record events and return deterministic aggregates", async () => {
  const root = await createFixture();
  const cli = resolve("dist/cli.js");
  try {
    // 1. Run feedback via CLI
    const fbResult = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_started", "--details", '{"step":1}'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(fbResult.status, 0, fbResult.stderr);
    const fbJson = JSON.parse(fbResult.stdout);
    assert.equal(fbJson.decision_id, "dec_12345");
    assert.equal(fbJson.type, "execution_started");
    assert.deepEqual(fbJson.details, { step: 1 });

    // 2. Run stats --json via CLI
    const statsResult = spawnSync(
      process.execPath,
      [cli, "stats", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(statsResult.status, 0, statsResult.stderr);
    const statsJson = JSON.parse(statsResult.stdout);
    assert.equal(statsJson.decisions.total, 1);
    assert.equal(statsJson.execution.started, 1);
    assert.equal(statsJson.execution.outcome, "collected");

    // 3. Run feedback with sensitive details -> fails with exitCode 1
    const badFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '{"api_key":"secret"}'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(badFb.status, 1);
    assert.match(badFb.stderr, /sensitive keys or tokens/);

    // 4. Run feedback with non-object details (string, array, number) -> fails with exitCode 1
    const stringFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '"Bearer secret-token"'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(stringFb.status, 1);
    assert.match(stringFb.stderr, /--details must be a JSON object/);

    const arrayFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '["Bearer secret-token"]'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(arrayFb.status, 1);
    assert.match(arrayFb.stderr, /--details must be a JSON object/);

    const numberFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '42'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(numberFb.status, 1);
    assert.match(numberFb.stderr, /--details must be a JSON object/);
    // 5. Run feedback with camelCase secret details -> fails with exitCode 1
    const camelBadFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '{"apiKey":"secret"}'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(camelBadFb.status, 1);
    assert.match(camelBadFb.stderr, /sensitive keys or tokens/);

    const tokenBadFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", '{"accessToken":"secret"}'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(tokenBadFb.status, 1);
    assert.match(tokenBadFb.stderr, /sensitive keys or tokens/);

    // 6. Run feedback with fine-grained GitHub PAT values -> fails with exitCode 1
    const patVal = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
    const patPlainFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", JSON.stringify({ stdout: patVal })],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(patPlainFb.status, 1);
    assert.match(patPlainFb.stderr, /(?:sensitive keys or tokens|sensitive tokens or credentials|detected sensitive value)/);

    const patNestedObjFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", JSON.stringify({ nested: { output: patVal } })],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(patNestedObjFb.status, 1);
    assert.match(patNestedObjFb.stderr, /(?:sensitive keys or tokens|sensitive tokens or credentials|detected sensitive value)/);

    const patNestedArrFb = spawnSync(
      process.execPath,
      [cli, "feedback", "dec_12345", "execution_succeeded", "--details", JSON.stringify({ items: [patVal] })],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(patNestedArrFb.status, 1);
    assert.match(patNestedArrFb.stderr, /(?:sensitive keys or tokens|sensitive tokens or credentials|detected sensitive value)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal in decision_id and plan_id even if target file exists outside decisions dir", async () => {
  const root = await createFixture();
  try {
    // Create .jevrouter/outside.json
    await writeFile(
      join(root, ".jevrouter", "outside.json"),
      JSON.stringify({ decision_id: "outside" }),
      "utf8",
    );

    // Reject ../outside in recordExecutionEvent
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "../outside", type: "execution_started" }, root),
      /path traversal detected/,
    );

    // Reject ../outside in assertDecisionExists
    await assert.rejects(
      () => assertDecisionExists("../outside", root),
      /path traversal detected/,
    );

    // Reject path traversal with subdirectories or slashes
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "foo/bar", type: "execution_started" }, root),
      /path traversal detected/,
    );

    // Reject path traversal in plan_id
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", plan_id: "../evil_plan", type: "execution_started" },
          root,
        ),
      /path traversal detected/,
    );

    // Validate CLI rejects path traversal
    const cli = resolve("dist/cli.js");
    const cliResult = spawnSync(
      process.execPath,
      [cli, "feedback", "../outside", "execution_started"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stderr, /path traversal detected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent execution feedback transitions for the same decision", async () => {
  const root = await createFixture();
  try {
    const decId = "dec_12345";

    // Launch two concurrent execution_started calls for the same decision
    const [res1, res2] = await Promise.allSettled([
      recordExecutionEvent({ decision_id: decId, type: "execution_started" }, root),
      recordExecutionEvent({ decision_id: decId, type: "execution_started" }, root),
    ]);

    // Exactly one must succeed and one must fail with invalid transition error
    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason?.message,
      /Invalid event transition: cannot transition from "execution_started" to "execution_started"/,
    );

    // Verify only one event was written to the events file
    const events = await getExecutionEventsForDecision(decId, root);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "execution_started");

    // Subsequent valid transition succeeds
    const succeeded = await recordExecutionEvent({ decision_id: decId, type: "execution_succeeded" }, root);
    assert.equal(succeeded.type, "execution_succeeded");

    const updatedEvents = await getExecutionEventsForDecision(decId, root);
    assert.equal(updatedEvents.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes feedback transitions across processes", async () => {
  const root = await createFixture();
  const eventsUrl = pathToFileURL(resolve("dist/events.js")).href;
  const childCode = `process.send('ready'); process.on('message', async () => {
    const { recordExecutionEvent } = await import(${JSON.stringify(eventsUrl)});
    try { await recordExecutionEvent({ decision_id: 'dec_12345', type: 'execution_started' }, ${JSON.stringify(root)}); process.exit(0); }
    catch { process.exit(1); }
  });`;
  try {
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    await Promise.all(children.map(child => new Promise<void>(done => child.once("message", () => done()))));
    const exits = children.map(child => new Promise<number | null>(done => child.once("exit", done)));
    children.forEach(child => child.send("start"));
    assert.deepEqual((await Promise.all(exits)).sort(), [0, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal((await getExecutionEventsForDecision("dec_12345", root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a writer lock left by a dead process", async () => {
  const root = await createFixture();
  try {
    const lockDir = join(root, ".jevrouter/events/.write-lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "pid"), "2147483647");
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    assert.equal((await getExecutionEventsForDecision("dec_12345", root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates the exact details snapshot saved to JSONL", async () => {
  const root = await createFixture();
  try {
    const details: Record<string, unknown> = { message: "safe" };
    const pending = recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started", details }, root);
    details.api_key = "synthetic-secret";
    const event = await pending;
    assert.deepEqual(event.details, { message: "safe" });
    assert.deepEqual((await getExecutionEventsForDecision("dec_12345", root))[0].details, { message: "safe" });
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "dec_12345", type: "execution_succeeded", details: {
        toJSON: () => ({ api_key: "synthetic-secret" }),
      } }, root),
      /sensitive keys or tokens/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays events from multiple files in timestamp order", async () => {
  const root = await createFixture();
  try {
    const event = (type: string, timestamp: string) => JSON.stringify({ event_id: type, decision_id: "dec_12345", type, timestamp }) + "\n";
    await writeFile(join(root, ".jevrouter/events/z-old.jsonl"), event("execution_started", "2026-09-29T10:00:00Z"));
    await writeFile(join(root, ".jevrouter/events/a-new.jsonl"), event("execution_succeeded", "2026-09-29T10:01:00Z") + event("task_completed", "2026-09-29T10:02:00Z"));
    assert.equal(resolveDecisionExecutionState(await getExecutionEventsForDecision("dec_12345", root)), "task_completed");
    assert.equal((await collectDashboardStats(root)).execution.succeeded, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid and malformed event timestamps", async () => {
  const root = await createFixture();
  try {
    assert.throws(() => validateTimestamp(""), /Invalid timestamp/);
    assert.throws(() => validateTimestamp("not-a-date"), /Invalid timestamp/);
    assert.throws(() => validateTimestamp("invalid-iso"), /Invalid timestamp/);
    assert.throws(() => validateTimestamp(null as unknown as string), /Invalid timestamp/);

    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started", timestamp: "invalid" }, root),
      /Invalid timestamp/,
    );
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started", timestamp: "" }, root),
      /Invalid timestamp/,
    );
    await assert.rejects(
      () => recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started", timestamp: "not-a-date" }, root),
      /Invalid timestamp/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects backdated event timestamps for a decision and maintains chronological state", async () => {
  const root = await createFixture();
  try {
    // 1. Record execution_started at 10:00
    await recordExecutionEvent(
      { decision_id: "dec_12345", type: "execution_started", timestamp: "2026-10-02T10:00:00.000Z" },
      root,
    );

    // 2. Attempt backdated execution_succeeded at 09:00 -> must be rejected
    await assert.rejects(
      () =>
        recordExecutionEvent(
          { decision_id: "dec_12345", type: "execution_succeeded", timestamp: "2026-10-02T09:00:00.000Z" },
          root,
        ),
      /cannot be earlier than previous event "execution_started" timestamp/,
    );

    // 3. Verify state and dashboard remain "started" rather than corrupted
    const eventsAfterReject = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(eventsAfterReject.length, 1);
    assert.equal(resolveDecisionExecutionState(eventsAfterReject), "execution_started");
    const statsAfterReject = await collectDashboardStats(root);
    assert.equal(statsAfterReject.execution.started, 1);
    assert.equal(statsAfterReject.execution.succeeded, 0);

    // 4. Subsequent forward timestamp succeeds
    await recordExecutionEvent(
      { decision_id: "dec_12345", type: "execution_succeeded", timestamp: "2026-10-02T10:05:00.000Z" },
      root,
    );

    // 5. Subsequent equal timestamp succeeds
    await recordExecutionEvent(
      { decision_id: "dec_12345", type: "task_completed", timestamp: "2026-10-02T10:05:00.000Z" },
      root,
    );

    const finalEvents = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(finalEvents.length, 3);
    assert.equal(resolveDecisionExecutionState(finalEvents), "task_completed");
    const finalStats = await collectDashboardStats(root);
    assert.equal(finalStats.execution.succeeded, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers when recovery directory was left abandoned by a crashed process", async () => {
  const root = await createFixture();
  try {
    const lockDir = join(root, ".jevrouter/events/.write-lock");
    const recoveryDir = join(root, ".jevrouter/events/.write-lock-recovery");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "pid"), "2147483647");
    await mkdir(recoveryDir, { recursive: true });
    await writeFile(join(recoveryDir, "pid"), "2147483647");

    // Must recover promptly without 30-second timeout
    const event = await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    assert.equal(event.type, "execution_started");
    assert.equal((await getExecutionEventsForDecision("dec_12345", root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers when recovery directory has no pid file but is stale", async () => {
  const root = await createFixture();
  try {
    const lockDir = join(root, ".jevrouter/events/.write-lock");
    const recoveryDir = join(root, ".jevrouter/events/.write-lock-recovery");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "pid"), "2147483647");
    await mkdir(recoveryDir, { recursive: true });

    // Set recoveryDir mtime to 5 seconds ago
    const past = (Date.now() - 5000) / 1000;
    await utimes(recoveryDir, past, past);

    const event = await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    assert.equal(event.type, "execution_started");
    assert.equal((await getExecutionEventsForDecision("dec_12345", root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays events with identical timestamps in authoritative ingestion order", async () => {
  const root = await createFixture();
  try {
    const ts = "2026-10-02T12:00:00.000Z";
    await recordExecutionEvent({ decision_id: "dec_12345", type: "handoff_accepted", timestamp: ts }, root);
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started", timestamp: ts }, root);
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_succeeded", timestamp: ts }, root);
    await recordExecutionEvent({ decision_id: "dec_12345", type: "task_completed", timestamp: ts }, root);

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((e) => e.type), [
      "handoff_accepted",
      "execution_started",
      "execution_succeeded",
      "task_completed",
    ]);
    assert.equal(resolveDecisionExecutionState(events), "task_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent recovery does not race or allow multiple processes into protected section", async () => {
  const root = await createFixture();
  const eventsUrl = pathToFileURL(resolve("dist/events.js")).href;

  // Pre-seed an abandoned lockDir and abandoned recoveryDir
  const lockDir = join(root, ".jevrouter/events/.write-lock");
  const recoveryDir = join(root, ".jevrouter/events/.write-lock-recovery");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "pid"), "2147483647");
  await mkdir(recoveryDir, { recursive: true });
  await writeFile(join(recoveryDir, "pid"), "2147483647");

  // Spawn 8 concurrent child processes that all start recovery simultaneously via IPC synchronization
  const childCode = `process.send('ready'); process.on('message', async () => {
    const { recordExecutionEvent } = await import(${JSON.stringify(eventsUrl)});
    try {
      await recordExecutionEvent({ decision_id: 'dec_12345', type: 'execution_started' }, ${JSON.stringify(root)});
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });`;

  try {
    const children = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    );
    await Promise.all(children.map((child) => new Promise<void>((done) => child.once("message", () => done()))));
    const exits = children.map((child) => new Promise<number | null>((done) => child.once("exit", done)));
    children.forEach((child) => child.send("start"));

    const exitCodes = (await Promise.all(exits)).sort();
    assert.deepEqual(exitCodes, [0, 1, 1, 1, 1, 1, 1, 1]);

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "execution_started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent callers on abandoned recovery lock maintain mutual exclusion without removing each other's locks", async () => {
  const root = await createFixture();
  try {
    const lockDir = join(root, ".jevrouter/events/.write-lock");
    const recoveryDir = join(root, ".jevrouter/events/.write-lock-recovery");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "pid"), "2147483647");
    await mkdir(recoveryDir, { recursive: true });
    await writeFile(join(recoveryDir, "pid"), "2147483647");

    // Launch two concurrent recordExecutionEvent calls
    const [res1, res2] = await Promise.allSettled([
      recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root),
      recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "execution_started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers from partial initial JSONL record without trailing newline", async () => {
  const root = await createFixture();
  try {
    const eventsFile = join(root, ".jevrouter", "events", "events.jsonl");
    // Simulate an interrupted initial write leaving an unclosed record and no newline
    await writeFile(eventsFile, '{"event_id":"evt_incomplete","decision_id":"dec_12345"', "utf8");

    const event = await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    assert.equal(event.type, "execution_started");

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "execution_started");
    assert.equal(resolveDecisionExecutionState(events), "execution_started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers from valid start plus partial successor tail and preserves task completion", async () => {
  const root = await createFixture();
  try {
    const eventsFile = join(root, ".jevrouter", "events", "events.jsonl");
    await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);

    // Simulate an interrupted successor write without trailing newline
    const { appendFile } = await import("node:fs/promises");
    await appendFile(eventsFile, '{"event_id":"evt_corrupt","type":"execution_succeeded"', "utf8");

    const succeeded = await recordExecutionEvent(
      { decision_id: "dec_12345", type: "execution_succeeded", details: { exit_code: 0 } },
      root,
    );
    assert.equal(succeeded.type, "execution_succeeded");

    const completed = await recordExecutionEvent({ decision_id: "dec_12345", type: "task_completed" }, root);
    assert.equal(completed.type, "task_completed");

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.type), ["execution_started", "execution_succeeded", "task_completed"]);
    assert.equal(resolveDecisionExecutionState(events), "task_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves valid final record lacking a trailing newline without fusing", async () => {
  const root = await createFixture();
  try {
    const eventsFile = join(root, ".jevrouter", "events", "events.jsonl");
    // Pre-seed a valid record without a trailing newline
    const initialEnvelope = {
      event_id: "evt_init",
      decision_id: "dec_12345",
      type: "handoff_accepted",
      timestamp: new Date().toISOString(),
    };
    await writeFile(eventsFile, JSON.stringify(initialEnvelope), "utf8");

    const nextEvent = await recordExecutionEvent({ decision_id: "dec_12345", type: "execution_started" }, root);
    assert.equal(nextEvent.type, "execution_started");

    const events = await getExecutionEventsForDecision("dec_12345", root);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.type), ["handoff_accepted", "execution_started"]);
    assert.equal(resolveDecisionExecutionState(events), "execution_started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent callers for different decisions on abandoned recovery lock maintain mutual exclusion", async () => {
  const root = await createFixture();
  try {
    const lockDir = join(root, ".jevrouter", "events", ".write-lock");
    const recoveryDir = join(root, ".jevrouter", "events", ".write-lock-recovery");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "pid"), "2147483647");
    await mkdir(recoveryDir, { recursive: true });
    await writeFile(join(recoveryDir, "pid"), "2147483647");

    let currentOccupancy = 0;
    let maxOccupancy = 0;

    const eventsDir = join(root, ".jevrouter", "events");
    const [res1, res2] = await Promise.allSettled([
      withEventFileLock(eventsDir, async () => {
        currentOccupancy++;
        maxOccupancy = Math.max(maxOccupancy, currentOccupancy);
        await new Promise((r) => setTimeout(r, 25));
        currentOccupancy--;
      }),
      withEventFileLock(eventsDir, async () => {
        currentOccupancy++;
        maxOccupancy = Math.max(maxOccupancy, currentOccupancy);
        await new Promise((r) => setTimeout(r, 25));
        currentOccupancy--;
      }),
    ]);

    assert.equal(res1.status, "fulfilled");
    assert.equal(res2.status, "fulfilled");
    assert.equal(maxOccupancy, 1, `Expected maxOccupancy to be 1, but observed ${maxOccupancy}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic three-process interleaving maintains mutual exclusion and limits protected-section occupancy to 1", async () => {
  const dirs = new Map<string, { mtimeMs: number }>();
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const livePids = new Set<number>([1001, 1002, 1003]);

  const eventsDir = "/virtual/.jevrouter/events";
  const lockDir = `${eventsDir}/.write-lock`;
  const recoveryDir = `${eventsDir}/.write-lock-recovery`;

  dirs.set("/virtual", { mtimeMs: Date.now() });
  dirs.set("/virtual/.jevrouter", { mtimeMs: Date.now() });
  dirs.set(eventsDir, { mtimeMs: Date.now() });
  dirs.set(lockDir, { mtimeMs: Date.now() - 60_000 });
  dirs.set(recoveryDir, { mtimeMs: Date.now() - 60_000 });

  const deadPid = 999999;
  files.set(`${lockDir}/pid`, { content: String(deadPid), mtimeMs: Date.now() - 60_000 });
  files.set(`${recoveryDir}/pid`, { content: String(deadPid), mtimeMs: Date.now() - 60_000 });

  let pauseBeforeRenameA = true;
  let resumeA: () => void = () => {};
  let aPausedResolve: () => void;
  const aPausedPromise = new Promise<void>((resolve) => {
    aPausedResolve = resolve;
  });

  let pauseBeforeRenameB = true;
  let resumeB: () => void = () => {};
  let bPausedResolve: () => void;
  const bPausedPromise = new Promise<void>((resolve) => {
    bPausedResolve = resolve;
  });

  const createSimulator = (pid: number): EventLockDeps => {
    return {
      pid,
      isProcessAlive: (p: number) => livePids.has(p),
      mkdir: async (path: string) => {
        if (dirs.has(path)) {
          const err = new Error(`EEXIST: directory already exists, mkdir '${path}'`) as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
        dirs.set(path, { mtimeMs: Date.now() });
      },
      readFile: async (path: string) => {
        const file = files.get(path);
        if (!file) {
          const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return file.content;
      },
      writeFile: async (path: string, data: string) => {
        files.set(path, { content: data, mtimeMs: Date.now() });
      },
      stat: async (path: string) => {
        if (files.has(path)) {
          return { mtimeMs: files.get(path)!.mtimeMs };
        }
        if (dirs.has(path)) {
          return { mtimeMs: dirs.get(path)!.mtimeMs };
        }
        const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      rename: async (oldPath: string, newPath: string) => {
        if (pid === 1001 && pauseBeforeRenameA && oldPath === recoveryDir) {
          pauseBeforeRenameA = false;
          aPausedResolve();
          await new Promise<void>((res) => {
            resumeA = res;
          });
        }
        if (pid === 1002 && pauseBeforeRenameB && oldPath === lockDir) {
          pauseBeforeRenameB = false;
          bPausedResolve();
          await new Promise<void>((res) => {
            resumeB = res;
          });
        }

        if (dirs.has(newPath)) {
          const err = new Error(`ENOTEMPTY: directory not empty, rename '${oldPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
          err.code = "ENOTEMPTY";
          throw err;
        }
        if (!dirs.has(oldPath) && !files.has(oldPath)) {
          const err = new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }

        if (dirs.has(oldPath)) {
          const dirEntry = dirs.get(oldPath)!;
          dirs.delete(oldPath);
          dirs.set(newPath, dirEntry);
          for (const [fPath, fVal] of Array.from(files.entries())) {
            if (fPath.startsWith(oldPath + "/")) {
              files.delete(fPath);
              files.set(newPath + fPath.slice(oldPath.length), fVal);
            }
          }
          for (const [dPath, dVal] of Array.from(dirs.entries())) {
            if (dPath.startsWith(oldPath + "/")) {
              dirs.delete(dPath);
              dirs.set(newPath + dPath.slice(oldPath.length), dVal);
            }
          }
        } else if (files.has(oldPath)) {
          const val = files.get(oldPath)!;
          files.delete(oldPath);
          files.set(newPath, val);
        }
      },
      rm: async (path: string) => {
        dirs.delete(path);
        files.delete(path);
        for (const [fPath] of Array.from(files.entries())) {
          if (fPath.startsWith(path + "/")) {
            files.delete(fPath);
          }
        }
        for (const [dPath] of Array.from(dirs.entries())) {
          if (dPath.startsWith(path + "/")) {
            dirs.delete(dPath);
          }
        }
      },
    };
  };

  let currentOccupancy = 0;
  let maxOccupancy = 0;

  const protectedSection = (pid: number) => async () => {
    currentOccupancy++;
    maxOccupancy = Math.max(maxOccupancy, currentOccupancy);
    await new Promise((resolve) => setTimeout(resolve, 20));
    currentOccupancy--;
  };

  const taskA = withEventFileLock(eventsDir, protectedSection(1001), createSimulator(1001));
  await aPausedPromise;

  // A holds recoveryDir/.claim and is paused before rename.
  // Age A's claim marker past 1000ms threshold:
  const aClaim = `${recoveryDir}/.claim`;
  assert.ok(dirs.has(aClaim), "A should have created recoveryDir/.claim");
  dirs.get(aClaim)!.mtimeMs = Date.now() - 1500;

  // Start B while A's live claim is >1000ms old:
  const taskB = withEventFileLock(eventsDir, protectedSection(1002), createSimulator(1002));

  // Give B time to run retry loops against A's aged claim
  await new Promise((r) => setTimeout(r, 60));

  // Verify that B did NOT remove A's live claim marker despite elapsed time > 1s:
  assert.ok(dirs.has(aClaim), "A's live claim marker must not be removed by B solely due to elapsed time");
  assert.equal(currentOccupancy, 0, "B must not enter protected section while A holds claim");

  // Resume A to complete
  resumeA();
  await taskA;
  assert.equal(currentOccupancy, 0);

  // Simulate an abandoned lockDir before B claims it:
  dirs.set(lockDir, { mtimeMs: Date.now() - 60_000 });
  files.set(`${lockDir}/pid`, { content: String(deadPid), mtimeMs: Date.now() - 60_000 });

  // B should now acquire recovery of abandoned lockDir and pause before renaming lockDir:
  await bPausedPromise;

  // B holds lockDir/.claim and is paused before rename.
  // Age B's claim marker past 1000ms threshold:
  const bClaim = `${lockDir}/.claim`;
  assert.ok(dirs.has(bClaim), "B should have created lockDir/.claim");
  dirs.get(bClaim)!.mtimeMs = Date.now() - 1500;

  // Start C while B's live claim is >1000ms old:
  const taskC = withEventFileLock(eventsDir, protectedSection(1003), createSimulator(1003));

  // Give C time to run retry loops against B's aged claim
  await new Promise((r) => setTimeout(r, 60));

  // Verify that C did NOT remove B's live claim marker despite elapsed time > 1s:
  assert.ok(dirs.has(bClaim), "B's live claim marker must not be removed by C solely due to elapsed time");

  // Resume B to complete
  resumeB();

  const results = await Promise.allSettled([taskB, taskC]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.equal(maxOccupancy, 1, `Expected maxOccupancy <= 1, but observed simultaneous occupancy of ${maxOccupancy}`);
});

