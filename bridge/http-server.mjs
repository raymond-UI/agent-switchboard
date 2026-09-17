#!/usr/bin/env node
// Switchboard HTTP face (network vision, phase 1): serves the SAME app over
// Streamable-HTTP-style JSON-RPC plus a hook-drain endpoint, so a Claude on
// another LAN machine can drive local workers. Single-machine stdio stays
// the default; this is opt-in: `node bridge/launcher.mjs serve --port 4598`.
// Auth: SWITCHBOARD_TOKEN env -> required `Authorization: Bearer` (fail
// closed when set). Bind: SWITCHBOARD_HOST (default 127.0.0.1).

import http from "node:http";
import { config, pi, oc, log, handleRequest, stopWorkers } from "./app.mjs";
import { decideInbox } from "./hook-core.mjs";

const token = process.env.SWITCHBOARD_TOKEN || null;
const host = process.env.SWITCHBOARD_HOST || "127.0.0.1";
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

function authorized(req) {
  if (!token) return true; // localhost default; set a token for LAN use
  const h = req.headers.authorization || "";
  return h === `Bearer ${token}`;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const sendJson = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(200, { healthy: true, name: "switchboard", version: "0.1.0" });
  }

  if (!authorized(req)) {
    return sendJson(401, { error: "unauthorized: set Authorization: Bearer $SWITCHBOARD_TOKEN" });
  }

  if (url.pathname === "/mcp" && req.method === "POST") {
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return sendJson(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    try {
      // Single or batch (array) JSON-RPC, mirroring the stdio surface.
      const collect = [];
      const send = (obj) => collect.push(obj);
      if (Array.isArray(msg)) {
        for (const m of msg) await handleRequest(m, send);
        return sendJson(200, collect);
      }
      await handleRequest(msg, send);
      if (!collect.length) return sendJson(202, {});
      return sendJson(200, collect[0]);
    } catch (err) {
      return sendJson(500, { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: String(err.message || err) } });
    }
  }

  if (url.pathname === "/inbox" && (req.method === "POST" || req.method === "GET")) {
    let sessionId = url.searchParams.get("session");
    if (req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        sessionId = body.session_id || body.sessionId || sessionId;
      } catch {}
    }
    try {
      const ans = decideInbox(config.agentBus, { session_id: sessionId }, {
        maxConsecutiveBlocks: config.maxConsecutiveBlocks,
      });
      return sendJson(200, ans.type === "block" ? { type: "block", reason: ans.reason } : { type: "silent" });
    } catch (err) {
      return sendJson(200, { type: "silent" }); // fail-open, like the hook
    }
  }

  return sendJson(404, { error: "unknown route (POST /mcp, POST|GET /inbox, GET /health)" });
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
