import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capResult, resultCap } from "../bridge/format.mjs";

describe("result cap (P4)", () => {
  it("short results pass through untouched, no spill file", () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
    assert.equal(capResult("hello", b), "hello");
    assert.equal(fs.existsSync(path.join(b, "results")), false);
  });

  it("long results truncate with a pointer to the full spill file", () => {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
    const big = "x".repeat(500);
    const out = capResult(big, b, { RESULT_CAP: "100" });
    assert.ok(out.length < big.length);
    assert.match(out, /truncated 400 chars/);
    const m = out.match(/full result: (\S+\.md)/);
    assert.ok(m);
    assert.equal(fs.readFileSync(m[1], "utf8"), big);
  });

  it("resultCap honors env, falls back on garbage", () => {
    assert.equal(resultCap({ RESULT_CAP: "123" }), 123);
    assert.equal(resultCap({}), 8000);
    assert.equal(resultCap({ RESULT_CAP: "junk" }), 8000);
  });
});
