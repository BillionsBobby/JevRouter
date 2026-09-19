# 03 · Use with Codex

**Goal**: Codex routes its meaningful capability choices through Jev automatically, via a project-local Skill + instructions.

## Prerequisites

- Codex CLI installed and logged in (its own credentials are separate from the Jev decision key)
- `TYPESAFE_API_KEY`, `JEV_API_KEY`, or `OPENROUTER_API_KEY` exported, or an interactive terminal for secure entry

## Install into a project (recommended: persistent entrypoint)

From the project root:

```bash
npx --yes github:BillionsBobby/JevRouter agent start --agent codex
```

This asks for the official Jev API or OpenRouter key when one is not already exported, without echoing or storing it. It checks Jev connectivity (one small paid call), installs the Skill + project instructions, then launches Codex attached to this session. The command stays attached until Codex exits; the Skill and instructions remain in the project for later sessions.

Install without launching (e.g. desktop users, CI):

```bash
export OPENROUTER_API_KEY="your-key"; npx --yes github:BillionsBobby/JevRouter agent setup --agent codex
```

## What lands in your project

| File | Purpose |
|---|---|
| `AGENTS.md` (or `AGENTS.override.md`) | Project routing rule; existing instructions are backed up and appended to, never replaced |
| `.agents/skills/jevrouter/SKILL.md` | The `$jevrouter` Skill: when and how to route |
| `.agents/skills/jevrouter/scripts/route.mjs` | CLI helper that reuses the installed package instead of downloading per decision |
| `.jevrouter/integration-v2.json` | Integration receipt (no key is ever written to disk) |

Add `--with-mcp` to also register the MCP adapter ([recipe 05](05-mcp-adapter.md)).

## Verify

```bash
npx --yes github:BillionsBobby/JevRouter agent doctor          # local configuration, no API call
npx --yes github:BillionsBobby/JevRouter agent doctor --live   # + small paid Jev probe
```

`doctor` reports the instruction file, Skill file, helper freshness and key availability per agent; exit code is non-zero until configuration is complete.

## Use it

In Codex, invoke **`$jevrouter`** explicitly for the first task, or just ask a real question — the project rules ask Codex to route meaningful capability choices automatically. Expect visible `JevRouter START` / `END` lines on stderr, a JSON status on stdout, a decision ID, and an append-only receipt in `.jevrouter/decisions/`.

Notes:

- `agent start` needs a real terminal (Codex is interactive); on headless machines use `agent setup` and launch Codex yourself.
- Keep the key exported in the agent's environment; add it to your shell profile or secret manager to survive new terminals.
- Skill instructions guide the host; they cannot intercept every built-in tool. `setup`'s `CHECK passed` proves connectivity, not that a later task was routed.

## Uninstall / repair

Re-running `agent setup` is idempotent for the Skill; conflicting integration files are preserved with a proposed replacement next to them. `agent doctor` lists anything stale.
