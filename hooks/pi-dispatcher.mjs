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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function main() {
  const raw = await readStdin();
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { process.exit(0); }

  // Only act on the *_ask_async tools; other PreToolUse calls exit silently.
  const tool = payload.tool_name || "";
  if (tool !== "mcp__switchboard__pi_ask_async" && tool !== "mcp__switchboard__oc_ask_async") {
    process.exit(0);
  }

  const sessionId = payload.session_id || payload.sessionId;
  if (!sessionId) process.exit(0); // no id -> fallback to pull-only (current behavior)

  const bus = resolveBus();
  try { fs.mkdirSync(bus, { recursive: true }); } catch {}

  // If a sidecar for THIS session already exists, replace it: a single
  // Claude session should never have two pending async dispatches because
  // Claude runs tools serially per turn. Replacing keeps the most recent
  // intent (also handles a PreToolUse+Stop reassembly loop).
  const file = path.join(bus, `dispatcher-${safeId(sessionId)}.json`);
  const record = {
    sessionId: String(sessionId),
    tool: tool.replace(/^mcp__switchboard__/, ""),
    expectedMessage: typeof payload.tool_input?.message === "string" ? payload.tool_input.message.slice(0, 4000) : null,
    host: (() => { try { return os.hostname(); } catch { return null; } })(),
    pid: process.ppid || process.pid,
    ts: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch {
    // Fail open: never break Claude on a write error.
  }
  process.exit(0);
}

main();
