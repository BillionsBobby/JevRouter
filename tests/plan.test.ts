import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityManifest, JevProvider, JevRawResponse, JevRouteRequest } from "../src/types.js";
import { JevRouter } from "../src/router.js";
import { plan as sdkPlan } from "../src/api.js";

const candidates: CapabilityManifest[] = [
  { id: "a.read", name: "Read records", type: "mcp_tool", description: "Read records without side effects", risk: { level: "low" } },
  { id: "b.write", name: "Write records", type: "mcp_tool", description: "Write records to an external system", risk: { level: "low" } },
  { id: "c.search", name: "Search records", type: "mcp_tool", description: "Search records by keyword", risk: { level: "low" } },
];

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence: number) {
  return { type: "choice", choice, probabilities, confidence };
}

function stateText(state: unknown): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

class RecordingProvider implements JevProvider {
  readonly name = "recording";
  calls: JevRouteRequest[] = [];
  constructor(private readonly respond: (request: JevRouteRequest, index: number) => JevRawResponse) {}
  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    this.calls.push(request);
    return this.respond(request, this.calls.length - 1);
  }
}

test("batch plan asks all step questions in a single provider call", async () => {
  const provider = new RecordingProvider(() => ({
    answers: {
      step1: choiceAnswer("a.read", { "a.read": 0.7, "b.write": 0.2, "c.search": 0.1 }, 0.9),
      step2: choiceAnswer("b.write", { "a.read": 0.3, "b.write": 0.6, "c.search": 0.1 }, 0.8),
      step3: choiceAnswer("a.read", { "a.read": 0.6, "b.write": 0.3, "c.search": 0.1 }, 0.7),
    },
  }));
  const plan = await new JevRouter(provider, { min_confidence: 0.55 }).plan({ request: "read, write, read" }, candidates, { steps: 3, mode: "batch" });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Object.keys(provider.calls[0].questions ?? {}), ["step1", "step2", "step3"]);
  assert.match(provider.calls[0].questions?.step2.instructions ?? "", /step 2/);
  assert.equal(plan.mode, "batch");
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((step) => step.step), [1, 2, 3]);
  assert.deepEqual(plan.steps.map((step) => step.decision.selected), ["a.read", "b.write", "a.read"]);
  assert.match(plan.steps[1].decision.question, /step 2/);
  assert.ok(plan.raw_jev);
  assert.equal(plan.steps[0].raw_jev, null);
});

test("batch plan applies the confidence gate to each step independently", async () => {
  const provider = new RecordingProvider(() => ({
    answers: {
      step1: choiceAnswer("a.read", { "a.read": 0.7, "b.write": 0.2, "c.search": 0.1 }, 0.9),
      step2: choiceAnswer("b.write", { "a.read": 0.3, "b.write": 0.6, "c.search": 0.1 }, 0.3),
    },
  }));
  const plan = await new JevRouter(provider, { min_confidence: 0.55 }).plan({ request: "read then write" }, candidates, { steps: 2, mode: "batch" });
  assert.equal(plan.steps[0].status, "selected");
  assert.equal(plan.steps[0].decision.selected, "a.read");
  assert.equal(plan.steps[1].status, "no_decision");
  assert.equal(plan.steps[1].decision.selected, null);
  assert.equal(plan.steps[1].decision.jev_choice, "b.write");
  assert.equal(plan.steps[1].fallback.type, "low_confidence");
});

test("serial plan feeds prior selections forward in the state", async () => {
  const choices = ["a.read", "b.write", "a.read"];
  const provider = new RecordingProvider((_request, index) => {
    const choice = choices[index];
    return { answers: { tool: choiceAnswer(choice, { "a.read": 0.5, "b.write": 0.4, "c.search": 0.1, [choice]: 0.9 }, 0.9) } };
  });
  const plan = await new JevRouter(provider, { min_confidence: 0.55 }).plan({ request: "read, write, read again" }, candidates, { steps: 3, mode: "serial" });
  assert.equal(provider.calls.length, 3);
  assert.equal(stateText(provider.calls[0].state), "read, write, read again");
  assert.match(stateText(provider.calls[1].state), /previous steps, in order: a\.read/);
  assert.match(stateText(provider.calls[2].state), /previous steps, in order: a\.read, b\.write/);
  assert.equal(plan.mode, "serial");
  assert.equal(plan.raw_jev, null);
  assert.deepEqual(plan.steps.map((step) => step.decision.selected), ["a.read", "b.write", "a.read"]);
});

