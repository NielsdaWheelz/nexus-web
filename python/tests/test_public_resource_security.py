from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nexus.app import create_app
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.public_resource_security import PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS
from nexus.services import public_resource_sharing


@pytest.fixture
def public_client():
    app = create_app(skip_auth_middleware=True)
    app.dependency_overrides[get_db] = lambda: object()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def _assert_public_headers(response) -> None:
    for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
        assert response.headers[name] == value
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    ("method", "path", "expected_status"),
    [
        ("POST", "/public/resource-share", 405),
        ("GET", "/public/resource-share/unknown", 404),
    ],
)
def test_public_api_framework_errors_receive_closed_headers(
    public_client,
    method: str,
    path: str,
    expected_status: int,
) -> None:
    response = public_client.request(method, path)

    assert response.status_code == expected_status
    _assert_public_headers(response)


def test_authorized_malformed_pagination_uses_nexus_envelope_and_headers(
    public_client,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        public_resource_sharing,
        "get_public_fragments",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            public_resource_sharing.PublicRequestValidation(
                "limit must be an integer from 1 to 100"
            )
        ),
    )

    response = public_client.get(
        "/public/resource-share/fragments?limit=bad",
        headers={"X-Nexus-Share-Token": "authorized"},
    )

    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "E_INVALID_REQUEST",
        "message": "limit must be an integer from 1 to 100",
    }
    _assert_public_headers(response)


@pytest.mark.parametrize("failure", ["masked", "unhandled"])
def test_public_api_service_errors_receive_same_closed_headers(
    public_client,
    monkeypatch,
    failure: str,
) -> None:
    if failure == "masked":
        error: Exception = NotFoundError(
            ApiErrorCode.E_NOT_FOUND,
            "Share unavailable",
        )
        expected_status = 404
    else:
        error = RuntimeError("private failure")
        expected_status = 500
    monkeypatch.setattr(
        public_resource_sharing,
        "get_public_bootstrap",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    response = public_client.get("/public/resource-share")

    assert response.status_code == expected_status
    _assert_public_headers(response)
