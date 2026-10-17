import "./isolate.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCode, decodeCode, ensureWorker, resolveRemote, saveRemote, candidateHosts } from "../bridge/remote.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("pairing", () => {
  it("pair code round-trips and rejects junk", () => {
    const code = encodeCode({ urls: ["http://10.0.0.2:4598"], token: "abc" });
    assert.match(code, /^sb1\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCode(code), { urls: ["http://10.0.0.2:4598"], token: "abc" });
    assert.throws(() => decodeCode("nope"), /pair code/);
  });

  it("worker token persists unless rotated; files are private", () => {
    const env = { SWITCHBOARD_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "sbw-")) };
    const a = ensureWorker({}, env);
    assert.equal(ensureWorker({}, env).token, a.token);
    assert.notEqual(ensureWorker({ rotate: true }, env).token, a.token);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(env.SWITCHBOARD_CONFIG_DIR, "worker.json")).mode & 0o077, 0);
    }
  });

  it("explicit env beats the saved pairing", () => {
    const env = { SWITCHBOARD_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "sbr-")) };
    assert.equal(resolveRemote(env), null);
    saveRemote({ url: "http://a:1/", token: "t1" }, env);
    assert.deepEqual(resolveRemote(env), { url: "http://a:1", token: "t1" });
    assert.deepEqual(resolveRemote({ ...env, AGENT_BUS_REMOTE: "http://b:2", SWITCHBOARD_TOKEN: "t2" }), { url: "http://b:2", token: "t2" });
  });

  it("advertises at least one address", () => {
    assert.ok(candidateHosts().length >= 1);
  });

  it("serve refuses a network bind without a token (and --host parses)", () => {
    const r = spawnSync(process.execPath, [path.join(REPO, "bridge", "launcher.mjs"), "serve", "--host", "0.0.0.0", "--port", "4631"], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, SWITCHBOARD_TOKEN: "", SWITCHBOARD_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "sbn-")), BRIDGE_WARMUP: "0" },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to bind 0\.0\.0\.0/);
  });
});

describe("worker service files", async () => {
  const { serviceEnv, renderPlist, renderUnit, LABEL } = await import("../scripts/service.mjs");
  const env = serviceEnv({ port: 4598 }, { PATH: "/opt/bin:/usr/bin", HOME: "/home/w", PI_CWD: "/srv/a&b", PI_MODEL: "x/y", ANTHROPIC_API_KEY: "secret" });

  it("bakes PATH/cwd/port/model, never provider keys", () => {
    assert.equal(env.PATH, "/opt/bin:/usr/bin");
    assert.equal(env.OC_CWD, "/srv/a&b");
    assert.equal(env.SWITCHBOARD_PORT, "4598");
    assert.equal(env.PI_MODEL, "x/y");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it("launchd plist runs the bin quietly and escapes XML", () => {
    const plist = renderPlist({ env, logFile: "/tmp/w.log" });
    assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
    assert.match(plist, /<string>switchboard-pair<\/string>\s*<string>--quiet<\/string>/);
    assert.match(plist, /\/srv\/a&amp;b/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    if (process.platform === "darwin") {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plist-")), "w.plist");
      fs.writeFileSync(f, plist);
      assert.equal(spawnSync("plutil", ["-lint", f]).status, 0);
    }
  });

  it("systemd unit restarts and quotes env", () => {
    const unit = renderUnit({ env: { ...env, PI_MODEL: 'a"b%c' } });
    assert.match(unit, /ExecStart=\/usr\/bin\/env -u NODE_OPTIONS switchboard-pair --quiet/);
    assert.match(unit, /Restart=always/);
    assert.match(unit, /Environment="PI_MODEL=a\\"b%%c"/);
  });
});
