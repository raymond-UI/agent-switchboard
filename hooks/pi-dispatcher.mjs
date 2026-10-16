#!/usr/bin/env node
// PreToolUse hook for mcp__switchboard__(pi|oc)_ask_async. Runs in the
// Claude process and is the ONLY place Claude's session id is exposed
// during a tool call. Writes a tiny sidecar the bridge reads at dispatch
// time so an async ticket can be bound to the dispatcher exactly — even
// when multiple Claude + worker sessions share one bus.
//
// Stdin (from Claude): {session_id, tool_name, tool_input: {message, ...}}
// Sidecar: $AGENT_BUS/dispatcher-<sanitizedSessionId>.json
//   { sessionId, tool, ts, expectedMessage }
// Consumed once by the bridge (read + delete). Never read by Claude.
// Paired with a remote worker (switchboard-connect / AGENT_BUS_REMOTE): the
// record is POSTed to the worker bridge's /dispatch instead, since the
// bridge reads sidecars from ITS bus, not ours.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRemote, firstSet } from "../bridge/remote.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.setEncoding ? null : null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 100);
  });
}

function safeId(s) {
  return String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200) || "unknown";
}

function resolveBus() {
  return process.env.AGENT_BUS || (process.env.CLAUDE_PROJECT_DIR ? path.join(process.env.CLAUDE_PROJECT_DIR, ".agentbus") : path.join(process.cwd(), ".agentbus"));
}

const ASYNC_TOOLS = new Set(["mcp__switchboard__pi_ask_async", "mcp__switchboard__oc_ask_async"]);

function hostname() {
  try { return os.hostname(); } catch { return null; }
}

function buildRecord(payload) {
  const msg = Object(payload.tool_input).message;
  return {
    sessionId: String(firstSet(payload.session_id, payload.sessionId)),
    tool: payload.tool_name.replace(/^mcp__switchboard__/, ""),
    expectedMessage: typeof msg === "string" ? msg.slice(0, 4000) : null,
    host: hostname(),
    pid: firstSet(process.ppid, process.pid),
    ts: new Date().toISOString(),
  };
}

async function postRemote(remote, record) {
  const headers = { "Content-Type": "application/json" };
  if (remote.token) headers.Authorization = `Bearer ${remote.token}`;
  try {
    await fetch(remote.url + "/dispatch", { method: "POST", headers, body: JSON.stringify(record), signal: AbortSignal.timeout(3000) });
  } catch {} // fail open: ticket just stays pull-only
}

// If a sidecar for THIS session already exists, replace it: a single
// Claude session should never have two pending async dispatches because
// Claude runs tools serially per turn. Replacing keeps the most recent
// intent (also handles a PreToolUse+Stop reassembly loop).
function writeLocal(record) {
  const bus = resolveBus();
  try {
    fs.mkdirSync(bus, { recursive: true });
    fs.writeFileSync(path.join(bus, `dispatcher-${safeId(record.sessionId)}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch {
    // Fail open: never break Claude on a write error.
  }
}

function parsePayload(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return null; }
}

async function main() {
  const payload = parsePayload(await readStdin());
  // Only act on the *_ask_async tools; no session id -> pull-only fallback.
  if (!payload || !ASYNC_TOOLS.has(payload.tool_name) || !firstSet(payload.session_id, payload.sessionId)) process.exit(0);
  const record = buildRecord(payload);
  const remote = resolveRemote();
  if (remote) await postRemote(remote, record);
  else writeLocal(record);
  process.exit(0);
}

main();
