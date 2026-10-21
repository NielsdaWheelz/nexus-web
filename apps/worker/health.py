"""A lane's heartbeat file and the container healthcheck that reads it.

The healthcheck runs ``python -S -m apps.worker.health --lane <lane>``: stdlib only.
A lane is healthy while its process, alive, published a database-backed cycle in
the last 20 seconds. The heartbeat uses the process's temporary directory; a
host worker and its health command must share TMPDIR.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

MAX_AGE_SECONDS = 20.0


def _path(lane: str) -> Path:
    return Path(tempfile.gettempdir()) / f"nexus-worker-{lane}.json"


class Heartbeat:
    def __init__(self, lane: str, source_sha: str, database_revision: str) -> None:
        self.path = _path(lane)
        self.record = {
            "pid": os.getpid(),
            "lane": lane,
            "source_sha": source_sha,
            "expected_database_revision": database_revision,
        }

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)

    def publish(self) -> None:
        """Replace the record atomically; CLOCK_MONOTONIC is system-wide on Linux."""
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.")
        with os.fdopen(fd, "w") as stream:
            json.dump(self.record | {"at": time.monotonic()}, stream)
        os.replace(temp, self.path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", choices=("interactive", "background"), required=True)
    lane = parser.parse_args().lane
    try:
        record = json.loads(_path(lane).read_bytes())
        if record["lane"] != lane:
            raise ValueError("identity_mismatch")
        if not 0 <= time.monotonic() - record["at"] <= MAX_AGE_SECONDS:
            raise ValueError("heartbeat_stale")
        os.kill(record["pid"], 0)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "unavailable", "reason": str(exc)}), file=sys.stderr)
        return 1
    keys = ("lane", "source_sha", "expected_database_revision")
    print(json.dumps({"status": "ready"} | {key: record[key] for key in keys}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
