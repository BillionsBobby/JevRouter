import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityManifest, JevProvider, JevRawResponse, JevRouteRequest } from "../src/types.js";
import { JevRouter } from "../src/router.js";
import { CHOICE_DISTRIBUTION_TOLERANCE, getChoiceAnswer, JevProviderError } from "../src/provider.js";

const candidates: CapabilityManifest[] = [
  { id: "a.read", name: "Read records", type: "mcp_tool", description: "Read records without side effects", risk: { level: "low" } },
  { id: "b.write", name: "Write records", type: "mcp_tool", description: "Write records to an external system", risk: { level: "low" } },
];

function toolAnswer(tool: Record<string, unknown>): JevRawResponse {
  return { answers: { tool: { type: "choice", ...tool } } };
}

class StubProvider implements JevProvider {
  readonly name = "stub";
  constructor(private readonly raw: JevRawResponse) {}
  async decide(_request: JevRouteRequest): Promise<JevRawResponse> {
    return this.raw;
  }
}

test("getChoiceAnswer rejects a missing numeric confidence instead of synthesizing one", () => {
  const tool = { type: "choice", choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 } };
  assert.equal(Object.hasOwn(tool, "confidence"), false);
  assert.throws(
    () => getChoiceAnswer(toolAnswer(tool), "tool"),
    (error: unknown) => error instanceof JevProviderError
      && error.code === "jev_malformed_response"
      && /missing a finite numeric confidence/.test(error.message),
  );
});

test("getChoiceAnswer rejects a non-numeric confidence", () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 }, confidence: "0.9" });
  assert.throws(() => getChoiceAnswer(raw, "tool"), /missing a finite numeric confidence/);
});

test("getChoiceAnswer rejects a non-finite confidence", () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 }, confidence: Number.NaN });
  assert.throws(() => getChoiceAnswer(raw, "tool"), /missing a finite numeric confidence/);
});

test("getChoiceAnswer rejects a confidence outside [0, 1]", () => {
  assert.throws(() => getChoiceAnswer(toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 }, confidence: 1.4 }), "tool"), /Invalid confidence/);
});

test("getChoiceAnswer rejects a probability distribution that does not sum to one", () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.9 }, confidence: 0.9 });
  assert.equal(Object.values({ "a.read": 0.9, "b.write": 0.9 }).reduce((sum, value) => sum + value, 0), 1.8);
  assert.throws(() => getChoiceAnswer(raw, "tool"), /sums to 1\.8/);
});

test("getChoiceAnswer rejects an empty probability map", () => {
  assert.throws(() => getChoiceAnswer(toolAnswer({ choice: "a.read", probabilities: {}, confidence: 0.9 }), "tool"), /empty probability distribution/);
});

test("getChoiceAnswer accepts a total inside the documented tolerance and rejects one outside it", () => {
  const inside = CHOICE_DISTRIBUTION_TOLERANCE / 2;
  const accepted = getChoiceAnswer(toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9 + inside, "b.write": 0.1 - inside }, confidence: 0.9 }), "tool");
  assert.equal(accepted.choice, "a.read");

  const outside = CHOICE_DISTRIBUTION_TOLERANCE * 10;
  assert.throws(
    () => getChoiceAnswer(toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9 + outside, "b.write": 0.1 }, confidence: 0.9 }), "tool"),
    /sums to/,
  );
});

test("a valid answer survives getChoiceAnswer unchanged", () => {
  const answer = getChoiceAnswer(toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.78, "b.write": 0.12, "c.search": 0.1 }, confidence: 0.67 }), "tool");
  assert.deepEqual(answer.probabilities, { "a.read": 0.78, "b.write": 0.12, "c.search": 0.1 });
  assert.equal(answer.confidence, 0.67);
});

test("routing rejects a missing confidence with no_decision and preserves the raw response", async () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 } });
  const result = await new JevRouter(new StubProvider(raw)).route({ request: "read" }, candidates);
  assert.equal(result.status, "no_decision");
  assert.equal(result.decision.selected, null);
  assert.equal(result.error?.code, "jev_malformed_response");
  assert.deepEqual(result.raw_jev, raw);
});

test("routing rejects an invalid distribution with no_decision", async () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.9 }, confidence: 0.9 });
  const result = await new JevRouter(new StubProvider(raw)).route({ request: "read" }, candidates);
  assert.equal(result.status, "no_decision");
  assert.equal(result.error?.code, "jev_malformed_response");
});

test("routing rejects probabilities for options outside the question criteria", async () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.6, "b.write": 0.2, "c.search": 0.2 }, confidence: 0.9 });
  const result = await new JevRouter(new StubProvider(raw)).route({ request: "read" }, candidates);
  assert.equal(result.status, "no_decision");
  assert.equal(result.error?.code, "jev_malformed_response");
  assert.match(result.error?.message ?? "", /unknown options: c\.search/);
});

test("routing rejects a selection that is not one of the question criteria", async () => {
  const raw = toolAnswer({ choice: "z.other", probabilities: { "a.read": 0.5, "b.write": 0.5 }, confidence: 0.9 });
  const result = await new JevRouter(new StubProvider(raw)).route({ request: "read" }, candidates);
  assert.equal(result.status, "no_decision");
  assert.equal(result.error?.code, "jev_malformed_response");
});

test("routing still selects when the provider answers within the contract", async () => {
  const raw = toolAnswer({ choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 }, confidence: 0.9 });
  const result = await new JevRouter(new StubProvider(raw)).route({ request: "read" }, candidates);
  assert.equal(result.status, "selected");
  assert.equal(result.decision.selected, "a.read");
});