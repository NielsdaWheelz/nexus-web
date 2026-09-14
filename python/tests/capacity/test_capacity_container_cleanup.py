"""Actual Docker cleanup preserves foreign resource ownership."""

import json
import os
from pathlib import Path

import pytest

from nexus_test_control.containers import (
    close_owned_container,
    create_owned_container,
    delete_owned_container,
    local_docker,
)
from nexus_test_control.runtime import RuntimeContractError, read_ledger

REPO_ROOT = Path(__file__).parents[3]


def test_container_cleanup_preserves_foreign_owners() -> None:
    run_id = os.environ["NEXUS_TEST_RUN_ID"]
    name = create_owned_container(
        REPO_ROOT,
        {"NEXUS_ENV": "test"},
        run_id,
        role="cleanup-proof",
        image=os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"],
        arguments=("--network=none", "--read-only", "--entrypoint=/app/.venv/bin/python"),
        command=("-c", "pass"),
    )
    try:
        actual_owner = next(
            entry.external_id
            for entry in read_ledger(REPO_ROOT, run_id).entries
            if entry.resource.identity == name
        )
        assert actual_owner is not None
        for claimed_run, owner in ((run_id, "0" * 32), ("0" * 16, actual_owner)):
            with pytest.raises(RuntimeContractError, match="foreign container"):
                delete_owned_container(REPO_ROOT, claimed_run, name, owner)
            assert json.loads(local_docker(("inspect", name)))[0]["Name"] == f"/{name}"
    finally:
        close_owned_container(REPO_ROOT, run_id, "cleanup-proof")
    assert all(entry.resource.identity != name for entry in read_ledger(REPO_ROOT, run_id).entries)
    assert (
        local_docker(("container", "ls", "--all", "--filter", f"name=^/{name}$", "--quiet")) == ""
    )
