# PRD: Agent Sync Layer (Claude Code ↔ pi)

Status: ready to build
Owner: Raymond Asogwa / Mzed Studio
Target: a single developer or coding agent, one working week

---

## 1. What we are building

A local sync layer that lets one Claude Code CLI session and one pi CLI session work on the same codebase as peers, on one Mac.

Claude Code is the session the human types into. Pi runs headless behind a bridge, with its own model, its own context, and its own working directory. Claude can hand pi work and get results back. Pi can push messages to Claude without being asked.

Nothing here is a wrapper around the models. Both harnesses keep their own agent loops, sessions, and tools. We are only building the wire between them.

## 2. Problem

Running two agent CLIs side by side today means copy-pasting between terminals. There is no shared state, no way for one to delegate to the other, and no way to know when they are about to edit the same file.

Claude Code speaks MCP and has hooks. Pi speaks a JSONL RPC protocol and has a TypeScript extension API. Neither speaks the other. The gap is small and worth closing once.

## 3. Scope

In scope:

- A bridge process that owns one long-lived `pi --mode rpc` session and exposes it to Claude Code as MCP tools
- A pi extension that lets pi push messages back to Claude
- A Claude Code Stop hook that delivers those messages into the live session
- A file-based message bus shared by both, working across separate directories
- Setup scripts and docs good enough that a second machine can be provisioned in ten minutes

Out of scope for v1:

- More than one pi session per Claude session
- Remote or networked agents. Everything is localhost, same user, same machine
- A GUI, a TUI, or any visualisation
- Claude Code driving anything other than pi
- Automatic conflict resolution when both agents edit the same file. We detect and warn, we do not merge
- Replacing either harness's own permission or trust model

## 4. Architecture

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

Claude Code spawns `pi-bridge` as an MCP stdio server. `pi-bridge` spawns pi. The bus is a plain append-only JSONL file both sides can reach.

Direction rules, which are load bearing:

- **Claude to pi** is synchronous. A `pi_ask` tool call blocks until pi settles, and the result is the tool result.
- **Pi to Claude** is always asynchronous. While Claude is blocked inside `pi_ask` it cannot answer anything, so a synchronous callback would deadlock both processes. Pi writes to the bus; Claude reads when it is free.

This is not a preference. Any design that lets pi make a blocking call back into Claude during a `pi_ask` is wrong and must be rejected in review.

## 5. Environment contract

All components read the same variables. No component may hardcode a path.

| Variable | Meaning | Default |
|---|---|---|
| `AGENT_BUS` | Directory holding the bus files. Must be identical for every component in a pairing. | `$PI_CWD/.agentbus` |
| `PI_CWD` | Working directory pi operates in. May differ from Claude Code's. | `$PWD` at launch |
| `PI_BIN` | pi executable | `pi` |
| `PI_MODEL` | Model passed to `pi --model` | pi's configured default |
| `PI_NAME` | Session display name passed to `pi --name` | `paired-with-claude-code` |
| `PI_SESSION_DIR` | Passed to `pi --session-dir` | pi's default |
| `PI_ASK_TIMEOUT_MS` | Max wall time for one `pi_ask` | `900000` (15 min) |
| `PI_MAX_CONSECUTIVE_BLOCKS` | Stop-hook loop cap | `3` |

When the two agents run in different directories, `AGENT_BUS` must be set explicitly on both sides to a path outside either tree. If it is not, they write to two different mailboxes and silently never see each other. This failure is invisible, so the bridge must detect and report it (see 7.5).

## 6. Components

### 6.1 pi transport (`bridge/pi-session.mjs`)

Owns the pi child process and the RPC conversation.

Requirements:

