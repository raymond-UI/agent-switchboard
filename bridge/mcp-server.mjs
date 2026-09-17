#!/usr/bin/env node
// MCP stdio server (PRD 6.2). Thin transport over bridge/app.mjs.
// stdout = protocol only. All logs -> stderr.

import { config, pi, oc, log, handleRequest, stopWorkers } from "./app.mjs";

let buffer = "";
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
});
function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRequest(msg, send);
  }
});
async function shutdown(signal) {
  log(`[switchboard] ${signal}, stopping workers...`);
  const force = setTimeout(() => process.exit(0), 8000);
  if (typeof force.unref === "function") force.unref();
  await stopWorkers();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
log(`[switchboard] ready. PI_CWD=${config.piCwd} AGENT_BUS=${config.agentBus} PI_BIN=${config.piBin}`);
