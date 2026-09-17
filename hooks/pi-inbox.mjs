#!/usr/bin/env node
// Stop hook: thin CLI over bridge/hook-core.mjs (shared with the HTTP
// /inbox endpoint). Node only. Exit 0 silently except block-with-messages.
// Remote mode: AGENT_BUS_REMOTE=http://host:port asks the bridge instead.

import { resolveConfig } from "../bridge/env.mjs";
import { decideInbox } from "../bridge/hook-core.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 100);
  });
}

async function remoteDecide(remote, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const headers = { "Content-Type": "application/json" };
    const token = process.env.SWITCHBOARD_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(remote.replace(/\/$/, "") + "/inbox", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: payload.session_id || payload.sessionId || null }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // fail-open: never break Claude on network trouble
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }
  if (payload.stop_hook_active) process.exit(0);

  const remote = process.env.AGENT_BUS_REMOTE;
  if (remote) {
    const ans = await remoteDecide(remote, payload);
    if (ans && ans.type === "block" && ans.reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: ans.reason }) + "\n");
    }
    process.exit(0);
  }

  const config = resolveConfig();
  try {
    const ans = decideInbox(config.agentBus, payload, {
      maxConsecutiveBlocks: config.maxConsecutiveBlocks,
    });
    if (ans.type === "block") {
      process.stdout.write(JSON.stringify({ decision: "block", reason: ans.reason }) + "\n");
    }
  } catch {}
  process.exit(0);
}

main();