- Spawn `pi --mode rpc` with args built from the environment contract. Lazy start: do not spawn until the first tool call needs pi.
- Frame records on LF only. Do not use `readline`. It also splits on U+2028 and U+2029, which are legal inside JSON strings, so it corrupts any message containing them. Strip one trailing `\r` if present.
- Correlate commands to responses by `id`. Every command gets a UUID; every pending command has a timeout and rejects cleanly on process exit.
- Treat `agent_settled` as completion, never `agent_end`. `agent_end` can be followed by automatic retry, compaction, and queued continuations.
- Collect per-run telemetry: tool names invoked, compaction events, auto-retry events, extension errors. Return them with the result so Claude knows what pi actually did.
- Handle `extension_ui_request`. Nobody is at pi's terminal. Dialog methods (`select`, `confirm`, `input`, `editor`) get an immediate `{"cancelled": true}` response and a recorded notice. Fire-and-forget methods (`notify` and friends) are recorded only. A hung dialog is a hung session, so this is not optional.
- When pi is already streaming, a new prompt must carry `streamingBehavior`. Use `followUp` for `pi_ask`. Without it, pi rejects the command.
- Expose: `ask()`, `steer()`, `abort()`, `state()`, `entries(since)`, `stop()`.

Acceptance:

- A prompt containing a literal U+2028 round-trips intact
- Killing pi mid-`ask` rejects the pending promise with a clear message instead of hanging
- A run that triggers compaction still resolves, and the compaction is surfaced in notices
- `ask()` called while pi is mid-run queues rather than erroring

### 6.2 MCP server (`bridge/mcp-server.mjs`)

The surface Claude Code sees.

Requirements:

- Speak MCP JSON-RPC over stdio, newline delimited. Implement `initialize`, `ping`, `tools/list`, `tools/call`. Ignore notifications (no `id`, no response).
- **stdout is the protocol channel.** Every log line goes to stderr. A stray `console.log` breaks the session with no useful error.
- Echo the client's `protocolVersion` back on initialize when present, rather than pinning one.
- Handle `EPIPE` on stdout by exiting 0. Clients close pipes.
- Tool errors return `{content: [...], isError: true}`, not a JSON-RPC error. Claude should see the failure and reason about it, not get a protocol fault.
- Clean shutdown on SIGINT and SIGTERM, terminating pi.

Tools to expose:

| Tool | Behaviour |
|---|---|
| `pi_ask(message)` | Prompt pi, wait for settle, return final text plus a tool-call summary and any notices. Blocking. |
| `pi_steer(message)` | Queue a mid-run correction. Returns immediately. |
| `pi_abort()` | Stop pi's current run. |
| `pi_state()` | Model, streaming flag, message count, token usage, context window pressure. |
| `pi_inbox()` | Return and mark read any unread bus messages from pi. |

Tool descriptions matter as much as the code. `pi_ask` must tell Claude that pi cannot see the conversation, that instructions have to be self-contained with absolute file paths, and that calls can take minutes. Bad delegation reads as a bad model.

Acceptance:

- `initialize` → `tools/list` → `tools/call` round-trips with a stock MCP client
- Nothing is ever written to stdout except JSON-RPC frames
- `pi_ask` against a missing `pi` binary returns a readable `isError` result, not a crash
- The server survives `pi_ask` timeouts and stays usable afterwards

### 6.3 Message bus

One append-only JSONL file: `$AGENT_BUS/to-claude.jsonl`.

Record shape:

```json
{
  "ts": "2026-09-11T10:00:00.000Z",
  "from": "pi" | "pi-user",
  "kind": "result" | "question" | "warning" | "fyi",
  "text": "...",
  "session": "/path/to/pi-session.jsonl",
  "paths": ["/abs/path/touched.ts"],
  "read": false
}
```

Requirements:

- Appends must be atomic enough for concurrent writers. Single `appendFileSync` of one line under 4KB is acceptable on macOS; anything larger needs a lock file. Document the limit.
- Readers mark records `read: true` **before** emitting them. A crash after emit must not replay the same message forever.
- Malformed lines are skipped, not fatal.
- The file is rewritten in place on drain. Two drainers racing is possible but rare; if it becomes a problem, move to a `.lock` file rather than a database.
- `paths` is advisory file ownership. v1 only surfaces it to Claude in the message text. No enforcement.

### 6.4 pi extension (`pi-extensions/claude-bridge.ts`)

Installed to `~/.pi/agent/extensions/claude-bridge.ts`.

Requirements:

