// OpenCode transport: owns `opencode serve` + drives one session over HTTP.
// Mirrors PiSession's surface (ask/steer-less/abort/state/messages/newSession)
// so the MCP layer stays uniform. Settle = SSE `session.idle` for our
// session id (PRD deadlock rule applies equally: never block the bridge
// waiting on a callback into Claude).
// (Mesh step 4.)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export class OcSession {
  constructor(opts = {}) {
    this.ocBin = opts.ocBin || process.env.OC_BIN || "opencode";
    this.ocCwd = opts.ocCwd || process.env.OC_CWD || process.cwd();
    this.portStart = opts.portStart ?? parseInt(process.env.OC_PORT || "4597", 10);
    this.defaultTimeoutMs =
      opts.askTimeoutMs ?? parseInt(process.env.OC_ASK_TIMEOUT_MS || process.env.PI_ASK_TIMEOUT_MS || "900000", 10);
    const model = opts.ocModel ?? process.env.OC_MODEL ?? null;
    this.model = model && model.includes("/") ? model : null;
    // Tests / attach: use an existing server instead of spawning.
    this.baseUrl = opts.baseUrl || process.env.OC_BASE_URL || null;
    this.password = opts.password || process.env.OC_PASSWORD || null;
    this.ownedServer = false;

    this.server = null;
    this.serverPort = null;
    this.sessionId = null;
    this.askChain = Promise.resolve();
    this.lastNotices = [];
  }

  authHeaders() {
    if (!this.password) return {};
    return { Authorization: "Basic " + Buffer.from(`opencode:${this.password}`).toString("base64") };
  }

  async api(path, { method = "GET", body } = {}, { timeoutMs = 15000 } = {}) {
    if (!this.baseUrl) throw new Error("opencode server not started");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`opencode ${method} ${path} timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureServe() {
    if (this.baseUrl) {
      // Attached (tests or explicit OC_BASE_URL): verify health.
      await this.api("/global/health", {}, { timeoutMs: 10000 });
      return;
    }
    if (this.server) return;
    let lastErr = null;
    for (let port = this.portStart; port < this.portStart + 20; port++) {
      try {
        await this.spawnServe(port);
        this.ownedServer = true;
        return;
      } catch (err) {
        lastErr = err;
        if (!/in use|EADDRINUSE|busy/i.test(err.message)) throw err;
      }
    }
    throw new Error(`could not bind opencode serve on ports ${this.portStart}-${this.portStart + 19}: ${lastErr?.message}`);
  }

  spawnServe(port) {
    const password = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.ocBin, ["serve", "--port", String(port)], {
          cwd: this.ocCwd,
          env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err);
        return;
      }
      let out = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`opencode serve on :${port} did not come up in time: ${out.slice(-300)}`));
      }, 15000);
      const onData = (chunk) => {
        out += chunk.toString();
        if (/address already in use|EADDRINUSE/i.test(out)) {
          clearTimeout(timer);
          try { child.kill("SIGKILL"); } catch {}
          reject(new Error(`port ${port} busy`));
        }
        const m = out.match(/listening on http:\/\/[^:]+:(\d+)/);
        if (m) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.stderr.off("data", onData);
          this.server = child;
          this.serverPort = parseInt(m[1], 10);
          this.baseUrl = `http://127.0.0.1:${this.serverPort}`;
          this.password = password;
          child.on("exit", () => {
            if (this.server === child) {
              this.server = null;
              this.baseUrl = null;
            }
          });
          this.api("/global/health", {}, { timeoutMs: 10000 }).then(() => resolve(), reject);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async ensureSession() {
    await this.ensureServe();
    if (this.sessionId) return this.sessionId;
    const res = await this.api("/session", { method: "POST", body: { directory: this.ocCwd } });
    this.sessionId = res?.data?.id || res?.id;
    if (!this.sessionId) throw new Error("opencode session create returned no id");
    return this.sessionId;
  }

  promptBody(message) {
    const parts = [{ type: "text", text: message }];
    if (!this.model) return { parts };
    const [providerID, ...rest] = this.model.split("/");
    return { parts, model: { providerID, modelID: rest.join("/") } };
  }

  /**
   * Ask opencode something and wait for session.idle (SSE). Serialized like
   * PiSession.ask: concurrent asks queue.
   */
  ask(message, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const run = () => this.askInner(message, { timeoutMs });
    const prev = this.askChain;
    const next = prev.then(run, run);
    this.askChain = next.catch(() => {});
    return next;
  }

  async askInner(message, { timeoutMs }) {
    const sid = await this.ensureSession();
    try {
      // Subscribe BEFORE prompting: a fast run could otherwise settle
      // before the event stream is up (same race class as pi agent_start).
      await this.promptAndWait(sid, message, timeoutMs);
    } catch (err) {
      if (/timed out/i.test(err.message)) {
        try { await this.abort(); } catch {}
        throw new Error(`oc_ask failed: ${err.message}`);
      }
      throw new Error(`oc_ask failed: ${err.message}`);
    }
    return this.collectResult(sid);
  }

  promptAndWait(sid, message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      let stream = null;
      const killTimer = setTimeout(() => finish(new Error(`timed out waiting for opencode to settle after ${timeoutMs}ms`)), timeoutMs + 5000);
      if (typeof killTimer.unref === "function") killTimer.unref();
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        try { stream?.cancel().catch(() => {}); } catch {}
        try { sseCtrl?.abort(); } catch {}
        err ? reject(err) : resolve();
      };
      let sseCtrl = null;
      const fail = (err) => finish(err);
      (async () => {
        try {
          sseCtrl = new AbortController();
          const res = await fetch(this.baseUrl + "/event", {
            headers: { Accept: "text/event-stream", ...this.authHeaders() },
            signal: sseCtrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`);
          stream = res.body.getReader();
          // Stream is up. Now prompt; any session.idle from here on is ours
          // (asks are serialized, one run at a time per session).
          await this.api(`/session/${sid}/prompt_async`, {
            method: "POST",
            body: this.promptBody(message),
          }, { timeoutMs: 30000 });
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            if (Date.now() > deadline) {
              finish(new Error(`timed out waiting for opencode to settle after ${timeoutMs}ms`));
              return;
            }
            const { value, done: streamDone } = await stream.read();
            if (streamDone) { fail(new Error("event stream closed before settle")); return; }
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              try {
                const ev = JSON.parse(line.slice(5));
                if (ev?.type === "session.idle" && ev?.properties?.sessionID === sid) {
                  finish(null);
                  return;
                }
              } catch {}
            }
          }
        } catch (err) {
          if (settled || err?.name === "AbortError") return;
          fail(err);
        }
      })();
    });
  }

  async collectResult(sid) {
    const res = await this.api(`/session/${sid}/message`, {}, { timeoutMs: 15000 }).catch(() => null);
    const items = res?.data || res || [];
    let text = null;
    const toolsUsed = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const info = item.info || item;
      if (info?.role !== "assistant") continue;
      const parts = item.parts || info.parts || [];
      const texts = [];
      for (const p of parts) {
        if (p.type === "text" && p.text) texts.push(p.text);
        else if (p.type === "tool" && p.tool) toolsUsed.push(p.tool);
      }
      if (texts.length) {
        text = texts.join("\n");
        break;
      }
    }
    let sess = null;
    try {
      const s = await this.api(`/session/${sid}`, {}, { timeoutMs: 15000 });
      sess = s?.data || s;
    } catch {}
    return {
      text: text ?? "(opencode settled with no assistant text)",
      toolsUsed: [...new Set(toolsUsed)],
      notices: [...this.lastNotices],
      tokens: sess?.tokens ?? null,
      cost: sess?.cost ?? null,
      sessionId: sid,
    };
  }

  /**
   * Queue a mid-run correction. Verified live: OpenCode treats a prompt
   * sent while busy as a QUEUED FOLLOW-UP turn (the current run finishes
   * first) — no mid-turn interrupt. Best-effort, returns immediately.
   */
  async steer(message) {
    const sid = await this.ensureSession();
    await this.api(`/session/${sid}/prompt_async`, {
      method: "POST",
      body: this.promptBody(message),
    }, { timeoutMs: 15000 });
    return true;
  }

  async abort() {
    await this.ensureSession();
    try {
      await this.api(`/session/${this.sessionId}/abort`, { method: "POST" }, { timeoutMs: 15000 });
    } catch {}
    return true;
  }

  async state() {
    await this.ensureSession();
    const s = await this.api(`/session/${this.sessionId}`, {}, { timeoutMs: 15000 }).catch(() => null);
    const sess = s?.data || s;
    return {
      agent: "opencode",
      sessionId: this.sessionId,
      directory: sess?.location?.directory || sess?.directory || this.ocCwd,
      title: sess?.title || null,
      tokens: sess?.tokens ?? null,
      cost: sess?.cost ?? null,
      serverPort: this.serverPort,
      ownedServer: this.ownedServer,
    };
  }

  async newSession() {
    await this.ensureServe();
    const old = this.sessionId;
    if (old) {
      try { await this.abort(); } catch {}
      try { await this.api(`/session/${old}`, { method: "DELETE" }, { timeoutMs: 15000 }); } catch {}
    }
    this.sessionId = null;
    this.lastNotices = [];
    const sid = await this.ensureSession();
    return { cancelled: false, sessionId: sid };
  }

  async stop() {
    if (this.sessionId && this.baseUrl) {
      try { await this.abort(); } catch {}
    }
    this.sessionId = null;
    if (this.server) {
      const child = this.server;
      this.server = null;
      this.baseUrl = null;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} setTimeout(finish, 1000); }, 3000);
        if (typeof t.unref === "function") t.unref();
        child.on("exit", finish);
        try { child.kill("SIGTERM"); } catch { finish(); }
      });
    }
  }
}
