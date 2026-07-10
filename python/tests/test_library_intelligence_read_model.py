"""Schema + read-model coverage for the head/revision library-intelligence model."""

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from tests.factories import (
    add_library_member,
    create_test_library,
    create_test_media_in_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# The Rev 3 head/revision tables that must exist at head.
_CURRENT_INTELLIGENCE_TABLES = {
    "artifacts",
    "artifact_revisions",
    "artifact_revision_events",
}

# The deterministic-compiler subtables dropped by 0141 (plus the already-dropped
# source-set/version tables from 0138, and the LI-private citation table folded
# into resource_edges by 0145).
_REMOVED_INTELLIGENCE_TABLES = {
    "library_intelligence_sections",
    "library_intelligence_nodes",
    "library_intelligence_claims",
    "library_intelligence_evidence",
    "library_intelligence_builds",
    "library_source_set_versions",
    "library_source_set_items",
    "library_intelligence_versions",
    "library_intelligence_citations",
}

_NEW_HEAD_COLUMNS = {"current_revision_id", "user_id"}
_NEW_REVISION_COLUMNS = {"custom_instruction"}
_REMOVED_HEAD_COLUMNS = {
    "artifact_kind",
    "status",
    "generator_model_id",
    "published_at",
    "invalidated_at",
    "invalid_reason",
    "active_version_id",
}


def _require_library_intelligence_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    missing = sorted(_CURRENT_INTELLIGENCE_TABLES - tables)
    if missing:
        pytest.fail(f"test database is not migrated to the head/revision schema: missing {missing}")
    assert _REMOVED_INTELLIGENCE_TABLES.isdisjoint(tables)
    head_columns = {col["name"] for col in inspector.get_columns("artifacts")}
    assert _NEW_HEAD_COLUMNS.issubset(head_columns), head_columns
    assert _REMOVED_HEAD_COLUMNS.isdisjoint(head_columns), head_columns
    revision_columns = {col["name"] for col in inspector.get_columns("artifact_revisions")}
    assert _NEW_REVISION_COLUMNS.issubset(revision_columns), revision_columns


def _require_route(client, path: str, method: str) -> None:
    routes = {
        (route.path, method_name)
        for route in client.app.routes
        for method_name in getattr(route, "methods", set())
    }
    if (path, method.upper()) not in routes:
        pytest.fail(
            f"FastAPI app is missing required library-intelligence route: {method.upper()} {path}"
        )


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def test_artifact_out_schema_rejects_removed_version_fields():
    from nexus.schemas.artifact import DossierArtifactOut

    with pytest.raises(ValidationError):
        DossierArtifactOut.model_validate(
            {
                "status": "current",
                "active_version_id": str(uuid4()),
            }
        )


def test_artifact_out_schema_has_no_support_state_or_sections():
    import nexus.schemas.artifact as schema

    assert not hasattr(schema, "SupportState")
    assert not hasattr(schema, "SectionKind")
    assert not hasattr(schema, "LibraryIntelligenceSectionOut")


def test_unavailable_artifact_for_member_without_head(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
):
    _require_library_intelligence_schema(engine)
    _require_route(auth_client, "/libraries/{library_id}/intelligence", "GET")
    owner_id = create_test_user_id()
    member_id = create_test_user_id()
    outsider_id = create_test_user_id()
    _bootstrap_user(auth_client, owner_id)
    _bootstrap_user(auth_client, member_id)
    _bootstrap_user(auth_client, outsider_id)

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Empty Intelligence")
        add_library_member(session, library_id, member_id, role="member")
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)

    member_response = auth_client.get(
        f"/libraries/{library_id}/intelligence",
        headers=auth_headers(member_id),
    )
    outsider_response = auth_client.get(
        f"/libraries/{library_id}/intelligence",
        headers=auth_headers(outsider_id),
    )

    assert member_response.status_code == 200, member_response.text
    data = member_response.json()["data"]
    assert data["status"] == "unavailable"
    assert data["artifact_id"] is None
    assert data["revision_id"] is None
    assert data["citations"] == []
    assert data["citation_count"] == 0
    assert data["source_count"] == 0
    assert data["covered_source_count"] == 0
    assert data["omitted_source_count"] == 0
    assert data["model_provider"] is None
    assert data["model_name"] is None
    assert outsider_response.status_code in {403, 404}, outsider_response.text


