#!/usr/bin/env bash
set -euo pipefail

# PainCave Outer Autonomous Loop (Ralph-style task runner with circuit breaker)
#
# Usage:
#   ./scripts/autonomous-loop.sh --dry-run
#   AGENT_CMD='claude -p' ./scripts/autonomous-loop.sh --max-iterations 10 --auto-commit
#
# AGENT_CMD receives the rendered iteration prompt on stdin and runs in REPO_ROOT.
# Examples:
#   AGENT_CMD='claude --dangerously-skip-permissions -p'
#   AGENT_CMD='codex exec -'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MAX_ITERATIONS=25
MAX_CONSECUTIVE_FAILURES=3
DRY_RUN=0
AUTO_COMMIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --auto-commit) AUTO_COMMIT=1; shift ;;
    --max-iterations) MAX_ITERATIONS="$2"; shift 2 ;;
    --max-failures) MAX_CONSECUTIVE_FAILURES="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

mkdir -p automation/logs

LAST_TASK_ID=""
CONSECUTIVE_FAILURES=0
LAST_FAIL_LOG=""

for ((iter = 1; iter <= MAX_ITERATIONS; iter++)); do
  echo ""
  echo "========================================================================"
  echo " PainCave Autonomous Loop — Iteration $iter / $MAX_ITERATIONS"
  echo "========================================================================"

  NEXT_JSON="$(node scripts/next-task.mjs --json)"
  ALL_DONE="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.done ? "true" : "false");' "$NEXT_JSON")"
  TASK_ID="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.task ? d.task.id : "");' "$NEXT_JSON")"

  if [[ "$ALL_DONE" == "true" ]]; then
    echo "==> All tasks in automation/tasks.json are DONE. Exiting cleanly."
    exit 0
  fi

  if [[ -z "$TASK_ID" ]]; then
    echo "==> No unblocked tasks remain (remaining tasks are blocked). Exiting."
    exit 2
  fi

  if [[ "$TASK_ID" != "$LAST_TASK_ID" ]]; then
    LAST_TASK_ID="$TASK_ID"
    CONSECUTIVE_FAILURES=0
    LAST_FAIL_LOG=""
  fi

  ATTEMPT=$((CONSECUTIVE_FAILURES + 1))
  PROMPT_FILE="automation/logs/prompt-${TASK_ID}-attempt-${ATTEMPT}.md"
  RUN_LOG="automation/logs/run-${TASK_ID}-attempt-${ATTEMPT}.log"

  {
    cat automation/PROMPT_AUTONOMOUS.md
    echo ""
    echo "---"
    echo "## Assigned Task (\`TASK_ID=$TASK_ID\`, Attempt $ATTEMPT/$MAX_CONSECUTIVE_FAILURES)"
    echo '```json'
    echo "$NEXT_JSON"
    echo '```'
    echo ""
    echo "## Recent Progress Log"
    tail -n 60 automation/progress.md
    if [[ -n "$LAST_FAIL_LOG" && -f "$LAST_FAIL_LOG" ]]; then
      echo ""
      echo "## Previous Attempt Failure Output (Fix This Root Cause First)"
      echo '```text'
      tail -n 120 "$LAST_FAIL_LOG"
      echo '```'
    fi
  } > "$PROMPT_FILE"

  echo "==> Next unblocked task: $TASK_ID (attempt $ATTEMPT/$MAX_CONSECUTIVE_FAILURES)"
  echo "    Rendered prompt: $PROMPT_FILE"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "==> --dry-run enabled: skipping agent invocation."
    echo "    To run live, set AGENT_CMD (e.g. AGENT_CMD='claude -p') and remove --dry-run."
    exit 0
  fi

  if [[ -z "${AGENT_CMD:-}" ]]; then
    echo "ERROR: AGENT_CMD is not set. Example: AGENT_CMD='claude -p' ./scripts/autonomous-loop.sh" >&2
    exit 1
  fi

  set +e
  bash -c "$AGENT_CMD" < "$PROMPT_FILE" 2>&1 | tee "$RUN_LOG"
  AGENT_RC=${PIPESTATUS[0]}
  set -e

  echo "==> Running post-iteration verification for $TASK_ID"
  VERIFY_LOG="automation/logs/verify-${TASK_ID}-attempt-${ATTEMPT}.log"
  set +e
  {
    ./scripts/verify-task.sh "$TASK_ID"
    ./scripts/verify.sh
  } 2>&1 | tee "$VERIFY_LOG"
  VERIFY_RC=${PIPESTATUS[0]}
  set -e

  # Check current status in tasks.json
  CUR_STATUS="$(node -e '
    const fs = require("node:fs");
    const d = JSON.parse(fs.readFileSync("automation/tasks.json", "utf8"));
    console.log(d.tasks.find((t) => t.id === process.argv[1])?.status ?? "");
  ' "$TASK_ID")"

  if [[ "$CUR_STATUS" == "blocked" ]]; then
    echo "==> Agent marked $TASK_ID as BLOCKED. Halting for human input."
    exit 3
  fi

  if [[ "$AGENT_RC" -eq 0 && "$VERIFY_RC" -eq 0 ]]; then
    if [[ "$CUR_STATUS" != "done" ]]; then
      node scripts/update-task.mjs "$TASK_ID" done --note "Completed and verified by autonomous loop (attempt $ATTEMPT)"
    fi
    if [[ "$AUTO_COMMIT" -eq 1 ]]; then
      git add -A
      if ! git diff --cached --quiet; then
        git commit -m "feat($TASK_ID): complete autonomous task $TASK_ID"
      fi
    fi
    CONSECUTIVE_FAILURES=0
    LAST_FAIL_LOG=""
    echo "==> Task $TASK_ID PASSED and recorded."
  else
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    LAST_FAIL_LOG="$VERIFY_LOG"
    echo "==> Attempt $ATTEMPT for $TASK_ID FAILED (agent_rc=$AGENT_RC, verify_rc=$VERIFY_RC)."
    if [[ "$CONSECUTIVE_FAILURES" -ge "$MAX_CONSECUTIVE_FAILURES" ]]; then
      echo "==> CIRCUIT BREAKER TRIPPED after $MAX_CONSECUTIVE_FAILURES consecutive failures on $TASK_ID."
      node scripts/update-task.mjs "$TASK_ID" blocked --note "Circuit breaker tripped after $MAX_CONSECUTIVE_FAILURES failed attempts. See $VERIFY_LOG"
      exit 4
    fi
  fi
done

echo "==> Reached MAX_ITERATIONS ($MAX_ITERATIONS). Inspect automation/tasks.json to continue."
