#!/usr/bin/env node
// Cross-platform installer: node scripts/install.mjs (replaces install.sh).
// Copies the pi extension + opencode plugin, registers the MCP server,
// prints the Stop-hook JSON. Idempotent; never touches running sessions.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRemote } from "../bridge/remote.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// npx runs from a cache dir the package manager may prune at any time. The
// MCP registration below would point at that transient path and silently
// break later. Detect it and steer toward a durable install instead.
const EPHEMERAL = /[\\/]\.npm[\\/]_npx[\\/]|[\\/]npm[\\/]_cacache[\\/]/.test(HERE);
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

// Bin-name invocation (PATH-resolved): immune to Node upgrades, npm paths,
// and repo moves. Unix prefixes `env -u` against poisoned host preloads
// (multiplexer NODE_OPTIONS pointing at purged tmp); Windows has no `env`.
const hook = isWindows ? "switchboard-inbox" : "env -u NODE_OPTIONS switchboard-inbox";
const mcpCmd = () => isWindows ? ["switchboard"] : ["env", "-u", "NODE_OPTIONS", "switchboard"];
let hasClaude = false;
try {
  execFileSync("claude", ["--version"], { stdio: "ignore" });
  hasClaude = true;
} catch {}
// Paired coordinator: keep the remote registration; a re-install (upgrade)
// must not silently swap Claude back to local workers.
const paired = loadRemote();
if (paired) {
  console.log(`Paired with remote worker ${paired.host} (${paired.url}); MCP registration left as-is. Unpair: switchboard-connect --local`);
} else if (hasClaude) {
  try {
    execFileSync("claude", ["mcp", "remove", "switchboard", "-s", "user"], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("claude", ["mcp", "add", "switchboard", "-s", "user", "--", ...mcpCmd()], { stdio: "inherit" });
    console.log("MCP registered.");
  } catch {
    console.log("MCP registration failed; register manually:");
    console.log(`  claude mcp add switchboard -s user -- ${mcpCmd().join(" ")}`);
  }
} else {
  console.log("claude CLI not found; register MCP manually:");
  console.log(`  claude mcp add switchboard -s user -- ${mcpCmd().join(" ")}`);
}

// Non-technical safety net: bins must resolve via PATH or nothing above works.
try {
  execFileSync(isWindows ? "where" : "which", ["switchboard-inbox"], { stdio: "ignore" });
} catch {
  console.log("WARNING: the npm global bin dir is not on your PATH, so Claude cannot find `switchboard*`.");
  console.log("Fix: add it to PATH (npm prefix -g + /bin), then re-run switchboard-install.");
}

console.log("Add these hooks to your Claude settings (use / forward slashes on Windows):");
const dispatcherHook = isWindows ? "switchboard-dispatcher" : "env -u NODE_OPTIONS switchboard-dispatcher";
console.log(JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "mcp__switchboard__pi_ask_async|mcp__switchboard__oc_ask_async",
        hooks: [{ type: "command", command: dispatcherHook }],
      },
    ],
    Stop: [{ hooks: [{ type: "command", command: hook }] }],
  },
}, null, 2));
console.log(`AGENT_BUS=${agentBus} (export/set identically on all sides when directories differ)`);
console.log("New worker sessions pick up plugin changes; running sessions keep their loaded copy.");
if (EPHEMERAL) {
  console.log("");
  console.log("WARNING: you ran from an npx cache (" + HERE + ").");
  console.log("The MCP registration above points there and will break when npm prunes it.");
  console.log("For durable use (no clone needed): npm install -g github:raymond-UI/agent-switchboard");
  console.log("then re-run: switchboard-install");
}

console.log("");
console.log("Cross-machine (optional): run `switchboard-pair` on the worker machine, then the");
console.log("`switchboard-connect <code>` it prints on the coordinator. Same hooks either way.");
