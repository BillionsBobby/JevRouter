# JevRouter

<p><a href="#jevrouter">English</a> · <a href="#中文介绍">中文</a></p>

JevRouter is a small, local-first router for Agent capabilities. It turns models, Subagents, Skills, MCP Tools, CLIs and DSH plugins into one candidate set, asks Jev one typed Choice question, and applies hard policy checks around the returned decision.

The key contract is simple: Jev owns the decision probabilities; JevRouter owns availability, permissions, risk and confirmation. Router fields live under `router`, while the original `probabilities`, `confidence`, and complete provider response remain intact. Filtered candidates are never re-normalized.

Small candidate sets use one Jev Choice call. When `single_stage_max_candidates` is exceeded, JevRouter first keeps the coarse Top-K candidates, then asks Jev for a final Choice over that reduced set. Both raw responses are returned in `raw_jev_stages`; coarse probabilities remain attached to candidates that were not sent to the final stage.

## Why this shape

TypeSafe documents Jev as a System One model: structured state in, typed decisions with probability distributions and confidence out. That makes it useful as a fast decision layer in front of tools, while a normal reasoning model can remain the execution or fallback layer. JevRouter keeps that boundary explicit and defaults to decision-only mode.

The core integration is the one-call SDK or CLI. MCP is an optional compatibility adapter for Agents that already load tools through MCP; it exposes one `jev_route` tool and does not execute the selected capability implicitly.

## Benchmark snapshot

We evaluated Jev on 10 Toolathlon tasks by predicting each task's first five ordered tool calls, comparing it with DeepSeek V4.1 Flash. In serial mode, Jev reached **38% position-wise accuracy** versus 24%, achieved a **0.9 mean longest common prefix** versus 0.5, ran about **5.5× faster** (1.58s vs 8.65s per task), and cost about **7× less** ($0.0058 vs $0.0407 for 10 tasks). The experiment measures ordered routing decisions, not end-to-end task completion.

<details>
<summary id="中文介绍">中文介绍</summary>

JevRouter 是一个本地优先的 Agent 能力路由器，将模型、Subagent、Skill、MCP 工具、CLI 和 DSH 插件统一为候选集，由 Jev 做出类型安全的选择，并由 JevRouter 执行权限、风险、可用性和确认策略。

在 Toolathlon 的 10 个任务中，我们让 Jev 和 DeepSeek V4.1 Flash 预测每个任务前 5 个有序工具调用。Jev 串行模式达到 **38% 的位置命中率**（DeepSeek 为 24%）、**0.9 的平均最长公共前缀**（0.5），速度约快 **5.5 倍**，成本约低 **7 倍**。该实验衡量的是有序路由预测，不是端到端任务完成率。

</details>

## Quick start

```bash
npm install
npm run typecheck
npm test

npm run dev -- init
npm run dev -- capability add examples/capabilities/github.issue.search.json
npm run dev -- capability add examples/capabilities/github.issue.create.json
npm run dev -- capability add examples/capabilities/repo.clone.json
npm run dev -- capability add examples/capabilities/summarize.issues.json
npm run dev -- capability add examples/capabilities/dsh.github.workflow.json
npm run dev -- capability add examples/capabilities/model.gpt-6-terra.json
npm run dev -- capability add examples/capabilities/model.claude-sonnet.json
npm run dev -- capability add examples/capabilities/subagent.researcher.json

# Works offline. The result is explicitly labelled jevrouter-demo.
npm run dev -- route --request "查找 owner/repo 最近 30 天的登录失败 issue"
# Inspect a saved decision without calling the provider again.
npm run dev -- decision show <decision-id>
```

To use the official Jev API, set `TYPESAFE_API_KEY` or `JEV_API_KEY` and omit `--provider demo`:

```bash
TYPESAFE_API_KEY=... npm run dev -- route \
  --request "查找 owner/repo 最近 30 天的登录失败 issue"
```

The direct TypeSafe endpoint is `https://api.typesafe.ai/v1/systemone`. For an OpenRouter Jev route, set `OPENROUTER_API_KEY`; JevRouter uses OpenRouter's native Decisions endpoint (`/api/alpha/decisions`) with the `~typesafe/jev-latest` model and labels the provider as `openrouter:~typesafe/jev-latest`.

Start the local HTTP process when an Agent wants a stable boundary:

```bash
npm run dev -- serve --provider demo --port 8787
curl -s http://127.0.0.1:8787/route \
  -H 'content-type: application/json' \
  -d '{"request":"查找登录失败 issue"}'
```

For a one-line TypeScript integration, use the SDK. It reads `JEV_API_KEY`, `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` automatically:

```ts
import { route } from "jevrouter";

const decision = await route({ request: "查找登录失败 issue", candidates: tools });
```

The CLI is the equivalent one-line shell interface:

```bash
JEV_API_KEY=... npx jevrouter route --request "查找登录失败 issue"
```

For Codex, Claude, or another MCP-native Agent, run the optional stdio adapter:

```json
{
  "mcpServers": {
    "jevrouter": {
      "command": "npx",
      "args": ["-y", "jevrouter", "serve-mcp"],
      "env": { "JEV_API_KEY": "..." }
    }
  }
}
```

The Agent can call `jev_route` with its current `candidates` array. A candidate can have `type: "model"`, `"subagent"`, `"mcp_tool"`, `"skill"`, `"cli"`, or `"dsh"`; the routing contract is the same.

### One-command Agent setup

For a trusted project, generate the Codex and/or Claude Code MCP entry without writing the key to disk:

```bash
export JEV_API_KEY="your Jev key"
npx --yes github:BillionsBobby/JevRouter agent setup --agent all
```

This creates or updates project-level `.codex/config.toml` and `.mcp.json` additively. Codex receives `JEV_API_KEY` through `env_vars`; Claude Code uses `${JEV_API_KEY}` expansion. Restart the Agent after setup. The MCP server instructions tell the Agent to call `jev_route` before choosing a meaningful model, Tool, or Subagent; the Agent still performs the selected execution.

For only one host:

```bash
npx --yes github:BillionsBobby/JevRouter agent setup --agent codex
npx --yes github:BillionsBobby/JevRouter agent setup --agent claude
```

The generated MCP command uses the public GitHub package source so this works before an npm release. After `jevrouter` is published, set `JEVROUTER_PACKAGE=jevrouter` before setup to use the npm package instead.

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

## Security posture

- Decision-only is the only mode in this MVP; no CLI, Skill, MCP or DSH action runs implicitly.
- Medium/high/critical capabilities require confirmation by default.
- Missing permissions, unavailable capabilities and disallowed risk levels are hard filters.
- API keys are read from environment variables and never written to manifests or decision files.
- Decision files are append-only; rerunning a route creates a new decision ID.
- CLI requests reuse a local cache keyed by provider, state, and the exact candidate snapshot; set `JEV_ROUTER_CACHE=0` to disable it.

## Scope and evidence

The Jev API shape in this repository follows TypeSafe's public docs: `POST /v1/systemone` with `state`, `model`, and a `Choice` question; responses contain `choice`, `probabilities`, and `confidence`. The OpenRouter adapter follows OpenRouter's public Decisions endpoint and preserves the returned typed answers. Provider performance and accuracy claims remain provider claims; this repository does not present them as JevRouter benchmarks.

## License

MIT.
