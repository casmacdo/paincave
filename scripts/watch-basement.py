"""Deploy the latest bridge after edits settle, including uncommitted changes."""

import hashlib
import subprocess
import time
from pathlib import Path


def fingerprint():
    paths = {Path("Cargo.toml"), Path("Cargo.lock")}
    for root in (Path("crates/trainer-bridge"), Path(".cargo")):
        paths.update(p for p in root.rglob("*") if p.is_file() and "target" not in p.parts)
    paths.update(Path(".").glob("rust-toolchain*"))
    paths.update([Path("scripts/deploy-basement.sh"), Path("scripts/activate-basement.sh")])
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(bytes(path))
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.digest()


def watch():
    print("Watching bridge inputs. Press Ctrl-C to stop.", flush=True)
    deployed = previous = None
    retry_at = 0
    while True:
        try:
            current = fingerprint()
        except FileNotFoundError:  # Editor or checkout mid-rename.
            current = None
        if current != previous:
            previous = current
            retry_at = 0
        elif current and current != deployed and time.monotonic() >= retry_at:
            result = subprocess.run(["scripts/deploy-basement.sh"], check=False)
            if result.returncode == 0:
                deployed = current
            else:
                print("Will retry in 30 seconds or after another edit.", flush=True)
                retry_at = time.monotonic() + 30
        time.sleep(2)


if __name__ == "__main__":
    try:
        watch()
    except KeyboardInterrupt:
        pass
