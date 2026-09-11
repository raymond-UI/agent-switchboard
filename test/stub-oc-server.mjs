// Stub OpenCode server for tests: minimal HTTP surface the bridge needs.
// STUB_OC_MODE=happy | hang | tooluse. Usage: node stub-oc-server.mjs <port>
import http from "node:http";

const MODE = process.env.STUB_OC_MODE || "happy";
const PORT = parseInt(process.argv[2] || "4599", 10);

let seq = 0;
const sessions = new Map(); // id -> {id, directory, messages: [], run: null}
const sseClients = new Set();

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function broadcastIdle(sid) {
  const line = `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: sid } })}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
}

function completeRun(sid, aborted = false) {
  const s = sessions.get(sid);
  if (!s || !s.run) return;
  s.run = null;
  const text = aborted ? "(aborted)" : s.pendingText;
  const parts = [{ id: `p${++seq}`, sessionID: sid, messageID: `m${seq}`, type: "text", text }];
  if (MODE === "tooluse" && !aborted) {
    parts.push({ id: `p${++seq}`, sessionID: sid, messageID: `m${seq}`, type: "tool", callID: "c1", tool: "read", state: { status: "completed" } });
  }
  s.messages.push({ info: { id: `m${seq}`, role: "assistant", sessionID: sid }, parts });
  broadcastIdle(sid);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
    const json = body ? JSON.parse(body) : {};

    if (path === "/global/health") return sendJson(res, { healthy: true, version: "stub" });
    if (path === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      // NOTE: req 'close' fires as soon as the (bodiless) GET request is
      // received — NOT on disconnect. Track the response instead.
      res.on("close", () => sseClients.delete(res));
      return;
    }
    if (path === "/session" && req.method === "POST") {
      const id = `ses_stub${++seq}`;
      sessions.set(id, { id, directory: json.directory || "/tmp", messages: [], run: null, pendingText: null });
      return sendJson(res, { data: { id, directory: json.directory || "/tmp", tokens: { input: 0, output: 0 }, cost: 0, title: "stub" } });
    }
    const m = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (!m) return sendJson(res, { error: "not found" }, 404);
    const [, sid, rest] = m;
    const s = sessions.get(sid);
    if (!s) return sendJson(res, { error: "no session" }, 404);

    if ((rest === "" || rest === undefined) && req.method === "GET") {
      return sendJson(res, { data: { id: sid, directory: s.directory, tokens: { input: 10, output: 5 }, cost: 0.001, title: "stub" } });
    }
    if (rest === "" && req.method === "DELETE") {
      sessions.delete(sid);
      return sendJson(res, { data: true });
    }
    if (rest === "/abort" && req.method === "POST") {
      if (s.run) setTimeout(() => completeRun(sid, true), 20);
      else broadcastIdle(sid);
      return sendJson(res, { data: true });
    }
    if ((rest === "/prompt_async" || rest === "/message") && req.method === "POST") {
      const text = (json.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n") || "(empty)";
      s.pendingText = `stub-oc answer to: ${text}`;
      s.run = { started: Date.now() };
      if (MODE !== "hang") setTimeout(() => completeRun(sid), 250);
      return sendJson(res, { data: { id: `msg${++seq}` } });
    }
    if (rest === "/message" && req.method === "GET") {
      return sendJson(res, { data: s.messages });
    }
    return sendJson(res, { error: "not found" }, 404);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-oc on ${PORT} mode=${MODE}`);
});