def test_generate_route_returns_202_and_revision_is_run(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
):
    _require_library_intelligence_schema(engine)
    _require_route(auth_client, "/libraries/{library_id}/intelligence/generate", "POST")
    owner_id = create_test_user_id()
    _bootstrap_user(auth_client, owner_id)

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Generate Route")
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)

    response = auth_client.post(
        f"/libraries/{library_id}/intelligence/generate",
        json={"instruction": "  focus on source tensions  "},
        headers={**auth_headers(owner_id), "Idempotency-Key": "route-token-1"},
    )
    assert response.status_code == 202, response.text
    data = response.json()["data"]
    assert "run_id" not in data
    assert UUID(data["artifact_id"])
    with direct_db.session() as session:
        stored_instruction = session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": UUID(data["revision_id"])},
        ).scalar_one()
    assert stored_instruction == "focus on source tensions"

    # Idempotency: replaying the header key returns the same revision.
    again = auth_client.post(
        f"/libraries/{library_id}/intelligence/generate",
        json={"instruction": "try to overwrite"},
        headers={**auth_headers(owner_id), "Idempotency-Key": "route-token-1"},
    )
    assert again.status_code == 202, again.text
    assert again.json()["data"]["revision_id"] == data["revision_id"]
    with direct_db.session() as session:
        replay_instruction = session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": UUID(data["revision_id"])},
        ).scalar_one()
    assert replay_instruction == "focus on source tensions"

    # A different key forks a fresh ordinary-regenerate draft when instruction is blank.
    forked = auth_client.post(
        f"/libraries/{library_id}/intelligence/generate",
        json={"instruction": "   "},
        headers={**auth_headers(owner_id), "Idempotency-Key": "route-token-2"},
    )
    assert forked.status_code == 202, forked.text
    assert forked.json()["data"]["revision_id"] != data["revision_id"]
    with direct_db.session() as session:
        forked_instruction = session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": UUID(forked.json()["data"]["revision_id"])},
        ).scalar_one()
    assert forked_instruction is None

    # The header is required: a body-only request is rejected (the app maps
    # request-validation failures to 400 E_INVALID_REQUEST).
    missing = auth_client.post(
        f"/libraries/{library_id}/intelligence/generate",
        json={"instruction": "focus on missing header"},
        headers=auth_headers(owner_id),
    )
    assert missing.status_code == 400, missing.text
    assert missing.json()["error"]["code"] == "E_INVALID_REQUEST", missing.text