- Register a `message_claude` tool: `{text, kind?, paths?}`. Appends to the bus. Returns immediately with a result that explicitly tells pi delivery is async and it must not wait for a reply in the same turn.
- Register a `/tell-claude` command for manual use when watching pi's TUI.
- Create `$AGENT_BUS` on `session_start`, not in the extension factory. Pi's docs are explicit that factories may run in invocations that never start a session, so background resources belong in `session_start` with cleanup in `session_shutdown`.
- Set a footer status so it is obvious at a glance that pi is paired.
- Use `promptSnippet` and `promptGuidelines` so the tool appears in pi's system prompt. Guidelines must name the tool explicitly ("Use message_claude when...") because bullets are appended flat with no tool prefix.

Acceptance:

- Pi, unprompted, uses `message_claude` to report a finding during a long task
- Removing the extension leaves pi working normally

### 6.5 Stop hook (`hooks/pi-inbox.mjs`)

The only way to push into a live Claude Code session.

Requirements:

- Node, not bash plus jq. Claude Code already requires Node; jq is not on every Mac.
- Read the hook payload from stdin. If `stop_hook_active` is true, exit 0 immediately. We are already inside a blocked stop.
- If there are unread bus messages and the consecutive-block counter is under `PI_MAX_CONSECUTIVE_BLOCKS`, emit `{"decision": "block", "reason": "<messages>"}` on stdout and increment the counter.
- Reset the counter to 0 whenever there is nothing to deliver.
- Exit 0 silently in every other case. A Stop hook that errors or blocks unconditionally makes Claude Code unusable.
- Resolve `AGENT_BUS` the same way every other component does, falling back to `CLAUDE_PROJECT_DIR`.

Acceptance:

- Unread messages present → blocks once with the messages in `reason`
- Same invocation repeated → exits 0, no duplicate delivery
- `stop_hook_active: true` → exits 0 regardless of inbox contents
- Four messages arriving back to back never produce more than three consecutive blocks

## 7. Failure modes that must be handled

**7.1 Deadlock.** Covered by the async rule in section 4. Enforce it in code review: pi has no synchronous path back into Claude.

**7.2 Stop-hook loop.** Two independent rails: `stop_hook_active` and the counter. Both required; either alone is insufficient.

**7.3 File stomping.** Both agents hold write and bash on a shared tree and neither sees the other's edits. v1 ships two documented modes:

- *Worktree mode* (default, safer): `git worktree add ../<project>-pi -b pi/work`, `PI_CWD` points there, `AGENT_BUS` outside both. Pi commits on its branch. No stomping possible.
- *Shared tree mode*: same `PI_CWD`, ownership split by folder, stated in the prompt. Better for genuine pairing, riskier.

**7.4 Relative paths across directories.** In worktree mode `src/auth.ts` names a different file for each agent. The `pi_ask` tool description must demand absolute paths. Additionally, the bridge should warn on stderr when a `pi_ask` message contains a relative-looking path and `PI_CWD` differs from the bridge's launch directory.

**7.5 Split bus.** If `AGENT_BUS` differs between the bridge and the hook, messages vanish. On startup the bridge writes `$AGENT_BUS/.bus-info.json` containing the resolved path, pi cwd, and pid. The hook compares its resolved path and, on mismatch, emits a one-time warning through the block reason. Silent failure is the worst outcome here.

**7.6 Context drift.** Pi cannot see the Claude conversation. Nothing to build, but the tool descriptions carry the weight.

**7.7 Cost.** Every `pi_ask` is a full agent run on a second provider. `pi_state` must report token totals and context percent so the human can see the meter.

## 8. Test plan

Unit:

- LF framing against payloads containing `\r\n`, U+2028, U+2029, and a 1MB single line
- Response correlation with out-of-order and duplicate ids
- Bus drain idempotency
- Stop-hook decision matrix (all four cases in 6.5)

Integration, with a stub pi that speaks the RPC protocol from a fixture script:

- Full `pi_ask` happy path
- pi exits mid-run
- pi emits `extension_ui_request` for a dialog
- pi emits compaction and auto-retry mid-run
- `pi_ask` timeout, then a successful `pi_ask` afterwards

