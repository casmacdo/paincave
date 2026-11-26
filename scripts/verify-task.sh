#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -lt 1 ]]; then
  echo "Usage: ./scripts/verify-task.sh <TASK_ID>" >&2
  exit 1
fi

TASK_ID="$1"
VERIFY_CMD="$(node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync("automation/tasks.json", "utf8"));
const task = data.tasks.find((t) => t.id === process.argv[1]);
if (!task) { console.error("Task not found:", process.argv[1]); process.exit(1); }
process.stdout.write(task.verify_cmd);
' "$TASK_ID")"

echo "==> Verifying task $TASK_ID"
echo "    Command: $VERIFY_CMD"
bash -euo pipefail -c "$VERIFY_CMD"
echo "==> Task $TASK_ID verification PASSED"
