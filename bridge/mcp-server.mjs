#!/usr/bin/env node
// MCP stdio server exposing pi to Claude Code (PRD 6.2).
// stdout = protocol only. All logs -> stderr.

import { PiSession } from "./pi-session.mjs";
import { OcSession } from "./oc-session.mjs";
import { resolveConfig, busInfoFile } from "./env.mjs";
import { drainUnread, formatForClaude, writeBusInfo, appendToAgent, listPresence } from "./bus.mjs";
import fs from "node:fs";
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

const PI_ASK_DESCRIPTION = `Delegate a self-contained task to the paired pi agent (runs in ${config.piCwd}).

pi CANNOT see this conversation. Instructions must be fully self-contained:
- Use ABSOLUTE file paths (relative paths resolve against pi's dir, not Claude's).
- State goal, constraints, done-criteria, and which files/folders pi owns.
- Keep it focused; one task per call.

This call BLOCKS for minutes (up to ${Math.round(config.askTimeoutMs / 60000)} min) until pi settles. Returns pi's final text + tool summary + notices. Follow-up pi_ask calls continue the SAME session (pi remembers). For a new task with clean context use pi_new_session first. For mid-run corrections use pi_steer; to stop use pi_abort. Delivery pi->Claude is async via the message bus (see pi_inbox).`;

const TOOLS = [
  {
    name: "pi_ask",
    description: PI_ASK_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Self-contained task for pi (absolute paths)." } },
      required: ["message"],
    },
  },
  {
    name: "pi_steer",
    description: "Queue a mid-run correction to pi while it is streaming. Returns immediately; pi picks it up after the current turn. No-op when pi is idle.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "pi_abort",
    description: "Abort pi's current run. Use on timeouts or wrong direction.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_new_session",
    description:
      "Kill the current pi session and start a fresh one (clean context) for a new task. Previous history is dropped and cannot be recovered. Use when switching tasks or when the session is polluted. Ongoing runs are aborted first. Follow-ups via pi_ask continue the NEW session afterwards.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_state",
    description: "pi model, streaming flag, message counts, token usage and context-window pressure (cost meter).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_ask",
    description:
      "Delegate a self-contained task to the paired OpenCode worker (headless `opencode serve` owned by this bridge). OpenCode CANNOT see this conversation: use ABSOLUTE file paths, state goal/constraints/done-criteria. BLOCKS until the session goes idle. Follow-ups continue the SAME session; oc_new_session starts clean. Async messages to running workers (either harness) go via agent_send.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Self-contained task for OpenCode (absolute paths)." } },
      required: ["message"],
    },
  },
  {
    name: "oc_state",
    description: "OpenCode session id, directory, token usage and cost (the cost meter).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_abort",
    description: "Abort OpenCode's current run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oc_new_session",
    description: "Drop the current OpenCode session (deleted server-side) and start clean for a new task. Previous history is unrecoverable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pi_inbox",
    description: "Return and mark-read unread bus messages pi pushed (results/questions/warnings). Poll when idle; Stop hook also delivers them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_sessions",
    description:
      "List running pi sessions paired via the message bus (session id, file, cwd, alive). Use to discover the `to` address for agent_send. Only sessions with a bridge plugin/extension appear.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_send",
    description:
      "Send an async message to a RUNNING paired worker (pi or opencode you didn't start). Delivery is one-way and polled (~2s): the target injects it into its conversation. No reply comes back in this call — watch pi_inbox for its response. `to` is a session id, session file path, or cwd from agent_sessions (default \"*\" broadcasts to all paired sessions; prefer addressing one).",
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

function formatAskResult(r) {
  const parts = [];
  parts.push(r.text || "(empty)");
  parts.push("");
  parts.push(`Tools used: ${r.toolsUsed.length ? r.toolsUsed.join(", ") : "(none)"}`);
  if (r.tokens) parts.push(`Tokens: ${JSON.stringify(r.tokens)}`);
  if (typeof r.cost !== "undefined" && r.cost !== null) parts.push(`Cost: ${r.cost}`);
  if (r.contextUsage) parts.push(`Context: ${JSON.stringify(r.contextUsage)}`);
  if (r.compactions) parts.push(`Compactions: ${r.compactions}`);
  if (r.retries) parts.push(`Auto-retries: ${r.retries}`);
  if (r.notices.length) parts.push(`Notices:\n- ${r.notices.join("\n- ")}`);
  if (r.sessionFile) parts.push(`pi session: ${r.sessionFile}`);
  return parts.join("\n");
}

async function handleToolCall(name, args) {
  try {
    switch (name) {
      case "pi_ask": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("pi_ask requires a 'message' string.");
        const warn = relativePathWarning(message);
        if (warn) log("[pi-bridge] WARN:", warn);
        const r = await pi.ask(message, { timeoutMs: config.askTimeoutMs });
        let out = formatAskResult(r);
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
          log(`[pi-bridge] WARN: OC_CWD (${oc.ocCwd}) differs from Claude's dir (${config.bridgeLaunchDir}). Prefer absolute paths.`);
        }
        const r = await oc.ask(message, { timeoutMs: config.askTimeoutMs });
        const parts = [r.text || "(empty)", ""];
        parts.push(`Tools used: ${r.toolsUsed.length ? r.toolsUsed.join(", ") : "(none)"}`);
        if (r.tokens) parts.push(`Tokens: ${JSON.stringify(r.tokens)}`);
        if (r.cost !== null && r.cost !== undefined) parts.push(`Cost: ${r.cost}`);
        if (r.sessionId) parts.push(`opencode session: ${r.sessionId}`);
        return okResult(parts.join("\n"));
      }
      case "oc_state": {
        const s = await oc.state();
        return okResult(JSON.stringify(s, null, 2));
      }
      case "oc_abort": {
        await oc.abort();
        return okResult("Abort sent.");
      }
      case "oc_new_session": {
        const r = await oc.newSession();
        return okResult(`Fresh OpenCode session started (id=${r.sessionId}). oc_ask now continues in the new session.`);
      }
      case "agent_send": {
        const message = args?.message;
        if (!message || typeof message !== "string")
          return errResult("agent_send requires a 'message' string.");
        const rec = appendToAgent(config.agentBus, { text: message, to: args?.to || "*" });
        return okResult(
          `Queued for running worker (to=${rec.to}, id=${rec.id}). Async: the target polls every ~2s. No reply here; watch pi_inbox.`
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

// ---- JSON-RPC over stdio, LF-delimited ----
let buffer = "";
let initialized = false;

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  }
}
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});

async function handleRequest(msg) {
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
          serverInfo: { name: "pi-bridge", version: "0.1.0" },
        },
      };
      initialized = true;
      // Write .bus-info.json on startup (split-bus detection, PRD 7.5).
      try {
        writeBusInfo(config.agentBus, { piCwd: config.piCwd });
      } catch (err) {
        log("[pi-bridge] WARN: cannot write .bus-info.json:", err.message);
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

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRequest(msg);
  }
});

async function shutdown(signal) {
  log(`[pi-bridge] ${signal}, stopping workers...`);
  // Force-exit even if graceful stop hangs (e.g. already-dead child).
  const force = setTimeout(() => process.exit(0), 8000);
  if (typeof force.unref === "function") force.unref();
  try {
    await pi.stop();
  } catch {}
  try {
    await oc.stop();
  } catch {}
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log(`[pi-bridge] ready. PI_CWD=${config.piCwd} AGENT_BUS=${config.agentBus} PI_BIN=${config.piBin}`);
