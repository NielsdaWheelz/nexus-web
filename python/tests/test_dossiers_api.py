from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.artifacts import revisions as revision_service
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph.citations import record_citation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot
from tests.factories import (
    add_library_member,
    create_test_library,
    create_test_library_artifact,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers
from tests.test_resource_graph_resolve import _make_span
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_shared_library_revision_keeps_owner_citation_but_member_target_fails_closed(
    db_session: Session,
) -> None:
    owner_id = uuid4()
    member_id = uuid4()
    ensure_user_and_default_library(db_session, owner_id)
    ensure_user_and_default_library(db_session, member_id)
    library_id = create_test_library(db_session, owner_id, "Shared Dossier")
    add_library_member(db_session, library_id, member_id)
    owner_default_library_id = get_user_default_library(db_session, owner_id)
    assert owner_default_library_id is not None
    private_media_id = create_test_media_in_library(
        db_session,
        owner_id,
        owner_default_library_id,
        title="Owner-only evidence",
    )
    private_span_id = _make_span(
        db_session,
        private_media_id,
        text="Private evidence locator.",
    )
    _artifact_id, revision_id = create_test_library_artifact(
        db_session,
        library_id=library_id,
        requester_user_id=owner_id,
        content_md="Shared synthesis with private historical evidence [1].",
    )
    record_citation(
        db_session,
        viewer_id=owner_id,
        source=ResourceRef(scheme="artifact_revision", id=revision_id),
        target=ResourceRef(scheme="evidence_span", id=private_span_id),
        ordinal=1,
        kind="supports",
        snapshot=CitationSnapshot(
            title="Historical evidence snapshot",
            excerpt="Snapshot prose remains readable.",
        ),
    )
    db_session.commit()

    revision = revision_service.get_revision(
        db_session,
        viewer_id=member_id,
        revision_id=revision_id,
    )

    assert len(revision.citations) == 1, (
        "the Library owner's citation edge remains part of shared revision history"
    )
    citation = revision.citations[0]
    assert citation.target_ref.id == private_span_id
    assert citation.snapshot is not None
    assert citation.snapshot.title == "Historical evidence snapshot"
    assert citation.activation.model_dump() == {
        "resource_ref": f"evidence_span:{private_span_id}",
        "kind": "none",
        "href": None,
        "unresolved_reason": "missing",
    }
    assert citation.media_id is None
    assert citation.locator is None


def test_generic_head_build_replay_cancel_contract(
    authenticated_client: TestClient,
) -> None:
    user_id = uuid4()
    conversation_id = authenticated_client.post(
        "/conversations",
        headers=auth_headers(user_id),
    ).json()["data"]["id"]
    try:
        path = f"/artifacts/dossiers/conversation/{conversation_id}"

        never_generated = authenticated_client.get(path, headers=auth_headers(user_id))
        assert never_generated.status_code == 200
        assert never_generated.json()["data"] == {
            "artifact_id": {"kind": "Absent"},
            "artifact_ref": {"kind": "Absent"},
            "current_revision": {"kind": "Absent"},
            "freshness": {"kind": "Absent"},
            "active_build": {"kind": "Absent"},
            "latest_unsuccessful_build": {"kind": "Absent"},
            "revision_count": 0,
            "media_abstract": {"kind": "Absent"},
        }
        headers = {**auth_headers(user_id), "Idempotency-Key": "api-build-1"}
        first = authenticated_client.post(
            f"{path}/builds",
            headers=headers,
            json={"instruction": {"kind": "Absent"}},
        )
        replay = authenticated_client.post(
            f"{path}/builds",
            headers=headers,
            json={"instruction": {"kind": "Absent"}},
        )
        assert first.status_code == replay.status_code == 202
        first_data = first.json()["data"]
        assert first_data["created"] is True
        assert replay.json()["data"] == {**first_data, "created": False}
        assert first_data["artifact_ref"].startswith("artifact:")
        assert first_data["build_handle"].startswith("ab1.")

        active = authenticated_client.get(path, headers=auth_headers(user_id)).json()["data"]
        assert active["active_build"]["kind"] == "Present"
        assert active["active_build"]["value"]["execution"]["value"]["phase"] == "Queued"

        cancelled = authenticated_client.post(
            f"/artifact-builds/{first_data['build_handle']}/cancel",
            headers=auth_headers(user_id),
        )
        replayed_cancel = authenticated_client.post(
            f"/artifact-builds/{first_data['build_handle']}/cancel",
            headers=auth_headers(user_id),
        )
        assert cancelled.status_code == replayed_cancel.status_code == 204
        after = authenticated_client.get(path, headers=auth_headers(user_id)).json()["data"]
        assert after["active_build"] == {"kind": "Absent"}
        assert after["latest_unsuccessful_build"]["value"]["cancellation"]["kind"] == "Present"
    finally:
        deleted = authenticated_client.delete(
            f"/conversations/{conversation_id}",
            headers=auth_headers(user_id),
        )
        assert deleted.status_code == 204, deleted.text


def test_generic_dossier_api_masks_subject_and_requires_idempotency_key(
    authenticated_client: TestClient,
) -> None:
    owner_id = uuid4()
    other_id = uuid4()
    conversation_id = authenticated_client.post(
        "/conversations",
        headers=auth_headers(owner_id),
    ).json()["data"]["id"]
    try:
        authenticated_client.get("/me", headers=auth_headers(other_id))
        path = f"/artifacts/dossiers/conversation/{conversation_id}"

        masked = authenticated_client.get(path, headers=auth_headers(other_id))
        assert masked.status_code == 404
        assert masked.json()["error"]["code"] == "E_NOT_FOUND"

        missing_key = authenticated_client.post(
            f"{path}/builds",
            headers=auth_headers(owner_id),
            json={"instruction": {"kind": "Absent"}},
        )
        assert missing_key.status_code == 400
        assert missing_key.json()["error"]["code"] == "E_INVALID_REQUEST"

        invalid_subject = authenticated_client.get(
            f"/artifacts/dossiers/message/{UUID(int=1)}",
            headers=auth_headers(owner_id),
        )
        assert invalid_subject.status_code == 400
    finally:
        deleted = authenticated_client.delete(
            f"/conversations/{conversation_id}",
            headers=auth_headers(owner_id),
        )
        assert deleted.status_code == 204, deleted.text


def test_revision_and_history_reauthorize_subject_visibility(
    authenticated_client: TestClient,
    direct_db: DirectSessionManager,
) -> None:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    conversation_id = UUID(
        authenticated_client.post(
            "/conversations",
            headers=auth_headers(user_id),
        ).json()["data"]["id"]
    )
    artifact_id = uuid4()
    build_id = uuid4()
    revision_id = uuid4()
    manifest = {
        "version": "v1",
        "kind": "conversation",
        "conversation_ref": f"conversation:{conversation_id}",
        "message_refs": [],
        "context_refs": [],
        "topology_fingerprint": {"kind": "Present", "value": "topology"},
        "completeness": {"kind": "Complete"},
    }
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO artifacts (
                    id, subject_scheme, subject_id, audience_scheme, audience_id
                )
                VALUES (:id, 'conversation', :subject_id, 'user', :audience_id)
                """
            ),
            {
                "id": artifact_id,
                "subject_id": conversation_id,
                "audience_id": str(user_id),
            },
        )
        db.execute(
            text(
                """
                INSERT INTO artifact_builds (
                    id, artifact_id, requester_user_id, idempotency_key
                )
                VALUES (:id, :artifact_id, :user_id, :idempotency_key)
                """
            ),
            {
                "id": build_id,
                "artifact_id": artifact_id,
                "user_id": user_id,
                "idempotency_key": f"visibility-{build_id}",
            },
        )
        db.execute(
            text(
                """
                INSERT INTO artifact_revisions (
                    id, build_id, content_md, input_manifest,
                    citation_owner_user_id, promoted_at
                )
                VALUES (
                    :id, :build_id, '# Dossier', CAST(:manifest AS jsonb),
                    :user_id, now()
                )
                """
            ),
            {
                "id": revision_id,
                "build_id": build_id,
                "manifest": json.dumps(manifest),
                "user_id": user_id,
            },
        )
        db.execute(
            text("UPDATE artifacts SET current_revision_id = :revision_id WHERE id = :artifact_id"),
            {"revision_id": revision_id, "artifact_id": artifact_id},
        )
        db.commit()

    headers = auth_headers(user_id)
    revision_path = f"/artifact-revisions/artifact_revision:{revision_id}"
    history_path = f"/artifacts/artifact:{artifact_id}/revisions"
    assert authenticated_client.get(revision_path, headers=headers).status_code == 200
    assert authenticated_client.get(history_path, headers=headers).status_code == 200

    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": conversation_id},
        )
        db.commit()

    revision = authenticated_client.get(revision_path, headers=headers)
    history = authenticated_client.get(history_path, headers=headers)
    assert revision.status_code == history.status_code == 404
    assert revision.json()["error"]["code"] == "E_NOT_FOUND"
    assert history.json()["error"]["code"] == "E_NOT_FOUND"
