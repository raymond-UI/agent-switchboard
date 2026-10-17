#!/usr/bin/env node
// Step 2 of 2, on the COORDINATOR machine: `switchboard-connect <code>`.
// Probes the worker's advertised addresses, saves the pairing (hooks read
// it, so settings stay unchanged), and re-registers the `switchboard` MCP
// server over HTTP under the SAME name, so tool names and hook matchers
// are identical to local mode.
//   switchboard-connect --status    show the current pairing
//   switchboard-connect --local     unpair; back to local stdio workers

import { execFileSync } from "node:child_process";
import { decodeCode, saveRemote, loadRemote, clearRemote, remoteFile } from "../bridge/remote.mjs";

const isWindows = process.platform === "win32";
const arg = process.argv[2];

function claude(args, opts = {}) {
  return execFileSync("claude", args, { stdio: "ignore", ...opts });
}

async function getJson(url, token) {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

if (!arg || arg === "-h" || arg === "--help") {
  console.log("usage: switchboard-connect <sb1.code>   (get the code from switchboard-pair on the worker)");
  console.log("       switchboard-connect --status | --local");
  process.exit(arg ? 0 : 2);
}

if (arg === "--status") {
  const r = loadRemote();
  if (!r) console.log("Not paired: workers run locally.");
  else console.log(`Paired with ${r.host} at ${r.url}\n  pi cwd: ${r.piCwd}\n  OpenCode cwd: ${r.ocCwd}`);
  process.exit(0);
}

if (arg === "--local") {
  clearRemote();
  try {
    try { claude(["mcp", "remove", "switchboard", "-s", "user"]); } catch {}
    const cmd = isWindows ? ["switchboard"] : ["env", "-u", "NODE_OPTIONS", "switchboard"];
    claude(["mcp", "add", "switchboard", "-s", "user", "--", ...cmd], { stdio: "inherit" });
    console.log("Unpaired. Workers run locally again (restart Claude sessions).");
  } catch {
    console.log("Unpaired, but MCP re-registration failed; run switchboard-install.");
  }
  process.exit(0);
}

let pair;
try {
  pair = decodeCode(arg);
} catch (err) {
  console.error(`switchboard-connect: ${err.message}`);
  process.exit(2);
}

// First address that answers /health AND accepts the token wins.
let chosen = null;
let rejected = false;
const tried = [];
for (const url of pair.urls) {
  try {
    await getJson(`${url}/health`);
    const info = await getJson(`${url}/info`, pair.token);
    chosen = { url, info };
    break;
  } catch (err) {
    rejected ||= err.message === "HTTP 401";
    tried.push(`${url} (${err.name === "TimeoutError" ? "no answer" : err.message})`);
  }
}
if (!chosen && rejected) {
  console.error("Reached the worker, but it rejected this code's token. Tried:\n  " + tried.join("\n  "));
  console.error("The code is stale, or an old process holds the port. On the worker run: switchboard-pair --print");
  console.error("It checks the running service and prints the current code.");
  process.exit(1);
}
if (!chosen) {
  console.error("Could not reach the worker. Tried:\n  " + tried.join("\n  "));
  console.error("Check that switchboard-pair is still running there, both machines share a network (or Tailscale), and no firewall blocks the port.");
  process.exit(1);
}

const { url, info } = chosen;
saveRemote({ url, token: pair.token, host: info.host, piCwd: info.piCwd, ocCwd: info.ocCwd, pairedAt: new Date().toISOString() });

let registered = false;
try {
  try { claude(["mcp", "remove", "switchboard", "-s", "user"]); } catch {}
  claude(["mcp", "add", "--transport", "http", "switchboard", "-s", "user", `${url}/mcp`, "--header", `Authorization: Bearer ${pair.token}`]);
  registered = true;
} catch {}

console.log(`Connected to ${info.host} (${url}).`);
console.log(`  pi works in:       ${info.piCwd}`);
console.log(`  OpenCode works in: ${info.ocCwd}`);
console.log("Paths you give workers refer to THAT machine.");
if (!registered) {
  console.log("Could not register MCP automatically; run:");
  console.log(`  claude mcp add --transport http switchboard -s user ${url}/mcp --header "Authorization: Bearer <token from ${remoteFile()}>"`);
}
console.log("Hooks need no change (they read the pairing). Restart Claude sessions to pick it up.");
console.log("Undo: switchboard-connect --local");
