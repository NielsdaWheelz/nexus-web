from pathlib import Path

import pytest

from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    extension_profile_identity,
    initialize_runtime,
    read_ledger,
    record_created,
    record_planned,
)
from nexus_test_control.services import clean_run
from nexus_test_control.services import test_environment as controlled_environment
from tests.testkit.database import require_test_database_url


def test_environment_isolation_rejects_production_and_cleans_only_the_exact_run(
    tmp_path: Path,
) -> None:
    """Priority risk: test-environment-isolation."""
    production_sentinel = tmp_path / "production-sentinel"
    production_sentinel.write_text("must survive", encoding="utf-8")

    with pytest.raises(RuntimeContractError, match="non-test NEXUS_ENV"):
        controlled_environment({"NEXUS_ENV": "prod"})
    with pytest.raises(RuntimeContractError, match="caller resource configuration"):
        controlled_environment(
            {
                "NEXUS_ENV": "test",
                "R2_S3_API_ORIGIN": "https://account.r2.cloudflarestorage.com",
            }
        )
    local_database_url = (
        "postgresql+psycopg://127.0.0.1:21001/"
        "nexus_run_0123456789abcdef?user=postgres&password=postgres"
    )
    assert (
        require_test_database_url(
            {
                "NEXUS_ENV": "test",
                "NEXUS_TEST_RUN_ID": "0123456789abcdef",
                "DATABASE_URL": local_database_url,
            }
        )
        == local_database_url
    )
    with pytest.raises(ValueError, match="runner-owned local PostgreSQL clone"):
        require_test_database_url(
            {
                "NEXUS_ENV": "test",
                "NEXUS_TEST_RUN_ID": "fedcba9876543210",
                "DATABASE_URL": local_database_url,
            }
        )
    with pytest.raises(ValueError, match="runner-owned local PostgreSQL clone"):
        require_test_database_url(
            {
                "NEXUS_ENV": "test",
                "NEXUS_TEST_RUN_ID": "0123456789abcdef",
                "DATABASE_URL": (
                    "postgresql+psycopg://db.example.com:5432/"
                    "nexus_run_0123456789abcdef?user=postgres&password=postgres"
                ),
            }
        )

    environment = controlled_environment({})
    initialize_runtime(tmp_path, environment, RuntimePorts(*range(21001, 21011)))
    cleaned_run = "0123456789abcdef"
    preserved_run = "fedcba9876543210"
    claim_run(tmp_path, environment, cleaned_run)
    claim_run(tmp_path, environment, preserved_run)

    with pytest.raises(RuntimeContractError, match="exact test-only name"):
        record_planned(
            tmp_path,
            environment,
            cleaned_run,
            Resource(ResourceKind.RUN_DATABASE, "nexus-production"),
        )

    cleaned_identity = extension_profile_identity(cleaned_run, "reader")
    preserved_identity = extension_profile_identity(preserved_run, "reader")
    cleaned_resource = Resource(ResourceKind.EXTENSION_PROFILE, cleaned_identity)
    record_planned(
        tmp_path,
        environment,
        cleaned_run,
        cleaned_resource,
        scenario_id="reader",
    )
    cleaned_profile = tmp_path / cleaned_identity
    cleaned_profile.mkdir(parents=True)
    (cleaned_profile / "state").write_text(cleaned_run, encoding="utf-8")

    preserved_resource = Resource(ResourceKind.EXTENSION_PROFILE, preserved_identity)
    record_planned(
        tmp_path,
        environment,
        preserved_run,
        preserved_resource,
        scenario_id="reader",
    )
    preserved_profile = tmp_path / preserved_identity
    preserved_profile.mkdir(parents=True)
    (preserved_profile / "state").write_text(preserved_run, encoding="utf-8")
    record_created(tmp_path, environment, preserved_run, preserved_resource)

    clean_run(tmp_path, environment, cleaned_run)

    assert not (tmp_path / cleaned_identity).exists(), (
        f"clean retained the exact profile owned by run {cleaned_run}"
    )
    assert (tmp_path / preserved_identity / "state").read_text(encoding="utf-8") == preserved_run, (
        f"clean for run {cleaned_run} mutated sibling run {preserved_run}"
    )
    assert read_ledger(tmp_path, preserved_run).run_id == preserved_run
    assert production_sentinel.read_text(encoding="utf-8") == "must survive"
