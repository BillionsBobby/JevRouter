# 04 · Use with Claude Code

**Goal**: Claude Code routes its meaningful capability choices through Jev automatically, via a project-local Skill + instructions.

## Prerequisites

- Claude Code installed and logged in (its own credentials are separate from the Jev decision key)
- `OPENROUTER_API_KEY` or `JEV_API_KEY` exported

## Install into a project

From the project root:

```bash
npx --yes github:BillionsBobby/JevRouter agent start --agent claude
```

The command asks for the official Jev API or OpenRouter key without echoing or storing it. Or, without launching Claude Code:

```bash
export OPENROUTER_API_KEY="your-key"; npx --yes github:BillionsBobby/JevRouter agent setup --agent claude
```

## What lands in your project

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project routing rule; existing instructions are backed up and appended to, never replaced |
| `.claude/skills/jevrouter/SKILL.md` | The `/jevrouter` Skill: when and how to route |
| `.claude/skills/jevrouter/scripts/route.mjs` | CLI helper that reuses the installed package |
| `.jevrouter/integration-v2.json` | Integration receipt (no key is ever written to disk) |

Add `--with-mcp` to also register the MCP adapter ([recipe 05](05-mcp-adapter.md)).

## Verify

```bash
npx --yes github:BillionsBobby/JevRouter agent doctor --agent claude --live
```

## Use it

In Claude Code, invoke **`/jevrouter`** explicitly for the first task, or just work normally — the project rules ask the agent to route meaningful capability choices automatically. Expect visible `JevRouter START` / `END` lines, a JSON status, a decision ID, and an append-only receipt in `.jevrouter/decisions/`.

The same caveats as Codex apply: `agent start` needs a real terminal; keep the key exported; `CHECK passed` proves connectivity only. See [recipe 03](03-use-with-codex.md) for the detailed notes.
