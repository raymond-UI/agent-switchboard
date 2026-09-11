import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OcSession } from "../bridge/oc-session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "stub-oc-server.mjs");
const PORTS = { happy: 4611, tooluse: 4612, hang: 4613 };

const stubs = [];
async function startStub(mode, port) {
  const stub = spawn(process.execPath, [STUB, String(port)], {
    env: { ...process.env, STUB_OC_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stubs.push(stub);
  // wait for listen line
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`stub ${mode} did not start`)), 8000);
    stub.stdout.on("data", (c) => {
      if (String(c).includes("stub-oc on")) { clearTimeout(t); resolve(); }
    });
    stub.on("exit", (code) => { clearTimeout(t); reject(new Error(`stub ${mode} exited ${code}`)); });
  });
}
function oc(mode = "happy") {
  return new OcSession({ baseUrl: `http://127.0.0.1:${PORTS[mode]}`, ocCwd: "/tmp" });
}

describe("opencode transport", () => {
  before(async () => {
    await startStub("happy", PORTS.happy);
    await startStub("tooluse", PORTS.tooluse);
    await startStub("hang", PORTS.hang);
  });
  after(() => { for (const s of stubs) s.kill("SIGKILL"); });

  it("ask happy path returns text via SSE settle", async () => {
    const s = oc();
    const r = await s.ask("first task", { timeoutMs: 10000 });
    assert.match(r.text, /first task/);
    assert.equal(r.sessionId.length > 0, true);
    await s.stop();
  });

  it("collects tool telemetry", async () => {
    const s = oc("tooluse");
    const r = await s.ask("use tools", { timeoutMs: 10000 });
    assert.deepEqual(r.toolsUsed, ["read"]);
    await s.stop();
  });

  it("sequential asks share the session; newSession rotates", async () => {
    const s = oc();
    const r1 = await s.ask("one", { timeoutMs: 10000 });
    const r2 = await s.ask("two", { timeoutMs: 10000 });
    assert.equal(r1.sessionId, r2.sessionId);
    const ns = await s.newSession();
    assert.equal(ns.cancelled, false);
    assert.notEqual(ns.sessionId, r1.sessionId);
    const r3 = await s.ask("three", { timeoutMs: 10000 });
    assert.equal(r3.sessionId, ns.sessionId);
    await s.stop();
  });

  it("steer queues a follow-up without breaking the wait", async () => {
    const s = oc("hang");
    const p = s.ask("long job", { timeoutMs: 900 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await s.steer("course correction"), true);
    await assert.rejects(p, /timed out|failed/i);
    await s.stop();
  });

  it("steer on idle starts a turn", async () => {
    const s = oc();
    assert.equal(await s.steer("first"), true);
    await new Promise((r) => setTimeout(r, 800)); // let the stub turn settle
    const msgs = await s.api(`/session/${await s.ensureSession()}/message`, {}, { timeoutMs: 5000 });
    const texts = JSON.stringify(msgs);
    assert.match(texts, /first/);
    await s.stop();
  });

  it("queued follow-ups complete in order", async () => {
    const s = oc();
    const sid = await s.ensureSession();
    const post = (t) => s.api(`/session/${sid}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text: t }] } }, { timeoutMs: 5000 });
    await post("alpha");
    await post("beta"); // lands while alpha runs -> queued
    await new Promise((r) => setTimeout(r, 900));
    const msgs = await s.api(`/session/${sid}/message`, {}, { timeoutMs: 5000 });
    const texts = (msgs.data || []).flatMap((m) => (m.parts || []).filter((p) => p.type === "text").map((p) => p.text));
    const ia = texts.findIndex((t) => t.includes("alpha"));
    const ib = texts.findIndex((t) => t.includes("beta"));
    assert.ok(ia >= 0 && ib > ia, `ordered answers, got: ${JSON.stringify(texts)}`);
    await s.stop();
  });

  it("state reports session info", async () => {
    const s = oc();
    await s.ask("hi", { timeoutMs: 10000 });
    const st = await s.state();
    assert.equal(st.agent, "opencode");
    assert.ok(st.sessionId);
    await s.stop();
  });

  it("timeout aborts and bridge stays usable", async () => {
    const s = oc("hang");
    // Hang stub never idles on its own.
    const p = s.ask("hang", { timeoutMs: 800 });
    await assert.rejects(p, /timed out|failed/i);
    await s.stop();
    const s2 = oc();
    const r = await s2.ask("after hang", { timeoutMs: 10000 });
    assert.match(r.text, /after hang/);
    await s2.stop();
  });
});
