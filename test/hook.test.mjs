import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "pi-inbox.mjs");

function runHook({ bus, payload }) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AGENT_BUS: bus, PI_CWD: bus },
  });
}
function mkBusWith(msgs) {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
  if (msgs.length) {
    const lines = msgs.map((m) =>
      JSON.stringify({ ts: new Date().toISOString(), from: "pi", kind: "fyi", text: m, session: null, paths: [], read: false })
    ).join("\n") + "\n";
    fs.writeFileSync(path.join(b, "to-claude.jsonl"), lines);
  }
  return b;
}

describe("stop hook decision matrix", () => {
  it("unread messages -> block once with messages", () => {
    const b = mkBusWith(["hello from pi"]);
    const r = runHook({ bus: b, payload: {} });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /hello from pi/);
  });

  it("same invocation repeated -> exit 0, no duplicate", () => {
    const b = mkBusWith(["once"]);
    runHook({ bus: b, payload: {} });
    const r2 = runHook({ bus: b, payload: {} });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.trim(), "");
  });

  it("stop_hook_active true -> exit 0 regardless", () => {
    const b = mkBusWith(["msg"]);
    const r = runHook({ bus: b, payload: { stop_hook_active: true } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  it("consecutive blocks capped at PI_MAX_CONSECUTIVE_BLOCKS", () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "hookcap-"));
    let blocks = 0;
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(
        path.join(b, "to-claude.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), from: "pi", kind: "fyi", text: `m${i}`, session: null, paths: [], read: false }) + "\n"
      );
      const r = runHook({ bus: b, payload: {} });
      if (r.stdout.trim()) {
        const out = JSON.parse(r.stdout);
        if (out.decision === "block") blocks++;
      }
    }
    assert.ok(blocks <= 3, `expected <=3 blocks, got ${blocks}`);
  });

  it("empty inbox resets counter and exits 0", () => {
    const b = mkBusWith([]);
    const r = runHook({ bus: b, payload: {} });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });
});
