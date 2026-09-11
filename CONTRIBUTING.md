# Contributing

## Tests first

Every behavior change ships with a test. The suite is zero-dependency
(`node:test`, no tokens, no network):

```bash
npm test
```

Rules learned the hard way in this repo:

- **Stub-first.** Both harnesses have fixtures (`test/stub-pi.mjs` for the
  pi RPC protocol, `test/stub-oc-server.mjs` for the OpenCode HTTP API).
  Prove protocol logic against the stub. Live runs are for final
  verification only (cents, not dollars).
- **Never import `bridge/mcp-server.mjs` into the test runner.** It attaches
  a stdin listener that hangs `node --test` at exit. Side-effect-free logic
  belongs in `bridge/bus.mjs`, `bridge/format.mjs`, etc.
- **Claim before emit.** Any take-one-message primitive marks it consumed
  *before* acting (crash-after-emit must not replay forever). See
  `drainUnread` / `claimToPi`.
- **No sync callbacks into a blocked caller.** Claude→worker is blocking,
  worker→Claude is always async (bus + poll). Any design that lets a worker
  block back into Claude during an ask deadlocks both processes and must be
  rejected in review.

## What goes where

- `bridge/` — harness-agnostic plumbing (`env`, `bus`, `format`) plus one
  transport per worker (`pi-session`, `oc-session`) and the MCP surface.
- `pi-extensions/`, `opencode-plugin/`, `hooks/` — code that runs *inside*
  the harnesses. Keep it dependency-free (node builtins only) and defensive:
  a throwing extension/plugin breaks someone else's UI.
- New worker support = new transport + worker-side plugin + stub + tests.
  No changes to the bus format without a version note in the README.

## Security model (do not weaken silently)

- `AGENT_BUS` is a trusted path: anyone who can write to it can inject
  prompts into paired agents. Same bar as project files.
- Bridge-owned servers bind `127.0.0.1` with a per-spawn password. Never
  expose them off-host without adding real auth.
- MCP runs over stdio with no auth by design (local client, local server).