test("batch plan rejects candidate sets above single_stage_max_candidates; serial still works", async () => {
  const policy = { single_stage_max_candidates: 2, top_k: 2, min_confidence: 0.4 };
  await assert.rejects(
    new JevRouter(new RecordingProvider(() => ({ answers: {} })), policy).plan({ request: "x" }, candidates, { steps: 2, mode: "batch" }),
    /single_stage_max_candidates/,
  );
  const provider = new RecordingProvider((_request, index) => {
    const responses = [
      { answers: { tool: choiceAnswer("a.read", { "a.read": 0.5, "b.write": 0.3, "c.search": 0.2 }, 0.9) } },
      { answers: { tool: choiceAnswer("a.read", { "a.read": 0.6, "b.write": 0.4 }, 0.9) } },
      { answers: { tool: choiceAnswer("b.write", { "a.read": 0.4, "b.write": 0.4, "c.search": 0.2 }, 0.9) } },
      { answers: { tool: choiceAnswer("b.write", { "a.read": 0.45, "b.write": 0.55 }, 0.9) } },
    ];
    return responses[index];
  });
  const plan = await new JevRouter(provider, policy).plan({ request: "x" }, candidates, { steps: 2, mode: "serial" });
  assert.equal(provider.calls.length, 4);
  assert.deepEqual(plan.steps.map((step) => step.decision.selected), ["a.read", "b.write"]);
  assert.equal(plan.steps[0].raw_jev_stages?.length, 2);
});

test("rejects invalid step counts", async () => {
  const router = new JevRouter(new RecordingProvider(() => ({ answers: {} })));
  await assert.rejects(router.plan({ request: "x" }, candidates, { steps: 0 }), /steps must be/);
  await assert.rejects(router.plan({ request: "x" }, candidates, { steps: 99 }), /steps must be/);
});

test("SDK plan works with the labelled demo provider", async () => {
  const plan = await sdkPlan(
    { request: "read records then write records", candidates },
    { provider: "demo", steps: 2, mode: "batch", policy: { min_confidence: 0 } },
  );
  assert.equal(plan.mode, "batch");
  assert.equal(plan.steps.length, 2);
  assert.ok(plan.steps[0].decision.selected);
  assert.equal(plan.provenance.jev_provider, "jevrouter-demo");
});

test("batch beam sequence selection overrides argmax while preserving jev_choice", async () => {
  const provider = new RecordingProvider(() => ({
    answers: {
      step1: choiceAnswer("a.read", { "a.read": 0.6, "b.write": 0.4, "c.search": 0.0 }, 0.9),
      step2: choiceAnswer("a.read", { "a.read": 0.55, "b.write": 0.45, "c.search": 0.0 }, 0.9),
    },
  }));
  const plan = await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "read then write" }, candidates,
    { steps: 2, mode: "batch", sequence: "beam", diversity_penalty: 1.0 },
  );
  assert.equal(provider.calls.length, 1);
  assert.equal(plan.steps[0].decision.selected, "a.read");
  assert.equal(plan.steps[1].decision.selected, "b.write");
  assert.equal(plan.steps[1].decision.jev_choice, "a.read");
  assert.match(plan.steps[1].fallback.reason ?? "", /sequence beam/);
});

test("serial plan diversity re-rank picks the un-repeated runner-up", async () => {
  const provider = new RecordingProvider((_request, index) => {
    const responses = [
      { answers: { tool: choiceAnswer("a.read", { "a.read": 0.6, "b.write": 0.4, "c.search": 0 }, 0.9) } },
      { answers: { tool: choiceAnswer("a.read", { "a.read": 0.55, "b.write": 0.45, "c.search": 0 }, 0.9) } },
    ];
    return responses[index];
  });
  const plan = await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "read then write" }, candidates,
    { steps: 2, mode: "serial", diversity_penalty: 1.0 },
  );
  assert.equal(plan.steps[0].decision.selected, "a.read");
  assert.equal(plan.steps[1].decision.selected, "b.write");
  assert.match(plan.steps[1].fallback.reason ?? "", /diversity re-rank/);
});

