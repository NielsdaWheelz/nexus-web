"""Prepared backend coverage for the library intelligence hard cutover.

These tests are intentionally narrow and skip until the expected schema/routes
exist. Once the cutover lands, they exercise the durable artifact contracts
without requiring app-code edits from this test-only worker.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
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

_INTELLIGENCE_TABLES = {
    "library_source_set_versions",
    "library_source_set_items",
    "library_intelligence_artifacts",
    "library_intelligence_versions",
    "library_intelligence_sections",
    "library_intelligence_builds",
}


def _require_library_intelligence_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = sorted(_INTELLIGENCE_TABLES - tables)
    if missing:
        pytest.skip(f"library intelligence schema is not installed yet: missing {missing}")


def _require_route(client, path: str, method: str) -> None:
    routes = {
        (route.path, method_name)
        for route in client.app.routes
        for method_name in getattr(route, "methods", set())
    }
    if (path, method.upper()) not in routes:
        pytest.skip(f"library intelligence route is not installed yet: {method.upper()} {path}")


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _insert_source_set(
    session: Session,
    *,
    library_id: UUID,
    source_set_hash: str,
    source_count: int,
    chunk_count: int,
    prompt_version: str = "library-intelligence-test-prompt",
    schema_version: str = "library-intelligence-test-schema",
) -> UUID:
    source_set_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO library_source_set_versions (
                id,
                library_id,
                source_set_hash,
                source_count,
                chunk_count,
                prompt_version,
                schema_version,
                created_at
            )
            VALUES (
                :id,
                :library_id,
                :source_set_hash,
                :source_count,
                :chunk_count,
                :prompt_version,
                :schema_version,
                :created_at
            )
            """
        ),
        {
            "id": source_set_id,
            "library_id": library_id,
            "source_set_hash": source_set_hash,
            "source_count": source_count,
            "chunk_count": chunk_count,
            "prompt_version": prompt_version,
            "schema_version": schema_version,
            "created_at": datetime.now(UTC),
        },
    )
    return source_set_id


