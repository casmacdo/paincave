#!/usr/bin/env bash
set -euo pipefail

# Vertical E2E Simulation Loop (Loop 2)
# Exercises Cloudflare Worker (local D1 + R2) <-> Rust trainer-bridge (60x mock) <-> MCP & WebSocket
# across two isolated users (User A: indoor cycling bridge, User B: Garmin runner + strength + .FIT export).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f scripts/sim-e2e-driver.mjs ]]; then
  echo "Missing scripts/sim-e2e-driver.mjs" >&2
  exit 1
fi

# Use isolated high ports by default so E2E never collides with a live local trainer-bridge (8765) or dev worker (8787).
E2E_WORKER_PORT="${E2E_WORKER_PORT:-18787}"
E2E_BRIDGE_PORT="${E2E_BRIDGE_PORT:-18765}"
E2E_WORKER_URL="http://127.0.0.1:${E2E_WORKER_PORT}"
E2E_BRIDGE_URL="http://127.0.0.1:${E2E_BRIDGE_PORT}"

WORKER_PID=""
BRIDGE_PID=""
TMP_DIR="$(mktemp -d)"
export XDG_CONFIG_HOME="$TMP_DIR/xdg-config"
export WRANGLER_LOG_PATH="$TMP_DIR/wrangler.log"

cleanup() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    echo "=== E2E FAILED (exit $exit_code) ===" >&2
    if [[ -f "$TMP_DIR/worker.log" ]]; then
      echo "--- worker.log tail ---" >&2
      tail -n 60 "$TMP_DIR/worker.log" >&2 || true
    fi
    if [[ -f "$TMP_DIR/bridge.log" ]]; then
      echo "--- bridge.log tail ---" >&2
      tail -n 60 "$TMP_DIR/bridge.log" >&2 || true
    fi
  fi
  [[ -n "$BRIDGE_PID" ]] && kill "$BRIDGE_PID" 2>/dev/null || true
  if [[ -n "$WORKER_PID" ]]; then
    pkill -TERM -P "$WORKER_PID" 2>/dev/null || true
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  wait "$BRIDGE_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  local label="$2"
  local max_tries="$3"
  for ((i = 1; i <= max_tries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for $label at $url" >&2
  return 1
}

echo "==> [sim-e2e] Building @paincave/web assets and Rust trainer-bridge"
npm --workspace @paincave/web run build >/dev/null
cargo build --manifest-path crates/trainer-bridge/Cargo.toml

E2E_SESSION_SECRET="$(openssl rand -hex 24)"
E2E_BETTER_AUTH_SECRET="$(openssl rand -hex 24)"
E2E_BRIDGE_TOKEN="$(openssl rand -hex 24)"
E2E_MCP_TOKEN="$(openssl rand -hex 24)"

echo "==> [sim-e2e] Applying local D1 migrations & starting Cloudflare Worker on :${E2E_WORKER_PORT}"
(
  cd apps/worker
  CI=1 npx wrangler d1 migrations apply paincave-db --local --persist-to "$TMP_DIR/wrangler-state" </dev/null >/dev/null
)

(
  cd apps/worker
  exec env CI=1 npx wrangler dev --local --ip 127.0.0.1 --port "$E2E_WORKER_PORT" \
    --persist-to "$TMP_DIR/wrangler-state" \
    --var "SESSION_SIGNING_SECRET:$E2E_SESSION_SECRET" \
    --var "BETTER_AUTH_SECRET:$E2E_BETTER_AUTH_SECRET" \
    --var "GOOGLE_CLIENT_ID:e2e-google-client-id" \
    --var "GOOGLE_CLIENT_SECRET:e2e-google-client-secret" \
    --var "ALLOWED_USER_EMAILS:cyclist-e2e@example.com,runner-e2e@example.com" \
    --var "BRIDGE_DEVICE_TOKEN:$E2E_BRIDGE_TOKEN" \
    --var "MCP_BEARER_TOKEN:$E2E_MCP_TOKEN" \
    </dev/null
) >"$TMP_DIR/worker.log" 2>&1 &
WORKER_PID=$!

wait_for_http "${E2E_WORKER_URL}/api/health" "Cloudflare Worker" 60

# Browser navigations must reach the OAuth handlers through the assets router.
# A signed-out connect returns 401 and a callback without an OAuth code returns 400.
for route in connect callback; do
  expected=401
  if [[ "$route" == callback ]]; then expected=400; fi
  response=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Mode: navigate' \
    -H 'Accept: text/html' "${E2E_WORKER_URL}/api/strava/$route")
  if [[ "$response" != "$expected" ]]; then
    echo "Strava $route navigation returned $response, expected $expected" >&2
    exit 1
  fi
done

echo "==> [sim-e2e] Starting trainer-bridge in accelerated mock mode (60x) on :${E2E_BRIDGE_PORT}"
PAINCAVE_API_URL="$E2E_WORKER_URL" \
PAINCAVE_BRIDGE_PORT="$E2E_BRIDGE_PORT" \
PAINCAVE_BRIDGE_TOKEN="$E2E_BRIDGE_TOKEN" \
PAINCAVE_DATA_DIR="$TMP_DIR/bridge-data" \
  ./target/debug/trainer-bridge serve --mock --time-scale 60 >"$TMP_DIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

wait_for_http "${E2E_BRIDGE_URL}/health" "Rust trainer-bridge" 30

echo "==> [sim-e2e] Running two-user E2E simulation driver"
E2E_BETTER_AUTH_SECRET="$E2E_BETTER_AUTH_SECRET" \
E2E_WRANGLER_STATE="$TMP_DIR/wrangler-state" \
E2E_BRIDGE_TOKEN="$E2E_BRIDGE_TOKEN" \
E2E_MCP_TOKEN="$E2E_MCP_TOKEN" \
  node scripts/sim-e2e-driver.mjs --worker-url "$E2E_WORKER_URL" --bridge-url "$E2E_BRIDGE_URL"

echo "==> [sim-e2e] Vertical E2E simulation PASSED"
