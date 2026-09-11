// pi extension: lets pi push async messages back to Claude via the file bus.
// Install: copy to ~/.pi/agent/extensions/claude-bridge.ts (or .pi/extensions/).
// (PRD 6.4)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

function busDir(): string {
  return (
    process.env.AGENT_BUS ||
    join(process.env.PI_CWD || process.cwd(), ".agentbus")
  );
}

function appendToBus(text: string, kind: string, paths: string[]) {
  const dir = busDir();
  mkdirSync(dir, { recursive: true });
  const session = process.env.PI_SESSION_FILE || null;
  const record = {
    ts: new Date().toISOString(),
    from: "pi",
    kind,
    text,
    session,
    paths: Array.isArray(paths) ? paths : [],
    read: false,
  };
  appendFileSync(join(dir, "to-claude.jsonl"), JSON.stringify(record) + "\n", "utf8");
}

const MessageClaudeParams = Type.Object({
  text: Type.String({ description: "Message text (result, question, warning, or update)" }),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("result"),
      Type.Literal("question"),
      Type.Literal("warning"),
      Type.Literal("fyi"),
    ])
  ),
  paths: Type.Optional(Type.Array(Type.String())),
  to: Type.Optional(
    Type.String({
      description:
        'Route: omit (or "claude") for Claude Code via to-claude.jsonl; or a session id, session file, cwd, or "*" to message a running paired worker (pi or opencode) via to-pi.jsonl.',
    })
  ),
});

