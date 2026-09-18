# JevRouter

<p><a href="#jevrouter">English</a> · <a href="#中文介绍">中文</a></p>

JevRouter is a small, local-first router for Agent capabilities. It turns models, Subagents, Skills, MCP Tools, CLIs and DSH plugins into one candidate set, asks Jev one typed Choice question, and applies hard policy checks around the returned decision.

The key contract is simple: Jev owns the decision probabilities; JevRouter owns availability, permissions, risk and confirmation. Router fields live under `router`, while the original `probabilities`, `confidence`, and complete provider response remain intact. Filtered candidates are never re-normalized.

Small candidate sets use one Jev Choice call. When `single_stage_max_candidates` is exceeded, JevRouter first keeps the coarse Top-K candidates, then asks Jev for a final Choice over that reduced set. Both raw responses are returned in `raw_jev_stages`; coarse probabilities remain attached to candidates that were not sent to the final stage.

## Why this shape

TypeSafe documents Jev as a System One model: structured state in, typed decisions with probability distributions and confidence out. That makes it useful as a fast decision layer in front of tools, while a normal reasoning model can remain the execution or fallback layer. JevRouter keeps that boundary explicit and defaults to decision-only mode.

The core integration is the one-call SDK or CLI. MCP is an optional compatibility adapter for Agents that already load tools through MCP; it exposes one `jev_route` tool and does not execute the selected capability implicitly.

![Jev API and JevRouter: decision model and agent integration](docs/assets/jev-api-router-comparison.png)

**Jev supplies the decision model; JevRouter supplies capability discovery, routing policies, and agent integration.** The diagram illustrates the broader orchestration vision. In the current implementation, JevRouter returns routing decisions and plans; the host agent executes the selected capabilities and produces the final result.

## Benchmark snapshot

We evaluated Jev on 10 Toolathlon tasks by predicting each task's first five ordered tool calls, comparing it with DeepSeek V4.1 Flash. In serial mode, Jev reached **38% position-wise accuracy** versus 24%, achieved a **0.9 mean longest common prefix** versus 0.5, ran about **5.5× faster** (1.58s vs 8.65s per task), and cost about **7× less** ($0.0058 vs $0.0407 for 10 tasks). The experiment measures ordered routing decisions, not end-to-end task completion.

<details>
<summary id="中文介绍">中文介绍</summary>

JevRouter 是一个本地优先的 Agent 能力路由器，将模型、Subagent、Skill、MCP 工具、CLI 和 DSH 插件统一为候选集，由 Jev 做出类型安全的选择，并由 JevRouter 执行权限、风险、可用性和确认策略。

在 Toolathlon 的 10 个任务中，我们让 Jev 和 DeepSeek V4.1 Flash 预测每个任务前 5 个有序工具调用。Jev 串行模式达到 **38% 的位置命中率**（DeepSeek 为 24%）、**0.9 的平均最长公共前缀**（0.5），速度约快 **5.5 倍**，成本约低 **7 倍**。该实验衡量的是有序路由预测，不是端到端任务完成率。

</details>

## Quick start: Skill + project instructions + CLI

Node.js 20+ is required. In the project you want the Agent to work on, this single command checks Jev, installs the Skill, and launches Codex with the same key:

```bash
JEV_API_KEY="your-typesafe-key" npx --yes github:BillionsBobby/JevRouter agent start --agent codex
```

For Claude Code use `--agent claude`. For OpenRouter replace `JEV_API_KEY` with `OPENROUTER_API_KEY` and add `--provider openrouter`. The host CLI must already be installed. Its login/model credentials are separate from the Jev decision key.

To install without launching a host (including desktop users):

```bash
export OPENROUTER_API_KEY="your-key"; npx --yes github:BillionsBobby/JevRouter agent setup
```

Default setup installs **Skills and project instructions only**. Codex reads `AGENTS.md` (or the active `AGENTS.override.md`) and `.agents/skills/jevrouter/SKILL.md`; Claude Code reads `CLAUDE.md` and `.claude/skills/jevrouter/SKILL.md`. It adds a small CLI helper, using the installed package instead of downloading a package for each decision. Existing instructions are backed up and appended to; conflicting integration files are preserved with a proposed replacement. No key is written to disk. No base model instructions are replaced.

Open a new Agent session in this project, explicitly invoke **`$jevrouter`** in Codex or **`/jevrouter`** in Claude Code, and give your real task. Project rules also ask the Agent to route meaningful capability choices automatically. A running session may need to reload skills; GUI apps must inherit the key environment. An inline `KEY=... setup` assignment ends with setup; `agent start` keeps it in the launched host. Skill instructions guide the host; they cannot intercept every built-in tool.

