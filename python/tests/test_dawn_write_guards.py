"""File-level structural guards for the dawn write cutover (§13).

These assertions fail CI before any deploy if the implementation drifts from
the structural invariants the spec requires.
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[2]
NEXUS = ROOT / "python" / "nexus"
DEPLOY = ROOT / "deploy"


def _read(*parts: str) -> str:
    return Path(NEXUS).joinpath(*parts).read_text()


def test_no_on_conflict_in_dawn_write_service() -> None:
    """Guard 1: the service never upserts — existence check is explicit (house doctrine)."""
    src = _read("services", "dawn_write.py")
    assert "ON CONFLICT" not in src, (
        "services/dawn_write.py contains an ON CONFLICT clause; "
        "the spec prohibits upserts — check for an existing row before inserting."
    )


def test_no_rowcount_in_dawn_write_files() -> None:
    """Guard 2: no rowcount-driven control flow (house doctrine)."""
    for path in ["services/dawn_write.py", "api/routes/notes.py"]:
        src = _read(*path.split("/"))
        assert ".rowcount" not in src and "rowcount" not in src, (
            f"{path} reads .rowcount; house doctrine prohibits rowcount-driven control flow."
        )


def test_dawn_write_task_uses_correct_owner_kind() -> None:
    """Guard 3: the task ledgers under 'dawn_write', not any other kind."""
    src = _read("tasks", "dawn_write.py")
    # The owner_kind is passed in dawn_write.py (service), not the task,
    # but the task must not reference any other owner kind string.
    assert "synapse_scan" not in src, (
        "tasks/dawn_write.py references 'synapse_scan' — wrong owner_kind."
    )
    assert "oracle_reading" not in src, (
        "tasks/dawn_write.py references 'oracle_reading' — wrong owner_kind."
    )
    # The service file must contain the correct owner_kind.
    svc = _read("services", "dawn_write.py")
    assert 'kind="dawn_write"' in svc or "kind='dawn_write'" in svc, (
        "services/dawn_write.py must pass owner_kind='dawn_write' to LlmCallOwner."
    )


def test_deploy_allowlist_triple_consistency() -> None:
    """Guard 4: dawn_write_job appears in all three deploy allowlist locations."""
    config_src = (NEXUS / "config.py").read_text()
    worker_example = (DEPLOY / "env" / "env-prod-worker.example").read_text()
    sync_env = (DEPLOY / "hetzner" / "sync-env.sh").read_text()

    assert "dawn_write_job" in config_src, (
        "DEFAULT_WORKER_ALLOWED_JOB_KINDS in config.py does not include 'dawn_write_job'."
    )
    assert "dawn_write_job" in worker_example, (
        "WORKER_ALLOWED_JOB_KINDS in deploy/env/env-prod-worker.example does not include "
        "'dawn_write_job'."
    )
    assert "dawn_write_job" in sync_env, (
        "SAFE_WORKER_ALLOWED_JOB_KINDS in deploy/hetzner/sync-env.sh does not include "
        "'dawn_write_job'."
    )
