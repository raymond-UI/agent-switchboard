// Tests must not see the developer's real pairing (~/.config/switchboard):
// a paired machine would send every spawned hook to a real remote worker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SWITCHBOARD_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-cfg-"));
delete process.env.AGENT_BUS_REMOTE;
delete process.env.SWITCHBOARD_TOKEN;
