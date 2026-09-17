#!/usr/bin/env node
// Cross-platform entry point: single `node bridge/launcher.mjs <mcp|hook>`
// invocation on every OS (no per-OS shell wrappers in MCP/hook config).
// Note: this CANNOT scrub NODE_OPTIONS — a poisoned preload kills node
// before main runs. Sanitize outside node (`env -u` on Unix; unneeded on
// Windows). NODE_PATH is still dropped (import hijack vector, useless to us).
if ("NODE_PATH" in process.env) delete process.env.NODE_PATH;

const which = process.argv[2];
if (which === "mcp") {
  await import("./mcp-server.mjs");
} else if (which === "hook") {
  await import("../hooks/pi-inbox.mjs");
} else if (which === "serve") {
  await import("./http-server.mjs");
} else {
  process.stderr.write("usage: launcher.mjs <mcp|hook|serve>\n");
  process.exit(2);
}
