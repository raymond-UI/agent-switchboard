import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  multiOrchEnabled,
  maxDepth,
  currentDepth,
  depthCheck,
  childDepthEnv,
} from "../bridge/env.mjs";

describe("delegation depth guard", () => {
  it("flag defaults off, accepts 1/true/yes", () => {
    assert.equal(multiOrchEnabled({}), false);
    assert.equal(multiOrchEnabled({ SWITCHBOARD_MULTI_ORCH: "1" }), true);
    assert.equal(multiOrchEnabled({ SWITCHBOARD_MULTI_ORCH: "yes" }), true);
    assert.equal(multiOrchEnabled({ SWITCHBOARD_MULTI_ORCH: "0" }), false);
  });

  it("refuses at cap, allows below", () => {
    assert.equal(depthCheck({}), null);
    assert.equal(depthCheck({ SWITCHBOARD_DEPTH: "1" }), null);
    assert.match(depthCheck({ SWITCHBOARD_DEPTH: "2" }), /at cap/);
    assert.match(depthCheck({ SWITCHBOARD_DEPTH: "5", SWITCHBOARD_MAX_DEPTH: "3" }), /max 3/);
  });

  it("garbage env degrades to safe defaults", () => {
    assert.equal(currentDepth({ SWITCHBOARD_DEPTH: "junk" }), 0);
    assert.equal(maxDepth({ SWITCHBOARD_MAX_DEPTH: "junk" }), 2);
    assert.equal(depthCheck({ SWITCHBOARD_DEPTH: "junk" }), null);
  });

  it("child env bumps depth by exactly one", () => {
    assert.equal(childDepthEnv({}).SWITCHBOARD_DEPTH, "1");
    assert.equal(childDepthEnv({ SWITCHBOARD_DEPTH: "2" }).SWITCHBOARD_DEPTH, "3");
  });
});
