import fcntl
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    EndpointKind,
    ResourcePhase,
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    cleanup_candidates,
    extension_profile_identity,
    forget_cleaned,
    initialize_runtime,
    process_resource_identity,
    read_ledger,
    record_created,
    record_planned,
    release_run,
    run_bucket_name,
    run_database_name,
    runtime_endpoint,
    supabase_user_email,
    supabase_user_metadata,
    template_build_database_name,
    template_database_name,
    template_fingerprint,
    template_lifecycle_lock,
)

RUN_ID = "0123456789abcdef"
OTHER_RUN_ID = "fedcba9876543210"
TEST_ENV = {"NEXUS_ENV": "test"}


def _ports() -> RuntimePorts:
    return RuntimePorts(15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000, 18010)


def _runtime(tmp_path: Path) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)


def test_runtime_exposes_only_recorded_loopback_endpoints_in_test_environment(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())

    assert runtime_endpoint(tmp_path, TEST_ENV, EndpointKind.POSTGRES) == (
        "postgresql://127.0.0.1:15432"
    )
    assert runtime_endpoint(tmp_path, TEST_ENV, EndpointKind.MINIO) == "http://127.0.0.1:19000"
    assert runtime_endpoint(tmp_path, TEST_ENV, EndpointKind.SUPABASE) == ("http://127.0.0.1:25421")
    for environment in ({}, {"NEXUS_ENV": "development"}, {"NEXUS_ENV": "production"}):
        with pytest.raises(RuntimeContractError, match="NEXUS_ENV"):
            runtime_endpoint(tmp_path, environment, EndpointKind.MINIO)


def test_runtime_and_ledger_are_bound_to_the_exact_repository(tmp_path: Path) -> None:
    _runtime(tmp_path)
    runtime_path = tmp_path / ".nexus-test" / "runtime.json"
    data = json.loads(runtime_path.read_text())
    data["repo_id"] = "f" * 16
    runtime_path.write_text(json.dumps(data))

    with pytest.raises(RuntimeContractError, match="different repository"):
        read_ledger(tmp_path, RUN_ID)


def test_runtime_ports_cannot_be_replaced_after_resource_ownership_exists(tmp_path: Path) -> None:
    _runtime(tmp_path)
    changed = RuntimePorts(15433, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000, 18010)

    with pytest.raises(RuntimeContractError, match="cannot be replaced"):
        initialize_runtime(tmp_path, TEST_ENV, changed)


def test_resource_is_persisted_as_planned_before_it_can_be_created(tmp_path: Path) -> None:
    _runtime(tmp_path)
    database = Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID))

    with pytest.raises(RuntimeContractError, match="not recorded"):
        record_created(tmp_path, TEST_ENV, RUN_ID, database)
    planned = record_planned(tmp_path, TEST_ENV, RUN_ID, database)
    assert planned.phase is ResourcePhase.PLANNED
    assert read_ledger(tmp_path, RUN_ID).entries == (planned,)
    created = record_created(tmp_path, TEST_ENV, RUN_ID, database)
    assert created.phase is ResourcePhase.CREATED
    assert read_ledger(tmp_path, RUN_ID).entries == (created,)


def test_concurrent_plans_cannot_lose_owned_resources(tmp_path: Path) -> None:
    _runtime(tmp_path)
    planned = [
        (
            Resource(
                ResourceKind.EXTENSION_PROFILE,
                extension_profile_identity(RUN_ID, f"scenario-{index}"),
            ),
            f"scenario-{index}",
        )
        for index in range(32)
    ]

    def persist(item: tuple[Resource, str]) -> None:
        resource, scenario = item
        record_planned(tmp_path, TEST_ENV, RUN_ID, resource, scenario_id=scenario)

    with ThreadPoolExecutor(max_workers=8) as executor:
        tuple(executor.map(persist, planned))

    assert {entry.resource for entry in read_ledger(tmp_path, RUN_ID).entries} == {
        resource for resource, _ in planned
    }


def test_cleanup_uses_only_persisted_exact_resources_and_never_discovers_sentinels(
    tmp_path: Path,
) -> None:
    _runtime(tmp_path)
    database = Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID))
    bucket = Resource(ResourceKind.BUCKET, run_bucket_name(RUN_ID))
    record_planned(tmp_path, TEST_ENV, RUN_ID, database)
    record_created(tmp_path, TEST_ENV, RUN_ID, database)
    record_planned(tmp_path, TEST_ENV, RUN_ID, bucket)
    local_dev_sentinels = {"postgres": "dev_database", "bucket": "user-library"}

    candidates = cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)

    assert [(item.resource, item.endpoint) for item in candidates] == [
        (bucket, "http://127.0.0.1:19000"),
        (database, "postgresql://127.0.0.1:15432"),
    ]
    assert local_dev_sentinels == {"postgres": "dev_database", "bucket": "user-library"}

    ledger_path = tmp_path / ".nexus-test" / "runs" / RUN_ID / "resources.json"
    data = json.loads(ledger_path.read_text())
    data["entries"][0]["identity"] = "production"
    ledger_path.write_text(json.dumps(data))
    with pytest.raises(RuntimeContractError, match="exact test-only name"):
        cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)