test("decompose routes each injected sub-goal and threads plan context", async () => {
  const provider = new RecordingProvider(() => ({
    answers: { tool: choiceAnswer("a.read", { "a.read": 0.9, "b.write": 0.1, "c.search": 0 }, 0.9) },
  }));
  const plan = await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "original multi-step request" }, candidates,
    { decompose: () => ["first sub-goal", "second sub-goal"], thread_context: true },
  );
  assert.equal(plan.mode, "decompose");
  assert.equal(plan.steps.length, 2);
  assert.match(stateText(provider.calls[0].state), /Sub-goal 1 of 2: first sub-goal/);
  assert.match(stateText(provider.calls[0].state), /original multi-step request/);
  assert.match(stateText(provider.calls[1].state), /Sub-goal 2 of 2: second sub-goal/);
  assert.match(stateText(provider.calls[1].state), /already routed in previous steps, in order: a\.read/);
});

test("hierarchical routing picks a group first, then a member", async () => {
  const provider = new RecordingProvider((_request, index) => {
    if (index === 0) {
      return { answers: { tool: choiceAnswer("mcp_tool", { mcp_tool: 0.9 }, 0.9) } };
    }
    return { answers: { tool: choiceAnswer("b.write", { "a.read": 0.3, "b.write": 0.6, "c.search": 0.1 }, 0.9) } };
  });
  const plan = await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "write something" }, candidates, { steps: 1, mode: "serial", group_by: "server" },
  );
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[0].candidates.every((candidate) => candidate.id === "mcp_tool"));
  assert.equal(plan.steps[0].decision.selected, "b.write");
  assert.equal(plan.steps[0].decision.candidates.find((candidate) => candidate.id === "b.write")?.jev_stage, "final");
  assert.equal(plan.steps[0].raw_jev_stages?.length, 2);
});

test("serial plan includes the plan sketch in every step state", async () => {
  const provider = new RecordingProvider(() => ({
    answers: { tool: choiceAnswer("a.read", { "a.read": 0.9, "b.write": 0.1, "c.search": 0 }, 0.9) },
  }));
  await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "do things" }, candidates,
    { steps: 2, mode: "serial", plan_hint: ["do first thing", "do second thing"] },
  );
  assert.match(stateText(provider.calls[0].state), /Plan sketch:\n1\. do first thing\n2\. do second thing/);
  assert.match(stateText(provider.calls[1].state), /Plan sketch/);
});

test("sequence reranking does not select a candidate whose input schema rejects the request", async () => {
  const schemaCandidates: CapabilityManifest[] = [
    { id: "a.read", name: "Read", type: "mcp_tool", description: "read", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
    { id: "b.write", name: "Write", type: "mcp_tool", description: "write", input_schema: { type: "object", required: ["content"], properties: { content: { type: "string" } } } },
  ];
  const provider = new RecordingProvider((_request, index) => ({
    answers: { tool: choiceAnswer(index === 0 ? "a.read" : "a.read", { "a.read": index === 0 ? 0.6 : 0.55, "b.write": index === 0 ? 0.4 : 0.45 }, 0.9) },
  }));
  const plan = await new JevRouter(provider, { min_confidence: 0 }).plan(
    { request: "read then write", input: { path: "a.txt" } }, schemaCandidates,
    { steps: 2, mode: "serial", diversity_penalty: 1 },
  );
  assert.equal(plan.steps[1].decision.selected, "a.read");
  assert.equal(plan.steps[1].decision.input_validation?.valid, true);
});

test("plan with zero candidates returns no_decision steps without calling the provider", async () => {
  const provider = new RecordingProvider(() => { throw new Error("must not be called"); });
  const plan = await new JevRouter(provider).plan({ request: "anything" }, [], { steps: 3, mode: "serial" });
  assert.equal(provider.calls.length, 0);
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every((step) => step.status === "no_decision"));
  assert.equal(plan.steps[0].fallback.type, "no_safe_candidate");
  assert.equal(plan.raw_jev, null);
});