Manual, on a real repo:

- Worktree mode, a real delegated task, result merged
- Shared tree mode, both agents editing different folders
- Pi sends a `warning` mid-task; Claude receives it via Stop hook
- Separate directories with a shared `AGENT_BUS`
- Deliberately mismatched `AGENT_BUS`, confirm the warning fires

Write the stub pi first. Testing against a real pi burns tokens and is not deterministic.

## 9. Milestones

1. **Transport.** `pi-session.mjs` plus stub pi and its unit tests. Nothing MCP yet. Done when `ask()` survives the full integration matrix.
2. **MCP surface.** `mcp-server.mjs`, registered with Claude Code, `pi_ask` working end to end against real pi. This is the first usable slice.
3. **Return path.** pi extension, bus, Stop hook, `pi_inbox`. Done when pi can interrupt Claude's stop.
4. **Directory modes.** Worktree setup script, `.bus-info.json` mismatch detection, path warnings, docs for both modes.
5. **Harden.** Timeouts, EPIPE, signal handling, error messages a human can act on. Ship.

Milestone 2 is the decision point. Run it on real work for a few days before building 3. If delegation to a second harness does not beat Claude Code's own subagents, the rest is not worth building.

## 10. Deferred decisions

Log these, do not solve them now.

- `pi_ask_async`: return a ticket, let pi push the result to the bus. Turns delegation from blocking to parallel, which is where the real speedup is. Wait until milestone 3 is proven.
- Shared `PROTOCOL.md` referenced from both `CLAUDE.md` and `AGENTS.md`, defining roles and file ownership.
- More than one pi session per Claude session.
- Replacing the file bus with a Unix socket broker.
- ACP as the transport instead of MCP plus RPC, once pi has a first-party adapter.

## 11. Protocol reference

Facts the implementation depends on. Verify against the linked docs before building; these move.

**pi RPC** (`pi --mode rpc`, https://pi.dev/docs/latest/rpc)

- Commands in on stdin as JSONL, one object per line. Optional `id` correlates to `{"type": "response", "id", "command", "success", "data"|"error"}`.
- Framing is LF only. `\r` may be stripped. Node `readline` is explicitly called out as non-compliant.
- Key commands: `prompt` (with `streamingBehavior: "steer"|"followUp"` when streaming), `steer`, `follow_up`, `abort`, `clear_queue`, `get_state`, `get_session_stats`, `get_last_assistant_text`, `get_entries` (durable `since` cursor), `set_model`, `set_thinking_level`, `compact`.
- Key events: `agent_start`, `turn_start`/`turn_end`, `message_update` (deltas in `assistantMessageEvent`), `tool_execution_start`/`update`/`end`, `compaction_start`/`end`, `auto_retry_start`/`end`, `extension_error`, `agent_end`, `agent_settled`.
- `agent_end` is one low-level run. `agent_settled` is the session actually finishing.
- `extension_ui_request` on stdout expects `extension_ui_response` on stdin for dialog methods, with matching `id`.

**pi extensions** (https://pi.dev/docs/latest/extensions)

- Default-export a factory receiving `ExtensionAPI`. TypeScript, loaded via jiti, no build step.
- `pi.registerTool({name, label, description, promptSnippet, promptGuidelines, parameters, execute})`, parameters via `typebox`.
- `pi.registerCommand(name, {description, handler})`.
- Background resources start in `session_start`, clean up in `session_shutdown`, never in the factory.
- Pi ships no MCP support by design. Do not look for it.

**Claude Code** (https://code.claude.com/docs/en/headless, .../hooks, .../mcp-quickstart)

- `claude mcp add <name> -s user -- <command>` registers a stdio server.
- Stop hook JSON output: `{"decision": "block", "reason": "..."}` prevents the stop and shows the reason to Claude. Exit code 2 is the equivalent via stderr; exit code 1 is a logged error with no effect.
- Hook payload arrives on stdin and includes `stop_hook_active`.
- MCP tool permissions are named `mcp__<server>__<tool>` in `permissions.allow`.
