# Agent Sync Layer (Claude Code ↔ pi ↔ OpenCode)

Local sync layer letting Claude Code, pi, and OpenCode work the same
codebase as peers, on one Mac. Claude Code is interactive; pi and OpenCode
run headless behind one bridge process. Any pair can message each other;
Claude can delegate blocking work to either worker. See
`PRD-agent-sync-layer.md` for the original design doc.

## Prerequisites

- Node.js ≥ 18, zero npm dependencies (`npm test` just works)
- [Claude Code](https://code.claude.com) CLI, [pi](https://pi.dev) CLI
  (any, both, or either worker — the bridge degrades gracefully),
  [OpenCode](https://opencode.ai) v1.18+ (for the `oc_*` tools)
- Tested against: pi 0.85.0, OpenCode 1.18.30, Node 24 (CI: Node 20/22/24 × ubuntu/macos)

```
  human
    │
    ▼
┌─────────────────┐   MCP stdio      ┌──────────────┐   pi RPC (JSONL)   ┌────────┐
│  Claude Code    │◄────────────────►│  pi-bridge   │◄──────────────────►│   pi   │
│  (interactive)  │                  │  (node proc) │                    │ (rpc)  │
└────────┬────────┘                  └──────────────┘                    └───┬────┘
         │                                                                   │
         │ Stop hook reads                                                   │ message_claude
         ▼                                                                   ▼
      ┌──────────────────────── message bus (JSONL file) ────────────────────────┐
```

Direction rule (load bearing): **Claude→pi is sync** (`pi_ask` blocks until
pi settles). **Pi→Claude is always async** (bus + Stop hook / `pi_inbox`).
A sync callback from pi into Claude during `pi_ask` would deadlock — rejected
in review by design.

## Layout

| Path | What |
|---|---|
| `bridge/env.mjs` | Shared env contract (`AGENT_BUS`, `PI_CWD`, `PI_BIN`, …) |
| `bridge/bus.mjs` | File bus: append / read / drain (`to-claude.jsonl`) |
| `bridge/pi-session.mjs` | pi transport: spawns `pi --mode rpc`, LF framing, id correlation, settle tracking, dialog auto-cancel, telemetry |
| `bridge/mcp-server.mjs` | MCP stdio server (18 tools): `pi_ask[_async]`, `pi_steer`, `pi_abort`, `pi_new_session`, `pi_state`, `oc_ask[_async]`, `oc_state`, `oc_abort`, `oc_new_session`, `agent_send`, `agent_sessions`, `agent_tickets`, `pi_inbox` |
| `bridge/format.mjs` | Side-effect-free result formatting + `RESULT_CAP` spillover (importable in tests) |
| `opencode-plugin/claude-bridge.ts` | OpenCode plugin (VERIFIED live): `message_claude` tool, presence heartbeat, `to-pi` watcher + SDK injection |
| `bridge/oc-session.mjs` | OpenCode transport: owns `opencode serve` (port scan, per-spawn password), promptAsync + SSE `session.idle` settle, abort/state/new-session. No `oc_steer` v1 (mid-run prompt semantics unverified) |
| `test/stub-oc-server.mjs` | Fixture HTTP+SSED server (`STUB_OC_MODE=happy\|hang\|tooluse`) |
| `pi-extensions/claude-bridge.ts` | pi extension: `message_claude` tool + `/tell-claude` |
| `hooks/pi-inbox.mjs` | Claude Code Stop hook delivering bus messages |
| `test/stub-pi.mjs` | Fixture stub speaking the RPC protocol (`STUB_MODE=happy\|exit-mid\|dialog\|compaction\|timeout-hang`) |
| `test/*.test.mjs` | `node:test` suites (bus, hook matrix, transport, MCP) |
| `scripts/install.sh` | 10-minute provisioning (extension + MCP + hook) |
| `scripts/setup-worktree.sh` | Worktree mode setup (default, safer) |

## Quick start

```bash
# 1. Provision (copies extension, registers MCP, prints hook JSON)
./scripts/install.sh

# 2. Same-directory pairing (simplest)
export AGENT_BUS=$PWD/.agentbus PI_CWD=$PWD
claude mcp add pi-bridge -s user -- node $PWD/bridge/mcp-server.mjs
# add to ~/.claude/settings.json:
# { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
#     "command": "node /abs/path/hooks/pi-inbox.mjs" }] }] } }

# 3. In Claude: /mcp, then pi_ask "…" with absolute paths
```

Worktree mode (no file stomping):

```bash
./scripts/setup-worktree.sh /path/to/project
# follow the printed exports (AGENT_BUS shared outside both trees)
```

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `AGENT_BUS` | Bus dir. Must match on both sides | `$PI_CWD/.agentbus` |
| `PI_CWD` | pi working dir | `$PWD` |
| `PI_BIN` | pi executable | `pi` |
| `PI_MODEL` | `--model` passthrough | pi default |
| `PI_NAME` | `--name` passthrough | `paired-with-claude-code` |
| `PI_SESSION_DIR` | `--session-dir` passthrough | pi default |
| `PI_ASK_TIMEOUT_MS` | One `pi_ask` wall budget | `900000` |
| `PI_MAX_CONSECUTIVE_BLOCKS` | Stop-hook loop cap | `3` |
| `PI_EXTRA_ARGS` | Prepended to pi argv (tests/wrappers) | — |

## Decisions locked in this implementation

- **Timeout**: `pi_ask` timeout sends `abort()` then returns `isError`; bridge stays usable.
- **Result shape**: `{text, toolsUsed, notices, dialogsCancelled, extensionErrors, compactions, retries, tokens, cost, contextUsage, sessionFile}` rendered as text + summary for Claude.
- **Session lifecycle**: `pi_ask` follow-ups continue the same session (history kept). `pi_new_session` aborts any run, drops history, starts clean for the next task. Verified live against real pi (session file rotates, `pi_state` follows). Same shape for OpenCode: `oc_ask` / `oc_new_session`, verified live (`OCASK-OK`, $0.0016 tracked).
- **OpenCode transport notes**: root API prefix (`/api` is half-broken server-side: health 404s, status errors); settle = SSE `session.idle` subscribed BEFORE prompting (fast runs otherwise win the race — same class as pi's `agent_start` race); port scan 4597+ (explicit port required, `--port 0` ignored); per-spawn server password. Env: `OC_BIN`, `OC_CWD`, `OC_PORT`, `OC_MODEL` (provider/model), `OC_ASK_TIMEOUT_MS`, `OC_BASE_URL` (tests/attach).

## Speed pass P0–P4 (2026-09-11)

- **P0 bus**: `drainUnread` compacts consumed records past `BUS_KEEP_CONSUMED` (default 200 kept) and early-exits without rewrite when nothing is unread; `claimToPi` same watermark, never drops undelivered. Measured before: 23ms/3.5MB at 20k records, growing forever.
- **P1 async tickets**: `pi_ask_async` / `oc_ask_async` return a ticket id now; results post to the bus (`kind=result`, `ticket=<id>`) for inbox/hook delivery; `agent_tickets` lists running/done/failed. In-memory (bridge restart loses running tickets — documented in tool text).
- **P2 cold start**: bridge-owned pi spawns with `PI_OFFLINE=1` unless explicitly set (skips update checks).
- **P3 warm pool, NOT in-process**: investigated `AgentSession`/`createAgentSession` — real but = reimplementing pi's `main()` (services, model runtime, extension runner) with version coupling; `RpcClient` is same-subprocess, zero gain. So: background warm-up after MCP initialize (pi pre-spawn + oc serve pre-start, no prompt/tokens, failures fall back to lazy). Verified live; `BRIDGE_WARMUP=0` opts out (tests set it).
- **P4 context tax**: all 12→18 tool descriptions cut to one-liners (~2.2k chars before); delegated results capped at `RESULT_CAP` (default 8000 chars) with overflow spilled to `$AGENT_BUS/results/` + pointer. Formatting lives in side-effect-free `bridge/format.mjs` (importing `mcp-server.mjs` in-process hangs test runners on its stdin listener — learned the hard way).
- **Settle tracking**: anchored on a `settledCount` generation (prompt ack can arrive before `agent_start`; `isStreaming` alone races).
- **Hook counter**: `$AGENT_BUS/.hook-counter.json`; mismatch one-time warnings in `.hook-warned.json`.
- **Bus limits**: single-`appendFileSync` lines <4KB are atomic-enough on macOS; larger lines are best-effort. Drain is temp-file + rename; two racing drainers are possible but rare (graduate to `.lock` if it bites).
- **Tests**: `node:test`, zero-dep. Stub pi first; never burn tokens in tests.

## Manual verification (needs real CLIs)

- [ ] Worktree mode: delegate a real task via `pi_ask`, merge result
- [ ] Shared tree: both agents, different folders
- [ ] pi sends `warning` mid-task → Claude gets it via Stop hook
- [ ] Separate dirs + shared `AGENT_BUS` → messages flow
- [ ] Mismatched `AGENT_BUS` → one-time warning fires

## Prototype: Claude → running pi (NEW)

Reverse direction, verified live against real pi 0.85.0 (not just stub):

- `pi_sessions` lists paired pi workers via `$AGENT_BUS/presence/*.json` heartbeats (written on `session_start`, refreshed on `agent_settled`, removed on `session_shutdown`; `alive` = pid check, same machine).
- `pi_send {message, to}` appends to `$AGENT_BUS/to-pi.jsonl`. `to` is a session id, session file, cwd, or `"*"` broadcast (prefer addressing one).
- The extension watches the bus dir (file watcher + 2s poll fallback; dir-watch because claim rewrites replace the file) and injects via `pi.sendMessage({customType: "claude-message"}, {triggerTurn: true})` — the sanctioned `file-trigger.ts` pattern.
- Claim-before-inject (`deliveredTo`, per-instance memory set) gives exactly-once per session; broadcast reaches every paired pi once.
- Live proof: presence appeared, broadcast claimed by session file id, injected text present in `get_messages`. No stub involved.

Trust note: any local bus writer can inject prompts into a paired pi. Treat `AGENT_BUS` like project files — shared dir, trusted users only. The installed `~/.pi/agent/extensions/claude-bridge.ts` is the PRE-mesh copy (no `to` route); reinstall from this repo to enable worker-to-worker messaging.

## Mesh status: pi ✓, OpenCode ✓ (2026-09-11, live)

- Bus + presence carry `agent: "pi" | "opencode"`; `agent_send`/`agent_sessions` route by session id/file/cwd across both. 28/28 tests green.
- Pi extension gained `message_claude {to}` (Claude default; worker address otherwise). Repo copy only — reinstall to go live.
- OpenCode plugin VERIFIED live against 1.18.30 TUI: heartbeat presence, `message_claude` tool (PING from opencode arrived in `to-claude.jsonl`), watcher injection (PONG from Claude appeared in-session, claimed by all three live sessions incl. lazy-seeded pre-existing ones). Installed globally at `~/.config/opencode/plugins/claude-bridge.ts`.
- Incident 2026-09-11: full-featured v1 blanked the OpenCode UI on every project (no log evidence). Bisect cleared heartbeat-only ✅ then +tool ✅ then +watcher ✅ — remaining suspect for the original breakage is the init-time `session.list()` await, which the shipped version does lazily instead. Full v1 kept in `opencode-plugin/claude-bridge.full.ts` for reference.
- Lesson: `to: "*"` broadcasts wake EVERY paired session (each burns a turn). Address singly for real work.

## Security

- `AGENT_BUS` is a trusted path: any local writer can inject prompts into paired agents. Same bar as project files.
- Bridge-owned servers bind `127.0.0.1` with per-spawn passwords. MCP is stdio, no auth by design (local only).
- See CONTRIBUTING.md; do not weaken silently.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Stub-first, tests with every change (`npm test`).

## License

MIT — see [LICENSE](LICENSE).

## Deferred (per PRD §10)

`pi_ask_async` tickets, shared `PROTOCOL.md`, multi-pi, socket broker, ACP.