def _insert_source_item(
    session: Session,
    *,
    source_set_id: UUID,
    media_id: UUID,
    readiness_state: str,
    included: bool,
    chunk_count: int,
    exclusion_reason: str | None = None,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO library_source_set_items (
                source_set_version_id,
                media_id,
                podcast_id,
                source_kind,
                title,
                media_kind,
                readiness_state,
                chunk_count,
                included,
                exclusion_reason,
                source_updated_at
            )
            VALUES (
                :source_set_id,
                :media_id,
                NULL,
                'media',
                'Test Source',
                'web_article',
                :readiness_state,
                :chunk_count,
                :included,
                :exclusion_reason,
                :source_updated_at
            )
            """
        ),
        {
            "source_set_id": source_set_id,
            "media_id": media_id,
            "readiness_state": readiness_state,
            "chunk_count": chunk_count,
            "included": included,
            "exclusion_reason": exclusion_reason,
            "source_updated_at": datetime.now(UTC),
        },
    )


def _insert_active_overview_artifact(
    session: Session,
    *,
    library_id: UUID,
    source_set_id: UUID,
    status: str = "active",
    invalidated_at: datetime | None = None,
    invalid_reason: str | None = None,
) -> tuple[UUID, UUID]:
    artifact_id = uuid4()
    version_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (
                id,
                library_id,
                artifact_kind,
                active_version_id,
                created_at,
                updated_at
            )
            VALUES (
                :artifact_id,
                :library_id,
                'overview',
                NULL,
                :now,
                :now
            )
            """
        ),
        {"artifact_id": artifact_id, "library_id": library_id, "now": datetime.now(UTC)},
    )
    session.execute(
        text(
            """
            INSERT INTO library_intelligence_versions (
                id,
                artifact_id,
                library_id,
                source_set_version_id,
                status,
                artifact_version,
                prompt_version,
                generator_model_id,
                published_at,
                invalidated_at,
                invalid_reason
            )
            VALUES (
                :version_id,
                :artifact_id,
                :library_id,
                :source_set_id,
                :status,
                1,
                'library-intelligence-test-prompt',
                NULL,
                :published_at,
                :invalidated_at,
                :invalid_reason
            )
            """
        ),
        {
            "version_id": version_id,
            "artifact_id": artifact_id,
            "library_id": library_id,
            "source_set_id": source_set_id,
            "status": status,
            "published_at": datetime.now(UTC),
            "invalidated_at": invalidated_at,
            "invalid_reason": invalid_reason,
        },
    )
    session.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET active_version_id = :version_id
            WHERE id = :artifact_id
            """
        ),
        {"version_id": version_id, "artifact_id": artifact_id},
    )
    session.execute(
        text(
            """
            INSERT INTO library_intelligence_sections (
                id,
                version_id,
                section_kind,
                title,
                body,
                ordinal,
                metadata
            )
            VALUES (
                :id,
                :version_id,
                'overview',
                'Overview',
                'A source-grounded overview for the test library.',
                0,
                '{}'::jsonb
            )
            """
        ),
        {"id": uuid4(), "version_id": version_id},
    )
    return artifact_id, version_id


def test_source_set_coverage_records_included_and_excluded_sources(
    engine: Engine,
    db_session: Session,
):
    _require_library_intelligence_schema(engine)
    owner_id = create_test_user_id()

    from nexus.services.bootstrap import ensure_user_and_default_library

    default_library_id = ensure_user_and_default_library(db_session, owner_id)
    assert default_library_id is not None
    library_id = create_test_library(db_session, owner_id, "Coverage Library")
    included_media_id = create_test_media(db_session, title="Readable Source")
    excluded_media_id = create_test_media(db_session, title="Failed Source", status="failed")
    add_media_to_library(db_session, library_id, included_media_id)
    add_media_to_library(db_session, library_id, excluded_media_id)

    source_set_id = _insert_source_set(
        db_session,
        library_id=library_id,
        source_set_hash="coverage-hash-v1",
        source_count=2,
        chunk_count=7,
    )
    _insert_source_item(
        db_session,
        source_set_id=source_set_id,
        media_id=included_media_id,
        readiness_state="ready",
        included=True,
        chunk_count=7,
    )
    _insert_source_item(
        db_session,
        source_set_id=source_set_id,
        media_id=excluded_media_id,
        readiness_state="failed",
        included=False,
        chunk_count=0,
        exclusion_reason="source_not_ready",
    )

    rows = (
        db_session.execute(
            text(
                """
            SELECT media_id, readiness_state, included, chunk_count, exclusion_reason
            FROM library_source_set_items
            WHERE source_set_version_id = :source_set_id
            ORDER BY included DESC, media_id ASC
            """
            ),
            {"source_set_id": source_set_id},
        )
        .mappings()
        .all()
    )

    assert [row["included"] for row in rows] == [True, False]
    assert rows[0]["readiness_state"] == "ready"
    assert rows[0]["chunk_count"] == 7
    assert rows[1]["readiness_state"] == "failed"
    assert rows[1]["exclusion_reason"] == "source_not_ready"


def test_refresh_build_idempotency_key_deduplicates_active_request(
    engine: Engine,
    db_session: Session,
):
    _require_library_intelligence_schema(engine)
    owner_id = create_test_user_id()

    from nexus.services.bootstrap import ensure_user_and_default_library

    ensure_user_and_default_library(db_session, owner_id)
    library_id = create_test_library(db_session, owner_id, "Refresh Library")
    source_set_id = _insert_source_set(
        db_session,
        library_id=library_id,
        source_set_hash="refresh-hash-v1",
        source_count=0,
        chunk_count=0,
    )
    idempotency_key = f"{library_id}:{source_set_id}:overview:library-intelligence-test-prompt"
    first_build_id = uuid4()
    second_build_id = uuid4()

    for build_id in (first_build_id, second_build_id):
        db_session.execute(
            text(
                """
                INSERT INTO library_intelligence_builds (
                    id,
                    library_id,
                    source_set_version_id,
                    artifact_kind,
                    status,
                    idempotency_key,
                    phase,
                    error_code,
                    diagnostics,
                    started_at,
                    finished_at
                )
                VALUES (
                    :build_id,
                    :library_id,
                    :source_set_id,
                    'overview',
                    'pending',
                    :idempotency_key,
                    'queued',
                    NULL,
                    '{}'::jsonb,
                    NULL,
                    NULL
                )
                ON CONFLICT (idempotency_key) DO NOTHING
                """
            ),
            {
                "build_id": build_id,
                "library_id": library_id,
                "source_set_id": source_set_id,
                "idempotency_key": idempotency_key,
            },
        )

    rows = (
        db_session.execute(
            text(
                """
            SELECT id, status, phase
            FROM library_intelligence_builds
            WHERE idempotency_key = :idempotency_key
            """
            ),
            {"idempotency_key": idempotency_key},
        )
        .mappings()
        .all()
    )

    assert rows == [{"id": first_build_id, "status": "pending", "phase": "queued"}]


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
        source_set_id = _insert_source_set(
            session,
            library_id=library_id,
            source_set_hash="read-model-hash-v1",
            source_count=0,
            chunk_count=0,
        )
        artifact_id, version_id = _insert_active_overview_artifact(
            session,
            library_id=library_id,
            source_set_id=source_set_id,
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_source_set_versions", "id", source_set_id)
    direct_db.register_cleanup("library_intelligence_artifacts", "id", artifact_id)
    direct_db.register_cleanup("library_intelligence_versions", "id", version_id)
    direct_db.register_cleanup("library_intelligence_sections", "version_id", version_id)

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
    assert data["artifact"]["active_version_id"] == str(version_id)
    assert outsider_response.status_code in {403, 404}, outsider_response.text


def test_stale_artifact_renders_as_stale_not_current(
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
        stale_source_set_id = _insert_source_set(
            session,
            library_id=library_id,
            source_set_hash="stale-hash-v1",
            source_count=1,
            chunk_count=2,
        )
        current_source_set_id = _insert_source_set(
            session,
            library_id=library_id,
            source_set_hash="stale-hash-v2",
            source_count=1,
            chunk_count=3,
        )
        artifact_id, version_id = _insert_active_overview_artifact(
            session,
            library_id=library_id,
            source_set_id=stale_source_set_id,
            status="stale",
            invalidated_at=datetime.now(UTC),
            invalid_reason="source_set_changed",
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_source_set_versions", "id", current_source_set_id)
    direct_db.register_cleanup(
        "library_intelligence_builds", "source_set_version_id", current_source_set_id
    )
    direct_db.register_cleanup("library_source_set_versions", "id", stale_source_set_id)
    direct_db.register_cleanup("library_intelligence_artifacts", "id", artifact_id)
    direct_db.register_cleanup("library_intelligence_versions", "id", version_id)
    direct_db.register_cleanup("library_intelligence_sections", "version_id", version_id)

    response = auth_client.get(
        f"/libraries/{library_id}/intelligence",
        headers=auth_headers(owner_id),
    )

    assert response.status_code == 200, response.text
    artifact = response.json()["data"]["artifact"]
    assert artifact["active_version_id"] == str(version_id)
    assert artifact["status"] == "stale"
    assert artifact["freshness"]["current_source_set_version_id"] == str(current_source_set_id)
    assert artifact["freshness"]["active_source_set_version_id"] == str(stale_source_set_id)


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
        source_set_id = _insert_source_set(
            session,
            library_id=library_id,
            source_set_hash="refresh-endpoint-hash-v1",
            source_count=0,
            chunk_count=0,
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("library_source_set_versions", "id", source_set_id)
    direct_db.register_cleanup(
        "library_intelligence_builds", "source_set_version_id", source_set_id
    )

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
        title="Grid Reliability Notes",
    )

    refresh = refresh_library_intelligence(db_session, owner_id, library_id)
    build_result = run_library_intelligence_build(db_session, refresh.build_id)
    result = get_library_intelligence(db_session, owner_id, library_id)
    key_sources = next(
        section for section in result.sections if section.section_kind == "key_sources"
    )

    assert build_result["status"] == "succeeded", f"Expected build to succeed, got {build_result}"
    assert result.status == "current"
    assert result.artifact.active_version_id is not None
    assert key_sources.claims, "Expected source claims on the published key-sources section"
    assert key_sources.claims[0].support_state == "supported"
    assert key_sources.claims[0].evidence, "Supported source claim must include evidence"
    assert "Grid Reliability Notes" in key_sources.body
