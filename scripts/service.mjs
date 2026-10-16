// Worker background service: keeps `switchboard-pair --quiet` running across
// logouts, crashes and reboots. macOS = launchd agent (wrapped in
// `caffeinate -i` so idle sleep doesn't take the worker offline), Linux =
// systemd user unit. Bin-name invocation with the installer's PATH baked in,
// same as the hooks: survives Node upgrades and repo moves.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstSet } from "../bridge/remote.mjs";

export const LABEL = "dev.switchboard.worker";

// Env the worker needs that a service manager won't provide. Provider API
// keys are deliberately NOT copied (they'd sit in a plain file); pi and
// OpenCode logins stored in their own config work as-is.
const PASS_ENV = ["PI_BIN", "PI_MODEL", "OC_BIN", "OC_MODEL", "AGENT_BUS", "SWITCHBOARD_HOST", "PI_ASK_TIMEOUT_MS", "PI_ASYNC_TIMEOUT_MS", "OC_ASYNC_TIMEOUT_MS", "RESULT_CAP"];

const PASS_ENV_ALL = [...PASS_ENV, "SWITCHBOARD_CONFIG_DIR"];

export function serviceEnv({ port }, env = process.env) {
  const piCwd = firstSet(env.PI_CWD, process.cwd());
  const passed = Object.fromEntries(PASS_ENV_ALL.filter((k) => env[k]).map((k) => [k, env[k]]));
  return {
    PATH: firstSet(env.PATH, "/usr/local/bin:/usr/bin:/bin"),
    HOME: firstSet(env.HOME, os.homedir()),
    PI_CWD: piCwd,
    OC_CWD: firstSet(env.OC_CWD, piCwd),
    SWITCHBOARD_PORT: String(port),
    ...passed,
  };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist({ env, logFile }) {
  const args = ["/usr/bin/caffeinate", "-i", "/usr/bin/env", "-u", "NODE_OPTIONS", "switchboard-pair", "--quiet"];
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xml(env.PI_CWD)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

// systemd quoting: backslash/quote escapes, and % is a specifier prefix.
const sq = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function renderUnit({ env }) {
  return `[Unit]
Description=Agent Switchboard worker (pi + OpenCode for a remote coordinator)
After=network-online.target

[Service]
ExecStart=/usr/bin/env -u NODE_OPTIONS switchboard-pair --quiet
WorkingDirectory=${env.PI_CWD}
${Object.entries(env).map(([k, v]) => `Environment=${sq(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function paths(home = os.homedir()) {
  if (process.platform === "darwin") {
    return {
      file: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
      logFile: path.join(home, "Library", "Logs", "switchboard-worker.log"),
    };
  }
  return { file: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", "switchboard-worker.service") };
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "pipe" });
const tryRun = (cmd, args) => { try { run(cmd, args); } catch {} };
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
const UNIT = "switchboard-worker.service";

// Per-platform service managers: write the file, then (re)start / stop.
const MANAGERS = {
  darwin: {
    install(p, env) {
      fs.mkdirSync(path.dirname(p.logFile), { recursive: true });
      fs.writeFileSync(p.file, renderPlist({ env, logFile: p.logFile }), { mode: 0o600 });
      tryRun("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
      run("launchctl", ["bootstrap", `gui/${uid()}`, p.file]);
      return p.logFile;
    },
    stop() { tryRun("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]); },
    after() {},
  },
  linux: {
    install(p, env) {
      fs.writeFileSync(p.file, renderUnit({ env }), { mode: 0o600 });
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", UNIT]);
      tryRun("systemctl", ["--user", "restart", UNIT]);
      return "journalctl --user -u switchboard-worker -f";
    },
    stop() { tryRun("systemctl", ["--user", "disable", "--now", UNIT]); },
    after() { tryRun("systemctl", ["--user", "daemon-reload"]); },
  },
};

function manager() {
  const m = MANAGERS[process.platform];
  if (!m) throw new Error("background service supports macOS and Linux; on Windows keep `switchboard-pair` running in a terminal");
  return m;
}

export function installService({ port }) {
  const m = manager();
  const env = serviceEnv({ port });
  const p = paths();
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  const logs = m.install(p, env);
  return { file: p.file, logs, env };
}

export function removeService() {
  const m = MANAGERS[process.platform];
  const p = paths();
  m?.stop();
  const existed = fs.existsSync(p.file);
  try { fs.unlinkSync(p.file); } catch {}
  m?.after();
  return existed;
}

export function serviceInstalled() {
  return fs.existsSync(paths().file);
}
