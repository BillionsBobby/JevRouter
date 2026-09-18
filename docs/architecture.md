# Architecture

```text
Agent host (Codex / Claude Code / custom)
        │ MCP or SDK
        ▼
JevRouter
  ├─ normalize native candidates
  ├─ build Jev Choice / multi-step questions
  ├─ preserve raw probabilities and confidence
  ├─ apply local policy and permission gates
  ├─ cache by provider + state + candidate snapshot
  └─ return a decision handoff
        │
        ▼
Agent host executes the selected model, Tool, or Subagent
```

JevRouter is a local control layer. It does not replace the Agent's reasoning loop and does not silently execute external side effects.

## Boundaries

- **Jev**: typed decisions, probabilities, confidence, and raw provider response.
- **JevRouter**: candidate normalization, stable snapshots, policy filtering, confidence gates, multi-step plans, cache, and decision records.
- **Agent host**: user interaction, execution approval, model/tool/subagent invocation, and result handling.

## Provider paths

- Official TypeSafe API: `https://api.typesafe.ai/v1/systemone`
- OpenRouter Decisions API: `https://openrouter.ai/api/alpha/decisions`
- Offline demo provider: local tests and demos only; its output is explicitly labelled `jevrouter-demo`.

## Safety boundary

The default mode is `decision_only`. A capability can be filtered for unavailable state, missing permissions, disallowed risk, or insufficient confidence. Router-derived fields stay under `router`; Jev probabilities are not re-normalized or overwritten.
