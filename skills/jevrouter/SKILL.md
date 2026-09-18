---
name: jevrouter
description: Use Jev to choose the next tool, model, or subagent when a task has competing capability choices, the user asks for routing, or the next step is uncertain. Use the real current task and available candidates.
---

# JevRouter

Announce “JevRouter: routing the next step” when starting. A past setup check is not a routing decision for the current task.

At the first meaningful capability choice, and again when an observation changes the next step, gather the tools/models/subagents actually available to this host. Submit the current task and at least two plausible choices; exclude JevRouter itself. Keep exact host tool names. Never reuse a GitHub example catalog for an unrelated task or invent unavailable model/subagent IDs. Skip trivial chat and steps whose sole permitted operation the user has already specified.

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

The names above illustrate the shape: replace the task and candidates with this turn's real capabilities. Model/subagent candidates use `{id,name,type,description}` with `type: model` or `subagent`. CLI also accepts `--request` with `--candidates-file` for JSON/YAML, and SDK users can call `route({request,candidates})`.

Read the JSON on stdout; progress is on stderr. State the returned `decision_id`, `status`, `decision.selected`, and whether the provider was live or demo. If `status=selected`, execute only that available capability through the host's own permission checks. If confirmation is required, obtain it first. On `no_decision`, invalid input, missing credentials, or network error, explain the fallback and gather better inputs; never describe a failed or demo call as live Jev routing. CLI exit codes: 0 selected, 2 review/no-decision, 1 error.

After execution, include the observation in the next routing request when needed. This is a routing aid: it does not switch the host's underlying model, spawn agents, or execute returned IDs automatically. Do not recurse into routing the router or run routing again just to make status green.

If the optional MCP tool `jev_route` is already loaded, it accepts the same request and candidate payload. Always respect project instructions and host authorization.
