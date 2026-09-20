# 09 · Local dashboard

The dashboard is a local, read-only view over routing receipts. It does not call Jev, send data anywhere, or require an API key.

From a project that contains `.jevrouter/decisions/` or `.jevrouter/plans/`:

```bash
npx --yes github:BillionsBobby/JevRouter dashboard
```

Open `http://127.0.0.1:8788`.

It reads:

- `.jevrouter/decisions/*.json` for status, provider, live/demo source, selected capabilities and latency;
- `.jevrouter/plans/*.json` for plan modes, step counts and step statuses.

The page refreshes every five seconds. Execution outcome is **not collected** in the MVP because JevRouter does not execute host capabilities. A selected route is therefore never counted as a successful task unless a future host feedback adapter records that result.

For scripts, the same data is available at:

```bash
curl -s http://127.0.0.1:8788/api/stats
```
