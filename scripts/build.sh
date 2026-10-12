#!/usr/bin/env bash
# Run the unattended build: Fable 5.1 orchestrates, Opus 5.5 subagents build/simplify/review.
# Billed to ANTHROPIC_API_KEY from .env, hard-capped by --max-budget-usd.
#   BUDGET=100 scripts/build.sh            start a new run
#   RESUME=<session_id> scripts/build.sh   continue a previous run
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env; set +a
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY missing from .env}"
export CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5
# Skills' own agents that ask for "sonnet" also run on Opus 5.5.
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-opus-5-5
# Headless mode otherwise kills background subagents 10 minutes after the orchestrator's last turn.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

mkdir -p build-logs
log="build-logs/$(date +%Y%m%d-%H%M%S).jsonl"

prompt="$(cat scripts/orchestrator-prompt.md)"
resume_args=()
if [[ -n "${RESUME:-}" ]]; then
  resume_args=(--resume "$RESUME")
  prompt="Continue the build from where you stopped. Re-read docs/PLAN.md, docs/LOG.md, git log, and scripts/orchestrator-prompt.md (updated: targets now run through M3 and the agent-doable parts of M4; every Agent call passes model: \"opus\"). The M2 build subagent was killed mid-run by a headless timeout (now fixed); check git log for what landed and relaunch M2 for the remaining units."
fi

echo "Logging to $log"
claude -p "$prompt" ${resume_args[@]+"${resume_args[@]}"} \
  --model claude-fable-5-1 \
  --max-budget-usd "${BUDGET:-100}" \
  --permission-mode auto \
  --output-format stream-json --verbose \
  > "$log"
