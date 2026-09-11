// File message bus: $AGENT_BUS/to-claude.jsonl (PRD 6.3).
// Append-only JSONL. Single appendFileSync of one line <4KB is atomic
// enough on macOS. Larger lines: still written with a single append but
// documented as best-effort (see README limit note).

import fs from "node:fs";
import path from "node:path";
import { busFile } from "./env.mjs";

const VALID_KINDS = new Set(["result", "question", "warning", "fyi"]);
const VALID_FROM = new Set(["pi", "pi-user"]);

export function ensureBusDir(agentBus) {
  fs.mkdirSync(agentBus, { recursive: true });
}

export function appendMessage(agentBus, { text, kind = "fyi", paths = [], from = "pi", session = null }) {
  ensureBusDir(agentBus);
  if (!VALID_KINDS.has(kind)) kind = "fyi";
  if (!VALID_FROM.has(from)) from = "pi";
  const record = {
    ts: new Date().toISOString(),
    from,
    kind,
    text: String(text ?? ""),
    session,
    paths: Array.isArray(paths) ? paths : [],
    read: false,
  };
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(busFile(agentBus), line, "utf8");
  return record;
}

export function readAll(agentBus) {
  const file = busFile(agentBus);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Malformed lines are skipped, never fatal (PRD 6.3).
    }
  }
  return out;
}

export function readUnread(agentBus) {
  return readAll(agentBus).filter((r) => r && r.read !== true);
}

/**
 * Drain unread messages. Marks read:true BEFORE returning (crash-after-emit
 * must not replay forever). Rewrites file in place.
 * Returns the unread records.
 */
export function drainUnread(agentBus) {
  const file = busFile(agentBus);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n");
  const records = [];
  const unread = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      records.push(rec);
      if (rec && rec.read !== true) unread.push(rec);
    } catch {
      // skip malformed
    }
  }
  if (unread.length === 0) return [];
  // Mark read before emit.
  for (const rec of records) {
    if (rec && rec.read !== true) rec.read = true;
  }
  const rewritten = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  // Best-effort atomic rewrite: write temp + rename.
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, rewritten, "utf8");
  fs.renameSync(tmp, file);
  return unread;
}

export function formatForClaude(records) {
  return records
    .map((r) => {
      const paths = r.paths && r.paths.length ? `\nFiles: ${r.paths.join(", ")}` : "";
      const sess = r.session ? `\n(pi session: ${r.session})` : "";
      return `[${r.kind}] ${r.text}${paths}${sess}`;
    })
    .join("\n---\n");
}

export function toPiFile(agentBus) {
  return path.join(agentBus, "to-pi.jsonl");
}

export function presenceDir(agentBus) {
  return path.join(agentBus, "presence");
}

// ---- Claude -> pi direction (prototype) ----
// Record: {id, ts, from, to, kind, text, deliveredTo: []}
// `to`: "*" broadcast, or exact match against any of the target instance's
// identifiers (session file path, session id, or cwd).

// appendToPi: legacy alias (to-pi.jsonl filename kept for compat with installed watchers).
export function appendToPi(agentBus, opts) {
  return appendToAgent(agentBus, opts);
}

export function appendToAgent(agentBus, { text, to = "*", kind = "brief", from = "claude", agent = null }) {
  ensureBusDir(agentBus);
  const record = {
    id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: new Date().toISOString(),
    from,
    agent,
    to: to || "*",
    kind,
    text: String(text ?? ""),
    deliveredTo: [],
  };
  fs.appendFileSync(toPiFile(agentBus), JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function readToPi(agentBus) {
  let raw;
  try {
    raw = fs.readFileSync(toPiFile(agentBus), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed, never fatal
    }
  }
  return out;
}

/**
 * Records awaiting delivery to an instance holding `myIds` (e.g.
 * [sessionFile, sessionId, cwd]). A record matches when to==="*" or to is
 * one of myIds, and none of myIds is in its deliveredTo list.
 */
export function pendingToPi(agentBus, myIds) {
  const ids = (Array.isArray(myIds) ? myIds : [myIds]).filter(Boolean);
  return readToPi(agentBus).filter(
    (r) =>
      r &&
      typeof r === "object" &&
      (r.to === "*" || ids.includes(r.to)) &&
      Array.isArray(r.deliveredTo) &&
      !r.deliveredTo.some((d) => ids.includes(d))
  );
}

/**
 * Claim a record for myId (marks delivered BEFORE acting, mirroring drain
 * semantics). Returns true when this call claimed it, false when already
 * claimed by me or the record is gone.
 */
export function claimToPi(agentBus, recordId, myId) {
  const file = toPiFile(agentBus);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  let claimed = false;
  const lines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id === recordId) {
        if (!Array.isArray(rec.deliveredTo)) rec.deliveredTo = [];
        if (!rec.deliveredTo.includes(myId)) {
          rec.deliveredTo.push(myId);
          claimed = true;
        }
      }
      lines.push(JSON.stringify(rec));
    } catch {
      // drop malformed on rewrite (consistent with drain)
    }
  }
  if (claimed) {
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
  return claimed;
}

// ---- Presence: which pi sessions are alive and paired ----

export function writePresence(agentBus, { sessionId, sessionFile: sf, cwd, name, agent = "pi" }) {
  if (!sessionId) return null;
  const dir = presenceDir(agentBus);
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    sessionId,
    agent,
    sessionFile: sf || null,
    cwd: cwd || null,
    name: name || null,
    pid: process.pid,
    ts: new Date().toISOString(),
  };
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
  fs.writeFileSync(path.join(dir, safe + ".json"), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

export function removePresence(agentBus, sessionId) {
  if (!sessionId) return;
  try {
    fs.unlinkSync(path.join(presenceDir(agentBus), String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_") + ".json"));
  } catch {}
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listPresence(agentBus) {
  let files;
  try {
    files = fs.readdirSync(presenceDir(agentBus));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(presenceDir(agentBus), f), "utf8"));
      rec.alive = pidAlive(rec.pid);
      out.push(rec);
    } catch {
      // skip malformed presence files
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

export function writeBusInfo(agentBus, { piCwd }) {
  ensureBusDir(agentBus);
  const info = {
    busPath: path.resolve(agentBus),
    piCwd: piCwd ? path.resolve(piCwd) : null,
    pid: process.pid,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(path.resolve(agentBus), ".bus-info.json"),
    JSON.stringify(info, null, 2) + "\n",
    "utf8"
  );
  return info;
}

export function readBusInfo(agentBus) {
  try {
    const raw = fs.readFileSync(path.join(agentBus, ".bus-info.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
