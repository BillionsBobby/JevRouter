# JevRouter Cookbook

Task-oriented recipes with exact commands and expected output. Everything here runs against the real Jev API (or the labelled offline demo provider where noted) — no mocks.

| # | Recipe | You will learn |
|---|---|---|
| 01 | [Route your first request](01-route-your-first-request.md) | One-shot CLI routing, inline candidates, exit codes, offline demo |
| 02 | [Multi-step plans](02-multi-step-plans.md) | serial / batch / decompose modes, beam sequences, strategy knobs |
| 03 | [Use with Codex](03-use-with-codex.md) | `agent setup`, `agent doctor`, `agent start`, the `$jevrouter` Skill |
| 04 | [Use with Claude Code](04-use-with-claude-code.md) | Same integration flow for Claude Code (`/jevrouter`) |
| 05 | [MCP adapter](05-mcp-adapter.md) | `serve-mcp` stdio server, the `jev_route` tool, host MCP configs |
| 06 | [Custom candidates & discovery](06-custom-candidates.md) | Manifest contract, OpenAI-style tool shapes, `discover` |
| 07 | [Policy, risk & confirmation](07-policy-and-confirmation.md) | `policy.json`, confidence gates, permissions, `no_decision` |
| 08 | [Offline, caching & receipts](08-offline-and-caching.md) | Demo provider, cache control, provenance, append-only receipts |
| 09 | [Local dashboard](09-local-dashboard.md) | Read-only routing statistics and effect boundary |

**Before you start**: Node.js 20+, and either a Jev key (`JEV_API_KEY`, from TypeSafe) or an OpenRouter key (`OPENROUTER_API_KEY`). All commands use the `npx --yes github:BillionsBobby/JevRouter` form so they work without cloning; from a clone you can substitute `npm run dev --`.
