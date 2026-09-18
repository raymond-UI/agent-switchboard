// Switchboard app core: transports, tools, tickets. Import-safe: constructing
// sessions spawns nothing (lazy), no stdin handling here. Shared by the
// stdio MCP server, the HTTP face, and tests.

import { PiSession } from "./pi-session.mjs";
import { OcSession } from "./oc-session.mjs";
import { resolveConfig } from "./env.mjs";
import { drainUnread, formatForClaude, writeBusInfo, appendToAgent, appendMessage, listPresence } from "./bus.mjs";
import { capResult, formatAskResult } from "./format.mjs";
import { randomUUID } from "node:crypto";

// Async delegation tickets (P1): fire-and-forget runs whose results land on
// the bus (kind=result, ticket=<id>) for pi_inbox/Stop-hook delivery.
// In-memory: a bridge restart loses running tickets (posted results persist).
const tickets = new Map(); // id -> {agent, status, startedTs, startedEpoch, timeoutMs, message}

// One-line nudge appended when a run eats most of its ceiling, so the
// calling agent learns (with zero human) to ask for more time or go async
// next time. Kept to one line: it rides every near-limit result.
function nearCeilingHint(elapsedMs, ceilingMs, asyncTool) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(ceilingMs) || ceilingMs <= 0) return null;
  if (elapsedMs < ceilingMs * 0.8) return null;
  return `Hint: took ${Math.round(elapsedMs / 1000)}s of a ${Math.round(ceilingMs / 1000)}s ceiling; for longer legs pass timeoutMs (max 28800000) or use ${asyncTool} (4h default).`;
}

function launchTicket(agent, message, run, timeoutMs = null) {
  const id = `t-${randomUUID().slice(0, 8)}`;
  const startedEpoch = Date.now();
  tickets.set(id, { agent, status: "running", startedTs: new Date(startedEpoch).toISOString(), startedEpoch, timeoutMs, message: String(message).slice(0, 200) });
  run().then(
    (r) => {
      tickets.set(id, { ...tickets.get(id), status: "done" });
      const hint = timeoutMs ? nearCeilingHint(Date.now() - startedEpoch, timeoutMs, agent === "opencode" ? "oc_ask_async" : "pi_ask_async") : null;
      appendMessage(config.agentBus, {
        text: `Ticket ${id} settled.\n\n${capResult(formatAskResult(r) + (hint ? `\n\n${hint}` : ""), config.agentBus)}`,
        kind: "result",
        from: agent,
        agent,
        ticket: id,
        session: r.sessionFile || r.sessionId || null,
      });
    },
    (err) => {
      tickets.set(id, { ...tickets.get(id), status: "failed" });
      appendMessage(config.agentBus, {
        text: `Ticket ${id} failed: ${err.message}`,
        kind: "warning",
        from: agent,
        agent,
        ticket: id,
      });
    }
  );
  return id;
}
import path from "node:path";

const config = resolveConfig();
const pi = new PiSession({
  piBin: config.piBin,
  piCwd: config.piCwd,
  piModel: config.piModel,
  piName: config.piName,
  piSessionDir: config.piSessionDir,
  askTimeoutMs: config.askTimeoutMs,
});
// OpenCode transport reads OC_* env itself (OC_BIN, OC_CWD, OC_PORT,
// OC_MODEL, OC_BASE_URL for tests/attach). Lazy: no server until first oc_* call.
const oc = new OcSession({});

function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

// Per-call timeout: lets one long leg (e.g. CI) ask for hours while normal
// asks keep the 15-min default. Clamped so a typo can't hang the bridge for
// days or pass a nonsense value to the transports.
const MAX_TIMEOUT_MS = 28800000; // 8h
function resolveTimeout(args, def) {
  const v = args?.timeoutMs;
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.floor(n), 1000), MAX_TIMEOUT_MS);
}

