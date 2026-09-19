import { test } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityManifest, JevProvider, JevRawResponse } from "../src/types.js";
import { JevRouter } from "../src/router.js";
import { discoverMcpConfig } from "../src/mcp.js";
import { discoverClis, discoverDsh, discoverSkills } from "../src/discovery.js";
import { CachedJevProvider } from "../src/provider.js";
import { createSdkProvider, route as sdkRoute } from "../src/api.js";
import { handleMessage } from "../src/mcp-server.js";
import { CapabilityRegistry, defaultPolicy, loadPolicyFile } from "../src/manifest.js";
import { doctorAgents, renderClaudeServer, renderCodexConfigBlock, renderJevRouterSkill, renderRoutingInstructions } from "../src/agent-setup.js";
import { resolve } from "node:path";

const candidates: CapabilityManifest[] = [
  {
    id: "safe.read",
    name: "Safe read",
    type: "mcp_tool",
    description: "Read records without side effects",
    permissions: [],
    risk: { level: "low" },
  },
  {
    id: "blocked.write",
    name: "Write records",
    type: "mcp_tool",
    description: "Write records to an external system",
    permissions: ["write"],
    risk: { level: "high" },
  },
];

class FixedProvider implements JevProvider {
  readonly name = "test";
  constructor(private readonly raw: JevRawResponse) {}
  async decide(): Promise<JevRawResponse> { return this.raw; }
}

class QueueProvider implements JevProvider {
  readonly name = "queue";
  calls = 0;
  constructor(private readonly responses: JevRawResponse[]) {}
  async decide(): Promise<JevRawResponse> {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (!response) throw new Error("unexpected provider call");
    return response;
  }
}

test("keeps Jev probabilities unchanged when a candidate is filtered", async () => {
  const provider = new FixedProvider({
    model: "jev-test",
    answers: { tool: { type: "choice", choice: "blocked.write", probabilities: { "safe.read": 0.31, "blocked.write": 0.69 }, confidence: 0.69 } },
  });
  const result = await new JevRouter(provider, { min_confidence: 0.4, allowed_risk_levels: ["low"] }).route({ request: "read records" }, candidates);
  const blocked = result.decision.candidates.find((candidate) => candidate.id === "blocked.write");
  assert.equal(blocked?.jev_probability, 0.69);
  assert.equal(blocked?.router.filtered, true);
  assert.equal(result.decision.jev_choice, "blocked.write");
  assert.equal(result.decision.selected, "safe.read");
  assert.match(result.fallback.reason ?? "", /filtered/);
});

test("returns no_decision below the configured confidence threshold", async () => {
  const provider = new FixedProvider({
    answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 0.55, "blocked.write": 0.45 }, confidence: 0.2 } },
  });
  const result = await new JevRouter(provider, { min_confidence: 0.7, allowed_risk_levels: ["low", "high"] }).route({ request: "read records" }, candidates);
  assert.equal(result.status, "no_decision");
  assert.equal(result.decision.selected, null);
  assert.equal(result.fallback.type, "low_confidence");
});

test("filters capabilities outside the caller permission set", async () => {
  const provider = new FixedProvider({
    answers: { tool: { type: "choice", choice: "blocked.write", probabilities: { "safe.read": 0.2, "blocked.write": 0.8 }, confidence: 0.8 } },
  });
  const result = await new JevRouter(provider, { min_confidence: 0.4, allowed_risk_levels: ["low", "high"] }).route(
    { request: "write records", actor_permissions: [] },
    candidates,
  );
  assert.equal(result.status, "selected");
  assert.equal(result.decision.selected, "safe.read");
  assert.match(result.decision.candidates.find((candidate) => candidate.id === "blocked.write")?.router.filter_reason ?? "", /actor_missing_permissions/);
});

test("keeps candidate provenance visible and can require verified capabilities", async () => {
  const provider = new FixedProvider({
    answers: { tool: { type: "choice", choice: "ad_hoc", probabilities: { ad_hoc: 1 }, confidence: 1 } },
  });
  const result = await new JevRouter(provider, { min_confidence: 0, require_verified_candidates: true }).route(
    { request: "read" },
    [{ name: "ad_hoc", description: "A caller supplied description" } as CapabilityManifest],
  );
  const candidate = result.decision.candidates[0];
  assert.equal(candidate?.router.verified, false);
  assert.equal(candidate?.router.verification_status, "unknown");
  assert.match(candidate?.router.filter_reason ?? "", /capability_not_verified/);
  assert.equal(result.status, "no_decision");
});

