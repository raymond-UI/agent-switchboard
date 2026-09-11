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