// Warn when a pi_ask message contains relative-looking paths and dirs differ.
function relativePathWarning(message) {
  if (path.resolve(config.piCwd) === path.resolve(config.bridgeLaunchDir)) return null;
  const m = String(message);
  // crude: match src/foo.ts, ./x, ../x, folder/file.ext patterns not starting with /
  const rel = m.match(/(?:^|\s)(?:\.\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/);
  if (rel) {
    return (
      `Note: PI_CWD (${config.piCwd}) differs from Claude's dir (${config.bridgeLaunchDir}). ` +
      `Relative path '${rel[0].trim()}' may resolve differently. Prefer absolute paths.`
    );
  }
  return null;
}

// One-line tool descriptions (details live in README): 12 tools ride on every
// Claude turn, so each token here is a recurring tax.
const PI_ASK_DESCRIPTION = `pi_ask(message, timeoutMs?): blocking delegate to paired pi (${config.piCwd}). Self-contained, ABSOLUTE paths (pi can't see this chat). Same session continues; pi_new_session for clean slate. Minutes. timeoutMs (optional, default 900000, max 28800000): ask for longer on long legs e.g. CI. On timeout the worker KEEPS going (detached, no abort) — re-run pi_ask to wait again, pi_abort to kill. Details: README.`;

const TOOLS = [
  {
    name: "pi_ask",
    description: PI_ASK_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained task for pi (absolute paths)." },
        timeoutMs: { type: "number", description: "Optional wait ceiling in ms (default 900000, max 28800000). On timeout the worker keeps going detached." },
      },
      required: ["message"],
    },
  },
  {
    name: "pi_steer",
    description: "pi_steer(message): queue a mid-run correction (returns immediately; no-op when idle).",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "pi_abort",
    description: "pi_abort(): stop pi's current run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_new_session",
    description: "pi_new_session(): drop pi history, start clean for a new task (aborts runs). Unrecoverable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_state",
    description: "pi_state(): pi model/streaming/detachedRun/timeouts/tokens/context pressure (cost meter). detachedRun=true means a timed-out run is still going.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_ask",
    description: "oc_ask(message, timeoutMs?): blocking delegate to paired OpenCode worker. Self-contained, ABSOLUTE paths. Same session continues; oc_new_session for clean slate. Minutes. timeoutMs optional (default 900000, max 28800000). On timeout the worker keeps going detached — re-run oc_ask to wait again, oc_abort to kill. Details: README.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained task for OpenCode (absolute paths)." },
        timeoutMs: { type: "number", description: "Optional wait ceiling in ms (default 900000, max 28800000)." },
      },
      required: ["message"],
    },
  },
  {
    name: "oc_state",
    description: "oc_state(): OpenCode session/tokens/cost. Includes detachedRun + askTimeoutMs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_steer",
    description: "oc_steer(message): queue a follow-up correction on the busy OpenCode session (current run finishes first; no mid-turn interrupt). Returns immediately.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "oc_abort",
    description: "oc_abort(): stop OpenCode's current run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_new_session",
    description: "oc_new_session(): drop OpenCode history, start clean. Unrecoverable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_ask_async",
    description: "pi_ask_async(message, timeoutMs?): non-blocking pi delegate. Returns ticket id now; result arrives ONLY in YOUR pi_inbox under ticket=... (never via Stop hook, so it can't leak into a sibling session). Default ceiling 4h (PI_ASYNC_TIMEOUT_MS), override per call with timeoutMs. Fan out N tasks, then collect. Lost if bridge restarts.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained task for pi (absolute paths)." },
        timeoutMs: { type: "number", description: "Optional wait ceiling in ms (default 14400000, max 28800000)." },
      },
      required: ["message"],
    },
  },
  {
    name: "oc_ask_async",
    description: "oc_ask_async(message, timeoutMs?): non-blocking OpenCode delegate. Returns ticket id now; result arrives ONLY in YOUR pi_inbox under ticket=... (never via Stop hook). Default ceiling 4h (OC_ASYNC_TIMEOUT_MS), override per call with timeoutMs.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained task for OpenCode (absolute paths)." },
        timeoutMs: { type: "number", description: "Optional wait ceiling in ms (default 14400000, max 28800000)." },
      },
      required: ["message"],
    },
  },
  {
    name: "agent_tickets",
    description: "agent_tickets(): list async ticket states (running/done/failed) with ceilings. Results themselves arrive via pi_inbox.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_inbox",
    description: "pi_inbox(): read bus messages pushed by workers (also via Stop hook).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_sessions",
    description: "agent_sessions(): list paired workers (id/file/cwd/alive) for agent_send addressing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_send",
    description: "agent_send(message, to?): async message to a RUNNING worker (no reply here; watch pi_inbox). to = id/file/cwd from agent_sessions, default broadcasts. Worker sessions only receive messages sent after they started (no stale backlog), so address live sessions.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message for the running pi session." },
        to: { type: "string", description: "Session id, session file, or cwd (from agent_sessions). Default \"*\" broadcasts." },
      },
      required: ["message"],
    },
  },
];

