#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STRICT=0
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=1
fi

echo "==> [1/5] Checking public-repo secret & PII hygiene"
python3 -c '
import re, subprocess, sys

tracked = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
forbidden_files = re.compile(r"(^|/)(\.dev\.vars(\..*)?|\.env(\..*)?|secrets\.json|wrangler\.local\.jsonc|bridge\.env|.*\.(pem|key|p12))$")
home_path_re = re.compile(r"/(home|Users)/[A-Za-z0-9._-]+/")
secret_res = [
    re.compile("gh" + "p_[A-Za-z0-9]{20,}"),
    re.compile("gh" + "o_[A-Za-z0-9]{20,}"),
    re.compile("github_" + "pat_[A-Za-z0-9_]{20,}"),
    re.compile("sk-" + "live-[A-Za-z0-9]{16,}"),
    re.compile("sk-" + "ant-[A-Za-z0-9_-]{16,}"),
    re.compile("AK" + "IA[0-9A-Z]{16}"),
    re.compile("-----BEGIN (RSA |EC |OPENSSH )?PRIVATE " + "KEY-----"),
]

violations = []
for path in tracked:
    if path in ("package-lock.json", "Cargo.lock") or path.endswith(".example"):
        continue
    if forbidden_files.search(path):
        violations.append(f"Forbidden secret file tracked: {path}")
        continue
    try:
        text = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        continue
    for idx, line in enumerate(text.splitlines(), 1):
        if home_path_re.search(line):
            violations.append(f"{path}:{idx}: personal home directory path detected")
        for pat in secret_res:
            if pat.search(line):
                violations.append(f"{path}:{idx}: credential/key pattern detected")

if violations:
    print("ERROR: Public-repo security hygiene violations found:", file=sys.stderr)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    sys.exit(1)
print(f"    Scanned {len(tracked)} tracked files: zero secrets or PII leaks.")
'

echo "==> [2/5] Validating autonomous task DAG (automation/tasks.json)"
node scripts/next-task.mjs --validate

echo "==> [3/5] Validating D1 SQLite migrations"
python3 -c '
import glob, sqlite3, sys
files = sorted(glob.glob("apps/worker/migrations/*.sql"))
assert files, "No SQL migration files found"
conn = sqlite3.connect(":memory:")
for f in files:
    conn.executescript(open(f, encoding="utf-8").read())
print(f"    Validated {len(files)} migration file(s) cleanly in SQLite.")
'

echo "==> [4/5] Checking Rust workspace (crates/trainer-bridge)"
if command -v cargo >/dev/null 2>&1; then
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
else
  echo "ERROR: cargo not found in PATH" >&2
  exit 1
fi

echo "==> [5/5] Checking TypeScript workspaces (packages/shared, apps/worker, apps/web)"
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
