"""Exact-image import qualification; workload qualification follows this receipt."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

from nexus_test_control.containers import (
    close_owned_container,
    create_owned_container,
    local_docker,
)

REPO_ROOT = Path(__file__).parents[3]
MANIFEST = REPO_ROOT / "testdata/capacity/incident-api.json"
PROBE = REPO_ROOT / "testdata/capacity/api_import_probe.py"
PROVIDER_PROBE = REPO_ROOT / "testdata/capacity/api_provider_first_request.py"


def _imports(image: str, role: str) -> dict:
    manifest = json.loads(MANIFEST.read_text())
    run_id = os.environ["NEXUS_TEST_RUN_ID"]
    name = create_owned_container(
        REPO_ROOT,
        {"NEXUS_ENV": "test"},
        run_id,
        role=f"api-{role}",
        image=image,
        arguments=(
            "--memory",
            str(manifest["memory_bytes"]),
            "--memory-swap",
            str(manifest["memory_bytes"]),
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--mount",
            f"type=bind,source={PROBE},target=/capacity_probe.py,readonly",
            "--mount",
            f"type=bind,source={PROVIDER_PROBE},target=/capacity_provider_first_request.py,readonly",
            "--env=NEXUS_ENV=test",
            "--env=DATABASE_URL=postgresql+psycopg://nexus:nexus@127.0.0.1/nexus_capacity",
            "--env=SUPABASE_JWKS_URL=http://127.0.0.1:1/auth/v1/.well-known/jwks.json",
            "--env=SUPABASE_ISSUER=http://127.0.0.1:1/auth/v1",
            "--env=SUPABASE_AUDIENCES=authenticated",
            "--env=PYTHONDONTWRITEBYTECODE=1",
            "--entrypoint=/app/.venv/bin/python",
        ),
        command=("/capacity_probe.py",),
    )
    attach_status = 0
    try:
        output = local_docker(("start", "--attach", name))
        errors = ""
    except subprocess.CalledProcessError as error:
        attach_status = error.returncode
        output = error.stdout
        errors = error.stderr
    inspection = json.loads(local_docker(("inspect", name)))[0]
    exit_code = inspection["State"]["ExitCode"]
    samples = []
    for line in output.splitlines():
        if line.startswith('{"phase":'):
            samples.append(json.loads(line))
    receipt = {
        "version": 1,
        "scope": "imports-only",
        "image_id": inspection["Image"],
        "source_sha": inspection["Config"]["Labels"].get("org.opencontainers.image.revision"),
        "memory_limit_bytes": inspection["HostConfig"]["Memory"],
        "memory_swap_limit_bytes": inspection["HostConfig"]["MemorySwap"],
        "manifest_sha256": hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
        "probe_sha256": hashlib.sha256(PROBE.read_bytes()).hexdigest(),
        "provider_probe_sha256": hashlib.sha256(PROVIDER_PROBE.read_bytes()).hexdigest(),
        "samples": samples,
        "state": inspection["State"],
        "exit_code": exit_code,
        "attach_status": attach_status,
        "stderr": errors,
    }
    if role == "candidate":
        identity = REPO_ROOT / "test-results/runs" / run_id / "api-build-inputs.json"
        receipt["build_inputs"] = json.loads(identity.read_text())
    evidence = REPO_ROOT / "test-results/runs" / run_id / f"api-capacity-{role}.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(receipt, indent=2) + "\n")
    close_owned_container(REPO_ROOT, run_id, f"api-{role}")
    assert exit_code == 0, f"api import failed; receipt={evidence}; stderr={errors}"
    assert [sample["phase"] for sample in samples] == [
        "interpreter",
        "provider-runtime-construction",
        "api-import",
        "api-created",
        "selected-provider-first-request",
    ], f"api import receipt is incomplete: {evidence}"
    return receipt


def test_incident_baseline() -> None:
    manifest = json.loads(MANIFEST.read_text())
    receipt = _imports(manifest["image"], "baseline")
    assert receipt["source_sha"] == manifest["source_sha"]


def test_candidate_import_envelope() -> None:
    receipt = _imports(os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate")
    assert receipt["samples"][-2]["vendor_modules"] == [], (
        "api construction loaded provider execution SDKs; see capacity receipt"
    )
    assert receipt["samples"][-1]["vendor_modules"] == ["openai"], (
        "selected provider execution initialized unrelated SDKs; see capacity receipt"
    )
