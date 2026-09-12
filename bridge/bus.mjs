// File message bus: $AGENT_BUS/to-claude.jsonl (PRD 6.3).
// Append-only JSONL. Single appendFileSync of one line <4KB is atomic
// enough on macOS. Larger lines: still written with a single append but
// documented as best-effort (see README limit note).

import fs from "node:fs";
import path from "node:path";
import { busFile } from "./env.mjs";

const VALID_KINDS = new Set(["result", "question", "warning", "fyi"]);
// `from` is open-ended (pi, pi-user, opencode, claude) — routed, not validated.

export function ensureBusDir(agentBus) {
  fs.mkdirSync(agentBus, { recursive: true });
  ensureBusIgnored(agentBus);
}

// Auto-ignore the bus dir in the enclosing git repo (if any), so runtime
// files (to-*.jsonl, presence, counters) never pollute git status. Idempotent,
// silent unless it writes. Only acts when the bus lives inside a repo.
export function ensureBusIgnored(agentBus) {
  const rel = repoRelative(agentBus);
  if (!rel) return false;
  const root = rel.root;
  const entry = rel.path.split(path.sep).join("/") + "/";
  const ignoreFile = path.join(root, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(ignoreFile, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") return false;
  }
  const norm = (l) => l.trim().replace(/^\//, "").replace(/\/$/, "");
  const want = norm(entry);
  const covered = existing.split("\n").some((l) => {
    const t = norm(l);
    return t === want || t === want + "/**" || want.startsWith(t.replace(/\/\*\*$/, "") + "/") && t.endsWith("/**");
  });
  if (covered) return false;
  const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
  const comment = "# agent switchboard bus (runtime, auto-added)\n";
  const hasComment = existing.includes("agent switchboard bus");
  try {
    fs.writeFileSync(ignoreFile, existing + prefix + (hasComment ? "" : comment) + entry + "\n", "utf8");
  } catch {
    return false;
  }
  return true;
}

// If dir lives inside a git repo, return {root, path} with path relative to
// root. Otherwise null. Pure fs walk (no git CLI needed).
export function repoRelative(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      fs.statSync(path.join(cur, ".git"));
      const rel = path.relative(cur, path.resolve(dir));
      if (!rel || rel.startsWith("..")) return null; // degenerate: bus at/above root
      return { root: cur, path: rel };
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function appendMessage(agentBus, { text, kind = "fyi", paths = [], from = "pi", session = null, ticket = null, agent = null }) {
  ensureBusDir(agentBus);
  if (!VALID_KINDS.has(kind)) kind = "fyi";
  const record = {
    ts: new Date().toISOString(),
    from,
    agent,
    kind,
    text: String(text ?? ""),
    session,
    ticket,
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

export function keepConsumed(env = process.env) {
  const n = parseInt(env.BUS_KEEP_CONSUMED || "200", 10);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

/**
 * Drain unread messages. Marks read:true BEFORE returning (crash-after-emit
 * must not replay forever). Compacts: drops consumed (read) records past a
 * watermark (BUS_KEEP_CONSUMED, default 200 kept as audit trail) so the file
 * can't grow forever. Early-exits without touching the file when nothing is
 * unread. Returns the unread records.
 */
export function drainUnread(agentBus, env = process.env, exclude = null) {
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
      if (rec && rec.read !== true && !(exclude && exclude(rec))) unread.push(rec);
    } catch {
      // skip malformed
    }
  }
  if (unread.length === 0) return [];
  // Mark read before emit.
  for (const rec of records) {
    if (rec && rec.read !== true) rec.read = true;
  }
  // Compact: keep all unread (just marked, none left) + newest consumed.
  const keep = keepConsumed(env);
  const consumed = records.filter((r) => r && r.read === true);
  const kept = consumed.slice(-keep);
  const keptSet = new Set(kept);
  const rewritten = records.filter((r) => r.read !== true || keptSet.has(r));
  const out = rewritten.map((r) => JSON.stringify(r)).join("\n") + (rewritten.length ? "\n" : "");
  // Best-effort atomic rewrite: write temp + rename.
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, out, "utf8");
  fs.renameSync(tmp, file);
  return unread;
}

export function formatForClaude(records) {
  return records
    .map((r) => {
      const paths = r.paths && r.paths.length ? `\nFiles: ${r.paths.join(", ")}` : "";
      const sess = r.session ? `\n(worker session: ${r.session})` : "";
      const ticket = r.ticket ? `\n(ticket: ${r.ticket})` : "";
      const from = r.from && r.from !== "pi" ? `\n(from: ${r.from})` : "";
      return `[${r.kind}] ${r.text}${paths}${sess}${ticket}${from}`;
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
  const recs = [];
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
      recs.push(rec);
    } catch {
      // drop malformed on rewrite (consistent with drain)
    }
  }
  if (claimed) {
    // Compact: drop consumed (delivered) records past the watermark, never
    // drop undelivered ones (a paired session may not have polled yet).
    const keep = keepConsumed();
    const live = new Set(recs.filter((r) => !r || !Array.isArray(r.deliveredTo) || r.deliveredTo.length === 0));
    const consumed = recs.filter((r) => r && Array.isArray(r.deliveredTo) && r.deliveredTo.length > 0);
    const kept = new Set(consumed.slice(-keep));
    const lines = recs.filter((r) => live.has(r) || kept.has(r)).map((r) => JSON.stringify(r));
    const tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
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
