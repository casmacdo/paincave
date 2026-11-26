#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STRICT=0
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=1
fi

echo "==> [1/4] Validating autonomous task DAG (automation/tasks.json)"
node scripts/next-task.mjs --validate

echo "==> [2/4] Validating D1 SQLite migrations"
python3 -c '
import glob, sqlite3, sys
files = sorted(glob.glob("apps/worker/migrations/*.sql"))
assert files, "No SQL migration files found"
conn = sqlite3.connect(":memory:")
for f in files:
    conn.executescript(open(f, encoding="utf-8").read())
print(f"    Validated {len(files)} migration file(s) cleanly in SQLite.")
'

echo "==> [3/4] Checking Rust workspace (crates/trainer-bridge)"
if command -v cargo >/dev/null 2>&1; then
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
else
  echo "ERROR: cargo not found in PATH" >&2
  exit 1
fi

echo "==> [4/4] Checking TypeScript workspaces (packages/shared, apps/worker, apps/web)"
if [[ -d node_modules ]]; then
  npm run typecheck
  npm run lint
  npm run test
else
  if [[ "$STRICT" -eq 1 ]]; then
    echo "ERROR: node_modules missing in --strict mode. Run 'npm install' (Task M1-01)." >&2
    exit 1
  else
    echo "    (Skipping npm checks until M1-01 installs node_modules; pass --strict to enforce.)"
  fi
fi

echo "==> PainCave verification gate PASSED"
