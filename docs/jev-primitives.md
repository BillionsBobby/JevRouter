# Jev primitives: Choice, Score, Noul — and structured state

Everything on this page is verified against the live Jev API (via OpenRouter's Decisions endpoint) and follows the [TypeSafe docs](https://docs.typesafe.ai/).

## Ground rules from the official docs

- **Jev is text-only.** Per the [State docs](https://docs.typesafe.ai/concepts/state): *"Jev accepts text only. State must be a string, JSON object, or array of text values. Images, audio, and video are not supported (yet)."*
  - Measured nuance: OpenRouter's alpha Decisions endpoint does not reject `image_url` content parts, and image content does shift answers (a dice photo flipped the answer from a strong text-only prior) — but confidence collapses to ~0. **Do not build on this; treat Jev as text-only.**
- **State can be a string, a JSON object, or an array of text values.** Objects are the recommended default: each part of the state keeps a descriptive name instead of being flattened into one string.
- **One call, many questions.** Choice, Score, and Noul questions can be mixed in a single request; each is evaluated independently against the same state, and `usage` is counted once for the whole call.
- **Language.** Jev's primary training language is English; other languages, including CJK, work but currently score lower accuracy. Prefer English state for critical routing.

## Structured state in JevRouter

`RouteInput.context` and `actor` are sent as structured JSON, not stringified into the request:

```ts
import { route } from "jevrouter";

const decision = await route({
  request: "Find login-failure issues from the last 30 days",
  actor: "triage-agent",
  context: { repo: "owner/repo", window_days: 30 },
  candidates: tools,
});
// state sent to Jev: { request: "...", actor: "triage-agent", context: { repo: "owner/repo", window_days: 30 } }
```

A bare request with no actor/context is still sent as a plain string — nothing changes for simple calls. The same applies per step inside `plan()` (progress threading is added to the `request` field, context travels intact).

CLI equivalent:

```bash
OPENROUTER_API_KEY="your-key" npx --yes github:BillionsBobby/JevRouter route --provider openrouter \
  --request "Find login-failure issues from the last 30 days" \
  --context '{"repo":"owner/repo","window_days":30}' \
  --candidates-file candidates.json
```

## The three primitives

| Primitive | Question shape | Typed answer | Use it for |
|---|---|---|---|
| Choice | pick one option from `criteria` | `choice`, `probabilities`, `confidence` | routing, classification, ranking |
| Score | rate against ordered levels | `score` (expected level index), `probabilities`, `confidence` | severity, urgency, quality grading |
| Noul | is this true? | `noul` (0–1 probability of true) | guardrails, "should we even call a tool", fact checks |

## `evaluate()`: one call, mixed batch

```ts
import { evaluate, getChoiceAnswer, getScoreAnswer, getNoulAnswer } from "jevrouter";

const raw = await evaluate({
  state: { ticket: "Checkout page shows a blank screen after I click Pay. Tried two browsers.", customer_tier: "enterprise" },
  questions: {
    team: { type: "choice", instructions: "Which team should own this ticket?",
            criteria: { payments: "Checkout, billing, or payment processing issues", frontend: "Rendering or browser issues", account: "Login or profile issues" } },
    urgency: { type: "score", instructions: "How urgent is this ticket?",
               criteria: ["Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"] },
    is_bug: { type: "noul", instructions: "Is the customer reporting a software defect?",
              criteria: { true: "The customer describes broken product behavior", false: "The customer asks a question or requests a feature" } },
  },
}, { provider: "openrouter" });

getChoiceAnswer(raw, "team");      // { choice: "payments", confidence: 0.84, ... }
getScoreAnswer(raw, "urgency");    // { score: 2, confidence: 1, ... }  (2 = blocking revenue)
getNoulAnswer(raw, "is_bug");      // { noul: 0.96 }
// one provider call: 458 input tokens / 70 output tokens / $0.000019 (measured)
```

Notes:

- A Choice question inside `evaluate()` may omit `criteria` if you pass `candidates` (they become the criteria, exactly like `route()`); with neither, you get a clear local error before any API call.
- Score questions require a non-empty `criteria` array of ordered levels — also validated locally.
- `getChoiceAnswer` / `getScoreAnswer` / `getNoulAnswer` validate the raw answer's shape and throw `jev_malformed_response` on garbage, so a provider quirk never becomes a silent wrong value.
- The labelled offline demo provider (`provider: "demo"`) answers all three primitives deterministically for offline development and CI.

## Patterns enabled

- **Confidence-gated routing**: act on `choice` only when `confidence` clears your bar, else fall back to a reasoning model (this is `route()`'s built-in `min_confidence` policy).
- **"Should a tool run at all?"**: a Noul question before routing saves both latency and tokens when the answer is "just reply in text".
- **Composite scoring**: ask several narrow Score questions (market size, feasibility, differentiation) and combine with your own weights — per the TypeSafe composite-scoring pattern.
