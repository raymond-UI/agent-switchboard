#!/usr/bin/env node
// Switchboard HTTP face (network vision, phase 1): serves the SAME app over
// Streamable-HTTP-style JSON-RPC plus a hook-drain endpoint, so a Claude on
// another LAN machine can drive local workers. Single-machine stdio stays
// the default; this is opt-in: `node bridge/launcher.mjs serve --port 4598`.
// Auth: SWITCHBOARD_TOKEN env, else the paired worker.json token ->
// required `Authorization: Bearer`. Bind: SWITCHBOARD_HOST (default
// 127.0.0.1); a non-loopback bind without a token refuses to start.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { config, oc, tickets, log, handleRequest, stopWorkers, setInstructions } from "./app.mjs";
import { readAll } from "./bus.mjs";
import { decideInbox } from "./hook-core.mjs";
import { loadWorker, firstSet } from "./remote.mjs";

const token = process.env.SWITCHBOARD_TOKEN || loadWorker()?.token || null;
let host = process.env.SWITCHBOARD_HOST || "127.0.0.1";
let port = parseInt(process.env.SWITCHBOARD_PORT || "4598", 10);
// Accept both `node http-server.mjs --port 1` and `node launcher.mjs serve --port 1`.
const argv = process.argv.slice(2).filter((a) => !["serve", "mcp", "hook"].includes(a));
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const pm = a.match(/^--port=(\d+)$/);
  if (a === "--port" && /^\d+$/.test(argv[i + 1] || "")) port = parseInt(argv[++i], 10);
  else if (pm) port = parseInt(pm[1], 10);
  const hm = a.match(/^--host=([\w.\-]+)$/);
  if (a === "--host" && argv[i + 1]) host = argv[++i];
  else if (hm) host = hm[1];
}

if (!token && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  log(`[switchboard] refusing to bind ${host} without a token: run switchboard-pair (or set SWITCHBOARD_TOKEN)`);
  process.exit(2);
}

// Remote Claude sees its own disk, not this one. Say so in the MCP
// handshake so paths in instructions target the worker machine.
const hostname = os.hostname();
setInstructions(
  `Workers run on remote machine "${hostname}", not on your machine. ` +
  `Files you edit locally are invisible to them. Use absolute paths on ${hostname}: ` +
  `pi cwd ${config.piCwd}, OpenCode cwd ${oc.ocCwd}.`
);

function safeId(s) {
  return String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200) || "unknown";
}

function authorized(req) {
  if (!token) return true; // localhost default; set a token for LAN use
  // Constant-time compare: response timing mustn't reveal a token prefix.
  const got = Buffer.from(String(req.headers.authorization));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

// Phone UI: one static page; it holds no secrets (token lives in the
// phone's localStorage and rides as a Bearer header like every client).
const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

// CSP: only the page's own inline script (pinned by hash, so injected
// markup can't run code), API calls to this origin only, and no framing
// (another site can't overlay the logged-in page to steal taps).
function uiPolicy(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const hash = createHash("sha256").update(script).digest("base64");
  return `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function serveUi(req, res) {
  let html;
  try { html = fs.readFileSync(UI_FILE, "utf8"); } catch { return sendJson(res, 500, { error: "ui.html missing" }); }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": uiPolicy(html),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// Single or batch (array) JSON-RPC, mirroring the stdio surface.
async function runRpc(msg) {
  const collect = [];
  for (const m of [msg].flat()) await handleRequest(m, (obj) => collect.push(obj));
  if (Array.isArray(msg)) return [200, collect];
  return collect.length ? [200, collect[0]] : [202, {}];
}

async function handleMcp(req, res) {
  const msg = await readJson(req).catch(() => undefined);
  if (msg === undefined) return sendJson(res, 400, rpcError(null, -32700, "parse error"));
  try {
    const [code, body] = await runRpc(msg);
    return sendJson(res, code, body);
  } catch (err) {
    return sendJson(res, 500, rpcError(Object(msg).id ?? null, -32603, String(err.message)));
  }
}

async function inboxSession(req, url) {
  const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
  return firstSet(body.session_id, body.sessionId, url.searchParams.get("session"));
}

async function handleInbox(req, res, url) {
  const sessionId = await inboxSession(req, url);
  try {
    const ans = decideInbox(config.agentBus, { session_id: sessionId }, { maxConsecutiveBlocks: config.maxConsecutiveBlocks });
    return sendJson(res, 200, ans.type === "block" ? { type: "block", reason: ans.reason } : { type: "silent" });
  } catch {
    return sendJson(res, 200, { type: "silent" }); // fail-open, like the hook
  }
}

// Remote PreToolUse dispatcher hook: same sidecar the local hook writes,
// just delivered over HTTP so async results route back across machines.
const validDispatch = (rec) => Boolean(rec.sessionId) && /^(pi|oc)_ask_async$/.test(String(rec.tool));

async function handleDispatch(req, res) {
  try {
    const rec = Object(await readJson(req));
    if (!validDispatch(rec)) return sendJson(res, 400, { error: "need sessionId + tool" });
    fs.mkdirSync(config.agentBus, { recursive: true });
    const out = { ...rec, ts: new Date().toISOString(), via: "http" };
    fs.writeFileSync(path.join(config.agentBus, `dispatcher-${safeId(rec.sessionId)}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message) });
  }
}

