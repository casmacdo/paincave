# Run by deploy-basement.sh using the SSH login shell, with a tar archive on stdin.
set -eu
umask 077
bin="$HOME/.local/bin/trainer-bridge"
unit="$HOME/.config/systemd/user/paincave-bridge.service"
config="$HOME/.config/paincave/bridge.env"
name=paincave-bridge.service
if [ ! -r "$config" ]; then
  echo "Set up ~/.config/paincave/bridge.env on the trainer PC first (docs/DEPLOYMENT.md)." >&2
  exit 1
fi

# Read just the numeric port. A systemd EnvironmentFile is not a shell script.
port=$(sed -n 's/^PAINCAVE_BRIDGE_PORT=//p' "$config" | tail -1 | tr -d "\"'\r")
case ${port:-8765} in *[!0-9]*) echo "Invalid PAINCAVE_BRIDGE_PORT" >&2; exit 1 ;; esac
health() { curl -fsS --max-time 2 "http://127.0.0.1:${port:-8765}/health"; }
check_available() {
  if systemctl --user is-active --quiet "$name"; then
    state=$(health | python3 -c 'import json,sys; print(json.load(sys.stdin)["workout_state"])')
    if [ "$state" != idle ]; then
      echo "Workout state is $state. Deferring the update." >&2
      exit 75
    fi
  elif health >/dev/null 2>&1; then
    echo "A bridge outside $name already owns the port. Stop it before enabling automatic deployment." >&2
    exit 1
  fi
}
if [ "${1:-}" = preflight ]; then
  check_available
  uname -sm
  getconf LONG_BIT
  exit
fi

mkdir -p "$(dirname "$bin")" "$(dirname "$unit")" "$HOME/.local/share/paincave"
stage=$(mktemp -d "$(dirname "$bin")/.paincave-deploy.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
tar -xf - -C "$stage"
"$stage/trainer-bridge" --version
exec 9>"$(dirname "$bin")/.paincave-deploy.lock"
flock -x 9
was_active=false
if systemctl --user is-active --quiet "$name"; then
  was_active=true
  if cmp -s "$bin" "$stage/trainer-bridge" && cmp -s "$unit" "$stage/$name" && health >/dev/null; then
    systemctl --user enable "$name"
    echo "Bridge already up to date."
    exit 0
  fi
fi

# Preserve the previous files until the new service answers its health check.
if [ -f "$bin" ]; then cp -p "$bin" "$stage/previous-bin"; fi
if [ -f "$unit" ]; then cp -p "$unit" "$stage/previous-unit"; fi
check_available
if mv -f "$stage/trainer-bridge" "$bin" && install -m 644 "$stage/$name" "$unit" &&
   systemctl --user daemon-reload && systemctl --user restart "$name"; then
  for attempt in 1 2 3 4 5; do
    if systemctl --user is-active --quiet "$name" && health >/dev/null 2>&1 &&
       systemctl --user enable "$name"; then
      echo "Bridge installed and healthy."
      exit 0
    fi
    sleep 1
  done
fi
echo "Bridge failed its startup check. Restoring the previous installation." >&2
systemctl --user stop "$name" || true
if [ -f "$stage/previous-bin" ]; then mv -f "$stage/previous-bin" "$bin"; else rm -f "$bin"; fi
if [ -f "$stage/previous-unit" ]; then
  install -m 644 "$stage/previous-unit" "$unit"
else
  rm -f "$unit"
fi
systemctl --user daemon-reload
if "$was_active"; then systemctl --user start "$name"; fi
exit 1