test("validates supplied tool input against the selected manifest schema", async () => {
  const provider = new FixedProvider({
    answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 1 }, confidence: 1 } },
  });
  const manifest = [{
    ...candidates[0],
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  }];
  const result = await new JevRouter(provider, { min_confidence: 0.4 }).route({ request: "read", input: {} }, manifest);
  assert.equal(result.status, "no_decision");
  assert.equal(result.decision.input_validation?.valid, false);
  assert.match(result.fallback.reason ?? "", /query is required/);
});

test("uses a stable candidate snapshot for equivalent input", async () => {
  const raw = { answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 1, "blocked.write": 0 }, confidence: 1 } } };
  const first = await new JevRouter(new FixedProvider(raw), { min_confidence: 0.1 }).route({ request: "read" }, candidates);
  const second = await new JevRouter(new FixedProvider(raw), { min_confidence: 0.1 }).route({ request: "read" }, [...candidates].reverse());
  assert.equal(first.provenance.candidate_snapshot_hash, second.provenance.candidate_snapshot_hash);
});

test("uses coarse then final Jev decisions for larger candidate sets", async () => {
  const many: CapabilityManifest[] = [
    ...candidates,
    { id: "other.one", name: "Other one", type: "skill", description: "A different capability", risk: { level: "low" } },
    { id: "other.two", name: "Other two", type: "cli", description: "Another different capability", risk: { level: "low" } },
  ];
  const provider = new QueueProvider([
    { answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 0.4, "blocked.write": 0.3, "other.one": 0.2, "other.two": 0.1 }, confidence: 0.4 } } },
    { answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 0.8, "blocked.write": 0.2 }, confidence: 0.8 } } },
  ]);
  const result = await new JevRouter(provider, { single_stage_max_candidates: 2, top_k: 2, min_confidence: 0.5, allowed_risk_levels: ["low"] }).route({ request: "read" }, many);
  assert.equal(provider.calls, 2);
  assert.equal(result.raw_jev_stages?.length, 2);
  assert.equal(result.decision.selected, "safe.read");
  assert.equal(result.decision.candidates.find((candidate) => candidate.id === "safe.read")?.jev_stage, "final");
  assert.equal(result.decision.candidates.find((candidate) => candidate.id === "other.two")?.jev_stage, "coarse");
  assert.equal(result.decision.candidates.find((candidate) => candidate.id === "other.two")?.jev_probability, 0.1);
  assert.equal(result.decision.candidates.find((candidate) => candidate.id === "other.two")?.jev_confidence, 0.4);
});

test("discovers MCP, Skill, CLI, and DSH capabilities into one manifest shape", async () => {
  const mcp = await discoverMcpConfig(resolve("tests/fixtures/mock-mcp.json"));
  const skills = await discoverSkills(resolve("examples/skills"));
  const clis = await discoverClis(["node"]);
  const dsh = await discoverDsh(resolve("examples/dsh"));
  assert.equal(mcp[0]?.type, "mcp_tool");
  assert.equal(mcp[0]?.id, "mcp.fixture.search");
  assert.equal(skills[0]?.type, "skill");
  assert.equal(clis[0]?.type, "cli");
  assert.equal(dsh[0]?.type, "dsh");
});

test("reuses a provider response for an identical candidate snapshot", async () => {
  let calls = 0;
  const inner: JevProvider = {
    name: "cache-test",
    async decide(): Promise<JevRawResponse> {
      calls += 1;
      return { answers: { tool: { type: "choice", choice: "safe.read", probabilities: { "safe.read": 1 }, confidence: 1 } } };
    },
  };
  const cached = new CachedJevProvider(inner, ".jevrouter/.cache-tests");
  const request = { state: `cache-test-${process.pid}`, candidates: [candidates[0]] };
  await cached.decide(request);
  await cached.decide(request);
  assert.equal(calls, 1);
});

