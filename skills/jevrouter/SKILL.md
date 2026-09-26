---
name: jevrouter
description: Use Jev to choose among relevant tools, models, skills, MCP servers, and Codex subagents for non-trivial task steps when routing can save execution time or reasoning cost. Use the real current task and available candidates.
---

# JevRouter

Announce “JevRouter: routing the next step” when starting. A past setup check is not a routing decision for the current task.

Route each non-trivial step when there are materially different available ways to do it and Jev's selection can reduce tool choice or reasoning overhead. Include commands, MCP tools, skills, and Codex subagents when they are actually available and relevant. Keep the candidate set small and task-specific (usually 2–5), rather than sending the entire installed tool/agent catalog. Skip trivial chat, fixed one-operation requests, and cases where the routing call would cost more time than it can save. For Codex subagents, use exact `name` and `description` values from relevant `~/.codex/agents/*.toml` profiles or built-in runtime agents; never send their `developer_instructions` to Jev. Jev selects; the Codex host performs the actual native spawn and enforces permissions.

Use the installed CLI helper. It reads the inherited Jev key. Do not print keys, put them in arguments, or replace them with placeholders.

```sh
{{JEVROUTER_COMMAND}} route --stdin <<'JEV_INPUT'
{
  "request": "Find the latest interview and retrieve its original source",
  "context": {"next_step": "Find the source before summarizing it"},
  "candidates": [
    {"name": "web_search", "description": "Find current web sources"},
    {"name": "summarize", "description": "Summarize sources already retrieved"}
  ]
}
JEV_INPUT
```

The names above illustrate the shape: replace the task and candidates with this turn's real capabilities. Model/subagent candidates use `{id,name,type,description}` with `type: model` or `subagent`. To discover Codex profiles, use `jevrouter discover --codex-agents "$HOME/.codex/agents" --codex-agent-names agent_one,agent_two` and route only the task-relevant profile manifests. CLI also accepts `--request` with `--candidates-file` for JSON/YAML, and SDK users can call `route({request,candidates})`.

Read the JSON on stdout; progress is on stderr. State the returned `decision_id`, `status`, `decision.selected`, and whether the provider was live or demo. If `status=selected`, execute only that available capability through the host's own permission checks. If confirmation is required, obtain it first. On `no_decision`, invalid input, missing credentials, or network error, explain the fallback and gather better inputs; never describe a failed or demo call as live Jev routing. CLI exit codes: 0 selected, 2 review/no-decision, 1 error.

After execution, include the observation in the next routing request when needed. This is a routing aid: it does not switch the host's underlying model, spawn agents, or execute returned IDs automatically. For a selected subagent, use the host's native spawn capability with the selected agent type and return its result to the parent task. Do not recurse into routing the router or run routing again just to make status green.

If the optional MCP tool `jev_route` is already loaded, it accepts the same request and candidate payload. Always respect project instructions and host authorization.
