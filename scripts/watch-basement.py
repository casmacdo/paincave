"""Deploy the latest bridge after edits settle, including uncommitted changes."""

import hashlib
import os
import subprocess
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _iter_tree(root: Path):
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "target"]
        for name in filenames:
            yield Path(dirpath) / name


def fingerprint():
    paths = {REPO_ROOT / "Cargo.toml", REPO_ROOT / "Cargo.lock"}
    for root in (REPO_ROOT / "crates/trainer-bridge", REPO_ROOT / ".cargo"):
        paths.update(_iter_tree(root))
    paths.update(REPO_ROOT.glob("rust-toolchain*"))
    paths.update([
        REPO_ROOT / "scripts/deploy-basement.sh",
        REPO_ROOT / "scripts/activate-basement.sh",
    ])
    digest = hashlib.sha256()
    for path in sorted(paths):
        rel = path.relative_to(REPO_ROOT)
        digest.update(bytes(rel))
        digest.update(b"\0")
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
            result = subprocess.run(
                [str(REPO_ROOT / "scripts/deploy-basement.sh")],
                cwd=REPO_ROOT,
                check=False,
            )
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
