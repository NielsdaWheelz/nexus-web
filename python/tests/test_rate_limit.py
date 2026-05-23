"""Unit tests for rate limiter admission behavior."""

from typing import Any, cast
from uuid import UUID

import pytest

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.rate_limit import RateLimiter

pytestmark = pytest.mark.unit

USER_ID = UUID("00000000-0000-4000-8000-000000000001")
ADMISSION_METHODS = (
    "check_rpm_limit",
    "check_concurrent_limit",
    "acquire_inflight_slot",
)


def _failing_session_factory():
    raise RuntimeError("database unavailable")


@pytest.mark.parametrize("method_name", ADMISSION_METHODS)
def test_admission_checks_fail_closed_when_backend_is_missing(method_name: str):
    limiter = RateLimiter(session_factory=None)

    with pytest.raises(ApiError) as exc_info:
        getattr(limiter, method_name)(USER_ID)

    assert exc_info.value.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE
    assert exc_info.value.status_code == 503


@pytest.mark.parametrize("method_name", ADMISSION_METHODS)
def test_admission_checks_fail_closed_when_database_is_unavailable(method_name: str):
    limiter = RateLimiter(session_factory=cast(Any, _failing_session_factory))

    with pytest.raises(ApiError) as exc_info:
        getattr(limiter, method_name)(USER_ID)

    assert exc_info.value.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE
    assert exc_info.value.status_code == 503
