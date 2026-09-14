"""Actual API middleware with only authentication authority controlled."""

from uuid import UUID

from fastapi import FastAPI
from sqlalchemy.orm import Session

from nexus.api.read_admission import ReadAdmission
from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.testkit.auth import StaticTokenVerifier, UserRecord


def production_read_app(
    db_session: Session, test_user: UserRecord
) -> tuple[FastAPI, dict[str, str]]:
    verifier = StaticTokenVerifier(test_user.id, test_user.email)

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        return ensure_user_and_default_library(db_session, user_id, email)

    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            bootstrap_callback=bootstrap,
        )
    )
    add_request_id_middleware(app, log_requests=False)
    # Explicit fixture input, not a production-qualified capacity profile. The
    # deadlines are long enough that only a test that sets its own shorter one
    # observes expiry.
    app.state.read_admission = ReadAdmission(
        max_concurrency=1, deadline_seconds=30, retry_after_seconds=1, request_bytes=262144
    )
    app.state.image_admission = ReadAdmission(
        max_concurrency=1, deadline_seconds=30, retry_after_seconds=1, request_bytes=262144
    )
    app.state.package_transfer_admission = ReadAdmission(
        max_concurrency=1, deadline_seconds=60, retry_after_seconds=1, request_bytes=262144
    )
    return app, {"Authorization": f"Bearer {verifier.token}", "X-Request-ID": "read-admission"}
