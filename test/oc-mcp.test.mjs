import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "bridge", "mcp-server.mjs");
const STUB_PI = path.join(HERE, "stub-pi.mjs");
const STUB_OC = path.join(HERE, "stub-oc-server.mjs");
const OC_PORT = 4615;

let ocStub = null;

function startServer(env) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BRIDGE_WARMUP: "0",
      STUB_MODE: "happy",
      PI_BIN: process.execPath,
      PI_EXTRA_ARGS: STUB_PI,
      PI_CWD: "/tmp",
      OC_BASE_URL: `http://127.0.0.1:${OC_PORT}`,
      OC_CWD: "/tmp",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function rpc(proc, obj, id) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { proc.stdout.off("data", onData); reject(new Error("rpc timeout")); }, 20000);
    if (typeof timer.unref === "function") timer.unref();
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...obj }) + "\n");
  });
}

describe("mcp server: opencode tools", () => {
  before(async () => {
    ocStub = spawn(process.execPath, [STUB_OC, String(OC_PORT)], {
      env: { ...process.env, STUB_OC_MODE: "happy" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("oc stub did not start")), 8000);
      ocStub.stdout.on("data", (c) => {
        if (String(c).includes("stub-oc on")) { clearTimeout(t); resolve(); }
      });
    });
  });
  after(() => { if (ocStub) ocStub.kill("SIGKILL"); });

  it("oc_ask / oc_state / oc_new_session round-trip", async () => {
    const bus = fs.mkdtempSync(path.join(os.tmpdir(), "ocmcp-"));
    const proc = startServer({ AGENT_BUS: bus });
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    await rpc(proc, { method: "initialize", params: {} }, 1);
    const list = await rpc(proc, { method: "tools/list" }, 2);
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("oc_ask") && names.includes("oc_state") && names.includes("oc_abort") && names.includes("oc_new_session"));
    const ask = await rpc(proc, { method: "tools/call", params: { name: "oc_ask", arguments: { message: "do /abs/thing" } } }, 3);
    assert.ok(!ask.result.isError, JSON.stringify(ask).slice(0, 300));
    assert.match(ask.result.content[0].text, /stub-oc answer/);
    const state = await rpc(proc, { method: "tools/call", params: { name: "oc_state", arguments: {} } }, 4);
    assert.match(state.result.content[0].text, /opencode/);
    const fresh = await rpc(proc, { method: "tools/call", params: { name: "oc_new_session", arguments: {} } }, 5);
    assert.ok(!fresh.result.isError);
    assert.match(fresh.result.content[0].text, /Fresh OpenCode session/);
    const asyncRes = await rpc(proc, { method: "tools/call", params: { name: "oc_ask_async", arguments: { message: "oc background" } } }, 6);
    assert.ok(!asyncRes.result.isError);
    const ticket = asyncRes.result.content[0].text.match(/Ticket (\S+)/)[1];
    let found = null;
    for (let i = 0; i < 40; i++) {
      const inbox = await rpc(proc, { method: "tools/call", params: { name: "pi_inbox", arguments: {} } }, 100 + i);
      if (inbox.result.content[0].text.includes(ticket)) { found = inbox.result.content[0].text; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(found && found.includes("oc background"), "oc ticket result arrived via inbox");
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
  });
});