test("routes model and subagent capabilities through the same SDK entrypoint", async () => {
  const result = await sdkRoute(
    { request: "deep research with citations", candidates: [
      { id: "model.fast", name: "Fast model", type: "model", description: "Fast short answers", risk: { level: "low" } },
      { id: "subagent.researcher", name: "Researcher", type: "subagent", description: "Deep research with citations", risk: { level: "low" } },
    ] },
    { provider: "demo", cache: false, policy: { min_confidence: 0 } },
  );
  assert.equal(result.decision.selected, "subagent.researcher");
  assert.equal(result.decision.candidates.find((candidate) => candidate.id === "subagent.researcher")?.type, "subagent");
});

test("exposes the same router through the optional MCP adapter", async () => {
  const provider = new FixedProvider({
    answers: { tool: { type: "choice", choice: "subagent.researcher", probabilities: { "subagent.researcher": 1 }, confidence: 1 } },
  });
  const options = { registry: new CapabilityRegistry(".jevrouter/capabilities"), policy: defaultPolicy, provider };
  const listed = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
  const tools = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["jev_route", "jev_capabilities"]);
  const initialized = await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize" }, options);
  assert.match(String((initialized?.result as { instructions: string }).instructions), /call jev_route/);
  const called = await handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "jev_route",
      arguments: {
        request: "delegate research",
        candidates: [{ id: "subagent.researcher", name: "Researcher", type: "subagent", description: "Deep research", risk: { level: "low" }, permissions: [] }],
      },
    },
  }, options);
  assert.equal((called?.result as { structuredContent: { decision: { selected: string } } }).structuredContent.decision.selected, "subagent.researcher");
});

test("accepts an OpenAI-style function tool without a manifest conversion step", async () => {
  const result = await sdkRoute(
    {
      request: "search issues",
      candidates: [{
        type: "function",
        function: { name: "github.issue.search", description: "Search issues", parameters: { type: "object" } },
      }],
    },
    { provider: "demo", cache: false, policy: { min_confidence: 0 } },
  );
  assert.equal(result.decision.selected, "github.issue.search");
  assert.equal(result.decision.candidates[0]?.type, "mcp_tool");
});

test("optional MCP config forwards the chosen key without replacing host instructions", () => {
  const claude = renderClaudeServer("openrouter") as {command: string; args: string[]; env: Record<string,string>};
  assert.equal(claude.command, process.execPath);
  assert.equal(claude.args.includes("serve-mcp"), true);
  assert.deepEqual(claude.env, { OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}" });
  const codex = renderCodexConfigBlock("openrouter");
  assert.match(codex, /env_vars = \["OPENROUTER_API_KEY"\]/);
  assert.doesNotMatch(codex, /model_instructions_file/);
});

test("explicit OpenRouter provider uses the OpenRouter key when multiple keys exist", async () => {
  const previousFetch = globalThis.fetch;
  const previousTypesafe = process.env.TYPESAFE_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  let authorization = "";
  process.env.TYPESAFE_API_KEY = "typesafe-test-key";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  globalThis.fetch = (async (_input, init) => {
    authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return Response.json({ answers: { tool: { type: "choice", choice: "tool", probabilities: { tool: 1 }, confidence: 1 } } });
  }) as typeof fetch;
  try {
    const provider = createSdkProvider({ provider: "openrouter", cache: false });
    await provider.decide({ state: "test", candidates: [{ id: "tool", name: "Tool", type: "mcp_tool", description: "test" }] });
    assert.equal(authorization, "Bearer openrouter-test-key");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousTypesafe;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
  }
});

test("agent doctor is read-only and reports missing setup", async () => {
  const results = await doctorAgents("all", "/tmp/jevrouter-agent-doctor-missing", "openrouter");
  assert.equal(results.length, 3);
  assert.equal(results.every((result) => result.configured === false), true);
  assert.ok(results.every((result) => result.issues.length > 0));
});

test("missing policy file falls back to the default policy for fresh Agent setup", async () => {
  const policy = await loadPolicyFile("/tmp/jevrouter-policy-does-not-exist/policy.json");
  assert.deepEqual(policy, defaultPolicy);
});
