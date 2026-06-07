"""Integration coverage for the current-only library intelligence read model."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.factories import (
    add_library_member,
    add_media_to_library,
    create_searchable_media_in_library,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_CURRENT_INTELLIGENCE_TABLES = {
    "library_intelligence_artifacts",
    "library_intelligence_sections",
    "library_intelligence_nodes",
    "library_intelligence_claims",
    "library_intelligence_evidence",
    "library_intelligence_builds",
}

_REMOVED_INTELLIGENCE_TABLES = {
    "library_source_set_versions",
    "library_source_set_items",
    "library_intelligence_versions",
}

_REMOVED_PUBLIC_ARTIFACT_FIELDS = {
    "active_version_id",
    "source_set_version_id",
    "prompt_version",
    "schema_version",
    "artifact_version",
    "freshness",
}


def _require_library_intelligence_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = sorted(_CURRENT_INTELLIGENCE_TABLES - tables)
    if missing:
        pytest.fail(
            f"test database is not migrated to the library-intelligence schema: missing {missing}"
        )
    assert _REMOVED_INTELLIGENCE_TABLES.isdisjoint(tables)


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


def _assert_artifact_has_no_removed_public_fields(artifact: dict[str, object]) -> None:
    assert _REMOVED_PUBLIC_ARTIFACT_FIELDS.isdisjoint(artifact)


def _insert_active_overview_artifact(
    session: Session,
    *,
    library_id: UUID,
    status: str = "active",
    published_at: datetime | None = None,
    invalidated_at: datetime | None = None,
    invalid_reason: str | None = None,
) -> UUID:
    artifact_id = uuid4()
    now = datetime.now(UTC)
    session.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (
                id,
                library_id,
                artifact_kind,
                status,
                published_at,
                invalidated_at,
                invalid_reason,
                created_at,
                updated_at
            )
            VALUES (
                :artifact_id,
                :library_id,
                'overview',
                :status,
                :published_at,
                :invalidated_at,
                :invalid_reason,
                :now,
                :now
            )
            """
        ),
        {
            "artifact_id": artifact_id,
            "library_id": library_id,
            "status": status,
            "published_at": published_at or now,
            "invalidated_at": invalidated_at,
            "invalid_reason": invalid_reason,
            "now": now,
        },
    )
    session.execute(
        text(
            """
            INSERT INTO library_intelligence_sections (
                id,
                artifact_id,
                section_kind,
                title,
                body,
                ordinal,
                metadata
            )
            VALUES (
                :id,
                :artifact_id,
                'overview',
                'Overview',
                'A source-grounded overview for the test library.',
                0,
                '{}'::jsonb
            )
            """
        ),
        {"id": uuid4(), "artifact_id": artifact_id},
    )
    return artifact_id


def test_artifact_schema_rejects_removed_version_fields():
    from nexus.schemas.library_intelligence import LibraryIntelligenceArtifactOut

    with pytest.raises(ValidationError):
        LibraryIntelligenceArtifactOut.model_validate(
            {
                "kind": "overview",
                "status": "current",
                "published_at": None,
                "active_version_id": str(uuid4()),
            }
        )


def test_current_coverage_records_included_and_excluded_sources(
    engine: Engine,
    db_session: Session,
):
    _require_library_intelligence_schema(engine)
    owner_id = create_test_user_id()

    from nexus.services.bootstrap import ensure_user_and_default_library
    from nexus.services.library_intelligence import get_library_intelligence

    ensure_user_and_default_library(db_session, owner_id)
    library_id = create_test_library(db_session, owner_id, "Coverage Library")
    included_media_id = create_searchable_media_in_library(
        db_session,
        owner_id,
        library_id,
        title="Readable Source",
    )
    excluded_media_id = create_test_media(db_session, title="Failed Source", status="failed")
    add_media_to_library(db_session, library_id, excluded_media_id)

    result = get_library_intelligence(db_session, owner_id, library_id)
    coverage_by_media = {row.media_id: row for row in result.coverage}

    assert coverage_by_media[included_media_id].included is True
    assert coverage_by_media[included_media_id].chunk_count > 0
    assert coverage_by_media[excluded_media_id].included is False
    assert coverage_by_media[excluded_media_id].exclusion_reason == "source_not_ready"


