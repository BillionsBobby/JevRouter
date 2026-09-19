# 06 · Custom candidates & discovery

**Goal**: supply the right candidates — hand-written manifests, OpenAI-style tool descriptors, or discovery from your environment.

## Minimal candidate shapes

JevRouter accepts manifests, OpenAI function tools, and simple name/description descriptors without a conversion step:

```jsonc
// Full manifest (all fields optional beyond id/name/type/description)
{
  "id": "github.issue.search",
  "name": "Search GitHub issues",
  "type": "mcp_tool",                    // model | subagent | mcp_tool | skill | cli | dsh
  "description": "Search issues in a GitHub repository.",
  "input_schema": { "type": "object", "properties": { "query": { "type": "string" } } },
  "permissions": ["github.read"],        // matched against actor_permissions
  "risk": { "level": "low" },            // low | medium | high | critical
  "availability": { "available": true },
  "verification": { "status": "verified", "source": "mcp-discovery" },
  "policy": { "requires_confirmation": false },
  "metadata": { "group": "github" }      // used by plan --group-by
}
```

```jsonc
// OpenAI function tool — accepted as-is
{ "type": "function", "function": { "name": "search_web", "description": "Find web sources", "parameters": { "type": "object" } } }
```

```jsonc
// Simplest form
{ "name": "search_web", "description": "Find web sources" }
```

## Discover candidates from your environment

```bash
npm run dev -- discover \
  --skills examples/skills \   # reads SKILL.md frontmatter
  --mcp examples/mcp.json \    # performs initialize + tools/list
  --cli git,docker \           # only calls `<command> --help`
  --dsh examples/dsh           # reads DSH plugin manifests
```

Discovered capabilities become manifests in `.jevrouter/capabilities/`, written only when the destination does not already exist. Secrets stay in the child process environment and are never copied into manifests.

## Registry vs inline

- `capability add <manifest.json|yaml>` → persistent registry in `.jevrouter/capabilities/`; `route`/`plan` without candidate flags read the registry.
- `--candidates` / `--candidates-file` / stdin → per-call candidates; win over the registry when supplied.
- Candidate IDs must be unique per call; duplicates are a hard error.
- Agent-supplied `{name, description}` shorthand is marked `unverified`. It remains useful for an advisory route, while a strict local policy can set `require_verified_candidates: true` to force a real discovery/verification record.

## Tips

- Write descriptions as routing signal: what the capability does, what it returns, what it costs. Jev reads `name: description [type=…; metadata hints]` per candidate.
- Keep risky capabilities in the candidate set — the policy layer ([recipe 07](07-policy-and-confirmation.md)) filters or flags them instead of you pre-filtering and losing the audit trail.
