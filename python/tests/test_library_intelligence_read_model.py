"""Schema + read-model coverage for the head/revision library-intelligence model."""

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.factories import (
    add_library_member,
    create_test_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# The Rev 3 head/revision tables that must exist at head.
_CURRENT_INTELLIGENCE_TABLES = {
    "library_intelligence_artifacts",
    "library_intelligence_artifact_revisions",
    "library_intelligence_revision_events",
    "library_intelligence_citations",
}

# The deterministic-compiler subtables dropped by 0141 (plus the already-dropped
# source-set/version tables from 0138).
_REMOVED_INTELLIGENCE_TABLES = {
    "library_intelligence_sections",
    "library_intelligence_nodes",
    "library_intelligence_claims",
    "library_intelligence_evidence",
    "library_intelligence_builds",
    "library_source_set_versions",
    "library_source_set_items",
    "library_intelligence_versions",
}

_NEW_HEAD_COLUMNS = {"current_revision_id", "user_id"}
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
    head_columns = {col["name"] for col in inspector.get_columns("library_intelligence_artifacts")}
    assert _NEW_HEAD_COLUMNS.issubset(head_columns), head_columns
    assert _REMOVED_HEAD_COLUMNS.isdisjoint(head_columns), head_columns


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
    from nexus.schemas.library_intelligence import LibraryIntelligenceArtifactOut

    with pytest.raises(ValidationError):
        LibraryIntelligenceArtifactOut.model_validate(
            {
                "status": "current",
                "active_version_id": str(uuid4()),
            }
        )


def test_artifact_out_schema_has_no_support_state_or_sections():
    import nexus.schemas.library_intelligence as schema

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
        json={"idempotency_key": "route-token-1"},
        headers=auth_headers(owner_id),
    )
    assert response.status_code == 202, response.text
    data = response.json()["data"]
    assert data["run_id"] == data["revision_id"]
    assert UUID(data["artifact_id"])

    # Idempotency: reusing the token returns the same revision.
    again = auth_client.post(
        f"/libraries/{library_id}/intelligence/generate",
        json={"idempotency_key": "route-token-1"},
        headers=auth_headers(owner_id),
    )
    assert again.status_code == 202, again.text
    assert again.json()["data"]["revision_id"] == data["revision_id"]


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
    assert "reference_added" in constraint


def test_chat_runs_next_event_seq_column_is_gone(db_session: Session, engine: Engine):
    _require_library_intelligence_schema(engine)
    columns = {col["name"] for col in inspect(engine).get_columns("chat_runs")}
    assert "next_event_seq" not in columns


def test_circular_head_revision_fk_present(db_session: Session, engine: Engine):
    _require_library_intelligence_schema(engine)
    fk = db_session.execute(
        text("SELECT conname FROM pg_constraint WHERE conname = 'fk_li_artifacts_current_revision'")
    ).scalar_one_or_none()
    assert fk == "fk_li_artifacts_current_revision"
    # Nullable until the first revision is promoted (the circular FK is resolved
    # after both tables exist; §11).
    nullable = db_session.execute(
        text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name = 'library_intelligence_artifacts' "
            "AND column_name = 'current_revision_id'"
        )
    ).scalar_one()
    assert nullable == "YES"