The Agent gathers its real available candidates and runs Jev before choosing a next step. Expect visible `JevRouter START` / `END`, JSON status, a decision ID and an append-only receipt. Setup's `CHECK passed` proves only connectivity, not that a later task was routed.

```bash
npx --yes github:BillionsBobby/JevRouter agent doctor        # local configuration, no API call
npx --yes github:BillionsBobby/JevRouter agent doctor --live # also perform a small paid Jev check
```

`--skip-check` on setup is available for offline installation; it never claims API validation. MCP is optional with `agent setup --with-mcp`; see [Agent integration](docs/agent-integration.md).

### CLI / SDK

No registry or `init` is required if you supply candidates. Use actual host capabilities rather than copying the example names below.

```bash
OPENROUTER_API_KEY="your-key" npx --yes github:BillionsBobby/JevRouter route --provider openrouter --request "Find original sources before summarizing" --candidates '[{"name":"search_web","description":"Find web sources"},{"name":"summarize","description":"Summarize existing sources"}]'
```

For Agent calls, `route --stdin` accepts a JSON `{request, context?, candidates, input?, actor_permissions?}` object, with no shell interpolation of the request. `--candidates-file` also accepts JSON/YAML arrays or `{candidates: [...]}`. Progress goes to stderr; stdout is one JSON object. Exit codes are 0 for selected, 2 for review/no-decision, and 1 for errors. Empty candidates and missing keys are errors; demo mode must be explicit.

```bash
npm install github:BillionsBobby/JevRouter
```

```ts
import { route } from "jevrouter";
const decision = await route({ request, candidates: agentTools });
```

SDK and CLI share provider selection; real Jev calls are the default. SDK callers can explicitly opt into the local cache with `{cache: true}`. Capabilities still execute through the host's permission system. JevRouter does not change a host's current model or create a Subagent by returning an ID.

## Manifest contract

```json
{
  "id": "github.issue.search",
  "name": "Search GitHub issues",
  "type": "mcp_tool",
  "description": "Search issues in a GitHub repository.",
  "input_schema": { "type": "object", "properties": { "query": { "type": "string" } } },
  "permissions": ["github.read"],
  "risk": { "level": "low", "categories": ["external_read"] },
  "availability": { "available": true },
  "execution": { "mode": "mcp", "target": "github", "dry_run": true },
  "policy": { "requires_confirmation": false }
}
```

Capability discovery accepts local Skill directories, MCP server configuration, CLI names, and DSH plugin manifests:

```bash
npm run dev -- discover \
  --skills examples/skills \
  --mcp examples/mcp.json \
  --cli git,docker \
  --dsh examples/dsh
```

Skill discovery reads `SKILL.md` frontmatter, CLI discovery only calls `<command> --help`, MCP discovery performs `initialize` and `tools/list`, and DSH discovery reads JSON manifests. Discovered capabilities are converted into manifests and written only when their destination does not already exist. Secrets stay in the child process environment and are not copied into manifests.

## Decision response

`route` returns:

- `decision.jev_choice`: the option Jev selected.
- `decision.candidates[].jev_probability`: the exact probability for that option from the provider response.
- `decision.candidates[].router`: availability, permission, risk, confirmation and filter explanation.
- `RouteInput.actor_permissions`: optional caller permissions; when supplied, a capability is filtered if any manifest permission is missing.
- `RouteInput.input`: optional tool arguments; when supplied, the selected manifest's JSON Schema subset is validated before returning a selection.
- `raw_jev`: the complete provider response, including the OpenRouter envelope when the compatibility adapter is used.
- `raw_jev_stages`: coarse and final provider responses when two-stage routing is active.
- `decision.candidates[].jev_stage`: `single`, `coarse`, or `final`.
- `provenance.candidate_snapshot_hash`: stable hash of the sorted candidate set.

When Jev selects a filtered candidate, the router can choose the highest-probability safe candidate, but records that fact in `fallback.reason` and keeps `jev_choice` unchanged. When confidence is below policy, the result is `no_decision` and `selected` is `null`.

## Multi-step plans

`route` answers one question. `plan` answers "which capability should handle step 1..N of this request?" in two modes:

