#!/usr/bin/env bash
set -euo pipefail

# Vertical E2E Simulation Loop (Loop 2)
# Implemented fully in task M7-01 once Worker (M2/M3) and Rust trainer-bridge (M4) are complete.
#
# Flow:
#   1. Apply D1 migrations locally and launch `wrangler dev --local` on port 8787
#   2. Build and launch `trainer-bridge serve --mock --time-scale 60` on port 8765
#   3. Run scripts/sim-e2e-driver.mjs:
#        - MCP create_workout + schedule_workout
#        - WS load_workout + start
#        - Inject 5s cadence=0 fault (verify ERG spiral-of-death auto-pause & ramp recovery)
#        - Finish workout, simulate transient 503 on first upload, verify idempotent retry succeeds
#        - Assert R2 .fit file, D1 rides/ride_intervals/ride_peaks/daily_pmc, and MCP get_ride_detail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f scripts/sim-e2e-driver.mjs ]]; then
  echo "sim-e2e.sh is scaffolded for M7-01. Complete milestones M1–M4 first (scripts/sim-e2e-driver.mjs not yet implemented)." >&2
  exit 1
fi

WORKER_PID=""
BRIDGE_PID=""
TMP_DIR="$(mktemp -d)"

cleanup() {
  [[ -n "$BRIDGE_PID" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "==> [sim-e2e] Building trainer-bridge"
cargo build --manifest-path crates/trainer-bridge/Cargo.toml

echo "==> [sim-e2e] Applying local D1 migrations & starting Cloudflare Worker"
npx --workspace @paincave/worker wrangler d1 migrations apply paincave-db --local
npx --workspace @paincave/worker wrangler dev --local --port 8787 --persist-to "$TMP_DIR/wrangler-state" >"$TMP_DIR/worker.log" 2>&1 &
WORKER_PID=$!

echo "==> [sim-e2e] Starting trainer-bridge in accelerated mock mode (60x)"
PAINCAVE_API_URL="http://127.0.0.1:8787" \
PAINCAVE_BRIDGE_PORT="8765" \
PAINCAVE_BRIDGE_TOKEN="sim-e2e-bridge-token" \
PAINCAVE_DATA_DIR="$TMP_DIR/bridge-data" \
  ./target/debug/trainer-bridge serve --mock --time-scale 60 >"$TMP_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

echo "==> [sim-e2e] Running E2E simulation driver"
node scripts/sim-e2e-driver.mjs --worker-url http://127.0.0.1:8787 --bridge-url http://127.0.0.1:8765
echo "==> [sim-e2e] Vertical E2E simulation PASSED"