function appendToPiBus(text: string, kind: string, to: string) {
  const dir = busDir();
  mkdirSync(dir, { recursive: true });
  const record = {
    id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: new Date().toISOString(),
    from: "pi",
    agent: "pi",
    to: to || "*",
    kind,
    text,
    deliveredTo: [],
  };
  appendFileSync(join(dir, "to-pi.jsonl"), JSON.stringify(record) + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "message_claude",
    label: "Message Claude",
    description:
      "Send an async message via the shared message bus. Default route is the paired Claude Code session (reads when free). With `to` set to a worker session id/file/cwd (or \"*\"), routes to a running paired worker instead. Delivery is always one-way and asynchronous: do NOT wait for a reply in the same turn; continue your work.",
    promptSnippet: "message_claude(text, kind, paths, to?): push a message to Claude Code, or with `to`, to a running worker.",
    promptGuidelines: [
      "Use message_claude when you finish a delegated task, hit a blocker, need a decision, or spot a file conflict.",
      "Keep messages short; include absolute file paths you touched in 'paths'.",
      "Use message_claude with `to` to reach a running paired worker (see presence via Claude) instead of Claude.",
    ],
    parameters: MessageClaudeParams,
    async execute(_toolCallId, params) {
      const text = (params as { text: string }).text;
      const kind = (params as { kind?: string }).kind || "fyi";
      const paths = (params as { paths?: string[] }).paths || [];
      const to = (params as { to?: string }).to || "claude";
      try {
        if (to === "claude") appendToBus(text, kind, paths);
        else appendToPiBus(paths.length ? `${text}\nFiles: ${paths.join(", ")}` : text, kind, to);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to queue message: ${(err as Error).message}` }],
          details: {},
        };
      }
      const where = to === "claude" ? "Claude (via pi_inbox/Stop-hook)" : `worker ${to} (via bus poll)`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Queued for ${where} (async, kind=${kind}). Do not wait for a reply; keep working.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerCommand("tell-claude", {
    description: "Push a message to Claude Code via the bus",
    handler: async (args, ctx) => {
      const text = String(args || "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /tell-claude <message>", "warning");
        return;
      }
      try {
        appendToBus(text, "fyi", []);
        ctx.ui.notify("Message queued for Claude.", "info");
      } catch (err) {
        ctx.ui.notify(`Bus write failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // ---- Claude -> pi direction (prototype): poll + watcher on to-pi.jsonl.
  // Identity = session file + session id + cwd; a record is mine when its
  // `to` is "*" or one of my ids. Claim (mark delivered) BEFORE injecting,
  // mirroring the bridge's drain semantics.
  let watcher: { close(): void } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let myIds: string[] = [];
  let myPrimaryId = "";
  let mySessionId = "";
  const seenInMemory = new Set<string>();

  function myIdentity(ctx: { cwd: string; sessionManager: { getSessionFile(): string | null; getSessionId(): string } }): string[] {
    const ids: string[] = [];
    try {
      const f = ctx.sessionManager.getSessionFile();
      if (f) ids.push(f);
    } catch {}
    try {
      const s = ctx.sessionManager.getSessionId();
      if (s) ids.push(s);
    } catch {}
    if (ctx.cwd) ids.push(ctx.cwd);
    return ids;
  }

  function readToPi(): Array<{ id: string; to: string; text: string; deliveredTo?: string[] }> {
    try {
      const raw = readFileSync(join(busDir(), "to-pi.jsonl"), "utf8");
      const out: Array<{ id: string; to: string; text: string; deliveredTo?: string[] }> = [];
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

  function claim(recordId: string): boolean {
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
          if (!rec.deliveredTo.includes(myPrimaryId)) {
            rec.deliveredTo.push(myPrimaryId);
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

  function pollForClaude() {
    if (!myPrimaryId) return;
    for (const rec of readToPi()) {
      if (!rec || !rec.id || seenInMemory.has(rec.id)) continue;
      const mine = rec.to === "*" || myIds.includes(rec.to);
      if (!mine) continue;
      if (Array.isArray(rec.deliveredTo) && rec.deliveredTo.some((d) => myIds.includes(d))) {
        seenInMemory.add(rec.id);
        continue;
      }
      if (!claim(rec.id)) {
        seenInMemory.add(rec.id);
        continue;
      }
      seenInMemory.add(rec.id);
      try {
        pi.sendMessage(
          {
            customType: "claude-message",
            content: `Message from Claude Code:\n\n${rec.text}`,
            display: true,
          },
          { triggerTurn: true }
        );
      } catch {}
    }
  }

  function heartbeat() {
    if (!mySessionId) return;
    try {
      const dir = join(busDir(), "presence");
      mkdirSync(dir, { recursive: true });
      const rec = {
        sessionId: mySessionId,
        agent: "pi",
        sessionFile: myIds[0] || null,
        cwd: myIds[myIds.length - 1] || null,
        name: "paired-with-claude-code",
        pid: process.pid,
        ts: new Date().toISOString(),
      };
      writeFileSync(join(dir, mySessionId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"), JSON.stringify(rec, null, 2) + "\n", "utf8");
    } catch {}
  }

  function removeHeartbeat() {
    if (!mySessionId) return;
    try {
      unlinkSync(join(busDir(), "presence", mySessionId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"));
    } catch {}
  }

  // Background resources start here, never in the factory (per pi docs).
  pi.on("session_start", async (_event, ctx) => {
    try {
      mkdirSync(busDir(), { recursive: true });
    } catch {}
    ctx.ui.setStatus("claude-bridge", "paired with Claude Code");
    myIds = myIdentity(ctx as unknown as { cwd: string; sessionManager: { getSessionFile(): string | null; getSessionId(): string } });
    myPrimaryId = myIds[0] || "";
    try {
      mySessionId = ctx.sessionManager.getSessionId() || "";
    } catch {
      mySessionId = "";
    }
    heartbeat();
    // Watch the DIRECTORY (claim rewrites replace the file via rename,
    // which would detach a file watcher). Plus polling fallback.
    try {
      if (existsSync(busDir())) {
        watcher = watch(busDir(), (ev, name) => {
          if (typeof name === "string" && !name.endsWith("to-pi.jsonl")) return;
          pollForClaude();
        });
      }
    } catch {}
    try {
      pollTimer = setInterval(pollForClaude, 2000);
    } catch {}
    pollForClaude();
  });

  pi.on("agent_settled", async (_event, _ctx) => {
    heartbeat();
    pollForClaude();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setStatus("claude-bridge", undefined);
    } catch {}
    try {
      watcher?.close();
    } catch {}
    watcher = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    removeHeartbeat();
    myIds = [];
    myPrimaryId = "";
    mySessionId = "";
  });
}