- **Serial** (default): one full routing decision per step. The capabilities selected in earlier steps are appended to the state (`Capabilities already routed in previous steps, in order: ...`), so later steps are conditioned on the plan so far. Works with any candidate count; two-stage routing still applies per step.
- **Batch**: all step questions (`step1`..`stepN`) are asked in a single provider call over the same candidate set — the cheapest and fastest shape. Requires the candidate count to fit `single_stage_max_candidates` (no per-step two-stage); use serial mode for larger sets.

```bash
npm run dev -- plan --request "查找 owner/repo 的登录失败 issue 并汇总成报告保存到本地" --steps 3 --mode serial
npm run dev -- plan --request "search issues then summarize them" --steps 3 --mode batch
```

```ts
import { plan } from "jevrouter";

const result = await plan({ request: "search issues then summarize them", candidates: tools }, { steps: 3, mode: "batch" });
```

The plan contract reuses the routing contract per step:

- `steps[]` is a list of full routing decisions with an added 1-based `step` index: per-step `selected`, `jev_choice`, `status`, candidate probabilities and `router` annotations, and per-step `fallback`. The confidence threshold and filters apply to every step independently.
- Batch mode stores the single provider envelope in `plan.raw_jev` (per-step `raw_jev` is `null`); serial mode keeps each step's own `raw_jev` (plan-level `raw_jev` is `null`).
- Serial mode feeds only post-policy `selected` capabilities forward; a `no_decision` step adds nothing to the state.
- Plans are saved append-only to `.jevrouter/plans/`, alongside decisions.

### Plan strategies

`plan()` accepts strategy knobs (CLI flags in parentheses):

- `decompose: "rule" | DecomposeFn` (`--decompose rule`): split the request into ordered sub-goals first — built-in discourse-marker splitter, or an injected function (e.g. an LLM that sees the tool catalog) — then route each sub-goal as a single-step decision. Decomposition turns a multi-step request into the single-action questions Jev answers most confidently.
- `thread_context: true`: in decompose mode, include the original request, the `Sub-goal k of N` marker, and the capabilities routed so far in each step's state.
- `sequence: "beam"` with `diversity_penalty: λ` (`--sequence beam --diversity-penalty 2.0`): batch mode only. Instead of independent per-step argmax, beam-search the joint sequence over Jev's per-step probability distributions with a repetition penalty. Jev keeps its probabilities; `jev_choice` still reports the per-step argmax and the override is recorded in `fallback.reason`. The same `diversity_penalty` also enables per-step diversity re-ranking in serial/decompose modes.
- `group_by: "server" | "type"` (`--group-by server`): hierarchical routing — a coarse Choice over candidate groups (manifest `metadata.group`/`metadata.server`, falling back to the capability type), then a Choice within the winning group. Both calls are preserved in `raw_jev_stages`.
- `state_detail: "targets"` (`--state-detail targets`): serial mode adds concrete targets (files, URLs, identifiers) extracted from the request to the state.
- `plan_hint: string[]` (SDK only): include an ordered plan sketch in every serial step's state.

Measured on 10 Toolathlon tasks (first-5 tool-call prediction vs hand-labeled gold, real tool inventories from 9 live MCP servers, Jev `typesafe/jev-1.13-20260917`): position-wise hits went from 38% (serial baseline) to **44%** with tool-aware LLM decomposition + `thread_context`, unordered overlap from 54% to **58%**; batch mode with `sequence: "beam"` (λ=2.0) went from 28% to **36%** hits at zero extra provider calls. The same decompose+thread configuration lifted MCP-Atlas (10 tasks) from 29% to **44%** hits. Standalone `group_by` and `state_detail: "targets"` did not improve the baseline in these runs — they are available as options, and the negative result is documented for future tuning.

## Security posture

- Decision-only is the only mode in this MVP; no CLI, Skill, MCP or DSH action runs implicitly.
- Medium/high/critical capabilities require confirmation by default.
- Missing permissions, unavailable capabilities and disallowed risk levels are hard filters.
- API keys are read from environment variables and never written to manifests or decision files.
- Decision files are append-only; rerunning a route creates a new decision ID.
- CLI routes call the provider live with cache disabled; SDK caching is opt-in.

## Scope and evidence

The Jev API shape in this repository follows TypeSafe's public docs: `POST /v1/systemone` with `state`, `model`, and a `Choice` question; responses contain `choice`, `probabilities`, and `confidence`. The OpenRouter adapter follows OpenRouter's public Decisions endpoint and preserves the returned typed answers. Provider performance and accuracy claims remain provider claims; this repository does not present them as JevRouter benchmarks.

## License

MIT.
