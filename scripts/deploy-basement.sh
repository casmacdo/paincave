#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -z ${BASEMENT_HOST:-} || $BASEMENT_HOST == -* ]]; then
  echo "Set BASEMENT_HOST to the trainer PC's SSH destination." >&2
  exit 1
fi

if [[ ${1:-} == --watch ]]; then
  exec python3 scripts/watch-basement.py
elif (( $# )); then
  echo "Usage: BASEMENT_HOST=user@trainer-pc scripts/deploy-basement.sh [--watch]" >&2
  exit 1
fi

remote=(ssh -o BatchMode=yes -o ConnectTimeout=5 "$BASEMENT_HOST")
platform=$("${remote[@]}" 'sh -s -- preflight' < scripts/activate-basement.sh)
case "$platform" in
  $'Linux x86_64\n64') target=x86_64-unknown-linux-gnu ;;
  $'Linux aarch64\n64') target=aarch64-unknown-linux-gnu ;;
  $'Linux armv7l\n32'|$'Linux aarch64\n32') target=armv7-unknown-linux-gnueabihf ;;
  *) echo "Unsupported trainer PC platform: $platform" >&2; exit 1 ;;
esac

binary_dir=${CARGO_TARGET_DIR:-target}
args=()
if [[ $target != "$(rustc -vV | sed -n 's/^host: //p')" ]]; then
  case $target in
    aarch64-*) compiler=aarch64-linux-gnu-gcc ;;
    armv7-*) compiler=arm-linux-gnueabihf-gcc ;;
    x86_64-*) compiler=x86_64-linux-gnu-gcc ;;
  esac
  if ! command -v "$compiler" >/dev/null; then
    echo "Cross-build needs $compiler and the Rust target $target on the laptop." >&2
    exit 1
  fi
  target_key=${target//-/_}
  export "CARGO_TARGET_${target_key^^}_LINKER=$compiler"
  args=(--target "$target")
  binary_dir="$binary_dir/$target"
fi

cargo test --locked -p paincave-bridge
cargo build --locked --release --bin trainer-bridge "${args[@]}"

# Stream both artifacts through the same SSH connection while explicitly invoking
# POSIX sh on the remote host (even if the user's login shell is non-POSIX).
activate_b64=$(base64 < scripts/activate-basement.sh | tr -d '\n')
tar -cf - -C "$binary_dir/release" trainer-bridge \
  -C "$PWD/crates/trainer-bridge/systemd" paincave-bridge.service |
  "${remote[@]}" "sh -c 'f=\$(mktemp); trap \"rm -f \$f\" EXIT; printf %s $activate_b64 | base64 -d > \"\$f\" && sh \"\$f\"'"
