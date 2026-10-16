// Cross-machine pairing state, shared by pair/connect/serve and both hooks.
// Worker box: worker.json {token, port} (minted once by switchboard-pair).
// Coordinator box: remote.json {url, token, host, piCwd, ocCwd} (written by
// switchboard-connect). Hooks read remote.json so settings never change
// between local and remote mode. Dir override: SWITCHBOARD_CONFIG_DIR.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

function platformConfigRoot(env) {
  if (process.platform === "win32") return env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function configDir(env = process.env) {
  return env.SWITCHBOARD_CONFIG_DIR || path.join(platformConfigRoot(env), "switchboard");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeSecret(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

const workerFile = (env) => path.join(configDir(env), "worker.json");
export const remoteFile = (env) => path.join(configDir(env), "remote.json");

export function loadWorker(env = process.env) {
  return readJson(workerFile(env));
}

// Token persists across pair runs (connected coordinators keep working);
// rotate=true mints a new one and invalidates every existing pairing.
export function ensureWorker({ port = 4598, rotate = false } = {}, env = process.env) {
  const cur = loadWorker(env);
  const rec = {
    token: !rotate && cur?.token ? cur.token : randomBytes(24).toString("hex"),
    port,
  };
  writeSecret(workerFile(env), rec);
  return rec;
}

export function loadRemote(env = process.env) {
  const rec = readJson(remoteFile(env));
  return rec && rec.url && rec.token ? rec : null;
}

export function saveRemote(rec, env = process.env) {
  writeSecret(remoteFile(env), rec);
}

export function clearRemote(env = process.env) {
  try { fs.unlinkSync(remoteFile(env)); return true; } catch { return false; }
}

// First non-empty value (env vars may be set to "").
export const firstSet = (...vals) => vals.find((v) => v) ?? null;

// Hook-side resolution: explicit env beats the paired remote.json.
export function resolveRemote(env = process.env) {
  const saved = loadRemote(env) ?? {};
  const url = firstSet(env.AGENT_BUS_REMOTE, saved.url);
  if (!url) return null;
  return { url: url.replace(/\/$/, ""), token: firstSet(env.SWITCHBOARD_TOKEN, saved.token) };
}

// Pair code: "sb1." + base64url(JSON{u: [candidate urls], t: token}).
// Several urls because the worker can't know which of its addresses the
// coordinator can reach (LAN, Tailscale, mDNS); connect probes them.
export function encodeCode({ urls, token }) {
  return "sb1." + Buffer.from(JSON.stringify({ u: urls, t: token })).toString("base64url");
}

function codeBody(code) {
  const m = String(code ?? "").trim().match(/^sb1\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("not a switchboard pair code (expected sb1.…)");
  return JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
}

export function decodeCode(code) {
  const { u, t } = codeBody(code);
  const urls = [u].flat().filter((x) => typeof x === "string");
  if (!urls.length || typeof t !== "string") throw new Error("pair code is incomplete");
  return { urls, token: t };
}

// Reachable-address guesses, best first: Tailscale (works off-LAN), LAN
// IPv4, then <hostname>.local (mDNS).
const isTailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
const isUsableV4 = (a) => !a.internal && (a.family === "IPv4" || a.family === 4) && !a.address.startsWith("169.254.");

function mdnsName() {
  const hn = os.hostname();
  if (!hn) return [];
  return [hn.endsWith(".local") ? hn : `${hn}.local`];
}

export function candidateHosts() {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && isUsableV4(a)).map((a) => a.address);
  const ordered = [...ips.filter(isTailscale), ...ips.filter((ip) => !isTailscale(ip)), ...mdnsName()];
  return [...new Set(ordered)];
}
