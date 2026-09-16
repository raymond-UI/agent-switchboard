// Shared environment contract (PRD section 5).
// Every component resolves paths the same way. Nothing hardcodes a path.

import path from "node:path";

export function resolveConfig(env = process.env) {
  const piCwd = env.PI_CWD || process.cwd();
  // AGENT_BUS default: $PI_CWD/.agentbus. Hook falls back to CLAUDE_PROJECT_DIR.
  const agentBus =
    env.AGENT_BUS ||
    (env.CLAUDE_PROJECT_DIR
      ? path.join(env.CLAUDE_PROJECT_DIR, ".agentbus")
      : path.join(piCwd, ".agentbus"));

  return {
    agentBus,
    piCwd,
    piBin: env.PI_BIN || "pi",
    piModel: env.PI_MODEL || null,
    piName: env.PI_NAME || "paired-with-claude-code",
    piSessionDir: env.PI_SESSION_DIR || null,
    askTimeoutMs: parseInt(env.PI_ASK_TIMEOUT_MS || "900000", 10),
    maxConsecutiveBlocks: parseInt(env.PI_MAX_CONSECUTIVE_BLOCKS || "3", 10),
    bridgeLaunchDir: process.cwd(),
  };
}

// ---- Multi-orchestrator depth guard ----
// Delegation depth travels in env across every spawn boundary (bridge ⭢ pi,
// bridge ⭢ opencode serve, extension ⭢ claude/opencode subprocess). Each
// delegate tool refuses at the cap so A⭢B⭢A loops die with a clear error
// instead of burning money forever. Gated by SWITCHBOARD_MULTI_ORCH.
export function multiOrchEnabled(env = process.env) {
  return ["1", "true", "yes"].includes(String(env.SWITCHBOARD_MULTI_ORCH || "").toLowerCase());
}

export function maxDepth(env = process.env) {
  const n = parseInt(env.SWITCHBOARD_MAX_DEPTH || "2", 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

export function currentDepth(env = process.env) {
  const n = parseInt(env.SWITCHBOARD_DEPTH || "0", 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function depthCheck(env = process.env) {
  const d = currentDepth(env);
  const m = maxDepth(env);
  return d < m ? null : `delegation depth ${d} at cap (max ${m}); refusing to avoid an orchestration loop`;
}

export function childDepthEnv(env = process.env) {
  return { ...env, SWITCHBOARD_DEPTH: String(currentDepth(env) + 1) };
}

export function busFile(agentBus) {
  return path.join(agentBus, "to-claude.jsonl");
}

export function busInfoFile(agentBus) {
  return path.join(agentBus, ".bus-info.json");
}

export function hookCounterFile(agentBus) {
  return path.join(agentBus, ".hook-counter.json");
}

export function hookWarnedFile(agentBus) {
  return path.join(agentBus, ".hook-warned.json");
}
