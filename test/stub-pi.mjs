#!/usr/bin/env node
// Stub pi for tests: speaks enough of the RPC protocol to exercise the bridge.
// Mode via STUB_MODE env: happy | exit-mid | dialog | compaction | timeout-hang
// All framing LF-only.

const MODE = process.env.STUB_MODE || "happy";

let buf = "";
let streaming = false;
let lastText = null;
let seq = 0;
let sessionSeq = 1;
function sessionFile() { return `/tmp/stub-session-${sessionSeq}.jsonl`; }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, command, success, data, error) {
  const r = { type: "response", id, command, success };
  if (data !== undefined) r.data = data;
  if (error !== undefined) r.error = error;
  send(r);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function runHappy(id, message) {
  streaming = true;
  send({ type: "agent_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "/tmp/x.ts" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  await delay(20);
  lastText = `stub answer to: ${message}`;
  send({ type: "agent_end", messages: [], willRetry: false });
  await delay(10);
  streaming = false;
  send({ type: "agent_settled" });
}

async function runDialog(id, message) {
  streaming = true;
  send({ type: "agent_start" });
  const uiId = "ui-1";
  send({ type: "extension_ui_request", id: uiId, method: "select", title: "Pick?", options: ["a", "b"] });
  // wait for response (bridge should auto-cancel). Give it 2s.
  await delay(300);
  lastText = `stub answer after dialog: ${message}`;
  send({ type: "agent_end", messages: [], willRetry: false });
  await delay(10);
  streaming = false;
  send({ type: "agent_settled" });
}

async function runCompaction(id, message) {
  streaming = true;
  send({ type: "agent_start" });
  await delay(10);
  send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "overloaded" });
  send({ type: "auto_retry_end", success: true, attempt: 1 });
  send({ type: "compaction_start", reason: "threshold" });
  await delay(10);
  send({ type: "compaction_end", reason: "threshold", result: { summary: "s" }, aborted: false, willRetry: false });
  await delay(10);
  lastText = `stub answer after compaction: ${message}`;
  send({ type: "agent_end", messages: [], willRetry: false });
  await delay(10);
  streaming = false;
  send({ type: "agent_settled" });
}

async function handle(cmd) {
  const { id, type } = cmd;
  switch (type) {
    case "prompt": {
      if (streaming && !cmd.streamingBehavior) {
        respond(id, "prompt", false, undefined, "agent is streaming; streamingBehavior required");
        return;
      }
      respond(id, "prompt", true);
      const msg = cmd.message || "";
      if (MODE === "exit-mid") {
        send({ type: "agent_start" });
        await delay(30);
        process.exit(1);
        return;
      }
      if (MODE === "timeout-hang") {
        streaming = true;
        send({ type: "agent_start" });
        return; // never settles
      }
      if (MODE === "dialog") { runDialog(id, msg); return; }
      if (MODE === "compaction") { runCompaction(id, msg); return; }
      runHappy(id, msg);
      return;
    }
    case "steer":
      respond(id, "steer", true);
      return;
    case "follow_up":
      respond(id, "follow_up", true);
      return;
    case "abort":
      streaming = false;
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
      respond(id, "abort", true);
      return;
    case "new_session":
      sessionSeq += 1;
      lastText = null;
      streaming = false;
      respond(id, "new_session", true, { cancelled: false, sessionFile: sessionFile() });
      return;
    case "get_state":
      respond(id, "get_state", true, {
        model: { id: "stub", provider: "stub" },
        thinkingLevel: "medium",
        isStreaming: streaming,
        sessionFile: sessionFile(),
        sessionName: "stub",
        messageCount: 2,
        pendingMessageCount: 0,
      });
      return;
    case "get_session_stats":
      respond(id, "get_session_stats", true, {
        sessionFile: sessionFile(),
        sessionId: "stub",
        totalMessages: 2,
        toolCalls: 1,
        tokens: { input: 100, output: 50, total: 150 },
        cost: 0.001,
        contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
      });
      return;
    case "get_last_assistant_text":
      respond(id, "get_last_assistant_text", true, { text: lastText || "stub default text" });
      return;
    case "get_entries":
      seq += 1;
      respond(id, "get_entries", true, { entries: [], leafId: `leaf-${seq}` });
      return;
    case "clear_queue":
      respond(id, "clear_queue", true, { steering: [], followUp: [] });
      return;
    case "extension_ui_response":
      // stub records but ignores (dialog wait loop just times out internally)
      return;
    default:
      respond(id, cmd.type || "unknown", false, undefined, `unknown command: ${cmd.type}`);
      return;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      send({ type: "response", command: "parse", success: false, error: "parse error" });
    }
  }
});
