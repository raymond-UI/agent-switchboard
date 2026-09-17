#!/usr/bin/env node
// Cross-platform installer: node scripts/install.mjs (replaces install.sh).
// Copies the pi extension + opencode plugin, registers the MCP server,
// prints the Stop-hook JSON. Idempotent; never touches running sessions.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();
const isWindows = process.platform === "win32";

const agentBus = process.env.AGENT_BUS || path.join(process.cwd(), ".agentbus");
const piExtDir = path.join(HOME, ".pi", "agent", "extensions");
const ocPluginDir = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "opencode", "plugins")
  : isWindows
    ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "opencode", "plugins")
    : path.join(HOME, ".config", "opencode", "plugins");

function cp(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  return path.join(destDir, path.basename(src));
}

fs.mkdirSync(agentBus, { recursive: true });
const piExt = cp(path.join(HERE, "pi-extensions", "claude-bridge.ts"), piExtDir);
console.log(`pi extension -> ${piExt}`);
let ocPlugin = null;
try {
  ocPlugin = cp(path.join(HERE, "opencode-plugin", "claude-bridge.ts"), ocPluginDir);
  console.log(`opencode plugin -> ${ocPlugin}`);
} catch (err) {
  console.log(`opencode plugin NOT installed (${err.message}); copy opencode-plugin/claude-bridge.ts to your plugins dir manually.`);
}

const launcher = path.join(HERE, "bridge", "launcher.mjs");
// Unix wraps with `env -u` against poisoned host preloads (e.g. a multiplexer
// pointing NODE_OPTIONS at a purged temp file); Windows has no `env` binary
// and no such preload problem, so invoke node directly there.
const hook = isWindows
  ? ["node", launcher, "hook"].join(" ")
  : ["env", "-u", "NODE_OPTIONS", "node", launcher, "hook"].join(" ");
const mcpCmd = (args) => isWindows
  ? ["node", launcher, "mcp", ...args]
  : ["env", "-u", "NODE_OPTIONS", "node", launcher, "mcp", ...args];
let hasClaude = false;
try {
  execFileSync("claude", ["--version"], { stdio: "ignore" });
  hasClaude = true;
} catch {}
if (hasClaude) {
  try {
    execFileSync("claude", ["mcp", "remove", "switchboard", "-s", "user"], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("claude", ["mcp", "add", "switchboard", "-s", "user", "--", ...mcpCmd([])], { stdio: "inherit" });
    console.log("MCP registered.");
  } catch {
    console.log("MCP registration failed; register manually:");
    console.log(`  claude mcp add switchboard -s user -- ${mcpCmd([]).join(" ")}`);
  }
} else {
  console.log("claude CLI not found; register MCP manually:");
  console.log(`  claude mcp add switchboard -s user -- ${mcpCmd([]).join(" ")}`);
}

console.log("Add this Stop hook to your Claude settings (use / forward slashes on Windows):");
console.log(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: hook }] }] } }, null, 2));
console.log(`AGENT_BUS=${agentBus} (export/set identically on all sides when directories differ)`);
console.log("New worker sessions pick up plugin changes; running sessions keep their loaded copy.");

// Remote Claude (cross-machine): mint a bearer token and print the client
// config. The bridge serves it with `node bridge/launcher.mjs serve --port <p>`
// (SWITCHBOARD_TOKEN set). Single-machine stdio stays the default.
const token = randomBytes(24).toString("hex");
console.log("");
console.log("Remote Claude (optional, LAN): serve the bridge, then connect:");
console.log(`  SWITCHBOARD_TOKEN=${token} node ${path.join(HERE, "bridge", "launcher.mjs")} serve --port 4598`);
console.log("  claude mcp add --transport http switchboard-remote http://<this-host>:4598/mcp --header \"Authorization: Bearer " + token + "\"");
console.log("  Hook: AGENT_BUS_REMOTE=http://<this-host>:4598 node " + path.join(HERE, "bridge", "launcher.mjs") + " hook");
console.log("  (bind LAN via SWITCHBOARD_HOST; Tailscale outside the LAN; token shown once, keep it secret)");
