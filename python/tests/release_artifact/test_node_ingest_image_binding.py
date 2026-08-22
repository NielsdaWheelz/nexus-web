from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).parents[3]
CANDIDATE_WORKER_IMAGE_ENV = "NEXUS_TEST_CANDIDATE_WORKER_IMAGE"
IMAGE_ENTRYPOINT = Path("/app/node/ingest/ingest.mjs")
IMAGE_EGRESS_OWNER = Path("/app/node/ingest/accepted_url_egress.mjs")
_IMMUTABLE_IMAGE = re.compile(r"(?:ghcr\.io/nielsdawheelz/nexus-worker@)?sha256:[0-9a-f]{64}\Z")


def _run(arguments: list[str], *, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _run_in_worker(image: str, program: str) -> dict[str, object]:
    completed = _run(
        [
            "docker",
            "run",
            "--rm",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
            "--env=NEXUS_ENV=production",
            "--env=NODE_INGEST_SCRIPT=/app/nexus/__init__.py",
            "--entrypoint=/app/.venv/bin/python",
            image,
            "-c",
            program,
        ]
    )
    assert completed.stderr == ""
    value = json.loads(completed.stdout)
    assert isinstance(value, dict)
    return value


def test_worker_launches_only_the_image_baked_hardened_ingest_entrypoint() -> None:
    """Risk: a released worker substitutes a different URL-fetch implementation."""
    image = os.environ.get(CANDIDATE_WORKER_IMAGE_ENV, "")
    assert _IMMUTABLE_IMAGE.fullmatch(image), (
        f"{CANDIDATE_WORKER_IMAGE_ENV} must name the controller-owned immutable worker image"
    )

    inspected = json.loads(_run(["docker", "image", "inspect", image]).stdout)
    assert isinstance(inspected, list) and len(inspected) == 1
    image_record = inspected[0]
    assert isinstance(image_record, dict)
    expected_sha = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    config = image_record.get("Config")
    assert isinstance(config, dict)
    labels = config.get("Labels")
    assert isinstance(labels, dict)
    assert labels.get("org.opencontainers.image.revision") == expected_sha

    result = _run_in_worker(
        image,
        """
import json
from nexus.services.node_ingest import IngestError, run_node_ingest
try:
    result = run_node_ingest('http://127.0.0.1/private')
except BaseException as error:
    value = {'tag': 'Defect', 'type': type(error).__name__}
else:
    value = (
        {'tag': 'IngestError', 'error_code': result.error_code.value}
        if isinstance(result, IngestError)
        else {'tag': 'Success'}
    )
print(json.dumps(value, separators=(',', ':')))
""",
    )
    assert result == {"tag": "IngestError", "error_code": "E_SSRF_BLOCKED"}

    environment = config.get("Env")
    assert isinstance(environment, list)
    assert all(
        isinstance(item, str) and not item.startswith("NODE_INGEST_SCRIPT=") for item in environment
    )

    image_hashes = _run_in_worker(
        image,
        """
import hashlib
import json
from pathlib import Path
paths = (
    Path('/app/node/ingest/ingest.mjs'),
    Path('/app/node/ingest/accepted_url_egress.mjs'),
)
print(json.dumps(
    {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
    separators=(',', ':'),
    sort_keys=True,
))
""",
    )
    assert image_hashes == {
        str(IMAGE_ENTRYPOINT): hashlib.sha256(
            (REPO_ROOT / "node/ingest/ingest.mjs").read_bytes()
        ).hexdigest(),
        str(IMAGE_EGRESS_OWNER): hashlib.sha256(
            (REPO_ROOT / "node/ingest/accepted_url_egress.mjs").read_bytes()
        ).hexdigest(),
    }
