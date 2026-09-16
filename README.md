# Agent Switchboard

Your coding agents as peers on one machine. Claude Code talks to a **pi**
worker and an **OpenCode** worker: it delegates whole tasks, nudges running
sessions, and hears back — every pair messageable, nothing copy-pasted
between terminals.

## Try it without cloning

```bash
npx -y -p github:raymond-UI/agent-switchboard switchboard-install
```

That installs the worker plugins, registers the bridge, and prints the one
Stop-hook snippet to add to your Claude settings. No checkout needed.

## The loop (30 seconds)

| You want to… | You use | What happens |
|---|---|---|
| Hand a worker a task and wait | `pi_ask` / `oc_ask` | Blocks until it settles; returns text + tools used + cost |
| Hand over N tasks at once | `pi_ask_async` / `oc_ask_async` | Ticket id now; each result lands in `pi_inbox` |
| Nudge a running session | `agent_send` (address from `agent_sessions`) | Lands in its conversation in ~2s |
| Hear back | `pi_inbox` (or the Stop hook, while working) | Results, questions, warnings |
| Fresh context for a new task | `pi_new_session` / `oc_new_session` | Old history dropped, unrecoverable |
| What's it costing | `pi_state` / `oc_state` | Model, tokens, context pressure |

Instructions to workers must be self-contained with **absolute paths** —
they can't see your Claude conversation.

## Install properly

```bash
git clone https://github.com/raymond-UI/agent-switchboard
cd agent-switchboard
node scripts/install.mjs
```

Prerequisites: Node.js ≥ 18, the [Claude Code](https://code.claude.com) CLI,
and whichever workers you want ([pi](https://pi.dev),
[OpenCode](https://opencode.ai) v1.18+). Zero npm dependencies.
Windows works the same way (forward slashes in settings paths; worktree
script wants git-bash). Tested: pi 0.85.0, OpenCode 1.18.30, Node 20/22/24.

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
3. **Idle Claude sessions can't be pushed to.** The Stop hook fires on
   transitions; a parked session needs one nudge (`check pi_inbox`) or a
   desktop notification — there is no timer hook. Nothing is ever lost: the
   bus is durable, pull anytime.
4. **Async results are pull-only.** Ticket results skip the Stop hook so they
   can't spray into a sibling session — collect by ticket id in `pi_inbox`.
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
`scripts/` (installer, worktree setup). Original design doc:
`PRD-agent-switchboard.md`.

**Security:** localhost only (bridge servers bind `127.0.0.1` with per-spawn
passwords; MCP is stdio, no auth by design). Don't weaken silently — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## For contributors

`npm test` — zero deps, stub-first (fixtures for both harnesses' protocols),
live runs for final verification only. Hard rules: claim-before-emit on every
take-one primitive; worker→Claude is always async (a sync callback into a
blocked ask deadlocks both processes); never import the MCP server into the
test runner (stdin listener hangs it). Design history (settle races, ticket
spray incident, stale-backlog gate, UI-blanking bisect, poisoned-preload
immunity) lives in git log + code comments. MIT — see [LICENSE](LICENSE).
