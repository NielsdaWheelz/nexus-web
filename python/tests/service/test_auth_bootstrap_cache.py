"""Priority proof: authenticated bootstrap reuse remains scoped to one user."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.testkit.auth import StaticTokenVerifier


class _ExternalVerifierFake:
    def __init__(self, identities: tuple[tuple[UUID, str], ...]) -> None:
        verifiers = tuple(StaticTokenVerifier(user_id, email) for user_id, email in identities)
        self._verifiers = {verifier.token: verifier for verifier in verifiers}
        self._token_by_user = {
            UUID(str(verifier.verify(verifier.token)["sub"])): verifier.token
            for verifier in verifiers
        }

    def token_for(self, user_id: UUID) -> str:
        return self._token_by_user[user_id]

    def verify(self, token: str) -> dict[str, Any]:
        verifier = self._verifiers.get(token)
        if verifier is None:
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid test token")
        return verifier.verify(token)


def test_auth_bootstrap_cache_reuses_only_the_matching_users_durable_library(
    db_session: Session,
) -> None:
    first_user_id = uuid4()
    second_user_id = uuid4()
    first_email = f"auth-cache-first-{first_user_id}@example.invalid"
    second_email = f"auth-cache-second-{second_user_id}@example.invalid"
    first_library_id = ensure_user_and_default_library(db_session, first_user_id, first_email)
    second_library_id = ensure_user_and_default_library(db_session, second_user_id, second_email)
    verifier = _ExternalVerifierFake(((first_user_id, first_email), (second_user_id, second_email)))
    bootstrap_calls: dict[UUID, int] = {}

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        bootstrap_calls[user_id] = bootstrap_calls.get(user_id, 0) + 1
        return ensure_user_and_default_library(db_session, user_id, email)

    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=bootstrap,
        )
    )

    def session() -> Generator[Session, None, None]:
        yield db_session

    app.dependency_overrides[get_db] = session
    with TestClient(app) as client:
        first = client.get(
            "/me",
            headers={"Authorization": f"Bearer {verifier.token_for(first_user_id)}"},
        )
        second = client.get(
            "/me",
            headers={"Authorization": f"Bearer {verifier.token_for(second_user_id)}"},
        )
        warm_first = client.get(
            "/me",
            headers={"Authorization": f"Bearer {verifier.token_for(first_user_id)}"},
        )

    assert first.status_code == second.status_code == warm_first.status_code == 200, (
        "real authenticated bootstrap/profile requests did not all succeed: "
        f"first={first.text}; second={second.text}; warm={warm_first.text}"
    )
    first_profile = first.json()["data"]
    second_profile = second.json()["data"]
    warm_profile = warm_first.json()["data"]
    assert first_profile["default_library_id"] == str(first_library_id)
    assert second_profile["default_library_id"] == str(second_library_id), (
        "second authenticated identity reused the first user's bootstrap cache entry"
    )
    assert warm_profile == first_profile, (
        f"warm bootstrap cache changed the first Viewer projection: {warm_profile!r}"
    )
    assert bootstrap_calls == {first_user_id: 1, second_user_id: 1}, (
        "auth bootstrap must call the real durable owner once per cold user and never on warm "
        f"reuse: {bootstrap_calls!r}"
    )
