"""Priority proof: anonymous bearer links stay bound to one durable subject."""

from __future__ import annotations

from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.db.models import (
    BillingEntitlementOverride,
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    ProcessingStatus,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.resource_grants import (
    LinkGrantAudience,
    UserGrantAudience,
    create_grant,
    delete_grant,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_storage_path
from tests.testkit.auth import UserRecord


def _seed_pdf(
    db: Session,
    *,
    owner_id: UUID,
    title: str,
    payload: bytes,
) -> tuple[ResourceRef, str]:
    media_id = uuid4()
    attempt_id = uuid4()
    storage_path = build_storage_path(media_id, "pdf")
    db.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title=title,
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=owner_id,
                page_count=1,
            ),
            MediaSourceAttempt(
                id=attempt_id,
                media_id=media_id,
                created_by_user_id=owner_id,
                source_type="uploaded_pdf_file",
                attempt_no=1,
                status="succeeded",
                intent_key=f"public-share-proof:{media_id}",
            ),
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/pdf",
                size_bytes=len(payload),
            ),
        ]
    )
    db.flush()
    ensure_media_in_default_library(db, owner_id, media_id)
    get_storage_client().put_object(storage_path, payload, "application/pdf")
    return ResourceRef("media", media_id), storage_path


def test_anonymous_link_matrix_binds_each_token_to_one_postgres_and_minio_subject(
    db_session: Session,
    test_user: UserRecord,
    anonymous_client: TestClient,
) -> None:
    """Link, user, invalid, cross-resource, and revoked paths stay distinct."""
    recipient_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        recipient_id,
        f"public-share-recipient-{recipient_id}@example.invalid",
    )
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id,
            plan_tier="plus",
            reason="public resource sharing priority proof",
        )
    )
    first_payload = b"%PDF-1.4 exact first public subject"
    second_payload = b"%PDF-1.4 exact second public subject"
    first, first_path = _seed_pdf(
        db_session,
        owner_id=test_user.id,
        title="First sealed subject",
        payload=first_payload,
    )
    second, second_path = _seed_pdf(
        db_session,
        owner_id=test_user.id,
        title="Second sealed subject",
        payload=second_payload,
    )
    storage = get_storage_client()

    try:
        first_link = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=first,
            audience=LinkGrantAudience(),
        ).grant
        second_link = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=second,
            audience=LinkGrantAudience(),
        ).grant
        user_grant = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=first,
            audience=UserGrantAudience(user_id=recipient_id),
        ).grant
        assert first_link.share_token is not None, (
            f"first link grant {first_link.grant_id} did not expose its bearer token"
        )
        assert second_link.share_token is not None, (
            f"second link grant {second_link.grant_id} did not expose its bearer token"
        )
        assert user_grant.share_token is None, (
            f"user grant {user_grant.grant_id} incorrectly became anonymously bearer-readable"
        )

        first_headers = {"X-Nexus-Share-Token": str(first_link.share_token)}
        second_headers = {"X-Nexus-Share-Token": str(second_link.share_token)}
        first_bootstrap = anonymous_client.get(
            "/public/resource-share",
            headers=first_headers,
        )
        second_bootstrap = anonymous_client.get(
            "/public/resource-share",
            headers=second_headers,
        )
        assert first_bootstrap.status_code == 200, (
            f"first bearer grant failed bootstrap: {first_bootstrap.text}"
        )
        assert second_bootstrap.status_code == 200, (
            f"second bearer grant failed bootstrap: {second_bootstrap.text}"
        )
        assert first_bootstrap.json()["data"]["media"]["title"] == "First sealed subject", (
            f"first token resolved the wrong durable subject: {first_bootstrap.json()!r}"
        )
        assert second_bootstrap.json()["data"]["media"]["title"] == "Second sealed subject", (
            f"second token resolved the wrong durable subject: {second_bootstrap.json()!r}"
        )

        first_file = anonymous_client.get(
            "/public/resource-share/file",
            headers=first_headers,
        )
        second_file = anonymous_client.get(
            "/public/resource-share/file",
            headers=second_headers,
        )
        assert first_file.status_code == 200 and first_file.content == first_payload, (
            "first token did not stream exactly its PostgreSQL-owned MinIO object: "
            f"status={first_file.status_code}, body={first_file.content!r}"
        )
        assert second_file.status_code == 200 and second_file.content == second_payload, (
            "second token escaped its grant or streamed the wrong MinIO object: "
            f"status={second_file.status_code}, body={second_file.content!r}"
        )

        invalid = anonymous_client.get(
            "/public/resource-share",
            headers={"X-Nexus-Share-Token": "not-a-share-token"},
        )
        missing = anonymous_client.get("/public/resource-share")
        assert (invalid.status_code, invalid.json()["error"]["code"]) == (
            404,
            "E_NOT_FOUND",
        ), f"invalid bearer token was not masked: {invalid.text}"
        assert (missing.status_code, missing.json()["error"]["code"]) == (
            404,
            "E_NOT_FOUND",
        ), f"missing bearer token was not masked: {missing.text}"

        delete_grant(
            db_session,
            viewer_user_id=test_user.id,
            handle=first_link.handle,
        )
        revoked = anonymous_client.get(
            "/public/resource-share",
            headers=first_headers,
        )
        assert (
            revoked.status_code,
            revoked.json()["error"]["code"],
            revoked.json()["error"]["message"],
        ) == (
            invalid.status_code,
            invalid.json()["error"]["code"],
            invalid.json()["error"]["message"],
        ), f"revoked bearer leaked a distinguishable authorization state: {revoked.text}"
    finally:
        storage.delete_object(first_path)
        storage.delete_object(second_path)
