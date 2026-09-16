// Bisect step 2: heartbeat + message_claude tool. Still NO client calls at
// init, NO watchers, NO timers. Full version kept in claude-bridge.full.ts.

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { spawnSync } from "node:child_process";

function multiOrchEnabled(): boolean {
  return ["1", "true", "yes"].includes(String(process.env.SWITCHBOARD_MULTI_ORCH || "").toLowerCase());
}
function depthRefusal(): string | null {
  const d = parseInt(process.env.SWITCHBOARD_DEPTH || "0", 10);
  const m = parseInt(process.env.SWITCHBOARD_MAX_DEPTH || "2", 10);
  const dd = Number.isFinite(d) && d >= 0 ? d : 0;
  const mm = Number.isFinite(m) && m >= 1 ? m : 2;
  return dd < mm ? null : `delegation depth ${dd} at cap (max ${mm}); refusing to avoid an orchestration loop`;
}

function busDir(): string {
  return process.env.AGENT_BUS || join(process.cwd(), ".agentbus");
}

function ensureBusIgnored(): void {
  const bus = resolve(busDir());
  let cur = bus;
  for (;;) {
    try {
      statSync(join(cur, ".git"));
      const rel = relative(cur, bus).split(sep).join("/");
      if (!rel || rel.startsWith("..")) return;
      const entry = rel + "/";
      const file = join(cur, ".gitignore");
      let existing = "";
      try {
        existing = readFileSync(file, "utf8");
      } catch {}
      const norm = (l: string) => l.trim().replace(/^\//, "").replace(/\/$/, "");
      if (existing.split("\n").some((l) => norm(l) === norm(entry))) return;
      writeFileSync(file, existing + (existing.length && !existing.endsWith("\n") ? "\n" : "") + entry + "\n", "utf8");
      return;
    } catch {}
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

function isClaudeSession(to: string): boolean {
  try {
    const files = readdirSync(join(busDir(), "presence"));
    const safe = to.replace(/[^A-Za-z0-9_-]/g, "_");
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(busDir(), "presence", f), "utf8"));
        if (rec && rec.agent === "claude" && (rec.sessionId === to || f === `claude-${safe}.json`)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

function heartbeat(sessionID: string, directory: string): void {
  try {
    ensureBusIgnored();
    const dir = join(busDir(), "presence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, String(sessionID).replace(/[^A-Za-z0-9_-]/g, "_") + ".json"),
      JSON.stringify({ sessionId: sessionID, agent: "opencode-min", sessionFile: null, cwd: directory || null, name: "paired-mesh", pid: process.pid, ts: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
  } catch {}
}

function removeHeartbeat(sessionID: string): void {
  try {
    unlinkSync(join(busDir(), "presence", String(sessionID).replace(/[^A-Za-z0-9_-]/g, "_") + ".json"));
  } catch {}
}

// Watcher: delivers to-pi.jsonl records into matching sessions. Started
// LAZILY on first session.created (never at init — init stays side-effect
// free). Injection via promptAsync (returns immediately, no turn-wait).
type ToPiRecord = { id: string; to: string; text: string; ts?: string; deliveredTo?: string[] };
// startedTs gates delivery: no stale backlog into sessions (see bus.mjs).
const knownSessions = new Map<string, { directory: string; startedTs: number }>();
const claimedInMemory = new Set<string>();
let watcherStarted = false;

type SdkClient = {
  session: {
    list(opts?: unknown): Promise<{ data?: Array<{ id: string; directory: string }> | null; error?: unknown }>;
    promptAsync(opts: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<unknown>;
  };
};

function readToPi(): ToPiRecord[] {
  try {
    const raw = readFileSync(join(busDir(), "to-pi.jsonl"), "utf8");
    const out: ToPiRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function claim(recordId: string, myId: string): boolean {
  const file = join(busDir(), "to-pi.jsonl");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let claimed = false;
  const lines: string[] = [];
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
    } catch {}
  }
  if (claimed) {
    const tmp = file + ".tmp." + process.pid;
    writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    renameSync(tmp, file);
  }
  return claimed;
}

async function pollForMessages(client: SdkClient): Promise<void> {
  for (const rec of readToPi()) {
    if (!rec || !rec.id) continue;
    const targets: string[] = [];
    for (const [sid, info] of knownSessions) {
      // Only the session id is exact; directory is shared project-wide.
      const addressed = rec.to === sid;
      const mine = rec.to === "*" || !rec.to || addressed || (!!info.directory && rec.to === info.directory);
      if (!mine) continue;
      if (!addressed && info.startedTs) {
        const ts = Date.parse(rec.ts);
        if (Number.isFinite(ts) && ts < info.startedTs - 60000) continue;
      }
      const delivered = Array.isArray(rec.deliveredTo) ? rec.deliveredTo : [];
      if (!delivered.includes(sid) && !claimedInMemory.has(rec.id + ":" + sid)) targets.push(sid);
    }
    for (const sid of targets) {
      if (!claim(rec.id, sid)) continue;
      claimedInMemory.add(rec.id + ":" + sid);
      try {
        await client.session.promptAsync({
          path: { id: sid },
          body: { parts: [{ type: "text", text: `Message from the agent mesh:\n\n${rec.text}` }] },
        });
      } catch {}
    }
  }
}

function ensureWatcher(client: SdkClient): void {
  if (watcherStarted) return;
  watcherStarted = true;
  try {
    if (existsSync(busDir())) {
      watch(busDir(), (_ev, name) => {
        if (typeof name === "string" && !name.endsWith("to-pi.jsonl")) return;
        pollForMessages(client).catch(() => {});
      });
    }
  } catch {}
  try {
    const t = setInterval(() => pollForMessages(client).catch(() => {}), 2000);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      (t as unknown as { unref: () => void }).unref();
    }
  } catch {}
}

export const ClaudeBridgeMinimal: Plugin = async ({ client, directory }) => {
  const c = client as unknown as SdkClient;
  return {
    tool: {
      ...(multiOrchEnabled()
        ? {
            delegate_claude: tool({
              description:
                "Blocking delegate to Claude Code headless (`claude -p`). Self-contained message, absolute paths. Honors delegation depth cap.",
              args: {
                message: tool.schema.string().describe("Self-contained task for Claude"),
              },
              async execute(args) {
                const refusal = depthRefusal();
                if (refusal) return refusal;
                const dd = parseInt(process.env.SWITCHBOARD_DEPTH || "0", 10);
                try {
                  const r = spawnSync("claude", ["-p", "--output-format", "text", args.message], {
                    encoding: "utf8",
                    timeout: 600000,
                    maxBuffer: 4 * 1024 * 1024,
                    env: { ...process.env, SWITCHBOARD_DEPTH: String((Number.isFinite(dd) && dd >= 0 ? dd : 0) + 1) },
                  });
                  if (r.error) throw r.error;
                  if (r.status !== 0) throw new Error(`claude exited ${r.status}`);
                  const out = String(r.stdout || "(empty)");
                  return out.length <= 8000 ? out : out.slice(0, 8000) + "\n\n[... truncated]";
                } catch (err) {
                  return `delegate_claude failed: ${(err as Error).message}`;
                }
              },
            }),
          }
        : {}),
      message_claude: tool({
        description:
          "Send an async message via the shared agent message bus. Default route is the paired Claude Code session (reads when free). With `to` set to a Claude session id (from presence) or a worker session id/directory (or \"*\"), routes there instead. If an incoming message names a reply-to session id, answer THAT session with `to` set. Always one-way and async: do NOT wait for a reply in the same turn.",
        args: {
          text: tool.schema.string().describe("Message text (result, question, warning, or update)"),
          kind: tool.schema.enum(["result", "question", "warning", "fyi"]).optional().describe("Message kind"),
          paths: tool.schema.array(tool.schema.string()).optional().describe("Absolute file paths touched"),
          to: tool.schema.string().optional().describe('Route: omit for Claude Code; or a worker session id/directory/"*"'),
        },
        async execute(args, context) {
          const kind = args.kind || "fyi";
          const paths = args.paths || [];
          const suffix = paths.length ? `\nFiles: ${paths.join(", ")}` : "";
          const to = args.to || "claude";
          const dir = busDir();
          try {
            mkdirSync(dir, { recursive: true });
            if (to === "claude" || isClaudeSession(to)) {
              const addressed = to === "claude" ? {} : { to };
              appendFileSync(join(dir, "to-claude.jsonl"), JSON.stringify({ ts: new Date().toISOString(), from: "opencode", agent: "opencode", kind, text: args.text + suffix, session: context.sessionID, paths, read: false, ...addressed }) + "\n", "utf8");
            } else {
              appendFileSync(join(dir, "to-pi.jsonl"), JSON.stringify({ id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, ts: new Date().toISOString(), from: "opencode", agent: "opencode", to, kind, text: args.text + suffix, deliveredTo: [] }) + "\n", "utf8");
            }
          } catch (err) {
            return `Failed to queue message: ${(err as Error).message}`;
          }
          return to === "claude"
            ? `Queued for Claude (async, kind=${kind}). Do not wait for a reply; keep working.`
            : `Queued for worker ${to} (async). Do not wait for a reply; keep working.`;
        },
      }),
    },
    event: async ({ event }) => {
      const type = (event as { type?: string }).type || "";
      const props = (event as { properties?: Record<string, string> }).properties || {};
      if (type === "session.created" && props.sessionID) {
        knownSessions.set(props.sessionID, { directory, startedTs: Date.now() });
        heartbeat(props.sessionID, directory);
        ensureWatcher(c);
        // Lazy seed: sessions predating plugin load. Fire-and-forget,
        // never at init.
        c.session.list().then((list) => {
          for (const s of list.data || []) {
            if (s && s.id && !knownSessions.has(s.id)) {
              // Predates us: gate delivery as stale (startedTs = now).
              knownSessions.set(s.id, { directory: s.directory || directory, startedTs: Date.now() });
            }
          }
          pollForMessages(c).catch(() => {});
        }).catch(() => {});
        pollForMessages(c).catch(() => {});
      } else if (type === "session.idle" && props.sessionID) {
        heartbeat(props.sessionID, directory);
        pollForMessages(c).catch(() => {});
      } else if ((type === "session.deleted" || type === "session.error") && props.sessionID) {
        knownSessions.delete(props.sessionID);
        removeHeartbeat(props.sessionID);
      }
    },
  };
};
