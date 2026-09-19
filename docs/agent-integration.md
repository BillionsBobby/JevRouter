# Agent integration

## Start in one command

Run in the project in which the Agent will work. This command keeps the host Agent running and leaves the Skill and project instructions installed in the project:

```bash
npx --yes github:BillionsBobby/JevRouter agent start --agent codex
```

The command asks whether to use the official Jev API or OpenRouter and reads the key without echoing it. For Claude Code, change `--agent codex` to `--agent claude`, and for Cursor use `--agent cursor`. In CI or another non-interactive shell, export `TYPESAFE_API_KEY`, `JEV_API_KEY`, or `OPENROUTER_API_KEY` and optionally pass `--provider typesafe|openrouter`.

The command performs a small live Jev connection check, installs a Skill and project instructions, and launches the installed host CLI with the same environment. The process stays attached until the host exits; the generated files remain for later sessions. Each check sends a labelled two-option connectivity request and may incur an API charge. It does not route a user task or fabricate a capability catalog. The Agent's own model account is separate from the Jev key. For future non-interactive sessions, add the selected environment variable to a shell profile or secret manager.

`agent setup` installs without launching. Its default target is Codex, Claude, and Cursor; `--agent codex|claude|cursor` restricts it. `--skip-check` is an explicit offline install and requires later validation. `export KEY=...; ... setup` retains the key for future terminal commands. Desktop hosts must also be launched with that environment.

## Installed files

| File | Purpose |
|---|---|
| `AGENTS.md` or existing nonempty `AGENTS.override.md` | Codex project routing rule |
| `CLAUDE.md` | Claude Code project routing rule |
| `.cursorrules` | Cursor project routing rule |
| `.agents/skills/jevrouter/SKILL.md` | Codex Skill (`$jevrouter`) |
| `.claude/skills/jevrouter/SKILL.md` | Claude Skill (`/jevrouter`) |
| `.cursor/skills/jevrouter/SKILL.md` | Cursor Skill (`@jevrouter`) |
| `.cursor/mcp.json` | Optional Cursor MCP configuration (when `--with-mcp` is passed) |
| Each Skill's `scripts/route.mjs` | Invokes the installed CLI in the project directory |
| `.jevrouter/integration-v2.json` | Non-secret provider/key-name and launcher metadata |

Existing project instruction bytes are backed up and preserved, with a routing block appended exactly once. Conflicting Skill/config files produce a separate proposal and an error; nothing is silently overwritten. Repeating an identical setup does not duplicate blocks. If the package install/cache moves or is removed, reinstall at a stable location and review the new proposed launcher.

Legacy MCP configurations remain unchanged by default. The v2 rule uses CLI, so it also works when old MCP credentials are unavailable. It never writes `model_instructions_file` or replaces the host's base prompt.

## What a routed task looks like

1. The host reads project instructions and the Skill.
2. It announces JevRouter routing and submits the actual task plus real, currently available tools/models/subagents via `route --stdin`.
3. JevRouter prints `START`, calls Jev, applies policy, saves a decision receipt, and prints `END` with the status and ID.
4. The host reports the ID/status and performs the selected operation subject to host permissions. It gathers the observation before deciding whether another routing call is needed.

The receipt contains the raw Jev response, candidate probabilities, policy fields, `runtime.source`, duration and cache status. The host's execution is not claimed as verified by that receipt. `no_decision` and `needs_confirmation` require explicit handling. Missing keys never silently activate demo; use `--provider demo` only for labelled offline tests.

No API can discover a host's private tool inventory just from a Jev key: the Skill tells the host to supply its current candidates. Do not route an interview task using a copied GitHub-only example registry. CLI supports stdin, `--candidates` JSON, `--candidates-file` JSON/YAML, or an explicitly populated registry. Models and Subagents must already be callable by the host.

## Diagnostics and optional MCP

`agent doctor` performs read-only local configuration/Skill/launcher/key-presence checks, with `scope: local_configuration_only`. It cannot prove that a running host has loaded instructions. `agent doctor --live` also calls Jev and returns a separately labelled connection check. Invalid setup has a nonzero exit code.

`agent setup --with-mcp` additionally writes `.codex/config.toml` and `.mcp.json`. It references the installed CLI directly, forwards one selected key, and does not alter base prompts. Existing differing MCP files produce proposals for manual merge; the default CLI Skill does not need them.

After starting a new Agent session, use `$jevrouter` or `/jevrouter` explicitly to validate a first real task. Implicit triggering depends on the host following project instructions; this is not a tool interception layer. Host approval, trust, and network restrictions remain in force.

## Upstream contracts

- [Codex Skills](https://developers.openai.com/codex/skills)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Jev Choice API](https://docs.typesafe.ai/primitives/choice)
