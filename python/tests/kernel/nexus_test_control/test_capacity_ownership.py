"""Interrupted capacity containers retain exact ownership in the recovery ledger."""

from pathlib import Path

import pytest

from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    cleanup_candidates,
    container_resource_identity,
    initialize_runtime,
    read_ledger,
    record_created,
    record_planned,
)


def test_capacity_container_recovery_retains_planned_owner_and_rejects_foreign_identity(
    tmp_path: Path,
) -> None:
    environment = {"NEXUS_ENV": "test"}
    run_id = "0123456789abcdef"
    owner = "1" * 32
    initialize_runtime(tmp_path, environment, RuntimePorts(*range(21001, 21014)))
    claim_run(tmp_path, environment, run_id)
    resource = Resource(ResourceKind.CONTAINER, container_resource_identity(run_id, "api-baseline"))
    with pytest.raises(RuntimeContractError, match="owner token"):
        record_planned(tmp_path, environment, run_id, resource)
    record_planned(tmp_path, environment, run_id, resource, external_id=owner)

    # Recovery after create succeeded but before its acknowledgment must retain
    # the same pre-creation identity, rather than infer ownership from a name.
    planned = cleanup_candidates(tmp_path, environment, run_id)
    assert [(entry.resource, entry.external_id) for entry in planned] == [(resource, owner)]
    with pytest.raises(RuntimeContractError, match="owner changed"):
        record_created(tmp_path, environment, run_id, resource, external_id="2" * 32)
    record_created(tmp_path, environment, run_id, resource)
    assert read_ledger(tmp_path, run_id).entries[0].external_id == owner

    # A container minted for another run carries that run id in its name, so it
    # is refused before it can enter this run's ledger, and the refusal names
    # the run-ownership invariant rather than an unparseable role.
    foreign = Resource(
        ResourceKind.CONTAINER,
        container_resource_identity("fedcba9876543210", "api-baseline"),
    )
    with pytest.raises(RuntimeContractError, match="identity is not the exact test-only name"):
        record_planned(tmp_path, environment, run_id, foreign, external_id=owner)
    assert [entry.resource for entry in read_ledger(tmp_path, run_id).entries] == [resource]
