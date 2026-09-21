import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, normalizeCapability } from "../src/manifest.js";
import { JevRouter } from "../src/router.js";
import type { JevProvider, JevRawResponse, JevRouteRequest } from "../src/types.js";

const dangerous = {
  name: "drop_production_database",
  description: "Permanently delete the production database and all backups",
  risk: { level: "critical", categories: ["data_loss"] },
  policy: { requires_confirmation: true },
};

class StubProvider implements JevProvider {
  readonly name = "stub";
  calls: JevRouteRequest[] = [];
  constructor(private readonly raw: JevRawResponse) {}
  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    this.calls.push(request);
    return this.raw;
  }
}

const picks = (id: string): JevRawResponse => ({
  answers: {
    tool: { type: "choice", choice: id, probabilities: { [id]: 1 }, confidence: 1 },
    severity: { type: "score", score: 3, probabilities: { "3": 1 }, confidence: 0.9, legend: { "0": "trivial", "3": "critical" } },
    needs_tool: { type: "noul", noul: 0.99 },
  },
});

test("an inline candidate keeps a declared risk level and confirmation requirement", () => {
  const manifest = normalizeCapability(dangerous, "candidates[0]");
  assert.equal(manifest.risk?.level, "critical");
  assert.deepEqual(manifest.risk?.categories, ["data_loss"]);
  assert.equal(manifest.policy?.requires_confirmation, true);
});

test("an inline candidate without risk still defaults to low and agent_tool", () => {
  const manifest = normalizeCapability({ name: "read_file", description: "Read a file" }, "candidates[0]");
  assert.equal(manifest.risk?.level, "low");
  assert.deepEqual(manifest.risk?.categories, ["agent_tool"]);
  assert.equal(manifest.policy, undefined);
});

test("declared permissions survive normalisation", () => {
  const manifest = normalizeCapability({ name: "send_email", description: "Send mail", permissions: ["mail.send"] }, "candidates[0]");
  assert.deepEqual(manifest.permissions, ["mail.send"]);
});

test("fields this shape decides for itself are reported rather than dropped in silence", () => {
  const warnings: string[] = [];
  normalizeCapability(
    { name: "read_file", description: "Read a file", verification: { status: "verified" }, metadata: { source: "elsewhere" } },
    "candidates[0]",
    message => warnings.push(message),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /candidates\[0\]/);
  assert.match(warnings[0], /verification/);
  assert.match(warnings[0], /metadata/);
});

test("an agent asserting its own tool is verified does not become verified", () => {
  const manifest = normalizeCapability({ name: "read_file", description: "Read a file", verification: { status: "verified" } }, "candidates[0]");
  assert.equal(manifest.verification?.status, "unverified");
});

test("a critical inline candidate is refused by the default policy", async () => {
  const candidate = normalizeCapability(dangerous, "candidates[0]");
  const provider = new StubProvider(picks(candidate.id));
  const result = await new JevRouter(provider).route({ request: "drop the production database now" }, [candidate]);
  assert.equal(result.status, "no_decision");
  assert.match(JSON.stringify(result), /risk_not_allowed:critical/);
});

test("when a policy does allow critical, the declared confirmation still applies", async () => {
  const candidate = normalizeCapability(dangerous, "candidates[0]");
  const provider = new StubProvider(picks(candidate.id));
  const policy = { ...defaultPolicy, allowed_risk_levels: ["low", "medium", "high", "critical"] as const };
  const result = await new JevRouter(provider, { ...policy, allowed_risk_levels: [...policy.allowed_risk_levels] }).route(
    { request: "drop the production database now" },
    [candidate],
  );
  assert.equal(result.status, "needs_confirmation");
});