function okResult(text) {
  return { content: [{ type: "text", text }] };
}

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function handleToolCall(name, args) {
  try {
    switch (name) {
      case "pi_ask": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("pi_ask requires a 'message' string.");
        const warn = relativePathWarning(message);
        if (warn) log("[switchboard] WARN:", warn);
        const ceiling = resolveTimeout(args, config.askTimeoutMs);
        const t0 = Date.now();
        const r = await pi.ask(message, { timeoutMs: ceiling });
        let out = capResult(formatAskResult(r), config.agentBus);
        const hint = nearCeilingHint(Date.now() - t0, ceiling, "pi_ask_async");
        if (hint) out += `\n\n${hint}`;
        if (warn) out += `\n\nWARNING: ${warn}`;
        return okResult(out);
      }
      case "pi_steer": {
        const message = args?.message;
        if (!message) return errResult("pi_steer requires a 'message' string.");
        await pi.steer(message);
        return okResult("Steer message queued.");
      }
      case "pi_abort": {
        await pi.abort();
        return okResult("Abort sent.");
      }
      case "pi_new_session": {
        const r = await pi.newSession();
        if (r.cancelled) return errResult("pi refused the new session (cancelled by extension).");
        return okResult(`Fresh pi session started.${r.sessionFile ? ` Session file: ${r.sessionFile}` : ""} pi_ask now continues in the new session.`);
      }
      case "pi_state": {
        const s = await pi.state();
        return okResult(JSON.stringify(s, null, 2));
      }
      case "pi_inbox": {
        const unread = drainUnread(config.agentBus);
        if (!unread.length) return okResult("(inbox empty)");
        return okResult(formatForClaude(unread));
      }
      case "agent_sessions": {
        const all = listPresence(config.agentBus);
        if (!all.length) return okResult("(no paired worker sessions seen yet)");
        return okResult(
          all
            .map(
              (p) =>
                `- ${p.alive ? "alive" : "STALE"} ${p.agent || "?"} id=${p.sessionId} cwd=${p.cwd || "?"}${p.sessionFile ? ` file=${p.sessionFile}` : ""} (pid ${p.pid || "?"}, seen ${p.ts})`
            )
            .join("\n")
        );
      }
      case "oc_ask": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("oc_ask requires a 'message' string.");
        if (path.resolve(oc.ocCwd) !== path.resolve(config.bridgeLaunchDir)) {
          log(`[switchboard] WARN: OC_CWD (${oc.ocCwd}) differs from Claude's dir (${config.bridgeLaunchDir}). Prefer absolute paths.`);
        }
        const ceiling = resolveTimeout(args, config.askTimeoutMs);
        const t0 = Date.now();
        const r = await oc.ask(message, { timeoutMs: ceiling });
        const parts = [r.text || "(empty)", ""];
        parts.push(`Tools used: ${r.toolsUsed.length ? r.toolsUsed.join(", ") : "(none)"}`);
        if (r.tokens) parts.push(`Tokens: ${JSON.stringify(r.tokens)}`);
        if (r.cost !== null && r.cost !== undefined) parts.push(`Cost: ${r.cost}`);
        if (r.sessionId) parts.push(`opencode session: ${r.sessionId}`);
        const hint = nearCeilingHint(Date.now() - t0, ceiling, "oc_ask_async");
        if (hint) parts.push("", hint);
        return okResult(capResult(parts.join("\n"), config.agentBus));
      }
      case "oc_state": {
        const s = await oc.state();
        return okResult(JSON.stringify(s, null, 2));
      }
      case "oc_steer": {
        const message = args?.message;
        if (!message) return errResult("oc_steer requires a 'message' string.");
        await oc.steer(message);
        return okResult("Steer message queued (follow-up; current run finishes first).");
      }
      case "oc_abort": {
        await oc.abort();
        return okResult("Abort sent.");
      }
      case "oc_new_session": {
        const r = await oc.newSession();
        return okResult(`Fresh OpenCode session started (id=${r.sessionId}). oc_ask now continues in the new session.`);
      }
      case "pi_ask_async": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("pi_ask_async requires a 'message' string.");
        const t = resolveTimeout(args, config.asyncTimeoutMs);
        const id = launchTicket("pi", message, () => pi.ask(message, { timeoutMs: t }), t);
        return okResult(`Ticket ${id} queued on pi (ceiling ${t}ms). Result arrives via pi_inbox (ticket=${id}); check agent_tickets for state.`);
      }
      case "oc_ask_async": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("oc_ask_async requires a 'message' string.");
        const ot = resolveTimeout(args, config.ocAsyncTimeoutMs ?? config.asyncTimeoutMs);
        const id = launchTicket("opencode", message, () => oc.ask(message, { timeoutMs: ot }), ot);
        return okResult(`Ticket ${id} queued on opencode (ceiling ${ot}ms). Result arrives via pi_inbox (ticket=${id}); check agent_tickets for state.`);
      }
      case "agent_tickets": {
        if (!tickets.size) return okResult("(no tickets)");
        return okResult(
          [...tickets.entries()]
            .map(([id, t]) => `- ${id} ${t.agent} ${t.status} ceiling=${t.timeoutMs != null ? `${t.timeoutMs}ms` : "?"} started=${t.startedTs} msg=${t.message}`)
            .join("\n")
        );
      }
      case "agent_send": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("agent_send requires a 'message' string.");
        // Reply-to stamping: the worker must be able to answer WITHOUT
        // guessing. The bridge can't know the calling Claude session (MCP
        // exposes no session id), but presence knows who's alive: exactly
        // one live Claude session => deterministic reply target, stamped
        // into the record AND the text. Zero/multiple => no stamp (the
        // worker sees candidates via agent_sessions, or the human relays).
        const claudeAlive = listPresence(config.agentBus).filter((p) => p.agent === "claude" && p.alive && p.sessionId);
        const replyTo = claudeAlive.length === 1 ? claudeAlive[0].sessionId : null;
        const footer = replyTo
          ? `\n\n(Reply to the Claude session that sent this with message_claude {to: "${replyTo}"})`
          : "";
        const rec = appendToAgent(config.agentBus, {
          text: message + footer,
          to: args?.to || "*",
          ...(replyTo ? { replyTo } : {}),
        });
        const who = replyTo
          ? ` Replies route to Claude session ${replyTo}.`
          : ` ${claudeAlive.length === 0 ? "No live Claude session seen" : `${claudeAlive.length} live Claude sessions seen`} — worker cannot auto-reply; name a session id for it to answer.`;
        return okResult(
          `Queued for running worker (to=${rec.to}, id=${rec.id}). Async: the target polls every ~2s. No reply here; watch pi_inbox.${who}`
        );
      }
      default:
        return errResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // Tool errors -> isError result, never JSON-RPC error (PRD 6.2).
    return errResult(`${name} failed: ${err.message}`);
  }
}


