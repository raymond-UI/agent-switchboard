import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "bridge", "mcp-server.mjs");
const STUB = path.join(HERE, "stub-pi.mjs");

function startServer(env) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, STUB_MODE: "happy", PI_BIN: process.execPath, PI_EXTRA_ARGS: STUB, PI_CWD: "/tmp", BRIDGE_WARMUP: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function rpc(proc, obj, id) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { proc.stdout.off("data", onData); reject(new Error("rpc timeout")); }, 15000);
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

describe("mcp server", () => {
  it("initialize -> tools/list -> tools/call round-trips; stdout is clean", async () => {
    const bus = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-"));
    const proc = startServer({ AGENT_BUS: bus });
    try {
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    const init = await rpc(proc, { method: "initialize", params: { protocolVersion: "2024-11-05" } }, 1);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    const list = await rpc(proc, { method: "tools/list" }, 2);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["agent_send", "agent_sessions", "agent_tickets", "oc_abort", "oc_ask", "oc_ask_async", "oc_new_session", "oc_state", "oc_steer", "pi_abort", "pi_ask", "pi_ask_async", "pi_inbox", "pi_new_session", "pi_state", "pi_steer"]);
    const state = await rpc(proc, { method: "tools/call", params: { name: "pi_state", arguments: {} } }, 3);
    assert.ok(state.result.content[0].text.includes("model"));
    const ask = await rpc(proc, { method: "tools/call", params: { name: "pi_ask", arguments: { message: "do /abs/path/task" } } }, 4);
    assert.ok(!ask.result.isError, JSON.stringify(ask).slice(0, 300));
    assert.match(ask.result.content[0].text, /stub answer/);
    // stdout clean: every line so far was consumed as JSON; stderr got logs
    assert.match(stderr, /switchboard/);
    // notifications ignored
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    // fresh session cycle: ask -> new session -> ask continues in the new one
    const fresh = await rpc(proc, { method: "tools/call", params: { name: "pi_new_session", arguments: {} } }, 5);
    assert.ok(!fresh.result.isError, JSON.stringify(fresh).slice(0, 200));
    assert.match(fresh.result.content[0].text, /Fresh pi session/);
    const ask2 = await rpc(proc, { method: "tools/call", params: { name: "pi_ask", arguments: { message: "follow-up in new session" } } }, 6);
    assert.ok(!ask2.result.isError);
    assert.match(ask2.result.content[0].text, /follow-up in new session/);
    // agent_send queues to the agent bus; agent_sessions lists presence
    const send = await rpc(proc, { method: "tools/call", params: { name: "agent_send", arguments: { message: "hello worker", to: "worker-1" } } }, 7);
    assert.ok(!send.result.isError, JSON.stringify(send).slice(0, 200));
    assert.match(send.result.content[0].text, /to=worker-1/);
    const sess = await rpc(proc, { method: "tools/call", params: { name: "agent_sessions", arguments: {} } }, 8);
    assert.ok(!sess.result.isError);
    assert.match(sess.result.content[0].text, /no paired worker sessions/);
    // reply-to stamping: exactly one live claude session => deterministic target
    const { writePresence, removePresence, readToPi } = await import("../bridge/bus.mjs");
    writePresence(bus, { sessionId: "claude-only", cwd: "/tmp", name: "t", agent: "claude" });
    const stamped = await rpc(proc, { method: "tools/call", params: { name: "agent_send", arguments: { message: "hello worker", to: "worker-9" } } }, 9);
    assert.match(stamped.result.content[0].text, /claude-only/);
    const recs = readToPi(bus);
    const mine = recs.find((r) => r.to === "worker-9");
    assert.equal(mine.replyTo, "claude-only");
    assert.match(mine.text, /reply-to|Reply to/);
    // zero live claude sessions => no stamp, honest report
    removePresence(bus, "claude-only");
    const unstamped = await rpc(proc, { method: "tools/call", params: { name: "agent_send", arguments: { message: "hello again", to: "worker-9" } } }, 10);
    assert.match(unstamped.result.content[0].text, /No live Claude session/);
    // async ticket: returns immediately, result lands in inbox
    const t0 = Date.now();
    const asyncRes = await rpc(proc, { method: "tools/call", params: { name: "pi_ask_async", arguments: { message: "background job" } } }, 9);
    assert.ok(!asyncRes.result.isError);
    assert.ok(Date.now() - t0 < 5000, "async must not block");
    const ticket = asyncRes.result.content[0].text.match(/Ticket (\S+)/)[1];
    let found = null;
    for (let i = 0; i < 40; i++) {
      const inbox = await rpc(proc, { method: "tools/call", params: { name: "pi_inbox", arguments: {} } }, 100 + i);
      if (inbox.result.content[0].text.includes(ticket) && inbox.result.content[0].text.includes("background job")) { found = inbox.result.content[0].text; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(found, "ticket result arrived via inbox");
    const tickets = await rpc(proc, { method: "tools/call", params: { name: "agent_tickets", arguments: {} } }, 200);
    assert.match(tickets.result.content[0].text, /done/);
    // tool error returns isError, not protocol error
    const bad = await rpc(proc, { method: "tools/call", params: { name: "nope", arguments: {} } }, 300);
    assert.equal(bad.result.isError, true);
    } finally {
      proc.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  it("pi_ask against missing binary returns isError, server stays usable", async () => {
    const bus = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-"));
    const proc = startServer({ AGENT_BUS: bus, PI_BIN: "/nonexistent-pi-binary-xyz", PI_EXTRA_ARGS: "" });
    await rpc(proc, { method: "initialize", params: {} }, 1);
    const ask = await rpc(proc, { method: "tools/call", params: { name: "pi_ask", arguments: { message: "hi" } } }, 2);
    assert.equal(ask.result.isError, true);
    const list = await rpc(proc, { method: "tools/list" }, 3);
    assert.ok(list.result.tools.length > 0);
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  });
});
