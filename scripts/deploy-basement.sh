#!/usr/bin/env bash
set -euo pipefail

# Build and deploy crates/trainer-bridge to the basement Linux machine.
# Usage:
#   BASEMENT_HOST=user@basement-pc ./scripts/deploy-basement.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "${BASEMENT_HOST:-}" ]]; then
  echo "Usage: BASEMENT_HOST=user@basement-pc ./scripts/deploy-basement.sh" >&2
  exit 1
fi

echo "==> Building release binary for trainer-bridge"
cargo build --release --manifest-path crates/trainer-bridge/Cargo.toml

BIN_PATH="$REPO_ROOT/target/release/trainer-bridge"
UNIT_PATH="$REPO_ROOT/crates/trainer-bridge/systemd/paincave-bridge.service"

echo "==> Copying binary and systemd user unit to $BASEMENT_HOST"
ssh "$BASEMENT_HOST" "mkdir -p ~/.local/bin ~/.config/systemd/user ~/.config/paincave ~/.local/share/paincave"
scp "$BIN_PATH" "$BASEMENT_HOST:~/.local/bin/trainer-bridge.new"
scp "$UNIT_PATH" "$BASEMENT_HOST:~/.config/systemd/user/paincave-bridge.service"

echo "==> Activating binary and restarting paincave-bridge.service"
ssh "$BASEMENT_HOST" "
  mv ~/.local/bin/trainer-bridge.new ~/.local/bin/trainer-bridge &&
  chmod +x ~/.local/bin/trainer-bridge &&
  systemctl --user daemon-reload &&
  systemctl --user enable --now paincave-bridge.service &&
  systemctl --user restart paincave-bridge.service &&
  sleep 1 &&
  curl -fsS http://127.0.0.1:8765/health
"
echo ""
echo "==> Basement deployment complete."
