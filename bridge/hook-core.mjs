// Shared inbox decision logic: used by the local Stop hook AND the HTTP
// /inbox endpoint (remote Claude sessions). Same files, same rails, same
// pull-only ticket rule. Side-effect free to import (no stdin handling).
// decideInbox returns {type:"silent"} | {type:"block", reason}.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readUnread,
  drainUnread,
  readBusInfo,
  readHookCounter,
  writeHookCounter,
  hookAlreadyWarned,
  hookMarkWarned,
} from "./bus.mjs";

function formatRecords(records) {
  return records
    .map((r) => {
      const paths = r.paths && r.paths.length ? `\nFiles: ${r.paths.join(", ")}` : "";
      return `[${r.kind}] ${r.text}${paths}`;
    })
    .join("\n---\n");
}

export function heartbeatClaude(agentBus, payload) {
  const mySessionId = payload.session_id || payload.sessionId || null;
  if (!mySessionId) return null;
  try {
    fs.mkdirSync(path.join(agentBus, "presence"), { recursive: true });
    fs.writeFileSync(
      path.join(agentBus, "presence", `claude-${String(mySessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`),
      JSON.stringify({
        sessionId: String(mySessionId),
        agent: "claude",
        host: (() => { try { return os.hostname(); } catch { return null; } })(),
        sessionFile: null,
        cwd: payload.cwd || process.env.CLAUDE_PROJECT_DIR || null,
        name: "claude-code",
        pid: process.ppid || process.pid,
        ts: new Date().toISOString(),
      }, null, 2) + "\n"
    );
  } catch {}
  return String(mySessionId);
}

export function decideInbox(agentBus, payload, { maxConsecutiveBlocks = 3 } = {}) {
  const mySessionId = heartbeatClaude(agentBus, payload);

  let mismatchNote = null;
  try {
    const info = readBusInfo(agentBus);
    if (info && info.busPath && path.resolve(info.busPath) !== path.resolve(agentBus)) {
      const key = `mismatch:${info.busPath}`;
      if (!hookAlreadyWarned(agentBus, key)) {
        mismatchNote =
          `WARNING: AGENT_BUS mismatch. Bridge writes to ${info.busPath} but this hook reads ${path.resolve(agentBus)}. ` +
          `Set AGENT_BUS to the same directory on both sides or messages will vanish.`;
        hookMarkWarned(agentBus, key);
      }
    }
  } catch {}

  const forMe = (r) => !mySessionId || !r || !r.to || r.to === "*" || r.to === mySessionId;
  let unread = [];
  try {
    unread = readUnread(agentBus).filter((r) => (!r || !r.ticket) && forMe(r));
  } catch {
    return { type: "silent" };
  }

  let count = readHookCounter(agentBus);
  const hasMessages = unread.length > 0;
  const hasWarning = !!mismatchNote;

  if (!hasMessages && !hasWarning) {
    if (count !== 0) writeHookCounter(agentBus, 0);
    return { type: "silent" };
  }
  if (count >= maxConsecutiveBlocks) {
    return { type: "silent" };
  }
  const skip = (r) => !!(r && (r.ticket || (mySessionId && r.to && r.to !== "*" && r.to !== mySessionId)));
  let drained = [];
  try {
    drained = hasMessages ? drainUnread(agentBus, process.env, skip) : [];
  } catch {
    return { type: "silent" };
  }
  const parts = [];
  if (mismatchNote) parts.push(mismatchNote);
  if (drained.length) parts.push(formatRecords(drained));
  writeHookCounter(agentBus, count + 1);
  return { type: "block", reason: parts.join("\n---\n") };
}
