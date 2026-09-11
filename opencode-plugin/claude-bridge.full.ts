// OpenCode plugin: makes an OpenCode session a full citizen of the agent
// message bus (Claude Code <-> pi <-> opencode mesh).
//
// Install (global):  cp claude-bridge.ts ~/.config/opencode/plugins/
// Install (project): cp claude-bridge.ts .opencode/plugins/
// Requires AGENT_BUS to match on all sides when directories differ.
//
// What it does:
// - Registers a `message_claude` tool (default route: to-claude.jsonl for
//   Claude Code; with `to`: to-pi.jsonl addressed at a running worker).
// - Heartbeats presence/<sessionID>.json (agent: "opencode") on
//   session.created, refreshes on session.idle, removes on session.deleted.
// - Watches to-pi.jsonl (dir watch + 2s poll) and injects matching records
//   into the target session via client.session.promptAsync, claiming
//   (deliveredTo) BEFORE injecting — same exactly-once semantics as pi.
//
// Status: written against @opencode-ai/plugin + SDK 1.18.30 types; load-
// checked (bun build) but NOT yet live-tested against a running OpenCode
// session. Mid-run injection robustness is unverified — treat as prototype.

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

function busDir(): string {
  return process.env.AGENT_BUS || join(process.cwd(), ".agentbus");
}

function safeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9_-]/g, "_");
}

function appendRecord(file: string, rec: Record<string, unknown>): void {
  mkdirSync(busDir(), { recursive: true });
  appendFileSync(join(busDir(), file), JSON.stringify(rec) + "\n", "utf8");
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

type ToPiRecord = { id: string; to: string; text: string; deliveredTo?: string[] };

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

// Known sessions in this server process (id -> {directory}).
const knownSessions = new Map<string, { directory: string }>();
// sessionID -> primary identity (we use the session id itself).
const claimedInMemory = new Set<string>();
let watcherStarted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

type Client = {
  session: {
    get(opts: { path: { id: string } }): Promise<{ data?: { id: string; directory: string } | null; error?: unknown }>;
    list(opts?: { query?: { directory?: string } }): Promise<{ data?: Array<{ id: string; directory: string }> | null; error?: unknown }>;
    promptAsync(opts: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<unknown>;
  };
};

function heartbeat(sessionID: string, directory: string): void {
  try {
    const dir = join(busDir(), "presence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, safeId(sessionID) + ".json"),
      JSON.stringify({ sessionId: sessionID, agent: "opencode", sessionFile: null, cwd: directory || null, name: "paired-mesh", pid: process.pid, ts: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
  } catch {}
}

function removeHeartbeat(sessionID: string): void {
  try {
    unlinkSync(join(busDir(), "presence", safeId(sessionID) + ".json"));
  } catch {}
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

async function pollForMessages(client: Client): Promise<void> {
  for (const rec of readToPi()) {
    if (!rec || !rec.id || claimedInMemory.has(rec.id)) continue;
    // Resolve target sessions: "*" matches all known; otherwise exact match
    // on session id or directory.
    const targets: string[] = [];
    for (const [sid, info] of knownSessions) {
      if (rec.to === "*" || rec.to === sid || (info.directory && rec.to === info.directory)) {
        const delivered = Array.isArray(rec.deliveredTo) ? rec.deliveredTo : [];
        if (!delivered.includes(sid)) targets.push(sid);
      }
    }
    if (!targets.length) continue;
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

function ensureWatcher(client: Client): void {
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
    pollTimer = setInterval(() => pollForMessages(client).catch(() => {}), 2000);
    if (typeof (pollTimer as unknown as { unref?: () => void }).unref === "function") {
      (pollTimer as unknown as { unref: () => void }).unref();
    }
  } catch {}
}

export const ClaudeBridge: Plugin = async ({ client, directory }) => {
  const c = client as unknown as Client;
  // Seed known sessions (server may already own some).
  try {
    const list = await c.session.list();
    for (const s of list.data || []) {
      if (s && s.id) knownSessions.set(s.id, { directory: s.directory || directory });
    }
  } catch {}
  ensureWatcher(c);

  return {
    tool: {
      message_claude: tool({
        description:
          "Send an async message via the shared agent message bus. Default route is the paired Claude Code session (reads when free). With `to` set to a worker session id/directory (or \"*\"), routes to a running paired worker instead. Always one-way and async: do NOT wait for a reply in the same turn.",
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
          const rec = {
            id: newId(),
            ts: new Date().toISOString(),
            from: "opencode",
            agent: "opencode",
            session: context.sessionID,
            ...(to === "claude"
              ? { kind, text: args.text + suffix, paths, read: false }
              : { to, kind, text: args.text + suffix, deliveredTo: [] as string[] }),
          };
          try {
            appendRecord(to === "claude" ? "to-claude.jsonl" : "to-pi.jsonl", rec);
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
        const sid = props.sessionID;
        let dir = directory;
        try {
          const s = await c.session.get({ path: { id: sid } });
          if (s.data && s.data.directory) dir = s.data.directory;
        } catch {}
        knownSessions.set(sid, { directory: dir });
        heartbeat(sid, dir);
        pollForMessages(c).catch(() => {});
      } else if (type === "session.idle" && props.sessionID) {
        const known = knownSessions.get(props.sessionID);
        heartbeat(props.sessionID, known?.directory || directory);
        pollForMessages(c).catch(() => {});
      } else if ((type === "session.deleted" || type === "session.error") && props.sessionID) {
        knownSessions.delete(props.sessionID);
        removeHeartbeat(props.sessionID);
      }
    },
  };
};
