#!/bin/bash
# Provision a machine in ~10 min (PRD scope): install ext, register MCP + hook.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_BUS="${AGENT_BUS:-$PWD/.agentbus}"
mkdir -p "$AGENT_BUS" ~/.pi/agent/extensions ~/.claude/hooks 2>/dev/null || true
cp "$HERE/pi-extensions/claude-bridge.ts" ~/.pi/agent/extensions/claude-bridge.ts
echo "Extension installed."
if command -v claude >/dev/null 2>&1; then
  claude mcp add pi-bridge -s user -- node "$HERE/bridge/mcp-server.mjs" || true
  echo "MCP registered. Add Stop hook to ~/.claude/settings.json:"
else
  echo "claude CLI not found; register MCP manually:"
  echo "  claude mcp add pi-bridge -s user -- node $HERE/bridge/mcp-server.mjs"
fi
cat <<EOF
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node $HERE/hooks/pi-inbox.mjs" }] }]
  }
}
EOF
echo "AGENT_BUS=$AGENT_BUS (export on both sides when dirs differ)"
