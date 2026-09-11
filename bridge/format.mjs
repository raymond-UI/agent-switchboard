// Result formatting for delegated answers (P4 context-tax controls).
// Kept side-effect free so tests can import it without starting servers.

import fs from "node:fs";
import path from "node:path";

export function resultCap(env = process.env) {
  const n = parseInt(env.RESULT_CAP || "8000", 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

// Cap text pasted back into Claude's context (RESULT_CAP, default 8000
// chars). Overflow spills to $AGENT_BUS/results/ with a pointer so nothing
// is lost, but the per-turn tax stays bounded.
export function capResult(text, agentBus, env = process.env) {
  const cap = resultCap(env);
  if (text.length <= cap) return text;
  const dir = path.join(agentBus, "results");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.floor(Math.random() * 1e6).toString(36)}.md`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return text.slice(0, cap) + `\n\n[... truncated ${text.length - cap} chars; full result: ${file}]`;
}

export function formatAskResult(r) {
  const parts = [];
  parts.push(r.text || "(empty)");
  parts.push("");
  parts.push(`Tools used: ${r.toolsUsed.length ? r.toolsUsed.join(", ") : "(none)"}`);
  if (r.tokens) parts.push(`Tokens: ${JSON.stringify(r.tokens)}`);
  if (typeof r.cost !== "undefined" && r.cost !== null) parts.push(`Cost: ${r.cost}`);
  if (r.contextUsage) parts.push(`Context: ${JSON.stringify(r.contextUsage)}`);
  if (r.compactions) parts.push(`Compactions: ${r.compactions}`);
  if (r.retries) parts.push(`Auto-retries: ${r.retries}`);
  if (r.notices.length) parts.push(`Notices:\n- ${r.notices.join("\n- ")}`);
  if (r.sessionFile) parts.push(`worker session: ${r.sessionFile}`);
  else if (r.sessionId) parts.push(`worker session: ${r.sessionId}`);
  return parts.join("\n");
}
