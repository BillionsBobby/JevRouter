# 09 · Local dashboard

The dashboard is a local, read-only view over routing receipts. It does not call Jev, send data anywhere, or require an API key.

From a project that contains `.jevrouter/decisions/` or `.jevrouter/plans/`:

```bash
npx --yes github:BillionsBobby/JevRouter dashboard
```

Open `http://127.0.0.1:8788`.

It reads:

- `.jevrouter/decisions/*.json` for status, provider, live/demo source, selected capabilities and latency;
- `.jevrouter/plans/*.json` for plan modes, step counts and step statuses;
- `.jevrouter/events/events.jsonl` for execution feedback lifecycle events.

The page refreshes every five seconds. Execution outcome is collected when execution feedback events are recorded via the CLI (`jevrouter feedback ...`) or SDK (`recordExecutionEvent(...)`). A selected route is never counted as a completed task unless valid execution feedback records that completion.

For scripts, the same data is available at:

```bash
curl -s http://127.0.0.1:8788/api/stats
```
