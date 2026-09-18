# Skill + CLI validation

Validated on 2026-09-19 (Asia/Shanghai). This is integration evidence, not an accuracy benchmark or a guarantee that every Agent follows project instructions.

## Real host workflow

- Host: Codex CLI `0.155.0-alpha.9`, new ephemeral session in an isolated Git project.
- Installed: `AGENTS.md`, `.agents/skills/jevrouter/SKILL.md`, local CLI helper. No JevRouter MCP configuration was required.
- Task: choose and invoke one of two local test tools to find interview source material; lookup and summarization were both real runnable fixture tools.
- The task prompt did not tell the host which tool to choose or explicitly ask it to invoke JevRouter. It permitted the installed Skill's API use.
- Observed sequence: read project instructions → read Skill → announce routing → invoke installed helper with real candidates → report decision → invoke selected local tool.
- Live provider: OpenRouter Decisions; resolved Jev model `typesafe/jev-1.13-20260917`.
- Decision: `dec_12d8c09e-abe8-4778-bf7f-9e21b25c600e`; selected `node tools/lookup.mjs`, probability `0.91`, confidence `0.82`, alternative `0.09`. Cache disabled, local elapsed time 850 ms, reported Jev cost $0.000019362.
- The host then ran `node tools/lookup.mjs`, receiving the fixture's `source_found` result. The fixture is not a verified real interview source.

An earlier test prohibited external API use. The host respected that restriction, disclosed that JevRouter had not run, and used an explicit local fallback. That is not counted as a successful Jev routing run.

Claude Code was not installed in this validation environment. Its generated Skill/instructions, CLI launcher, and key inheritance were checked with integration tests; a live Claude session is not claimed.

## Automated coverage

`npm test` builds production JavaScript and checks process-level setup, stdin routing and failure exit codes. Provider transports in these automated tests are explicitly stubbed and do not establish live model accuracy.

- Fresh setup with `JEV_API_KEY`, no `init` or MCP dependency.
- Real-shaped Choice responses, raw probabilities and confidence preserved.
- Installed helper invoked from another working directory.
- Existing project instructions backed up and preserved; identical setup is idempotent.
- Active Codex override support and legacy MCP files preserved.
- Missing credentials, rejected credentials, malformed input and empty/duplicate candidates fail visibly.
- Optional MCP conflicts produce a proposal, preserving existing configuration.
- Host-launch boundary checks key inheritance and does not launch after authentication failure.
- Paths containing spaces and quotes; JSON/YAML candidate inputs; SDK provider precedence.
- Doctor distinguishes local configuration checks from the optional live probe.

Host trust, permissions, network policy and Skill loading remain prerequisites. Use `$jevrouter` / `/jevrouter` for an explicit first invocation; subsequent implicit invocation is host-guided, not intercepted by the router.
