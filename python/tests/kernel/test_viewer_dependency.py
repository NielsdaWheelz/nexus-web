"""The authenticated viewer projection runs directly in the request coroutine."""

import asyncio
from uuid import UUID

import pytest
from fastapi import Request

from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode


def test_viewer_dependency_returns_the_middleware_identity() -> None:
    user_id = UUID("11111111-1111-4111-8111-111111111111")
    viewer = Viewer(user_id=user_id, default_library_id=user_id)
    request = Request({"type": "http", "state": {"viewer": viewer}})

    assert asyncio.run(get_viewer(request)) is viewer


def test_viewer_dependency_rejects_missing_authentication() -> None:
    request = Request({"type": "http"})

    with pytest.raises(ApiError) as raised:
        asyncio.run(get_viewer(request))

    assert raised.value.code is ApiErrorCode.E_UNAUTHENTICATED
