"""Stream-token mint endpoint.

Pins the one cross-endpoint behavior at risk when stream-token logic moved out of
``auth/`` into ``services/stream_tokens``: the per-user RPM throttle (shared with
chat-run creation) must still fire as an explicit route guard *before* minting.
"""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from nexus.api.routes import stream_tokens as stream_tokens_route
from nexus.errors import ApiError, ApiErrorCode
from tests.helpers import auth_headers
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class _RaisingRateLimiter:
    """Stands in for a user who is already past their RPM budget."""

    def check_rpm_limit(self, user_id) -> None:
        raise ApiError(ApiErrorCode.E_RATE_LIMITED, "Rate limit exceeded")


def test_stream_token_mint_past_rpm_limit_returns_429(
    auth_client: TestClient,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    # The route calls get_rate_limiter().check_rpm_limit before mint_stream_token;
    # stubbing the limiter to raise proves the guard fires (and 429s) ahead of the mint.
    monkeypatch.setattr(stream_tokens_route, "get_rate_limiter", lambda: _RaisingRateLimiter())

    response = auth_client.post("/internal/stream-tokens", headers=auth_headers(user_id))

    assert response.status_code == 429
    assert response.json()["error"]["code"] == ApiErrorCode.E_RATE_LIMITED.value
