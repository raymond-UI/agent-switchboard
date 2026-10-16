#!/usr/bin/env node
// Step 1 of 2, on the WORKER machine: `switchboard-pair`.
// Mints (or reuses) the bearer token, prints a one-line pair code for the
// coordinator, then serves the bridge on the network. Flags:
//   --service         install as a background service (login/reboot/crash
//                     safe) instead of serving in this terminal
//   --remove-service  stop and uninstall the background service
//   --port <n>        listen port (default 4598, or the last paired port)
//   --rotate          new token; every existing coordinator must reconnect
//   --print           print the code only, don't serve
//   --quiet           serve without printing (what the service runs)

import { ensureWorker, loadWorker, encodeCode, candidateHosts } from "../bridge/remote.mjs";
import { installService, removeService, serviceInstalled } from "./service.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);

if (flag("--remove-service")) {
  console.log(removeService() ? "Background worker stopped and removed." : "No background worker was installed.");
  process.exit(0);
}

const portArg = args[args.indexOf("--port") + 1];
const port = args.includes("--port") && /^\d+$/.test(portArg || "")
  ? parseInt(portArg, 10)
  : parseInt(process.env.SWITCHBOARD_PORT || "", 10) || loadWorker()?.port || 4598;

const { token } = ensureWorker({ port, rotate: flag("--rotate") });

if (!flag("--quiet")) {
  const urls = candidateHosts().map((h) => `http://${h}:${port}`);
  console.log("");
  console.log("On the coordinator machine, run:");
  console.log("");
  console.log(`  switchboard-connect ${encodeCode({ urls, token })}`);
  console.log("");
  console.log(`Advertised: ${urls.join(", ")}`);
  console.log(`Workers run in: pi ${process.env.PI_CWD || process.cwd()}, OpenCode ${process.env.OC_CWD || process.env.PI_CWD || process.cwd()} (set PI_CWD / OC_CWD, or run this from the project dir)`);
  console.log("The code contains the access token; treat it like a password. Rotate: switchboard-pair --rotate");
  console.log("");
}

if (flag("--service")) {
  try {
    const svc = installService({ port });
    console.log(`Background worker installed and running (${svc.file}).`);
    console.log(`Logs: ${svc.logs}`);
    console.log("Starts at login, restarts on crash. Changed PI_CWD/model/env? Re-run switchboard-pair --service.");
    if (process.platform === "darwin") console.log("Idle sleep is blocked while it runs; lid-close/manual sleep still pauses it.");
    if (process.platform === "linux") console.log("Headless box (no login)? Run once: sudo loginctl enable-linger $USER");
    console.log("Provider API keys from your shell env are NOT copied; pi/OpenCode logins work as-is.");
  } catch (err) {
    console.error(`Could not install the service: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (flag("--print")) process.exit(0);

if (!flag("--quiet") && serviceInstalled()) {
  console.log("Note: a background worker is installed; if it's running, this port is taken. Stop it: switchboard-pair --remove-service");
}

// Serve on all interfaces; the token is required (http-server refuses a
// non-loopback bind without one). SWITCHBOARD_HOST still wins if set.
process.env.SWITCHBOARD_TOKEN = token;
process.env.SWITCHBOARD_HOST ||= "0.0.0.0";
process.env.SWITCHBOARD_PORT = String(port);
process.argv = process.argv.slice(0, 2);
await import("../bridge/http-server.mjs");
