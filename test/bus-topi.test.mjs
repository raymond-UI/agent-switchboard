import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendToPi,
  readToPi,
  pendingToPi,
  claimToPi,
  writePresence,
  removePresence,
  listPresence,
} from "../bridge/bus.mjs";

function tmpBus() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topi-"));
}

const ALICE = ["/sess/alice.jsonl", "alice-id", "/work/proj"];
const BOB = ["/sess/bob.jsonl", "bob-id", "/work/proj"];

describe("to-pi bus (prototype)", () => {
  it("addressed message is pending only for its target", () => {
    const b = tmpBus();
    appendToPi(b, { text: "hi alice", to: "alice-id" });
    assert.equal(pendingToPi(b, ALICE).length, 1);
    assert.equal(pendingToPi(b, BOB).length, 0);
  });

  it("broadcast is pending for every instance, once each", () => {
    const b = tmpBus();
    appendToPi(b, { text: "all hands" }); // to defaults to "*"
    assert.equal(pendingToPi(b, ALICE).length, 1);
    assert.equal(pendingToPi(b, BOB).length, 1);
    const rec = pendingToPi(b, ALICE)[0];
    assert.ok(claimToPi(b, rec.id, ALICE[0]));
    // Alice done, Bob still pending.
    assert.equal(pendingToPi(b, ALICE).length, 0);
    assert.equal(pendingToPi(b, BOB).length, 1);
  });

  it("claim marks delivered before acting; double-claim is idempotent", () => {
    const b = tmpBus();
    const rec = appendToPi(b, { text: "once", to: ALICE[0] });
    assert.ok(claimToPi(b, rec.id, ALICE[0]));
    assert.equal(claimToPi(b, rec.id, ALICE[0]), false);
    assert.equal(pendingToPi(b, ALICE).length, 0);
    assert.equal(readToPi(b)[0].deliveredTo.length, 1);
  });

  it("sessions never inherit pre-birth backlog (stale-brief fix)", () => {
    const b = tmpBus();
    const oldTs = new Date(Date.now() - 3600000).toISOString();
    const nowTs = new Date().toISOString();
    const old = { ...appendToPi(b, { text: "ancient broadcast", to: "*" }), ts: oldTs };
    const addressed = { ...appendToPi(b, { text: "for alice", to: "alice-id" }), ts: oldTs };
    const fresh = { ...appendToPi(b, { text: "fresh broadcast", to: "*" }), ts: nowTs };
    // rewrite with fixed timestamps
    const fs2 = fs;
    fs2.writeFileSync(
      path.join(b, "to-pi.jsonl"),
      [old, addressed, fresh].map((r) => JSON.stringify(r)).join("\n") + "\n"
    );
    const sinceTs = Date.now();
    const got = pendingToPi(b, ["alice-id"], { sinceTs }).map((r) => r.text);
    assert.ok(!got.includes("ancient broadcast"), "stale broadcast withheld");
    assert.ok(got.includes("for alice"), "exact addressing bypasses age gate");
    assert.ok(got.includes("fresh broadcast"), "fresh broadcast delivered");
    // No filter: back-compat, everything matches.
    assert.equal(pendingToPi(b, ["alice-id"]).length, 3);
  });

  it("matches on session file and cwd, not just id", () => {
    const b = tmpBus();
    appendToPi(b, { text: "by file", to: "/sess/alice.jsonl" });
    appendToPi(b, { text: "by cwd", to: "/work/proj" });
    // Bob shares the cwd, so cwd-addressed reaches him too.
    assert.equal(pendingToPi(b, ALICE).length, 2);
    assert.equal(pendingToPi(b, BOB).length, 1);
  });

  it("claiming a missing record returns false", () => {
    assert.equal(claimToPi(tmpBus(), "nope", "x"), false);
  });

  it("skips malformed lines", () => {
    const b = tmpBus();
    appendToPi(b, { text: "ok" });
    fs.appendFileSync(path.join(b, "to-pi.jsonl"), "GARBAGE\n");
    assert.equal(readToPi(b).length, 1);
  });

  it("presence write -> list -> remove round-trips; dead pids read stale", () => {
    const b = tmpBus();
    assert.deepEqual(listPresence(b), []);
    writePresence(b, { sessionId: "live-1", sessionFile: "/s/1.jsonl", cwd: "/w", name: "t" });
    const all = listPresence(b);
    assert.equal(all.length, 1);
    assert.equal(all[0].alive, true); // our own pid
    assert.equal(all[0].sessionFile, "/s/1.jsonl");
    // Forge a dead entry straight to disk.
    fs.writeFileSync(
      path.join(b, "presence", "dead-9.json"),
      JSON.stringify({ sessionId: "dead-9", pid: 2 ** 22, ts: new Date().toISOString() })
    );
    const withDead = listPresence(b);
    assert.equal(withDead.length, 2);
    assert.equal(withDead.find((p) => p.sessionId === "dead-9").alive, false);
    removePresence(b, "live-1");
    assert.equal(listPresence(b).length, 1);
  });
});
