# Agent integration

JevRouter adds a Jev decision step to an Agent host. The host still performs the selected execution.

## One-command setup

Until an npm release is available, run the setup command from GitHub:

```bash
export OPENROUTER_API_KEY="your OpenRouter Jev key"
npx --yes github:BillionsBobby/JevRouter agent setup --agent all
```

The command creates project-level configuration for Codex and Claude Code:

- `.codex/config.toml` forwards the selected provider key with `env_vars`.
- `.codex/jevrouter-instructions.md` is loaded through `model_instructions_file` and tells Codex to route meaningful capability choices first.
- `.mcp.json` expands only the selected provider key at runtime.
- `CLAUDE.md` gives Claude Code the same routing rule.
- `.agents/skills/jevrouter-routing/SKILL.md` and `.claude/skills/jevrouter-routing/SKILL.md` provide the reusable Skill procedure, including the CLI fallback.

The key is never written into either file. Restart the Agent after setup.

Check the setup without making changes:

```bash
OPENROUTER_API_KEY="your key" npx --yes github:BillionsBobby/JevRouter agent doctor --agent all
```

Both agents should report `configured: true` and an empty `issues` array.

After JevRouter is published to npm, set `JEVROUTER_PACKAGE=jevrouter` before running setup to use the package name.

When using OpenRouter, setup detects `OPENROUTER_API_KEY` automatically. You can make the provider explicit with `--provider openrouter` or `--provider typesafe`. Only the selected provider environment variable is injected, so Claude Code does not see unresolved `${VAR}` references.

The CLI fallback accepts the Agent's real candidates without requiring a registry:

```bash
OPENROUTER_API_KEY="your key" \
npx --yes github:BillionsBobby/JevRouter route \
  --provider openrouter \
  --request "choose a research capability" \
  --candidates-file ./jevrouter-candidates.json
```

## Runtime flow

1. The Agent receives a user request.
2. Before choosing a meaningful model, Tool, or Subagent, it calls `jev_route`.
3. The call includes the request and native candidate descriptors when the host can provide them.
4. Jev returns a typed Choice with probabilities and confidence.
5. JevRouter applies availability, permission, risk, and confirmation policy.
6. The Agent executes the returned `selected` capability when status permits.
7. `no_decision` and `needs_confirmation` remain host-visible states; the Agent must not guess around them.

The MCP server is decision-only. It does not invoke the selected Tool or Subagent implicitly.

## MCP tools

- `jev_route`: route a request across model, Subagent, Skill, MCP Tool, CLI, or DSH candidates.
- `jev_capabilities`: list capabilities registered in the local `.jevrouter` registry.

Native OpenAI Function Tool descriptors are accepted directly:

```json
{
  "type": "function",
  "function": {
    "name": "search_web",
    "description": "Search the web for source material",
    "parameters": { "type": "object" }
  }
}
```