def test_refresh_build_deduplicates_inflight_request(
    engine: Engine,
    db_session: Session,
):
    _require_library_intelligence_schema(engine)
    owner_id = create_test_user_id()

    from nexus.services.bootstrap import ensure_user_and_default_library
    from nexus.services.library_intelligence import refresh_library_intelligence

    ensure_user_and_default_library(db_session, owner_id)
    library_id = create_test_library(db_session, owner_id, "Refresh Library")

    first = refresh_library_intelligence(db_session, owner_id, library_id)
    second = refresh_library_intelligence(db_session, owner_id, library_id)

    assert second.build_id == first.build_id
    assert second.idempotent is True


def test_supported_artifact_read_model_is_member_only(
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
        library_id = create_test_library(session, owner_id, "Readable Intelligence")
        add_library_member(session, library_id, member_id, role="member")
        artifact_id = _insert_active_overview_artifact(session, library_id=library_id)
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_intelligence_artifacts", "id", artifact_id)
    direct_db.register_cleanup("library_intelligence_sections", "artifact_id", artifact_id)

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
    assert data["library_id"] == str(library_id)
    assert data["artifact"]["kind"] == "overview"
    assert data["artifact"]["status"] == "current"
    _assert_artifact_has_no_removed_public_fields(data["artifact"])
    assert outsider_response.status_code in {403, 404}, outsider_response.text


def test_stale_artifact_renders_as_stale_and_queues_rebuild(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
):
    _require_library_intelligence_schema(engine)
    _require_route(auth_client, "/libraries/{library_id}/intelligence", "GET")
    owner_id = create_test_user_id()
    _bootstrap_user(auth_client, owner_id)

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Stale Intelligence")
        create_searchable_media_in_library(
            session,
            owner_id,
            library_id,
            title="Fresh Source",
        )
        artifact_id = _insert_active_overview_artifact(
            session,
            library_id=library_id,
            published_at=datetime(2000, 1, 1, tzinfo=UTC),
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_intelligence_builds", "library_id", library_id)
    direct_db.register_cleanup("library_intelligence_artifacts", "id", artifact_id)
    direct_db.register_cleanup("library_intelligence_sections", "artifact_id", artifact_id)

    response = auth_client.get(
        f"/libraries/{library_id}/intelligence",
        headers=auth_headers(owner_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    artifact = data["artifact"]
    assert artifact["status"] == "stale"
    assert data["build"]["status"] == "pending"
    _assert_artifact_has_no_removed_public_fields(artifact)


def test_manual_refresh_endpoint_deduplicates_existing_build(
    auth_client,
    direct_db: DirectSessionManager,
    engine: Engine,
):
    _require_library_intelligence_schema(engine)
    _require_route(auth_client, "/libraries/{library_id}/intelligence/refresh", "POST")
    owner_id = create_test_user_id()
    _bootstrap_user(auth_client, owner_id)

    with direct_db.session() as session:
        library_id = create_test_library(session, owner_id, "Refresh Endpoint")
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_intelligence_builds", "library_id", library_id)

    first_response = auth_client.post(
        f"/libraries/{library_id}/intelligence/refresh",
        json={"artifact_kind": "overview"},
        headers=auth_headers(owner_id),
    )
    second_response = auth_client.post(
        f"/libraries/{library_id}/intelligence/refresh",
        json={"artifact_kind": "overview"},
        headers=auth_headers(owner_id),
    )

    assert first_response.status_code == 202, first_response.text
    assert second_response.status_code == 202, second_response.text
    first = first_response.json()["data"]
    second = second_response.json()["data"]
    assert second["build_id"] == first["build_id"]
    assert second["idempotent"] is True


def test_build_publishes_current_artifact_with_supported_evidence(
    engine: Engine,
    db_session: Session,
):
    _require_library_intelligence_schema(engine)
    owner_id = create_test_user_id()

    from nexus.services.bootstrap import ensure_user_and_default_library
    from nexus.services.library_intelligence import (
        get_library_intelligence,
        refresh_library_intelligence,
        run_library_intelligence_build,
    )

    ensure_user_and_default_library(db_session, owner_id)
    library_id = create_test_library(db_session, owner_id, "Build Library")
    create_searchable_media_in_library(
        db_session,
        owner_id,
        library_id,
        title="Build Source",
    )

    refresh = refresh_library_intelligence(db_session, owner_id, library_id)
    result = run_library_intelligence_build(db_session, refresh.build_id)
    read_model = get_library_intelligence(db_session, owner_id, library_id)

    assert result["status"] == "succeeded"
    assert read_model.status == "current"
    assert read_model.artifact.status == "current"
    assert read_model.artifact.published_at is not None
    assert read_model.sections
