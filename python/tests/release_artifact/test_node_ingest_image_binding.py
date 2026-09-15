from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from nexus.release_artifact import build_runtime_identity

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


def _run_in_image(
    image: str, program: str, *, test_configuration: bool = False
) -> dict[str, object]:
    container_name = os.environ["NEXUS_TEST_CANDIDATE_CONTAINER_NAME"]
    assert re.fullmatch(r"nexus-test-backend-[0-9a-f]{16}-[0-9a-f]{16}", container_name)
    try:
        completed = _run(
            [
                "docker",
                "run",
                "--name",
                container_name,
                "--network=none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
                "--env=PYTHONDONTWRITEBYTECODE=1",
                *(
                    [
                        "--env=NEXUS_ENV=test",
                        "--env=DATABASE_URL=postgresql+psycopg://test:test@127.0.0.1:1/test",
                        "--env=SUPABASE_JWKS_URL=http://127.0.0.1:1/auth/v1/.well-known/jwks.json",
                        "--env=SUPABASE_ISSUER=http://127.0.0.1:1/auth/v1",
                        "--env=SUPABASE_AUDIENCES=authenticated",
                    ]
                    if test_configuration
                    else [
                        "--env=NEXUS_ENV=production",
                        "--env=NODE_INGEST_SCRIPT=/app/nexus/__init__.py",
                    ]
                ),
                "--entrypoint=/app/.venv/bin/python",
                image,
                "-c",
                program,
            ]
        )
    finally:
        _run(["docker", "container", "rm", "--force", container_name])
    assert completed.stderr == ""
    value = json.loads(completed.stdout)
    assert isinstance(value, dict)
    return value


@pytest.mark.parametrize("target", ["api", "worker"])
def test_backend_image_preserves_immutable_identity_and_unprivileged_runtime(target: str) -> None:
    """A tagged build must contain the exact runtime and launchable target, without credentials."""
    image = os.environ.get(f"NEXUS_TEST_CANDIDATE_{target.upper()}_IMAGE", "")
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", image)
    expected_sha = _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    inspected = json.loads(_run(["docker", "image", "inspect", image]).stdout)
    assert isinstance(inspected, list) and len(inspected) == 1
    config = inspected[0]["Config"]
    assert config["Labels"]["org.opencontainers.image.revision"] == expected_sha
    assert config["User"] == "nexus:nexus"
    assert config["WorkingDir"] == "/app"
    assert config["Entrypoint"] is None
    assert config["Cmd"] == (
        ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
        if target == "api"
        else ["python", "-m", "apps.worker.main"]
    )
    assert all(
        entry.split("=", 1)[0]
        not in {
            "DATABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "CODEX_HOME",
            "NODE_INGEST_SCRIPT",
        }
        for entry in config["Env"]
    )
    result = _run_in_image(
        image,
        """
import contextlib
import importlib
import io
import json
import os
import stat
import sys
from pathlib import Path
from nexus.release_artifact import load_runtime_identity

target = """
        + repr(target)
        + """
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    importlib.import_module('apps.api.main' if target == 'api' else 'apps.worker.main')
identity_path = Path('/app/runtime-identity.json')
identity_stat = identity_path.stat()
owned_paths = [Path('/app/nexus'), Path('/app/migrations'), Path('/app/apps') / target]
print(json.dumps({
    'identity': load_runtime_identity(identity_path).as_json(),
    'uid': os.getuid(),
    'gid': os.getgid(),
    'identity_uid': identity_stat.st_uid,
    'identity_mode': stat.S_IMODE(identity_stat.st_mode),
    'mutable_code': [str(path) for root in owned_paths for path in (root, *root.rglob('*'))
                     if path.stat().st_uid != 0 or path.stat().st_mode & 0o022],
    'codex_launcher_present': Path('/app/apps/codex_agent/main.py').is_file(),
    'codex_state_present': Path('/var/lib/nexus-codex').is_dir(),
    'ingest_present': Path('/app/node/ingest/ingest.mjs').is_file(),
    'worker_provider_preloaded': target == 'worker' and 'provider_runtime' in sys.modules,
}, sort_keys=True))
""",
        test_configuration=True,
    )
    assert result == {
        "identity": build_runtime_identity(REPO_ROOT, expected_sha).as_json(),
        "uid": 10001,
        "gid": 10001,
        "identity_uid": 0,
        "identity_mode": 0o444,
        "mutable_code": [],
        "codex_launcher_present": target == "worker",
        "codex_state_present": target == "worker",
        "ingest_present": target == "worker",
        "worker_provider_preloaded": False,
    }


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

    result = _run_in_image(
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

    image_hashes = _run_in_image(
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
