import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiSession } from "../bridge/pi-session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "stub-pi.mjs");

function stubSession(mode, extra = {}) {
  return new PiSession({
    piBin: process.execPath,
    extraArgs: [STUB],
    piCwd: "/tmp",
    askTimeoutMs: 8000,
    ...extra,
  });
}
async function stopQuiet(s) {
  try { await s.stop(); } catch {}
}

describe("transport framing + correlation", () => {
  it("U+2028 round-trips intact (no readline split)", async () => {
    const s = stubSession("happy");
    process.env.STUB_MODE = "happy";
    // feed framing directly without spawning: simulate two records where
    // first JSON string contains literal U+2028
    const seen = [];
    const orig = s.onEvent.bind(s);
    s.onEvent = (ev) => { seen.push(ev); return orig(ev); };
    // pending correlation check via raw onMessage with ids
    s.ensureStarted();
    await new Promise((r) => setTimeout(r, 300)); // let stub boot
    const tricky = "a b";
    const res = await s.ask(`payload ${tricky} end`);
    assert.match(res.text, /stub answer/);
    assert.ok(res.text.includes(tricky), "U+2028 must survive");
    await stopQuiet(s);
  });

  it("killing pi mid-ask rejects instead of hanging", async () => {
    process.env.STUB_MODE = "exit-mid";
    const s = stubSession("exit-mid");
    await assert.rejects(() => s.ask("will die", { timeoutMs: 5000 }), /exited|failed/i);
    await stopQuiet(s);
    process.env.STUB_MODE = "happy";
  });

  it("compaction + retry resolve and surface in notices", async () => {
    process.env.STUB_MODE = "compaction";
    const s = stubSession("compaction");
    const r = await s.ask("compact me");
    assert.equal(r.compactions, 1);
    assert.equal(r.retries, 1);
    assert.ok(r.notices.length >= 2);
    await stopQuiet(s);
    process.env.STUB_MODE = "happy";
  });

  it("dialog auto-cancelled, ask still resolves", async () => {
    process.env.STUB_MODE = "dialog";
    const s = stubSession("dialog");
    const r = await s.ask("dialog test");
    assert.match(r.text, /after dialog/);
    assert.ok(r.dialogsCancelled.length >= 1);
    await stopQuiet(s);
    process.env.STUB_MODE = "happy";
  });

  it("ask while streaming queues rather than erroring (followUp)", async () => {
    process.env.STUB_MODE = "happy";
    const s = stubSession("happy");
    const p1 = s.ask("first");
    const p2 = s.ask("second");
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.match(r1.text, /first|stub answer/);
    assert.match(r2.text, /second|stub answer/);
    await stopQuiet(s);
  });

  it("timeout then usable afterwards", async () => {
    process.env.STUB_MODE = "timeout-hang";
    const s = stubSession("timeout-hang", { askTimeoutMs: 600 });
    await assert.rejects(() => s.ask("hang", { timeoutMs: 600 }), /timed out|failed/i);
    // flip stub to happy via fresh session (old child hung -> stop it)
    await stopQuiet(s);
    process.env.STUB_MODE = "happy";
    const s2 = stubSession("happy");
    const r = await s2.ask("after timeout");
    assert.match(r.text, /stub answer/);
    await stopQuiet(s2);
  });

  it("out-of-order responses correlate by id", async () => {
    process.env.STUB_MODE = "happy";
    const s = stubSession("happy");
    s.ensureStarted();
    await new Promise((r) => setTimeout(r, 200));
    const [a, b] = await Promise.all([
      s.sendCommand({ type: "get_state" }, { timeoutMs: 5000 }),
      s.sendCommand({ type: "get_session_stats" }, { timeoutMs: 5000 }),
    ]);
    assert.ok(a.model);
    assert.ok(b.tokens);
    await stopQuiet(s);
  });

  it("newSession drops history and keeps bridge usable", async () => {
    process.env.STUB_MODE = "happy";
    const s = stubSession("happy");
    const r1 = await s.ask("first task");
    assert.match(r1.text, /first task/);
    const ns = await s.newSession();
    assert.equal(ns.cancelled, false);
    assert.ok(ns.sessionFile, "new session file reported");
    assert.ok(!r1.sessionFile || ns.sessionFile !== r1.sessionFile, "session file rotates");
    const r2 = await s.ask("second task");
    assert.match(r2.text, /second task/);
    assert.equal(r2.sessionFile, ns.sessionFile);
    await stopQuiet(s);
  });

  it("spawn env strips NODE_OPTIONS (poisoned host preload immunity)", async () => {
    process.env.NODE_OPTIONS = "--require /nonexistent/restore.cjs";
    try {
      assert.ok(!("NODE_OPTIONS" in new PiSession({ piBin: "x", piCwd: "/tmp" }).spawnEnv()));
    } finally {
      delete process.env.NODE_OPTIONS;
    }
  });

  it("spawn env defaults PI_OFFLINE=1 unless explicitly set", async () => {
    const s = new PiSession({ piBin: process.execPath, extraArgs: ["x"], piCwd: "/tmp" });
    assert.equal(s.spawnEnv().PI_OFFLINE, "1");
    process.env.PI_OFFLINE = "0";
    try {
      assert.equal(s.spawnEnv().PI_OFFLINE, "0");
    } finally {
      delete process.env.PI_OFFLINE;
    }
  });

  it("1MB single line + CRLF framing", async () => {
    const s = new PiSession({ piBin: process.execPath, extraArgs: [STUB], piCwd: "/tmp" });
    // craft raw frames directly
    const big = "x".repeat(1024 * 1024);
    let resolved = null;
    // fake pending
    const id = "big-1";
    const p = new Promise((resolve) => { s.pending.set(id, { resolve, reject: () => {}, command: "t", timer: setTimeout(() => {}, 5000) }); });
    s.onStdout(Buffer.from(JSON.stringify({ type: "response", id, command: "t", success: true, data: { big } }) + "\r\n", "utf8"));
    resolved = await Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
    assert.ok(resolved && resolved.big.length === 1024 * 1024);
    clearTimeout(s.pending.get(id)?.timer);
    s.pending.clear();
    await stopQuiet(s);
  });
});
