# Agent integration

JevRouter adds a Jev decision step to an Agent host. The host still performs the selected execution.

## One-command setup

Until an npm release is available, run the setup command from GitHub:

```bash
export JEV_API_KEY="your Jev key"
npx --yes github:BillionsBobby/JevRouter agent setup --agent all
```

The command creates project-level configuration for Codex and Claude Code:

- `.codex/config.toml` forwards `JEV_API_KEY` with `env_vars`.
- `.mcp.json` expands `${JEV_API_KEY}` at runtime.

The key is never written into either file. Restart the Agent after setup.

After JevRouter is published to npm, set `JEVROUTER_PACKAGE=jevrouter` before running setup to use the package name.

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
