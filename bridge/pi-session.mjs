// pi transport: owns `pi --mode rpc` child, LF-only framing, id correlation,
// agent_settled completion, extension_ui auto-response, per-run telemetry.
// (PRD 6.1)

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { childDepthEnv } from "./env.mjs";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiSession {
  constructor(opts = {}) {
    this.piBin = opts.piBin || process.env.PI_BIN || "pi";
    this.piCwd = opts.piCwd || process.env.PI_CWD || process.cwd();
    this.piModel = opts.piModel ?? process.env.PI_MODEL ?? null;
    this.piName = opts.piName ?? process.env.PI_NAME ?? "paired-with-claude-code";
    this.piSessionDir = opts.piSessionDir ?? process.env.PI_SESSION_DIR ?? null;
    this.defaultTimeoutMs =
      opts.askTimeoutMs ?? parseInt(process.env.PI_ASK_TIMEOUT_MS || "900000", 10);
    this.extraArgs = opts.extraArgs || (process.env.PI_EXTRA_ARGS ? process.env.PI_EXTRA_ARGS.split(/\s+/) : []);

    this.child = null;
    this.started = false;
    this.exited = false;
    this.exitInfo = null;
    this.buf = "";
    this.pending = new Map(); // id -> {resolve,reject,command,timer}
    this.isStreaming = false;
    this.settledCount = 0;
    this.sessionFile = null;
    this.lastNotices = [];
    // per-run telemetry accumulator
    this.runTelemetry = null;
    // serialize ask() calls so concurrent asks queue rather than error
    this.askChain = Promise.resolve();
    this.spawnError = null;
    // Detach flag: a timed-out ask leaves the worker RUNNING (no auto-abort).
    // The next ask drains this run before sending a new prompt so a stale
    // settle can't be misattributed to the new prompt.
    this.detachedRun = false;
  }

  // Bridge-owned pi never needs update checks/package telemetry at startup;
  // default them off (honor an explicit PI_OFFLINE=0). Saves seconds per boot.
  // Also strips NODE_OPTIONS: hostile host envs (e.g. a multiplexer preload
  // pointing at a purged temp file) would otherwise kill node before main.
  spawnEnv() {
    const env = {
      ...childDepthEnv(process.env),
      PI_OFFLINE: process.env.PI_OFFLINE ?? "1",
    };
    delete env.NODE_OPTIONS;
    return env;
  }

  buildArgs() {
    const args = [...this.extraArgs, "--mode", "rpc"];
    if (this.piModel) args.push("--model", this.piModel);
    if (this.piName) args.push("--name", this.piName);
    if (this.piSessionDir) args.push("--session-dir", this.piSessionDir);
    return args;
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.resetRunTelemetry();
    const args = this.buildArgs();
    try {
      this.child = spawn(this.piBin, args, {
        cwd: this.piCwd,
        env: this.spawnEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.spawnError = err;
      throw err;
    }
    this.child.on("error", (err) => {
      this.spawnError = err;
      this.exited = true;
      this.exitInfo = { code: null, signal: null, error: String(err.message || err) };
      this.failAllPending(err);
    });
    const onExit = (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      const err = new Error(
        `pi process exited (code=${code}, signal=${signal ?? "none"}). Pending commands rejected.`
      );
      this.failAllPending(err);
    };
    this.child.on("exit", onExit);
    // Spawn failures (ENOENT) may emit 'close' without 'exit' on some platforms.
    this.child.on("close", (code, signal) => {
      if (!this.exited) onExit(code, signal);
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    // stderr from pi: keep for debugging, surface via notices on failure
    this.piStderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.piStderr += chunk.toString("utf8").slice(-4000);
    });
  }

  failAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // A dead process will never settle: fail settle-waiters fast instead
    // of hanging until ask timeout (PRD: reject, don't hang).
    if (this.settledWaiters) {
      const w = this.settledWaiters;
      this.settledWaiters = null;
      for (const waiter of w) waiter.fail(err);
    }
  }

  // LF-only framing. Never use readline (splits U+2028/U+2029).
  onStdout(chunk) {
    this.buf += chunk.toString("utf8");
    while (true) {
      const idx = this.buf.indexOf("\n");
      if (idx === -1) break;
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip unparseable
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    // Extension UI requests (stdout, expect stdin response for dialogs)
    if (msg.type === "extension_ui_request") {
      this.handleExtensionUiRequest(msg);
      return;
    }
    if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.data ?? null);
      else p.reject(new Error(msg.error || `pi command '${msg.command}' failed`));
      return;
    }
    this.onEvent(msg);
  }

  handleExtensionUiRequest(req) {
    const { id, method } = req;
    const label = `${method}${req.title ? `: ${req.title}` : ""}`;
    if (DIALOG_METHODS.has(method)) {
      // Nobody is at pi's terminal: cancel immediately so session never hangs.
      this.pushNotice(`extension dialog '${label}' auto-cancelled (headless RPC)`);
      this.recordTelemetry("dialogCancelled", label);
      if (id) this.writeRaw({ type: "extension_ui_response", id, cancelled: true });
    } else {
      // Fire-and-forget: record only.
      this.pushNotice(`pi ui ${method}: ${(req.message || req.statusText || req.title || "").slice(0, 300)}`);
    }
  }

  pushNotice(text) {
    const target = this.runTelemetry ? this.runTelemetry.notices : this.lastNotices;
    target.push(String(text));
  }

  recordTelemetry(key, value) {
    if (!this.runTelemetry) return;
    if (key === "tool") this.runTelemetry.tools.push(value);
    else if (key === "dialogCancelled") this.runTelemetry.dialogs.push(value);
    else if (key === "extensionError")
      this.runTelemetry.extensionErrors.push(value);
  }

  resetRunTelemetry() {
    this.runTelemetry = {
      tools: [],
      compactions: 0,
      retries: 0,
      extensionErrors: [],
      dialogs: [],
      notices: [],
    };
  }

  onEvent(ev) {
    switch (ev.type) {
      case "agent_start":
        this.isStreaming = true;
        break;
      case "agent_settled":
        this.isStreaming = false;
        this.settledCount += 1;
        this.detachedRun = false;
        if (this.settledWaiters) {
          const w = this.settledWaiters;
          this.settledWaiters = null;
          for (const waiter of w) waiter.done();
        }
        break;
      case "agent_end":
        // Deliberately NOT completion (may be followed by retry/compaction).
        break;
      case "tool_execution_start":
        if (ev.toolName) this.recordTelemetry("tool", ev.toolName);
        break;
      case "compaction_start":
        break;
      case "compaction_end":
        if (this.runTelemetry) this.runTelemetry.compactions += 1;
        this.pushNotice(
          `compaction (${ev.reason || "unknown"}${ev.aborted ? ", aborted" : ""})`
        );
        break;
      case "auto_retry_start":
        if (this.runTelemetry) this.runTelemetry.retries += 1;
        this.pushNotice(`auto-retry attempt ${ev.attempt ?? "?"}: ${(ev.errorMessage || "").slice(0, 200)}`);
        break;
      case "extension_error":
        this.recordTelemetry("extensionError", `${ev.extensionPath || "ext"} ${ev.event || ""}: ${ev.error || ""}`.slice(0, 300));
        this.pushNotice(`extension error: ${(ev.error || "").slice(0, 200)}`);
        break;
      case "queue_update":
        break;
      default:
        break;
    }
    if (ev.sessionFile) this.sessionFile = ev.sessionFile;
  }

  writeRaw(obj) {
    this.ensureStarted();
    if (!this.child || this.exited) throw new Error("pi process is not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n", "utf8");
  }

  sendCommand(cmd, { timeoutMs = 30000 } = {}) {
    this.ensureStarted();
    if (this.exited) return Promise.reject(new Error("pi process has exited"));
    if (this.spawnError) return Promise.reject(this.spawnError);
    const id = cmd.id || randomUUID();
    const frame = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${frame.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Avoid unref issues in tests: keep ref.
      this.pending.set(id, { resolve, reject, command: frame.type, timer });
      try {
        this.child.stdin.write(JSON.stringify(frame) + "\n", "utf8");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  waitForSettled(timeoutMs, sinceSettledCount = null) {
    // Wait for a NEW agent_settled (after the prompt), not just idle state.
    // The prompt ack can arrive before agent_start, so checking isStreaming
    // alone races. sinceSettledCount anchors the wait.
    if (sinceSettledCount !== null && this.settledCount > sinceSettledCount) return Promise.resolve();
    if (sinceSettledCount === null && !this.isStreaming) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // remove waiter
        if (this.settledWaiters) {
          const i = this.settledWaiters.findIndex((w) => w.done === done);
          if (i >= 0) this.settledWaiters.splice(i, 1);
        }
        reject(new Error(`timed out waiting for pi to settle after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const fail = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      if (!this.settledWaiters) this.settledWaiters = [];
      this.settledWaiters.push({ done, fail });
      // Re-check: settled may have arrived between anchor and waiter install.
      if (sinceSettledCount !== null && this.settledCount > sinceSettledCount) {
        const i = this.settledWaiters.findIndex((w) => w.done === done);
        if (i >= 0) this.settledWaiters.splice(i, 1);
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Prompt pi and wait for settle. Serialized: concurrent calls queue.
   * Returns {text, toolsUsed, notices, compactions, retries, ...}
   */
  ask(message, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const run = () =>
      this.askInner(message, { timeoutMs }).catch((err) => {
        throw err;
      });
    // Chain to serialize; keep chain alive even on rejection.
    const prev = this.askChain;
    const next = prev.then(run, run);
    this.askChain = next.catch(() => {});
    return next;
  }

  async askInner(message, { timeoutMs }) {
    this.ensureStarted();
    // Catch-up: the previous ask timed out detached and may still be running.
    // Drain it BEFORE sending a new prompt so its settle can't resolve the
    // new wait early (that would return the old run's text for the new task).
    if (this.detachedRun) {
      try {
        await this.waitForSettled(timeoutMs, null);
      } catch {
        throw new Error(
          `pi_ask failed: previous run still going after ${timeoutMs}ms (detached, no abort). Check pi_state; re-run pi_ask to wait again; pi_abort to kill.`
        );
      }
      this.detachedRun = false;
    }
    this.resetRunTelemetry();
    const streaming = this.isStreaming;
    const cmd = streaming
      ? { type: "prompt", message, streamingBehavior: "followUp" }
      : { type: "prompt", message };
    let accepted = false;
    try {
      const anchor = this.settledCount;
      await this.sendCommand(cmd, { timeoutMs: Math.min(timeoutMs, 60000) });
      accepted = true;
      await this.waitForSettled(timeoutMs, anchor);
    } catch (err) {
      // On timeout: DETACH, don't abort. The worker keeps going so long jobs
      // (e.g. an 11-min CI leg) survive the ceiling. Kill only via pi_abort.
      if (/timed out/i.test(err.message)) {
        this.detachedRun = true;
        throw new Error(
          `pi_ask timed out after ${timeoutMs}ms but worker still running (detached, no abort). Check pi_state; re-run pi_ask to wait again / queue follow-up; pi_abort to kill.`
        );
      }
      throw new Error(`pi_ask failed: ${err.message}`);
    }
    this.detachedRun = false;
    // Fetch final text + stats (best effort; never fail the ask on these).
    let text = null;
    let stats = null;
    let st = null;
    try {
      text = await this.sendCommand({ type: "get_last_assistant_text" }, { timeoutMs: 15000 });
      text = text && typeof text.text === "string" ? text.text : null;
    } catch {}
    try {
      stats = await this.sendCommand({ type: "get_session_stats" }, { timeoutMs: 15000 });
    } catch {}
    try {
      st = await this.sendCommand({ type: "get_state" }, { timeoutMs: 15000 });
      if (st && st.sessionFile) this.sessionFile = st.sessionFile;
    } catch {}
    const t = this.runTelemetry || { tools: [], compactions: 0, retries: 0, extensionErrors: [], dialogs: [], notices: [] };
    return {
      text: text ?? "(pi settled with no assistant text)",
      toolsUsed: [...new Set(t.tools)],
      notices: [...t.notices],
      dialogsCancelled: [...t.dialogs],
      extensionErrors: [...t.extensionErrors],
      compactions: t.compactions,
      retries: t.retries,
      tokens: stats?.tokens ?? null,
      cost: stats?.cost ?? null,
      contextUsage: stats?.contextUsage ?? null,
      sessionFile: stats?.sessionFile || this.sessionFile || st?.sessionFile || null,
      acceptedWhileStreaming: streaming && accepted,
    };
  }

  async steer(message) {
    this.ensureStarted();
    return this.sendCommand({ type: "steer", message }, { timeoutMs: 15000 });
  }

  async abort() {
    this.ensureStarted();
    try {
      return await this.sendCommand({ type: "abort" }, { timeoutMs: 15000 });
    } finally {
      // If abort hangs, waiters will time out; force streaming false on exit only.
    }
  }

  /**
   * Start a fresh session in the same pi process (clean context for a new
   * task). Previous history is dropped. If a run is active, abort first.
   * Returns {cancelled, sessionFile}.
   */
  async newSession() {
    this.ensureStarted();
    if (this.isStreaming) {
      try {
        await this.abort();
      } catch {}
      // Give the abort a moment to settle; bounded so this can't hang.
      try {
        await this.waitForSettled(15000, null);
      } catch {}
    }
    const data = await this.sendCommand({ type: "new_session" }, { timeoutMs: 15000 });
    this.resetRunTelemetry();
    this.sessionFile = data?.sessionFile || data?.session || null;
    // Fresh session: no run in flight; telemetry reset above.
    return { cancelled: data?.cancelled === true, sessionFile: this.sessionFile };
  }

  async state() {
    this.ensureStarted();
    const [st, stats] = await Promise.all([
      this.sendCommand({ type: "get_state" }, { timeoutMs: 15000 }).catch(() => null),
      this.sendCommand({ type: "get_session_stats" }, { timeoutMs: 15000 }).catch(() => null),
    ]);
    return {
      model: st?.model ?? null,
      thinkingLevel: st?.thinkingLevel ?? null,
      isStreaming: st?.isStreaming ?? this.isStreaming,
      detachedRun: this.detachedRun === true,
      askTimeoutMs: this.defaultTimeoutMs,
      messageCount: st?.messageCount ?? stats?.totalMessages ?? null,
      pendingMessageCount: st?.pendingMessageCount ?? null,
      sessionFile: st?.sessionFile ?? stats?.sessionFile ?? this.sessionFile,
      sessionName: st?.sessionName ?? null,
      tokens: stats?.tokens ?? null,
      cost: stats?.cost ?? null,
      contextUsage: stats?.contextUsage ?? null,
      toolCalls: stats?.toolCalls ?? null,
    };
  }

  async entries(since) {
    this.ensureStarted();
    const cmd = since ? { type: "get_entries", since } : { type: "get_entries" };
    return this.sendCommand(cmd, { timeoutMs: 15000 });
  }

  async stop() {
    if (!this.child || this.exited || this.child.exitCode !== null) {
      this.exited = true;
      return;
    }
    return new Promise((resolve) => {
      const child = this.child;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        this.exited = true;
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        // Force-resolve even if 'exit' never fires (already-dead child).
        setTimeout(finish, 1000);
      }, 3000);
      child.on("exit", finish);
      child.on("close", finish);
      child.on("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }
}
