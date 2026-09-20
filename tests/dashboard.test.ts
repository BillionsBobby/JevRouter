import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDashboardStats, startDashboardServer } from "../src/dashboard.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jevrouter-dashboard-"));
  await mkdir(join(root, ".jevrouter/decisions"), { recursive: true });
  await mkdir(join(root, ".jevrouter/plans"), { recursive: true });
  await writeFile(join(root, ".jevrouter/decisions/dec_one.json"), JSON.stringify({
    decision_id: "dec_one", status: "selected", decision: { selected: "search_web" },
    provenance: { jev_provider: "jevrouter-demo" }, runtime: { source: "demo", elapsed_ms: 10 },
    execution: { status: "not_started" },
  }));
  await writeFile(join(root, ".jevrouter/decisions/dec_two.json"), JSON.stringify({
    decision_id: "dec_two", status: "no_decision", decision: { selected: null },
    provenance: { jev_provider: "typesafe" }, runtime: { source: "live", elapsed_ms: 30 },
    execution: { status: "not_started" },
  }));
  await writeFile(join(root, ".jevrouter/plans/plan_one.json"), JSON.stringify({
    plan_id: "plan_one", mode: "serial", steps: [
      { status: "selected", execution: { status: "not_started" } },
      { status: "needs_confirmation", execution: { status: "not_started" } },
    ],
  }));
  return root;
}

test("collectDashboardStats reports only persisted routing facts", async () => {
  const root = await fixture();
  const stats = await collectDashboardStats(root);
  assert.equal(stats.decisions.total, 2);
  assert.deepEqual(stats.decisions.by_status, { selected: 1, no_decision: 1 });
  assert.deepEqual(stats.decisions.by_source, { demo: 1, live: 1 });
  assert.equal(stats.decisions.p50_elapsed_ms, 10);
  assert.equal(stats.decisions.p95_elapsed_ms, 30);
  assert.deepEqual(stats.decisions.selected_capabilities, [{ id: "search_web", count: 1 }]);
  assert.equal(stats.plans.total, 1);
  assert.equal(stats.plans.steps, 2);
  assert.equal(stats.execution.outcome, "not_collected");
  assert.equal(stats.execution.not_started, 4);
});

test("dashboard server exposes JSON stats and a local HTML view", async () => {
  const root = await fixture();
  const server = await startDashboardServer(root, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const statsResponse = await fetch(`${base}/api/stats`);
  assert.equal(statsResponse.status, 200);
  assert.equal((await statsResponse.json()).decisions.total, 2);
  const htmlResponse = await fetch(base);
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), /JevRouter/);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
