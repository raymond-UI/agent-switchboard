import "./isolate.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const LAUNCHER = path.join(REPO, "bridge", "launcher.mjs");
const HOOK = path.join(REPO, "hooks", "pi-inbox.mjs");
const DISPATCH_HOOK = path.join(REPO, "hooks", "pi-dispatcher.mjs");
const STUB_OC = path.join(REPO, "test", "stub-oc-server.mjs");
const HTTP_PORT = 4621;
const OC_PORT = 4622;
const TOKEN = "test-token-123";

let httpSrv = null;
let ocStub = null;

async function waitFor(pat, proc, what, stream = "stderr") {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not start`)), 10000);
    proc[stream].on("data", (c) => {
      if (String(c).includes(pat)) { clearTimeout(t); resolve(); }
    });
  });
}

function api(p, { method = "GET", body, token = TOKEN } = {}) {
  return fetch(`http://127.0.0.1:${HTTP_PORT}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("http face (remote Claude)", () => {
  let bus;
  before(async () => {
    bus = fs.mkdtempSync(path.join(os.tmpdir(), "http-"));
    ocStub = spawn(process.execPath, [STUB_OC, String(OC_PORT)], {
      env: { ...process.env, STUB_OC_MODE: "happy" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor("stub-oc on", ocStub, "oc stub", "stdout");
    httpSrv = spawn(process.execPath, [LAUNCHER, "serve", "--port", String(HTTP_PORT)], {
      env: {
        ...process.env,
        AGENT_BUS: bus,
        PI_CWD: "/tmp",
        OC_BASE_URL: `http://127.0.0.1:${OC_PORT}`,
        OC_CWD: "/tmp",
        BRIDGE_WARMUP: "0",
        SWITCHBOARD_TOKEN: TOKEN,
        SWITCHBOARD_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor("http face on", httpSrv, "http face");
  });
  after(() => {
    if (httpSrv) httpSrv.kill("SIGKILL");
    if (ocStub) ocStub.kill("SIGKILL");
  });

  it("health is public, api requires the token", async () => {
    const h = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/health`)).json();
    assert.equal(h.healthy, true);
    const denied = await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" }, token: "wrong" });
    assert.equal(denied.status, 401);
    const denied2 = await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" }, token: null });
    assert.equal(denied2.status, 401);
  });

  it("JSON-RPC round-trips over POST /mcp", async () => {
    const init = await (await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).json();
    assert.equal(init.result.serverInfo.name, "switchboard");
    const list = await (await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 2, method: "tools/list" } })).json();
    assert.ok(list.result.tools.some((t) => t.name === "oc_ask"));
    const st = await (await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "oc_state", arguments: {} } } })).json();
    assert.ok(!st.result.isError);
    assert.match(st.result.content[0].text, /opencode/);
  });

  it("hook remote mode drains via POST /inbox", async () => {
    const { appendMessage } = await import("../bridge/bus.mjs");
    appendMessage(bus, { text: "hello remote claude", kind: "fyi", from: "pi" });
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: "remote-1" }),
      encoding: "utf8",
      env: { ...process.env, AGENT_BUS_REMOTE: `http://127.0.0.1:${HTTP_PORT}`, SWITCHBOARD_TOKEN: TOKEN },
    });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).reason, /hello remote claude/);
    // Second poll: nothing left (server marked read).
    const r2 = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: "remote-1" }),
      encoding: "utf8",
      env: { ...process.env, AGENT_BUS_REMOTE: `http://127.0.0.1:${HTTP_PORT}`, SWITCHBOARD_TOKEN: TOKEN },
    });
    assert.equal(r2.stdout.trim(), "");
  });

  it("hook remote mode fails open without a server", async () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: "remote-1" }),
      encoding: "utf8",
      env: { ...process.env, AGENT_BUS_REMOTE: "http://127.0.0.1:1", SWITCHBOARD_TOKEN: TOKEN },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  it("initialize tells remote Claude where the workers live", async () => {
    const init = await (await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 9, method: "initialize", params: {} } })).json();
    assert.match(init.result.instructions, /remote machine/);
    assert.match(init.result.instructions, /\/tmp/);
    const get = await api("/mcp");
    assert.equal(get.status, 405);
  });

  it("/info needs the token and reports worker dirs", async () => {
    assert.equal((await api("/info", { token: "wrong" })).status, 401);
    const info = await (await api("/info")).json();
    assert.equal(info.piCwd, "/tmp");
    assert.ok(info.host);
  });

  it("paired dispatcher hook POSTs /dispatch and the sidecar lands on the worker bus", async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "sbcfg-"));
    fs.writeFileSync(path.join(cfg, "remote.json"), JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}`, token: TOKEN }));
    const localBus = fs.mkdtempSync(path.join(os.tmpdir(), "localbus-"));
    const r = spawnSync(process.execPath, [DISPATCH_HOOK], {
      input: JSON.stringify({ session_id: "laptop-1", tool_name: "mcp__switchboard__pi_ask_async", tool_input: { message: "do x" } }),
      encoding: "utf8",
      env: { ...process.env, SWITCHBOARD_CONFIG_DIR: cfg, AGENT_BUS: localBus, AGENT_BUS_REMOTE: "", SWITCHBOARD_TOKEN: "" },
    });
    assert.equal(r.status, 0);
    const side = JSON.parse(fs.readFileSync(path.join(bus, "dispatcher-laptop-1.json"), "utf8"));
    assert.equal(side.sessionId, "laptop-1");
    assert.equal(side.tool, "pi_ask_async");
    assert.equal(side.expectedMessage, "do x");
    assert.deepEqual(fs.readdirSync(localBus), []);
  });

  it("paired Stop hook drains remotely with no env (reads remote.json)", async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "sbcfg-"));
    fs.writeFileSync(path.join(cfg, "remote.json"), JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}`, token: TOKEN }));
    const { appendMessage } = await import("../bridge/bus.mjs");
    appendMessage(bus, { text: "paired hello", kind: "fyi", from: "pi" });
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: "remote-2" }),
      encoding: "utf8",
      env: { ...process.env, SWITCHBOARD_CONFIG_DIR: cfg, AGENT_BUS_REMOTE: "", SWITCHBOARD_TOKEN: "" },
    });
    assert.match(JSON.parse(r.stdout).reason, /paired hello/);
  });

  it("a malformed request gets 400 and the server stays up", async () => {
    const net = await import("node:net");
    const reply = await new Promise((resolve) => {
      const s = net.connect(HTTP_PORT, "127.0.0.1", () => s.end("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      let buf = "";
      s.on("data", (c) => (buf += c));
      s.on("close", () => resolve(buf));
      s.on("error", () => resolve(buf));
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.equal((await api("/health", { token: null })).status, 200);
  });

  it("phone UI page is public; overview needs the token and never marks read", async () => {
    const page = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(await page.text(), /Switchboard/);
    assert.equal((await api("/api/overview", { token: null })).status, 401);
    const { appendMessage, readUnread } = await import("../bridge/bus.mjs");
    appendMessage(bus, { text: "phone sees this", kind: "fyi", from: "pi" });
    const o = await (await api("/api/overview")).json();
    assert.equal(o.piCwd, "/tmp");
    assert.ok(Array.isArray(o.tickets));
    assert.equal(o.feed[0].text, "phone sees this");
    assert.ok(readUnread(bus).some((r) => r.text === "phone sees this"));
  });
});
