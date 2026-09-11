#!/usr/bin/env node
// Stop hook: delivers unread bus messages into the live Claude Code session.
// (PRD 6.5) Node only. Exit 0 silently in every case except block-with-messages.

import fs from "node:fs";
import path from "node:path";
import { resolveConfig, hookCounterFile, hookWarnedFile } from "../bridge/env.mjs";
import { readUnread, drainUnread, readBusInfo } from "../bridge/bus.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // If no pipe, resolve quickly.
    setTimeout(() => resolve(data), 100);
  });
}

function readCounter(agentBus) {
  try {
    return JSON.parse(fs.readFileSync(hookCounterFile(agentBus), "utf8")).count || 0;
  } catch {
    return 0;
  }
}
function writeCounter(agentBus, count) {
  try {
    fs.mkdirSync(agentBus, { recursive: true });
    fs.writeFileSync(hookCounterFile(agentBus), JSON.stringify({ count }) + "\n");
  } catch {}
}
function alreadyWarned(agentBus, key) {
  try {
    const j = JSON.parse(fs.readFileSync(hookWarnedFile(agentBus), "utf8"));
    return j[key] === true;
  } catch {
    return false;
  }
}
function markWarned(agentBus, key) {
  try {
    fs.mkdirSync(agentBus, { recursive: true });
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(hookWarnedFile(agentBus), "utf8"));
    } catch {}
    j[key] = true;
    fs.writeFileSync(hookWarnedFile(agentBus), JSON.stringify(j));
  } catch {}
}

function formatRecords(records) {
  return records
    .map((r) => {
      const paths = r.paths && r.paths.length ? `\nFiles: ${r.paths.join(", ")}` : "";
      return `[${r.kind}] ${r.text}${paths}`;
    })
    .join("\n---\n");
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }
  // Already inside a blocked stop: exit immediately (rail 1).
  if (payload.stop_hook_active) process.exit(0);

  const config = resolveConfig();
  const agentBus = config.agentBus;

  // Split-bus detection (PRD 7.5): compare hook-resolved path to bridge's .bus-info.json.
  let mismatchNote = null;
  try {
    const info = readBusInfo(agentBus);
    if (info && info.busPath && path.resolve(info.busPath) !== path.resolve(agentBus)) {
      const key = `mismatch:${info.busPath}`;
      if (!alreadyWarned(agentBus, key)) {
        mismatchNote =
          `WARNING: AGENT_BUS mismatch. Bridge writes to ${info.busPath} but this hook reads ${path.resolve(agentBus)}. ` +
          `Set AGENT_BUS to the same directory on both sides or messages will vanish.`;
        markWarned(agentBus, key);
      }
    }
  } catch {
    // No .bus-info.json yet: bridge hasn't started. Not fatal.
  }

  let unread = [];
  try {
    unread = readUnread(agentBus);
  } catch {
    process.exit(0);
  }

  const maxBlocks = config.maxConsecutiveBlocks;
  let count = readCounter(agentBus);

  const hasMessages = unread.length > 0;
  const hasWarning = !!mismatchNote;

  if (!hasMessages && !hasWarning) {
    // Nothing to deliver: reset counter.
    if (count !== 0) writeCounter(agentBus, 0);
    process.exit(0);
  }
  if (count >= maxBlocks) {
    // Loop cap (rail 2). Do not block; leave messages for pi_inbox poll.
    process.exit(0);
  }
  // Drain (marks read BEFORE emit) then block once with messages.
  let drained = [];
  try {
    drained = hasMessages ? drainUnread(agentBus) : [];
  } catch {
    process.exit(0);
  }
  const parts = [];
  if (mismatchNote) parts.push(mismatchNote);
  if (drained.length) parts.push(formatRecords(drained));
  const reason = parts.join("\n---\n");
  writeCounter(agentBus, count + 1);
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

main();