// Phone UI snapshot. Read-only on the bus: never marks records read, so the
// coordinator's Claude still receives everything the phone has seen.
function handleOverview(req, res) {
  const list = [...tickets.entries()].map(([id, t]) => ({ id, agent: t.agent, status: t.status, startedTs: t.startedTs, message: t.message }));
  const feed = readAll(config.agentBus).slice(-60).reverse().map((r) => ({
    ts: r.ts, from: r.from, agent: r.agent, kind: r.kind, ticket: r.ticket, text: String(r.text ?? "").slice(0, 20000),
  }));
  return sendJson(res, 200, { host: hostname, piCwd: config.piCwd, ocCwd: oc.ocCwd, tickets: list.reverse(), feed });
}

function handleInfo(req, res) {
  return sendJson(res, 200, { host: hostname, piCwd: config.piCwd, ocCwd: oc.ocCwd, agentBus: config.agentBus });
}

// Streamable HTTP: no server-initiated SSE stream; 405 tells clients so.
function mcpGet(req, res) {
  res.writeHead(405, { Allow: "POST" });
  res.end();
}

const PUBLIC = {
  "GET /": serveUi,
  "GET /health": (req, res) => sendJson(res, 200, { healthy: true, name: "switchboard", version: "0.1.0" }),
};
const PRIVATE = {
  "GET /info": handleInfo,
  "GET /api/overview": handleOverview,
  "POST /dispatch": handleDispatch,
  "GET /mcp": mcpGet,
  "POST /mcp": handleMcp,
  "GET /inbox": handleInbox,
  "POST /inbox": handleInbox,
};

async function route(req, res, url) {
  const key = `${req.method} ${url.pathname}`;
  if (PUBLIC[key]) return PUBLIC[key](req, res, url);
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized: set Authorization: Bearer $SWITCHBOARD_TOKEN" });
  if (PRIVATE[key]) return PRIVATE[key](req, res, url);
  return sendJson(res, 404, { error: "unknown route (GET /, POST /mcp, POST|GET /inbox, POST /dispatch, GET /info, GET /api/overview, GET /health)" });
}

// One bad request (unparseable URL, a throwing handler) must never take the
// worker down: it's reachable on the network before any auth check.
function fail(res, code, err) {
  log(`[switchboard] ${code}: ${err.message}`);
  if (!res.headersSent) sendJson(res, code, { error: code === 400 ? "bad request" : "internal error" });
  else res.end();
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (err) { return fail(res, 400, err); }
  try { await route(req, res, url); } catch (err) { fail(res, 500, err); }
});

server.listen(port, host, () => {
  log(`[switchboard] http face on http://${host}:${port} (token ${token ? "required" : "OFF — localhost only"})`);
});

async function shutdown(signal) {
  log(`[switchboard] ${signal}, stopping...`);
  await new Promise((r) => server.close(r));
  await stopWorkers();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
