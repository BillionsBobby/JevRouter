import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityManifest, JevProvider, JevRawResponse, JevRouteRequest, StateValue } from "../src/types.js";
import { JevRouter } from "../src/router.js";
import { evaluate } from "../src/api.js";
import { DemoProvider, getChoiceAnswer, getNoulAnswer, getScoreAnswer } from "../src/provider.js";

const candidates: CapabilityManifest[] = [
  { id: "a.read", name: "Read records", type: "mcp_tool", description: "Read records without side effects", risk: { level: "low" } },
  { id: "b.write", name: "Write records", type: "mcp_tool", description: "Write records to an external system", risk: { level: "low" } },
];

class RecordingProvider implements JevProvider {
  readonly name = "recording";
  calls: JevRouteRequest[] = [];
  constructor(private readonly raw: JevRawResponse) {}
  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    this.calls.push(request);
    return this.raw;
  }
}

const okRaw: JevRawResponse = {
  answers: {
    tool: { type: "choice", choice: "a.read", probabilities: { "a.read": 0.9, "b.write": 0.1 }, confidence: 0.9 },
    severity: { type: "score", score: 2.4, probabilities: { "0": 0, "1": 0.1, "2": 0.5, "3": 0.4 }, confidence: 0.8, legend: { "0": "trivial", "3": "critical" } },
    needs_tool: { type: "noul", noul: 0.93 },
  },
};

test("route sends a plain string state for a bare request", async () => {
  const provider = new RecordingProvider(okRaw);
  await new JevRouter(provider).route({ request: "just text" }, candidates);
  assert.equal(provider.calls[0].state, "just text");
});

test("route upgrades state to a structured object when actor/context exist", async () => {
  const provider = new RecordingProvider(okRaw);
  await new JevRouter(provider).route({ request: "read this", actor: "agent-1", context: { repo: "owner/repo", days: 30 } }, candidates);
  const state = provider.calls[0].state as Record<string, unknown>;
  assert.equal(typeof state, "object");
  assert.equal(state.request, "read this");
  assert.equal(state.actor, "agent-1");
  assert.deepEqual(state.context, { repo: "owner/repo", days: 30 });
});

test("serial plan keeps progress threading inside structured state", async () => {
  const provider = new RecordingProvider(okRaw);
  await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "read then read again", context: { scope: "demo" } }, candidates, { steps: 2, mode: "serial" },
  );
  const state = provider.calls[1].state as Record<string, unknown>;
  assert.match(String(state.request), /already routed in previous steps, in order: a\.read/);
  assert.deepEqual(state.context, { scope: "demo" });
});

test("evaluate answers a mixed primitive batch end-to-end (demo provider)", async () => {
  const raw = await evaluate(
    {
      state: { ticket: "checkout page is blank after clicking Pay" },
      questions: {
        pick: { type: "choice", instructions: "Which capability should handle this?" },
        severity: { type: "score", instructions: "How severe is this?", criteria: ["trivial", "minor", "major", "critical"] },
        needs_tool: { type: "noul", instructions: "Does handling this require a tool?", criteria: { true: "fixing a broken checkout page", false: "reading a FAQ" } },
      },
      candidates,
    },
    { provider: "demo" },
  );
  assert.equal(raw.model, "jevrouter-demo");
  assert.ok(typeof getChoiceAnswer(raw, "pick").choice === "string");
  const severity = getScoreAnswer(raw, "severity");
  assert.ok(severity.score >= 0 && severity.score <= 3);
  const needsTool = getNoulAnswer(raw, "needs_tool");
  assert.ok(needsTool.noul > 0.5);
});

test("buildQuestions rejects a score question without criteria locally", async () => {
  const provider = new DemoProvider();
  await assert.rejects(
    provider.decide({ state: "x", candidates, questions: { bad: { type: "score", criteria: [] } } }),
    /score questions require a non-empty criteria array/,
  );
});

test("demo provider answers all three primitives with labelled offline answers", async () => {
  const provider = new DemoProvider();
  const raw = await provider.decide({
    state: "read the records carefully",
    candidates,
    questions: {
      pick: { type: "choice" },
      severity: { type: "score", instructions: "How careful should we be?", criteria: ["casual", "careful"] },
      needs_tool: { type: "noul", instructions: "Is a read needed?", criteria: { true: "read records", false: "delete everything" } },
    },
  });
  const choice = getChoiceAnswer(raw, "pick");
  assert.equal(choice.choice, "a.read");
  const score = getScoreAnswer(raw, "severity");
  assert.ok(score.score >= 0 && score.score <= 1);
  assert.equal(raw.answers?.severity && (raw.answers.severity as { model?: unknown }).model, undefined);
  const noul = getNoulAnswer(raw, "needs_tool");
  assert.ok(noul.noul > 0.5);
  assert.equal(raw.model, "jevrouter-demo");
});

test("demo provider uses explicit Choice criteria without a candidate manifest", async () => {
  const raw = await evaluate(
    {
      state: "The checkout payment is failing",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { payments: "billing and checkout issues", frontend: "browser rendering issues" },
        },
      },
    },
    { provider: "demo" },
  );
  const answer = getChoiceAnswer(raw, "team");
  assert.equal(answer.choice, "payments");
  assert.deepEqual(Object.keys(answer.probabilities), ["payments", "frontend"]);
});

test("answer extractors reject malformed answers", async () => {
  const provider = new RecordingProvider({ answers: { s: { type: "score", score: "high" }, n: { type: "noul", noul: 1.7 } } });
  const raw = await provider.decide({ state: "x", candidates });
  assert.throws(() => getScoreAnswer(raw, "s"), /not a Score answer/);
  assert.throws(() => getNoulAnswer(raw, "n"), /not a Noul answer/);
});
