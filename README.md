# Agent Switchboard

Your coding agents as peers on one machine. Claude Code talks to a **pi**
worker and an **OpenCode** worker: it delegates whole tasks, nudges running
sessions, and hears back — every pair messageable, nothing copy-pasted
between terminals.

## Setup — pick one

**A. Just try it** (taste, may break later when npm prunes its cache):

```bash
npx -y -p github:raymond-UI/agent-switchboard switchboard-install
```

**B. Use it** (durable, still no clone) — **this is the normal path**:

```bash
npm install -g github:raymond-UI/agent-switchboard
switchboard-install
```

**C. Hack on it:** `git clone https://github.com/raymond-UI/agent-switchboard`, then `node scripts/install.mjs`.

All three install the worker plugins, register the bridge, and print the
one Stop-hook snippet for your Claude settings. You need: Node.js ≥ 18,
the [Claude Code](https://code.claude.com) CLI, and whichever workers you
want ([pi](https://pi.dev), [OpenCode](https://opencode.ai) v1.18+).
Windows works identically (forward slashes in settings paths).

It worked if: `agent_sessions` lists your workers, and `pi_inbox` answers
without errors. Then hand a worker something tiny with absolute paths.

## The loop (30 seconds)

| You want to… | You use | What happens |
|---|---|---|
| Hand a worker a task and wait | `pi_ask` / `oc_ask` | Blocks until it settles; returns text + tools used + cost. `timeoutMs` overrides the 15-min default (max 8h). On timeout the worker **keeps going** (detached, no abort) — re-run the ask to wait again, `*_abort` to kill. |
| Hand over N tasks at once | `pi_ask_async` / `oc_ask_async` | Ticket id now. Result lands in YOUR pi_inbox AND fires the Stop hook for the Claude session that dispatched it (siblings stay pull-only). Default ceiling 4h (`PI_ASYNC_TIMEOUT_MS` / `OC_ASYNC_TIMEOUT_MS`), overridable per call. |
| Nudge a running session | `agent_send` (address from `agent_sessions`) | Lands in its conversation in ~2s |
| Hear back | `pi_inbox` (or the Stop hook, while working) | Results, questions, warnings |
| Fresh context for a new task | `pi_new_session` / `oc_new_session` | Old history dropped, unrecoverable |
| What's it costing | `pi_state` / `oc_state` | Model, tokens, context pressure |

Instructions to workers must be self-contained with **absolute paths** —
they can't see your Claude conversation.

## Upgrading

Re-run whatever installed it — it reinstalls plugins, re-registers MCP, and
reprints the hook snippet. Idempotent; running sessions keep their loaded
copies, new sessions pick everything up:

```bash
switchboard-install          # paths B and C (C: `node scripts/install.mjs`)
npx -y -p github:raymond-UI/agent-switchboard switchboard-install   # path A
```

No migration steps between versions so far; if one ever lands, it will be
announced at the top of this section.

Tested: pi 0.85.0, OpenCode 1.18.30, Node 20/22/24 (CI × ubuntu/macos/windows).

## Across machines (worker box)

Run pi and OpenCode on a second machine so the coordinator (your laptop
running Claude) stays light. Install switchboard on both (path B above),
then:

```bash
switchboard-pair                 # 1. on the WORKER: prints a code, starts serving
switchboard-connect sb1.…        # 2. on the COORDINATOR: paste that code
```

Restart Claude on the coordinator and you're done. It uses the same tools
and the same hook snippet, and async results still reach the session that
started them. Claude is told which machine the workers are on. **Paths you give
workers refer to the worker machine** (`switchboard-connect --status` shows
their working dirs).

Notes: the code contains the access token (`switchboard-pair --rotate`
revokes it). Both machines need to be on the same LAN, or use Tailscale
from anywhere. Undo with `switchboard-connect --local`.

**Always-on worker:** `switchboard-pair --service` instead of step 1. It
installs a background service (launchd on macOS, systemd user unit on
Linux) that starts at login and restarts if it crashes, and prints the same code.
Run it from the project dir (or set `PI_CWD`/`OC_CWD`). It captures your PATH
and model settings but not provider API keys. Re-run after changing them.
Remove: `switchboard-pair --remove-service`. Windows: keep `switchboard-pair`
open in a terminal.
Full diagram: `docs/network-vision.html`.

Two agents, one checkout: give each its own worktree
(`./scripts/setup-worktree.sh /path/to/project`) or split folders by
agreement. Two writers in one tree with no ownership split *will* stomp
each other — the tooling detects, it doesn't merge.

## Rules that bite (read once)

1. **Replies need addresses.** `agent_send` to a live session id is precise;
   `*` broadcasts wake *every* paired session (each burns a turn).
2. **New sessions don't inherit backlog.** Workers only receive messages sent
   after they were born (exact id/file addressing bypasses). Re-brief instead
   of relying on history.
3. **Async results are pull-only... with one new exception.** A `pi_ask_async` /
   `oc_ask_async` ticket result lands in `pi_inbox` for everyone AND fires the
   Stop hook for the Claude session that dispatched it (multi-agent safe: each
   Claude writes its own dispatcher sidecar, the bridge stamps the ticket at
   dispatch time, the hook routes by exact match). Tickets that were never
   stamped (no PreToolUse hook, or different tool) stay pull-only.
4. **Idle Claude sessions can't be pushed to.** The Stop hook fires on
   transitions; a parked session needs one nudge (`check pi_inbox`) or a
   desktop notification — there is no timer hook. Nothing is ever lost: the
   bus is durable, pull anytime.
4. **Async results are pull-only by default.** Ticket results skip the Stop
   hook so they can't spray into a sibling session — collect by ticket id in
   `pi_inbox`. (If the `PreToolUse` dispatcher hook is installed, async results
   ALSO fire the Stop hook for the Claude session that dispatched them.)
5. **The bus is trusted.** Anyone who can write to `AGENT_BUS` can whisper to
   your agents. Same bar as project files. Bus dirs auto-ignore themselves
   in enclosing git repos.

## Who can orchestrate whom

| Orchestrator | Drives pi | Drives OpenCode | Drives Claude | How |
|---|---|---|---|
| Claude Code | `pi_ask` | `oc_ask` | — (self) | MCP bridge, always on |
| OpenCode | MCP bridge | MCP bridge | `delegate_claude` tool | Add bridge to `opencode.json`; flag-gated tool |
| pi | bus only (`message_claude {to}`) | `delegate_oc` / bus | `delegate_claude` tool | Flag-gated tools |

Worker→worker also works over the bus (`message_claude {to}`).
Multi-orchestration is **flag-gated** (`SWITCHBOARD_MULTI_ORCH=1`) and
**depth-capped** (`SWITCHBOARD_DEPTH`/`SWITCHBOARD_MAX_DEPTH`, default cap 2):
delegation depth travels in env across every spawn, and any delegate tool at
the cap refuses with a clear error instead of looping A→B→A forever.
Live-verified: pi → `delegate_claude` round-trip (`DELTEST`).

## Reference

**Tools (16):** `pi_ask[_async]`, `pi_steer`, `pi_abort`, `pi_new_session`,
`pi_state`, `oc_ask[_async]`, `oc_steer`, `oc_state`, `oc_abort`,
`oc_new_session`, `agent_send`, `agent_sessions`, `agent_tickets`, `pi_inbox`.
One-line descriptions in-tool; details here.

**Env (essentials):** `AGENT_BUS` (must match on all sides when dirs differ),
`PI_CWD` / `OC_CWD`, `PI_MODEL` / `OC_MODEL` (`provider/model`), `PI_ASK_TIMEOUT_MS`
(15 min), `RESULT_CAP` (8k chars, overflow spills to `$AGENT_BUS/results/`).
Full table in code: `bridge/env.mjs`, `bridge/oc-session.mjs`.

**Layout:** `bridge/` (env, bus, format, MCP server, `pi-session`,
`oc-session`, `launcher`), `hooks/pi-inbox.mjs` (Stop hook),
`pi-extensions/`, `opencode-plugin/`, `test/` (stubs + `node:test` suites),
`scripts/` (installer, pair/connect, worktree setup). Original design doc:
`PRD-agent-switchboard.md`.

**Security:** localhost only (bridge servers bind `127.0.0.1` with per-spawn
passwords; MCP is stdio, no auth by design). The one exception is
`switchboard-pair`, which you run on purpose: it binds the network and
requires the token. It refuses to bind the network without one. Don't weaken silently — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## For contributors

`npm test` — zero deps, stub-first (fixtures for both harnesses' protocols),
live runs for final verification only. Hard rules: claim-before-emit on every
take-one primitive; worker→Claude is always async (a sync callback into a
blocked ask deadlocks both processes); never import the MCP server into the
test runner (stdin listener hangs it). Design history (settle races, ticket
spray incident, stale-backlog gate, UI-blanking bisect, poisoned-preload
immunity) lives in git log + code comments. MIT — see [LICENSE](LICENSE).
