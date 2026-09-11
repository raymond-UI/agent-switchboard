import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendMessage, readAll, readUnread, drainUnread, formatForClaude } from "../bridge/bus.mjs";

function tmpBus() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bus-"));
  return d;
}

describe("bus", () => {
  it("appends and reads back", () => {
    const b = tmpBus();
    appendMessage(b, { text: "hello", kind: "result", paths: ["/a.ts"] });
    const all = readAll(b);
    assert.equal(all.length, 1);
    assert.equal(all[0].text, "hello");
    assert.equal(all[0].read, false);
  });

  it("skips malformed lines", () => {
    const b = tmpBus();
    appendMessage(b, { text: "ok" });
    fs.appendFileSync(path.join(b, "to-claude.jsonl"), "NOT JSON\n");
    appendMessage(b, { text: "ok2" });
    assert.equal(readAll(b).length, 2);
  });

  it("drain early-exits without rewriting when nothing is unread", () => {
    const b = tmpBus();
    appendMessage(b, { text: "m1" });
    drainUnread(b);
    const file = path.join(b, "to-claude.jsonl");
    const before = fs.readFileSync(file, "utf8");
    assert.deepEqual(drainUnread(b), []);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("drain compacts consumed history past the watermark", () => {
    const b = tmpBus();
    for (let i = 0; i < 10; i++) appendMessage(b, { text: `m${i}` });
    assert.equal(drainUnread(b, { BUS_KEEP_CONSUMED: "3" }).length, 10);
    const rest = readAll(b);
    assert.equal(rest.length, 3); // newest 3 kept as audit trail
    assert.equal(rest[2].text, "m9");
    appendMessage(b, { text: "fresh" });
    assert.equal(drainUnread(b, { BUS_KEEP_CONSUMED: "3" }).length, 1);
    assert.equal(readAll(b).length, 3);
  });

  it("drain marks read before emit and is idempotent", () => {
    const b = tmpBus();
    appendMessage(b, { text: "m1" });
    appendMessage(b, { text: "m2" });
    const first = drainUnread(b);
    assert.equal(first.length, 2);
    assert.equal(drainUnread(b).length, 0);
    assert.equal(readUnread(b).length, 0);
    // file still has records, all read:true
    assert.equal(readAll(b).length, 2);
    assert.ok(readAll(b).every((r) => r.read === true));
  });

  it("formats for claude with paths", () => {
    const s = formatForClaude([{ kind: "warning", text: "careful", paths: ["/x.ts"], session: null }]);
    assert.match(s, /warning/);
    assert.match(s, /\/x\.ts/);
  });

  it("U+2028 payloads survive JSONL", () => {
    const b = tmpBus();
    const tricky = "line sep para";
    appendMessage(b, { text: tricky });
    assert.equal(readAll(b)[0].text, tricky);
  });
});
