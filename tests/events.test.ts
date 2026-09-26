import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertNoSecrets,
  FEEDBACK_EVENT_TYPES,
  getExecutionEventsForDecision,
  readExecutionEvents,
  recordExecutionEvent,
  resolveDecisionExecutionState,
  VALID_FEEDBACK_TRANSITIONS,
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
  // Sensitive keys
  assert.throws(
    () => assertNoSecrets({ api_key: "abc" }),
    /rejected key: "api_key"/,
  );
  assert.throws(
    () => assertNoSecrets({ auth_token: "xyz" }),
    /rejected key: "auth_token"/,
  );
  assert.throws(
    () => assertNoSecrets({ nested: { password: "123" } }),
    /rejected key: "password"/,
  );
  assert.throws(
    () => assertNoSecrets({ client_secret: "shhh" }),
    /rejected key: "client_secret"/,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