def test_revision_routes_read_historical_citations_after_head_moves(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
):
    _require_library_intelligence_schema(engine)
    _require_route(auth_client, "/libraries/{library_id}/intelligence/revisions", "GET")
    _require_route(
        auth_client,
        "/libraries/{library_id}/intelligence/revisions/{revision_id}",
        "GET",
    )
    _require_route(
        auth_client,
        "/libraries/{library_id}/intelligence/revisions/{revision_id}/promote",
        "POST",
    )
    owner_id = create_test_user_id()
    _bootstrap_user(auth_client, owner_id)

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Revision Routes")
        media_id = create_test_media_in_library(session, owner_id, library_id, title="Route Source")
        artifact_id = session.execute(
            text(
                """
                INSERT INTO artifacts (subject_scheme, subject_id, kind, user_id)
                VALUES ('library', :library_id, 'library_dossier', :user_id)
                RETURNING id
                """
            ),
            {"library_id": library_id, "user_id": owner_id},
        ).scalar_one()
        first_revision_id = session.execute(
            text(
                """
                INSERT INTO artifact_revisions (
                    artifact_id, content_md, covered_targets, status, promoted_at
                )
                VALUES (:artifact_id, 'First body [1].', '[]'::jsonb, 'ready', now())
                RETURNING id
                """
            ),
            {"artifact_id": artifact_id},
        ).scalar_one()
        second_revision_id = session.execute(
            text(
                """
                INSERT INTO artifact_revisions (
                    artifact_id, content_md, covered_targets, status, promoted_at
                )
                VALUES (:artifact_id, 'Second body [1].', '[]'::jsonb, 'ready', now())
                RETURNING id
                """
            ),
            {"artifact_id": artifact_id},
        ).scalar_one()
        session.execute(
            text("UPDATE artifacts SET current_revision_id = :revision_id WHERE id = :artifact_id"),
            {"revision_id": second_revision_id, "artifact_id": artifact_id},
        )
        session.add_all(
            [
                ResourceEdge(
                    user_id=owner_id,
                    kind="supports",
                    origin="citation",
                    source_scheme="artifact_revision",
                    source_id=first_revision_id,
                    target_scheme="media",
                    target_id=media_id,
                    ordinal=1,
                    snapshot={"title": "First Source", "excerpt": "first"},
                ),
                ResourceEdge(
                    user_id=owner_id,
                    kind="supports",
                    origin="citation",
                    source_scheme="artifact_revision",
                    source_id=second_revision_id,
                    target_scheme="media",
                    target_id=media_id,
                    ordinal=1,
                    snapshot={"title": "Second Source", "excerpt": "second"},
                ),
            ]
        )
        session.commit()

    direct_db.register_cleanup("resource_edges", "user_id", owner_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)

    revisions = auth_client.get(
        f"/libraries/{library_id}/intelligence/revisions",
        headers=auth_headers(owner_id),
    )
    assert revisions.status_code == 200, revisions.text
    rows = revisions.json()["data"]["revisions"]
    assert {row["revision_ref"] for row in rows} == {
        f"artifact_revision:{first_revision_id}",
        f"artifact_revision:{second_revision_id}",
    }
    assert {row["citation_count"] for row in rows} == {1}
    assert {row["source_count"] for row in rows} == {0}
    assert {row["covered_source_count"] for row in rows} == {0}
    assert {row["omitted_source_count"] for row in rows} == {0}
    assert {row["model_provider"] for row in rows} == {None}
    assert {row["revision_id"]: row["is_current"] for row in rows} == {
        str(first_revision_id): False,
        str(second_revision_id): True,
    }

    historical = auth_client.get(
        f"/libraries/{library_id}/intelligence/revisions/{first_revision_id}",
        headers=auth_headers(owner_id),
    )
    assert historical.status_code == 200, historical.text
    data = historical.json()["data"]
    assert data["revision_ref"] == f"artifact_revision:{first_revision_id}"
    assert data["content_md"] == "First body [1]."
    assert data["is_current"] is False
    assert data["citations"][0]["snapshot"]["title"] == "First Source"
    assert data["citation_count"] == 1
    assert data["source_count"] == 0
    assert data["model_provider"] is None

    promoted = auth_client.post(
        f"/libraries/{library_id}/intelligence/revisions/{first_revision_id}/promote",
        headers=auth_headers(owner_id),
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["data"]["revision_ref"] == (f"artifact_revision:{first_revision_id}")
    assert "run_id" not in promoted.json()["data"]

    after = auth_client.get(
        f"/libraries/{library_id}/intelligence/revisions/{second_revision_id}",
        headers=auth_headers(owner_id),
    )
    assert after.status_code == 200, after.text
    assert after.json()["data"]["revision_ref"] == f"artifact_revision:{second_revision_id}"
    assert after.json()["data"]["is_current"] is False
    assert after.json()["data"]["citations"][0]["snapshot"]["title"] == "Second Source"


def test_chat_run_events_check_lacks_claim_values(db_session: Session, engine: Engine):
    _require_library_intelligence_schema(engine)
    constraint = db_session.execute(
        text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_chat_run_events_event_type'"
        )
    ).scalar_one()
    assert "claim_evidence" not in constraint
    assert "'claim'" not in constraint
    assert "citation_index" in constraint
    assert "context_ref_added" in constraint


def test_chat_runs_next_event_seq_column_is_gone(db_session: Session, engine: Engine):
    _require_library_intelligence_schema(engine)
    columns = {col["name"] for col in inspect(engine).get_columns("chat_runs")}
    assert "next_event_seq" not in columns


def test_circular_head_revision_fk_present(db_session: Session, engine: Engine):
    _require_library_intelligence_schema(engine)
    fk = db_session.execute(
        text("SELECT conname FROM pg_constraint WHERE conname = 'fk_artifacts_current_revision'")
    ).scalar_one_or_none()
    assert fk == "fk_artifacts_current_revision"
    # Nullable until the first revision is promoted (the circular FK is resolved
    # after both tables exist; §11).
    nullable = db_session.execute(
        text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name = 'artifacts' "
            "AND column_name = 'current_revision_id'"
        )
    ).scalar_one()
    assert nullable == "YES"
