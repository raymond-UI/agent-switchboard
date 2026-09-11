#!/bin/bash
# Worktree setup: default safer mode (PRD 7.3).
# Usage: ./scripts/setup-worktree.sh <project-dir> [branch-name]
set -euo pipefail
PROJECT="${1:?Usage: setup-worktree.sh <project-dir> [branch-name]}"
BRANCH="${2:-pi/work}"
PI_DIR="$(cd "$PROJECT" && pwd)-pi"
SHARED_BUS="$HOME/.agentbus/$(basename "$PROJECT")"

git -C "$PROJECT" worktree add "$PI_DIR" -b "$BRANCH" 2>/dev/null || git -C "$PROJECT" worktree add "$PI_DIR" "$BRANCH" || true
mkdir -p "$SHARED_BUS"
cat <<EOF
Worktree ready:
  claude dir: $PROJECT
  pi dir:     $PI_DIR  (export PI_CWD=$PI_DIR)
  shared bus: $SHARED_BUS  (export AGENT_BUS=$SHARED_BUS on BOTH sides)

Next:
  export AGENT_BUS=$SHARED_BUS
  export PI_CWD=$PI_DIR
  cp pi-extensions/claude-bridge.ts ~/.pi/agent/extensions/claude-bridge.ts
  claude mcp add pi-bridge -s user -- node $PWD/bridge/mcp-server.mjs
EOF
