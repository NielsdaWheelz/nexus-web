from __future__ import annotations

from pathlib import Path

import pytest

from nexus.config import Environment
from nexus.runtime_health import (
    NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV,
    PRODUCTION_RUNTIME_IDENTITY_FILE,
    database_revision_is_ready,
    runtime_identity_path,
)


def test_runtime_identity_path_is_explicit_and_non_overridable_in_deployments() -> None:
    nonproduction_path = Path("/tmp/nexus-test-runtime-identity.json")

    assert (
        runtime_identity_path(
            environment=Environment.TEST,
            environ={NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV: str(nonproduction_path)},
        )
        == nonproduction_path
    )
    with pytest.raises(RuntimeError, match="required"):
        runtime_identity_path(environment=Environment.LOCAL, environ={})
    with pytest.raises(RuntimeError, match="not permitted"):
        runtime_identity_path(
            environment=Environment.PROD,
            environ={NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV: str(nonproduction_path)},
        )
    assert (
        runtime_identity_path(environment=Environment.STAGING, environ={})
        == PRODUCTION_RUNTIME_IDENTITY_FILE
    )


@pytest.mark.parametrize(
    ("observed_revisions", "expected", "ready"),
    [
        (("0210",), "0210", True),
        ((), "0210", False),
        (("0209",), "0210", False),
        (("0210", "branch_head"), "0210", False),
    ],
)
def test_database_readiness_requires_one_exact_revision(
    observed_revisions: tuple[str, ...], expected: str, ready: bool
) -> None:
    assert database_revision_is_ready(observed_revisions, expected) is ready