@pytest.mark.parametrize(
    ("kind", "identity"),
    [
        (ResourceKind.RUN_DATABASE, "production"),
        (ResourceKind.RUN_DATABASE, run_database_name(OTHER_RUN_ID)),
        (ResourceKind.BUCKET, "nexus-production"),
        (ResourceKind.SUPABASE_USER, "owner@example.com"),
        (ResourceKind.PROCESS, f"nexus-process-{RUN_ID}-worker"),
        (ResourceKind.TEMPLATE, template_database_name("a" * 40)),
    ],
)
def test_production_cross_run_and_shared_names_cannot_enter_the_ledger(
    tmp_path: Path, kind: ResourceKind, identity: str
) -> None:
    _runtime(tmp_path)
    with pytest.raises(RuntimeContractError):
        record_planned(tmp_path, TEST_ENV, RUN_ID, Resource(kind, identity))


def test_supabase_user_persists_exact_run_and_scenario_identity(tmp_path: Path) -> None:
    _runtime(tmp_path)
    scenario = "auth-session"
    user = Resource(ResourceKind.SUPABASE_USER, supabase_user_email(RUN_ID, scenario))

    entry = record_planned(tmp_path, TEST_ENV, RUN_ID, user, scenario_id=scenario)

    assert entry.scenario_id == scenario
    assert supabase_user_metadata(RUN_ID, scenario) == {
        "nexus_test_run_id": RUN_ID,
        "nexus_test_scenario": scenario,
    }
    with pytest.raises(RuntimeContractError, match="scenario"):
        record_planned(tmp_path, TEST_ENV, RUN_ID, user)
    with pytest.raises(RuntimeContractError, match="admin user id"):
        record_created(tmp_path, TEST_ENV, RUN_ID, user)
    user_id = "12345678-1234-4123-8123-123456789abc"
    record_created(tmp_path, TEST_ENV, RUN_ID, user, external_id=user_id)
    assert cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)[0].external_id == user_id


def test_processes_use_fixed_roles_and_record_the_group_before_cleanup(tmp_path: Path) -> None:
    _runtime(tmp_path)
    for role in ("worker-interactive", "worker-background"):
        process = Resource(ResourceKind.PROCESS, process_resource_identity(RUN_ID, role))
        record_planned(tmp_path, TEST_ENV, RUN_ID, process)
        with pytest.raises(RuntimeContractError, match="process-group"):
            record_created(tmp_path, TEST_ENV, RUN_ID, process)
        record_created(tmp_path, TEST_ENV, RUN_ID, process, process_group_id=12000 + len(role))

    assert [
        candidate.process_group_id for candidate in cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)
    ] == [
        12017,
        12018,
    ]
    with pytest.raises(RuntimeContractError, match="unknown process role"):
        process_resource_identity(RUN_ID, "worker")


def test_interrupted_planned_resources_remain_cleanup_candidates(tmp_path: Path) -> None:
    _runtime(tmp_path)
    building = Resource(ResourceKind.TEMPLATE_BUILD, template_build_database_name(RUN_ID))
    record_planned(tmp_path, TEST_ENV, RUN_ID, building)

    assert cleanup_candidates(tmp_path, TEST_ENV, RUN_ID)[0].resource == building


def test_extension_profile_is_scenario_scoped_and_run_releases_only_when_empty(
    tmp_path: Path,
) -> None:
    _runtime(tmp_path)
    profile = Resource(
        ResourceKind.EXTENSION_PROFILE,
        extension_profile_identity(RUN_ID, "reader-extension"),
    )
    record_planned(tmp_path, TEST_ENV, RUN_ID, profile, scenario_id="reader-extension")
    with pytest.raises(RuntimeContractError, match="resources remain"):
        release_run(tmp_path, TEST_ENV, RUN_ID)
    forget_cleaned(tmp_path, TEST_ENV, RUN_ID, profile)
    release_run(tmp_path, TEST_ENV, RUN_ID)
    assert not (tmp_path / ".nexus-test" / "runs" / RUN_ID).exists()


def test_template_fingerprint_is_deterministic_and_has_one_exact_lock(tmp_path: Path) -> None:
    migration = tmp_path / "migration.py"
    seed = tmp_path / "seed.json"
    migration.write_text("revision = 'head'\n")
    seed.write_text('{"seed":1}\n')
    inputs = {
        "migration_sources": (migration,),
        "postgres_image": "pgvector/pgvector:pg15",
        "postgres_version": "15.13",
        "extensions": ("vector",),
        "immutable_seed_sources": (seed,),
    }

    fingerprint = template_fingerprint(tmp_path, **inputs)
    assert fingerprint == template_fingerprint(tmp_path, **inputs)
    assert template_database_name(fingerprint) == f"nexus_tpl_{fingerprint}"
    with template_lifecycle_lock(tmp_path, TEST_ENV, fingerprint) as lock_path:
        competing = lock_path.open("a+b")
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(competing.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            competing.close()
