from __future__ import annotations

import pytest

from tests.testkit.database import (
    require_test_database_url,
    require_test_migration_database_url,
)

_RUN_ID = "0123456789abcdef"
_BASE_ENV = {"NEXUS_ENV": "test", "NEXUS_TEST_RUN_ID": _RUN_ID}


def test_database_contract_accepts_only_runner_owned_database_shapes() -> None:
    run_url = (
        f"postgresql+psycopg://127.0.0.1:15432/nexus_run_{_RUN_ID}?user=postgres&password=postgres"
    )
    migration_url = (
        f"postgresql+psycopg://127.0.0.1:15432/nexus_migration_{_RUN_ID}"
        "?user=postgres&password=postgres"
    )
    assert require_test_database_url({**_BASE_ENV, "DATABASE_URL": run_url}) == run_url
    assert (
        require_test_migration_database_url(
            {**_BASE_ENV, "NEXUS_MIGRATION_DATABASE_URL": migration_url}
        )
        == migration_url
    )


@pytest.mark.parametrize(
    ("key", "url"),
    (
        ("DATABASE_URL", f"postgresql+psycopg://db.prod/nexus_run_{_RUN_ID}"),
        ("DATABASE_URL", "postgresql+psycopg://127.0.0.1:15432/nexus"),
        (
            "NEXUS_MIGRATION_DATABASE_URL",
            f"postgresql+psycopg://db.prod/nexus_migration_{_RUN_ID}",
        ),
        ("NEXUS_MIGRATION_DATABASE_URL", "postgresql+psycopg://127.0.0.1:15432/postgres"),
    ),
)
def test_database_contract_rejects_public_or_unowned_database(key: str, url: str) -> None:
    environment = {**_BASE_ENV, key: url}
    validator = (
        require_test_database_url if key == "DATABASE_URL" else require_test_migration_database_url
    )
    with pytest.raises(ValueError, match="runner-owned local"):
        validator(environment)