let initialized = false;
export async function handleRequest(msg, send) {
  // Notifications (no id): no response.
  const isNotif = msg.id === undefined || msg.id === null;
  try {
    if (msg.method === "initialize") {
      const version = msg.params?.protocolVersion || "2024-11-05";
      const res = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "switchboard", version: "0.1.0" },
        },
      };
      initialized = true;
      // Write .bus-info.json on startup (split-bus detection, PRD 7.5).
      try {
        writeBusInfo(config.agentBus, { piCwd: config.piCwd });
      } catch (err) {
        log("[switchboard] WARN: cannot write .bus-info.json:", err.message);
      }
      // P3 warm pool: pre-spawn workers in the background (no prompt, no
      // tokens) so the first ask doesn't pay spawn+model-load. Lazy path
      // still covers failures. Disable with BRIDGE_WARMUP=0.
      if (process.env.BRIDGE_WARMUP !== "0") {
        (async () => {
          try {
            pi.ensureStarted();
            log("[switchboard] pi warming up...");
          } catch (err) {
            log("[switchboard] pi warmup failed (lazy start still works):", err.message);
          }
          try {
            await oc.ensureServe();
            log("[switchboard] opencode serve warm");
          } catch (err) {
            log("[switchboard] opencode warmup failed (lazy start still works):", err.message);
          }
        })();
      }
      if (!isNotif) send(res);
      return;
    }
    if (msg.method === "ping") {
      if (!isNotif) send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "notifications/initialized" || (msg.method || "").startsWith("notifications/")) {
      return; // ignore
    }
    if (msg.method === "tools/list") {
      if (!isNotif) send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const result = await handleToolCall(name, args);
      if (!isNotif) send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (!isNotif) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    if (!isNotif) {
      // Protocol-level failure only; tool failures are handled inside handleToolCall.
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err.message || err) } });
    }
  }
}


export { config, pi, oc, tickets, log, TOOLS };
export async function stopWorkers() {
  try { await pi.stop(); } catch {}
  try { await oc.stop(); } catch {}
}
