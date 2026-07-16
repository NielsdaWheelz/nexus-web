"""Tests for database migrations.

These tests run on a SEPARATE DATABASE (nexus_test_migrations) from other tests.
This allows them to safely drop/recreate schema without affecting other tests.

Run with: make test-migrations
Do NOT run with: make test (these are excluded)
"""

import json
import os
import re
import subprocess
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

pytestmark = pytest.mark.integration


def get_test_database_url() -> str:
    """Get the test database URL from environment."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.fail("DATABASE_URL environment variable must be set")
    return url


def get_migrations_dir() -> str:
    """Get the path to the migrations directory."""
    # From python/tests/, go up to repo root, then into migrations/
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    python_dir = os.path.dirname(tests_dir)
    repo_root = os.path.dirname(python_dir)
    return os.path.join(repo_root, "migrations")


def run_alembic_command(command: str) -> subprocess.CompletedProcess:
    """Run an alembic command and return the result."""
    migrations_dir = get_migrations_dir()
    python_dir = os.path.join(os.path.dirname(migrations_dir), "python")
    result = subprocess.run(
        ["uv", "run", "--project", python_dir, "alembic"] + command.split(),
        capture_output=True,
        text=True,
        env={**os.environ},
        cwd=migrations_dir,
    )
    return result


def reset_test_schema() -> None:
    """Reset the dedicated migration database without relying on downgrades."""
    engine = create_engine(get_test_database_url(), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as connection:
            connection.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            connection.execute(text("CREATE SCHEMA public"))
            connection.execute(text("GRANT ALL ON SCHEMA public TO postgres"))
            connection.execute(text("GRANT ALL ON SCHEMA public TO public"))
    finally:
        engine.dispose()


def insert_canonical_fragment_highlight(
    session: Session,
    *,
    highlight_id,
    user_id,
    media_id,
    fragment_id,
    start_offset: int,
    end_offset: int,
    color: str = "yellow",
    exact: str = "exact",
    prefix: str = "prefix",
    suffix: str = "suffix",
    created_at=None,
) -> None:
    """Insert a head-schema fragment highlight plus its canonical anchor row."""
    highlight_params = {
        "id": highlight_id,
        "user_id": user_id,
        "media_id": media_id,
        "color": color,
        "exact": exact,
        "prefix": prefix,
        "suffix": suffix,
    }
    if created_at is None:
        session.execute(
            text(
                """
                INSERT INTO highlights (
                    id,
                    user_id,
                    anchor_kind,
                    anchor_media_id,
                    color,
                    exact,
                    prefix,
                    suffix
                )
                VALUES (
                    :id,
                    :user_id,
                    'fragment_offsets',
                    :media_id,
                    :color,
                    :exact,
                    :prefix,
                    :suffix
                )
                """
            ),
            highlight_params,
        )
    else:
        session.execute(
            text(
                """
                INSERT INTO highlights (
                    id,
                    user_id,
                    anchor_kind,
                    anchor_media_id,
                    color,
                    exact,
                    prefix,
                    suffix,
                    created_at
                )
                VALUES (
                    :id,
                    :user_id,
                    'fragment_offsets',
                    :media_id,
                    :color,
                    :exact,
                    :prefix,
                    :suffix,
                    :created_at
                )
                """
            ),
            {**highlight_params, "created_at": created_at},
        )

    session.execute(
        text(
            """
            INSERT INTO highlight_fragment_anchors (
                highlight_id,
                fragment_id,
                start_offset,
                end_offset
            )
            VALUES (
                :highlight_id,
                :fragment_id,
                :start_offset,
                :end_offset
            )
            """
        ),
        {
            "highlight_id": highlight_id,
            "fragment_id": fragment_id,
            "start_offset": start_offset,
            "end_offset": end_offset,
        },
    )


def insert_evidence_span_offset_fixture(session: Session) -> dict[str, UUID]:
    """Insert the minimum rows needed to exercise evidence_span offset constraints."""
    user_id = uuid4()
    media_id = uuid4()
    index_run_id = uuid4()
    source_snapshot_id = uuid4()
    first_block_id = uuid4()
    second_block_id = uuid4()

    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', 'Evidence Offset Fixture', 'ready_for_reading', :user_id)
            """
        ),
        {"id": media_id, "user_id": user_id},
    )
    session.execute(
        text(
            """
            INSERT INTO content_index_runs (
                id,
                media_id,
                state,
                source_version,
                extractor_version,
                chunker_version,
                embedding_provider,
                embedding_model,
                embedding_version,
                embedding_config_hash,
                started_at
            )
            VALUES (
                :id,
                :media_id,
                'ready',
                'fixture:v1',
                'fixture',
                'fixture',
                'fixture',
                'fixture',
                'fixture',
                'fixture',
                now()
            )
            """
        ),
        {"id": index_run_id, "media_id": media_id},
    )
    session.execute(
        text(
            """
            INSERT INTO source_snapshots (
                id,
                media_id,
                index_run_id,
                source_kind,
                artifact_kind,
                artifact_ref,
                content_type,
                byte_length,
                source_fingerprint,
                source_version,
                extractor_version,
                content_sha256,
                metadata
            )
            VALUES (
                :id,
                :media_id,
                :index_run_id,
                'web_article',
                'fragments',
                'fixture',
                'text/plain',
                25,
                'fixture',
                'fixture:v1',
                'fixture',
                :content_sha256,
                '{}'::jsonb
            )
            """
        ),
        {
            "id": source_snapshot_id,
            "media_id": media_id,
            "index_run_id": index_run_id,
            "content_sha256": "a" * 64,
        },
    )
    for block_idx, block_id, text_value, start_offset, end_offset in (
        (0, first_block_id, "first block", 0, 11),
        (1, second_block_id, "second block", 13, 25),
    ):
        session.execute(
            text(
                """
                INSERT INTO content_blocks (
                    id,
                    media_id,
                    index_run_id,
                    source_snapshot_id,
                    block_idx,
                    block_kind,
                    canonical_text,
                    text_sha256,
                    source_start_offset,
                    source_end_offset,
                    heading_path,
                    locator,
                    selector,
                    metadata
                )
                VALUES (
                    :id,
                    :media_id,
                    :index_run_id,
                    :source_snapshot_id,
                    :block_idx,
                    'paragraph',
                    :text_value,
                    :text_sha256,
                    :start_offset,
                    :end_offset,
                    '[]'::jsonb,
                    '{}'::jsonb,
                    '{}'::jsonb,
                    '{}'::jsonb
                )
                """
            ),
            {
                "id": block_id,
                "media_id": media_id,
                "index_run_id": index_run_id,
                "source_snapshot_id": source_snapshot_id,
                "block_idx": block_idx,
                "text_value": text_value,
                "text_sha256": "b" * 64,
                "start_offset": start_offset,
                "end_offset": end_offset,
            },
        )
    session.commit()

    return {
        "media_id": media_id,
        "index_run_id": index_run_id,
        "source_snapshot_id": source_snapshot_id,
        "first_block_id": first_block_id,
        "second_block_id": second_block_id,
    }


def insert_cross_block_backwards_evidence_span(
    session: Session,
    fixture: dict[str, UUID],
) -> UUID:
    evidence_span_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO evidence_spans (
                id,
                media_id,
                index_run_id,
                source_snapshot_id,
                start_block_id,
                end_block_id,
                start_block_offset,
                end_block_offset,
                span_text,
                span_sha256,
                selector,
                citation_label,
                resolver_kind
            )
            VALUES (
                :id,
                :media_id,
                :index_run_id,
                :source_snapshot_id,
                :first_block_id,
                :second_block_id,
                9,
                2,
                'cross block span',
                :span_sha256,
                '{}'::jsonb,
                'Fixture',
                'web'
            )
            """
        ),
        {
            "id": evidence_span_id,
            "media_id": fixture["media_id"],
            "index_run_id": fixture["index_run_id"],
            "source_snapshot_id": fixture["source_snapshot_id"],
            "first_block_id": fixture["first_block_id"],
            "second_block_id": fixture["second_block_id"],
            "span_sha256": "c" * 64,
        },
    )
    return evidence_span_id


@pytest.fixture(scope="session", autouse=True)
def verify_schema_exists():
    """Override the global verify_schema_exists fixture.

    Migration tests manage their own schema state, so we skip the check.
    """
    yield


@pytest.fixture(scope="module")
def migrated_engine():
    """Create engine and run migrations for the module.

    This fixture runs migrations at the start of the module and
    downgrades at the end to clean up.
    """
    database_url = get_test_database_url()
    engine = create_engine(database_url)

    reset_test_schema()

    # Run migrations
    result = run_alembic_command("upgrade head")
    if result.returncode != 0:
        pytest.fail(f"Migration upgrade failed: {result.stderr}")

    yield engine

    reset_test_schema()
    engine.dispose()


def _insert_message_context_parent_rows(
    session: Session,
    *,
    user_id: UUID,
    conversation_id: UUID,
    message_id: UUID,
) -> None:
    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :user_id, 'private', 2)
        """),
        {"id": conversation_id, "user_id": user_id},
    )
    session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :conversation_id, 1, 'user', 'test', 'complete')
        """),
        {"id": message_id, "conversation_id": conversation_id},
    )


class TestMigrationUpgradeDowngrade:
    """Tests that migrations apply and rollback cleanly."""

    def test_upgrade_succeeds(self):
        """Migration upgrade to head succeeds on empty database."""
        reset_test_schema()

        result = run_alembic_command("upgrade head")

        assert result.returncode == 0, f"Upgrade failed: {result.stderr}"

    def test_hard_cutover_downgrade_to_base_is_blocked(self):
        """Head intentionally cannot downgrade through hard-cutover migrations.

        Each hard-cutover ``downgrade()`` raises ``NotImplementedError``
        (the message varies per migration, e.g. ``"Hard cutover: 0115 is not
        reversible"``). The assertion below checks for the consistent marker
        in the stderr output."""
        reset_test_schema()
        run_alembic_command("upgrade head")

        result = run_alembic_command("downgrade base")

        assert result.returncode != 0
        combined = (result.stdout or "") + (result.stderr or "")
        assert (
            "NotImplementedError" in combined
            or "hard cutover migration and has no downgrade path" in combined
            or "Hard cutover" in combined
        ), (
            "Expected downgrade from head to surface NotImplementedError "
            "or 'Hard cutover' marker; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )

    def test_0137_rewrites_legacy_processing_statuses_and_replaces_enum(self):
        reset_test_schema()
        assert run_alembic_command("upgrade 0136").returncode == 0
        engine = create_engine(get_test_database_url())
        user_id = uuid4()
        media_ids = {status: uuid4() for status in ("embedding", "ready", "ready_for_reading")}
        try:
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                for status, media_id in media_ids.items():
                    session.execute(
                        text("""
                            INSERT INTO media (
                                id, kind, title, processing_status, created_by_user_id
                            )
                            VALUES (
                                :id, 'web_article', :title,
                                CAST(:status AS processing_status_enum), :user_id
                            )
                        """),
                        {
                            "id": media_id,
                            "title": f"Legacy {status}",
                            "status": status,
                            "user_id": user_id,
                        },
                    )
                session.commit()
        finally:
            engine.dispose()

        result = run_alembic_command("upgrade 0137")
        assert result.returncode == 0, result.stderr

        engine = create_engine(get_test_database_url())
        try:
            with Session(engine) as session:
                rows = dict(
                    session.execute(
                        text("""
                            SELECT id, processing_status::text
                            FROM media
                            WHERE created_by_user_id = :user_id
                        """),
                        {"user_id": user_id},
                    ).all()
                )
                assert rows[media_ids["embedding"]] == "ready_for_reading"
                assert rows[media_ids["ready"]] == "ready_for_reading"
                assert rows[media_ids["ready_for_reading"]] == "ready_for_reading"
                labels = [
                    row[0]
                    for row in session.execute(
                        text("""
                            SELECT enumlabel
                            FROM pg_enum
                            WHERE enumtypid = 'processing_status_enum'::regtype
                            ORDER BY enumsortorder
                        """)
                    )
                ]
                assert labels == ["pending", "extracting", "ready_for_reading", "failed"]
                index_names = {
                    row[0]
                    for row in session.execute(
                        text("""
                            SELECT indexname
                            FROM pg_indexes
                            WHERE schemaname = 'public'
                              AND tablename = 'media'
                              AND indexname IN (
                                  'idx_media_stale_extracting_recovery',
                                  'idx_media_stale_pending_upload_cleanup'
                              )
                        """)
                    )
                }
                assert index_names == {
                    "idx_media_stale_extracting_recovery",
                    "idx_media_stale_pending_upload_cleanup",
                }
        finally:
            engine.dispose()

    def test_0137_downgrade_to_0136_is_blocked(self):
        reset_test_schema()
        assert run_alembic_command("upgrade 0137").returncode == 0

        result = run_alembic_command("downgrade 0136")

        assert result.returncode != 0
        combined = (result.stdout or "") + (result.stderr or "")
        assert "Hard cutover: 0137 is not reversible" in combined
        reset_test_schema()

    def test_0140_drops_message_tool_calls_semantic_column(self):
        """Search hybrid-invariant cutover (§11/D-14): 0140 drops the dead ``semantic``
        toggle column and retains ``requested_types``."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())

        def has_column(column: str) -> bool:
            with Session(engine) as session:
                return (
                    session.execute(
                        text(
                            """
                            SELECT 1
                            FROM information_schema.columns
                            WHERE table_name = 'message_tool_calls'
                              AND column_name = :column
                            """
                        ),
                        {"column": column},
                    ).first()
                    is not None
                )

        try:
            assert run_alembic_command("upgrade 0139").returncode == 0
            assert has_column("semantic"), "semantic column should exist at 0139"

            assert run_alembic_command("upgrade 0140").returncode == 0
            assert not has_column("semantic"), "0140 must drop message_tool_calls.semantic"
            assert has_column("requested_types"), "0140 must retain requested_types"
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0140_downgrade_is_blocked(self):
        reset_test_schema()
        assert run_alembic_command("upgrade 0140").returncode == 0

        result = run_alembic_command("downgrade 0139")

        assert result.returncode != 0
        combined = (result.stdout or "") + (result.stderr or "")
        assert "no downgrade path" in combined or "NotImplementedError" in combined
        reset_test_schema()

    def test_0107_canonicalizes_reader_selection_context_snapshots(self):
        """Reader-selection context snapshots are upgraded from legacy camelCase keys."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0106")
            assert result.returncode == 0, f"upgrade to 0106 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            message_id = uuid4()
            media_id = uuid4()
            client_context_id = uuid4()
            fragment_id = uuid4()
            locator = {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": 0,
                "end_offset": 12,
            }
            with Session(engine) as session:
                _insert_message_context_parent_rows(
                    session,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                )
                session.execute(
                    text("""
                        INSERT INTO message_context_items (
                            message_id,
                            user_id,
                            context_kind,
                            source_media_id,
                            locator_json,
                            ordinal,
                            context_snapshot
                        )
                        VALUES (
                            :message_id,
                            :user_id,
                            'reader_selection',
                            :media_id,
                            CAST(:locator AS jsonb),
                            0,
                            CAST(:context_snapshot AS jsonb)
                        )
                    """),
                    {
                        "message_id": message_id,
                        "user_id": user_id,
                        "media_id": media_id,
                        "locator": json.dumps(locator),
                        "context_snapshot": json.dumps(
                            {
                                "kind": "reader_selection",
                                "clientContextId": str(client_context_id),
                                "mediaId": str(media_id),
                                "sourceMediaId": str(media_id),
                                "mediaKind": "web_article",
                                "mediaTitle": "Legacy Reader Source",
                                "exact": "quoted text",
                                "prefix": "before ",
                                "suffix": " after",
                                "locator": locator,
                                "sourceVersion": f"fragment:{fragment_id}",
                            }
                        ),
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0107")
            assert result.returncode == 0, f"upgrade to 0107 failed: {result.stderr}"

            with Session(engine) as session:
                snapshot = session.execute(
                    text("""
                        SELECT context_snapshot
                        FROM message_context_items
                        WHERE message_id = :message_id
                    """),
                    {"message_id": message_id},
                ).scalar_one()

            assert snapshot == {
                "kind": "reader_selection",
                "client_context_id": str(client_context_id),
                "media_id": str(media_id),
                "source_media_id": str(media_id),
                "media_kind": "web_article",
                "media_title": "Legacy Reader Source",
                "exact": "quoted text",
                "prefix": "before ",
                "suffix": " after",
                "locator": locator,
                "source_version": f"fragment:{fragment_id}",
            }
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0108_canonicalizes_object_ref_context_snapshots(self):
        """Object-ref context snapshots are upgraded from hydrated legacy keys."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0107")
            assert result.returncode == 0, f"upgrade to 0107 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            message_id = uuid4()
            chunk_id = uuid4()
            media_id = uuid4()
            span_id = uuid4()
            second_span_id = uuid4()
            with Session(engine) as session:
                _insert_message_context_parent_rows(
                    session,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                )
                session.execute(
                    text("""
                        INSERT INTO message_context_items (
                            message_id,
                            user_id,
                            context_kind,
                            object_type,
                            object_id,
                            ordinal,
                            context_snapshot
                        )
                        VALUES (
                            :message_id,
                            :user_id,
                            'object_ref',
                            'content_chunk',
                            :chunk_id,
                            0,
                            CAST(:context_snapshot AS jsonb)
                        )
                    """),
                    {
                        "message_id": message_id,
                        "user_id": user_id,
                        "chunk_id": chunk_id,
                        "context_snapshot": json.dumps(
                            {
                                "objectType": "content_chunk",
                                "objectId": str(chunk_id),
                                "label": "Legacy title",
                                "snippet": "Legacy preview",
                                "mediaId": str(media_id),
                                "mediaTitle": "Legacy Source",
                                "mediaKind": "web_article",
                                "evidenceSpanIds": [
                                    str(span_id),
                                    str(second_span_id),
                                    str(span_id),
                                ],
                            }
                        ),
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0108")
            assert result.returncode == 0, f"upgrade to 0108 failed: {result.stderr}"

            with Session(engine) as session:
                snapshot = session.execute(
                    text("""
                        SELECT context_snapshot
                        FROM message_context_items
                        WHERE message_id = :message_id
                    """),
                    {"message_id": message_id},
                ).scalar_one()

            assert snapshot == {
                "kind": "object_ref",
                "type": "content_chunk",
                "id": str(chunk_id),
                "title": "Legacy title",
                "preview": "Legacy preview",
                "media_id": str(media_id),
                "media_title": "Legacy Source",
                "media_kind": "web_article",
                "evidence_span_ids": [str(span_id), str(second_span_id)],
            }

            with Session(engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text("""
                            INSERT INTO message_context_items (
                                message_id,
                                user_id,
                                context_kind,
                                object_type,
                                object_id,
                                ordinal,
                                context_snapshot
                            )
                            VALUES (
                                :message_id,
                                :user_id,
                                'object_ref',
                                'content_chunk',
                                :chunk_id,
                                1,
                                CAST(:context_snapshot AS jsonb)
                            )
                        """),
                        {
                            "message_id": message_id,
                            "user_id": user_id,
                            "chunk_id": chunk_id,
                            "context_snapshot": json.dumps(
                                {
                                    "kind": "object_ref",
                                    "type": "content_chunk",
                                    "id": str(chunk_id),
                                }
                            ),
                        },
                    )
                    session.commit()

                assert "ck_message_context_items_object_ref_snapshot" in str(exc_info.value)
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0127_rewrites_plate_event_payloads(self):
        """Plate SSE events gain the owned ``url`` route; non-plate and
        null-image events are left untouched (oracle-plate-owned-asset-cutover)."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0126")
            assert result.returncode == 0, f"upgrade to 0126 failed: {result.stderr}"

            user_id = uuid4()
            corpus_set_version_id = uuid4()
            image_id = uuid4()
            reading_id = uuid4()
            null_image_reading_id = uuid4()
            plate_event_id = uuid4()
            argument_event_id = uuid4()
            null_image_plate_event_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_corpus_set_versions (
                            id, version, label, embedding_model
                        )
                        VALUES (:id, :version, 'Migration Test Corpus', 'test_hash_v2_256')
                        """
                    ),
                    {
                        "id": corpus_set_version_id,
                        "version": f"migration-test-{corpus_set_version_id}",
                    },
                )
                # 0126-era oracle_corpus_images row: only the columns that exist at
                # 0126 (the four owned-asset columns are added by 0127).
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_corpus_images (
                            id,
                            corpus_set_version_id,
                            source_repository,
                            source_url,
                            artist,
                            work_title,
                            attribution_text,
                            width,
                            height
                        )
                        VALUES (
                            :id,
                            :corpus_set_version_id,
                            'wikimedia',
                            'https://example.test/plate.jpg',
                            'Anon',
                            'Plate',
                            'Attribution',
                            1,
                            1
                        )
                        """
                    ),
                    {"id": image_id, "corpus_set_version_id": corpus_set_version_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id,
                            user_id,
                            corpus_set_version_id,
                            folio_number,
                            question_text,
                            prompt_version,
                            image_id
                        )
                        VALUES (
                            :id,
                            :user_id,
                            :corpus_set_version_id,
                            1,
                            'what now?',
                            'v1',
                            :image_id
                        )
                        """
                    ),
                    {
                        "id": reading_id,
                        "user_id": user_id,
                        "corpus_set_version_id": corpus_set_version_id,
                        "image_id": image_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id,
                            user_id,
                            corpus_set_version_id,
                            folio_number,
                            question_text,
                            prompt_version,
                            image_id
                        )
                        VALUES (
                            :id,
                            :user_id,
                            :corpus_set_version_id,
                            2,
                            'and then?',
                            'v1',
                            NULL
                        )
                        """
                    ),
                    {
                        "id": null_image_reading_id,
                        "user_id": user_id,
                        "corpus_set_version_id": corpus_set_version_id,
                    },
                )
                # A plate event whose reading has an image_id (should be rewritten).
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_reading_events (
                            id, reading_id, seq, event_type, payload
                        )
                        VALUES (:id, :reading_id, 1, 'plate', CAST(:payload AS jsonb))
                        """
                    ),
                    {
                        "id": plate_event_id,
                        "reading_id": reading_id,
                        "payload": json.dumps(
                            {
                                "source_url": "/api/media/image?url=x",
                                "attribution_text": "t",
                                "width": 1,
                                "height": 1,
                            }
                        ),
                    },
                )
                # A non-plate event on the same reading (should be untouched).
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_reading_events (
                            id, reading_id, seq, event_type, payload
                        )
                        VALUES (:id, :reading_id, 2, 'argument', CAST(:payload AS jsonb))
                        """
                    ),
                    {
                        "id": argument_event_id,
                        "reading_id": reading_id,
                        "payload": json.dumps({"text": "keep me"}),
                    },
                )
                # A plate event whose reading has no image_id (should be untouched).
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_reading_events (
                            id, reading_id, seq, event_type, payload
                        )
                        VALUES (:id, :reading_id, 1, 'plate', CAST(:payload AS jsonb))
                        """
                    ),
                    {
                        "id": null_image_plate_event_id,
                        "reading_id": null_image_reading_id,
                        "payload": json.dumps(
                            {
                                "source_url": "/api/media/image?url=y",
                                "attribution_text": "t",
                                "width": 1,
                                "height": 1,
                            }
                        ),
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0127")
            assert result.returncode == 0, f"upgrade to 0127 failed: {result.stderr}"

            with Session(engine) as session:
                plate_payload = session.execute(
                    text("SELECT payload FROM oracle_reading_events WHERE id = :id"),
                    {"id": plate_event_id},
                ).scalar_one()
                argument_payload = session.execute(
                    text("SELECT payload FROM oracle_reading_events WHERE id = :id"),
                    {"id": argument_event_id},
                ).scalar_one()
                null_image_payload = session.execute(
                    text("SELECT payload FROM oracle_reading_events WHERE id = :id"),
                    {"id": null_image_plate_event_id},
                ).scalar_one()

            # Plate event on a reading with an image_id gains the owned url route
            # and loses the legacy source_url.
            assert plate_payload["url"] == f"/api/oracle/plates/{image_id}"
            assert "source_url" not in plate_payload
            assert plate_payload["attribution_text"] == "t"

            # Non-plate events are untouched.
            assert argument_payload == {"text": "keep me"}

            # Plate events whose reading has no image_id are left as-is.
            assert null_image_payload["source_url"] == "/api/media/image?url=y"
            assert "url" not in null_image_payload
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0127_backfills_owned_asset_columns(self):
        """The 0072 seed plates are backfilled to the bundled owned-asset fixture
        and the current owned-asset columns remain NOT NULL at head."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                rows = (
                    session.execute(
                        text(
                            """
                            SELECT storage_key, content_type, byte_size
                            FROM oracle_plates
                            """
                        )
                    )
                    .mappings()
                    .all()
                )
                columns = {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT column_name
                            FROM information_schema.columns
                            WHERE table_name = 'oracle_plates'
                            """
                        )
                    )
                }

            assert rows, "expected at least one seeded oracle_plates row"
            assert "sha256" not in columns
            assert "corpus_set_version_id" not in columns
            for row in rows:
                assert row["storage_key"].startswith("oracle/plates/")
                assert row["storage_key"].endswith(".jpg")
                assert row["content_type"] == "image/jpeg"
                assert row["byte_size"] == 9382
                assert row["storage_key"] is not None
                assert row["content_type"] is not None
                assert row["byte_size"] is not None
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0127_owned_asset_schema_contract_is_enforced(self):
        """The current owned-asset columns are not merely backfilled.

        The head schema enforces the surviving route/storage invariants after
        the current-only cutover drops corpus-version and SHA identity.
        """
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            # Known-good column template (everything but ``id``/``created_at``/``tags``,
            # which carry server defaults). Each case overrides exactly one binding.
            def good_params() -> dict:
                slug = f"contract-test-{str(uuid4())[:8]}"
                return {
                    "id": uuid4(),
                    "source_repository": "wikimedia",
                    "source_url": f"https://example.test/{uuid4()}.jpg",
                    "artist": "Anon",
                    "work_title": "Plate",
                    "attribution_text": "Attribution",
                    "width": 1,
                    "height": 1,
                    "storage_key": f"oracle/plates/{slug}.jpg",
                    "content_type": "image/jpeg",
                    "byte_size": 1,
                }

            insert_sql = text(
                """
                INSERT INTO oracle_plates (
                    id,
                    source_repository,
                    source_url,
                    artist,
                    work_title,
                    attribution_text,
                    width,
                    height,
                    storage_key,
                    content_type,
                    byte_size
                )
                VALUES (
                    :id,
                    :source_repository,
                    :source_url,
                    :artist,
                    :work_title,
                    :attribution_text,
                    :width,
                    :height,
                    :storage_key,
                    :content_type,
                    :byte_size
                )
                """
            )

            # Sanity check: the known-good template inserts cleanly, so each
            # failure below is attributable to the single mutated field.
            with Session(engine) as session:
                session.execute(insert_sql, good_params())
                session.commit()

            negative_cases: list[tuple[dict, tuple[str, ...]]] = [
                # 1) storage_key NULL -> NOT NULL violation.
                ({"storage_key": None}, ("storage_key",)),
                # 2) byte_size = 0 -> ck_oracle_plates_byte_size_positive.
                ({"byte_size": 0}, ("ck_oracle_plates_byte_size_positive",)),
                # 3) disallowed content_type -> ck_oracle_plates_content_type.
                ({"content_type": "image/svg+xml"}, ("ck_oracle_plates_content_type",)),
                # 4) storage_key must be oracle/plates/<stable-key>.<ext>.
                ({"storage_key": "oracle/plates/.jpg"}, ("storage_key_shape",)),
                ({"storage_key": "media/x.jpg"}, ("storage_key_shape",)),
                # 5) storage_key extension must match content_type.
                ({"content_type": "image/png"}, ("storage_key_content_type_match",)),
            ]

            for override, expected_constraints in negative_cases:
                params = good_params()
                params.update(override)
                with Session(engine) as session:
                    with pytest.raises(IntegrityError) as exc_info:
                        session.execute(insert_sql, params)
                        session.commit()
                    session.rollback()
                error_text = str(exc_info.value)
                assert any(name in error_text for name in expected_constraints), (
                    f"expected one of {expected_constraints!r} for override {override!r}, "
                    f"got: {error_text}"
                )
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0084_rewrites_tool_result_events_without_dropping_replay_data(self):
        """Chat event cutover preserves replay payloads while renaming tool_result."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0083")
            assert result.returncode == 0, f"upgrade to 0083 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            model_id = uuid4()
            run_id = uuid4()
            event_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO models (
                            id, provider, model_name, max_context_tokens, is_available
                        )
                        VALUES (:id, 'openai', :model_name, 4096, true)
                        """
                    ),
                    {"id": model_id, "model_name": f"migration-test-{model_id}"},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :owner_user_id, 'private', 3)
                        """
                    ),
                    {"id": conversation_id, "owner_user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conversation_id, 1, 'user', 'find sources', 'complete')
                        """
                    ),
                    {"id": user_message_id, "conversation_id": conversation_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status, parent_message_id
                        )
                        VALUES (
                            :id, :conversation_id, 2, 'assistant', '', 'pending',
                            :parent_message_id
                        )
                        """
                    ),
                    {
                        "id": assistant_message_id,
                        "conversation_id": conversation_id,
                        "parent_message_id": user_message_id,
                    },
                )
                # At revision 0083 the chat_runs.web_search NOT NULL column
                # still exists (it is dropped only in 0115). This test runs at
                # 0083, so we must keep providing it here.
                session.execute(
                    text(
                        """
                        INSERT INTO chat_runs (
                            id,
                            owner_user_id,
                            conversation_id,
                            user_message_id,
                            assistant_message_id,
                            idempotency_key,
                            payload_hash,
                            status,
                            model_id,
                            reasoning,
                            key_mode,
                            web_search,
                            next_event_seq
                        )
                        VALUES (
                            :id,
                            :owner_user_id,
                            :conversation_id,
                            :user_message_id,
                            :assistant_message_id,
                            :idempotency_key,
                            'hash',
                            'running',
                            :model_id,
                            'none',
                            'auto',
                            '{"mode": "off"}'::jsonb,
                            2
                        )
                        """
                    ),
                    {
                        "id": run_id,
                        "owner_user_id": user_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                        "idempotency_key": f"migration-{run_id}",
                        "model_id": model_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                        VALUES (
                            :id,
                            :run_id,
                            1,
                            'tool_result',
                            jsonb_build_object(
                                'tool_name', 'app_search',
                                'result_count', 2,
                                'citations', jsonb_build_array(
                                    jsonb_build_object('result_type', 'media', 'source_id', 'm1')
                                )
                            )
                        )
                        """
                    ),
                    {"id": event_id, "run_id": run_id},
                )
                session.commit()

            # Pause at 0119, where the retired verifier taxonomy
            # (claim / claim_evidence) is still a valid event_type, and seed two
            # such rows. Migration 0142 tightens the CHECK; it must delete these
            # first or the ADD CONSTRAINT fails on real data — the clean-DB-only
            # gap that shipped this as a production incident.
            result = run_alembic_command("upgrade 0119")
            assert result.returncode == 0, f"upgrade to 0119 failed: {result.stderr}"
            with Session(engine) as session:
                session.execute(
                    text(
                        """
                        INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                        VALUES
                            (:run_id, 90, 'claim', '{}'::jsonb),
                            (:run_id, 91, 'claim_evidence', '{}'::jsonb)
                        """
                    ),
                    {"run_id": run_id},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                retired_count = session.execute(
                    text(
                        """
                        SELECT count(*) FROM chat_run_events
                        WHERE event_type IN ('claim', 'claim_evidence')
                        """
                    )
                ).scalar_one()
                assert retired_count == 0, (
                    "migration 0142 must delete retired claim/claim_evidence event rows "
                    "before tightening ck_chat_run_events_event_type"
                )

                row = session.execute(
                    text(
                        """
                        SELECT event_type, payload
                        FROM chat_run_events
                        WHERE id = :id
                        """
                    ),
                    {"id": event_id},
                ).one_or_none()
                assert row is None, "0167 hard cutover deletes old retrieval_result event rows"

                message_document = session.execute(
                    text(
                        """
                        SELECT message_document
                        FROM messages
                        WHERE id = :id
                        """
                    ),
                    {"id": user_message_id},
                ).scalar_one()
                assert message_document["type"] == "message_document"
                assert message_document["blocks"][0]["text"] == "find sources"

                # context_ref_added remains a valid event_type at head; the dead
                # verifier values claim/claim_evidence were dropped from the CHECK
                # by migration 0142.
                session.execute(
                    text(
                        """
                        INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                        VALUES (
                            :run_id, 2, 'context_ref_added',
                            jsonb_build_object('tool_name', 'app_search')
                        )
                        """
                    ),
                    {"run_id": run_id},
                )
                session.commit()

                # claim / claim_evidence / citation are all rejected at head
                # (claim + claim_evidence dropped in 0142; citation in 0100).
                for seq, rejected in enumerate(("citation", "claim", "claim_evidence"), start=5):
                    with pytest.raises(IntegrityError) as exc_info:
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                                VALUES (:run_id, :seq, :event_type, '{}'::jsonb)
                                """
                            ),
                            {"run_id": run_id, "seq": seq, "event_type": rejected},
                        )
                        session.commit()
                    session.rollback()
                    assert "ck_chat_run_events_event_type" in str(exc_info.value)

                session.execute(
                    text(
                        """
                        INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                        VALUES (
                            :run_id, 8, 'tool_result',
                            jsonb_build_object(
                                'tool_call_id', null,
                                'assistant_message_id', CAST(:assistant_message_id AS text),
                                'tool_name', 'app_search',
                                'tool_call_index', 1,
                                'status', 'complete',
                                'scope', 'all',
                                'types', jsonb_build_array(),
                                'filters', '{}'::jsonb,
                                'results', jsonb_build_array()
                            )
                        )
                        """
                    ),
                    {"run_id": run_id, "assistant_message_id": str(assistant_message_id)},
                )
                session.commit()
        finally:
            reset_test_schema()

            engine.dispose()

    def test_0070_rejects_annotations_without_valid_owned_highlights(self):
        """Annotation cutover must not drop notes that cannot attach to a valid highlight."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0069")
            assert result.returncode == 0, f"upgrade to 0069 failed: {result.stderr}"

            user_id = uuid4()
            highlight_id = uuid4()
            annotation_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO highlights (
                            id,
                            user_id,
                            anchor_kind,
                            anchor_media_id,
                            color,
                            exact,
                            prefix,
                            suffix
                        )
                        VALUES (
                            :id,
                            :user_id,
                            NULL,
                            NULL,
                            'yellow',
                            'orphaned annotation',
                            '',
                            ''
                        )
                        """
                    ),
                    {"id": highlight_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO annotations (id, highlight_id, body)
                        VALUES (:id, :highlight_id, 'Must not be dropped')
                        """
                    ),
                    {"id": annotation_id, "highlight_id": highlight_id},
                )
                session.commit()

            result = run_alembic_command("upgrade 0070")
            assert result.returncode != 0
            assert "highlights are not valid owned anchors" in result.stderr
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0070_backfills_object_links_for_migrated_message_context_items(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0069")
            assert result.returncode == 0, f"upgrade to 0069 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            message_id = uuid4()
            media_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, title, next_seq)
                        VALUES (:id, :owner_user_id, 'Legacy context', 2)
                        """
                    ),
                    {"id": conversation_id, "owner_user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conversation_id, 1, 'user', 'legacy context', 'complete')
                        """
                    ),
                    {"id": message_id, "conversation_id": conversation_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', 'Legacy media', 'ready_for_reading', :user_id)
                        """
                    ),
                    {"id": media_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_contexts (
                            id, message_id, target_type, ordinal, media_id
                        )
                        VALUES (:id, :message_id, 'media', 2, :media_id)
                        """
                    ),
                    {"id": uuid4(), "message_id": message_id, "media_id": media_id},
                )
                session.commit()

            result = run_alembic_command("upgrade 0070")
            assert result.returncode == 0, f"upgrade to 0070 failed: {result.stderr}"

            with Session(engine) as session:
                row = (
                    session.execute(
                        text(
                            """
                        SELECT
                            mci.user_id,
                            mci.object_type,
                            mci.object_id,
                            mci.ordinal,
                            ol.relation_type,
                            ol.a_type,
                            ol.a_id,
                            ol.b_type,
                            ol.b_id,
                            ol.a_order_key
                        FROM message_context_items mci
                        JOIN object_links ol
                          ON ol.user_id = mci.user_id
                         AND ol.relation_type = 'used_as_context'
                         AND ol.a_type = 'message'
                         AND ol.a_id = mci.message_id
                         AND ol.b_type = mci.object_type
                         AND ol.b_id = mci.object_id
                        WHERE mci.message_id = :message_id
                        """
                        ),
                        {"message_id": message_id},
                    )
                    .mappings()
                    .one()
                )

                assert row["user_id"] == user_id
                assert row["object_type"] == "media"
                assert row["object_id"] == media_id
                assert row["ordinal"] == 2
                assert row["relation_type"] == "used_as_context"
                assert row["a_type"] == "message"
                assert row["a_id"] == message_id
                assert row["b_type"] == "media"
                assert row["b_id"] == media_id
                assert row["a_order_key"] == "0000000003"
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0070_migrates_page_body_markdown_into_ordered_note_blocks(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0069")
            assert result.returncode == 0, f"upgrade to 0069 failed: {result.stderr}"

            user_id = uuid4()
            page_id = uuid4()
            raw_ref_id = uuid4()
            legacy_body = (
                "# Overview\n\n"
                f"Intro [docs](https://example.com) and [[page:{raw_ref_id}|Raw]]\n\n"
                "- First\n"
                "  - Nested\n"
                "1. Ordered\n\n"
                "```\n"
                "print('hi')\n"
                "```"
            )
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO pages (id, user_id, title, body)
                        VALUES (:id, :user_id, 'Legacy Markdown', :body)
                        """
                    ),
                    {"id": page_id, "user_id": user_id, "body": legacy_body},
                )
                session.commit()

            result = run_alembic_command("upgrade 0070")
            assert result.returncode == 0, f"upgrade to 0070 failed: {result.stderr}"

            with Session(engine) as session:
                rows = (
                    session.execute(
                        text(
                            """
                            SELECT
                                id,
                                parent_block_id,
                                order_key,
                                block_kind,
                                body_markdown,
                                body_text,
                                body_pm_json
                            FROM note_blocks
                            WHERE page_id = :page_id
                            """
                        ),
                        {"page_id": page_id},
                    )
                    .mappings()
                    .all()
                )

            by_text = {row["body_text"]: row for row in rows}
            intro_text = f"Intro docs and [[page:{raw_ref_id}|Raw]]"

            assert set(by_text) == {
                "Overview",
                intro_text,
                "First",
                "Nested",
                "Ordered",
                "print('hi')",
            }, f"Unexpected migrated note blocks: {rows}"
            assert by_text["Overview"]["parent_block_id"] is None
            assert by_text["Overview"]["block_kind"] == "heading"
            assert by_text[intro_text]["parent_block_id"] == by_text["Overview"]["id"]
            assert by_text["First"]["parent_block_id"] == by_text["Overview"]["id"]
            assert by_text["Ordered"]["parent_block_id"] == by_text["Overview"]["id"]
            assert by_text["Nested"]["parent_block_id"] == by_text["First"]["id"]
            assert by_text[intro_text]["order_key"] == "0000000001"
            assert by_text["First"]["order_key"] == "0000000002"
            assert by_text["Ordered"]["order_key"] == "0000000003"
            assert by_text["print('hi')"]["block_kind"] == "code"
            assert by_text[intro_text]["body_markdown"] == (
                f"Intro [docs](https://example.com) and [[page:{raw_ref_id}|Raw]]"
            )
            assert by_text[intro_text]["body_pm_json"]["content"][1] == {
                "type": "text",
                "text": "docs",
                "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
            }
            assert by_text[intro_text]["body_pm_json"]["content"][2]["text"] == (
                f" and [[page:{raw_ref_id}|Raw]]"
            )
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0073_evidence_span_offset_constraint_upgrade_and_downgrade(self):
        """0073 loosens cross-block offsets and downgrade restores the prior check."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0072")
            assert result.returncode == 0, f"upgrade to 0072 failed: {result.stderr}"

            with Session(engine) as session:
                fixture = insert_evidence_span_offset_fixture(session)
                with pytest.raises(IntegrityError) as exc_info:
                    insert_cross_block_backwards_evidence_span(session, fixture)
                    session.commit()
                session.rollback()
                assert "ck_evidence_spans_offsets" in str(exc_info.value)

            result = run_alembic_command("upgrade 0073")
            assert result.returncode == 0, f"upgrade to 0073 failed: {result.stderr}"

            with Session(engine) as session:
                evidence_span_id = insert_cross_block_backwards_evidence_span(
                    session,
                    fixture,
                )
                session.commit()
                session.execute(
                    text("DELETE FROM evidence_spans WHERE id = :id"),
                    {"id": evidence_span_id},
                )
                session.commit()

            result = run_alembic_command("downgrade 0072")
            assert result.returncode == 0, f"downgrade to 0072 failed: {result.stderr}"

            with Session(engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    insert_cross_block_backwards_evidence_span(session, fixture)
                    session.commit()
                session.rollback()
                assert "ck_evidence_spans_offsets" in str(exc_info.value)
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0069_marks_ready_text_media_for_content_index_repair(self):
        """Readable legacy media must be queued for shared evidence-index repair."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0068")
            assert result.returncode == 0, f"upgrade to 0068 failed: {result.stderr}"

            user_id = uuid4()
            web_id = uuid4()
            epub_id = uuid4()
            pdf_id = uuid4()
            pending_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                for media_id, kind, title, status in (
                    (web_id, "web_article", "Legacy Web", "ready_for_reading"),
                    (epub_id, "epub", "Legacy EPUB", "ready"),
                    (pdf_id, "pdf", "Legacy PDF", "ready_for_reading"),
                    (pending_id, "web_article", "Pending Web", "pending"),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                            VALUES (:id, :kind, :title, :status, :user_id)
                            """
                        ),
                        {
                            "id": media_id,
                            "kind": kind,
                            "title": title,
                            "status": status,
                            "user_id": user_id,
                        },
                    )

                for fragment_id, media_id, text_value in (
                    (uuid4(), web_id, "legacy web body"),
                    (uuid4(), epub_id, "legacy epub body"),
                    (uuid4(), pending_id, "pending body"),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                            VALUES (:id, :media_id, 0, :html, :text)
                            """
                        ),
                        {
                            "id": fragment_id,
                            "media_id": media_id,
                            "html": f"<p>{text_value}</p>",
                            "text": text_value,
                        },
                    )

                session.execute(
                    text(
                        """
                        INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                        VALUES (:media_id, 'media/legacy/original.pdf', 'application/pdf', 1024)
                        """
                    ),
                    {"media_id": pdf_id},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                rows = session.execute(
                    text(
                        """
                        SELECT id, owner_id AS media_id, status, status_reason
                        FROM content_index_states
                        WHERE owner_kind = 'media' AND owner_id = ANY(:media_ids)
                        ORDER BY owner_id
                        """
                    ),
                    {"media_ids": [web_id, epub_id, pdf_id, pending_id]},
                ).fetchall()

            assert all(row[0] is not None for row in rows)
            indexed_by_media = {row[1]: (row[2], row[3]) for row in rows}
            assert indexed_by_media[web_id] == ("pending", "current_only_artifacts_cutover")
            assert indexed_by_media[epub_id] == ("pending", "current_only_artifacts_cutover")
            assert indexed_by_media[pdf_id] == ("pending", "current_only_artifacts_cutover")
            assert pending_id not in indexed_by_media
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0075_repairs_media_content_index_state_id_for_existing_head_databases(self):
        """Forward migration repairs DBs that reached head before 0069 gained id."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0074")
            assert result.returncode == 0, f"upgrade to 0074 failed: {result.stderr}"

            with Session(engine) as session:
                session.execute(
                    text(
                        """
                        DO $$
                        DECLARE
                            primary_key_name text;
                        BEGIN
                            SELECT conname
                            INTO primary_key_name
                            FROM pg_constraint
                            WHERE conrelid = 'media_content_index_states'::regclass
                              AND contype = 'p';

                            IF primary_key_name IS NOT NULL THEN
                                EXECUTE format(
                                    'ALTER TABLE media_content_index_states DROP CONSTRAINT %I',
                                    primary_key_name
                                );
                            END IF;

                            ALTER TABLE media_content_index_states DROP COLUMN id;
                            ALTER TABLE media_content_index_states
                            ADD PRIMARY KEY (media_id);
                        END $$;
                        """
                    )
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                id_column = session.execute(
                    text(
                        """
                        SELECT is_nullable, column_default
                        FROM information_schema.columns
                        WHERE table_name = 'content_index_states'
                          AND column_name = 'id'
                        """
                    )
                ).fetchone()
                primary_key_columns = session.execute(
                    text(
                        """
                        SELECT array_agg(a.attname ORDER BY key.ordinality)
                        FROM pg_constraint c
                        JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
                          ON true
                        JOIN pg_attribute a
                          ON a.attrelid = c.conrelid
                         AND a.attnum = key.attnum
                        WHERE c.conrelid = 'content_index_states'::regclass
                          AND c.contype = 'p'
                        """
                    )
                ).scalar_one()
                owner_unique = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM pg_constraint
                        WHERE conrelid = 'content_index_states'::regclass
                          AND conname = 'uq_content_index_states_owner'
                          AND contype = 'u'
                        """
                    )
                ).scalar()

            assert id_column is not None
            assert id_column[0] == "NO"
            assert "gen_random_uuid" in id_column[1]
            assert primary_key_columns == ["id"]
            assert owner_unique == 1
        finally:
            reset_test_schema()
            engine.dispose()

    def test_legacy_annotation_retrievals_do_not_block_result_type_cutover(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0068")
            assert result.returncode == 0, f"upgrade to 0068 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            tool_call_id = uuid4()

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, title, next_seq)
                        VALUES (:id, :owner_user_id, 'Migration Result Types', 3)
                        """
                    ),
                    {"id": conversation_id, "owner_user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conversation_id, 1, 'user', 'find my annotation', 'complete')
                        """
                    ),
                    {"id": user_message_id, "conversation_id": conversation_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conversation_id, 2, 'assistant', '', 'pending')
                        """
                    ),
                    {"id": assistant_message_id, "conversation_id": conversation_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_tool_calls (
                            id,
                            conversation_id,
                            user_message_id,
                            assistant_message_id,
                            tool_name,
                            tool_call_index,
                            scope,
                            status
                        )
                        VALUES (
                            :id,
                            :conversation_id,
                            :user_message_id,
                            :assistant_message_id,
                            'app_search',
                            0,
                            'all',
                            'complete'
                        )
                        """
                    ),
                    {
                        "id": tool_call_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_retrievals (
                            tool_call_id,
                            ordinal,
                            result_type,
                            source_id,
                            context_ref,
                            result_ref
                        )
                        VALUES (
                            :tool_call_id,
                            0,
                            'annotation',
                            :source_id,
                            jsonb_build_object('type', 'annotation', 'id', CAST(:source_id AS text)),
                            jsonb_build_object('type', 'annotation', 'id', CAST(:source_id AS text))
                        )
                        """
                    ),
                    {"tool_call_id": tool_call_id, "source_id": str(uuid4())},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                stale_count = session.execute(
                    text("SELECT COUNT(*) FROM message_retrievals WHERE result_type = 'annotation'")
                ).scalar_one()
                assert stale_count == 0

                contributor_source_id = "contributor:test-author"
                session.execute(
                    text(
                        """
                        INSERT INTO message_retrievals (
                            tool_call_id,
                            ordinal,
                            result_type,
                            source_id,
                            context_ref,
                            result_ref
                        )
                        VALUES (
                            :tool_call_id,
                            1,
                            'contributor',
                            :source_id,
                            jsonb_build_object('type', 'contributor', 'id', CAST(:source_id AS text)),
                            jsonb_build_object('type', 'contributor', 'id', CAST(:source_id AS text))
                        )
                        """
                    ),
                    {"tool_call_id": tool_call_id, "source_id": contributor_source_id},
                )
                for result_type in ("episode", "video"):
                    source_id = str(uuid4())
                    session.execute(
                        text(
                            """
                            INSERT INTO message_retrievals (
                                tool_call_id,
                                ordinal,
                                result_type,
                                source_id,
                                context_ref,
                                result_ref
                            )
                            VALUES (
                                :tool_call_id,
                                :ordinal,
                                :result_type,
                                :source_id,
                                jsonb_build_object(
                                    'type',
                                    CAST(:result_type AS text),
                                    'id',
                                    CAST(:source_id AS text)
                                ),
                                jsonb_build_object(
                                    'type',
                                    CAST(:result_type AS text),
                                    'id',
                                    CAST(:source_id AS text)
                                )
                            )
                            """
                        ),
                        {
                            "tool_call_id": tool_call_id,
                            "ordinal": 2 if result_type == "episode" else 3,
                            "result_type": result_type,
                            "source_id": source_id,
                        },
                    )
                session.commit()

                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text(
                            """
                            INSERT INTO message_retrievals (
                                tool_call_id,
                                ordinal,
                                result_type,
                                source_id,
                                context_ref,
                                result_ref
                            )
                            VALUES (
                                :tool_call_id,
                                4,
                                'annotation',
                                :source_id,
                                jsonb_build_object('type', 'annotation', 'id', CAST(:source_id AS text)),
                                jsonb_build_object('type', 'annotation', 'id', CAST(:source_id AS text))
                            )
                            """
                        ),
                        {"tool_call_id": tool_call_id, "source_id": str(uuid4())},
                    )
                    session.commit()
                session.rollback()
                assert "ck_message_retrievals_result_type" in str(exc_info.value)
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0138_current_only_artifacts_strips_identity_and_drops_columns(self):
        """0138 is a hard cutover from versioned/hash artifact identity to current rows."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        legacy_keys = {
            "base_page_revision",
            "base_revision",
            "block_hashes",
            "contentHash",
            "contentSha256",
            "content_hash",
            "content_sha256",
            "fileSha256",
            "file_sha256",
            "fingerprint",
            "geometry_fingerprint",
            "geometry_version",
            "hash",
            "manifestSha256",
            "manifest_sha256",
            "provider_request_hash",
            "revision",
            "sha256",
            "sourceFingerprint",
            "sourceVersion",
            "source_fingerprint",
            "source_sha256",
            "source_version",
            "stable_hash",
            "stable_prefix_hash",
            "transcriptVersionId",
            "transcript_version_id",
            "version",
        }

        def assert_no_legacy_identity(value):
            if isinstance(value, dict):
                assert legacy_keys.isdisjoint(value.keys())
                for child in value.values():
                    assert_no_legacy_identity(child)
            elif isinstance(value, list):
                for child in value:
                    assert_no_legacy_identity(child)

        try:
            result = run_alembic_command("upgrade 0136")
            assert result.returncode == 0, f"upgrade to 0136 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            tool_call_id = uuid4()
            retrieval_id = uuid4()
            candidate_id = uuid4()
            pdf_media_id = uuid4()
            epub_media_id = uuid4()
            podcast_id = uuid4()
            podcast_media_id = uuid4()
            legacy_opml_provider_id = "opml-" + ("a" * 40)
            legacy_feed_episode_id = "feed-" + ("b" * 40)
            page_id = uuid4()
            note_block_id = uuid4()
            search_document_id = uuid4()

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :user_id, 'private', 3)
                    """),
                    {"id": conversation_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status, message_document
                        )
                        VALUES (
                            :id, :conversation_id, 1, 'user', 'legacy user', 'complete',
                            CAST(:message_document AS jsonb)
                        )
                    """),
                    {
                        "id": user_message_id,
                        "conversation_id": conversation_id,
                        "message_document": json.dumps(
                            {
                                "type": "message_document",
                                "blocks": [
                                    {
                                        "type": "text",
                                        "sourceVersion": "fragment:v1",
                                        "stable_hash": "old-block-hash",
                                        "attrs": {
                                            "sha256": "a" * 64,
                                            "source_fingerprint": "sha256:old",
                                            "block_hashes": ["old-block-hash"],
                                        },
                                    }
                                ],
                                "stable_prefix_hash": "old-prefix",
                            }
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status,
                            parent_message_id, message_document
                        )
                        VALUES (
                            :id, :conversation_id, 2, 'assistant', 'legacy assistant', 'complete',
                            :parent_message_id, CAST(:message_document AS jsonb)
                        )
                    """),
                    {
                        "id": assistant_message_id,
                        "conversation_id": conversation_id,
                        "parent_message_id": user_message_id,
                        "message_document": json.dumps(
                            {
                                "type": "message_document",
                                "version": 1,
                                "blocks": [
                                    {
                                        "type": "citation",
                                        "result_ref": {
                                            "type": "media",
                                            "id": str(pdf_media_id),
                                            "source_version": "media:v1",
                                            "file_sha256": "b" * 64,
                                            "provider_request_hash": "old-provider-request",
                                        },
                                    }
                                ],
                            }
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id, file_sha256
                        )
                        VALUES (
                            :id, 'pdf', 'Legacy PDF', 'pending', :user_id, :file_sha256
                        )
                    """),
                    {"id": pdf_media_id, "user_id": user_id, "file_sha256": "c" * 64},
                )
                session.execute(
                    text("""
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id, file_sha256
                        )
                        VALUES (
                            :id, 'epub', 'Legacy EPUB', 'pending', :user_id, :file_sha256
                        )
                    """),
                    {"id": epub_media_id, "user_id": user_id, "file_sha256": "d" * 64},
                )
                session.execute(
                    text("""
                        INSERT INTO podcasts (
                            id, provider, provider_podcast_id, title, feed_url
                        )
                        VALUES (
                            :id, 'podcast_index', :provider_podcast_id,
                            'Legacy Podcast', 'https://example.test/feed.xml'
                        )
                    """),
                    {"id": podcast_id, "provider_podcast_id": legacy_opml_provider_id},
                )
                session.execute(
                    text("""
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id,
                            canonical_source_url, external_playback_url, provider,
                            provider_id, published_date
                        )
                        VALUES (
                            :id, 'podcast_episode', 'Legacy Episode', 'ready_for_reading',
                            :user_id, 'https://example.test/feed.xml',
                            'https://cdn.example.test/audio.mp3', 'podcast_index',
                            'legacy-episode', '2026-01-02T03:04:05Z'
                        )
                    """),
                    {"id": podcast_media_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcast_episodes (
                            media_id, podcast_id, provider_episode_id, fallback_identity
                        )
                        VALUES (
                            :media_id, :podcast_id, :provider_episode_id, :fallback_identity
                        )
                    """),
                    {
                        "media_id": podcast_media_id,
                        "podcast_id": podcast_id,
                        "provider_episode_id": legacy_feed_episode_id,
                        "fallback_identity": "f" * 64,
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO epub_resources (
                            id, media_id, package_href, asset_key, storage_path,
                            content_type, size_bytes, sha256
                        )
                        VALUES (
                            :id, :media_id, 'images/cover.png', 'images/cover.png',
                            'epub-assets/current/cover.png', 'image/png', 12, :sha256
                        )
                    """),
                    {"id": uuid4(), "media_id": epub_media_id, "sha256": "e" * 64},
                )
                session.execute(
                    text("""
                        INSERT INTO media_source_attempts (
                            id, media_id, created_by_user_id, source_type, attempt_no,
                            status, intent_key, source_payload
                        )
                        VALUES (
                            :id, :media_id, :user_id, 'uploaded_pdf_file', 1,
                            'succeeded', 'legacy-intent', CAST(:source_payload AS jsonb)
                        )
                    """),
                    {
                        "id": uuid4(),
                        "media_id": pdf_media_id,
                        "user_id": user_id,
                        "source_payload": json.dumps(
                            {
                                "kind": "pdf",
                                "file_sha256": "f" * 64,
                                "nested": {"contentSha256": "0" * 64},
                            }
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO pages (id, user_id, title, revision)
                        VALUES (:id, :user_id, 'Legacy Page', 7)
                    """),
                    {"id": page_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO note_blocks (
                            id, user_id, page_id, order_key, body_pm_json, body_text, revision
                        )
                        VALUES (
                            :id, :user_id, :page_id, 'a0',
                            '{"type":"doc","content":[]}'::jsonb, 'Legacy block', 9
                        )
                    """),
                    {"id": note_block_id, "user_id": user_id, "page_id": page_id},
                )
                session.execute(
                    text("""
                        INSERT INTO message_tool_calls (
                            id, conversation_id, user_message_id, assistant_message_id,
                            tool_name, tool_call_index, status, result_refs,
                            selected_context_refs
                        )
                        VALUES (
                            :id, :conversation_id, :user_message_id, :assistant_message_id,
                            'app_search', 0, 'complete', CAST(:result_refs AS jsonb),
                            CAST(:selected_context_refs AS jsonb)
                        )
                    """),
                    {
                        "id": tool_call_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                        "result_refs": json.dumps(
                            [
                                {
                                    "type": "media",
                                    "id": str(pdf_media_id),
                                    "sourceVersion": "media:v1",
                                    "sha256": "1" * 64,
                                }
                            ]
                        ),
                        "selected_context_refs": json.dumps(
                            [
                                {
                                    "type": "reader_selection",
                                    "locator": {"transcript_version_id": str(uuid4())},
                                    "revision": 3,
                                }
                            ]
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO message_retrievals (
                            id, tool_call_id, ordinal, result_type, source_id,
                            media_id, context_ref, result_ref, locator, source_version
                        )
                        VALUES (
                            :id, :tool_call_id, 0, 'media', :source_id, :media_id,
                            CAST(:context_ref AS jsonb), CAST(:result_ref AS jsonb),
                            CAST(:locator AS jsonb), 'media:v1'
                        )
                    """),
                    {
                        "id": retrieval_id,
                        "tool_call_id": tool_call_id,
                        "source_id": str(pdf_media_id),
                        "media_id": pdf_media_id,
                        "context_ref": json.dumps(
                            {"type": "media", "id": str(pdf_media_id), "source_version": "media:v1"}
                        ),
                        "result_ref": json.dumps(
                            {"type": "media", "id": str(pdf_media_id), "content_hash": "hash"}
                        ),
                        "locator": json.dumps(
                            {
                                "type": "pdf_text_quote",
                                "media_id": str(pdf_media_id),
                                "geometry_fingerprint": "old",
                            }
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO message_retrieval_candidate_ledgers (
                            id, tool_call_id, retrieval_id, ordinal, result_type, source_id,
                            selection_status, selection_reason, result_ref, locator,
                            source_version
                        )
                        VALUES (
                            :id, :tool_call_id, :retrieval_id, 0, 'media', :source_id,
                            'retrieved', 'migration', CAST(:result_ref AS jsonb),
                            CAST(:locator AS jsonb), 'media:v1'
                        )
                    """),
                    {
                        "id": candidate_id,
                        "tool_call_id": tool_call_id,
                        "retrieval_id": retrieval_id,
                        "source_id": str(pdf_media_id),
                        "result_ref": json.dumps(
                            {
                                "type": "media",
                                "id": str(pdf_media_id),
                                "manifest_sha256": "2" * 64,
                            }
                        ),
                        "locator": json.dumps(
                            {"type": "pdf", "media_id": str(pdf_media_id), "fingerprint": "old"}
                        ),
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO object_search_documents (
                            id, user_id, object_type, object_id, title_text, body_text,
                            search_text, route_path, content_hash, index_version,
                            index_status
                        )
                        VALUES (
                            :id, :user_id, 'page', :object_id, 'Legacy Search',
                            'body', 'Legacy Search body', :route_path, 'old-hash',
                            1, 'ready'
                        )
                    """),
                    {
                        "id": search_document_id,
                        "user_id": user_id,
                        "object_id": page_id,
                        "route_path": f"/pages/{page_id}",
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                for table_name, removed_columns in {
                    "media": {"file_sha256"},
                    "epub_resources": {"sha256"},
                    "pages": {"revision"},
                    "note_blocks": {"revision"},
                    "message_retrievals": {"source_version"},
                    "message_retrieval_candidate_ledgers": {"source_version"},
                    "object_search_documents": {"content_hash", "index_version"},
                    "chat_prompt_assemblies": {
                        "stable_prefix_hash",
                        "provider_request_hash",
                    },
                }.items():
                    columns = {
                        row[0]
                        for row in session.execute(
                            text("""
                                SELECT column_name
                                FROM information_schema.columns
                                WHERE table_name = :table_name
                            """),
                            {"table_name": table_name},
                        )
                    }
                    assert removed_columns.isdisjoint(columns)

                indexes = {
                    row[0]
                    for row in session.execute(
                        text("SELECT indexname FROM pg_indexes WHERE tablename = 'media'")
                    )
                }
                assert "uix_media_file_sha256" not in indexes
                assert "idx_media_stale_pending_upload_cleanup" not in indexes

                for value in session.execute(
                    text("SELECT message_document FROM messages ORDER BY seq")
                ).scalars():
                    assert_no_legacy_identity(value)
                for value in session.execute(
                    text("SELECT source_payload FROM media_source_attempts")
                ).scalars():
                    assert_no_legacy_identity(value)
                for row in session.execute(
                    text("""
                        SELECT context_ref, result_ref, locator
                        FROM message_retrievals
                    """)
                ).mappings():
                    assert_no_legacy_identity(row["context_ref"])
                    assert_no_legacy_identity(row["result_ref"])
                    assert_no_legacy_identity(row["locator"])
                for row in session.execute(
                    text("""
                        SELECT result_ref, locator
                        FROM message_retrieval_candidate_ledgers
                    """)
                ).mappings():
                    assert_no_legacy_identity(row["result_ref"])
                    assert_no_legacy_identity(row["locator"])
                for row in session.execute(
                    text("""
                        SELECT result_refs, selected_context_refs
                        FROM message_tool_calls
                    """)
                ).mappings():
                    assert_no_legacy_identity(row["result_refs"])
                    assert_no_legacy_identity(row["selected_context_refs"])

                # 0143 drops the object_search substrate entirely (notes now live in
                # content_chunks); both tables are gone at head.
                assert (
                    session.execute(
                        text("SELECT to_regclass('public.object_search_documents')")
                    ).scalar_one()
                    is None
                )
                assert (
                    session.execute(
                        text("SELECT to_regclass('public.object_search_embeddings')")
                    ).scalar_one()
                    is None
                )
                assert session.execute(
                    text("""
                        SELECT fallback_identity
                        FROM podcast_episodes
                        WHERE media_id = :media_id
                    """),
                    {"media_id": podcast_media_id},
                ).scalar_one() == (
                    "audio_url=https://cdn.example.test/audio.mp3\n"
                    "title=legacy episode\n"
                    "published_at=2026-01-02t03:04:05z"
                )
                assert (
                    session.execute(
                        text("SELECT provider_podcast_id FROM podcasts WHERE id = :id"),
                        {"id": podcast_id},
                    ).scalar_one()
                    == "opml-feed-url=https://example.test/feed.xml"
                )
                assert (
                    session.execute(
                        text("""
                        SELECT provider_episode_id
                        FROM podcast_episodes
                        WHERE media_id = :media_id
                    """),
                        {"media_id": podcast_media_id},
                    ).scalar_one()
                    == "feed-title-legacy-episode-published-2026-01-02t03-04-05z"
                )
        finally:
            reset_test_schema()
            engine.dispose()

    def test_0138_blocks_ambiguous_podcast_fallback_identity_rewrite(self):
        """0138 fails with an operator error before a fallback unique violation."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0136")
            assert result.returncode == 0, f"upgrade to 0136 failed: {result.stderr}"

            user_id = uuid4()
            podcast_id = uuid4()
            media_a_id = uuid4()
            media_b_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text("""
                        INSERT INTO podcasts (
                            id, provider, provider_podcast_id, title, feed_url
                        )
                        VALUES (
                            :id, 'podcast_index', 'legacy-podcast',
                            'Legacy Podcast', 'https://example.test/feed.xml'
                        )
                    """),
                    {"id": podcast_id},
                )
                for media_id, provider_episode_id, fallback_identity in (
                    (media_a_id, "legacy-episode-a", "legacy-fallback-a"),
                    (media_b_id, "legacy-episode-b", "legacy-fallback-b"),
                ):
                    session.execute(
                        text("""
                            INSERT INTO media (
                                id, kind, title, processing_status, created_by_user_id,
                                canonical_source_url, external_playback_url, provider,
                                provider_id, published_date
                            )
                            VALUES (
                                :id, 'podcast_episode', 'Same Episode', 'ready_for_reading',
                                :user_id, 'https://example.test/feed.xml',
                                'https://cdn.example.test/same.mp3', 'podcast_index',
                                :provider_id, '2026-01-02T03:04:05Z'
                            )
                        """),
                        {
                            "id": media_id,
                            "user_id": user_id,
                            "provider_id": provider_episode_id,
                        },
                    )
                    session.execute(
                        text("""
                            INSERT INTO podcast_episodes (
                                media_id, podcast_id, provider_episode_id, fallback_identity
                            )
                            VALUES (
                                :media_id, :podcast_id,
                                :provider_episode_id, :fallback_identity
                            )
                        """),
                        {
                            "media_id": media_id,
                            "podcast_id": podcast_id,
                            "provider_episode_id": provider_episode_id,
                            "fallback_identity": fallback_identity,
                        },
                    )
                session.commit()

            result = run_alembic_command("upgrade head")

            assert result.returncode != 0
            assert "duplicate podcast episodes normalize to the same fallback_identity" in (
                result.stderr or ""
            )
            assert "uq_podcast_episodes_podcast_fallback_identity" not in (result.stderr or "")
        finally:
            reset_test_schema()
            engine.dispose()


class TestSchemaConstraints:
    """Tests that schema constraints are properly enforced."""

    def test_content_embeddings_vector_column_matches_schema(self, migrated_engine):
        """content_embeddings stores pgvector payloads in the schema dimension."""
        with Session(migrated_engine) as session:
            vector_type = session.execute(
                text(
                    """
                    SELECT format_type(a.atttypid, a.atttypmod)
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    WHERE c.relname = 'content_embeddings'
                      AND a.attname = 'embedding_vector'
                      AND NOT a.attisdropped
                    """
                )
            ).scalar_one()

        assert vector_type == "vector(256)"

    def test_duplicate_default_library_rejected(self, migrated_engine):
        """Partial unique index prevents duplicate default libraries per user."""
        with Session(migrated_engine) as session:
            user_id = uuid4()

            # Create user
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Create first default library
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'My Library', true)
                """),
                {"id": uuid4(), "owner_id": user_id},
            )

            # Attempt to create second default library - should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'Another Default', true)
                    """),
                    {"id": uuid4(), "owner_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uix_libraries_one_default_per_user" in str(exc_info.value)

    def test_duplicate_membership_rejected(self, migrated_engine):
        """Primary key prevents duplicate memberships."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            library_id = uuid4()

            # Create user
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Create library
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Test Library', false)
                """),
                {"id": library_id, "owner_id": user_id},
            )

            # Create first membership
            session.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                """),
                {"library_id": library_id, "user_id": user_id},
            )

            # Attempt duplicate membership - should fail
            with pytest.raises(IntegrityError):
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'member')
                    """),
                    {"library_id": library_id, "user_id": user_id},
                )
                session.commit()

            session.rollback()

    def test_invalid_role_rejected(self, migrated_engine):
        """Check constraint prevents invalid role values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            library_id = uuid4()

            # Create user and library
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Test Library', false)
                """),
                {"id": library_id, "owner_id": user_id},
            )

            # Attempt membership with invalid role
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'invalid_role')
                    """),
                    {"library_id": library_id, "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_memberships_role" in str(exc_info.value)

    def test_billing_plan_tier_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                        VALUES (:id, :user_id, 'legacy_paid', now(), now())
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_billing_accounts_plan_tier" in str(exc_info.value)

    def test_billing_account_user_unique_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                    VALUES (:id, :user_id, 'free', now(), now())
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO billing_accounts (id, user_id, plan_tier, created_at, updated_at)
                        VALUES (:id, :user_id, 'plus', now(), now())
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uq_billing_accounts_user_id" in str(exc_info.value)

    def test_billing_entitlement_override_constraints_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO billing_entitlement_overrides (
                            id,
                            user_id,
                            plan_tier,
                            platform_token_quota_mode,
                            reason
                        )
                        VALUES (:id, :user_id, 'free', 'plan', 'bad')
                        """
                    ),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_billing_entitlement_overrides_plan_tier" in str(exc_info.value)

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO billing_entitlement_overrides (
                            id,
                            user_id,
                            plan_tier,
                            platform_token_quota_mode,
                            platform_token_limit_monthly,
                            reason
                        )
                        VALUES (:id, :user_id, 'ai_pro', 'plan', 10, 'bad')
                        """
                    ),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_billing_entitlement_overrides_platform_token_limit" in str(exc_info.value)

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO billing_entitlement_overrides (
                            id,
                            user_id,
                            plan_tier,
                            transcription_quota_mode,
                            transcription_minutes_limit_monthly,
                            reason
                        )
                        VALUES (:id, :user_id, 'ai_pro', 'custom', -1, 'bad')
                        """
                    ),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_billing_entitlement_overrides_transcription_limit" in str(exc_info.value)

    def test_billing_entitlement_override_zero_custom_quota_allowed(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO billing_entitlement_overrides (
                        id,
                        user_id,
                        plan_tier,
                        platform_token_quota_mode,
                        platform_token_limit_monthly,
                        transcription_quota_mode,
                        transcription_minutes_limit_monthly,
                        reason
                    )
                    VALUES (
                        :id,
                        :user_id,
                        'ai_pro',
                        'custom',
                        0,
                        'custom',
                        0,
                        'zero quota'
                    )
                    """
                ),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

    def test_billing_entitlement_override_user_unique_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO billing_entitlement_overrides (id, user_id, plan_tier, reason)
                    VALUES (:id, :user_id, 'plus', 'first')
                    """
                ),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO billing_entitlement_overrides (id, user_id, plan_tier, reason)
                        VALUES (:id, :user_id, 'ai_pro', 'second')
                        """
                    ),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()
            session.rollback()
            assert "uq_billing_entitlement_overrides_user_id" in str(exc_info.value)

    def test_billing_entitlement_override_event_type_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO billing_entitlement_override_events (
                            id,
                            user_id,
                            event_type,
                            reason
                        )
                        VALUES (:id, :user_id, 'deleted', 'bad')
                        """
                    ),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_billing_entitlement_override_events_event_type" in str(exc_info.value)

    def test_pages_title_length_constraint_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO pages (id, user_id, title)
                        VALUES (:id, :user_id, '')
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_pages_title_length" in str(exc_info.value)

    def test_billing_webhook_event_duplicate_rejected(self, migrated_engine):
        with Session(migrated_engine) as session:
            event_id = "evt_test_1"
            session.execute(
                text("""
                    INSERT INTO stripe_webhook_events (
                        id,
                        stripe_event_id,
                        event_type,
                        processed_at,
                        created_at
                    )
                    VALUES (:id, :stripe_event_id, 'checkout.session.completed', now(), now())
                """),
                {"id": uuid4(), "stripe_event_id": event_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO stripe_webhook_events (
                            id,
                            stripe_event_id,
                            event_type,
                            processed_at,
                            created_at
                        )
                        VALUES (:id, :stripe_event_id, 'checkout.session.completed', now(), now())
                    """),
                    {"id": uuid4(), "stripe_event_id": event_id},
                )
                session.commit()

            session.rollback()
            assert "uq_stripe_webhook_events_stripe_event_id" in str(exc_info.value)

    def test_invalid_media_kind_rejected(self, migrated_engine):
        """Check constraint prevents invalid media kind values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'invalid_kind', 'Test', 'pending', :user_id)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_media_kind" in str(exc_info.value)

    def test_invalid_processing_status_rejected(self, migrated_engine):
        """Enum type prevents invalid processing status values."""
        from sqlalchemy.exc import DBAPIError

        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # With enum type, casting an invalid value fails with a database error
            with pytest.raises(DBAPIError):
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', 'Test', 'invalid_status'::processing_status_enum, :user_id)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()

    def test_library_name_too_short_rejected(self, migrated_engine):
        """Check constraint prevents empty library names."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, '', false)
                    """),
                    {"id": uuid4(), "owner_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_libraries_name_length" in str(exc_info.value)

    def test_library_name_too_long_rejected(self, migrated_engine):
        """Check constraint prevents library names over 100 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_name = "x" * 101
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, :name, false)
                    """),
                    {"id": uuid4(), "owner_id": user_id, "name": long_name},
                )
                session.commit()

            session.rollback()
            assert "ck_libraries_name_length" in str(exc_info.value)

    def test_valid_media_kinds_accepted(self, migrated_engine):
        """All valid media kinds are accepted."""
        valid_kinds = ["web_article", "epub", "pdf", "video", "podcast_episode"]

        with Session(migrated_engine) as session:
            # Need a user for created_by_user_id
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            for kind in valid_kinds:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, :kind, :title, 'pending', :user_id)
                    """),
                    {"id": media_id, "kind": kind, "title": f"Test {kind}", "user_id": user_id},
                )

            session.commit()

            # Verify all were inserted (including system user media)
            result = session.execute(
                text("SELECT COUNT(*) FROM media WHERE created_by_user_id = :user_id"),
                {"user_id": user_id},
            )
            count = result.scalar()
            assert count == len(valid_kinds)

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_valid_processing_statuses_accepted(self, migrated_engine):
        """All valid processing statuses are accepted."""
        valid_statuses = [
            "pending",
            "extracting",
            "ready_for_reading",
            "failed",
        ]

        with Session(migrated_engine) as session:
            # Need a user for created_by_user_id
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            for status in valid_statuses:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', :title, CAST(:status AS processing_status_enum), :user_id)
                    """),
                    {
                        "id": media_id,
                        "title": f"Test {status}",
                        "status": status,
                        "user_id": user_id,
                    },
                )

            session.commit()

            # Clean up
            session.execute(text("DELETE FROM media"))
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    @pytest.mark.parametrize("status", ["embedding", "ready"])
    def test_legacy_processing_statuses_rejected(self, migrated_engine, status):
        """Removed media processing statuses are rejected by the final enum."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            with pytest.raises(DBAPIError):
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                        VALUES (:id, 'web_article', 'Legacy status', CAST(:status AS processing_status_enum), :user_id)
                    """),
                    {
                        "id": uuid4(),
                        "status": status,
                        "user_id": user_id,
                    },
                )
            session.rollback()
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_fragment_time_offsets_require_strictly_increasing_ranges(self, migrated_engine):
        """Fragment transcript timing must enforce t_start_ms < t_end_ms."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'podcast_episode', 'Timing Test', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

            # Valid strict range succeeds.
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                    )
                    VALUES (:id, :media_id, 0, 'ok', '<p>ok</p>', 100, 200)
                    """
                ),
                {"id": uuid4(), "media_id": media_id},
            )
            session.commit()

            # Zero-length range must fail.
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO fragments (
                            id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                        )
                        VALUES (:id, :media_id, 1, 'zero', '<p>zero</p>', 200, 200)
                        """
                    ),
                    {"id": uuid4(), "media_id": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_fragments_time_offsets_valid" in str(exc_info.value)

            # Backwards range must fail.
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO fragments (
                            id, media_id, idx, canonical_text, html_sanitized, t_start_ms, t_end_ms
                        )
                        VALUES (:id, :media_id, 2, 'backward', '<p>backward</p>', 400, 300)
                        """
                    ),
                    {"id": uuid4(), "media_id": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_fragments_time_offsets_valid" in str(exc_info.value)


class TestS1SchemaConstraints:
    """Tests for S1-specific schema constraints (idempotency indexes, URL lengths)."""

    def test_canonical_url_uniqueness(self, migrated_engine):
        """Partial unique index on (kind, canonical_url) enforced."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            canonical_url = "https://example.com/article"

            # Create first media with canonical_url
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                    VALUES (:id, 'web_article', 'First Article', 'pending', :user_id, :canonical_url)
                """),
                {"id": uuid4(), "user_id": user_id, "canonical_url": canonical_url},
            )
            session.commit()

            # Attempt to create second media with same kind and canonical_url
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                        VALUES (:id, 'web_article', 'Second Article', 'pending', :user_id, :canonical_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "canonical_url": canonical_url},
                )
                session.commit()

            session.rollback()
            assert "uix_media_canonical_url" in str(exc_info.value)

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_x_provider_identity_uniqueness(self, migrated_engine):
        """Partial unique index enforces one media row per X post ID."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'web_article', 'First X Post', 'ready_for_reading', :user_id,
                        'x', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id,
                            provider, provider_id
                        )
                        VALUES (
                            :id, 'web_article', 'Second X Post', 'ready_for_reading', :user_id,
                            'x', '1234567890'
                        )
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "uix_media_x_provider_id" in str(exc_info.value)

            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'video', 'YouTube Fixture', 'ready_for_reading', :user_id,
                        'youtube', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, processing_status, created_by_user_id,
                        provider, provider_id
                    )
                    VALUES (
                        :id, 'video', 'Second YouTube Fixture', 'ready_for_reading', :user_id,
                        'youtube', '1234567890'
                    )
                """),
                {"id": uuid4(), "user_id": user_id},
            )
            session.commit()

            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_media_file_sha256_identity_is_removed(self, migrated_engine):
        """PDF/EPUB file bytes are not app-level media identity at head."""
        with Session(migrated_engine) as session:
            media_columns = {
                row[0]
                for row in session.execute(
                    text("""
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'media'
                    """)
                )
            }
            media_indexes = {
                row[0]
                for row in session.execute(
                    text("""
                        SELECT indexname
                        FROM pg_indexes
                        WHERE tablename = 'media'
                    """)
                )
            }

        assert "file_sha256" not in media_columns
        assert "uix_media_file_sha256" not in media_indexes
        assert "idx_media_stale_pending_upload_cleanup" not in media_indexes

    def test_requested_url_length_constraint(self, migrated_engine):
        """Check constraint prevents requested_url over 2048 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_url = "https://example.com/" + "x" * 2030

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, requested_url)
                        VALUES (:id, 'web_article', 'Test', 'pending', :user_id, :requested_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "requested_url": long_url},
                )
                session.commit()

            session.rollback()
            assert "ck_media_requested_url_length" in str(exc_info.value)

    def test_canonical_url_length_constraint(self, migrated_engine):
        """Check constraint prevents canonical_url over 2048 characters."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            long_url = "https://example.com/" + "y" * 2030

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, canonical_url)
                        VALUES (:id, 'web_article', 'Test', 'pending', :user_id, :canonical_url)
                    """),
                    {"id": uuid4(), "user_id": user_id, "canonical_url": long_url},
                )
                session.commit()

            session.rollback()
            assert "ck_media_canonical_url_length" in str(exc_info.value)

    def test_media_file_table_exists(self, migrated_engine):
        """media_file table exists and can store file metadata."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'pdf', 'Test PDF', 'pending', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )

            # Insert media_file
            session.execute(
                text("""
                    INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                    VALUES (:media_id, 'media/test/original.pdf', 'application/pdf', 1048576)
                """),
                {"media_id": media_id},
            )
            session.commit()

            # Verify it was inserted
            result = session.execute(
                text(
                    "SELECT storage_path, content_type, size_bytes FROM media_file WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "media/test/original.pdf"
            assert row[1] == "application/pdf"
            assert row[2] == 1048576

            # Clean up (cascade should handle media_file)
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_failure_stage_enum(self, migrated_engine):
        """failure_stage enum accepts valid values and rejects invalid."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            valid_stages = ["upload", "extract", "transcribe", "embed", "other"]

            for stage in valid_stages:
                media_id = uuid4()
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status, created_by_user_id, failure_stage)
                        VALUES (:id, 'web_article', :title, 'failed', :user_id, CAST(:stage AS failure_stage_enum))
                    """),
                    {"id": media_id, "title": f"Test {stage}", "user_id": user_id, "stage": stage},
                )

            session.commit()

            # Clean up
            session.execute(
                text("DELETE FROM media WHERE created_by_user_id = :user_id"), {"user_id": user_id}
            )
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_processing_attempts_default(self, migrated_engine):
        """processing_attempts defaults to 0."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'pending', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

            result = session.execute(
                text("SELECT processing_attempts FROM media WHERE id = :id"),
                {"id": media_id},
            )
            attempts = result.scalar()
            assert attempts == 0

            # Clean up
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestS2HighlightsNotesConstraints:
    """Tests for highlight and notes-layer schema constraints."""

    def test_invalid_highlight_color_rejected(self, migrated_engine):
        """CHECK constraint prevents invalid highlight color values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Attempt to create highlight with invalid color
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlights (
                            id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                        )
                        VALUES (
                            :id, :user_id, 'fragment_offsets', :media_id,
                            'invalid_color', 'exact', 'prefix', 'suffix'
                        )
                    """),
                    {"id": uuid4(), "user_id": user_id, "media_id": media_id},
                )
                session.commit()

            session.rollback()
            assert "ck_highlights_color" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_invalid_fragment_anchor_offsets_rejected(self, migrated_engine):
        """Canonical fragment anchor rows reject invalid offset ranges."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            session.execute(
                text("""
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.commit()

            # Test case 1: end_offset <= start_offset (end == start)
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, 10, 10)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Test case 2: end_offset < start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, 10, 5)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Test case 3: negative start_offset
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO highlight_fragment_anchors (
                            highlight_id, fragment_id, start_offset, end_offset
                        )
                        VALUES (:highlight_id, :fragment_id, -1, 10)
                    """),
                    {"highlight_id": highlight_id, "fragment_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_hfa_offsets_valid" in str(exc_info.value)

            # Clean up
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_duplicate_fragment_spans_are_not_db_constrained_at_head(self, migrated_engine):
        """Head schema no longer keeps a bridge-column unique index for fragment spans."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )

            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="yellow",
                exact="exact",
            )
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="blue",
                exact="exact",
            )
            session.commit()

            count = session.execute(
                text(
                    "SELECT COUNT(*) FROM highlight_fragment_anchors "
                    "WHERE fragment_id = :fragment_id AND start_offset = 0 AND end_offset = 10"
                ),
                {"fragment_id": fragment_id},
            ).scalar_one()
            assert count == 2

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_annotations_table_removed(self, migrated_engine):
        """The notes hard cutover removes legacy annotation storage."""
        with Session(migrated_engine) as session:
            table_name = session.execute(text("SELECT to_regclass('public.annotations')")).scalar()
            assert table_name is None

    def test_multiple_note_blocks_can_link_to_one_highlight(self, migrated_engine):
        """Highlight notes are independent note blocks, not one annotation row."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()
            highlight_id = uuid4()
            page_id = uuid4()
            note_a_id = uuid4()
            note_b_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, 'fragment_offsets', :media_id,
                        'yellow', 'exact', 'prefix', 'suffix'
                    )
                """),
                {"id": highlight_id, "user_id": user_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO highlight_fragment_anchors (
                        highlight_id, fragment_id, start_offset, end_offset
                    )
                    VALUES (:highlight_id, :fragment_id, 0, 10)
                """),
                {"highlight_id": highlight_id, "fragment_id": fragment_id},
            )
            session.execute(
                text("""
                    INSERT INTO pages (id, user_id, title)
                    VALUES (:id, :user_id, 'Highlight Notes')
                """),
                {"id": page_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO note_blocks (
                        id, user_id, body_pm_json, body_text
                    )
                    VALUES
                        (
                            :note_a_id, :user_id,
                            jsonb_build_object('type', 'paragraph'), ''
                        ),
                        (
                            :note_b_id, :user_id,
                            jsonb_build_object('type', 'paragraph'), ''
                        )
                """),
                {
                    "note_a_id": note_a_id,
                    "note_b_id": note_b_id,
                    "user_id": user_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, source_order_key
                    )
                        VALUES
                        (
                            :user_id, 'context', 'user',
                            'page', :page_id, 'note_block', :note_a_id, '0000000001'
                        ),
                        (
                            :user_id, 'context', 'user',
                            'page', :page_id, 'note_block', :note_b_id, '0000000002'
                        )
                """),
                {
                    "user_id": user_id,
                    "page_id": page_id,
                    "note_a_id": note_a_id,
                    "note_b_id": note_b_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO resource_edges (
                        id, user_id, kind, origin,
                        source_scheme, source_id, target_scheme, target_id
                    )
                    VALUES
                        (
                            :edge_a_id, :user_id, 'context', 'highlight_note',
                            'highlight', :highlight_id, 'note_block', :note_a_id
                        ),
                        (
                            :edge_b_id, :user_id, 'context', 'highlight_note',
                            'highlight', :highlight_id, 'note_block', :note_b_id
                        )
                """),
                {
                    "edge_a_id": uuid4(),
                    "edge_b_id": uuid4(),
                    "user_id": user_id,
                    "note_a_id": note_a_id,
                    "note_b_id": note_b_id,
                    "highlight_id": highlight_id,
                },
            )
            session.commit()

            result = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM resource_edges
                    WHERE origin = 'highlight_note'
                      AND source_scheme = 'highlight'
                      AND source_id = :highlight_id
                """),
                {"highlight_id": highlight_id},
            )
            assert result.scalar_one() == 2

            # Clean up
            session.execute(
                text(
                    """
                    DELETE FROM resource_edges
                    WHERE source_id IN (:highlight_id, :page_id)
                       OR target_id IN (:note_a_id, :note_b_id)
                    """
                ),
                {
                    "highlight_id": highlight_id,
                    "page_id": page_id,
                    "note_a_id": note_a_id,
                    "note_b_id": note_b_id,
                },
            )
            session.execute(
                text("DELETE FROM note_blocks WHERE id IN (:note_a_id, :note_b_id)"),
                {"note_a_id": note_a_id, "note_b_id": note_b_id},
            )
            session.execute(text("DELETE FROM pages WHERE id = :id"), {"id": page_id})
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": highlight_id})
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_valid_highlight_colors_accepted(self, migrated_engine):
        """All valid highlight colors are accepted."""
        valid_colors = ["yellow", "green", "blue", "pink", "purple"]

        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content for highlights', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Create highlights with each valid color.
            for i, color in enumerate(valid_colors):
                start = i * 5
                end = start + 4
                insert_canonical_fragment_highlight(
                    session,
                    highlight_id=uuid4(),
                    user_id=user_id,
                    media_id=media_id,
                    fragment_id=fragment_id,
                    start_offset=start,
                    end_offset=end,
                    color=color,
                    exact="text",
                    prefix="",
                    suffix="",
                )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlight_fragment_anchors WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            count = result.scalar()
            assert count == len(valid_colors)

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_overlapping_highlights_allowed(self, migrated_engine):
        """Overlapping highlights at different offsets are allowed."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            # Create user and media with fragment
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test Article', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test canonical text content', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # Create first highlight: [0, 10)
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=10,
                color="yellow",
                exact="exact1",
            )

            # Create overlapping highlight: [5, 15) - overlaps with first
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=5,
                end_offset=15,
                color="blue",
                exact="exact2",
            )

            # Create nested highlight: [2, 8) - contained within first
            insert_canonical_fragment_highlight(
                session,
                highlight_id=uuid4(),
                user_id=user_id,
                media_id=media_id,
                fragment_id=fragment_id,
                start_offset=2,
                end_offset=8,
                color="green",
                exact="exact3",
            )

            session.commit()

            # Verify all highlights were inserted
            result = session.execute(
                text("SELECT COUNT(*) FROM highlight_fragment_anchors WHERE fragment_id = :fid"),
                {"fid": fragment_id},
            )
            assert result.scalar() == 3

            # Clean up
            session.execute(text("DELETE FROM fragments WHERE id = :id"), {"id": fragment_id})
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()


class TestWorkerRuntime:
    """Tests for worker runtime import and initialization."""

    def test_worker_app_initializes(self):
        """Worker app can be imported and constructed without error."""
        from apps.worker.main import create_worker

        worker = create_worker()
        assert worker is not None
        assert len(worker.registry) > 0

    def test_worker_queue_and_reconciler_indexes_exist(self, migrated_engine):
        with Session(migrated_engine) as session:
            indexes = {
                row["index_name"]: row
                for row in session.execute(
                    text(
                        """
                        SELECT
                            idx.relname AS index_name,
                            tbl.relname AS table_name,
                            array_agg(
                                pg_get_indexdef(i.indexrelid, keys.key_no, true)
                                ORDER BY keys.key_no
                            ) AS keys,
                            pg_get_expr(i.indpred, i.indrelid) AS predicate
                        FROM pg_index i
                        JOIN pg_class idx ON idx.oid = i.indexrelid
                        JOIN pg_class tbl ON tbl.oid = i.indrelid
                        JOIN pg_namespace ns ON ns.oid = idx.relnamespace
                        CROSS JOIN LATERAL generate_series(1, i.indnkeyatts) AS keys(key_no)
                        WHERE ns.nspname = 'public'
                        GROUP BY idx.relname, tbl.relname, i.indexrelid, i.indrelid, i.indpred
                        """
                    )
                )
                .mappings()
                .all()
            }

        def assert_index(
            name: str,
            *,
            table_name: str,
            keys: list[str],
            predicate_fragments: list[str],
        ) -> None:
            assert name in indexes, f"Expected worker hardening index {name} to exist."
            row = indexes[name]
            assert row["table_name"] == table_name, (
                f"Expected {name} on table {table_name}. Row={row}"
            )
            assert list(row["keys"]) == keys, f"Expected {name} keys {keys}. Row={row}"
            predicate = str(row["predicate"]).lower()
            missing_fragments = [
                fragment for fragment in predicate_fragments if fragment.lower() not in predicate
            ]
            assert not missing_fragments, (
                f"Expected {name} predicate to contain {missing_fragments}. "
                f"Predicate={row['predicate']}"
            )

        def assert_plan_uses_any_index(sql: str, index_names: tuple[str, ...]) -> None:
            with Session(migrated_engine) as session:
                session.execute(text("SET enable_seqscan = off"))
                plan = "\n".join(row[0] for row in session.execute(text(sql)).fetchall())
            assert any(index_name in plan for index_name in index_names), (
                f"Expected plan to use one of {index_names}. Plan:\n{plan}"
            )

        assert_index(
            "idx_background_jobs_due_claim",
            table_name="background_jobs",
            keys=["priority", "available_at", "created_at", "id"],
            predicate_fragments=["pending", "failed"],
        )
        assert_index(
            "idx_background_jobs_due_claim_by_kind",
            table_name="background_jobs",
            keys=["kind", "priority", "available_at", "created_at", "id"],
            predicate_fragments=["pending", "failed"],
        )
        assert_index(
            "idx_background_jobs_running_expired_claim",
            table_name="background_jobs",
            keys=["priority", "lease_expires_at", "created_at", "id"],
            predicate_fragments=["running", "lease_expires_at IS NOT NULL"],
        )
        assert_index(
            "idx_background_jobs_running_expired_claim_by_kind",
            table_name="background_jobs",
            keys=["kind", "priority", "lease_expires_at", "created_at", "id"],
            predicate_fragments=["running", "lease_expires_at IS NOT NULL"],
        )
        assert_index(
            "idx_background_jobs_wait_due",
            table_name="background_jobs",
            keys=["available_at", "id"],
            predicate_fragments=["pending", "failed"],
        )
        assert_index(
            "idx_background_jobs_wait_due_by_kind",
            table_name="background_jobs",
            keys=["kind", "available_at", "id"],
            predicate_fragments=["pending", "failed"],
        )
        assert_index(
            "idx_background_jobs_wait_running",
            table_name="background_jobs",
            keys=["lease_expires_at", "id"],
            predicate_fragments=["running", "lease_expires_at IS NOT NULL"],
        )
        assert_index(
            "idx_background_jobs_wait_running_by_kind",
            table_name="background_jobs",
            keys=["kind", "lease_expires_at", "id"],
            predicate_fragments=["running", "lease_expires_at IS NOT NULL"],
        )
        assert_plan_uses_any_index(
            """
            EXPLAIN (COSTS OFF)
            SELECT available_at
            FROM background_jobs
            WHERE status IN ('pending', 'failed')
              AND kind = ANY(ARRAY['ingest_media_source'])
              AND available_at > now()
            ORDER BY available_at ASC, id ASC
            LIMIT 1
            """,
            ("idx_background_jobs_wait_due", "idx_background_jobs_wait_due_by_kind"),
        )
        assert_plan_uses_any_index(
            """
            EXPLAIN (COSTS OFF)
            SELECT lease_expires_at
            FROM background_jobs
            WHERE status = 'running'
              AND lease_expires_at IS NOT NULL
              AND kind = ANY(ARRAY['ingest_media_source'])
              AND lease_expires_at > now()
            ORDER BY lease_expires_at ASC, id ASC
            LIMIT 1
            """,
            (
                "idx_background_jobs_wait_running",
                "idx_background_jobs_wait_running_by_kind",
            ),
        )
        assert_index(
            "idx_background_jobs_terminal_prune",
            table_name="background_jobs",
            keys=["finished_at", "id"],
            predicate_fragments=["succeeded", "dead", "finished_at IS NOT NULL"],
        )
        assert_index(
            "idx_media_stale_extracting_recovery",
            table_name="media",
            keys=["processing_started_at", "id"],
            predicate_fragments=[
                "processing_status",
                "extracting",
                "web_article",
                "pdf",
                "epub",
                "podcast_episode",
                "processing_started_at IS NOT NULL",
            ],
        )
        assert_index(
            "ix_content_index_states_repair_waiting",
            table_name="content_index_states",
            keys=["updated_at", "owner_kind", "owner_id"],
            predicate_fragments=["pending", "failed"],
        )
        assert_index(
            "ix_content_index_states_repair_indexing",
            table_name="content_index_states",
            keys=["updated_at", "owner_kind", "owner_id"],
            predicate_fragments=["indexing"],
        )
        assert_index(
            "ix_media_transcript_states_semantic_repair",
            table_name="media_transcript_states",
            keys=["updated_at", "media_id"],
            predicate_fragments=[
                "ready",
                "partial",
                "full",
                "pending",
                "failed",
            ],
        )


class TestS4Migration0007:
    """Tests for S4 migration 0007 — library sharing schema.

    Each test self-manages migration state (reset schema -> upgrade target).
    Does NOT rely on the module-level migrated_engine fixture.
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s4_engine(self):
        """Provide a dedicated engine for S4 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def test_upgrade_0006_to_0007_seeds_edges_and_intrinsics(self, s4_engine):
        """Seed transform produces correct closure edges and intrinsics."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0, f"upgrade 0006 failed: {result.stderr}"

        u1 = uuid4()
        d1 = uuid4()  # default library for u1
        l1 = uuid4()  # non-default library
        m_edge = uuid4()  # media in l1 AND d1
        m_intrinsic_only = uuid4()  # media in d1 only

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u1})

            # Default library for u1
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": d1, "owner": u1},
            )
            # Non-default library
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared', false)"
                ),
                {"id": l1, "owner": u1},
            )

            # u1 is member of both libraries
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": d1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u1},
            )

            # Media m_edge in l1 AND d1
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Edge Article', 'ready_for_reading', :user)"
                ),
                {"id": m_edge, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m_edge},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_edge},
            )

            # Media m_intrinsic_only in d1 only
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Intrinsic Article', 'ready_for_reading', :user)"
                ),
                {"id": m_intrinsic_only, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_intrinsic_only},
            )

            session.commit()

        # Upgrade to 0007 — seed runs
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0, f"upgrade 0007 failed: {result.stderr}"

        # Assert seed results
        with Session(s4_engine) as session:
            # Closure edge: (d1, m_edge, l1) must exist
            edge_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_closure_edges "
                    "WHERE default_library_id = :d AND media_id = :m "
                    "AND source_library_id = :s"
                ),
                {"d": d1, "m": m_edge, "s": l1},
            ).scalar()
            assert edge_count == 1

            # Intrinsic: (d1, m_intrinsic_only) must exist
            intrinsic_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_intrinsics "
                    "WHERE default_library_id = :d AND media_id = :m"
                ),
                {"d": d1, "m": m_intrinsic_only},
            ).scalar()
            assert intrinsic_count == 1

            # Intrinsic: (d1, m_edge) must NOT exist (covered by closure edge)
            edge_intrinsic = session.execute(
                text(
                    "SELECT COUNT(*) FROM default_library_intrinsics "
                    "WHERE default_library_id = :d AND media_id = :m"
                ),
                {"d": d1, "m": m_edge},
            ).scalar()
            assert edge_intrinsic == 0

            # Backfill jobs: 0 rows
            job_count = session.execute(
                text("SELECT COUNT(*) FROM default_library_backfill_jobs")
            ).scalar()
            assert job_count == 0

    def test_upgrade_0006_to_0007_fails_when_member_has_no_default_library(self, s4_engine):
        """Upgrade hard-fails with sentinel when default library is missing."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0

        u_owner = uuid4()
        u_member = uuid4()
        l1 = uuid4()
        m1 = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u_owner})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u_member})

            # Owner has a default library
            owner_default = uuid4()
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Owner Default', true)"
                ),
                {"id": owner_default, "owner": u_owner},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": owner_default, "user": u_owner},
            )

            # Non-default library owned by u_owner
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared Lib', false)"
                ),
                {"id": l1, "owner": u_owner},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u_owner},
            )

            # u_member is member of l1 but has NO default library
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'member')"
                ),
                {"lib": l1, "user": u_member},
            )

            # Media in l1
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Article', 'ready_for_reading', :user)"
                ),
                {"id": m1, "user": u_owner},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m1},
            )

            session.commit()

        # Upgrade should fail
        result = run_alembic_command("upgrade 0007")
        assert result.returncode != 0
        combined = result.stdout + result.stderr
        assert "S4_0007_MISSING_DEFAULT_LIBRARY" in combined

    def test_upgrade_0006_to_0007_seed_is_idempotent_after_downgrade_round_trip(self, s4_engine):
        """Seeded PK tuple sets are identical after downgrade + re-upgrade."""
        result = run_alembic_command("upgrade 0006")
        assert result.returncode == 0

        u1 = uuid4()
        d1 = uuid4()
        l1 = uuid4()
        m_edge = uuid4()
        m_intrinsic_only = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u1})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": d1, "owner": u1},
            )
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Shared', false)"
                ),
                {"id": l1, "owner": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": d1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role) "
                    "VALUES (:lib, :user, 'admin')"
                ),
                {"lib": l1, "user": u1},
            )
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Edge', 'ready_for_reading', :user)"
                ),
                {"id": m_edge, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": l1, "med": m_edge},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_edge},
            )
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                    "VALUES (:id, 'web_article', 'Intrinsic', 'ready_for_reading', :user)"
                ),
                {"id": m_intrinsic_only, "user": u1},
            )
            session.execute(
                text("INSERT INTO library_media (library_id, media_id) VALUES (:lib, :med)"),
                {"lib": d1, "med": m_intrinsic_only},
            )
            session.commit()

        # First upgrade
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0

        with Session(s4_engine) as session:
            edges_first = set(
                session.execute(
                    text(
                        "SELECT default_library_id, media_id, source_library_id "
                        "FROM default_library_closure_edges"
                    )
                ).fetchall()
            )
            intrinsics_first = set(
                session.execute(
                    text("SELECT default_library_id, media_id FROM default_library_intrinsics")
                ).fetchall()
            )

        # Downgrade back to 0006
        result = run_alembic_command("downgrade 0006")
        assert result.returncode == 0

        # Second upgrade
        result = run_alembic_command("upgrade 0007")
        assert result.returncode == 0

        with Session(s4_engine) as session:
            edges_second = set(
                session.execute(
                    text(
                        "SELECT default_library_id, media_id, source_library_id "
                        "FROM default_library_closure_edges"
                    )
                ).fetchall()
            )
            intrinsics_second = set(
                session.execute(
                    text("SELECT default_library_id, media_id FROM default_library_intrinsics")
                ).fetchall()
            )

        assert edges_first == edges_second
        assert intrinsics_first == intrinsics_second

    def test_0007_supporting_indexes_exist(self, s4_engine):
        """All expected 0007 index names exist in pg_indexes."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        expected_indexes = [
            # library_invitations
            "uix_library_invitations_pending_once",
            "idx_library_invitations_library_status_created",
            "idx_library_invitations_invitee_status_created",
            # default_library_intrinsics
            "idx_default_library_intrinsics_media",
            # default_library_closure_edges
            "idx_default_library_closure_edges_source",
            "idx_default_library_closure_edges_default_media",
            # default_library_backfill_jobs
            "idx_default_library_backfill_jobs_status_updated",
            # existing-table supporting indexes
            "idx_memberships_user_library_role",
            "idx_library_entries_media_library",
            "idx_conversation_shares_library_conversation",
        ]

        with Session(s4_engine) as session:
            result = session.execute(
                text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
            )
            existing = {row[0] for row in result.fetchall()}

        for idx_name in expected_indexes:
            assert idx_name in existing, f"Index {idx_name} not found"

    def test_library_invitations_pending_unique_partial_index(self, s4_engine):
        """Partial unique index prevents duplicate pending invites."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        inviter = uuid4()
        invitee = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": inviter})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": invitee})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": inviter},
            )

            # First pending invite
            session.execute(
                text(
                    "INSERT INTO library_invitations "
                    "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                    "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending')"
                ),
                {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
            )
            session.commit()

            # Duplicate pending invite should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending')"
                    ),
                    {
                        "id": uuid4(),
                        "lib": library_id,
                        "inviter": inviter,
                        "invitee": invitee,
                    },
                )
                session.commit()

            session.rollback()
            assert "uix_library_invitations_pending_once" in str(exc_info.value)

    def test_library_invitations_responded_at_check_constraint(self, s4_engine):
        """Check constraint enforces responded_at/status consistency."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        inviter = uuid4()
        invitee = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": inviter})
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": invitee})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": inviter},
            )
            session.commit()

            # pending with non-null responded_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'pending', now())"
                    ),
                    {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
                )
                session.commit()
            session.rollback()
            assert "ck_library_invitations_responded_at" in str(exc_info.value)

            # accepted with null responded_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                        "VALUES (:id, :lib, :inviter, :invitee, 'member', 'accepted', NULL)"
                    ),
                    {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
                )
                session.commit()
            session.rollback()
            assert "ck_library_invitations_responded_at" in str(exc_info.value)

            # valid terminal: accepted with non-null responded_at → must succeed
            session.execute(
                text(
                    "INSERT INTO library_invitations "
                    "(id, library_id, inviter_user_id, invitee_user_id, role, status, responded_at) "
                    "VALUES (:id, :lib, :inviter, :invitee, 'member', 'accepted', now())"
                ),
                {"id": uuid4(), "lib": library_id, "inviter": inviter, "invitee": invitee},
            )
            session.commit()

    def test_library_invitations_not_self_check_constraint(self, s4_engine):
        """Check constraint prevents self-invitations."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        user = uuid4()
        library_id = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Test', false)"
                ),
                {"id": library_id, "owner": user},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO library_invitations "
                        "(id, library_id, inviter_user_id, invitee_user_id, role, status) "
                        "VALUES (:id, :lib, :user, :user, 'member', 'pending')"
                    ),
                    {"id": uuid4(), "lib": library_id, "user": user},
                )
                session.commit()

            session.rollback()
            assert "ck_library_invitations_not_self" in str(exc_info.value)

    def test_default_library_backfill_jobs_finished_at_state_constraint(self, s4_engine):
        """Check constraint enforces finished_at/status consistency for backfill jobs."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0

        user = uuid4()
        default_lib = uuid4()
        source_lib = uuid4()

        with Session(s4_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user})
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Default', true)"
                ),
                {"id": default_lib, "owner": user},
            )
            session.execute(
                text(
                    "INSERT INTO libraries (id, owner_user_id, name, is_default) "
                    "VALUES (:id, :owner, 'Source', false)"
                ),
                {"id": source_lib, "owner": user},
            )
            session.commit()

            # pending with non-null finished_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO default_library_backfill_jobs "
                        "(default_library_id, source_library_id, user_id, status, finished_at) "
                        "VALUES (:dl, :sl, :u, 'pending', now())"
                    ),
                    {"dl": default_lib, "sl": source_lib, "u": user},
                )
                session.commit()
            session.rollback()
            assert "ck_default_library_backfill_jobs_finished_at_state" in str(exc_info.value)

            # completed with null finished_at → must fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO default_library_backfill_jobs "
                        "(default_library_id, source_library_id, user_id, status, finished_at) "
                        "VALUES (:dl, :sl, :u, 'completed', NULL)"
                    ),
                    {"dl": default_lib, "sl": source_lib, "u": user},
                )
                session.commit()
            session.rollback()
            assert "ck_default_library_backfill_jobs_finished_at_state" in str(exc_info.value)

            # valid: completed with non-null finished_at → must succeed
            session.execute(
                text(
                    "INSERT INTO default_library_backfill_jobs "
                    "(default_library_id, source_library_id, user_id, status, finished_at) "
                    "VALUES (:dl, :sl, :u, 'completed', now())"
                ),
                {"dl": default_lib, "sl": source_lib, "u": user},
            )
            session.commit()


class TestS5Migration0008:
    """Tests for S5 migration 0008 — epub_toc_nodes schema.

    Each test self-manages migration state (reset schema -> upgrade target).
    Does NOT rely on the module-level migrated_engine fixture.
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s5_engine(self):
        """Provide a dedicated engine for S5 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def _create_epub_fixtures(self, session):
        """Insert user + epub media + fragment fixtures, return their ids."""
        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                "INSERT INTO media (id, kind, title, processing_status, created_by_user_id) "
                "VALUES (:id, 'epub', 'Test EPUB', 'extracting', :user_id)"
            ),
            {"id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                "VALUES (:id, :media_id, 0, 'Chapter one text', '<p>Chapter one</p>')"
            ),
            {"id": fragment_id, "media_id": media_id},
        )
        session.commit()
        return user_id, media_id, fragment_id

    def test_0008_epub_toc_nodes_table_and_indexes_exist(self, s5_engine):
        """Table epub_toc_nodes and its indexes exist after upgrade to head."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            # Table exists
            table_result = session.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_name = 'epub_toc_nodes'"
                )
            )
            assert table_result.fetchone() is not None, "epub_toc_nodes table must exist"

            # Indexes exist
            idx_result = session.execute(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'epub_toc_nodes'"
                )
            )
            index_names = {row[0] for row in idx_result.fetchall()}
            assert "uix_epub_toc_nodes_media_nav_order" in index_names
            assert "idx_epub_toc_nodes_media_fragment" in index_names

    def test_0008_epub_toc_nodes_constraints_enforced(self, s5_engine):
        """Check and FK constraints on epub_toc_nodes reject invalid data."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            # node_id empty -> fail ck_epub_toc_nodes_node_id_nonempty
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, '', 'Label', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_node_id_nonempty" in str(exc_info.value)

            # label whitespace-only -> fail ck_epub_toc_nodes_label_nonempty
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n1', '   ', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_label_nonempty" in str(exc_info.value)

            # parent_node_id == node_id -> fail ck_epub_toc_nodes_parent_nonself
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, parent_node_id, label, depth, order_key) "
                        "VALUES (:mid, 'self', 'self', 'Label', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_parent_nonself" in str(exc_info.value)

            # depth negative -> fail ck_epub_toc_nodes_depth_range
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n2', 'Label', -1, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_depth_range" in str(exc_info.value)

            # depth too large -> fail ck_epub_toc_nodes_depth_range
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'n3', 'Label', 17, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_depth_range" in str(exc_info.value)

            # fragment_idx negative -> fail ck_epub_toc_nodes_fragment_idx_nonneg
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key, fragment_idx) "
                        "VALUES (:mid, 'n4', 'Label', 0, '0001', -1)"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "ck_epub_toc_nodes_fragment_idx_nonneg" in str(exc_info.value)

            # parent FK referencing nonexistent parent -> fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, parent_node_id, label, depth, order_key) "
                        "VALUES (:mid, 'child', 'nonexistent_parent', 'Label', 1, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "fk_epub_toc_nodes_parent" in str(exc_info.value)

            # Valid insert with fragment_idx=0 (references existing fragment)
            session.execute(
                text(
                    "INSERT INTO epub_toc_nodes "
                    "(media_id, node_id, label, depth, order_key, fragment_idx) "
                    "VALUES (:mid, 'valid', 'Chapter 1', 0, '0001', 0)"
                ),
                {"mid": media_id},
            )
            session.commit()

            # Verify the row was inserted
            count = session.execute(
                text(
                    "SELECT COUNT(*) FROM epub_toc_nodes "
                    "WHERE media_id = :mid AND node_id = 'valid'"
                ),
                {"mid": media_id},
            ).scalar()
            assert count == 1

    def test_0008_order_key_format_constraint(self, s5_engine):
        """ck_epub_toc_nodes_order_key_format accepts valid and rejects invalid keys."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            valid_keys = ["0001", "0001.0002", "0010.0001.0003"]
            for i, key in enumerate(valid_keys):
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, :nid, 'Label', 0, :key)"
                    ),
                    {"mid": media_id, "nid": f"valid_{i}", "key": key},
                )
            session.commit()

            invalid_keys = ["1", "0001.2", "0001.000A", ".0001", "0001."]
            for i, key in enumerate(invalid_keys):
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text(
                            "INSERT INTO epub_toc_nodes "
                            "(media_id, node_id, label, depth, order_key) "
                            "VALUES (:mid, :nid, 'Label', 0, :key)"
                        ),
                        {"mid": media_id, "nid": f"invalid_{i}", "key": key},
                    )
                    session.commit()
                session.rollback()
                assert "ck_epub_toc_nodes_order_key_format" in str(exc_info.value)

    def test_0008_unique_media_nav_order_key_enforced(self, s5_engine):
        """uix_epub_toc_nodes_media_nav_order rejects duplicate order_key per nav type."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

        with Session(s5_engine) as session:
            _, media_id, _ = self._create_epub_fixtures(session)

            session.execute(
                text(
                    "INSERT INTO epub_toc_nodes "
                    "(media_id, node_id, label, depth, order_key) "
                    "VALUES (:mid, 'a', 'First', 0, '0001')"
                ),
                {"mid": media_id},
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        "INSERT INTO epub_toc_nodes "
                        "(media_id, node_id, label, depth, order_key) "
                        "VALUES (:mid, 'b', 'Second', 0, '0001')"
                    ),
                    {"mid": media_id},
                )
                session.commit()
            session.rollback()
            assert "uix_epub_toc_nodes_media_nav_order" in str(exc_info.value)


class TestS3SchemaConstraints:
    """Tests for S3-specific schema constraints (chat, conversations, messages, etc.)."""

    def test_conversation_sharing_constraint(self, migrated_engine):
        """CHECK constraint prevents invalid sharing values."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, sharing)
                        VALUES (:id, :user_id, 'invalid_sharing')
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_sharing" in str(exc_info.value)

    def test_conversation_next_seq_positive_constraint(self, migrated_engine):
        """CHECK constraint prevents next_seq < 1."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :user_id, 'private', 0)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_next_seq_positive" in str(exc_info.value)

    def test_conversation_title_not_blank_constraint(self, migrated_engine):
        """CHECK constraint prevents blank conversation titles."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, title, sharing, next_seq)
                        VALUES (:id, :user_id, '   ', 'private', 1)
                    """),
                    {"id": uuid4(), "user_id": user_id},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_title_not_blank" in str(exc_info.value)

    def test_conversation_title_max_length_constraint(self, migrated_engine):
        """CHECK constraint enforces bounded conversation titles."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO conversations (id, owner_user_id, title, sharing, next_seq)
                        VALUES (:id, :user_id, :title, 'private', 1)
                    """),
                    {"id": uuid4(), "user_id": user_id, "title": "x" * 121},
                )
                session.commit()

            session.rollback()
            assert "ck_conversations_title_max_length" in str(exc_info.value)

    def test_message_pending_only_assistant_constraint(self, migrated_engine):
        """CHECK constraint: pending status only valid for assistant role."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 1)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            # User message with pending status should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conv_id, 1, 'user', 'test', 'pending')
                    """),
                    {"id": uuid4(), "conv_id": conversation_id},
                )
                session.commit()

            session.rollback()
            assert "ck_messages_pending_only_assistant" in str(exc_info.value)

    def test_message_pending_assistant_allowed(self, migrated_engine):
        """Assistant message with pending status is allowed."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 2)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            user_message_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'test', 'complete')
                """),
                {"id": user_message_id, "conv_id": conversation_id},
            )

            # Assistant message with pending status should succeed when parented to a user.
            session.execute(
                text("""
                    INSERT INTO messages (
                        id, conversation_id, seq, role, content, status, parent_message_id
                    )
                    VALUES (:id, :conv_id, 2, 'assistant', '', 'pending', :parent_message_id)
                """),
                {"id": uuid4(), "conv_id": conversation_id, "parent_message_id": user_message_id},
            )
            session.commit()

    def test_message_conversation_seq_unique(self, migrated_engine):
        """UNIQUE constraint on (conversation_id, seq)."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 3)
                """),
                {"id": conversation_id, "user_id": user_id},
            )

            # First message with seq=1
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'first', 'complete')
                """),
                {"id": uuid4(), "conv_id": conversation_id},
            )
            session.commit()

            # Duplicate seq should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conv_id, 1, 'user', 'duplicate', 'complete')
                    """),
                    {"id": uuid4(), "conv_id": conversation_id},
                )
                session.commit()

            session.rollback()
            assert "uix_messages_conversation_seq" in str(exc_info.value)

    def test_message_context_items_removed_at_head(self, migrated_engine):
        """Conversation references replaced per-message context-item storage at HEAD."""
        with Session(migrated_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = 'message_context_items'
                    """
                )
            ).fetchall()

        assert rows == []

    def test_user_api_key_nonce_length_constraint(self, migrated_engine):
        """CHECK constraint: nonce must be exactly 24 bytes."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            # Nonce with wrong length should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                        VALUES (:id, :user_id, 'openai', :key, :nonce, 'xxxx')
                    """),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "key": b"encrypted_key_data",
                        "nonce": b"too_short",  # Not 24 bytes
                    },
                )
                session.commit()

            session.rollback()
            assert "ck_user_api_keys_nonce_len" in str(exc_info.value)

    def test_user_api_key_user_provider_unique(self, migrated_engine):
        """UNIQUE constraint: one key per provider per user."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})

            valid_nonce = b"x" * 24  # 24 bytes

            # First key
            session.execute(
                text("""
                    INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                    VALUES (:id, :user_id, 'openai', :key, :nonce, 'xxxx')
                """),
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted_key_1",
                    "nonce": valid_nonce,
                },
            )
            session.commit()

            # Duplicate key for same provider should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO user_api_keys (id, user_id, provider, encrypted_key, key_nonce, key_fingerprint)
                        VALUES (:id, :user_id, 'openai', :key, :nonce, 'yyyy')
                    """),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "key": b"encrypted_key_2",
                        "nonce": valid_nonce,
                    },
                )
                session.commit()

            session.rollback()
            assert "uix_user_api_keys_user_provider" in str(exc_info.value)

    def test_chat_run_idempotency_key_length_constraint(self, migrated_engine):
        """CHECK constraint: chat run idempotency key length between 1 and 128."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            conversation_id = uuid4()
            msg1_id = uuid4()
            msg2_id = uuid4()
            model_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
                    VALUES (:id, 'openai', :model_name, 4096, true)
                """),
                {"id": model_id, "model_name": f"migration-test-{model_id}"},
            )
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :user_id, 'private', 3)
                """),
                {"id": conversation_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conv_id, 1, 'user', 'test', 'complete')
                """),
                {"id": msg1_id, "conv_id": conversation_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (
                        id, conversation_id, seq, role, content, status, parent_message_id
                    )
                    VALUES (:id, :conv_id, 2, 'assistant', 'response', 'complete', :parent_message_id)
                """),
                {"id": msg2_id, "conv_id": conversation_id, "parent_message_id": msg1_id},
            )
            session.commit()

            # Key too long should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO chat_runs (
                            owner_user_id,
                            conversation_id,
                            user_message_id,
                            assistant_message_id,
                            idempotency_key,
                            payload_hash,
                            status,
                            model_id,
                            reasoning,
                            key_mode
                        )
                        VALUES (
                            :user_id,
                            :conversation_id,
                            :msg1,
                            :msg2,
                            :key,
                            'hash',
                            'queued',
                            :model_id,
                            'none',
                            'auto'
                        )
                    """),
                    {
                        "user_id": user_id,
                        "conversation_id": conversation_id,
                        "key": "x" * 129,  # Too long
                        "msg1": msg1_id,
                        "msg2": msg2_id,
                        "model_id": model_id,
                    },
                )
                session.commit()

            session.rollback()
            assert "ck_chat_runs_idempotency_key_length" in str(exc_info.value)

    def test_chat_branching_foreign_keys_are_not_cascading(self, migrated_engine):
        """Branch-path ownership cleanup is explicit in services, not FK cascades."""
        with Session(migrated_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT
                        kcu.table_name,
                        kcu.column_name,
                        rc.delete_rule
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON kcu.constraint_catalog = tc.constraint_catalog
                     AND kcu.constraint_schema = tc.constraint_schema
                     AND kcu.constraint_name = tc.constraint_name
                    JOIN information_schema.referential_constraints rc
                      ON rc.constraint_catalog = tc.constraint_catalog
                     AND rc.constraint_schema = tc.constraint_schema
                     AND rc.constraint_name = tc.constraint_name
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                      AND kcu.table_name IN (
                          'messages',
                          'conversation_active_paths',
                          'conversation_branches'
                      )
                      AND kcu.column_name IN (
                          'parent_message_id',
                          'branch_root_message_id',
                          'conversation_id',
                          'viewer_user_id',
                          'active_leaf_message_id',
                          'branch_user_message_id'
                      )
                    ORDER BY kcu.table_name, kcu.column_name
                    """
                )
            ).fetchall()

        delete_rules = {(row[0], row[1]): row[2] for row in rows}
        expected_columns = {
            ("messages", "parent_message_id"),
            ("messages", "branch_root_message_id"),
            ("conversation_active_paths", "conversation_id"),
            ("conversation_active_paths", "viewer_user_id"),
            ("conversation_active_paths", "active_leaf_message_id"),
            ("conversation_branches", "conversation_id"),
            ("conversation_branches", "branch_user_message_id"),
        }
        assert expected_columns.issubset(delete_rules), (
            f"Missing branch FK assertions. Got: {delete_rules}"
        )
        assert {delete_rules[column] for column in expected_columns} == {"NO ACTION"}, (
            f"Branching FKs must be non-cascading; got {delete_rules}"
        )

    def test_chat_retrieval_foreign_keys_are_not_cascading(self, migrated_engine):
        """Chat retrieval cleanup is explicit in services, not FK cascades."""
        expected_constraints = {
            "message_tool_calls_conversation_id_fkey",
            "message_tool_calls_user_message_id_fkey",
            "message_tool_calls_assistant_message_id_fkey",
            "message_retrievals_tool_call_id_fkey",
            "message_retrievals_media_id_fkey",
            "chat_runs_owner_user_id_fkey",
            "chat_runs_conversation_id_fkey",
            "chat_runs_user_message_id_fkey",
            "chat_runs_assistant_message_id_fkey",
            "chat_prompt_assemblies_chat_run_id_fkey",
            "chat_prompt_assemblies_conversation_id_fkey",
            "chat_prompt_assemblies_assistant_message_id_fkey",
            "chat_run_events_run_id_fkey",
        }
        with Session(migrated_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT constraint_name, delete_rule
                    FROM information_schema.referential_constraints
                    WHERE constraint_name = ANY(:constraint_names)
                    """
                ),
                {"constraint_names": list(expected_constraints)},
            ).fetchall()

        delete_rules = {row[0]: row[1] for row in rows}
        assert expected_constraints == set(delete_rules), delete_rules
        assert set(delete_rules.values()) == {"NO ACTION"}, delete_rules

    def test_verifier_and_citation_audit_tables_are_removed_at_head(self, migrated_engine):
        """The verifier/citation-audit stack was removed by the hard cutover."""
        removed_tables = {
            "assistant_message_claim_evidence",
            "assistant_message_citation_audits",
            "assistant_message_claims",
            "assistant_message_evidence_summaries",
            "assistant_message_verifier_runs",
        }
        with Session(migrated_engine) as session:
            tables = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_name = ANY(:table_names)
                        """
                    ),
                    {"table_names": list(removed_tables)},
                ).fetchall()
            }

        assert tables == set()

    def test_fragment_block_offsets_constraint(self, migrated_engine):
        """CHECK constraint: end_offset >= start_offset."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            fragment_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'ready_for_reading', :user_id)
                """),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Test', '<p>Test</p>')
                """),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

            # end < start should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO fragment_blocks (id, fragment_id, block_idx, start_offset, end_offset)
                        VALUES (:id, :frag_id, 0, 10, 5)
                    """),
                    {"id": uuid4(), "frag_id": fragment_id},
                )
                session.commit()

            session.rollback()
            assert "ck_fragment_blocks_offsets" in str(exc_info.value)

    def test_generated_tsvector_columns_exist(self, migrated_engine):
        """Generated tsvector columns exist and are STORED."""
        with Session(migrated_engine) as session:
            # Check media.title_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'media' AND column_name = 'title_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "media.title_tsv column should exist"
            assert row[0] == "ALWAYS", "title_tsv should be a generated column"

            # Check fragments.canonical_text_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'fragments' AND column_name = 'canonical_text_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "fragments.canonical_text_tsv column should exist"
            assert row[0] == "ALWAYS"

            # Check messages.content_tsv
            result = session.execute(
                text("""
                    SELECT is_generated FROM information_schema.columns
                    WHERE table_name = 'messages' AND column_name = 'content_tsv'
                """)
            )
            row = result.fetchone()
            assert row is not None, "messages.content_tsv column should exist"
            assert row[0] == "ALWAYS"

    def test_gin_indexes_exist(self, migrated_engine):
        """GIN indexes exist for tsvector columns."""
        with Session(migrated_engine) as session:
            # Check for GIN indexes
            result = session.execute(
                text("""
                    SELECT indexname, indexdef FROM pg_indexes
                    WHERE tablename IN ('media', 'fragments', 'note_blocks', 'messages')
                    AND indexdef LIKE '%gin%'
                """)
            )
            rows = result.fetchall()
            index_names = [row[0] for row in rows]

            assert "idx_media_title_tsv" in index_names
            assert "idx_fragments_canonical_text_tsv" in index_names
            assert "ix_note_blocks_body_text_tsv" in index_names
            assert "idx_messages_content_tsv" in index_names

    def test_models_provider_model_name_unique(self, migrated_engine):
        """UNIQUE constraint on (provider, model_name)."""
        with Session(migrated_engine) as session:
            # First model
            session.execute(
                text("""
                    INSERT INTO models (id, provider, model_name, max_context_tokens)
                    VALUES (:id, 'openai', 'gpt-4', 8192)
                """),
                {"id": uuid4()},
            )
            session.commit()

            # Duplicate should fail
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text("""
                        INSERT INTO models (id, provider, model_name, max_context_tokens)
                        VALUES (:id, 'openai', 'gpt-4', 8192)
                    """),
                    {"id": uuid4()},
                )
                session.commit()

            session.rollback()
            assert "uix_models_provider_model_name" in str(exc_info.value)


# =============================================================================
# Typed-Highlight Data Foundation (migration 0009)
# =============================================================================


class TestS6PR01Migration0009:
    """Tests for migration 0009 typed-highlight data foundation.

    Each test self-manages migration state (reset schema -> upgrade target).
    """

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        """Start and end each test at a clean base state, restore to head."""
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def s6_engine(self):
        """Provide a dedicated engine for migration 0009 tests."""
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def _upgrade_to_0009(self):
        result = run_alembic_command("upgrade 0009")
        assert result.returncode == 0, f"upgrade failed: {result.stderr}"

    def _create_base_fixtures(self, session):
        """Insert user + web_article media + fragment, return ids."""
        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.execute(
            text(
                "INSERT INTO media (id, kind, title, processing_status, "
                "created_by_user_id) VALUES (:id, 'web_article', 'Test', "
                "'ready_for_reading', :uid)"
            ),
            {"id": media_id, "uid": user_id},
        )
        session.execute(
            text(
                "INSERT INTO fragments (id, media_id, idx, canonical_text, "
                "html_sanitized) VALUES (:id, :mid, 0, 'Hello world test', "
                "'<p>Hello world test</p>')"
            ),
            {"id": fragment_id, "mid": media_id},
        )
        session.commit()
        return user_id, media_id, fragment_id

    def test_pr01_adds_s6_typed_highlight_foundation_tables_and_columns(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            # New tables exist
            for tbl in (
                "highlight_fragment_anchors",
                "highlight_pdf_anchors",
                "highlight_pdf_quads",
                "pdf_page_text_spans",
            ):
                row = session.execute(
                    text("SELECT 1 FROM information_schema.tables WHERE table_name = :t"),
                    {"t": tbl},
                ).fetchone()
                assert row is not None, f"table {tbl} must exist"

            # New columns on media
            for col in ("plain_text", "page_count"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'media' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None, f"media.{col} must exist"
                assert row[0] == "YES", f"media.{col} must be nullable"

            # New columns on highlights
            for col in ("anchor_kind", "anchor_media_id"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'highlights' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None, f"highlights.{col} must exist"
                assert row[0] == "YES", f"highlights.{col} must be nullable"

            # Fragment columns are now nullable
            for col in ("fragment_id", "start_offset", "end_offset"):
                row = session.execute(
                    text(
                        "SELECT is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'highlights' AND column_name = :c"
                    ),
                    {"c": col},
                ).fetchone()
                assert row is not None
                assert row[0] == "YES", f"highlights.{col} must be nullable"

            # Check constraints exist on highlights
            constraints = session.execute(
                text(
                    "SELECT conname FROM pg_constraint "
                    "WHERE conrelid = 'highlights'::regclass "
                    "AND contype = 'c'"
                )
            ).fetchall()
            cnames = {r[0] for r in constraints}
            assert "ck_highlights_fragment_bridge" in cnames
            assert "ck_highlights_anchor_fields_paired_null" in cnames
            assert "ck_highlights_anchor_kind_valid" in cnames
            assert "ck_highlights_color" in cnames

            # Supporting PDF indexes exist
            indexes = session.execute(
                text("SELECT indexname FROM pg_indexes WHERE tablename = 'highlight_pdf_anchors'")
            ).fetchall()
            inames = {r[0] for r in indexes}
            assert "ix_hpa_media_page_sort" in inames
            assert "ix_hpa_geometry_lookup" in inames

    def test_pr01_media_page_count_domain_check(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            user_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.commit()

            # NULL is OK
            mid1 = uuid4()
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'A', 'pending', NULL, :uid)"
                ),
                {"id": mid1, "uid": user_id},
            )
            session.commit()

            # page_count = 1 is OK
            mid2 = uuid4()
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'B', 'pending', 1, :uid)"
                ),
                {"id": mid2, "uid": user_id},
            )
            session.commit()

            # page_count = 0 rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status, "
                        "page_count, created_by_user_id) VALUES "
                        "(:id, 'pdf', 'C', 'pending', 0, :uid)"
                    ),
                    {"id": uuid4(), "uid": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_media_page_count_positive" in str(exc.value)

            # page_count = -1 rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status, "
                        "page_count, created_by_user_id) VALUES "
                        "(:id, 'pdf', 'D', 'pending', -1, :uid)"
                    ),
                    {"id": uuid4(), "uid": user_id},
                )
                session.commit()
            session.rollback()
            assert "ck_media_page_count_positive" in str(exc.value)

    def test_pr01_preserves_legacy_fragment_highlight_constraints_after_migration(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Valid legacy insert succeeds
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            # Invalid color rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 3, 'red', 'Hel', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_color" in str(exc.value)

            # Invalid offsets (end <= start) rejected by bridge check
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 5, 5, 'green', 'x', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_fragment_bridge" in str(exc.value)

            # Duplicate span rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 5, 'blue', 'Hello', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "uix_highlights_user_fragment_offsets" in str(exc.value)

    def test_pr01_new_anchor_subtype_cascade_and_uniqueness_constraints(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Create a logical highlight with fragment bridge + subtype row
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                    "'fragment_offsets', :mid)"
                ),
                {"id": h_id, "uid": uid, "fid": fid, "mid": mid},
            )
            session.execute(
                text(
                    "INSERT INTO highlight_fragment_anchors "
                    "(highlight_id, fragment_id, start_offset, end_offset) "
                    "VALUES (:hid, :fid, 0, 5)"
                ),
                {"hid": h_id, "fid": fid},
            )
            session.commit()

            # Duplicate 1:1 subtype row rejected (PK violation)
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_fragment_anchors "
                        "(highlight_id, fragment_id, start_offset, end_offset) "
                        "VALUES (:hid, :fid, 0, 5)"
                    ),
                    {"hid": h_id, "fid": fid},
                )
                session.commit()
            session.rollback()

            # FK violation: non-existent highlight_id
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_fragment_anchors "
                        "(highlight_id, fragment_id, start_offset, end_offset) "
                        "VALUES (:hid, :fid, 0, 3)"
                    ),
                    {"hid": uuid4(), "fid": fid},
                )
                session.commit()
            session.rollback()

            # Delete core highlight -> cascade to subtype
            session.execute(text("DELETE FROM highlights WHERE id = :id"), {"id": h_id})
            session.commit()
            row = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert row is None, "cascade must delete subtype row"

    def test_pr01_greenfield_defaults_allow_dormant_schema_without_backfill(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # Legacy insert works without setting new fields
            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            # anchor_kind and anchor_media_id default to NULL
            row = session.execute(
                text("SELECT anchor_kind, anchor_media_id FROM highlights WHERE id = :id"),
                {"id": h_id},
            ).fetchone()
            assert row[0] is None
            assert row[1] is None

            # No fragment subtype row exists (no dual-write)
            sub = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert sub is None

    def test_pr01_rejects_partial_dormant_logical_anchor_fields_on_highlights(self, s6_engine):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # anchor_kind without anchor_media_id -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_kind) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                        "'fragment_offsets')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_fields_paired_null" in str(exc.value)

            # anchor_media_id without anchor_kind -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_media_id) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_fields_paired_null" in str(exc.value)

            # Invalid anchor_kind value -> rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix, "
                        "anchor_kind, anchor_media_id) VALUES "
                        "(:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '', "
                        "'invalid_kind', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_highlights_anchor_kind_valid" in str(exc.value)

    def test_pr01_does_not_require_fragment_subtype_dual_write_during_dormant_window(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": h_id, "uid": uid, "fid": fid},
            )
            session.commit()

            row = session.execute(
                text("SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            ).fetchone()
            assert row is None, "Legacy insert must succeed without fragment subtype row"

    def test_pr01_allows_future_non_fragment_logical_rows_to_leave_legacy_fragment_columns_null(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            row = session.execute(
                text("SELECT fragment_id, start_offset, end_offset FROM highlights WHERE id = :id"),
                {"id": h_id},
            ).fetchone()
            assert row[0] is None
            assert row[1] is None
            assert row[2] is None

    def test_pr01_retained_fragment_unique_index_preserves_duplicate_semantics_under_nullable_bridge(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, fid = self._create_base_fixtures(session)

            # First fragment highlight
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, fragment_id, "
                    "start_offset, end_offset, color, exact, prefix, suffix) "
                    "VALUES (:id, :uid, :fid, 0, 5, 'yellow', 'Hello', '', '')"
                ),
                {"id": uuid4(), "uid": uid, "fid": fid},
            )
            session.commit()

            # Duplicate rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, fragment_id, "
                        "start_offset, end_offset, color, exact, prefix, suffix) "
                        "VALUES (:id, :uid, :fid, 0, 5, 'blue', 'Hello', '', '')"
                    ),
                    {"id": uuid4(), "uid": uid, "fid": fid},
                )
                session.commit()
            session.rollback()
            assert "uix_highlights_user_fragment_offsets" in str(exc.value)

            # Multiple non-fragment rows with NULL fragment columns don't conflict
            for _ in range(3):
                session.execute(
                    text(
                        "INSERT INTO highlights (id, user_id, "
                        "fragment_id, start_offset, end_offset, "
                        "color, exact, prefix, suffix, "
                        "anchor_kind, anchor_media_id) VALUES "
                        "(:id, :uid, NULL, NULL, NULL, "
                        "'yellow', '', '', '', "
                        "'pdf_page_geometry', :mid)"
                    ),
                    {"id": uuid4(), "uid": uid, "mid": mid},
                )
            session.commit()

    def test_pr01_pdf_anchor_supporting_indexes_exist_without_exact_duplicate_uniqueness(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            indexes = session.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE tablename = 'highlight_pdf_anchors'"
                )
            ).fetchall()
            idx_map = {r[0]: r[1] for r in indexes}
            assert "ix_hpa_media_page_sort" in idx_map
            assert "ix_hpa_geometry_lookup" in idx_map
            # Neither is UNIQUE
            for name in ("ix_hpa_media_page_sort", "ix_hpa_geometry_lookup"):
                assert "UNIQUE" not in idx_map[name].upper(), f"{name} must not be unique in pr-01"

    def test_pr01_pdf_page_text_spans_enforces_row_local_validity_but_not_contiguity_lifecycle_rules(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid = uuid4()
            mid = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": uid})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status, "
                    "page_count, created_by_user_id) VALUES "
                    "(:id, 'pdf', 'Test PDF', 'extracting', 5, :uid)"
                ),
                {"id": mid, "uid": uid},
            )
            session.commit()

            # Valid row
            session.execute(
                text(
                    "INSERT INTO pdf_page_text_spans "
                    "(media_id, page_number, start_offset, end_offset, "
                    "text_extract_version) VALUES (:mid, 1, 0, 100, 1)"
                ),
                {"mid": mid},
            )
            session.commit()

            # Duplicate page rejected (PK)
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 1, 0, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()

            # Invalid page_number = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 0, 0, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_page_number" in str(exc.value)

            # Negative start_offset
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 2, -1, 50, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_start_offset" in str(exc.value)

            # end < start
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO pdf_page_text_spans "
                        "(media_id, page_number, start_offset, end_offset, "
                        "text_extract_version) VALUES (:mid, 2, 50, 10, 1)"
                    ),
                    {"mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_ppts_offsets_valid" in str(exc.value)

            # Non-contiguous pages are row-valid (contiguity is pr-03 concern)
            session.execute(
                text(
                    "INSERT INTO pdf_page_text_spans "
                    "(media_id, page_number, start_offset, end_offset, "
                    "text_extract_version) VALUES (:mid, 4, 500, 600, 1)"
                ),
                {"mid": mid},
            )
            session.commit()

    def test_pr01_highlight_pdf_quads_enforces_row_shape_without_canonicalization_semantics(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            # Valid quad
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_quads "
                    "(highlight_id, quad_idx, x1, y1, x2, y2, "
                    "x3, y3, x4, y4) VALUES "
                    "(:hid, 0, 10, 20, 30, 20, 30, 40, 10, 40)"
                ),
                {"hid": h_id},
            )
            session.commit()

            # Duplicate (highlight_id, quad_idx) rejected
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_quads "
                        "(highlight_id, quad_idx, x1, y1, x2, y2, "
                        "x3, y3, x4, y4) VALUES "
                        "(:hid, 0, 1, 2, 3, 4, 5, 6, 7, 8)"
                    ),
                    {"hid": h_id},
                )
                session.commit()
            session.rollback()

            # Negative quad_idx rejected
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_quads "
                        "(highlight_id, quad_idx, x1, y1, x2, y2, "
                        "x3, y3, x4, y4) VALUES "
                        "(:hid, -1, 1, 2, 3, 4, 5, 6, 7, 8)"
                    ),
                    {"hid": h_id},
                )
                session.commit()
            session.rollback()
            assert "ck_hpq_quad_idx" in str(exc.value)

            # Row-valid but not canonically ordered is accepted in pr-01
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_quads "
                    "(highlight_id, quad_idx, x1, y1, x2, y2, "
                    "x3, y3, x4, y4) VALUES "
                    "(:hid, 5, 99, 99, 1, 1, 50, 50, 0, 0)"
                ),
                {"hid": h_id},
            )
            session.commit()

    def test_pr01_highlight_pdf_anchors_enforces_row_local_shape_domains_without_semantic_coherence_rules(
        self, s6_engine
    ):
        self._upgrade_to_0009()
        with Session(s6_engine) as session:
            uid, mid, _ = self._create_base_fixtures(session)

            h_id = uuid4()
            session.execute(
                text(
                    "INSERT INTO highlights (id, user_id, "
                    "fragment_id, start_offset, end_offset, "
                    "color, exact, prefix, suffix, "
                    "anchor_kind, anchor_media_id) VALUES "
                    "(:id, :uid, NULL, NULL, NULL, "
                    "'yellow', '', '', '', "
                    "'pdf_page_geometry', :mid)"
                ),
                {"id": h_id, "uid": uid, "mid": mid},
            )
            session.commit()

            # Valid row
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_anchors "
                    "(highlight_id, media_id, page_number, geometry_version, "
                    "geometry_fingerprint, sort_top, sort_left, "
                    "plain_text_match_status, rect_count) VALUES "
                    "(:hid, :mid, 1, 1, 'abc123', 10.5, 20.0, 'pending', 1)"
                ),
                {"hid": h_id, "mid": mid},
            )
            session.commit()
            session.execute(
                text("DELETE FROM highlight_pdf_anchors WHERE highlight_id = :hid"),
                {"hid": h_id},
            )
            session.commit()

            # Invalid page_number = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 0, 1, 'x', 0, 0, 'pending', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_page_number" in str(exc.value)

            # Invalid rect_count = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'pending', 0)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_rect_count" in str(exc.value)

            # Invalid geometry_version = 0
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 0, 'x', 0, 0, 'pending', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_geometry_version" in str(exc.value)

            # Invalid match_status
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'bogus', 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_status" in str(exc.value)

            # Negative match offset
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "plain_text_start_offset, plain_text_end_offset, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'unique', -1, 5, 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_offsets_non_negative" in str(exc.value)

            # One-sided offset null
            with pytest.raises(IntegrityError) as exc:
                session.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id, media_id, page_number, "
                        "geometry_version, geometry_fingerprint, "
                        "sort_top, sort_left, plain_text_match_status, "
                        "plain_text_start_offset, plain_text_end_offset, "
                        "rect_count) VALUES "
                        "(:hid, :mid, 1, 1, 'x', 0, 0, 'unique', 5, NULL, 1)"
                    ),
                    {"hid": h_id, "mid": mid},
                )
                session.commit()
            session.rollback()
            assert "ck_hpa_match_offsets_paired_null" in str(exc.value)

            # Semantically unresolved but row-valid (pr-03+)
            session.execute(
                text(
                    "INSERT INTO highlight_pdf_anchors "
                    "(highlight_id, media_id, page_number, "
                    "geometry_version, geometry_fingerprint, "
                    "sort_top, sort_left, plain_text_match_status, "
                    "plain_text_match_version, "
                    "plain_text_start_offset, plain_text_end_offset, "
                    "rect_count) VALUES "
                    "(:hid, :mid, 1, 1, 'abc', 0, 0, 'unique', 1, 0, 50, 2)"
                ),
                {"hid": h_id, "mid": mid},
            )
            session.commit()


class TestHighlightBridgeRemovalMigration0056:
    """Data migration coverage for the highlight bridge-column hard cutover."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()

    def test_upgrade_0055_to_head_backfills_fragment_anchors_and_drops_bridge_columns(
        self, migration_engine
    ):
        result = run_alembic_command("upgrade 0055")
        assert result.returncode == 0, f"upgrade 0055 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()
        highlight_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Legacy highlight media', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'legacy fragment text', '<p>legacy fragment text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO highlights (
                        id,
                        user_id,
                        fragment_id,
                        start_offset,
                        end_offset,
                        color,
                        exact,
                        prefix,
                        suffix
                    )
                    VALUES (
                        :id,
                        :user_id,
                        :fragment_id,
                        0,
                        6,
                        'yellow',
                        'legacy',
                        '',
                        ''
                    )
                    """
                ),
                {
                    "id": highlight_id,
                    "user_id": user_id,
                    "fragment_id": fragment_id,
                },
            )
            session.commit()

        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        with Session(migration_engine) as session:
            for column_name in ("fragment_id", "start_offset", "end_offset"):
                row = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'highlights'
                          AND column_name = :column_name
                        """
                    ),
                    {"column_name": column_name},
                ).fetchone()
                assert row is None, f"highlights.{column_name} must be removed at head"

            row = session.execute(
                text(
                    """
                    SELECT anchor_kind, anchor_media_id
                    FROM highlights
                    WHERE id = :id
                    """
                ),
                {"id": highlight_id},
            ).fetchone()
            assert row is not None
            assert row[0] == "fragment_offsets"
            assert str(row[1]) == str(media_id)

            anchor_row = session.execute(
                text(
                    """
                    SELECT fragment_id, start_offset, end_offset
                    FROM highlight_fragment_anchors
                    WHERE highlight_id = :id
                    """
                ),
                {"id": highlight_id},
            ).fetchone()
            assert anchor_row is not None
            assert str(anchor_row[0]) == str(fragment_id)
            assert anchor_row[1] == 0
            assert anchor_row[2] == 6

    def test_downgrade_head_to_0055_is_blocked_by_hard_cutover(self):
        """Hard-cutover migrations make any downgrade from head fail. The
        per-migration error message varies (e.g. ``"Hard cutover: 0115 is not
        reversible"``); assert the consistent ``NotImplementedError`` marker
        rather than the legacy phrase."""
        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        result = run_alembic_command("downgrade 0055")
        assert result.returncode != 0
        combined = (result.stdout or "") + (result.stderr or "")
        assert (
            "NotImplementedError" in combined
            or "hard cutover migration and has no downgrade path" in combined
            or "Hard cutover" in combined
        ), (
            f"Expected downgrade to surface NotImplementedError or 'Hard cutover' marker; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )


class TestMigration0026SemanticChunkBackfill:
    """Regression tests for semantic chunk backfill over legacy transcripts."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        database_url = get_test_database_url()
        engine = create_engine(database_url)
        yield engine
        engine.dispose()

    def test_upgrade_backfills_semantic_chunks_for_pre_0024_transcripts(self, migration_engine):
        result = run_alembic_command("upgrade 0023")
        assert result.returncode == 0, f"upgrade 0023 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_1 = uuid4()
        fragment_2 = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:media_id, 'podcast_episode', 'legacy transcript', 'ready_for_reading', :user_id)
                    """
                ),
                {"media_id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text,
                        t_start_ms,
                        t_end_ms,
                        speaker_label
                    )
                    VALUES (
                        :id,
                        :media_id,
                        :idx,
                        :html_sanitized,
                        :canonical_text,
                        :t_start_ms,
                        :t_end_ms,
                        :speaker_label
                    )
                    """
                ),
                {
                    "id": fragment_1,
                    "media_id": media_id,
                    "idx": 0,
                    "html_sanitized": "<p>first legacy segment</p>",
                    "canonical_text": "first legacy segment",
                    "t_start_ms": 0,
                    "t_end_ms": 1000,
                    "speaker_label": "Host",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text,
                        t_start_ms,
                        t_end_ms,
                        speaker_label
                    )
                    VALUES (
                        :id,
                        :media_id,
                        :idx,
                        :html_sanitized,
                        :canonical_text,
                        :t_start_ms,
                        :t_end_ms,
                        :speaker_label
                    )
                    """
                ),
                {
                    "id": fragment_2,
                    "media_id": media_id,
                    "idx": 1,
                    "html_sanitized": "<p>second legacy segment</p>",
                    "canonical_text": "second legacy segment",
                    "t_start_ms": 1200,
                    "t_end_ms": 2200,
                    "speaker_label": "Guest",
                },
            )
            session.commit()

        result = run_alembic_command("upgrade head")
        assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

        with Session(migration_engine) as session:
            state_row = session.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage, semantic_status
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            version_table = session.execute(
                text(
                    """
                    SELECT to_regclass('public.podcast_transcript_versions')
                    """
                ),
            ).scalar()
            segment_count = session.execute(
                text("SELECT COUNT(*) FROM podcast_transcript_segments WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar()
            chunk_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM content_chunks
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                      AND source_kind = 'transcript'
                    """
                ),
                {"media_id": media_id},
            ).scalar()
            ready_index_count = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM content_index_states
                    WHERE owner_kind = 'media' AND owner_id = :media_id
                      AND status = 'ready'
                    """
                ),
                {"media_id": media_id},
            ).scalar()

        assert state_row is not None
        assert state_row[0] == "ready"
        assert state_row[1] == "full"
        assert state_row[2] == "pending", (
            "legacy transcript rows backfilled before pgvector cutover must be marked pending "
            "until re-indexed with production semantic embeddings"
        )
        assert version_table is None
        assert segment_count == 2
        assert chunk_count == 0, (
            "the evidence hard cutover must not preserve stale pre-cutover transcript chunks"
        )
        assert ready_index_count == 0, (
            "legacy transcript media must not be marked retrieval-ready until rebuilt "
            "through the shared evidence indexer"
        )


class TestPodcastListeningStateMigration:
    """Schema assertions for podcast listening-state persistence table."""

    def test_head_contains_podcast_listening_state_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_listening_states'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            pk_columns = session.execute(
                text(
                    """
                    SELECT a.attname
                    FROM pg_index i
                    JOIN pg_class c ON c.oid = i.indrelid
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
                    WHERE c.relname = 'podcast_listening_states'
                      AND i.indisprimary
                    ORDER BY a.attname
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_listening_states'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'podcast_listening_states'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            is_completed_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_listening_states'
                      AND column_name = 'is_completed'
                    """
                )
            ).fetchone()

        column_names = {row[0] for row in columns}
        assert {
            "user_id",
            "media_id",
            "position_ms",
            "duration_ms",
            "playback_speed",
            "is_completed",
            "updated_at",
        }.issubset(column_names), f"Unexpected podcast_listening_states columns: {column_names}"

        assert [row[0] for row in pk_columns] == ["media_id", "user_id"], (
            f"Expected composite PK over (user_id, media_id), got {[row[0] for row in pk_columns]}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_podcast_listening_states_position_ms_non_negative" in constraint_names
        assert "ck_podcast_listening_states_playback_speed_positive" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_podcast_listening_states_media_id" in index_names

        assert is_completed_column is not None, (
            "podcast_listening_states.is_completed must exist for played/unplayed state derivation"
        )
        assert is_completed_column[1] == "boolean", (
            f"Expected is_completed boolean type, got {is_completed_column[1]}"
        )
        assert is_completed_column[2] == "NO", "is_completed must be non-null"


class TestConsumptionQueueMigration:
    """Schema assertions for consumption queue table and subscription auto-queue toggle."""

    def test_head_contains_consumption_queue_table_and_auto_queue_flag(self, migrated_engine):
        with Session(migrated_engine) as session:
            queue_columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'consumption_queue_items'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            queue_constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'consumption_queue_items'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            queue_indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'consumption_queue_items'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            auto_queue_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'auto_queue'
                    """
                )
            ).fetchone()
            default_playback_speed_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'default_playback_speed'
                    """
                )
            ).fetchone()

        queue_column_names = {row[0] for row in queue_columns}
        assert {
            "id",
            "user_id",
            "media_id",
            "position",
            "added_at",
            "source",
        }.issubset(queue_column_names), (
            "consumption queue migration must provide durable ordered queue schema; "
            f"got columns {queue_column_names}"
        )

        queue_constraint_names = {row[0] for row in queue_constraints}
        assert "uq_consumption_queue_items_user_media" in queue_constraint_names
        assert "ck_consumption_queue_items_position_non_negative" in queue_constraint_names
        # The source vocabulary CHECK was dropped by 0181 (lectern player
        # lifecycle): persistence adapters own the enum, not the database.
        assert "ck_consumption_queue_items_source" not in queue_constraint_names

        queue_index_names = {row[0] for row in queue_indexes}
        assert "ix_consumption_queue_items_user_position" in queue_index_names

        assert auto_queue_column is not None, (
            "podcast_subscriptions.auto_queue must exist for sync-driven queue opt-in"
        )
        assert auto_queue_column[1] == "boolean", (
            f"Expected auto_queue boolean column, got {auto_queue_column[1]}"
        )
        assert default_playback_speed_column is not None, (
            "podcast_subscriptions.default_playback_speed must exist for per-subscription speed inheritance"
        )
        assert default_playback_speed_column[1] == "double precision", (
            "default_playback_speed should be FLOAT for player-speed precision parity, "
            f"got {default_playback_speed_column[1]}"
        )
        assert default_playback_speed_column[2] == "YES", (
            "default_playback_speed must be nullable so null means inherit global default 1.0x"
        )


class TestLibraryEntriesCutoverMigration:
    """Schema assertions for the mixed library entry hard cutover."""

    def test_head_drops_subscription_categories_and_category_fk(self, migrated_engine):
        with Session(migrated_engine) as session:
            categories_table = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_name = 'podcast_subscription_categories'
                    """
                )
            ).fetchone()
            category_column = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'category_id'
                    """
                )
            ).fetchone()
            unsubscribe_mode_column = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscriptions'
                      AND column_name = 'unsubscribe_mode'
                    """
                )
            ).fetchone()

        assert categories_table is None, "podcast subscription categories must be removed at head"
        assert category_column is None, "podcast_subscriptions.category_id must be removed at head"
        assert unsubscribe_mode_column is None, (
            "podcast_subscriptions.unsubscribe_mode must be removed at head"
        )

    def test_head_contains_library_entries_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            entry_columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'library_entries'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'library_entries'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'library_entries'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            color_column = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'libraries'
                      AND column_name = 'color'
                    """
                )
            ).fetchone()
            legacy_table = session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_name = 'library_media'
                    """
                )
            ).fetchone()

        entry_column_names = {row[0] for row in entry_columns}
        assert {
            "id",
            "library_id",
            "media_id",
            "podcast_id",
            "created_at",
            "position",
        }.issubset(entry_column_names), (
            "library_entries must contain the mixed-entry contract columns"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_library_entries_exactly_one_target" in constraint_names
        assert "ck_library_entries_position_non_negative" in constraint_names
        assert "uq_library_entries_library_media" in constraint_names
        assert "uq_library_entries_library_podcast" in constraint_names
        assert "uq_library_entries_library_position" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_library_entries_library_order" in index_names
        assert "idx_library_entries_media_library" in index_names

        assert color_column is not None, "libraries.color must exist at head"
        assert color_column[1] == "text"
        assert color_column[2] == "YES"
        assert legacy_table is None, "legacy library_media table must be removed at head"

    def test_head_library_entries_fks_are_non_cascading(self, migrated_engine):
        with Session(migrated_engine) as session:
            fks = session.execute(
                text(
                    """
                    SELECT confrelid::regclass::text AS referenced_table, confdeltype
                    FROM pg_constraint
                    WHERE conrelid = 'library_entries'::regclass
                      AND contype = 'f'
                    """
                )
            ).fetchall()

        # 'a' = NO ACTION. Cleanup is explicit in application code (database.md); the
        # media_id/podcast_id CASCADE and the library_id ORM/DDL mismatch from 0047 are
        # gone after 0131. Pin FK identity (referenced table) so a future migration cannot
        # silently swap one non-cascading FK for another and still pass.
        delete_actions = {row[0]: row[1] for row in fks}
        for referenced_table in ("media", "podcasts", "libraries"):
            assert referenced_table in delete_actions, (
                f"library_entries must keep its FK to {referenced_table}: {delete_actions}"
            )
            assert delete_actions[referenced_table] == "a", (
                f"library_entries→{referenced_table} FK must be NO ACTION, "
                f"got {delete_actions[referenced_table]!r}: {delete_actions}"
            )
        assert len(delete_actions) == 3, delete_actions

    def test_head_contains_request_storm_hot_path_indexes(self, migrated_engine):
        with Session(migrated_engine) as session:
            indexes = session.execute(
                text("""
                    SELECT tablename, indexname, indexdef
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND indexname IN (
                        'ix_library_entries_library_order',
                        'ix_workspace_sessions_user_updated',
                        'ix_user_pinned_objects_active_order'
                      )
                """)
            ).fetchall()

        index_defs = {row[1]: row[2] for row in indexes}
        assert set(index_defs) == {
            "ix_library_entries_library_order",
            "ix_workspace_sessions_user_updated",
            "ix_user_pinned_objects_active_order",
        }
        assert (
            'library_id, "position", created_at DESC, id DESC'
            in index_defs["ix_library_entries_library_order"]
        )
        assert (
            "user_id, updated_at DESC, id DESC" in index_defs["ix_workspace_sessions_user_updated"]
        )
        assert "WHERE (deleted_at IS NULL)" in index_defs["ix_user_pinned_objects_active_order"]

    def test_upgrade_0046_to_0047_backfills_media_and_podcast_entries(self):
        reset_test_schema()
        result = run_alembic_command("upgrade 0046")
        assert result.returncode == 0, f"upgrade 0046 failed: {result.stderr}"

        engine = create_engine(get_test_database_url())
        try:
            user_id = uuid4()
            default_library_id = uuid4()
            shared_library_id = uuid4()
            media_id = uuid4()
            podcast_id = uuid4()
            category_id = uuid4()

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'My Library', true)
                    """),
                    {"id": default_library_id, "owner_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO libraries (id, owner_user_id, name, is_default)
                        VALUES (:id, :owner_id, 'Shared', false)
                    """),
                    {"id": shared_library_id, "owner_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'admin')
                    """),
                    {"library_id": default_library_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO memberships (library_id, user_id, role)
                        VALUES (:library_id, :user_id, 'admin')
                    """),
                    {"library_id": shared_library_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO media (id, kind, title, processing_status)
                        VALUES (:id, 'web_article', 'Migrated Article', 'ready_for_reading')
                    """),
                    {"id": media_id},
                )
                session.execute(
                    text("""
                        INSERT INTO library_media (library_id, media_id, position)
                        VALUES (:library_id, :media_id, 3)
                    """),
                    {"library_id": shared_library_id, "media_id": media_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcasts (
                            id, provider, provider_podcast_id, title, feed_url
                        ) VALUES (
                            :id, 'podcast_index', 'migrated-podcast', 'Migrated Podcast', 'https://example.com/feed.xml'
                        )
                    """),
                    {"id": podcast_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcast_subscription_categories (
                            id, user_id, name, position, color
                        ) VALUES (
                            :id, :user_id, 'Sports', 0, '#123456'
                        )
                    """),
                    {"id": category_id, "user_id": user_id},
                )
                session.execute(
                    text("""
                        INSERT INTO podcast_subscriptions (
                            user_id, podcast_id, status, category_id
                        ) VALUES (
                            :user_id, :podcast_id, 'active', :category_id
                        )
                    """),
                    {
                        "user_id": user_id,
                        "podcast_id": podcast_id,
                        "category_id": category_id,
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0047")
            assert result.returncode == 0, f"upgrade 0047 failed: {result.stderr}"

            with Session(engine) as session:
                media_entry = session.execute(
                    text("""
                        SELECT library_id, media_id, podcast_id, position
                        FROM library_entries
                        WHERE library_id = :library_id
                          AND media_id = :media_id
                    """),
                    {"library_id": shared_library_id, "media_id": media_id},
                ).fetchone()
                category_library = session.execute(
                    text("""
                        SELECT id, owner_user_id, name, color, is_default
                        FROM libraries
                        WHERE owner_user_id = :user_id
                          AND name = 'Sports'
                          AND is_default = false
                    """),
                    {"user_id": user_id},
                ).fetchone()
                assert category_library is not None
                podcast_entry = session.execute(
                    text("""
                        SELECT podcast_id
                        FROM library_entries
                        WHERE library_id = :library_id
                          AND podcast_id = :podcast_id
                    """),
                    {"library_id": category_library[0], "podcast_id": podcast_id},
                ).fetchone()
                category_table = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.tables
                        WHERE table_name = 'podcast_subscription_categories'
                        """
                    )
                ).fetchone()
                category_column = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'podcast_subscriptions'
                          AND column_name = 'category_id'
                        """
                    )
                ).fetchone()
                unsubscribe_mode_column = session.execute(
                    text(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_name = 'podcast_subscriptions'
                          AND column_name = 'unsubscribe_mode'
                        """
                    )
                ).fetchone()

            assert media_entry is not None
            assert media_entry[0] == shared_library_id
            assert media_entry[1] == media_id
            assert media_entry[2] is None
            assert media_entry[3] == 3
            assert category_library[1] == user_id
            assert category_library[2] == "Sports"
            assert category_library[3] == "#123456"
            assert category_library[4] is False
            assert podcast_entry is not None
            assert category_table is None
            assert category_column is None
            assert unsubscribe_mode_column is None
        finally:
            engine.dispose()
            run_alembic_command("upgrade head")


class TestPodcastEpisodeChapterMigration:
    """Schema assertions for podcast episode chapter persistence contract."""

    def test_head_contains_podcast_episode_chapters_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_episode_chapters'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_episode_chapters'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'podcast_episode_chapters'
                    ORDER BY indexname
                    """
                )
            ).fetchall()

        column_names = {row[0] for row in columns}
        assert {
            "id",
            "media_id",
            "chapter_idx",
            "title",
            "t_start_ms",
            "t_end_ms",
            "url",
            "image_url",
            "source",
            "created_at",
        }.issubset(column_names), (
            "podcast chapter migration must persist canonical chapter contract fields; "
            f"got columns {column_names}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "uq_podcast_episode_chapters_media_idx" in constraint_names
        assert "ck_podcast_episode_chapters_source" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_podcast_episode_chapters_media_t_start_ms" in index_names


class TestPodcastEpisodeShowNotesMigration:
    """Schema assertions for PR-12 show notes persistence columns."""

    def test_head_contains_podcast_episode_show_notes_columns(self, migrated_engine):
        with Session(migrated_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_episodes'
                      AND column_name IN ('description_html', 'description_text')
                    ORDER BY column_name
                    """
                )
            ).fetchall()

        column_contract = {row[0]: (row[1], row[2]) for row in rows}
        assert "description_html" in column_contract, (
            "podcast_episodes.description_html must exist for sanitized show notes html persistence"
        )
        assert "description_text" in column_contract, (
            "podcast_episodes.description_text must exist for plain-text preview/search contexts"
        )
        assert column_contract["description_html"][0] in {"text", "character varying"}, (
            f"description_html should be text-like, got {column_contract['description_html'][0]}"
        )
        assert column_contract["description_text"][0] in {"text", "character varying"}, (
            f"description_text should be text-like, got {column_contract['description_text'][0]}"
        )
        assert column_contract["description_html"][1] == "YES", (
            "description_html should be nullable for episodes with no show notes"
        )
        assert column_contract["description_text"][1] == "YES", (
            "description_text should be nullable for episodes with no show notes"
        )


class TestProjectGutenbergCatalogMigration:
    """Schema assertions for the local Project Gutenberg catalog mirror."""

    def test_head_contains_project_gutenberg_catalog_table_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'project_gutenberg_catalog'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname
                    FROM pg_constraint
                    WHERE conrelid = 'project_gutenberg_catalog'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'project_gutenberg_catalog'
                    ORDER BY indexname
                    """
                )
            ).fetchall()

        column_names = {row[0] for row in columns}
        assert {
            "ebook_id",
            "title",
            "gutenberg_type",
            "issued",
            "language",
            "subjects",
            "locc",
            "bookshelves",
            "copyright_status",
            "download_count",
            "raw_metadata",
            "synced_at",
            "created_at",
            "updated_at",
        }.issubset(column_names), (
            "project_gutenberg_catalog must persist normalized catalog fields plus raw metadata; "
            f"got columns {column_names}"
        )

        constraint_names = {row[0] for row in constraints}
        assert "ck_project_gutenberg_catalog_ebook_id_positive" in constraint_names
        assert "project_gutenberg_catalog_pkey" in constraint_names

        index_names = {row[0] for row in indexes}
        assert "ix_project_gutenberg_catalog_language" in index_names
        assert "ix_project_gutenberg_catalog_title" in index_names


class TestAuthorsLayerHardCutoverMigration:
    """Data migration coverage for contributor identity cutover."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()

    def test_upgrade_0071_preserves_name_only_legacy_author_boundaries(
        self,
        migration_engine,
    ):
        result = run_alembic_command("upgrade 0070")
        assert result.returncode == 0, f"upgrade 0070 failed: {result.stderr}"

        media_a = uuid4()
        media_b = uuid4()
        with Session(migration_engine) as session:
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES
                        (:media_a, 'pdf', 'Legacy Author A', 'ready'),
                        (:media_b, 'pdf', 'Legacy Author B', 'ready')
                    """
                ),
                {"media_a": media_a, "media_b": media_b},
            )
            session.execute(
                text(
                    """
                    INSERT INTO media_authors (media_id, name, role, sort_order)
                    VALUES
                        (:media_a, 'Same Legacy Name', 'author', 0),
                        (:media_b, 'Same Legacy Name', 'author', 0)
                    """
                ),
                {"media_a": media_a, "media_b": media_b},
            )
            session.commit()

        result = run_alembic_command("upgrade 0071")
        assert result.returncode == 0, f"upgrade 0071 failed: {result.stderr}"

        with Session(migration_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT media_id, contributor_id
                    FROM contributor_credits
                    WHERE media_id IN (:media_a, :media_b)
                    ORDER BY media_id
                    """
                ),
                {"media_a": media_a, "media_b": media_b},
            ).fetchall()

        assert len(rows) == 2
        assert rows[0][1] != rows[1][1]


class TestEpubNavSourceCutoverMigration:
    """Data migration coverage for EPUB nav source cutover."""

    @pytest.fixture(autouse=True)
    def isolate_migration(self):
        reset_test_schema()
        yield
        reset_test_schema()
        run_alembic_command("upgrade head")

    @pytest.fixture
    def migration_engine(self):
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()

    def test_upgrade_0051_to_0052_rewrites_fragment_fallback_rows(self, migration_engine):
        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', 'Migration EPUB', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Chapter text', '<p>Chapter text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations (
                        media_id,
                        location_id,
                        ordinal,
                        source_node_id,
                        label,
                        fragment_idx,
                        href_path,
                        href_fragment,
                        source
                    ) VALUES (
                        :media_id,
                        'frag-000001',
                        0,
                        NULL,
                        'Chapter 1',
                        0,
                        NULL,
                        NULL,
                        'spine'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        result = run_alembic_command("downgrade 0051")
        assert result.returncode == 0, f"downgrade 0051 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "fragment_fallback"

        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "spine"

    def test_downgrade_0052_to_0051_rewrites_spine_rows(self, migration_engine):
        result = run_alembic_command("upgrade 0052")
        assert result.returncode == 0, f"upgrade 0052 failed: {result.stderr}"

        user_id = uuid4()
        media_id = uuid4()
        fragment_id = uuid4()

        with Session(migration_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', 'Migration EPUB', 'ready_for_reading', :user_id)
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:id, :media_id, 0, 'Chapter text', '<p>Chapter text</p>')
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO epub_nav_locations (
                        media_id,
                        location_id,
                        ordinal,
                        source_node_id,
                        label,
                        fragment_idx,
                        href_path,
                        href_fragment,
                        source
                    ) VALUES (
                        :media_id,
                        'frag-000001',
                        0,
                        NULL,
                        'Chapter 1',
                        0,
                        NULL,
                        NULL,
                        'spine'
                    )
                    """
                ),
                {"media_id": media_id},
            )
            session.commit()

        result = run_alembic_command("downgrade 0051")
        assert result.returncode == 0, f"downgrade 0051 failed: {result.stderr}"

        with Session(migration_engine) as session:
            source = session.execute(
                text(
                    """
                    SELECT source
                    FROM epub_nav_locations
                    WHERE media_id = :media_id
                      AND location_id = 'frag-000001'
                    """
                ),
                {"media_id": media_id},
            ).scalar_one()

        assert source == "fragment_fallback"


class TestPodcastSubscriptionLibrariesMigration0113:
    """Schema assertions for migration 0113 (podcast_subscription_libraries)."""

    def test_migration_0113_creates_podcast_subscription_libraries(self, migrated_engine):
        """Head migration must materialize the table, composite PK, FK cascade, and index."""
        with Session(migrated_engine) as session:
            columns = session.execute(
                text(
                    """
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'podcast_subscription_libraries'
                    ORDER BY ordinal_position
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conname, contype
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_subscription_libraries'::regclass
                    ORDER BY conname
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'podcast_subscription_libraries'
                    ORDER BY indexname
                    """
                )
            ).fetchall()
            fk_actions = session.execute(
                text(
                    """
                    SELECT confrelid::regclass::text AS referenced_table,
                           confdeltype
                    FROM pg_constraint
                    WHERE conrelid = 'podcast_subscription_libraries'::regclass
                      AND contype = 'f'
                    ORDER BY confrelid::regclass::text
                    """
                )
            ).fetchall()

        column_by_name = {row[0]: (row[1], row[2]) for row in columns}
        assert {
            "subscription_user_id",
            "subscription_podcast_id",
            "library_id",
            "created_at",
        }.issubset(column_by_name.keys()), (
            "podcast_subscription_libraries must contain composite-key + library_id + created_at; "
            f"got {set(column_by_name)}"
        )
        assert column_by_name["subscription_user_id"][0] == "uuid"
        assert column_by_name["subscription_podcast_id"][0] == "uuid"
        assert column_by_name["library_id"][0] == "uuid"
        # All key columns must be NOT NULL.
        for col_name in (
            "subscription_user_id",
            "subscription_podcast_id",
            "library_id",
        ):
            assert column_by_name[col_name][1] == "NO", (
                f"{col_name} must be NOT NULL, got nullable={column_by_name[col_name][1]}"
            )

        constraint_names = {row[0] for row in constraints}
        assert "pk_podcast_subscription_libraries" in constraint_names, (
            f"composite PK must be named pk_podcast_subscription_libraries, got {constraint_names}"
        )

        index_names = {row[0] for row in indexes}
        assert "ix_podcast_subscription_libraries_library_id" in index_names, (
            f"secondary index for library_id reverse lookups is required, got {index_names}"
        )

        # Both FKs must cascade-delete.
        delete_actions = {row[0]: row[1] for row in fk_actions}
        assert "podcast_subscriptions" in delete_actions, (
            "FK to podcast_subscriptions (composite) is required"
        )
        assert "libraries" in delete_actions, "FK to libraries is required"
        assert delete_actions["podcast_subscriptions"] == "c", (
            "FK to podcast_subscriptions must cascade-delete, "
            f"got {delete_actions['podcast_subscriptions']}"
        )
        assert delete_actions["libraries"] == "c", (
            f"FK to libraries must cascade-delete, got {delete_actions['libraries']}"
        )

    def test_migration_0113_pk_rejects_duplicate_composite(self, migrated_engine):
        """The composite primary key prevents inserting the same triple twice."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            podcast_id = uuid4()
            library_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'PK Subscription Lib', false)
                    """
                ),
                {"id": library_id, "owner_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                    """
                ),
                {"library_id": library_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', :provider_id, 'PK Podcast',
                        'https://feeds.example.com/pk-test.xml'
                    )
                    """
                ),
                {"id": podcast_id, "provider_id": f"pk-{podcast_id}"},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_libraries (
                        subscription_user_id, subscription_podcast_id, library_id
                    )
                    VALUES (:user_id, :podcast_id, :library_id)
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "library_id": library_id,
                },
            )
            session.commit()

            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        """
                        INSERT INTO podcast_subscription_libraries (
                            subscription_user_id, subscription_podcast_id, library_id
                        )
                        VALUES (:user_id, :podcast_id, :library_id)
                        """
                    ),
                    {
                        "user_id": user_id,
                        "podcast_id": podcast_id,
                        "library_id": library_id,
                    },
                )
                session.commit()
            session.rollback()

    def test_migration_0113_subscription_delete_cascades_to_join_table(self, migrated_engine):
        """Deleting a podcast_subscription must remove its podcast_subscription_libraries rows."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            podcast_id = uuid4()
            library_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Cascade Lib', false)
                    """
                ),
                {"id": library_id, "owner_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                    """
                ),
                {"library_id": library_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', :provider_id, 'Cascade Podcast',
                        'https://feeds.example.com/cascade-test.xml'
                    )
                    """
                ),
                {"id": podcast_id, "provider_id": f"cascade-{podcast_id}"},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_libraries (
                        subscription_user_id, subscription_podcast_id, library_id
                    )
                    VALUES (:user_id, :podcast_id, :library_id)
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "library_id": library_id,
                },
            )
            session.commit()

            session.execute(
                text(
                    """
                    DELETE FROM podcast_subscriptions
                    WHERE user_id = :user_id AND podcast_id = :podcast_id
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.commit()

            remaining = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_subscription_libraries
                    WHERE subscription_user_id = :user_id
                      AND subscription_podcast_id = :podcast_id
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            ).scalar_one()
        assert remaining == 0, (
            f"deleting a podcast_subscription must cascade-delete join rows; got {remaining}"
        )

    def test_migration_0113_library_delete_cascades_to_join_table(self, migrated_engine):
        """Deleting a library must remove its podcast_subscription_libraries rows."""
        with Session(migrated_engine) as session:
            user_id = uuid4()
            podcast_id = uuid4()
            library_id = uuid4()

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO libraries (id, owner_user_id, name, is_default)
                    VALUES (:id, :owner_id, 'Lib Cascade', false)
                    """
                ),
                {"id": library_id, "owner_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :user_id, 'admin')
                    """
                ),
                {"library_id": library_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        id, provider, provider_podcast_id, title, feed_url
                    ) VALUES (
                        :id, 'podcast_index', :provider_id, 'Lib Cascade Podcast',
                        'https://feeds.example.com/lib-cascade.xml'
                    )
                    """
                ),
                {"id": podcast_id, "provider_id": f"libcasc-{podcast_id}"},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
                    VALUES (:user_id, :podcast_id, 'active')
                    """
                ),
                {"user_id": user_id, "podcast_id": podcast_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_libraries (
                        subscription_user_id, subscription_podcast_id, library_id
                    )
                    VALUES (:user_id, :podcast_id, :library_id)
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "library_id": library_id,
                },
            )
            session.commit()

            session.execute(
                text(
                    """
                    DELETE FROM memberships
                    WHERE library_id = :library_id
                    """
                ),
                {"library_id": library_id},
            )
            session.execute(
                text("DELETE FROM libraries WHERE id = :library_id"),
                {"library_id": library_id},
            )
            session.commit()

            remaining = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM podcast_subscription_libraries
                    WHERE library_id = :library_id
                    """
                ),
                {"library_id": library_id},
            ).scalar_one()
        assert remaining == 0, f"deleting a library must cascade-delete join rows; got {remaining}"


class TestConversationReferencesCutoverMigration0121:
    """Schema assertions for the conversation_references cutover at HEAD.

    Migration 0121 drops the five fragmented chat-context tables
    (``conversation_memory_items``, ``conversation_memory_item_sources``,
    ``conversation_pinned_sources``, ``chat_singletons``,
    ``message_context_items``) plus ``source_manifests``, and created the
    polymorphic ``conversation_references`` table — which 0145 then folded into
    ``resource_edges`` (see ``test_0145_folds_link_stores_into_resource_edges``),
    so at HEAD the table no longer exists. The pre-existing ``scope_*`` columns
    on ``conversations`` were already dropped by 0114 and stay dropped at HEAD.
    Migration 0124 drops the legacy conversation state snapshot table and
    prompt-assembly memory/snapshot columns.
    """

    def test_0121_and_0124_drop_fragmented_chat_context_tables(self, migrated_engine):
        with Session(migrated_engine) as session:
            tables = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                        """
                    )
                ).fetchall()
            }
        dropped = {
            "conversation_memory_items",
            "conversation_memory_item_sources",
            "conversation_pinned_sources",
            "chat_singletons",
            "message_context_items",
            "source_manifests",
            "conversation_state_snapshots",
        }
        leftover = dropped & tables
        assert leftover == set(), (
            "Migrations 0121 and 0124 should have dropped these tables by HEAD, "
            f"but they remain: {leftover}"
        )

    def test_0145_folds_link_stores_into_resource_edges(self, migrated_engine):
        """0145 drops the four per-feature link/citation stores for one edge table.

        ``conversation_references``/``object_links``/``oracle_reading_passages`` are
        gone at HEAD (``library_intelligence_citations`` is covered by the LI class),
        and the provenance-graph owners exist. ``message_retrievals`` keeps its
        telemetry row but trades ``citation_ordinal`` for the FK-free
        ``cited_edge_id`` pointer (§8.4).
        """
        with Session(migrated_engine) as session:
            tables = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name FROM information_schema.tables
                        WHERE table_schema = 'public'
                        """
                    )
                ).fetchall()
            }
            retrieval_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'message_retrievals'
                        """
                    )
                ).fetchall()
            }

        dropped = {"conversation_references", "object_links", "oracle_reading_passages"}
        assert dropped.isdisjoint(tables), (
            f"0145 must drop the per-feature link stores; still present: {dropped & tables}"
        )
        for required in ("resource_edges", "resource_external_snapshots", "oracle_reading_folios"):
            assert required in tables, f"0145 must create {required} at HEAD"
        assert "cited_edge_id" in retrieval_columns, (
            f"message_retrievals must gain cited_edge_id; got {retrieval_columns}"
        )
        assert "citation_ordinal" not in retrieval_columns, (
            f"message_retrievals must drop citation_ordinal; got {retrieval_columns}"
        )

    def test_0124_drops_legacy_snapshot_and_memory_prompt_columns(self, migrated_engine):
        with Session(migrated_engine) as session:
            prompt_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'chat_prompt_assemblies'
                        """
                    )
                ).fetchall()
            }

        stale_columns = {"snapshot_id", "included_memory_item_ids"}
        assert stale_columns.isdisjoint(prompt_columns), (
            "chat_prompt_assemblies must not retain legacy snapshot/memory columns; "
            f"got {prompt_columns}"
        )

    def test_0137_drops_prompt_version_and_hash_provenance_columns(self, migrated_engine):
        with Session(migrated_engine) as session:
            prompt_assembly_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'chat_prompt_assemblies'
                        """
                    )
                ).fetchall()
            }

        assert {
            "prompt_version",
            "prompt_plan_version",
            "assembler_version",
            "stable_prefix_hash",
            "provider_request_hash",
        }.isdisjoint(prompt_assembly_columns), (
            "chat_prompt_assemblies must not retain prompt version/hash provenance columns; "
            f"got {prompt_assembly_columns}"
        )

    def test_0121_conversations_has_no_scope_columns(self, migrated_engine):
        """Scope columns were dropped by 0114 and stay dropped through 0121."""
        with Session(migrated_engine) as session:
            conversations_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'conversations'
                        """
                    )
                ).fetchall()
            }
        for legacy_col in ("scope_type", "scope_id", "scope_media_id", "scope_library_id"):
            assert legacy_col not in conversations_columns, (
                f"conversations.{legacy_col} must remain dropped at HEAD; "
                f"got columns {conversations_columns}"
            )

    def test_references_cutover_downgrade_raises(self, migrated_engine):
        """Per spec, the references cutover is irreversible by policy.
        Downgrading to a target before 0121 raises ``NotImplementedError``."""
        result = run_alembic_command("downgrade 0120")

        assert result.returncode != 0, (
            "Expected alembic downgrade through 0121 to fail; "
            f"got returncode={result.returncode}, stderr={result.stderr}"
        )
        combined = (result.stdout or "") + (result.stderr or "")
        assert "NotImplementedError" in combined or "not reversible" in combined, (
            "Expected downgrade to surface the explicit NotImplementedError "
            "or 'not reversible' marker; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )


class TestDurableSourceIngestMigrations:
    """Schema assertions for 0132/0133 durable source ingest cutover."""

    def test_0133_backfills_existing_source_media_attempts(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0132")
            assert result.returncode == 0, f"upgrade 0132 failed: {result.stderr}"

            user_id = uuid4()
            x_media_id = uuid4()
            remote_pdf_id = uuid4()
            uploaded_epub_id = uuid4()
            youtube_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, requested_url, canonical_url,
                            canonical_source_url, provider, provider_id,
                            processing_status, created_by_user_id,
                            processing_attempts, last_error_code,
                            last_error_message, processing_started_at, failed_at
                        )
                        VALUES (
                            :id, 'web_article', 'Legacy X failure',
                            'https://x.com/ada/status/1234567890',
                            'https://x.com/i/status/1234567890',
                            'https://x.com/i/status/1234567890',
                            'x', 'post:1234567890', 'failed', :user_id,
                            2, 'E_X_PROVIDER_TIMEOUT', 'provider timed out',
                            now(), now()
                        )
                        """
                    ),
                    {"id": x_media_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, requested_url, canonical_source_url,
                            processing_status, created_by_user_id,
                            processing_attempts, last_error_code, last_error_message,
                            processing_started_at, failed_at
                        )
                        VALUES (
                            :id, 'pdf', 'Legacy remote PDF failure',
                            'https://example.com/missing.pdf',
                            'https://example.com/missing.pdf',
                            'failed', :user_id, 1, 'E_UPSTREAM_NOT_FOUND',
                            'not found', now(), now()
                        )
                        """
                    ),
                    {"id": remote_pdf_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, processing_status, created_by_user_id,
                            processing_completed_at
                        )
                        VALUES (
                            :id, 'epub', 'Legacy uploaded EPUB',
                            'ready_for_reading', :user_id, now()
                        )
                        """
                    ),
                    {
                        "id": uploaded_epub_id,
                        "user_id": user_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media_file (
                            media_id, storage_path, content_type, size_bytes
                        )
                        VALUES (
                            :id, :storage_path, 'application/epub+zip', 1024
                        )
                        """
                    ),
                    {
                        "id": uploaded_epub_id,
                        "storage_path": f"media/{uploaded_epub_id}/original.epub",
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, requested_url, canonical_url,
                            canonical_source_url, provider, provider_id,
                            processing_status, created_by_user_id,
                            processing_attempts, processing_started_at
                        )
                        VALUES (
                            :id, 'video', 'Legacy YouTube pending',
                            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                            'youtube', 'dQw4w9WgXcQ', 'pending', :user_id,
                            0, now()
                        )
                        """
                    ),
                    {"id": youtube_id, "user_id": user_id},
                )
                session.commit()

            result = run_alembic_command("upgrade 0133")
            assert result.returncode == 0, f"upgrade 0133 failed: {result.stderr}"

            with Session(engine) as session:
                rows = {
                    row.media_id: row
                    for row in session.execute(
                        text(
                            """
                            SELECT
                                media_id,
                                source_type,
                                status,
                                run_count,
                                provider_target_ref,
                                error_code,
                                source_payload
                            FROM media_source_attempts
                            WHERE media_id = ANY(:media_ids)
                            """
                        ),
                        {
                            "media_ids": [
                                x_media_id,
                                remote_pdf_id,
                                uploaded_epub_id,
                                youtube_id,
                            ]
                        },
                    )
                }

            assert rows[x_media_id].source_type == "x_author_thread"
            assert rows[x_media_id].status == "failed"
            assert rows[x_media_id].run_count == 2
            assert rows[x_media_id].provider_target_ref == "1234567890"
            assert rows[x_media_id].error_code == "E_X_PROVIDER_TIMEOUT"
            assert rows[x_media_id].source_payload["backfilled"] is True

            assert rows[remote_pdf_id].source_type == "remote_pdf_url"
            assert rows[remote_pdf_id].status == "failed"
            assert rows[remote_pdf_id].error_code == "E_UPSTREAM_NOT_FOUND"
            assert rows[remote_pdf_id].source_payload["backfilled"] is True

            assert rows[uploaded_epub_id].source_type == "uploaded_epub_file"
            assert rows[uploaded_epub_id].status == "succeeded"
            assert rows[uploaded_epub_id].source_payload["storage_path"] == (
                f"media/{uploaded_epub_id}/original.epub"
            )

            assert rows[youtube_id].source_type == "youtube_video"
            assert rows[youtube_id].status == "queued"
            assert rows[youtube_id].provider_target_ref == "dQw4w9WgXcQ"
        finally:
            engine.dispose()
            reset_test_schema()
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"restore head failed: {result.stderr}"

    def test_0136_backfills_numeric_x_source_attempt_targets(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0135")
            assert result.returncode == 0, f"upgrade 0135 failed: {result.stderr}"

            user_id = uuid4()
            media_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO media (
                            id, kind, title, requested_url, canonical_source_url,
                            provider, provider_id, processing_status,
                            created_by_user_id, processing_completed_at
                        )
                        VALUES (
                            :id, 'web_article', 'Existing X media',
                            'https://x.com/ada/status/2058605803267919911',
                            'https://x.com/ada/status/2058605803267919911',
                            'x', '2058605803267919911', 'ready_for_reading',
                            :user_id, now()
                        )
                        """
                    ),
                    {"id": media_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO media_source_attempts (
                            media_id, created_by_user_id, source_type, attempt_no,
                            status, intent_key, provider, provider_target_ref,
                            source_payload
                        )
                        VALUES (
                            :media_id, :user_id, 'x_author_thread', 1,
                            'succeeded', :intent_key,
                            'x', NULL, '{"backfilled": true}'::jsonb
                        )
                        """
                    ),
                    {
                        "media_id": media_id,
                        "user_id": user_id,
                        "intent_key": f"backfill:x_author_thread:{media_id}",
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade 0136")
            assert result.returncode == 0, f"upgrade 0136 failed: {result.stderr}"

            with Session(engine) as session:
                row = session.execute(
                    text(
                        """
                        SELECT provider, provider_target_ref, source_payload
                        FROM media_source_attempts
                        WHERE media_id = :media_id
                        """
                    ),
                    {"media_id": media_id},
                ).one()

            assert row.provider == "x"
            assert row.provider_target_ref == "2058605803267919911"
            assert row.source_payload["post_id"] == "2058605803267919911"
            assert row.source_payload["backfilled"] is True
        finally:
            engine.dispose()
            reset_test_schema()
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"restore head failed: {result.stderr}"

    def test_media_source_attempts_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            constraints = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT conname, pg_get_constraintdef(oid)
                        FROM pg_constraint
                        WHERE conrelid = 'media_source_attempts'::regclass
                        """
                    )
                ).fetchall()
            }
            indexes = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname, indexdef
                        FROM pg_indexes
                        WHERE tablename = 'media_source_attempts'
                        """
                    )
                ).fetchall()
            }

        assert "ck_media_source_attempts_source_type" in constraints
        assert "ck_media_source_attempts_status" in constraints
        assert "uq_media_source_attempts_media_attempt" in constraints
        assert "FOREIGN KEY (media_id) REFERENCES media(id)" in set(constraints.values())
        assert "FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL" in set(
            constraints.values()
        )
        assert "FOREIGN KEY (job_id) REFERENCES background_jobs(id) ON DELETE SET NULL" in set(
            constraints.values()
        )

        assert "idx_media_source_attempts_media_created" in indexes
        assert "created_at DESC" in indexes["idx_media_source_attempts_media_created"]
        assert "id DESC" in indexes["idx_media_source_attempts_media_created"]
        assert "idx_media_source_attempts_request_id" in indexes
        assert "WHERE (request_id IS NOT NULL)" in indexes["idx_media_source_attempts_request_id"]
        assert "idx_media_source_attempts_source_type_status_updated" in indexes
        assert "source_type" in indexes["idx_media_source_attempts_source_type_status_updated"]
        assert "status" in indexes["idx_media_source_attempts_source_type_status_updated"]
        assert "idx_media_source_attempts_provider_target" in indexes
        assert "provider_target_ref" in indexes["idx_media_source_attempts_provider_target"]
        assert (
            "WHERE ((provider IS NOT NULL) AND (provider_target_ref IS NOT NULL))"
            in indexes["idx_media_source_attempts_provider_target"]
        )
        assert "uq_media_source_attempts_idempotency" in indexes
        assert (
            "WHERE (idempotency_key IS NOT NULL)" in indexes["uq_media_source_attempts_idempotency"]
        )

    def test_external_provider_events_correlation_contract(self, migrated_engine):
        with Session(migrated_engine) as session:
            constraints = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT conname, pg_get_constraintdef(oid)
                        FROM pg_constraint
                        WHERE conrelid = 'external_provider_events'::regclass
                        """
                    )
                ).fetchall()
            }
            indexes = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname, indexdef
                        FROM pg_indexes
                        WHERE tablename = 'external_provider_events'
                        """
                    )
                ).fetchall()
            }

        constraint_defs = set(constraints.values())
        assert "ck_external_provider_events_status" in constraints
        assert "FOREIGN KEY (viewer_id) REFERENCES users(id)" in constraint_defs
        assert "FOREIGN KEY (media_id) REFERENCES media(id)" in constraint_defs
        assert (
            "FOREIGN KEY (source_attempt_id) REFERENCES media_source_attempts(id)"
            in constraint_defs
        )
        assert "ix_external_provider_events_request_id" in indexes
        assert "ix_external_provider_events_source_attempt_id" in indexes
        assert "ix_external_provider_events_provider_status_created" in indexes


class TestMigration0143PolymorphicOwner:
    """Content indexing has polymorphic media/note owners at head.

    0143 generalizes content_blocks/content_chunks/evidence_spans/content_index_states
    from a single media_id to a polymorphic (owner_kind, owner_id), extends the
    source_kind/resolver_kind domains with 'note', renames
    media_content_index_states -> content_index_states, and drops object_search.
    0160 removes page-owned note indexing; head accepts only media and note_block owners.
    """

    OWNER_TABLES = ("content_blocks", "content_chunks", "evidence_spans")

    def _insert_minimal_block(
        self,
        session: Session,
        *,
        owner_kind: str,
        owner_id,
        block_idx: int = 0,
    ):
        """Insert one HEAD-schema content_block and return its id (or raise)."""
        return session.execute(
            text(
                """
                INSERT INTO content_blocks (
                    owner_kind,
                    owner_id,
                    block_idx,
                    block_kind,
                    canonical_text,
                    source_start_offset,
                    source_end_offset,
                    heading_path,
                    locator,
                    selector,
                    metadata
                )
                VALUES (
                    :owner_kind,
                    CAST(:owner_id AS uuid),
                    :block_idx,
                    'paragraph',
                    'minimal block',
                    0,
                    13,
                    '[]'::jsonb,
                    '{}'::jsonb,
                    '{}'::jsonb,
                    '{}'::jsonb
                )
                RETURNING id
                """
            ),
            {"owner_kind": owner_kind, "owner_id": str(owner_id), "block_idx": block_idx},
        ).scalar_one()

    def _insert_minimal_chunk(
        self,
        session: Session,
        *,
        owner_kind: str,
        owner_id,
        source_kind: str,
        primary_evidence_span_id=None,
        chunk_idx: int = 0,
    ):
        return session.execute(
            text(
                """
                INSERT INTO content_chunks (
                    owner_kind,
                    owner_id,
                    primary_evidence_span_id,
                    chunk_idx,
                    source_kind,
                    chunk_text,
                    token_count,
                    heading_path,
                    summary_locator
                )
                VALUES (
                    :owner_kind,
                    CAST(:owner_id AS uuid),
                    CAST(:primary_evidence_span_id AS uuid),
                    :chunk_idx,
                    :source_kind,
                    'minimal chunk',
                    3,
                    '[]'::jsonb,
                    '{}'::jsonb
                )
                RETURNING id
                """
            ),
            {
                "owner_kind": owner_kind,
                "owner_id": str(owner_id),
                "primary_evidence_span_id": (
                    str(primary_evidence_span_id) if primary_evidence_span_id is not None else None
                ),
                "source_kind": source_kind,
                "chunk_idx": chunk_idx,
            },
        ).scalar_one()

    def _insert_minimal_span(
        self,
        session: Session,
        *,
        owner_kind: str,
        owner_id,
        start_block_id,
        end_block_id,
        resolver_kind: str,
    ):
        return session.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    owner_kind,
                    owner_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    selector,
                    citation_label,
                    resolver_kind
                )
                VALUES (
                    :owner_kind,
                    CAST(:owner_id AS uuid),
                    CAST(:start_block_id AS uuid),
                    CAST(:end_block_id AS uuid),
                    0,
                    13,
                    'minimal span',
                    '{}'::jsonb,
                    'Source',
                    :resolver_kind
                )
                RETURNING id
                """
            ),
            {
                "owner_kind": owner_kind,
                "owner_id": str(owner_id),
                "start_block_id": str(start_block_id),
                "end_block_id": str(end_block_id),
                "resolver_kind": resolver_kind,
            },
        ).scalar_one()

    def test_owner_columns_replace_media_id_at_head(self):
        """(a) owner_kind/owner_id are NOT NULL and media_id is gone."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                for table in self.OWNER_TABLES:
                    columns = {
                        row[0]: row[1]
                        for row in session.execute(
                            text(
                                """
                                SELECT column_name, is_nullable
                                FROM information_schema.columns
                                WHERE table_name = :table
                                """
                            ),
                            {"table": table},
                        ).fetchall()
                    }
                    assert "media_id" not in columns, (
                        f"{table}.media_id must be dropped at head. Columns={columns}"
                    )
                    assert columns.get("owner_kind") == "NO", (
                        f"{table}.owner_kind must be NOT NULL at head. Columns={columns}"
                    )
                    assert columns.get("owner_id") == "NO", (
                        f"{table}.owner_id must be NOT NULL at head. Columns={columns}"
                    )
        finally:
            reset_test_schema()
            engine.dispose()

    def test_owner_kind_check_rejects_unknown_kind(self):
        """(b) ck_<table>_owner_kind rejects owner_kind outside media/note_block."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            owner_id = uuid4()
            with Session(engine) as session:
                block_id = self._insert_minimal_block(
                    session, owner_kind="note_block", owner_id=owner_id
                )
                session.commit()

                # content_blocks
                with pytest.raises(IntegrityError) as exc_info:
                    self._insert_minimal_block(session, owner_kind="garbage", owner_id=owner_id)
                    session.commit()
                session.rollback()
                assert "ck_content_blocks_owner_kind" in str(exc_info.value)

                # content_chunks
                with pytest.raises(IntegrityError) as exc_info:
                    self._insert_minimal_chunk(
                        session,
                        owner_kind="garbage",
                        owner_id=owner_id,
                        source_kind="note",
                    )
                    session.commit()
                session.rollback()
                assert "ck_content_chunks_owner_kind" in str(exc_info.value)

                # evidence_spans
                with pytest.raises(IntegrityError) as exc_info:
                    self._insert_minimal_span(
                        session,
                        owner_kind="garbage",
                        owner_id=owner_id,
                        start_block_id=block_id,
                        end_block_id=block_id,
                        resolver_kind="note",
                    )
                    session.commit()
                session.rollback()
                assert "ck_evidence_spans_owner_kind" in str(exc_info.value)

                # content_index_states
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text(
                            """
                            INSERT INTO content_index_states (
                                owner_kind, owner_id, status
                            )
                            VALUES ('garbage', CAST(:owner_id AS uuid), 'pending')
                            """
                        ),
                        {"owner_id": str(owner_id)},
                    )
                    session.commit()
                session.rollback()
                assert "ck_content_index_states_owner_kind" in str(exc_info.value)
        finally:
            reset_test_schema()
            engine.dispose()

    def test_discriminator_checks_accept_note_and_reject_unknown(self):
        """(c) source_kind/resolver_kind accept 'note' and reject a bogus kind."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            owner_id = uuid4()
            with Session(engine) as session:
                block_id = self._insert_minimal_block(
                    session, owner_kind="note_block", owner_id=owner_id
                )

                # content_chunks accepts source_kind='note'.
                self._insert_minimal_chunk(
                    session,
                    owner_kind="note_block",
                    owner_id=owner_id,
                    source_kind="note",
                    chunk_idx=0,
                )
                # evidence_spans accepts resolver_kind='note'.
                self._insert_minimal_span(
                    session,
                    owner_kind="note_block",
                    owner_id=owner_id,
                    start_block_id=block_id,
                    end_block_id=block_id,
                    resolver_kind="note",
                )
                session.commit()

                # content_chunks rejects a bogus source_kind.
                with pytest.raises(IntegrityError) as exc_info:
                    self._insert_minimal_chunk(
                        session,
                        owner_kind="note_block",
                        owner_id=owner_id,
                        source_kind="bogus_kind",
                        chunk_idx=1,
                    )
                    session.commit()
                session.rollback()
                assert "ck_content_chunks_source_kind" in str(exc_info.value)

                # evidence_spans rejects a bogus resolver_kind.
                with pytest.raises(IntegrityError) as exc_info:
                    self._insert_minimal_span(
                        session,
                        owner_kind="note_block",
                        owner_id=owner_id,
                        start_block_id=block_id,
                        end_block_id=block_id,
                        resolver_kind="bogus_kind",
                    )
                    session.commit()
                session.rollback()
                assert "ck_evidence_spans_resolver" in str(exc_info.value)
        finally:
            reset_test_schema()
            engine.dispose()

    def test_owner_keys_recreated_and_media_keys_gone(self):
        """(d) Owner uniques/indexes exist by name; old media keys are gone."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                constraint_names = {
                    row[0]
                    for row in session.execute(
                        text(
                            "SELECT conname FROM pg_constraint WHERE connamespace = "
                            "'public'::regnamespace"
                        )
                    ).fetchall()
                }
                index_names = {
                    row[0]
                    for row in session.execute(
                        text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
                    ).fetchall()
                }

            present = constraint_names | index_names
            expected_owner_keys = (
                "uq_content_blocks_owner_idx",
                "uq_content_chunks_owner_idx",
                "uq_content_index_states_owner",
                "ix_evidence_spans_owner",
            )
            for key in expected_owner_keys:
                assert key in present, (
                    f"Expected recreated owner key {key} at head. "
                    f"Constraints={sorted(constraint_names)} Indexes={sorted(index_names)}"
                )

            removed_media_keys = (
                "uq_content_blocks_media_idx",
                "ix_content_blocks_media_idx",
                "uq_content_chunks_media_idx",
                "ix_content_chunks_media_idx",
                "ix_evidence_spans_media",
                "uq_media_content_index_states_media",
            )
            for key in removed_media_keys:
                assert key not in present, (
                    f"Old media key {key} must be gone at head. Present={sorted(present)}"
                )
        finally:
            reset_test_schema()
            engine.dispose()

    def test_note_owner_scoped_delete_clears_note_evidence(self):
        """(e) owner-scoped delete drops note evidence + nulls retrievals."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            tool_call_id = uuid4()
            note_owner_id = uuid4()
            # An unrelated media owner whose evidence must survive the note-scoped delete.
            other_owner_id = uuid4()

            with Session(engine) as session:
                # Conversation/message/tool_call chain to host a message_retrievals row.
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :user_id, 'private', 3)
                        """
                    ),
                    {"id": conversation_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (id, conversation_id, seq, role, content, status)
                        VALUES (:id, :conversation_id, 1, 'user', 'note please', 'complete')
                        """
                    ),
                    {"id": user_message_id, "conversation_id": conversation_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status, parent_message_id
                        )
                        VALUES (:id, :conversation_id, 2, 'assistant', '', 'pending', :parent_id)
                        """
                    ),
                    {
                        "id": assistant_message_id,
                        "conversation_id": conversation_id,
                        "parent_id": user_message_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_tool_calls (
                            id, conversation_id, user_message_id, assistant_message_id,
                            tool_name, tool_call_index, scope, status
                        )
                        VALUES (
                            :id, :conversation_id, :user_message_id, :assistant_message_id,
                            'app_search', 0, 'all', 'complete'
                        )
                        """
                    ),
                    {
                        "id": tool_call_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                    },
                )

                # Note-owned evidence: block -> span -> chunk -> part + embedding + state.
                note_block_id = self._insert_minimal_block(
                    session, owner_kind="note_block", owner_id=note_owner_id
                )
                note_span_id = self._insert_minimal_span(
                    session,
                    owner_kind="note_block",
                    owner_id=note_owner_id,
                    start_block_id=note_block_id,
                    end_block_id=note_block_id,
                    resolver_kind="note",
                )
                note_chunk_id = self._insert_minimal_chunk(
                    session,
                    owner_kind="note_block",
                    owner_id=note_owner_id,
                    source_kind="note",
                    primary_evidence_span_id=note_span_id,
                )
                session.execute(
                    text(
                        """
                        INSERT INTO content_chunk_parts (
                            chunk_id, part_idx, block_id,
                            block_start_offset, block_end_offset,
                            chunk_start_offset, chunk_end_offset
                        )
                        VALUES (
                            CAST(:chunk_id AS uuid), 0, CAST(:block_id AS uuid),
                            0, 13, 0, 13
                        )
                        """
                    ),
                    {"chunk_id": str(note_chunk_id), "block_id": str(note_block_id)},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO content_embeddings (
                            chunk_id, embedding_provider, embedding_model,
                            embedding_dimensions, embedding_vector
                        )
                        VALUES (
                            CAST(:chunk_id AS uuid), 'fixture', 'fixture',
                            256, CAST(:embedding_vector AS vector(256))
                        )
                        """
                    ),
                    {
                        "chunk_id": str(note_chunk_id),
                        "embedding_vector": "[" + ",".join(["0"] * 256) + "]",
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO content_index_states (owner_kind, owner_id, status)
                        VALUES ('note_block', CAST(:owner_id AS uuid), 'ready')
                        """
                    ),
                    {"owner_id": str(note_owner_id)},
                )

                # A message_retrievals row pointing at the note-owned span.
                session.execute(
                    text(
                        """
                        INSERT INTO message_retrievals (
                            tool_call_id, ordinal, result_type, source_id,
                            context_ref, result_ref, evidence_span_id
                        )
                        VALUES (
                            :tool_call_id, 0, 'note_block', :source_id,
                            jsonb_build_object('type', 'note_block', 'id', CAST(:source_id AS text)),
                            jsonb_build_object('type', 'note_block', 'id', CAST(:source_id AS text)),
                            CAST(:evidence_span_id AS uuid)
                        )
                        """
                    ),
                    {
                        "tool_call_id": tool_call_id,
                        "source_id": str(uuid4()),
                        "evidence_span_id": str(note_span_id),
                    },
                )

                # An unrelated media-owned span + retrieval that MUST survive the delete.
                other_block_id = self._insert_minimal_block(
                    session, owner_kind="media", owner_id=other_owner_id
                )
                other_span_id = self._insert_minimal_span(
                    session,
                    owner_kind="media",
                    owner_id=other_owner_id,
                    start_block_id=other_block_id,
                    end_block_id=other_block_id,
                    resolver_kind="web",
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_retrievals (
                            tool_call_id, ordinal, result_type, source_id,
                            context_ref, result_ref, evidence_span_id
                        )
                        VALUES (
                            :tool_call_id, 1, 'content_chunk', :source_id,
                            jsonb_build_object('type', 'content_chunk', 'id', CAST(:source_id AS text)),
                            jsonb_build_object('type', 'content_chunk', 'id', CAST(:source_id AS text)),
                            CAST(:evidence_span_id AS uuid)
                        )
                        """
                    ),
                    {
                        "tool_call_id": tool_call_id,
                        "source_id": str(uuid4()),
                        "evidence_span_id": str(other_span_id),
                    },
                )
                session.commit()

            # Run the owner-scoped delete sequence the application uses for a note
            # (services/content_indexing.delete_content_index, owner_kind='note_block'):
            # null dangling retrievals first, then delete state/embeddings/parts/
            # chunks/spans/blocks for that owner.
            params = {"owner_kind": "note_block", "owner_id": str(note_owner_id)}
            with Session(engine) as session:
                session.execute(
                    text(
                        """
                        UPDATE message_retrievals mr
                        SET evidence_span_id = NULL
                        FROM evidence_spans es
                        WHERE mr.evidence_span_id = es.id
                          AND es.owner_kind = :owner_kind
                          AND es.owner_id = CAST(:owner_id AS uuid)
                        """
                    ),
                    params,
                )
                session.execute(
                    text(
                        "DELETE FROM content_index_states "
                        "WHERE owner_kind = :owner_kind AND owner_id = CAST(:owner_id AS uuid)"
                    ),
                    params,
                )
                session.execute(
                    text(
                        """
                        DELETE FROM content_embeddings ce
                        USING content_chunks cc
                        WHERE ce.chunk_id = cc.id
                          AND cc.owner_kind = :owner_kind
                          AND cc.owner_id = CAST(:owner_id AS uuid)
                        """
                    ),
                    params,
                )
                session.execute(
                    text(
                        """
                        DELETE FROM content_chunk_parts ccp
                        USING content_chunks cc
                        WHERE ccp.chunk_id = cc.id
                          AND cc.owner_kind = :owner_kind
                          AND cc.owner_id = CAST(:owner_id AS uuid)
                        """
                    ),
                    params,
                )
                session.execute(
                    text(
                        "DELETE FROM content_chunks "
                        "WHERE owner_kind = :owner_kind AND owner_id = CAST(:owner_id AS uuid)"
                    ),
                    params,
                )
                session.execute(
                    text(
                        "DELETE FROM evidence_spans "
                        "WHERE owner_kind = :owner_kind AND owner_id = CAST(:owner_id AS uuid)"
                    ),
                    params,
                )
                session.execute(
                    text(
                        "DELETE FROM content_blocks "
                        "WHERE owner_kind = :owner_kind AND owner_id = CAST(:owner_id AS uuid)"
                    ),
                    params,
                )
                session.commit()

            with Session(engine) as session:
                dangling = session.execute(
                    text(
                        """
                        SELECT COUNT(*)
                        FROM message_retrievals mr
                        WHERE mr.evidence_span_id IS NOT NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM evidence_spans es WHERE es.id = mr.evidence_span_id
                          )
                        """
                    )
                ).scalar_one()
                assert dangling == 0, (
                    f"Expected zero dangling message_retrievals.evidence_span_id, got {dangling}"
                )

                for table in (
                    "content_chunk_parts",
                    "content_embeddings",
                    "content_chunks",
                    "content_index_states",
                    "content_blocks",
                    "evidence_spans",
                ):
                    if table in ("content_chunk_parts", "content_embeddings"):
                        residual = session.execute(
                            text(
                                f"""
                                SELECT COUNT(*)
                                FROM {table} t
                                JOIN content_chunks cc ON cc.id = t.chunk_id
                                WHERE cc.owner_kind = 'note_block'
                                  AND cc.owner_id = CAST(:owner_id AS uuid)
                                """
                            ),
                            {"owner_id": str(note_owner_id)},
                        ).scalar_one()
                    else:
                        residual = session.execute(
                            text(
                                f"""
                                SELECT COUNT(*) FROM {table}
                                WHERE owner_kind = 'note_block'
                                  AND owner_id = CAST(:owner_id AS uuid)
                                """
                            ),
                            {"owner_id": str(note_owner_id)},
                        ).scalar_one()
                    assert residual == 0, (
                        f"Expected zero residual {table} rows for the deleted note owner, "
                        f"got {residual}"
                    )

                # The unrelated media-owned retrieval/span must be untouched.
                survivor = session.execute(
                    text(
                        """
                        SELECT mr.evidence_span_id
                        FROM message_retrievals mr
                        WHERE mr.result_type = 'content_chunk'
                        """
                    )
                ).scalar_one()
                assert survivor is not None, (
                    "Media-owned retrieval evidence_span_id must survive the note-scoped delete"
                )
        finally:
            reset_test_schema()
            engine.dispose()

    def test_note_reindex_inflight_index_present_at_head(self):
        """Resource-native note indexing has one in-flight job per note at head."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                row = session.execute(
                    text(
                        """
                        SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid) AS predicate
                        FROM pg_index i
                        JOIN pg_class idx ON idx.oid = i.indexrelid
                        JOIN pg_class tbl ON tbl.oid = i.indrelid
                        WHERE idx.relname = 'uq_note_reindex_job_inflight'
                          AND tbl.relname = 'background_jobs'
                        """
                    )
                ).fetchone()

            assert row is not None, (
                "Expected uq_note_reindex_job_inflight on background_jobs at head"
            )
            indisunique, predicate = row
            assert indisunique is True, (
                f"uq_note_reindex_job_inflight must be unique. indisunique={indisunique}"
            )
            assert predicate is not None, (
                "uq_note_reindex_job_inflight must be a partial index (have a predicate)"
            )
            predicate_lower = predicate.lower()
            assert "note_reindex_job" in predicate_lower, (
                f"Expected partial predicate to scope to note_reindex_job. Predicate={predicate}"
            )
            assert "succeeded" in predicate_lower and "dead" in predicate_lower, (
                f"Expected partial predicate to exclude terminal states. Predicate={predicate}"
            )
        finally:
            # Leave the schema at head (do NOT reset): the next class,
            # TestMediaIntelligenceUnitsMigration0141, uses the module-scoped
            # `migrated_engine` fixture, which is set up once and does not re-upgrade —
            # so it must inherit a head-migrated database from the preceding test.
            engine.dispose()


class TestMediaIntelligenceUnitsMigration0141:
    """Schema assertions for the 0141 per-media intelligence unit tables."""

    def test_head_contains_media_summaries_and_claims(self, migrated_engine):
        with Session(migrated_engine) as session:
            tables = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_name IN ('media_summaries', 'media_claims')
                        """
                    )
                ).fetchall()
            }
            summary_constraints = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT conname, pg_get_constraintdef(oid)
                        FROM pg_constraint
                        WHERE conrelid = 'media_summaries'::regclass
                        """
                    )
                ).fetchall()
            }
            claim_columns = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name, is_nullable
                        FROM information_schema.columns
                        WHERE table_name = 'media_claims'
                        """
                    )
                ).fetchall()
            }
            claim_constraints = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'media_claims'::regclass
                        """
                    )
                ).fetchall()
            }

        assert tables == {"media_summaries", "media_claims"}, (
            "0141 must create both media_summaries and media_claims at head"
        )
        assert "uq_media_summaries_media" in summary_constraints
        assert "ck_media_summaries_status" in summary_constraints
        # evidence_span_id NOT NULL is the physical grounding-by-construction guard (AC-2).
        assert claim_columns.get("evidence_span_id") == "NO", (
            "media_claims.evidence_span_id must be NOT NULL"
        )
        assert "uq_media_claims_summary_ordinal" in claim_constraints
        assert "ck_media_claims_ordinal_non_negative" in claim_constraints

    def test_head_media_intelligence_fks_are_non_cascading(self, migrated_engine):
        with Session(migrated_engine) as session:
            fks = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT confrelid::regclass::text AS referenced_table, confdeltype
                        FROM pg_constraint
                        WHERE conrelid = 'media_claims'::regclass
                          AND contype = 'f'
                        """
                    )
                ).fetchall()
            }
        # 'a' = NO ACTION (no ON DELETE CASCADE; cleanup is explicit, database.md).
        for referenced_table in ("media", "media_summaries", "evidence_spans"):
            assert fks.get(referenced_table) == "a", (
                f"media_claims→{referenced_table} FK must be NO ACTION, got {fks}"
            )

    def test_0141_downgrade_is_blocked(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            assert run_alembic_command("upgrade 0141").returncode == 0
            result = run_alembic_command("downgrade 0140")
            combined = f"{result.stdout}\n{result.stderr}"
            assert result.returncode != 0
            assert "Hard cutover: 0141 is not reversible" in combined
        finally:
            engine.dispose()
            reset_test_schema()


class TestLibraryIntelligenceArtifactRewrite0142:
    """Head-assertions for the 0142 stable-head + immutable-revisions rewrite."""

    @pytest.fixture(scope="class")
    def li_head_engine(self):
        """A freshly head-migrated engine for this class.

        The module-scoped ``migrated_engine`` is migrated once at module start, but
        earlier classes call ``reset_test_schema()`` in their teardown (e.g. the
        downgrade-blocked test), which drops the public schema for every test that
        runs afterward. This class sits at the end of the file, so it owns its own
        reset + upgrade to head rather than inheriting a contaminated schema.
        """
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    # The deterministic-compiler subtables + old head dropped by 0142 (the
    # source-set/version tables were already dropped in 0138; the LI-private
    # citation table folded into resource_edges by 0145).
    _DROPPED_LI_TABLES = (
        "library_intelligence_sections",
        "library_intelligence_nodes",
        "library_intelligence_claims",
        "library_intelligence_evidence",
        "library_intelligence_builds",
        "library_intelligence_versions",
        "library_source_set_versions",
        "library_source_set_items",
        "library_intelligence_citations",
    )
    _NEW_LI_TABLES = (
        "artifacts",
        "artifact_revisions",
        "artifact_revision_events",
    )

    def test_dropped_li_tables_are_gone_at_head(self, li_head_engine):
        with Session(li_head_engine) as session:
            present = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = ANY(:names)
                        """
                    ),
                    {"names": list(self._DROPPED_LI_TABLES)},
                ).fetchall()
            }
        assert present == set(), f"dropped LI tables still present: {present}"

    def test_new_head_revision_tables_present_at_head(self, li_head_engine):
        with Session(li_head_engine) as session:
            present = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = ANY(:names)
                        """
                    ),
                    {"names": list(self._NEW_LI_TABLES)},
                ).fetchall()
            }
        assert present == set(self._NEW_LI_TABLES), f"missing new LI tables: {present}"

    def test_old_artifact_shape_columns_are_gone(self, li_head_engine):
        """The old versioned/status/generator artifact columns must not survive."""
        with Session(li_head_engine) as session:
            columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'artifacts'
                        """
                    )
                ).fetchall()
            }
        removed = {
            "active_version_id",
            "artifact_kind",
            "status",
            "generator_model_id",
            "published_at",
            "invalidated_at",
            "invalid_reason",
        }
        assert removed.isdisjoint(columns), f"stale artifact columns survive: {columns & removed}"
        assert {"current_revision_id", "user_id"}.issubset(columns), columns

    def test_circular_current_revision_fk_present_and_nullable(self, li_head_engine):
        with Session(li_head_engine) as session:
            fk = session.execute(
                text(
                    "SELECT conname FROM pg_constraint "
                    "WHERE conname = 'fk_artifacts_current_revision'"
                )
            ).scalar_one_or_none()
            nullable = session.execute(
                text(
                    """
                    SELECT is_nullable FROM information_schema.columns
                    WHERE table_name = 'artifacts'
                      AND column_name = 'current_revision_id'
                    """
                )
            ).scalar_one()
        assert fk == "fk_artifacts_current_revision"
        # Nullable until the first revision is promoted (circular FK, §11).
        assert nullable == "YES", "current_revision_id must be nullable"

    def test_li_head_and_revision_fks_are_non_cascading(self, li_head_engine):
        with Session(li_head_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT conrelid::regclass::text AS tbl, confdeltype
                    FROM pg_constraint
                    WHERE contype = 'f'
                      AND conrelid IN (
                        'artifacts'::regclass,
                        'artifact_revisions'::regclass,
                        'artifact_revision_events'::regclass
                      )
                    """
                )
            ).fetchall()
        # 'a' = NO ACTION: no ON DELETE CASCADE anywhere in the LI graph (G6).
        assert rows, "expected LI FKs to exist"
        assert {row[1] for row in rows} == {"a"}, f"LI FKs must be NO ACTION; got {rows}"

    def test_revision_events_check_and_unique(self, li_head_engine):
        with Session(li_head_engine) as session:
            constraints = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT conname FROM pg_constraint "
                        "WHERE conrelid = 'artifact_revision_events'::regclass"
                    )
                ).fetchall()
            }
        assert "ck_artifact_revision_events_type" in constraints
        assert "uq_artifact_revision_events_seq" in constraints

    def test_chat_run_events_check_drops_claim_keeps_citation_index(self, li_head_engine):
        with Session(li_head_engine) as session:
            constraint = session.execute(
                text(
                    "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conname = 'ck_chat_run_events_event_type'"
                )
            ).scalar_one()
        assert "claim_evidence" not in constraint
        assert "'claim'" not in constraint
        assert "citation_index" in constraint
        assert "context_ref_added" in constraint

    def test_chat_runs_next_event_seq_column_and_check_are_gone(self, li_head_engine):
        with Session(li_head_engine) as session:
            columns = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name = 'chat_runs'"
                    )
                ).fetchall()
            }
            check = session.execute(
                text(
                    "SELECT conname FROM pg_constraint "
                    "WHERE conname = 'ck_chat_runs_next_event_seq_positive'"
                )
            ).scalar_one_or_none()
        assert "next_event_seq" not in columns
        assert check is None, "the next_event_seq CHECK must be dropped with the column"

    def test_support_status_enum_is_dropped(self, li_head_engine):
        """The orphaned verifier-taxonomy PG enum is gone (finishes 0116)."""
        with Session(li_head_engine) as session:
            present = session.execute(
                text("SELECT 1 FROM pg_type WHERE typname = 'assistant_claim_support_status'")
            ).scalar_one_or_none()
        assert present is None, "assistant_claim_support_status enum must be dropped"

    def test_message_retrievals_telemetry_survives(self, li_head_engine):
        """Anti-over-deletion: retrieval telemetry stays chat-owned (LI AC-11, §8.4).

        The LI cutover left the citation/link stores untouched; the later
        provenance-graph cutover (0145) folded ``conversation_references``,
        ``oracle_reading_passages`` and ``object_links`` into ``resource_edges``
        (see ``test_0145_folds_link_stores_into_resource_edges``). But
        ``message_retrievals`` is never folded — telemetry keeps its own table.
        """
        with Session(li_head_engine) as session:
            present = session.execute(
                text(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_name = 'message_retrievals'"
                )
            ).scalar_one_or_none()
        assert present is not None, "message_retrievals telemetry must survive the cutovers"


class TestMigration0145LlmCallLedgerAndErrorFloor:
    """0145: message_llm -> polymorphic llm_calls + the run-parent error floor."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        """A freshly head-migrated engine for this class.

        Earlier tests (including this class's own data-move test) call
        ``reset_test_schema()`` in their teardown, so the module-scoped
        ``migrated_engine`` cannot be trusted this late in the file — same
        rationale as ``li_head_engine`` above.
        """
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_0145_moves_message_llm_history_and_recuts_oracle_error_columns(self):
        """Seed pre-0145 rows, upgrade, and assert the data moves losslessly.

        Covers: the assistant-message join (one llm_calls row per message_llm
        row that has a chat run; orphans dropped), reasoning_effort taken from
        the run row, the oracle error_message -> error_detail rename preserving
        values, the delta-event interpretation backfill (seq-order concat,
        readings without deltas stay NULL), and the generator_model_id drop.

        Upgrades to 0165 (the last revision before the Oracle corpus cutover):
        the assertions span 0145 (the move/recut) and 0152 (``provider_route``),
        and stopping at 0165 keeps both while avoiding 0166, which wipes ALL
        Oracle reading state and would delete the seeded readings under test.
        """
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0144")
            assert result.returncode == 0, f"upgrade to 0144 failed: {result.stderr}"

            user_id = uuid4()
            model_id = uuid4()
            conversation_id = uuid4()
            run_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            orphan_user_message_id = uuid4()
            orphan_assistant_message_id = uuid4()
            failed_reading_id = uuid4()
            complete_reading_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO models (
                            id, provider, model_name, max_context_tokens, is_available
                        )
                        VALUES (:id, 'anthropic', :model_name, 200000, true)
                        """
                    ),
                    {"id": model_id, "model_name": f"migration-test-{model_id}"},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :owner_user_id, 'private', 5)
                        """
                    ),
                    {"id": conversation_id, "owner_user_id": user_id},
                )
                for message_id, seq, role, parent_id in (
                    (user_message_id, 1, "user", None),
                    (assistant_message_id, 2, "assistant", user_message_id),
                    (orphan_user_message_id, 3, "user", None),
                    (orphan_assistant_message_id, 4, "assistant", orphan_user_message_id),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (
                                id, conversation_id, seq, role, content, status,
                                parent_message_id
                            )
                            VALUES (
                                :id, :conversation_id, :seq, :role, 'migration seed',
                                'complete', :parent_message_id
                            )
                            """
                        ),
                        {
                            "id": message_id,
                            "conversation_id": conversation_id,
                            "seq": seq,
                            "role": role,
                            "parent_message_id": parent_id,
                        },
                    )
                session.execute(
                    text(
                        """
                        INSERT INTO chat_runs (
                            id, owner_user_id, conversation_id, user_message_id,
                            assistant_message_id, idempotency_key, payload_hash,
                            status, model_id, reasoning, key_mode
                        )
                        VALUES (
                            :id, :owner_user_id, :conversation_id, :user_message_id,
                            :assistant_message_id, :idempotency_key, 'hash',
                            'complete', :model_id, 'medium', 'auto'
                        )
                        """
                    ),
                    {
                        "id": run_id,
                        "owner_user_id": user_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                        "idempotency_key": f"migration-{run_id}",
                        "model_id": model_id,
                    },
                )
                # One ledger row joined to the run, one orphan (no chat_runs row
                # points at its message) that the INSERT-SELECT must drop.
                session.execute(
                    text(
                        """
                        INSERT INTO message_llm (
                            message_id, provider, model_name, input_tokens, output_tokens,
                            total_tokens, reasoning_tokens, cache_write_input_tokens,
                            cache_read_input_tokens, cached_input_tokens,
                            key_mode_requested, key_mode_used, latency_ms, error_class,
                            provider_request_id, provider_usage, created_at
                        )
                        VALUES (
                            :message_id, 'anthropic', 'claude-test', 11, 7, 18, 3, 2, 1, 0,
                            'byok_only', 'byok', 1234, 'E_LLM_TIMEOUT', 'req_abc',
                            '{"total_tokens": 18}'::jsonb, '2026-01-02T03:04:05Z'
                        )
                        """
                    ),
                    {"message_id": assistant_message_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO message_llm (
                            message_id, provider, model_name, key_mode_requested, key_mode_used
                        )
                        VALUES (:message_id, 'openai', 'orphan-model', 'auto', 'platform')
                        """
                    ),
                    {"message_id": orphan_assistant_message_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id, user_id, folio_number, question_text, status,
                            error_code, error_message, failed_at, generator_model_id
                        )
                        VALUES (
                            :id, :user_id, 1, 'What fails?', 'failed',
                            'E_INTERNAL', 'operator detail survives the rename', now(),
                            :model_id
                        )
                        """
                    ),
                    {"id": failed_reading_id, "user_id": user_id, "model_id": model_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id, user_id, folio_number, question_text, status, completed_at
                        )
                        VALUES (:id, :user_id, 2, 'What completes?', 'complete', now())
                        """
                    ),
                    {"id": complete_reading_id, "user_id": user_id},
                )
                for seq, event_type, payload in (
                    (1, "argument", '{"text": "not interpretation"}'),
                    (2, "delta", '{"text": "Part one. "}'),
                    (3, "delta", '{"text": "Part two."}'),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO oracle_reading_events (
                                reading_id, seq, event_type, payload
                            )
                            VALUES (:reading_id, :seq, :event_type, CAST(:payload AS jsonb))
                            """
                        ),
                        {
                            "reading_id": complete_reading_id,
                            "seq": seq,
                            "event_type": event_type,
                            "payload": payload,
                        },
                    )
                session.commit()

            result = run_alembic_command("upgrade 0165")
            assert result.returncode == 0, f"upgrade to 0165 failed: {result.stderr}"

            with Session(engine) as session:
                tables = {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT table_name FROM information_schema.tables
                            WHERE table_schema = 'public'
                              AND table_name IN ('llm_calls', 'message_llm')
                            """
                        )
                    ).fetchall()
                }
                assert tables == {"llm_calls"}, (
                    f"expected llm_calls to replace message_llm, got {tables}"
                )

                calls = session.execute(text("SELECT * FROM llm_calls")).mappings().all()
                assert len(calls) == 1, (
                    "exactly the run-joined message_llm row must migrate "
                    f"(orphans dropped), got {[dict(c) for c in calls]}"
                )
                call = calls[0]
                assert call["owner_kind"] == "chat_run"
                assert call["owner_id"] == run_id
                assert call["call_seq"] == 1
                assert call["provider"] == "anthropic"
                assert call["provider_route"] == "anthropic"
                assert call["model_name"] == "claude-test"
                assert call["llm_operation"] == "chat_send"
                assert call["streaming"] is True
                assert call["reasoning_effort"] == "medium", (
                    "reasoning_effort must come from the run row"
                )
                assert call["key_mode_requested"] == "byok_only"
                assert call["key_mode_used"] == "byok"
                assert (
                    call["input_tokens"],
                    call["output_tokens"],
                    call["total_tokens"],
                    call["reasoning_tokens"],
                ) == (11, 7, 18, 3)
                assert (
                    call["cache_write_input_tokens"],
                    call["cache_read_input_tokens"],
                    call["cached_input_tokens"],
                ) == (2, 1, 0)
                assert call["latency_ms"] == 1234
                assert call["error_class"] == "E_LLM_TIMEOUT"
                assert call["error_detail"] is None
                assert call["provider_request_id"] == "req_abc"
                assert call["provider_usage"] == {"total_tokens": 18}
                assert call["cost_status"] == "missing_pricing"
                assert call["total_cost_usd_micros"] is None
                assert call["pricing_snapshot"] == {
                    "pricing_source": "provider_runtime.catalog.DEFAULT_CATALOG",
                    "provider": "anthropic",
                    "model": "claude-test",
                    "route": "anthropic",
                    "cache_write_ttl": None,
                    "pricing": {
                        "input_per_million": None,
                        "output_per_million": None,
                        "cached_input_per_million": None,
                        "cache_write_per_million_by_ttl": {},
                        "reasoning_per_million": None,
                        "reasoning_billing_mode": "unknown",
                        "applies_up_to_input_tokens": None,
                        "source_url": None,
                        "verified_at": None,
                        "currency": "USD",
                        "unit": "per_million_tokens",
                    },
                }
                assert call["created_at"] == datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC), (
                    f"history timestamps must be preserved, got {call['created_at']}"
                )

                reading_columns = {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT column_name FROM information_schema.columns
                            WHERE table_name = 'oracle_readings'
                            """
                        )
                    ).fetchall()
                }
                assert "error_message" not in reading_columns
                assert "generator_model_id" not in reading_columns
                assert {"error_detail", "interpretation_text"}.issubset(reading_columns)

                readings = {
                    row["id"]: row
                    for row in session.execute(
                        text(
                            """
                            SELECT id, error_detail, interpretation_text
                            FROM oracle_readings
                            """
                        )
                    ).mappings()
                }
                assert (
                    readings[failed_reading_id]["error_detail"]
                    == "operator detail survives the rename"
                )
                assert readings[failed_reading_id]["interpretation_text"] is None, (
                    "a reading without delta events must stay NULL"
                )
                assert (
                    readings[complete_reading_id]["interpretation_text"] == "Part one. Part two."
                ), "interpretation must concatenate delta payload text in seq order"
        finally:
            engine.dispose()
            reset_test_schema()

    def test_llm_calls_constraints_enforced_at_head(self, head_engine):
        """The 0145 ledger CHECKs + per-owner call_seq uniqueness reject bad rows."""
        owner_id = uuid4()
        insert_sql = text(
            """
            INSERT INTO llm_calls (
                owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                llm_operation, streaming, reasoning_effort,
                key_mode_requested, key_mode_used, input_tokens, provider_usage,
                total_cost_usd_micros, cost_status, pricing_snapshot
            )
            VALUES (
                :owner_kind, :owner_id, :call_seq, :provider, :provider_route, 'm',
                'chat_send', true, 'none', 'auto', 'platform', :input_tokens,
                CAST(:provider_usage AS jsonb), :total_cost_usd_micros, :cost_status,
                CAST(:pricing_snapshot AS jsonb)
            )
            """
        )

        def good_params() -> dict:
            return {
                "owner_kind": "chat_run",
                "owner_id": owner_id,
                "call_seq": 1,
                "provider": "openai",
                "provider_route": "openai",
                "input_tokens": None,
                "provider_usage": None,
                "total_cost_usd_micros": None,
                "cost_status": "missing_usage",
                "pricing_snapshot": "{}",
            }

        negative_cases = [
            ({"owner_kind": "bogus"}, "ck_llm_calls_owner_kind"),
            ({"call_seq": 0}, "ck_llm_calls_call_seq_positive"),
            ({"provider": "mistral"}, "ck_llm_calls_provider"),
            ({"provider_route": "mistral"}, "ck_llm_calls_provider_route"),
            ({"input_tokens": -1}, "ck_llm_calls_token_counts_non_negative"),
            ({"provider_usage": "[1]"}, "ck_llm_calls_provider_usage_object"),
            ({"total_cost_usd_micros": -1}, "ck_llm_calls_total_cost_non_negative"),
            ({"cost_status": "bogus"}, "ck_llm_calls_cost_status"),
            ({"pricing_snapshot": "[1]"}, "ck_llm_calls_pricing_snapshot_object"),
        ]
        for override, expected_constraint in negative_cases:
            params = good_params()
            params.update(override)
            with Session(head_engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(insert_sql, params)
                    session.commit()
                session.rollback()
            assert expected_constraint in str(exc_info.value), (
                f"expected {expected_constraint} for override {override!r}, got: {exc_info.value}"
            )

        with Session(head_engine) as session:
            session.execute(insert_sql, good_params())
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(insert_sql, good_params())
            session.rollback()
        assert "uq_llm_calls_owner_call_seq" in str(exc_info.value)

        with Session(head_engine) as session:
            bad_attempt_rows = [
                (
                    """
                    INSERT INTO llm_calls (
                        owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                        llm_operation, streaming, reasoning_effort,
                        key_mode_requested, key_mode_used, cost_status, attempt_count, retry_count
                    )
                    VALUES (
                        'chat_run', :owner_id, 1, 'openai', 'openai', 'm',
                        'chat_send', true, 'none', 'auto', 'platform', 'missing_usage', 1, 1
                    )
                    """,
                    "ck_llm_calls_attempt_counts",
                ),
                (
                    """
                    INSERT INTO llm_calls (
                        owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                        llm_operation, streaming, reasoning_effort,
                        key_mode_requested, key_mode_used, cost_status, terminal_attempt_status
                    )
                    VALUES (
                        'chat_run', :owner_id, 1, 'openai', 'openai', 'm',
                        'chat_send', true, 'none', 'auto', 'platform', 'missing_usage', 'unknown'
                    )
                    """,
                    "ck_llm_calls_terminal_attempt_status",
                ),
                (
                    """
                    INSERT INTO llm_calls (
                        owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                        llm_operation, streaming, reasoning_effort,
                        key_mode_requested, key_mode_used, cost_status, provider_attempts
                    )
                    VALUES (
                        'chat_run', :owner_id, 1, 'openai', 'openai', 'm',
                        'chat_send', true, 'none', 'auto', 'platform', 'missing_usage',
                        '{}'::jsonb
                    )
                    """,
                    "ck_llm_calls_provider_attempts_array",
                ),
            ]
            for sql, expected_constraint in bad_attempt_rows:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(text(sql), {"owner_id": uuid4()})
                    session.commit()
                session.rollback()
                assert expected_constraint in str(exc_info.value)

    def test_error_floor_columns_exist_at_head(self, head_engine):
        """Every run parent gained its operator-facing failure columns."""
        with Session(head_engine) as session:
            columns_by_table = {
                table_name: {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT column_name FROM information_schema.columns
                            WHERE table_name = :table_name
                            """
                        ),
                        {"table_name": table_name},
                    ).fetchall()
                }
                for table_name in (
                    "chat_runs",
                    "artifact_revisions",
                    "media_summaries",
                )
            }
        assert "error_detail" in columns_by_table["chat_runs"]
        assert {"error_code", "error_detail"}.issubset(columns_by_table["artifact_revisions"])
        assert {"error_code", "error_detail"}.issubset(columns_by_table["media_summaries"])


class TestMigration0146OracleDoneNormalization:
    """0146: oracle ``error`` events deleted + 8-type CHECK + create idempotency."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        """A freshly head-migrated engine for this class (same rationale as 0145's)."""
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_0146_deletes_error_events_and_keeps_the_rest(self):
        """Seed a pre-0146 failed reading with an ``error`` event; upgrade deletes
        exactly the retired rows (0142 DELETE-then-tighten pattern).

        Pinned to 0146 (the migration under test): 0166 later wipes ALL Oracle
        reading state as a hard cutover, so upgrading to head would delete every
        seeded row and mask this migration's selective deletion.
        """
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0145")
            assert result.returncode == 0, f"upgrade to 0145 failed: {result.stderr}"

            user_id = uuid4()
            failed_reading_id = uuid4()
            complete_reading_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id, user_id, folio_number, question_text, status,
                            error_code, error_detail, failed_at
                        )
                        VALUES (
                            :id, :user_id, 1, 'What fails?', 'failed',
                            'E_INTERNAL', 'operator detail', now()
                        )
                        """
                    ),
                    {"id": failed_reading_id, "user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_readings (
                            id, user_id, folio_number, question_text, status, completed_at
                        )
                        VALUES (:id, :user_id, 2, 'What completes?', 'complete', now())
                        """
                    ),
                    {"id": complete_reading_id, "user_id": user_id},
                )
                for reading_id, seq, event_type, payload in (
                    (failed_reading_id, 1, "meta", '{"question": "What fails?"}'),
                    (failed_reading_id, 2, "error", '{"code": "E_INTERNAL", "message": "x"}'),
                    (complete_reading_id, 1, "meta", '{"question": "What completes?"}'),
                    (complete_reading_id, 2, "done", "{}"),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO oracle_reading_events (
                                reading_id, seq, event_type, payload
                            )
                            VALUES (:reading_id, :seq, :event_type, CAST(:payload AS jsonb))
                            """
                        ),
                        {
                            "reading_id": reading_id,
                            "seq": seq,
                            "event_type": event_type,
                            "payload": payload,
                        },
                    )
                session.commit()

            result = run_alembic_command("upgrade 0146")
            assert result.returncode == 0, f"upgrade to 0146 failed: {result.stderr}"

            with Session(engine) as session:
                events = {
                    (row[0], row[1], row[2])
                    for row in session.execute(
                        text("SELECT reading_id, seq, event_type FROM oracle_reading_events")
                    ).fetchall()
                }
                assert events == {
                    (failed_reading_id, 1, "meta"),
                    (complete_reading_id, 1, "meta"),
                    (complete_reading_id, 2, "done"),
                }, f"only the retired 'error' rows are deleted, got {events}"
                reading_columns = {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT column_name FROM information_schema.columns
                            WHERE table_name = 'oracle_readings'
                            """
                        )
                    ).fetchall()
                }
                assert "idempotency_key" in reading_columns
        finally:
            engine.dispose()
            reset_test_schema()

    def test_oracle_event_check_rejects_error_at_head(self, head_engine):
        """The tightened CHECK forbids the retired ``error`` event type."""
        user_id = uuid4()
        reading_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO oracle_readings (id, user_id, folio_number, question_text, status)
                    VALUES (:id, :user_id, 1, 'May an error event exist?', 'pending')
                    """
                ),
                {"id": reading_id, "user_id": user_id},
            )
            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO oracle_reading_events (reading_id, seq, event_type, payload)
                        VALUES (:reading_id, 1, 'error', '{}'::jsonb)
                        """
                    ),
                    {"reading_id": reading_id},
                )
            session.rollback()
        assert "ck_oracle_reading_events_type" in str(exc_info.value)

    def test_oracle_idempotency_partial_unique_at_head(self, head_engine):
        """(user_id, idempotency_key) is unique only when a key is present;
        NULL keys stay unrestricted and other users may reuse a key."""
        first_user = uuid4()
        second_user = uuid4()

        def insert_reading(session, *, user_id, folio_number, idempotency_key):
            session.execute(
                text(
                    """
                    INSERT INTO oracle_readings (
                        user_id, folio_number, question_text, status, idempotency_key
                    )
                    VALUES (:user_id, :folio_number, 'Same key?', 'pending', :idempotency_key)
                    """
                ),
                {
                    "user_id": user_id,
                    "folio_number": folio_number,
                    "idempotency_key": idempotency_key,
                },
            )

        with Session(head_engine) as session:
            for user_id in (first_user, second_user):
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            insert_reading(session, user_id=first_user, folio_number=1, idempotency_key="key-1")
            insert_reading(session, user_id=second_user, folio_number=1, idempotency_key="key-1")
            insert_reading(session, user_id=first_user, folio_number=2, idempotency_key=None)
            insert_reading(session, user_id=first_user, folio_number=3, idempotency_key=None)
            with pytest.raises(IntegrityError) as exc_info:
                insert_reading(session, user_id=first_user, folio_number=4, idempotency_key="key-1")
            session.rollback()
        assert "uq_oracle_readings_user_idempotency_key" in str(exc_info.value)


class TestMigration0148NotesPagesResourceGraphOrder:
    """0148: ordered resource edges, tag resources, and note view state."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_resource_edges_order_schema_at_head(self, head_engine):
        with Session(head_engine) as session:
            columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'resource_edges'
                        """
                    )
                ).fetchall()
            }
            assert {"source_order_key", "target_order_key"}.issubset(columns)

            note_block_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'note_blocks'
                        """
                    )
                ).fetchall()
            }
            assert {
                "page_id",
                "parent_block_id",
                "order_key",
                "collapsed",
                "block_kind",
                "body_markdown",
            }.isdisjoint(note_block_columns)
            assert {"id", "user_id", "body_pm_json", "body_text"}.issubset(note_block_columns)

            page_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'pages'
                        """
                    )
                ).fetchall()
            }
            assert {"id", "user_id", "title", "created_at", "updated_at"}.issubset(page_columns)
            assert {"description", "document_version"}.isdisjoint(page_columns)

            assert not session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_name = 'page_document_mutations'
                    """
                )
            ).fetchone()

            resource_version_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'resource_versions'
                        """
                    )
                ).fetchall()
            }
            assert {
                "id",
                "user_id",
                "resource_scheme",
                "resource_id",
                "lane",
                "version",
                "content_hash",
                "created_at",
                "updated_at",
            }.issubset(resource_version_columns)

            resource_mutation_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'resource_mutations'
                        """
                    )
                ).fetchall()
            }
            assert {
                "id",
                "user_id",
                "mutation_scope",
                "client_mutation_id",
                "request_hash",
                "changed_lanes",
                "response_json",
                "created_at",
            }.issubset(resource_mutation_columns)

            indexes = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE tablename = 'resource_edges'
                        """
                    )
                ).fetchall()
            }
            assert {
                "uq_resource_edges_citation_ordinal",
                "uq_resource_edges_context_pair",
                "uq_resource_edges_source_order",
                "ix_resource_edges_user_source",
                "ix_resource_edges_user_target",
            }.issubset(indexes)
            assert {
                "uq_resource_edges_containment_source_order",
                "uq_resource_edges_containment_target_once",
            }.isdisjoint(indexes)

            resource_indexes = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE tablename IN ('resource_versions', 'resource_mutations')
                        """
                    )
                ).fetchall()
            }
            assert {
                "uix_resource_versions_lane",
                "uix_resource_mutations_client_id",
            }.issubset(resource_indexes)

            user_id = uuid4()
            source_id = uuid4()
            target_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            for origin in ("user", "note_body"):
                session.execute(
                    text(
                        """
                        INSERT INTO resource_edges (
                            user_id, kind, origin, source_scheme, source_id,
                            target_scheme, target_id
                        )
                        VALUES (
                            :user_id, 'context', :origin, 'note_block', :source_id,
                            'media', :target_id
                        )
                        """
                    ),
                    {
                        "user_id": user_id,
                        "origin": origin,
                        "source_id": source_id,
                        "target_id": target_id,
                    },
                )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO resource_edges (
                            user_id, kind, origin, source_scheme, source_id,
                            target_scheme, target_id
                        )
                        VALUES (
                            :user_id, 'context', 'user', 'note_block', :source_id,
                            'media', :target_id
                        )
                        """
                    ),
                    {"user_id": user_id, "source_id": source_id, "target_id": target_id},
                )
                session.flush()
            session.rollback()
        assert "uq_resource_edges_context_pair" in str(exc_info.value)

    def test_ordered_adjacency_order_is_unique_per_source_at_head(self, head_engine):
        with Session(head_engine) as session:
            user_id = uuid4()
            page_id = uuid4()
            first_block_id = uuid4()
            second_block_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, source_order_key
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'page', :page_id,
                        'note_block', :first_block_id, '0000000001'
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "page_id": page_id,
                    "first_block_id": first_block_id,
                },
            )
            session.commit()

            with pytest.raises(IntegrityError) as exc_info:
                session.execute(
                    text(
                        """
                        INSERT INTO resource_edges (
                            user_id, kind, origin, source_scheme, source_id,
                            target_scheme, target_id, source_order_key
                        )
                        VALUES (
                            :user_id, 'context', 'user', 'page', :page_id,
                            'note_block', :second_block_id, '0000000001'
                        )
                        """
                    ),
                    {
                        "user_id": user_id,
                        "page_id": page_id,
                        "second_block_id": second_block_id,
                    },
                )
                session.flush()
            session.rollback()
        assert "uq_resource_edges_source_order" in str(exc_info.value)

    def test_ordered_adjacency_target_can_be_shared_at_head(self, head_engine):
        with Session(head_engine) as session:
            user_id = uuid4()
            first_page_id = uuid4()
            second_page_id = uuid4()
            block_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, source_order_key
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'page', :page_id,
                        'note_block', :block_id, '0000000001'
                    )
                    """
                ),
                {"user_id": user_id, "page_id": first_page_id, "block_id": block_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, source_order_key
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'page', :page_id,
                        'note_block', :block_id, '0000000001'
                    )
                    """
                ),
                {"user_id": user_id, "page_id": second_page_id, "block_id": block_id},
            )
            session.commit()
            count = session.scalar(
                text(
                    """
                    SELECT COUNT(*)
                    FROM resource_edges
                    WHERE user_id = :user_id
                      AND target_scheme = 'note_block'
                      AND target_id = :block_id
                      AND source_order_key IS NOT NULL
                    """
                ),
                {"user_id": user_id, "block_id": block_id},
            )
        assert count == 2

    def test_resource_view_states_exist_at_head(self, head_engine):
        with Session(head_engine) as session:
            view_state_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'resource_view_states'
                        """
                    )
                ).fetchall()
            }
            assert {
                "id",
                "user_id",
                "surface_scheme",
                "surface_id",
                "edge_id",
                "state",
                "created_at",
                "updated_at",
            }.issubset(view_state_columns)

            user_id = uuid4()
            page_id = uuid4()
            block_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Page')"),
                {"id": page_id, "user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO note_blocks (
                        id, user_id, body_pm_json, body_text
                    )
                    VALUES (
                        :id, :user_id, '{"type":"paragraph"}'::jsonb, 'Block'
                    )
                    """
                ),
                {"id": block_id, "user_id": user_id},
            )
            edge_id = session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, source_order_key
                    )
                    VALUES (
                        :user_id, 'context', 'user', 'page', :page_id,
                        'note_block', :block_id, '0000000001'
                    )
                    RETURNING id
                    """
                ),
                {"user_id": user_id, "page_id": page_id, "block_id": block_id},
            ).scalar_one()
            session.execute(
                text(
                    """
                    INSERT INTO resource_view_states (
                        user_id, surface_scheme, surface_id, edge_id,
                        target_scheme, target_id, state
                    )
                    VALUES (
                        :user_id, 'page', :page_id, :edge_id,
                        'note_block', :block_id, '{"collapsed": true}'::jsonb
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "page_id": page_id,
                    "block_id": block_id,
                    "edge_id": edge_id,
                },
            )
            session.commit()


class TestMigration0151LlmProviderRuntimeCatalog:
    """0151: provider-runtime provider set replaces DeepSeek with OpenRouter/Cloudflare."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_provider_constraints_and_seed_rows_at_head(self, head_engine):
        expected_seed_rows = {
            ("anthropic", "claude-opus-4-8"),
            ("openrouter", "moonshotai/kimi-k2.6"),
            ("openrouter", "openai/gpt-5.5"),
            ("openrouter", "openai/gpt-5.4-mini"),
            ("cloudflare", "@cf/openai/gpt-oss-20b"),
        }

        user_id = uuid4()
        with Session(head_engine) as session:
            seed_rows = {
                tuple(row)
                for row in session.execute(
                    text(
                        """
                        SELECT provider, model_name
                        FROM models
                        WHERE provider IN ('openrouter', 'cloudflare')
                           OR (
                               provider = 'anthropic'
                               AND model_name IN ('claude-opus-4-7', 'claude-opus-4-8')
                           )
                        """
                    )
                ).fetchall()
            }
            assert expected_seed_rows.issubset(seed_rows), (
                f"0151 model seed rows missing: {sorted(expected_seed_rows - seed_rows)}"
            )
            assert ("anthropic", "claude-opus-4-7") not in seed_rows

            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            for provider in ("openrouter", "cloudflare"):
                session.execute(
                    text(
                        """
                        INSERT INTO models (id, provider, model_name, max_context_tokens)
                        VALUES (:id, :provider, :model_name, 8192)
                        """
                    ),
                    {
                        "id": uuid4(),
                        "provider": provider,
                        "model_name": f"constraint-test-{provider}-{uuid4()}",
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO llm_calls (
                            owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                            llm_operation, streaming, reasoning_effort,
                            key_mode_requested, key_mode_used, cost_status
                        )
                        VALUES (
                            'chat_run', :owner_id, 1, :provider, :provider, :model_name,
                            'chat_send', false, 'default', 'auto', 'platform', 'missing_usage'
                        )
                        """
                    ),
                    {
                        "owner_id": uuid4(),
                        "provider": provider,
                        "model_name": f"constraint-test-{provider}",
                    },
                )
            session.execute(
                text(
                    """
                    INSERT INTO user_api_keys (
                        id, user_id, provider, encrypted_key, key_nonce, key_fingerprint
                    )
                    VALUES (:id, :user_id, 'openrouter', :key, :nonce, :fingerprint)
                    """
                ),
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted-key",
                    "nonce": b"x" * 24,
                    "fingerprint": "fp-openrouter",
                },
            )
            session.commit()

        negative_cases = [
            (
                """
                INSERT INTO models (id, provider, model_name, max_context_tokens)
                VALUES (:id, 'deepseek', :model_name, 8192)
                """,
                {"id": uuid4(), "model_name": f"removed-provider-{uuid4()}"},
                "ck_models_provider",
            ),
            (
                """
                INSERT INTO user_api_keys (
                    id, user_id, provider, encrypted_key, key_nonce, key_fingerprint
                )
                VALUES (:id, :user_id, 'deepseek', :key, :nonce, :fingerprint)
                """,
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted-key",
                    "nonce": b"x" * 24,
                    "fingerprint": f"removed-provider-{uuid4()}",
                },
                "ck_user_api_keys_provider",
            ),
            (
                """
                INSERT INTO user_api_keys (
                    id, user_id, provider, encrypted_key, key_nonce, key_fingerprint
                )
                VALUES (:id, :user_id, 'cloudflare', :key, :nonce, :fingerprint)
                """,
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted-key",
                    "nonce": b"x" * 24,
                    "fingerprint": f"cloudflare-byok-disabled-{uuid4()}",
                },
                "ck_user_api_keys_provider",
            ),
            (
                """
                INSERT INTO user_api_keys (
                    id, user_id, provider, encrypted_key, key_nonce, key_fingerprint
                )
                VALUES (:id, :user_id, 'cloudflare', :key, :nonce, :fingerprint)
                """,
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "key": b"encrypted-key",
                    "nonce": b"x" * 24,
                    "fingerprint": f"platform-only-{uuid4()}",
                },
                "ck_user_api_keys_provider",
            ),
            (
                """
                INSERT INTO llm_calls (
                    owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                    llm_operation, streaming, reasoning_effort,
                    key_mode_requested, key_mode_used, cost_status
                )
                VALUES (
                    'chat_run', :owner_id, 1, 'deepseek', 'openai', 'removed-model',
                    'chat_send', false, 'default', 'auto', 'platform', 'missing_usage'
                )
                """,
                {"owner_id": uuid4()},
                "ck_llm_calls_provider",
            ),
        ]
        for sql, params, expected_constraint in negative_cases:
            with Session(head_engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(text(sql), params)
                    session.commit()
                session.rollback()
            assert expected_constraint in str(exc_info.value), (
                f"expected {expected_constraint}, got: {exc_info.value}"
            )

    def test_0151_deletes_deepseek_dependents_before_provider_removal(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0150")
            assert result.returncode == 0, f"upgrade to 0150 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            deepseek_model_id = uuid4()
            deepseek_model_name = f"deepseek-cutover-{deepseek_model_id}"
            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            run_id = uuid4()
            prompt_assembly_id = uuid4()
            event_id = uuid4()
            llm_owner_id = uuid4()
            key_id = uuid4()
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            """
                            INSERT INTO models (
                                id, provider, model_name, max_context_tokens, is_available
                            )
                            VALUES (:id, 'deepseek', :model_name, 64000, true)
                            """
                        ),
                        {"id": deepseek_model_id, "model_name": deepseek_model_name},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 3)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (id, conversation_id, seq, role, content, status)
                            VALUES (:id, :conversation_id, 1, 'user', 'deepseek seed', 'complete')
                            """
                        ),
                        {"id": user_message_id, "conversation_id": conversation_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (
                                id, conversation_id, seq, role, content, status, parent_message_id
                            )
                            VALUES (
                                :id, :conversation_id, 2, 'assistant', 'deepseek reply',
                                'complete', :parent_message_id
                            )
                            """
                        ),
                        {
                            "id": assistant_message_id,
                            "conversation_id": conversation_id,
                            "parent_message_id": user_message_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_runs (
                                id, owner_user_id, conversation_id, user_message_id,
                                assistant_message_id, idempotency_key, payload_hash,
                                status, model_id, reasoning, key_mode
                            )
                            VALUES (
                                :id, :owner_user_id, :conversation_id, :user_message_id,
                                :assistant_message_id, :idempotency_key, 'hash',
                                'complete', :model_id, 'none', 'auto'
                            )
                            """
                        ),
                        {
                            "id": run_id,
                            "owner_user_id": user_id,
                            "conversation_id": conversation_id,
                            "user_message_id": user_message_id,
                            "assistant_message_id": assistant_message_id,
                            "idempotency_key": f"deepseek-{run_id}",
                            "model_id": deepseek_model_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_prompt_assemblies (
                                id, chat_run_id, conversation_id, assistant_message_id,
                                model_id, cacheable_input_tokens_estimate,
                                max_context_tokens, reserved_output_tokens,
                                reserved_reasoning_tokens, input_budget_tokens,
                                estimated_input_tokens
                            )
                            VALUES (
                                :id, :chat_run_id, :conversation_id, :assistant_message_id,
                                :model_id, 0, 64000, 1, 1, 100, 10
                            )
                            """
                        ),
                        {
                            "id": prompt_assembly_id,
                            "chat_run_id": run_id,
                            "conversation_id": conversation_id,
                            "assistant_message_id": assistant_message_id,
                            "model_id": deepseek_model_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                            VALUES (:id, :run_id, 1, 'done', '{}'::jsonb)
                            """
                        ),
                        {"id": event_id, "run_id": run_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO llm_calls (
                                owner_kind, owner_id, call_seq, provider, model_name,
                                llm_operation, streaming, reasoning_effort,
                                key_mode_requested, key_mode_used
                            )
                            VALUES (
                                'chat_run', :owner_id, 1, 'deepseek', :model_name,
                                'chat_send', false, 'none', 'auto', 'platform'
                            )
                            """
                        ),
                        {"owner_id": llm_owner_id, "model_name": deepseek_model_name},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO user_api_keys (
                                id, user_id, provider, encrypted_key, key_nonce, key_fingerprint
                            )
                            VALUES (:id, :user_id, 'deepseek', :key, :nonce, :fingerprint)
                            """
                        ),
                        {
                            "id": key_id,
                            "user_id": user_id,
                            "key": b"encrypted-key",
                            "nonce": b"x" * 24,
                            "fingerprint": "seek",
                        },
                    )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    counts = session.execute(
                        text(
                            """
                            SELECT
                                (SELECT count(*) FROM chat_prompt_assemblies WHERE id = :assembly_id),
                                (SELECT count(*) FROM chat_run_events WHERE id = :event_id),
                                (SELECT count(*) FROM chat_runs WHERE id = :run_id),
                                (SELECT count(*) FROM llm_calls WHERE provider = 'deepseek'),
                                (SELECT count(*) FROM user_api_keys WHERE provider = 'deepseek'),
                                (SELECT count(*) FROM models WHERE provider = 'deepseek')
                            """
                        ),
                        {
                            "assembly_id": prompt_assembly_id,
                            "event_id": event_id,
                            "run_id": run_id,
                        },
                    ).one()
                    assert tuple(counts) == (0, 0, 0, 0, 0, 0)
            finally:
                engine.dispose()
        finally:
            reset_test_schema()


class TestMigration0148NotesPagesBackfill:
    """0148 backfills old note tree columns into graph containment edges."""

    def _insert_0147_user_page_block(
        self,
        session: Session,
        *,
        user_id,
        page_id,
        block_id,
        title: str = "Page",
        parent_id=None,
        order_key: str = "0000000001",
        body: str = "Block",
    ) -> None:
        user_exists = session.execute(
            text("SELECT 1 FROM users WHERE id = :id"),
            {"id": user_id},
        ).scalar_one_or_none()
        if user_exists is None:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        page_exists = session.execute(
            text("SELECT 1 FROM pages WHERE id = :id"),
            {"id": page_id},
        ).scalar_one_or_none()
        if page_exists is None:
            session.execute(
                text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, :title)"),
                {"id": page_id, "user_id": user_id, "title": title},
            )
        session.execute(
            text(
                """
                INSERT INTO note_blocks (
                    id, user_id, page_id, parent_block_id, order_key, body_pm_json, body_text
                )
                VALUES (
                    :id, :user_id, :page_id, :parent_id, :order_key,
                    '{"type":"paragraph"}'::jsonb, :body
                )
                """
            ),
            {
                "id": block_id,
                "user_id": user_id,
                "page_id": page_id,
                "parent_id": parent_id,
                "order_key": order_key,
                "body": body,
            },
        )

    def _assert_0148_preflight_failure(self, expected_message: str) -> None:
        result = run_alembic_command("upgrade head")
        combined = f"{result.stdout}\n{result.stderr}"
        assert result.returncode != 0
        assert expected_message in combined

    def test_rejects_note_block_owned_by_different_user_than_page(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            page_user_id = uuid4()
            block_user_id = uuid4()
            page_id = uuid4()
            block_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": page_user_id})
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": block_user_id})
                session.execute(
                    text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Page')"),
                    {"id": page_id, "user_id": page_user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO note_blocks (
                            id, user_id, page_id, order_key, body_pm_json, body_text
                        )
                        VALUES (
                            :id, :user_id, :page_id, '0000000001',
                            '{"type":"paragraph"}'::jsonb, 'Block'
                        )
                        """
                    ),
                    {"id": block_id, "user_id": block_user_id, "page_id": page_id},
                )
                session.commit()
            engine.dispose()

            result = run_alembic_command("upgrade head")
            combined = f"{result.stdout}\n{result.stderr}"
            assert result.returncode != 0
            assert "note block page crosses user boundary" in combined
        finally:
            reset_test_schema()

    def test_rejects_note_block_parent_owned_by_different_user(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            child_user_id = uuid4()
            parent_user_id = uuid4()
            child_page_id = uuid4()
            parent_page_id = uuid4()
            child_block_id = uuid4()
            parent_block_id = uuid4()
            with Session(engine) as session:
                self._insert_0147_user_page_block(
                    session,
                    user_id=parent_user_id,
                    page_id=parent_page_id,
                    block_id=parent_block_id,
                    title="Parent page",
                )
                self._insert_0147_user_page_block(
                    session,
                    user_id=child_user_id,
                    page_id=child_page_id,
                    block_id=child_block_id,
                    title="Child page",
                    parent_id=parent_block_id,
                )
                session.commit()
            engine.dispose()

            self._assert_0148_preflight_failure("note block parent crosses user boundary")
        finally:
            reset_test_schema()

    def test_rejects_note_block_parent_on_different_page(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            user_id = uuid4()
            child_page_id = uuid4()
            parent_page_id = uuid4()
            child_block_id = uuid4()
            parent_block_id = uuid4()
            with Session(engine) as session:
                self._insert_0147_user_page_block(
                    session,
                    user_id=user_id,
                    page_id=parent_page_id,
                    block_id=parent_block_id,
                    title="Parent page",
                )
                self._insert_0147_user_page_block(
                    session,
                    user_id=user_id,
                    page_id=child_page_id,
                    block_id=child_block_id,
                    title="Child page",
                    parent_id=parent_block_id,
                )
                session.commit()
            engine.dispose()

            self._assert_0148_preflight_failure("note block parent crosses page boundary")
        finally:
            reset_test_schema()

    def test_rejects_note_block_self_parent(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            user_id = uuid4()
            page_id = uuid4()
            block_id = uuid4()
            with Session(engine) as session:
                self._insert_0147_user_page_block(
                    session,
                    user_id=user_id,
                    page_id=page_id,
                    block_id=block_id,
                )
                session.execute(
                    text("UPDATE note_blocks SET parent_block_id = :id WHERE id = :id"),
                    {"id": block_id},
                )
                session.commit()
            engine.dispose()

            self._assert_0148_preflight_failure("note block cannot parent itself")
        finally:
            reset_test_schema()

    def test_rejects_note_block_containment_cycle(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            user_id = uuid4()
            page_id = uuid4()
            first_block_id = uuid4()
            second_block_id = uuid4()
            with Session(engine) as session:
                self._insert_0147_user_page_block(
                    session,
                    user_id=user_id,
                    page_id=page_id,
                    block_id=first_block_id,
                    order_key="0000000001",
                )
                self._insert_0147_user_page_block(
                    session,
                    user_id=user_id,
                    page_id=page_id,
                    block_id=second_block_id,
                    order_key="0000000002",
                )
                session.execute(
                    text(
                        """
                        UPDATE note_blocks
                        SET parent_block_id = CASE
                            WHEN id = :first_block_id THEN :second_block_id
                            WHEN id = :second_block_id THEN :first_block_id
                            ELSE parent_block_id
                        END
                        WHERE id IN (:first_block_id, :second_block_id)
                        """
                    ),
                    {
                        "first_block_id": first_block_id,
                        "second_block_id": second_block_id,
                    },
                )
                session.commit()
            engine.dispose()

            self._assert_0148_preflight_failure("note block containment cycle")
        finally:
            reset_test_schema()

    def test_backfills_ordered_adjacency_and_resource_view_state(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0147")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to 0147 failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            user_id = uuid4()
            page_id = uuid4()
            first_block_id = uuid4()
            second_block_id = uuid4()
            child_block_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Page')"),
                    {"id": page_id, "user_id": user_id},
                )
                for block_id, parent_id, order_key, collapsed, body, created_at in (
                    (second_block_id, None, "same", False, "Second", "2026-01-01T00:00:02Z"),
                    (first_block_id, None, "same", False, "First", "2026-01-01T00:00:01Z"),
                    (
                        child_block_id,
                        first_block_id,
                        "child",
                        True,
                        "Child",
                        "2026-01-01T00:00:03Z",
                    ),
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO note_blocks (
                                id, user_id, page_id, parent_block_id, order_key,
                                body_pm_json, body_text, collapsed, created_at
                            )
                            VALUES (
                                :id, :user_id, :page_id, :parent_id, :order_key,
                                '{"type":"paragraph"}'::jsonb, :body, :collapsed, :created_at
                            )
                            """
                        ),
                        {
                            "id": block_id,
                            "user_id": user_id,
                            "page_id": page_id,
                            "parent_id": parent_id,
                            "order_key": order_key,
                            "collapsed": collapsed,
                            "body": body,
                            "created_at": created_at,
                        },
                    )
                session.commit()
            engine.dispose()

            result = run_alembic_command("upgrade head")
            if result.returncode != 0:
                pytest.fail(f"Migration upgrade to head failed: {result.stderr}")

            engine = create_engine(get_test_database_url())
            with Session(engine) as session:
                page_children = session.execute(
                    text(
                        """
                        SELECT target_id, source_order_key
                        FROM resource_edges
                        WHERE user_id = :user_id
                          AND origin = 'user'
                          AND source_scheme = 'page'
                          AND source_id = :page_id
                        ORDER BY source_order_key ASC
                        """
                    ),
                    {"user_id": user_id, "page_id": page_id},
                ).fetchall()
                child_rows = session.execute(
                    text(
                        """
                        SELECT target_id, source_order_key
                        FROM resource_edges
                        WHERE user_id = :user_id
                          AND origin = 'user'
                          AND source_scheme = 'note_block'
                          AND source_id = :first_block_id
                        """
                    ),
                    {"user_id": user_id, "first_block_id": first_block_id},
                ).fetchall()
                collapsed_rows = session.execute(
                    text(
                        """
                        SELECT surface_scheme, surface_id, target_id,
                               (state ->> 'collapsed')::boolean
                        FROM resource_view_states
                        WHERE user_id = :user_id
                        """
                    ),
                    {"user_id": user_id},
                ).fetchall()
            engine.dispose()

            assert [(row[0], row[1]) for row in page_children] == [
                (first_block_id, "0000000001"),
                (second_block_id, "0000000002"),
            ]
            assert [(row[0], row[1]) for row in child_rows] == [(child_block_id, "0000000001")]
            assert collapsed_rows == [("note_block", first_block_id, child_block_id, True)]
        finally:
            reset_test_schema()


# The scannable resource-graph schemes. synapse_suppressions mirrors these, not
# every resource_edges scheme ever introduced. 0166 swapped the dropped
# oracle_corpus_passage scheme for oracle_passage_anchor across these CHECKs.
RESOURCE_EDGE_SCHEMES = (
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "oracle_reading",
    "oracle_passage_anchor",
    "artifact",
    "external_snapshot",
    "contributor",
    "podcast",
)


class TestMigration0149SynapseResonance:
    """0149: 'synapse' origin + 'synapse_scan' ledger owner + the suppression memory."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        """A freshly head-migrated engine for this class (same rationale as 0145's)."""
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _constraint_def(self, session, table: str, conname: str) -> str:
        return session.execute(
            text(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = CAST(:table AS regclass) AND conname = :conname
                """
            ),
            {"table": table, "conname": conname},
        ).scalar_one()

    def test_0149_downgrade_restores_narrowed_vocabulary(self):
        """0149 is additive and reversible: downgrade drops the suppression
        table and restores the pre-synapse origin/owner CHECKs."""
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            # Upgrade to 0149 specifically, not head: a later hard-cutover
            # migration (0150 reader-apparatus) is irreversible, so downgrading
            # *through* it would fail; this isolates 0149's own downgrade.
            assert run_alembic_command("upgrade 0149").returncode == 0
            # 0149's down_revision is 0148 (the notes/pages cutover); 0148 is a
            # hard cutover with no downgrade, so 0149 reverses exactly one step
            # back to 0148's pre-synapse origin/owner vocabulary.
            result = run_alembic_command("downgrade 0148")
            assert result.returncode == 0, f"downgrade to 0148 failed: {result.stderr}"
            with Session(engine) as session:
                tables = {
                    row[0]
                    for row in session.execute(
                        text(
                            """
                            SELECT table_name FROM information_schema.tables
                            WHERE table_schema = 'public'
                            """
                        )
                    ).fetchall()
                }
                origin_check = self._constraint_def(
                    session, "resource_edges", "ck_resource_edges_origin"
                )
                owner_check = self._constraint_def(session, "llm_calls", "ck_llm_calls_owner_kind")
            assert "synapse_suppressions" not in tables
            assert "'synapse'" not in origin_check, origin_check
            assert "'synapse_scan'" not in owner_check, owner_check
        finally:
            engine.dispose()
            reset_test_schema()

    def test_widened_vocabulary_checks_at_head(self, head_engine):
        """ck_resource_edges_origin admits 'synapse'; ck_llm_calls_owner_kind
        admits 'synapse_scan'; both keep every pre-0149 value."""
        with Session(head_engine) as session:
            origin_check = self._constraint_def(
                session, "resource_edges", "ck_resource_edges_origin"
            )
            owner_check = self._constraint_def(session, "llm_calls", "ck_llm_calls_owner_kind")
        for origin in (
            "user",
            "citation",
            "system",
            "note_body",
            "highlight_note",
            "synapse",
        ):
            assert f"'{origin}'" in origin_check, origin_check
        for owner_kind in (
            "chat_run",
            "oracle_reading",
            "artifact_revision",
            "media_summary",
            "media_enrichment",
            "synapse_scan",
        ):
            assert f"'{owner_kind}'" in owner_check, owner_check

    def test_resource_edge_vocab_checks_match_backend_literals_at_head(self, head_engine):
        from nexus.services.resource_graph.refs import RESOURCE_SCHEMES
        from nexus.services.resource_graph.schemas import EDGE_KINDS, EDGE_ORIGINS

        with Session(head_engine) as session:
            checks = {
                name: self._constraint_def(session, "resource_edges", name)
                for name in (
                    "ck_resource_edges_kind",
                    "ck_resource_edges_origin",
                    "ck_resource_edges_source_scheme",
                    "ck_resource_edges_target_scheme",
                )
            }

        assert set(re.findall(r"'([^']+)'", checks["ck_resource_edges_kind"])) == set(EDGE_KINDS)
        assert set(re.findall(r"'([^']+)'", checks["ck_resource_edges_origin"])) == set(
            EDGE_ORIGINS
        )
        assert set(re.findall(r"'([^']+)'", checks["ck_resource_edges_source_scheme"])) == set(
            RESOURCE_SCHEMES
        )
        assert set(re.findall(r"'([^']+)'", checks["ck_resource_edges_target_scheme"])) == set(
            RESOURCE_SCHEMES
        )

    def test_resource_edge_scheme_checks_include_li_revision_at_head(self, head_engine):
        user_id = uuid4()
        source_id = uuid4()
        target_id = uuid4()
        with Session(head_engine) as session:
            source_check = self._constraint_def(
                session, "resource_edges", "ck_resource_edges_source_scheme"
            )
            target_check = self._constraint_def(
                session, "resource_edges", "ck_resource_edges_target_scheme"
            )
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id
                    )
                    VALUES (
                        :user_id, 'context', 'user',
                        'artifact_revision', :source_id,
                        'artifact_revision', :target_id
                    )
                    """
                ),
                {"user_id": user_id, "source_id": source_id, "target_id": target_id},
            )
            session.commit()

        assert "'artifact_revision'" in source_check, source_check
        assert "'artifact_revision'" in target_check, target_check

    def test_synapse_suppressions_shape_at_head(self, head_engine):
        """The dismissal memory exists with exact columns, five-column PK,
        verbatim scheme CHECKs, and the reverse-direction index."""
        with Session(head_engine) as session:
            columns = {
                row[0]: (row[1], row[2])
                for row in session.execute(
                    text(
                        """
                        SELECT column_name, data_type, is_nullable
                        FROM information_schema.columns
                        WHERE table_name = 'synapse_suppressions'
                        """
                    )
                ).fetchall()
            }
            pk_def = session.execute(
                text(
                    """
                    SELECT pg_get_constraintdef(oid)
                    FROM pg_constraint
                    WHERE conrelid = 'synapse_suppressions'::regclass AND contype = 'p'
                    """
                )
            ).scalar_one()
            source_check = self._constraint_def(
                session, "synapse_suppressions", "ck_synapse_suppressions_source_scheme"
            )
            target_check = self._constraint_def(
                session, "synapse_suppressions", "ck_synapse_suppressions_target_scheme"
            )
            indexes = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname, indexdef FROM pg_indexes
                        WHERE tablename = 'synapse_suppressions'
                        """
                    )
                ).fetchall()
            }

        assert columns == {
            "user_id": ("uuid", "NO"),
            "source_scheme": ("text", "NO"),
            "source_id": ("uuid", "NO"),
            "target_scheme": ("text", "NO"),
            "target_id": ("uuid", "NO"),
            "created_at": ("timestamp with time zone", "NO"),
        }, columns
        assert pk_def == (
            "PRIMARY KEY (user_id, source_scheme, source_id, target_scheme, target_id)"
        ), pk_def
        for scheme in RESOURCE_EDGE_SCHEMES:
            assert f"'{scheme}'" in source_check, source_check
            assert f"'{scheme}'" in target_check, target_check
        assert "ix_synapse_suppressions_user_target" in indexes, indexes
        assert (
            "(user_id, target_scheme, target_id)"
            in (indexes["ix_synapse_suppressions_user_target"])
        )

    def test_suppression_constraints_enforced_at_head(self, head_engine):
        """The scheme CHECKs and the pair PK reject bad rows; a widened-origin
        edge and a synapse_scan ledger row insert cleanly."""
        user_id = uuid4()
        insert_sql = text(
            """
            INSERT INTO synapse_suppressions (
                user_id, source_scheme, source_id, target_scheme, target_id
            )
            VALUES (:user_id, :source_scheme, :source_id, :target_scheme, :target_id)
            """
        )
        params = {
            "user_id": user_id,
            "source_scheme": "highlight",
            "source_id": uuid4(),
            "target_scheme": "media",
            "target_id": uuid4(),
        }

        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(insert_sql, params)
            # The widened CHECKs accept the new vocabulary.
            session.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, snapshot
                    )
                    VALUES (
                        :user_id, 'supports', 'synapse', 'highlight', :source_id,
                        'media', :target_id,
                        CAST('{"title": "t", "excerpt": "why"}' AS jsonb)
                    )
                    """
                ),
                {"user_id": user_id, "source_id": uuid4(), "target_id": uuid4()},
            )
            session.execute(
                text(
                    """
                    INSERT INTO llm_calls (
                        owner_kind, owner_id, call_seq, provider, provider_route, model_name,
                        llm_operation, streaming, reasoning_effort,
                        key_mode_requested, key_mode_used, cost_status
                    )
                    VALUES (
                        'synapse_scan', :owner_id, 1, 'anthropic', 'anthropic', 'm',
                        'synapse_scan', false, 'none', 'auto', 'platform', 'missing_usage'
                    )
                    """
                ),
                {"owner_id": uuid4()},
            )
            session.commit()

        for override, expected_constraint in (
            ({"source_scheme": "bogus"}, "ck_synapse_suppressions_source_scheme"),
            ({"target_scheme": "bogus"}, "ck_synapse_suppressions_target_scheme"),
            ({}, "synapse_suppressions_pkey"),  # exact re-dismissal is idempotent-by-PK
        ):
            with Session(head_engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(insert_sql, {**params, **override})
                    session.commit()
                session.rollback()
            assert expected_constraint in str(exc_info.value), (
                f"expected {expected_constraint} for override {override!r}, got: {exc_info.value}"
            )


class TestMigration0153ChatRunPolicyConstraints:
    """0153: chat_runs persists explicit reasoning and key-mode vocabularies."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_chat_run_policy_constraints_enforced_at_head(self, head_engine):
        user_id = uuid4()
        conversation_id = uuid4()
        user_message_id = uuid4()
        assistant_message_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            model_id = session.execute(
                text(
                    """
                    SELECT id
                    FROM models
                    WHERE provider = 'openai'
                      AND model_name = 'gpt-5.4-mini'
                    """
                )
            ).scalar_one()
            session.execute(
                text(
                    """
                    INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                    VALUES (:id, :owner_user_id, 'private', 3)
                    """
                ),
                {"id": conversation_id, "owner_user_id": user_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conversation_id, 1, 'user', 'hello', 'complete')
                    """
                ),
                {"id": user_message_id, "conversation_id": conversation_id},
            )
            session.execute(
                text(
                    """
                    INSERT INTO messages (
                        id, conversation_id, seq, role, content, status, parent_message_id
                    )
                    VALUES (
                        :id, :conversation_id, 2, 'assistant', 'hi', 'complete',
                        :parent_message_id
                    )
                    """
                ),
                {
                    "id": assistant_message_id,
                    "conversation_id": conversation_id,
                    "parent_message_id": user_message_id,
                },
            )
            session.commit()

        negative_cases = [
            ("legacy-reasoning", "turbo", "auto", "ck_chat_runs_reasoning"),
            ("legacy-key-mode", "none", "byok", "ck_chat_runs_key_mode"),
        ]
        for idempotency_key, reasoning, key_mode, expected_constraint in negative_cases:
            with Session(head_engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_runs (
                                owner_user_id, conversation_id, user_message_id,
                                assistant_message_id, idempotency_key, payload_hash, status,
                                model_id, reasoning, key_mode
                            )
                            VALUES (
                                :owner_user_id, :conversation_id, :user_message_id,
                                :assistant_message_id, :idempotency_key, 'hash', 'queued',
                                :model_id, :reasoning, :key_mode
                            )
                            """
                        ),
                        {
                            "owner_user_id": user_id,
                            "conversation_id": conversation_id,
                            "user_message_id": user_message_id,
                            "assistant_message_id": assistant_message_id,
                            "idempotency_key": idempotency_key,
                            "model_id": model_id,
                            "reasoning": reasoning,
                            "key_mode": key_mode,
                        },
                    )
                    session.commit()
                session.rollback()
            assert expected_constraint in str(exc_info.value)

    def test_0153_canonicalizes_legacy_chat_run_key_modes(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0152")
            assert result.returncode == 0, f"upgrade to 0152 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    model_id = session.execute(
                        text(
                            """
                            SELECT id
                            FROM models
                            WHERE provider = 'openai'
                              AND model_name = 'gpt-5.4-mini'
                            """
                        )
                    ).scalar_one()
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 3)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (id, conversation_id, seq, role, content, status)
                            VALUES (:id, :conversation_id, 1, 'user', 'hello', 'complete')
                            """
                        ),
                        {"id": user_message_id, "conversation_id": conversation_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (
                                id, conversation_id, seq, role, content, status, parent_message_id
                            )
                            VALUES (
                                :id, :conversation_id, 2, 'assistant', 'hi', 'complete',
                                :parent_message_id
                            )
                            """
                        ),
                        {
                            "id": assistant_message_id,
                            "conversation_id": conversation_id,
                            "parent_message_id": user_message_id,
                        },
                    )
                    for key_mode in ("byok", "platform"):
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_runs (
                                    id, owner_user_id, conversation_id, user_message_id,
                                    assistant_message_id, idempotency_key, payload_hash, status,
                                    model_id, reasoning, key_mode
                                )
                                VALUES (
                                    :id, :owner_user_id, :conversation_id, :user_message_id,
                                    :assistant_message_id, :idempotency_key, 'hash', 'queued',
                                    :model_id, 'none', :key_mode
                                )
                                """
                            ),
                            {
                                "id": uuid4(),
                                "owner_user_id": user_id,
                                "conversation_id": conversation_id,
                                "user_message_id": user_message_id,
                                "assistant_message_id": assistant_message_id,
                                "idempotency_key": f"legacy-{key_mode}",
                                "model_id": model_id,
                                "key_mode": key_mode,
                            },
                        )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade 0153")
            assert result.returncode == 0, f"upgrade to 0153 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    rows = {
                        tuple(row)
                        for row in session.execute(
                            text(
                                """
                                SELECT idempotency_key, key_mode
                                FROM chat_runs
                                WHERE idempotency_key LIKE 'legacy-%'
                                """
                            )
                        ).fetchall()
                    }
            finally:
                engine.dispose()
            assert rows == {
                ("legacy-byok", "byok_only"),
                ("legacy-platform", "platform_only"),
            }
        finally:
            reset_test_schema()


class TestMigration0154TokenBudgetChargesPolymorphic:
    """0154: token budget charge idempotency is keyed by reservation id."""

    def test_0154_renames_message_id_and_removes_message_fk(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0153")
            assert result.returncode == 0, f"upgrade to 0153 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    before_columns = set(
                        session.execute(
                            text(
                                """
                                SELECT column_name
                                FROM information_schema.columns
                                WHERE table_name = 'token_budget_charges'
                                """
                            )
                        ).scalars()
                    )
                    before_fks = set(
                        session.execute(
                            text(
                                """
                                SELECT conname
                                FROM pg_constraint
                                WHERE conrelid = 'token_budget_charges'::regclass
                                  AND contype = 'f'
                                """
                            )
                        ).scalars()
                    )
            finally:
                engine.dispose()

            assert "message_id" in before_columns
            assert "reservation_id" not in before_columns
            assert "token_budget_charges_message_id_fkey" in before_fks

            result = run_alembic_command("upgrade 0154")
            assert result.returncode == 0, f"upgrade to 0154 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    after_columns = set(
                        session.execute(
                            text(
                                """
                                SELECT column_name
                                FROM information_schema.columns
                                WHERE table_name = 'token_budget_charges'
                                """
                            )
                        ).scalars()
                    )
                    after_fks = set(
                        session.execute(
                            text(
                                """
                                SELECT conname
                                FROM pg_constraint
                                WHERE conrelid = 'token_budget_charges'::regclass
                                  AND contype = 'f'
                                """
                            )
                        ).scalars()
                    )
            finally:
                engine.dispose()

            assert "reservation_id" in after_columns
            assert "message_id" not in after_columns
            assert "token_budget_charges_message_id_fkey" not in after_fks
            assert "token_budget_charges_user_id_fkey" in after_fks
        finally:
            reset_test_schema()


class TestMigration0155AssistantMessageTrustTrail:
    """0155: assistant message trust trail strips legacy message-document telemetry."""

    def test_0155_strips_retrieval_blocks_and_backfills_reference_edge_key(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0154")
            assert result.returncode == 0, f"upgrade to 0154 failed: {result.stderr}"

            user_id = uuid4()
            model_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            run_id = uuid4()
            before_document = {
                "type": "message_document",
                "blocks": [
                    {"type": "text", "format": "markdown", "text": "First"},
                    {"type": "retrieval_result", "result_type": "media", "source_id": "old"},
                    {"type": "text", "format": "markdown", "text": "Second"},
                    {"type": "tool_result", "tool_name": "old"},
                ],
            }

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            """
                            INSERT INTO models (id, provider, model_name, max_context_tokens)
                            VALUES (:id, 'openai', 'migration-test', 100000)
                            """
                        ),
                        {"id": model_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 3)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (
                                id, conversation_id, seq, role, content, status, message_document
                            )
                            VALUES (
                                :id, :conversation_id, 1, 'user', 'Question', 'complete',
                                CAST(:message_document AS jsonb)
                            )
                            """
                        ),
                        {
                            "id": user_message_id,
                            "conversation_id": conversation_id,
                            "message_document": json.dumps(
                                {
                                    "type": "message_document",
                                    "blocks": [
                                        {"type": "text", "format": "plain", "text": "Question"}
                                    ],
                                }
                            ),
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO messages (
                                id, conversation_id, seq, role, content, status,
                                parent_message_id, message_document
                            )
                            VALUES (
                                :id, :conversation_id, 2, 'assistant', 'First\n\nSecond',
                                'complete', :parent_message_id, CAST(:message_document AS jsonb)
                            )
                            """
                        ),
                        {
                            "id": assistant_message_id,
                            "conversation_id": conversation_id,
                            "parent_message_id": user_message_id,
                            "message_document": json.dumps(before_document),
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_runs (
                                id, owner_user_id, conversation_id, user_message_id,
                                assistant_message_id, idempotency_key, payload_hash, status,
                                model_id, reasoning, key_mode
                            )
                            VALUES (
                                :id, :owner_user_id, :conversation_id, :user_message_id,
                                :assistant_message_id, 'migration-0155', 'hash', 'complete',
                                :model_id, 'default', 'auto'
                            )
                            """
                        ),
                        {
                            "id": run_id,
                            "owner_user_id": user_id,
                            "conversation_id": conversation_id,
                            "user_message_id": user_message_id,
                            "assistant_message_id": assistant_message_id,
                            "model_id": model_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                            VALUES (
                                :run_id, 1, 'reference_added',
                                CAST(:payload AS jsonb)
                            )
                            """
                        ),
                        {
                            "run_id": run_id,
                            "payload": json.dumps(
                                {
                                    "id": str(uuid4()),
                                    "conversation_id": str(conversation_id),
                                    "resource_ref": f"media:{uuid4()}",
                                    "label": "Source",
                                    "summary": "",
                                    "missing": False,
                                    "created_at": datetime.now(UTC).isoformat(),
                                }
                            ),
                        },
                    )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade 0155")
            assert result.returncode == 0, f"upgrade to 0155 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    after_document = session.execute(
                        text("SELECT message_document FROM messages WHERE id = :id"),
                        {"id": assistant_message_id},
                    ).scalar_one()
                    payload = session.execute(
                        text("SELECT payload FROM chat_run_events WHERE run_id = :run_id"),
                        {"run_id": run_id},
                    ).scalar_one()
            finally:
                engine.dispose()

            assert after_document["blocks"] == [
                {"type": "text", "format": "markdown", "text": "First"},
                {"type": "text", "format": "markdown", "text": "Second"},
            ]
            assert "citation_edge_id" in payload
            assert payload["citation_edge_id"] is None
        finally:
            reset_test_schema()


class TestMigration0157ResourceEdgeDbParity:
    """0157: resource_edges database CHECKs match the head edge policy."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_resource_edge_parity_constraints_at_head(self, head_engine):
        with Session(head_engine) as session:
            constraints = set(
                session.execute(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'resource_edges'::regclass
                        """
                    )
                ).scalars()
            )
            indexes = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname, indexdef
                        FROM pg_indexes
                        WHERE tablename = 'resource_edges'
                        """
                    )
                ).fetchall()
            }

        assert {
            "ck_resource_edges_no_self_edge",
            "ck_resource_edges_source_order_key_shape",
            "ck_resource_edges_target_order_key_reserved",
            "ck_resource_edges_synapse_snapshot_excerpt",
            "ck_resource_edges_citation_shape",
            "ck_resource_edges_system_shape",
            "ck_resource_edges_note_body_shape",
            "ck_resource_edges_synapse_shape",
        }.issubset(constraints)
        assert "ck_resource_edges_target_order_key_length" not in constraints
        assert "uq_resource_edges_containment_target_order" not in indexes
        assert "target_order_key" not in indexes["ix_resource_edges_user_target"]

    def test_resource_edge_parity_constraints_are_enforced_at_head(self, head_engine):
        user_id = uuid4()
        insert_edge = text(
            """
            INSERT INTO resource_edges (
                user_id, kind, origin, source_scheme, source_id,
                target_scheme, target_id, source_order_key, target_order_key,
                ordinal, snapshot
            )
            VALUES (
                :user_id, :kind, :origin, :source_scheme, :source_id,
                :target_scheme, :target_id, :source_order_key, :target_order_key,
                :ordinal, CAST(:snapshot AS jsonb)
            )
            """
        )
        base = {
            "user_id": user_id,
            "kind": "context",
            "origin": "user",
            "source_scheme": "page",
            "source_id": uuid4(),
            "target_scheme": "media",
            "target_id": uuid4(),
            "source_order_key": None,
            "target_order_key": None,
            "ordinal": None,
            "snapshot": None,
        }

        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                insert_edge,
                {
                    **base,
                    "origin": "user",
                    "source_scheme": "page",
                    "source_id": uuid4(),
                    "target_scheme": "note_block",
                    "target_id": uuid4(),
                    "source_order_key": "0000000001",
                },
            )
            for origin in ("user", "citation", "system"):
                session.execute(
                    insert_edge,
                    {
                        **base,
                        "origin": origin,
                        "source_scheme": "conversation",
                        "source_id": uuid4(),
                        "target_scheme": "media",
                        "target_id": uuid4(),
                        "source_order_key": f"ctx-{origin}",
                    },
                )
            session.execute(
                insert_edge,
                {
                    **base,
                    "kind": "supports",
                    "origin": "synapse",
                    "source_id": uuid4(),
                    "target_id": uuid4(),
                    "snapshot": '{"excerpt": "Shared claim."}',
                },
            )
            session.execute(
                insert_edge,
                {
                    **base,
                    "origin": "citation",
                    "source_scheme": "message",
                    "source_id": uuid4(),
                    "target_scheme": "media",
                    "target_id": uuid4(),
                    "ordinal": 1,
                    "snapshot": '{"excerpt": "Cited evidence."}',
                },
            )
            session.commit()

        same_id = uuid4()
        cases = [
            (
                {
                    "source_scheme": "page",
                    "target_scheme": "page",
                    "source_id": same_id,
                    "target_id": same_id,
                },
                "ck_resource_edges_no_self_edge",
            ),
            ({"target_order_key": "reserved"}, "ck_resource_edges_target_order_key_reserved"),
            (
                {
                    "origin": "note_body",
                    "source_scheme": "conversation",
                    "source_order_key": "bad",
                },
                "ck_resource_edges_note_body_shape",
            ),
            (
                {
                    "kind": "supports",
                    "source_scheme": "conversation",
                    "source_order_key": "bad",
                },
                "ck_resource_edges_source_order_key_shape",
            ),
            (
                {"origin": "citation", "source_scheme": "page"},
                "ck_resource_edges_citation_shape",
            ),
            (
                {
                    "origin": "citation",
                    "source_scheme": "artifact",
                    "ordinal": 1,
                    "snapshot": '{"excerpt": "Artifact head citation"}',
                },
                "ck_resource_edges_citation_shape",
            ),
            (
                {
                    "origin": "citation",
                    "source_scheme": "conversation",
                    "ordinal": 1,
                    "snapshot": '{"excerpt": "Conversation citation"}',
                },
                "ck_resource_edges_citation_shape",
            ),
            (
                {"origin": "system", "source_scheme": "page"},
                "ck_resource_edges_system_shape",
            ),
            (
                {"origin": "note_body", "source_scheme": "media"},
                "ck_resource_edges_note_body_shape",
            ),
            (
                {"origin": "synapse", "source_scheme": "conversation"},
                "ck_resource_edges_synapse_shape",
            ),
            (
                {"origin": "synapse", "target_scheme": "artifact_revision"},
                "ck_resource_edges_synapse_shape",
            ),
            (
                {"kind": "supports", "origin": "synapse", "snapshot": '{"title": "No rationale"}'},
                "ck_resource_edges_synapse_snapshot_excerpt",
            ),
            (
                {"kind": "supports", "origin": "synapse", "snapshot": None},
                "ck_resource_edges_synapse_snapshot_excerpt",
            ),
        ]
        for override, expected_constraint in cases:
            with Session(head_engine) as session:
                with pytest.raises(IntegrityError) as exc_info:
                    params = {
                        **base,
                        "source_id": uuid4(),
                        "target_id": uuid4(),
                        **override,
                    }
                    session.execute(
                        insert_edge,
                        params,
                    )
                    session.commit()
                session.rollback()
            assert expected_constraint in str(exc_info.value), (
                f"expected {expected_constraint} for override {override!r}, got: {exc_info.value}"
            )


class TestMigration0158ContextRefAddedEventType:
    """0158: chat-run replay uses context_ref_added at head."""

    def test_0158_renames_reference_added_event_type(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0157")
            assert result.returncode == 0, f"upgrade to 0157 failed: {result.stderr}"

            user_id = uuid4()
            model_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            run_id = uuid4()
            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            """
                            INSERT INTO models (id, provider, model_name, max_context_tokens)
                            VALUES (:id, 'openai', 'migration-test', 100000)
                            """
                        ),
                        {"id": model_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 3)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    for message_id, seq, role, content in (
                        (user_message_id, 1, "user", "Question"),
                        (assistant_message_id, 2, "assistant", "Answer"),
                    ):
                        session.execute(
                            text(
                                """
                                INSERT INTO messages (
                                    id, conversation_id, seq, role, content, status,
                                    parent_message_id, message_document
                                )
                                VALUES (
                                    :id, :conversation_id, :seq, :role, :content, 'complete',
                                    :parent_message_id,
                                    '{"type": "message_document", "blocks": []}'::jsonb
                                )
                                """
                            ),
                            {
                                "id": message_id,
                                "conversation_id": conversation_id,
                                "seq": seq,
                                "role": role,
                                "content": content,
                                "parent_message_id": (
                                    user_message_id if message_id == assistant_message_id else None
                                ),
                            },
                        )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_runs (
                                id, owner_user_id, conversation_id, user_message_id,
                                assistant_message_id, idempotency_key, payload_hash, status,
                                model_id, reasoning, key_mode
                            )
                            VALUES (
                                :id, :owner_user_id, :conversation_id, :user_message_id,
                                :assistant_message_id, 'migration-0158', 'hash', 'complete',
                                :model_id, 'default', 'auto'
                            )
                            """
                        ),
                        {
                            "id": run_id,
                            "owner_user_id": user_id,
                            "conversation_id": conversation_id,
                            "user_message_id": user_message_id,
                            "assistant_message_id": assistant_message_id,
                            "model_id": model_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                            VALUES (:run_id, 1, 'reference_added', '{}'::jsonb)
                            """
                        ),
                        {"run_id": run_id},
                    )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade 0158")
            assert result.returncode == 0, f"upgrade to 0158 failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    event_type = session.execute(
                        text("SELECT event_type FROM chat_run_events WHERE run_id = :run_id"),
                        {"run_id": run_id},
                    ).scalar_one()
                    constraint = session.execute(
                        text(
                            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                            "WHERE conname = 'ck_chat_run_events_event_type'"
                        )
                    ).scalar_one()
                    with pytest.raises(IntegrityError) as exc_info:
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                                VALUES (:run_id, 2, 'reference_added', '{}'::jsonb)
                                """
                            ),
                            {"run_id": run_id},
                        )
                        session.commit()
                    session.rollback()
            finally:
                engine.dispose()

            assert event_type == "context_ref_added"
            assert "context_ref_added" in constraint
            assert "reference_added" not in constraint
            assert "ck_chat_run_events_event_type" in str(exc_info.value)
        finally:
            reset_test_schema()


class TestMigration0159DropConversationMedia:
    """0159: conversation context membership is no longer a table contract."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_conversation_media_table_is_absent_at_head(self, head_engine):
        with Session(head_engine) as session:
            table_name = session.execute(
                text("SELECT to_regclass('public.conversation_media')")
            ).scalar_one()
        assert table_name is None


class TestMigration0163DropUserGraphTags:
    """0163: user graph tags are removed from storage and scheme vocabularies."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _constraint_def(self, session, table: str, conname: str) -> str:
        return session.execute(
            text(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = CAST(:table AS regclass) AND conname = :conname
                """
            ),
            {"table": table, "conname": conname},
        ).scalar_one()

    def test_user_graph_tag_schema_absent_at_head(self, head_engine):
        from nexus.services.resource_graph.refs import RESOURCE_SCHEMES

        with Session(head_engine) as session:
            assert session.scalar(text("SELECT to_regclass('public.tags')")) is None
            checks = {
                "resource_edges": (
                    self._constraint_def(
                        session, "resource_edges", "ck_resource_edges_source_scheme"
                    ),
                    self._constraint_def(
                        session, "resource_edges", "ck_resource_edges_target_scheme"
                    ),
                ),
                "resource_versions": (
                    self._constraint_def(
                        session,
                        "resource_versions",
                        "ck_resource_versions_resource_scheme",
                    ),
                ),
                "resource_view_states": (
                    self._constraint_def(
                        session,
                        "resource_view_states",
                        "ck_resource_view_states_surface_scheme",
                    ),
                    self._constraint_def(
                        session,
                        "resource_view_states",
                        "ck_resource_view_states_target_scheme",
                    ),
                ),
                "chat_run_turn_contexts": (
                    self._constraint_def(
                        session,
                        "chat_run_turn_contexts",
                        "ck_chat_run_turn_contexts_requested_subject_scheme",
                    ),
                    self._constraint_def(
                        session,
                        "chat_run_turn_contexts",
                        "ck_chat_run_turn_contexts_subject_scheme",
                    ),
                ),
            }

        for table, table_checks in checks.items():
            for check in table_checks:
                schemes = set(re.findall(r"'([^']+)'", check))
                assert "tag" not in schemes, f"{table} still admits tag: {check}"
                assert schemes == set(RESOURCE_SCHEMES), f"{table} drifted: {check}"

    def test_0163_deletes_and_normalizes_existing_tag_data(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0162")
            assert result.returncode == 0, f"upgrade to 0162 failed: {result.stderr}"

            user_id = uuid4()
            model_id = uuid4()
            page_id = uuid4()
            block_id = uuid4()
            tag_id = uuid4()
            second_tag_id = uuid4()
            tag_edge_id = uuid4()
            conversation_id = uuid4()
            run_delete_id = uuid4()
            run_keep_id = uuid4()
            message_ids = [uuid4(), uuid4(), uuid4(), uuid4()]

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            """
                            INSERT INTO models (id, provider, model_name, max_context_tokens)
                            VALUES (:id, 'openai', 'migration-test', 100000)
                            """
                        ),
                        {"id": model_id},
                    )
                    session.execute(
                        text(
                            "INSERT INTO pages (id, user_id, title) "
                            "VALUES (:id, :user_id, 'Tagged page')"
                        ),
                        {"id": page_id, "user_id": user_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO tags (id, user_id, name, slug)
                            VALUES
                                (:tag_id, :user_id, 'SOTA', 'sota'),
                                (:second_tag_id, :user_id, 'AI', 'ai')
                            """
                        ),
                        {
                            "tag_id": tag_id,
                            "second_tag_id": second_tag_id,
                            "user_id": user_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO note_blocks (
                                id, user_id, body_pm_json, body_text
                            )
                            VALUES (:id, :user_id, CAST(:body_pm_json AS jsonb), 'stale')
                            """
                        ),
                        {
                            "id": block_id,
                            "user_id": user_id,
                            "body_pm_json": json.dumps(
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {"type": "text", "text": "before "},
                                        {
                                            "type": "object_ref",
                                            "attrs": {
                                                "objectType": "tag",
                                                "objectId": str(tag_id),
                                                "label": "stale label",
                                            },
                                        },
                                        {"type": "text", "text": " after "},
                                        {
                                            "type": "object_ref",
                                            "attrs": {
                                                "object_type": "tag",
                                                "object_id": str(second_tag_id),
                                            },
                                        },
                                    ],
                                }
                            ),
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO resource_edges (
                                id, user_id, kind, origin, source_scheme, source_id,
                                target_scheme, target_id
                            )
                            VALUES (
                                :id, :user_id, 'context', 'note_body', 'note_block', :block_id,
                                'tag', :tag_id
                            )
                            """
                        ),
                        {
                            "id": tag_edge_id,
                            "user_id": user_id,
                            "block_id": block_id,
                            "tag_id": tag_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO resource_versions (
                                user_id, resource_scheme, resource_id, lane
                            )
                            VALUES (:user_id, 'tag', :tag_id, 'body')
                            """
                        ),
                        {"user_id": user_id, "tag_id": tag_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO resource_view_states (
                                user_id, surface_scheme, surface_id, edge_id,
                                target_scheme, target_id, state
                            )
                            VALUES (
                                :user_id, 'page', :page_id, :edge_id,
                                'tag', :tag_id, '{"collapsed": true}'::jsonb
                            )
                            """
                        ),
                        {
                            "user_id": user_id,
                            "page_id": page_id,
                            "edge_id": tag_edge_id,
                            "tag_id": tag_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 5)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    for index, message_id, parent_message_id in (
                        (1, message_ids[0], None),
                        (2, message_ids[1], message_ids[0]),
                        (3, message_ids[2], None),
                        (4, message_ids[3], message_ids[2]),
                    ):
                        session.execute(
                            text(
                                """
                                INSERT INTO messages (
                                    id, conversation_id, seq, role, content, status,
                                    parent_message_id, message_document
                                )
                                VALUES (
                                    :id, :conversation_id, :seq, :role, :content,
                                    'complete', :parent_message_id,
                                    '{"type": "message_document", "blocks": []}'::jsonb
                                )
                                """
                            ),
                            {
                                "id": message_id,
                                "conversation_id": conversation_id,
                                "seq": index,
                                "role": "user" if index in {1, 3} else "assistant",
                                "content": f"message {index}",
                                "parent_message_id": parent_message_id,
                            },
                        )
                    for run_id, user_message_id, assistant_message_id in (
                        (run_delete_id, message_ids[0], message_ids[1]),
                        (run_keep_id, message_ids[2], message_ids[3]),
                    ):
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_runs (
                                    id, owner_user_id, conversation_id, user_message_id,
                                    assistant_message_id, idempotency_key, payload_hash,
                                    status, model_id, reasoning, key_mode
                                )
                                VALUES (
                                    :id, :owner_user_id, :conversation_id, :user_message_id,
                                    :assistant_message_id, :idempotency_key, 'hash',
                                    'complete', :model_id, 'default', 'auto'
                                )
                                """
                            ),
                            {
                                "id": run_id,
                                "owner_user_id": user_id,
                                "conversation_id": conversation_id,
                                "user_message_id": user_message_id,
                                "assistant_message_id": assistant_message_id,
                                "idempotency_key": str(run_id),
                                "model_id": model_id,
                            },
                        )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_turn_contexts (
                                chat_run_id, requested_subject_scheme, requested_subject_id,
                                subject_scheme, subject_id
                            )
                            VALUES (:run_id, 'tag', :tag_id, 'tag', :tag_id)
                            """
                        ),
                        {"run_id": run_delete_id, "tag_id": tag_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_turn_contexts (
                                chat_run_id, requested_subject_scheme, requested_subject_id,
                                subject_scheme, subject_id, subject_context_edge_id,
                                reader_selection_media_id, reader_selection_highlight_id
                            )
                            VALUES (
                                :run_id, 'tag', :tag_id, 'tag', :tag_id, :edge_id,
                                :media_id, :highlight_id
                            )
                            """
                        ),
                        {
                            "run_id": run_keep_id,
                            "tag_id": tag_id,
                            "edge_id": tag_edge_id,
                            "media_id": uuid4(),
                            "highlight_id": uuid4(),
                        },
                    )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    assert session.scalar(text("SELECT to_regclass('public.tags')")) is None
                    body_pm_json, body_text = session.execute(
                        text("SELECT body_pm_json, body_text FROM note_blocks WHERE id = :id"),
                        {"id": block_id},
                    ).one()
                    assert body_pm_json == {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "before "},
                            {"type": "text", "text": "#SOTA"},
                            {"type": "text", "text": " after "},
                            {"type": "text", "text": "#AI"},
                        ],
                    }
                    assert body_text == "before #SOTA after #AI"
                    assert (
                        session.scalar(
                            text(
                                """
                            SELECT count(*) FROM resource_edges
                            WHERE source_scheme = 'tag' OR target_scheme = 'tag'
                            """
                            )
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                "SELECT count(*) FROM resource_versions WHERE resource_scheme = 'tag'"
                            )
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                """
                            SELECT count(*) FROM resource_view_states
                            WHERE surface_scheme = 'tag' OR target_scheme = 'tag'
                            """
                            )
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                """
                            SELECT count(*) FROM chat_run_turn_contexts
                            WHERE requested_subject_scheme = 'tag'
                               OR subject_scheme = 'tag'
                            """
                            )
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                """
                            SELECT count(*) FROM chat_run_turn_contexts
                            WHERE chat_run_id = :run_id
                            """
                            ),
                            {"run_id": run_delete_id},
                        )
                        == 0
                    )
                    kept = session.execute(
                        text(
                            """
                            SELECT requested_subject_scheme, requested_subject_id,
                                   subject_scheme, subject_id, subject_context_edge_id,
                                   reader_selection_highlight_id
                            FROM chat_run_turn_contexts
                            WHERE chat_run_id = :run_id
                            """
                        ),
                        {"run_id": run_keep_id},
                    ).one()
                    assert kept[0] is None
                    assert kept[1] is None
                    assert kept[2] is None
                    assert kept[3] is None
                    assert kept[4] is None
                    assert kept[5] is not None
            finally:
                engine.dispose()
        finally:
            reset_test_schema()


class TestMigration0166OracleCorpusLibrary:
    """0166: the Oracle corpus becomes a real library of indexed media.

    The Oracle-owned text/vector corpus (``oracle_corpus_works`` /
    ``oracle_corpus_passages``) is dropped, ``oracle_corpus_images`` is renamed to
    ``oracle_plates`` (without its text embeddings), and the new
    ``oracle_corpus_sources`` / ``oracle_passage_anchors`` mapping + ``libraries.system_key``
    are added. The ``oracle_corpus_passage`` resource scheme is swapped for
    ``oracle_passage_anchor`` across every scheme CHECK.
    """

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _has_column(self, session, table: str, column: str) -> bool:
        return (
            session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = :table AND column_name = :column
                    """
                ),
                {"table": table, "column": column},
            ).first()
            is not None
        )

    def _constraint_def(self, session, table: str, conname: str) -> str:
        return session.execute(
            text(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = CAST(:table AS regclass) AND conname = :conname
                """
            ),
            {"table": table, "conname": conname},
        ).scalar_one()

    def test_head_oracle_corpus_library_schema_contract(self, head_engine):
        with Session(head_engine) as session:
            # New tables exist; the old Oracle-owned corpus vector store is gone.
            assert (
                session.scalar(text("SELECT to_regclass('public.oracle_corpus_sources')"))
                is not None
            )
            assert (
                session.scalar(text("SELECT to_regclass('public.oracle_passage_anchors')"))
                is not None
            )
            assert session.scalar(text("SELECT to_regclass('public.oracle_plates')")) is not None
            assert (
                session.scalar(text("SELECT to_regclass('public.oracle_corpus_works')")) is None
            ), "0166 must drop oracle_corpus_works"
            assert (
                session.scalar(text("SELECT to_regclass('public.oracle_corpus_passages')")) is None
            ), "0166 must drop oracle_corpus_passages"
            assert (
                session.scalar(text("SELECT to_regclass('public.oracle_corpus_images')")) is None
            ), "0166 must rename oracle_corpus_images -> oracle_plates"

            # libraries.system_key is added.
            assert self._has_column(session, "libraries", "system_key"), (
                "0166 must add libraries.system_key"
            )

            # The renamed plates table drops its text embeddings.
            assert not self._has_column(session, "oracle_plates", "embedding"), (
                "0166 must drop oracle_plates.embedding"
            )
            assert not self._has_column(session, "oracle_plates", "embedding_model"), (
                "0166 must drop oracle_plates.embedding_model"
            )
            resolution_check = self._constraint_def(
                session,
                "oracle_passage_anchors",
                "ck_oracle_passage_anchors_resolution_state",
            )
            assert "resolution_status = 'resolved'" in resolution_check
            assert "current_content_chunk_id IS NOT NULL" in resolution_check
            assert "resolution_error IS NULL" in resolution_check

            # The scheme CHECK swapped oracle_corpus_passage -> oracle_passage_anchor.
            scheme_check = session.execute(
                text(
                    """
                    SELECT pg_get_constraintdef(oid)
                    FROM pg_constraint
                    WHERE conrelid = 'resource_edges'::regclass
                      AND conname = 'ck_resource_edges_target_scheme'
                    """
                )
            ).scalar_one()
        schemes = set(re.findall(r"'([^']+)'", scheme_check))
        assert "oracle_corpus_passage" not in schemes, (
            f"0166 must drop the oracle_corpus_passage scheme: {scheme_check}"
        )
        assert "oracle_passage_anchor" in schemes, (
            f"0166 must admit the oracle_passage_anchor scheme: {scheme_check}"
        )

    def test_0166_normalizes_old_oracle_chat_contexts_before_scheme_cutover(self):
        reset_test_schema()
        try:
            result = run_alembic_command("upgrade 0165")
            assert result.returncode == 0, f"upgrade to 0165 failed: {result.stderr}"

            user_id = uuid4()
            model_id = uuid4()
            conversation_id = uuid4()
            old_reading_id = uuid4()
            old_passage_id = uuid4()
            old_edge_id = uuid4()
            run_delete_id = uuid4()
            run_keep_id = uuid4()
            highlight_id = uuid4()
            message_ids = [uuid4(), uuid4(), uuid4(), uuid4()]

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            """
                            INSERT INTO models (id, provider, model_name, max_context_tokens)
                            VALUES (:id, 'openai', 'migration-test', 100000)
                            """
                        ),
                        {"id": model_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                            VALUES (:id, :owner_user_id, 'private', 5)
                            """
                        ),
                        {"id": conversation_id, "owner_user_id": user_id},
                    )
                    for index, message_id, parent_message_id in (
                        (1, message_ids[0], None),
                        (2, message_ids[1], message_ids[0]),
                        (3, message_ids[2], None),
                        (4, message_ids[3], message_ids[2]),
                    ):
                        session.execute(
                            text(
                                """
                                INSERT INTO messages (
                                    id, conversation_id, seq, role, content, status,
                                    parent_message_id, message_document
                                )
                                VALUES (
                                    :id, :conversation_id, :seq, :role, :content,
                                    'complete', :parent_message_id,
                                    '{"type": "message_document", "blocks": []}'::jsonb
                                )
                                """
                            ),
                            {
                                "id": message_id,
                                "conversation_id": conversation_id,
                                "seq": index,
                                "role": "user" if index in {1, 3} else "assistant",
                                "content": f"message {index}",
                                "parent_message_id": parent_message_id,
                            },
                        )
                    for run_id, user_message_id, assistant_message_id in (
                        (run_delete_id, message_ids[0], message_ids[1]),
                        (run_keep_id, message_ids[2], message_ids[3]),
                    ):
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_runs (
                                    id, owner_user_id, conversation_id, user_message_id,
                                    assistant_message_id, idempotency_key, payload_hash,
                                    status, model_id, reasoning, key_mode
                                )
                                VALUES (
                                    :id, :owner_user_id, :conversation_id, :user_message_id,
                                    :assistant_message_id, :idempotency_key, 'hash',
                                    'complete', :model_id, 'default', 'auto'
                                )
                                """
                            ),
                            {
                                "id": run_id,
                                "owner_user_id": user_id,
                                "conversation_id": conversation_id,
                                "user_message_id": user_message_id,
                                "assistant_message_id": assistant_message_id,
                                "idempotency_key": str(run_id),
                                "model_id": model_id,
                            },
                        )
                    session.execute(
                        text(
                            """
                            INSERT INTO resource_edges (
                                id, user_id, kind, origin, source_scheme, source_id,
                                target_scheme, target_id
                            )
                            VALUES (
                                :id, :user_id, 'context', 'user',
                                'oracle_reading', :old_reading_id,
                                'oracle_corpus_passage', :old_passage_id
                            )
                            """
                        ),
                        {
                            "id": old_edge_id,
                            "user_id": user_id,
                            "old_reading_id": old_reading_id,
                            "old_passage_id": old_passage_id,
                        },
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_turn_contexts (
                                chat_run_id, requested_subject_scheme, requested_subject_id,
                                subject_scheme, subject_id
                            )
                            VALUES (
                                :run_id, 'oracle_corpus_passage', :old_passage_id,
                                'oracle_corpus_passage', :old_passage_id
                            )
                            """
                        ),
                        {"run_id": run_delete_id, "old_passage_id": old_passage_id},
                    )
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_turn_contexts (
                                chat_run_id, requested_subject_scheme, requested_subject_id,
                                subject_scheme, subject_id, subject_context_edge_id,
                                reader_selection_media_id, reader_selection_highlight_id
                            )
                            VALUES (
                                :run_id, 'oracle_reading', :old_reading_id,
                                'oracle_reading', :old_reading_id, :old_edge_id,
                                :media_id, :highlight_id
                            )
                            """
                        ),
                        {
                            "run_id": run_keep_id,
                            "old_reading_id": old_reading_id,
                            "old_edge_id": old_edge_id,
                            "media_id": uuid4(),
                            "highlight_id": highlight_id,
                        },
                    )
                    session.commit()
            finally:
                engine.dispose()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            engine = create_engine(get_test_database_url())
            try:
                with Session(engine) as session:
                    assert (
                        session.scalar(
                            text(
                                """
                                SELECT count(*) FROM resource_edges
                                WHERE source_scheme IN ('oracle_reading', 'oracle_corpus_passage')
                                   OR target_scheme IN ('oracle_reading', 'oracle_corpus_passage')
                                """
                            )
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                """
                                SELECT count(*) FROM chat_run_turn_contexts
                                WHERE requested_subject_scheme IN (
                                    'oracle_reading', 'oracle_corpus_passage'
                                )
                                   OR subject_scheme IN (
                                    'oracle_reading', 'oracle_corpus_passage'
                                )
                                   OR subject_context_edge_id = :old_edge_id
                                """
                            ),
                            {"old_edge_id": old_edge_id},
                        )
                        == 0
                    )
                    assert (
                        session.scalar(
                            text(
                                """
                                SELECT count(*) FROM chat_run_turn_contexts
                                WHERE chat_run_id = :run_id
                                """
                            ),
                            {"run_id": run_delete_id},
                        )
                        == 0
                    )
                    kept = session.execute(
                        text(
                            """
                            SELECT requested_subject_scheme, requested_subject_id,
                                   subject_scheme, subject_id, subject_context_edge_id,
                                   reader_selection_highlight_id
                            FROM chat_run_turn_contexts
                            WHERE chat_run_id = :run_id
                            """
                        ),
                        {"run_id": run_keep_id},
                    ).one()
                    assert kept[0] is None
                    assert kept[1] is None
                    assert kept[2] is None
                    assert kept[3] is None
                    assert kept[4] is None
                    assert kept[5] == highlight_id
            finally:
                engine.dispose()
        finally:
            reset_test_schema()

    def test_0166_downgrade_is_blocked(self):
        reset_test_schema()
        try:
            assert run_alembic_command("upgrade 0166").returncode == 0

            result = run_alembic_command("downgrade 0165")

            assert result.returncode != 0
            combined = (result.stdout or "") + (result.stderr or "")
            assert "no downgrade path" in combined or "NotImplementedError" in combined
        finally:
            reset_test_schema()


class TestMigration0167SotaChatStreamingHardCutover:
    def test_0167_deletes_legacy_events_and_enforces_new_event_names(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0166")
            assert result.returncode == 0, f"upgrade to 0166 failed: {result.stderr}"

            user_id = uuid4()
            conversation_id = uuid4()
            user_message_id = uuid4()
            assistant_message_id = uuid4()
            model_id = uuid4()
            run_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        """
                        INSERT INTO models (id, provider, model_name, max_context_tokens)
                        VALUES (:id, 'openai', 'migration-test', 100000)
                        """
                    ),
                    {"id": model_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
                        VALUES (:id, :owner_user_id, 'private', 3)
                        """
                    ),
                    {"id": conversation_id, "owner_user_id": user_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status, parent_message_id
                        )
                        VALUES
                          (:user_message_id, :conversation_id, 1, 'user', 'hi', 'complete', null),
                          (
                            :assistant_message_id, :conversation_id, 2, 'assistant', '', 'pending',
                            :user_message_id
                          )
                        """
                    ),
                    {
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                        "conversation_id": conversation_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO chat_runs (
                            id, owner_user_id, conversation_id, user_message_id,
                            assistant_message_id, idempotency_key, payload_hash,
                            status, model_id, reasoning, key_mode
                        )
                        VALUES (
                            :id, :owner_user_id, :conversation_id, :user_message_id,
                            :assistant_message_id, :idempotency_key, 'hash',
                            'running', :model_id, 'none', 'auto'
                        )
                        """
                    ),
                    {
                        "id": run_id,
                        "owner_user_id": user_id,
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                        "assistant_message_id": assistant_message_id,
                        "idempotency_key": f"migration-{run_id}",
                        "model_id": model_id,
                    },
                )
                session.execute(
                    text(
                        """
                        INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                        VALUES
                          (:run_id, 1, 'delta', '{"text":"old"}'::jsonb),
                          (:run_id, 2, 'tool_call', '{"tool_name":"old"}'::jsonb),
                          (:run_id, 3, 'retrieval_result', '{"tool_name":"old"}'::jsonb),
                          (:run_id, 4, 'context_ref_added', '{"tool_name":"old"}'::jsonb)
                        """
                    ),
                    {"run_id": run_id},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade to head failed: {result.stderr}"

            with Session(engine) as session:
                stale_count = session.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM chat_run_events
                        WHERE run_id = :run_id
                          AND event_type IN (
                            'delta', 'tool_call', 'retrieval_result', 'context_ref_added'
                          )
                        """
                    ),
                    {"run_id": run_id},
                ).scalar_one()
                assert stale_count == 0

                constraint = session.execute(
                    text(
                        """
                        SELECT pg_get_constraintdef(oid)
                        FROM pg_constraint
                        WHERE conrelid = 'chat_run_events'::regclass
                          AND conname = 'ck_chat_run_events_event_type'
                        """
                    )
                ).scalar_one()
                assert "assistant_text_delta" in constraint
                assert "tool_result" in constraint
                assert "retrieval_result" not in constraint

                session.execute(
                    text(
                        """
                        INSERT INTO messages (
                            id, conversation_id, seq, role, content, status, parent_message_id
                        )
                        VALUES (
                            :id, :conversation_id, 3, 'assistant', 'Request cancelled.',
                            'cancelled', :user_message_id
                        )
                        """
                    ),
                    {
                        "id": uuid4(),
                        "conversation_id": conversation_id,
                        "user_message_id": user_message_id,
                    },
                )
                session.commit()

                for seq, event_type in enumerate(("delta", "tool_call", "retrieval_result"), 10):
                    with pytest.raises(IntegrityError):
                        session.execute(
                            text(
                                """
                                INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                                VALUES (:run_id, :seq, :event_type, '{}'::jsonb)
                                """
                            ),
                            {"run_id": run_id, "seq": seq, "event_type": event_type},
                        )
                        session.commit()
                    session.rollback()

                for seq, event_type in enumerate(
                    (
                        "meta",
                        "assistant_activity",
                        "assistant_text_delta",
                        "tool_call_start",
                        "tool_call_delta",
                        "tool_call_done",
                        "tool_result",
                        "citation_index",
                        "context_ref_added",
                        "done",
                    ),
                    20,
                ):
                    session.execute(
                        text(
                            """
                            INSERT INTO chat_run_events (run_id, seq, event_type, payload)
                            VALUES (:run_id, :seq, :event_type, '{}'::jsonb)
                            """
                        ),
                        {"run_id": run_id, "seq": seq, "event_type": event_type},
                    )
                session.commit()
        finally:
            engine.dispose()
            reset_test_schema()

    def test_0167_downgrade_is_blocked(self):
        reset_test_schema()
        try:
            assert run_alembic_command("upgrade 0167").returncode == 0

            result = run_alembic_command("downgrade 0166")

            assert result.returncode != 0
            combined = (result.stdout or "") + (result.stderr or "")
            assert "Hard cutover: 0167 is not reversible" in combined
        finally:
            reset_test_schema()


class TestMigration0168WebArticleInlineEmbedsHardCutover:
    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _constraint_def(self, session, table: str, conname: str) -> str:
        return session.execute(
            text(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = CAST(:table AS regclass) AND conname = :conname
                """
            ),
            {"table": table, "conname": conname},
        ).scalar_one()

    def test_0168_creates_document_embed_schema_contract(self, head_engine):
        with Session(head_engine) as session:
            assert (
                session.scalar(text("SELECT to_regclass('public.document_embed_artifact_states')"))
                is not None
            )
            assert session.scalar(text("SELECT to_regclass('public.document_embeds')")) is not None

            columns = session.execute(
                text(
                    """
                    SELECT table_name, column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name IN ('document_embed_artifact_states', 'document_embeds')
                    """
                )
            ).fetchall()
            constraints = session.execute(
                text(
                    """
                    SELECT conrelid::regclass::text AS table_name, conname
                    FROM pg_constraint
                    WHERE conrelid IN (
                        'document_embed_artifact_states'::regclass,
                        'document_embeds'::regclass,
                        'resource_edges'::regclass,
                        'media_source_attempts'::regclass
                    )
                    """
                )
            ).fetchall()
            indexes = session.execute(
                text(
                    """
                    SELECT indexname
                    FROM pg_indexes
                    WHERE tablename = 'document_embeds'
                    """
                )
            ).fetchall()
            source_type_def = self._constraint_def(
                session,
                "media_source_attempts",
                "ck_media_source_attempts_source_type",
            )
            edge_origin_def = self._constraint_def(
                session,
                "resource_edges",
                "ck_resource_edges_origin",
            )

        column_by_table: dict[str, set[str]] = {}
        not_null_columns: set[tuple[str, str]] = set()
        for table_name, column_name, _data_type, is_nullable in columns:
            column_by_table.setdefault(table_name, set()).add(column_name)
            if is_nullable == "NO":
                not_null_columns.add((table_name, column_name))

        assert {
            "media_id",
            "source_attempt_id",
            "status",
            "total_count",
            "resolved_count",
            "unsupported_count",
            "failed_count",
            "diagnostics",
            "updated_at",
        }.issubset(column_by_table.get("document_embed_artifact_states", set())), (
            "document_embed_artifact_states must own aggregate current-artifact state; "
            f"got {column_by_table.get('document_embed_artifact_states', set())}"
        )
        assert {
            "media_id",
            "fragment_id",
            "source_attempt_id",
            "ordinal",
            "occurrence_key",
            "provider",
            "embed_kind",
            "source_shape",
            "resolution_status",
            "source_url",
            "canonical_source_url",
            "provider_target_ref",
            "target_media_id",
            "placeholder_text",
            "canonical_start_offset",
            "canonical_end_offset",
            "document_order_key",
            "diagnostics",
        }.issubset(column_by_table.get("document_embeds", set())), (
            "document_embeds must persist typed occurrence, locator, provider, and target state; "
            f"got {column_by_table.get('document_embeds', set())}"
        )
        for table_name, column_name in (
            ("document_embed_artifact_states", "media_id"),
            ("document_embed_artifact_states", "status"),
            ("document_embeds", "media_id"),
            ("document_embeds", "ordinal"),
            ("document_embeds", "occurrence_key"),
            ("document_embeds", "provider"),
            ("document_embeds", "embed_kind"),
            ("document_embeds", "resolution_status"),
            ("document_embeds", "placeholder_text"),
            ("document_embeds", "document_order_key"),
        ):
            assert (table_name, column_name) in not_null_columns, (
                f"{table_name}.{column_name} must be NOT NULL"
            )

        constraint_names = {row[1] for row in constraints}
        assert {
            "uq_document_embed_artifact_states_media",
            "uq_document_embeds_media_ordinal",
            "uq_document_embeds_media_key",
        }.issubset(constraint_names), (
            f"0168 must install document embed relational constraints; got {constraint_names}"
        )
        assert {
            "idx_document_embeds_media_order",
            "idx_document_embeds_fragment_order",
            "idx_document_embeds_target_media",
            "idx_document_embeds_resolution",
        }.issubset({row[0] for row in indexes}), f"document_embeds indexes missing: {indexes}"
        assert "'x_post'" in source_type_def, source_type_def
        assert "'document_embed'" in edge_origin_def, edge_origin_def

    def test_0168_downgrade_is_blocked(self):
        reset_test_schema()
        try:
            assert run_alembic_command("upgrade 0168").returncode == 0

            result = run_alembic_command("downgrade 0167")

            assert result.returncode != 0
            combined = (result.stdout or "") + (result.stderr or "")
            assert "Hard cutover: 0168 is not reversible" in combined
        finally:
            reset_test_schema()


class TestMigration0172AttentionLedger:
    """0172 creates reading_sessions + consumption_overrides with the ledger
    contract and seeds sessions from existing reader/listening state."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_head_contains_attention_tables_and_constraints(self, head_engine):
        with Session(head_engine) as session:
            reading_session_columns = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_name = 'reading_sessions'
                        """
                    )
                ).fetchall()
            }
            reading_session_constraints = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'reading_sessions'::regclass
                        """
                    )
                ).fetchall()
            }
            reading_session_indexes = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE tablename = 'reading_sessions'
                        """
                    )
                ).fetchall()
            }
            override_constraints = {
                row[0]
                for row in session.execute(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint
                        WHERE conrelid = 'consumption_overrides'::regclass
                        """
                    )
                ).fetchall()
            }

        assert {
            "id",
            "user_id",
            "media_id",
            "device_id",
            "started_at",
            "last_active_at",
            "dwell_ms",
            "max_progression",
            "spans",
        }.issubset(reading_session_columns), reading_session_columns
        assert "ck_reading_sessions_dwell_non_negative" in reading_session_constraints
        assert "ck_reading_sessions_max_progression" in reading_session_constraints
        assert "ck_reading_sessions_spans_array" in reading_session_constraints
        assert "ck_reading_sessions_device_id_len" in reading_session_constraints
        assert "ix_reading_sessions_user_media_active" in reading_session_indexes
        assert "ix_reading_sessions_user_started" in reading_session_indexes
        # The status vocabulary CHECK was dropped by 0181 (lectern player
        # lifecycle): persistence adapters own the enum, not the database.
        assert "ck_consumption_overrides_status" not in override_constraints


class TestMigration0173SynapseSpanGrainTargets:
    """0173 widens ck_resource_edges_synapse_shape so a synapse edge can target an
    evidence_span (passage grain); downgrade deletes those edges then narrows."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _constraint_def(self, session, conname: str) -> str:
        return session.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                " WHERE conrelid = 'resource_edges'::regclass AND conname = :c"
            ),
            {"c": conname},
        ).scalar_one()

    def test_head_synapse_shape_allows_evidence_span_target(self, head_engine):
        with Session(head_engine) as session:
            definition = self._constraint_def(session, "ck_resource_edges_synapse_shape")
        assert "evidence_span" in definition, definition

    def test_downgrade_deletes_span_target_synapse_edges_then_narrows(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        user_id = uuid4()
        try:
            assert run_alembic_command("upgrade 0173").returncode == 0

            def _insert_span_edge(session) -> None:
                session.execute(
                    text(
                        """
                        INSERT INTO resource_edges (
                            id, user_id, kind, origin,
                            source_scheme, source_id, target_scheme, target_id, snapshot
                        )
                        VALUES (
                            gen_random_uuid(), :u, 'context', 'synapse',
                            'media', gen_random_uuid(), 'evidence_span', gen_random_uuid(),
                            CAST('{"title": "T", "excerpt": "e"}' AS jsonb)
                        )
                        """
                    ),
                    {"u": user_id},
                )

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                _insert_span_edge(session)
                session.commit()

            assert run_alembic_command("downgrade 0172").returncode == 0

            with Session(engine) as session:
                remaining = session.execute(
                    text(
                        "SELECT count(*) FROM resource_edges"
                        " WHERE origin = 'synapse' AND target_scheme = 'evidence_span'"
                    )
                ).scalar_one()
                assert remaining == 0, "downgrade must delete span-target synapse edges"
                definition = self._constraint_def(session, "ck_resource_edges_synapse_shape")
                assert "evidence_span" not in definition, definition
                with pytest.raises(IntegrityError):
                    _insert_span_edge(session)
                    session.commit()
                session.rollback()
                session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
                session.commit()
        finally:
            reset_test_schema()
            engine.dispose()


class TestMigration0176AmanuensisAssistantWrites:
    """0176 adds the 'assistant' edge origin (a widened synapse shape: adds page +
    highlight, keeps a mandatory rationale snapshot, no ordinal) and the
    message_tool_calls.reverted_at undo column."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def _constraint_def(self, session, conname: str) -> str:
        return session.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                " WHERE conrelid = 'resource_edges'::regclass AND conname = :c"
            ),
            {"c": conname},
        ).scalar_one()

    def test_head_origin_check_includes_assistant(self, head_engine):
        with Session(head_engine) as session:
            definition = self._constraint_def(session, "ck_resource_edges_origin")
        assert "assistant" in definition, definition

    def test_head_has_reverted_at_column(self, head_engine):
        with Session(head_engine) as session:
            present = session.execute(
                text(
                    "SELECT 1 FROM information_schema.columns"
                    " WHERE table_name = 'message_tool_calls'"
                    " AND column_name = 'reverted_at'"
                )
            ).scalar_one_or_none()
        assert present == 1

    def test_head_assistant_checks_reject_violations(self, head_engine):
        user_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.commit()

            def _insert(snapshot: str, *, ordinal_clause: str, target_scheme: str) -> None:
                session.execute(
                    text(
                        f"""
                        INSERT INTO resource_edges (
                            id, user_id, kind, origin,
                            source_scheme, source_id, target_scheme, target_id,
                            {ordinal_clause[0]} snapshot
                        )
                        VALUES (
                            gen_random_uuid(), :u, 'context', 'assistant',
                            'media', gen_random_uuid(), '{target_scheme}', gen_random_uuid(),
                            {ordinal_clause[1]} {snapshot}
                        )
                        """
                    ),
                    {"u": user_id},
                )

            # Valid assistant edge (bare, rationale excerpt, page endpoint) commits.
            _insert(
                'CAST(\'{"excerpt": "because"}\' AS jsonb)',
                ordinal_clause=("", ""),
                target_scheme="page",
            )
            session.commit()

            # Missing excerpt is rejected.
            with pytest.raises(IntegrityError):
                _insert(
                    'CAST(\'{"title": "t"}\' AS jsonb)',
                    ordinal_clause=("", ""),
                    target_scheme="page",
                )
                session.commit()
            session.rollback()

            # A NULL snapshot is rejected (assistant requires one).
            with pytest.raises(IntegrityError):
                _insert("NULL", ordinal_clause=("", ""), target_scheme="page")
                session.commit()
            session.rollback()

            # An ordinal is rejected (assistant edges are bare).
            with pytest.raises(IntegrityError):
                _insert(
                    'CAST(\'{"excerpt": "x"}\' AS jsonb)',
                    ordinal_clause=("ordinal,", "3,"),
                    target_scheme="page",
                )
                session.commit()
            session.rollback()

            # A disallowed endpoint scheme is rejected (evidence_span excluded).
            with pytest.raises(IntegrityError):
                _insert(
                    'CAST(\'{"excerpt": "x"}\' AS jsonb)',
                    ordinal_clause=("", ""),
                    target_scheme="evidence_span",
                )
                session.commit()
            session.rollback()

            session.execute(text("DELETE FROM resource_edges WHERE user_id = :u"), {"u": user_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_downgrade_drops_column_and_narrows_origin(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            assert run_alembic_command("upgrade 0176").returncode == 0
            assert run_alembic_command("downgrade 0175").returncode == 0
            with Session(engine) as session:
                present = session.execute(
                    text(
                        "SELECT 1 FROM information_schema.columns"
                        " WHERE table_name = 'message_tool_calls'"
                        " AND column_name = 'reverted_at'"
                    )
                ).scalar_one_or_none()
                assert present is None
                definition = session.execute(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                        " WHERE conrelid = 'resource_edges'::regclass"
                        " AND conname = 'ck_resource_edges_origin'"
                    )
                ).scalar_one()
                assert "assistant" not in definition, definition
        finally:
            reset_test_schema()
            engine.dispose()


class TestMigration0177GrandAtlas:
    """0177 adds media_atlas_positions: the persistent 2D corpus spatial substrate
    with x/y range CHECKs and a version-positive CHECK."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_head_has_media_atlas_positions_shape(self, head_engine):
        with Session(head_engine) as session:
            columns = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns"
                        " WHERE table_name = 'media_atlas_positions'"
                    )
                ).fetchall()
            }
            constraints = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT conname FROM pg_constraint"
                        " WHERE conrelid = 'media_atlas_positions'::regclass"
                    )
                ).fetchall()
            }
            indexes = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT indexname FROM pg_indexes WHERE tablename = 'media_atlas_positions'"
                    )
                ).fetchall()
            }
        assert {"media_id", "x", "y", "projection_version", "computed_at"}.issubset(columns)
        assert "ck_media_atlas_positions_x_range" in constraints
        assert "ck_media_atlas_positions_y_range" in constraints
        assert "ck_media_atlas_positions_version_positive" in constraints
        assert "ix_media_atlas_positions_version" in indexes

    def test_head_range_checks_reject_out_of_bounds(self, head_engine):
        media_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": media_id})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status)"
                    " VALUES (:id, 'web_article', 'T', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            session.commit()

            # Valid row commits.
            session.execute(
                text("INSERT INTO media_atlas_positions (media_id, x, y) VALUES (:id, 0.5, 0.5)"),
                {"id": media_id},
            )
            session.commit()

            # Out-of-range x is rejected.
            with pytest.raises(IntegrityError):
                session.execute(
                    text("UPDATE media_atlas_positions SET x = 1.5 WHERE media_id = :id"),
                    {"id": media_id},
                )
                session.commit()
            session.rollback()

            # projection_version < 1 is rejected.
            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "UPDATE media_atlas_positions SET projection_version = 0"
                        " WHERE media_id = :id"
                    ),
                    {"id": media_id},
                )
                session.commit()
            session.rollback()

            session.execute(
                text("DELETE FROM media_atlas_positions WHERE media_id = :id"),
                {"id": media_id},
            )
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": media_id})
            session.commit()

    def test_downgrade_drops_table(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            assert run_alembic_command("upgrade 0177").returncode == 0
            assert run_alembic_command("downgrade 0176").returncode == 0
            with Session(engine) as session:
                present = session.execute(
                    text(
                        "SELECT 1 FROM information_schema.tables"
                        " WHERE table_name = 'media_atlas_positions'"
                    )
                ).scalar_one_or_none()
                assert present is None
        finally:
            reset_test_schema()
            engine.dispose()


# Migration 0179 — Lightweight Author Deduplication Hard Cutover.
#
# Author: M2b (fixture author). Deliberately built from the SPEC (§4/§8) + plan
# (S2, D-7/D-12/D-17..D-20/D-32/D-33) rather than from the migration source, so a
# defect in the migration's collapse/rewrite/DDL is caught rather than mirrored.
#
# Fixture coverage (plan S2 representative-fixture bullets):
#   exact-name triplicate collapse; earliest-active survivor beats an earlier
#   merged/tombstoned row; resolving vs non-resolving alias classification (full
#   D-17 vocabulary); duplicate (owner, normalized_alias) dedup keeping the
#   resolving literal; same-name/same-authority key conflict staying distinct;
#   every authority disposition (orcid/isni/viaf/wikidata/openalex/lcnaf kept,
#   email->email_address, youtube->youtube_channel channel-kept + ambiguous-video
#   dropped, podcast_index/rss/gutenberg dropped); source_ref.x_user_id recovery
#   onto the survivor; merged+tombstoned total disposition; email-as-display,
#   embedded-address display (usable remainder stripped + kept, and address-only
#   local-part fallback), and URL-alias privacy cleanup; manual+machine author salvage (flag true) and
#   machine-only media (flag false); translator/host/guest (media + podcast +
#   gutenberg targets); >20 author slice truncated to dense 20; a no-survivor
#   HUSK (tombstoned, unique name) whose pin/version/view-state/edge/suppression/
#   alias/xid/scoped-memo are purged, never repointed; a NINE-deep merged chain
#   whose deepest row still repoints to the active end; the prod-dominant
#   machine-source display alias flipped to resolving; machine-vs-machine
#   salvage recency (newer MAX(updated_at) wins; exact tie falls to source name
#   ascending); a junk contributor-scoped memo (uuid never a contributor) that
#   survives untouched; an embedded-address alias STRIPPED (not removed) to its
#   human remainder by privacy cleanup;
#   collapsed edge ids inside prompt assemblies + meta events rebinding to the
#   collision winner; reconciliation
#   runs/candidates/identity-events/background_jobs deleted; and every §8 + D-18
#   reference shape (pin incl. soft-deleted collision; resource_version collision;
#   view-state surface/target/edge + collision; turn-context both pairs; edges
#   with bare-pair collision + self-edge + citation snapshot nesting a typed
#   contributor + handle + deep link; oracle folio required rebind; cited_edge_id
#   rebind + null; synapse-suppression delete exemption; retrieval context/result
#   refs + source_id + deep_link; candidate ledger; tool-call ref arrays; prompt
#   assembly typed refs + "contributor:<uuid>" URI strings; chat_run_events meta
#   URIs + tool_result filters handles; mutation memo response refs + a memo
#   scoped to a losing contributor UUID (deleted); note_blocks PM object_ref /
#   object_embed nodes). A generic scanner asserts no losing UUID/handle/deep
#   link survives in any manifest column.

_MIG_PREV = "0178"
_MIG_REV = "0179"
_HASH64 = "0" * 64  # satisfies ck_resource_mutations_request_hash_length (=64)

# Independent copy of the reference manifest (spec §8 + D-18). Deliberately NOT
# imported from the migration: a column missing from the migration's own manifest
# is caught here.
_JSONB_REF_COLUMNS: tuple[tuple[str, str], ...] = (
    ("message_retrievals", "context_ref"),
    ("message_retrievals", "result_ref"),
    ("message_retrieval_candidate_ledgers", "result_ref"),
    ("message_tool_calls", "result_refs"),
    ("message_tool_calls", "selected_context_refs"),
    ("chat_prompt_assemblies", "included_context_refs"),
    ("chat_prompt_assemblies", "prompt_block_manifest"),
    ("chat_prompt_assemblies", "dropped_items"),
    ("chat_run_events", "payload"),
    ("resource_edges", "snapshot"),
    ("resource_mutations", "response_json"),
    ("note_blocks", "body_pm_json"),
)
_SCALAR_REF_COLUMNS: tuple[tuple[str, str], ...] = (
    ("message_retrievals", "source_id"),
    ("message_retrievals", "deep_link"),
    ("message_retrieval_candidate_ledgers", "source_id"),
    ("resource_mutations", "mutation_scope"),
)
# (table, discriminator_column, uuid_column) — polymorphic contributor refs.
_POLY_UUID_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("user_pinned_objects", "object_type", "object_id"),
    ("resource_versions", "resource_scheme", "resource_id"),
    ("resource_view_states", "surface_scheme", "surface_id"),
    ("resource_view_states", "target_scheme", "target_id"),
    ("resource_edges", "source_scheme", "source_id"),
    ("resource_edges", "target_scheme", "target_id"),
    ("chat_run_turn_contexts", "requested_subject_scheme", "requested_subject_id"),
    ("chat_run_turn_contexts", "subject_scheme", "subject_id"),
)


def _ts(year: int, month: int = 1, day: int = 1) -> datetime:
    return datetime(year, month, day, tzinfo=UTC)


def _dumps(obj) -> str:
    return json.dumps(obj)


def _insert_contributor(
    session: Session,
    *,
    cid: UUID,
    handle: str,
    display: str,
    created_at: datetime,
    status: str = "unverified",
    kind: str = "unknown",
    merged_into: UUID | None = None,
    with_display_alias: bool = True,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO contributors (
                id, handle, display_name, sort_name, kind, status,
                merged_into_contributor_id, created_at, updated_at
            )
            VALUES (:id, :h, :d, :s, :k, :st, :mi, :ca, :ca)
            """
        ),
        {
            "id": cid,
            "h": handle,
            "d": display,
            "s": display.lower(),
            "k": kind,
            "st": status,
            "mi": merged_into,
            "ca": created_at,
        },
    )
    if with_display_alias:
        # 0071 seeds one canonical display alias per contributor; source
        # 'migration' is a resolving source (D-17).
        _insert_alias(
            session,
            cid=cid,
            alias=display,
            source="migration",
            alias_kind="display",
            created_at=created_at,
        )


def _insert_alias(
    session: Session,
    *,
    cid: UUID,
    alias: str,
    source: str,
    alias_kind: str = "credited",
    normalized: str | None = None,
    created_at: datetime | None = None,
) -> None:
    if created_at is None:
        created_at = _ts(2020)
    session.execute(
        text(
            """
            INSERT INTO contributor_aliases (
                contributor_id, alias, normalized_alias, alias_kind,
                source, is_primary, created_at
            )
            VALUES (:cid, :a, :n, :ak, :src, false, :ca)
            """
        ),
        {
            "cid": cid,
            "a": alias,
            "n": normalized if normalized is not None else alias.lower(),
            "ak": alias_kind,
            "src": source,
            "ca": created_at,
        },
    )


def _insert_xid(
    session: Session,
    *,
    cid: UUID,
    authority: str,
    external_key: str,
    source: str = "manual",
    external_url: str | None = None,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO contributor_external_ids (
                contributor_id, authority, external_key, external_url, source
            )
            VALUES (:cid, :au, :k, :url, :src)
            """
        ),
        {"cid": cid, "au": authority, "k": external_key, "url": external_url, "src": source},
    )


def _insert_credit(
    session: Session,
    *,
    cid: UUID,
    role: str,
    ordinal: int,
    source: str,
    media: UUID | None = None,
    podcast: UUID | None = None,
    gutenberg: int | None = None,
    credited_name: str | None = None,
    source_ref: dict | None = None,
    resolution_status: str = "unverified",
    updated_at: datetime | None = None,
) -> None:
    if updated_at is None:
        updated_at = _ts(2021)
    name = credited_name if credited_name is not None else "Credited Name"
    session.execute(
        text(
            """
            INSERT INTO contributor_credits (
                contributor_id, media_id, podcast_id,
                project_gutenberg_catalog_ebook_id, credited_name,
                normalized_credited_name, role, ordinal, source, source_ref,
                resolution_status, created_at, updated_at
            )
            VALUES (
                :cid, :m, :p, :g, :cn, :ncn, :role, :ord, :src,
                CAST(:sref AS jsonb), :rs, :ua, :ua
            )
            """
        ),
        {
            "cid": cid,
            "m": media,
            "p": podcast,
            "g": gutenberg,
            "cn": name,
            "ncn": name.lower(),
            "role": role,
            "ord": ordinal,
            "src": source,
            "sref": _dumps(source_ref or {}),
            "rs": resolution_status,
            "ua": updated_at,
        },
    )


def _insert_media(session: Session, *, mid: UUID, title: str, user_id: UUID | None = None) -> None:
    session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', :t, 'ready_for_reading', :u)
            """
        ),
        {"id": mid, "t": title, "u": user_id},
    )


def _build_chat_parents(session: Session, ids: dict) -> None:
    u = ids["user"]
    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u})
    session.execute(
        text(
            """
            INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
            VALUES (:id, 'anthropic', 'claude-test', 200000, true)
            """
        ),
        {"id": ids["model"]},
    )
    session.execute(
        text(
            """
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :u, 'private', 3)
            """
        ),
        {"id": ids["conversation"], "u": u},
    )
    session.execute(
        text(
            """
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :c, 1, 'user', 'seed', 'complete')
            """
        ),
        {"id": ids["msg_user"], "c": ids["conversation"]},
    )
    session.execute(
        text(
            """
            INSERT INTO messages (
                id, conversation_id, seq, role, content, status, parent_message_id
            )
            VALUES (:id, :c, 2, 'assistant', 'reply', 'complete', :parent)
            """
        ),
        {"id": ids["msg_assistant"], "c": ids["conversation"], "parent": ids["msg_user"]},
    )
    session.execute(
        text(
            """
            INSERT INTO chat_runs (
                id, owner_user_id, conversation_id, user_message_id,
                assistant_message_id, idempotency_key, payload_hash, status,
                model_id, reasoning, key_mode
            )
            VALUES (:id, :u, :c, :mu, :ma, :ik, 'hash', 'complete', :model, 'none', 'auto')
            """
        ),
        {
            "id": ids["chat_run"],
            "u": u,
            "c": ids["conversation"],
            "mu": ids["msg_user"],
            "ma": ids["msg_assistant"],
            "ik": f"idem-{ids['chat_run']}",
            "model": ids["model"],
        },
    )
    session.execute(
        text(
            """
            INSERT INTO oracle_readings (id, user_id, folio_number, question_text, status)
            VALUES (:id, :u, 1, 'A question about a folio.', 'pending')
            """
        ),
        {"id": ids["reading"], "u": u},
    )


def _build_0179_success_fixture(session: Session) -> dict:
    """Insert the AC-31/32 representative 0178 fixture. Returns an id map."""
    ids: dict = {}

    # ---- chat/graph parents -------------------------------------------------
    ids["user"] = uuid4()
    ids["model"] = uuid4()
    ids["conversation"] = uuid4()
    ids["msg_user"] = uuid4()
    ids["msg_assistant"] = uuid4()
    ids["chat_run"] = uuid4()
    ids["reading"] = uuid4()
    _build_chat_parents(session, ids)

    # Arbitrary polymorphic endpoints that need no real row (no FK on scheme/id).
    ids["graph_media_x"] = uuid4()
    ids["graph_media_y"] = uuid4()
    ids["graph_media_z"] = uuid4()
    ids["msg_cited"] = uuid4()  # E_SNAP citation source (message scheme, no FK)
    ids["arb_edge"] = uuid4()  # arbitrary edge uuid embedded in JSON payloads

    # =====================================================================
    # 1. COLLAPSE COMPONENT "Ursula K. Le Guin" — triplicate + merged + tomb.
    #    Survivor is the earliest ACTIVE row, not the (earlier) merged/tomb rows.
    # =====================================================================
    # Deterministic UUIDs: the winner deliberately has the HIGHEST uuid among the
    # active rows and is NOT the earliest-created row overall (the merged/tomb
    # rows are earlier), so the survivor election is only correct if it is
    # earliest-created-among-active — not lowest-uuid and not earliest-ignoring-
    # status. A uuid-first bug would pick loser1; a status-blind bug would pick
    # the tombstone.
    ids["winner"] = UUID("ffffffff-0000-4000-8000-000000000001")
    ids["winner_h"] = "ursula-k-le-guin-w0"
    ids["loser1"] = UUID("11111111-0000-4000-8000-000000000011")
    ids["loser1_h"] = "ursula-k-le-guin-l1"
    ids["loser2"] = UUID("22222222-0000-4000-8000-000000000022")
    ids["loser2_h"] = "ursula-k-le-guin-l2"
    ids["merged"] = UUID("00000000-0000-4000-8000-0000000000aa")
    ids["merged_h"] = "ursula-k-le-guin-mg"
    ids["tomb"] = UUID("00000000-0000-4000-8000-0000000000bb")
    ids["tomb_h"] = "ursula-k-le-guin-tb"

    _insert_contributor(
        session,
        cid=ids["winner"],
        handle=ids["winner_h"],
        display="Ursula K. Le Guin",
        created_at=_ts(2020),
    )
    _insert_contributor(
        session,
        cid=ids["loser1"],
        handle=ids["loser1_h"],
        display="Ursula K. Le Guin",
        created_at=_ts(2021),
    )
    _insert_contributor(
        session,
        cid=ids["loser2"],
        handle=ids["loser2_h"],
        display="Ursula K. Le Guin",
        created_at=_ts(2022),
    )
    # merged/tombstoned rows are created EARLIER than the winner but are not
    # active-retainable, so they must not win the survivor election.
    _insert_contributor(
        session,
        cid=ids["merged"],
        handle=ids["merged_h"],
        display="Ursula K. Le Guin",
        created_at=_ts(2018),
        status="merged",
        merged_into=ids["winner"],
    )
    _insert_contributor(
        session,
        cid=ids["tomb"],
        handle=ids["tomb_h"],
        display="Ursula K. Le Guin",
        created_at=_ts(2017),
        status="tombstoned",
    )

    # duplicate (owner, normalized_alias) literals on the winner: a resolving
    # display alias and a non-resolving credited alias that CASEFOLD to the same
    # match key -> must dedup to the resolving one before the unique index.
    _insert_alias(
        session,
        cid=ids["winner"],
        alias="URSULA K. LE GUIN",
        source="epub_opf",
        alias_kind="credited",
    )
    # a genuinely distinct searchable (non-resolving) alias on the winner
    _insert_alias(
        session,
        cid=ids["winner"],
        alias="Ursula Kroeber Le Guin",
        source="web_article_byline",
        alias_kind="credited",
    )
    # a distinct non-resolving alias on a LOSER -> must repoint to the survivor
    _insert_alias(
        session,
        cid=ids["loser1"],
        alias="U. K. Le Guin",
        source="epub_opf",
        alias_kind="credited",
    )

    # =====================================================================
    # 2. CLASSIFY — full D-17 resolving/non-resolving alias vocabulary.
    # =====================================================================
    ids["classify"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["classify"],
        handle="classify-test-c0",
        display="Classify Test",
        created_at=_ts(2020),
    )
    for alias, source, _resolves in [
        ("Classify Manual", "manual", True),
        ("Classify User", "user", True),
        ("Classify Curated", "curated", True),
        ("Classify Merge", "merge", True),
        ("Classify Epub", "epub_opf", False),
        ("Classify MigAuthors", "migration:media_authors", False),
        ("Classify Enrich", "metadata_enrichment", False),
        ("Classify XApi", "x_oembed_article", False),
    ]:
        _insert_alias(session, cid=ids["classify"], alias=alias, source=source)
    ids["classify_resolving"] = {
        "classify test",
        "classify manual",
        "classify user",
        "classify curated",
        "classify merge",
    }
    ids["classify_nonresolving"] = {
        "classify epub",
        "classify migauthors",
        "classify enrich",
        "classify xapi",
    }

    # =====================================================================
    # 3. SAME-NAME / SAME-AUTHORITY CONFLICT — must stay DISTINCT.
    # =====================================================================
    ids["smith_a"] = uuid4()
    ids["smith_b"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["smith_a"],
        handle="john-smith-a",
        display="John Smith",
        created_at=_ts(2020),
    )
    _insert_contributor(
        session,
        cid=ids["smith_b"],
        handle="john-smith-b",
        display="John Smith",
        created_at=_ts(2021),
    )
    _insert_xid(session, cid=ids["smith_a"], authority="wikidata", external_key="Q1001")
    _insert_xid(session, cid=ids["smith_b"], authority="wikidata", external_key="Q1002")

    # =====================================================================
    # 4. AUTHORITY DISPOSITIONS.
    # =====================================================================
    ids["auth_keep"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["auth_keep"],
        handle="auth-keep-k0",
        display="Auth Keep",
        created_at=_ts(2020),
    )
    ids["orcid_keep"] = "0000-0002-1825-0097"
    for authority, key in [
        ("orcid", ids["orcid_keep"]),
        ("isni", "0000000121032683"),
        ("viaf", "102333412"),
        ("wikidata", "Q42"),
        ("openalex", "A5023888391"),
        ("lcnaf", "n79021164"),
    ]:
        _insert_xid(session, cid=ids["auth_keep"], authority=authority, external_key=key)

    ids["auth_email"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["auth_email"],
        handle="auth-email-e0",
        display="Alice Contributor",
        created_at=_ts(2020),
    )
    # mixed-case + padded address -> canonicalized to authority email_address.
    _insert_xid(
        session, cid=ids["auth_email"], authority="email", external_key="  Alice@Example.COM "
    )

    ids["auth_yt"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["auth_yt"],
        handle="auth-yt-y0",
        display="Channel Owner",
        created_at=_ts(2020),
    )
    ids["yt_channel"] = "UCxxxxxxxxxxxxxxxxxxxxxx"  # UC + 22 = 24-char channel id
    _insert_xid(
        session,
        cid=ids["auth_yt"],
        authority="youtube",
        external_key=ids["yt_channel"],
        source="youtube_metadata",
        external_url=f"https://www.youtube.com/channel/{ids['yt_channel']}",
    )
    _insert_xid(
        session,
        cid=ids["auth_yt"],
        authority="youtube",
        external_key="dQw4w9WgXcQ",
        source="youtube_metadata",
        external_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    ids["auth_drop"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["auth_drop"],
        handle="auth-drop-d0",
        display="Feed Author",
        created_at=_ts(2020),
    )
    _insert_xid(session, cid=ids["auth_drop"], authority="podcast_index", external_key="pi-777")
    _insert_xid(
        session, cid=ids["auth_drop"], authority="rss", external_key="https://feed.example/rss.xml"
    )
    _insert_xid(session, cid=ids["auth_drop"], authority="gutenberg", external_key="9999")

    # =====================================================================
    # 5. PRIVACY — email-as-display + URL alias.
    # =====================================================================
    ids["priv"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["priv"],
        handle="priv-email-p0",
        display="jane.doe@example.com",
        created_at=_ts(2020),
    )
    _insert_alias(
        session, cid=ids["priv"], alias="https://example.com/~jane", source="web_article_byline"
    )
    # an address EMBEDDED in prose (not a full-value email): the address is
    # stripped and the human remainder ("Jane Doe") is KEPT as a searchable alias,
    # never dropped and never left carrying the address.
    _insert_alias(
        session,
        cid=ids["priv"],
        alias="Jane Doe <jane.doe@example.com>",
        source="web_article_byline",
    )

    # 5a. PRIVACY — an embedded address in the DISPLAY with a usable human
    #     remainder: the migration strips the address + its <> wrapper + the
    #     dangling trailing separator and keeps the name ("Dr. Jane Roe"), rather
    #     than blocking cutover. Its only alias is the same embedded-address prose
    #     (the prod-dominant machine display shape) -> stripped, not dropped, then
    #     flipped to the resolving canonical display alias.
    ids["priv_embed"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["priv_embed"],
        handle="priv-embed-e0",
        display="Dr. Jane Roe. <jane.roe@example.org>",
        created_at=_ts(2020),
        with_display_alias=False,
    )
    _insert_alias(
        session,
        cid=ids["priv_embed"],
        alias="Dr. Jane Roe. <jane.roe@example.org>",
        source="metadata_enrichment",
        alias_kind="display",
    )

    # 5a'. PRIVACY — an embedded-address-ONLY display (no human remainder after
    #      stripping): falls back to the sanitized local-part rule ("solo"), never
    #      blocks cutover, and never leaks the address as display or alias text.
    ids["priv_embed_only"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["priv_embed_only"],
        handle="priv-embed-only-o0",
        display="< solo@example.net >",
        created_at=_ts(2020),
        with_display_alias=False,
    )

    # =====================================================================
    # 5b. HUSK — tombstoned, unique name, NO retained survivor. Total
    #     disposition: children dropped, clean references purged, row deleted.
    #     (Its graph/reference rows are seeded in section 8 with the helpers.)
    # =====================================================================
    ids["husk"] = uuid4()
    ids["husk_h"] = "husk-solo-h0"
    _insert_contributor(
        session,
        cid=ids["husk"],
        handle=ids["husk_h"],
        display="Husk Solo",
        created_at=_ts(2019),
        status="tombstoned",
    )
    _insert_xid(session, cid=ids["husk"], authority="viaf", external_key="99999999")
    _insert_alias(session, cid=ids["husk"], alias="Husk Alias", source="epub_opf")

    # =====================================================================
    # 5c. DEEP MERGED CHAIN — nine merged rows deep. The disposition walk must
    #     reach the active end regardless of depth (no hop cap): the deepest
    #     row maps to the survivor, never silently degrades to a husk.
    # =====================================================================
    ids["chain_end"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["chain_end"],
        handle="chain-end-e0",
        display="Chain End Person",
        created_at=_ts(2019, 6),
    )
    ids["chain"] = []
    ids["chain_handles"] = []
    previous = ids["chain_end"]
    for i in range(9, 0, -1):  # chain9 -> chain_end, chain8 -> chain9, ...
        cid = uuid4()
        handle = f"chain-hop-{i:02d}-cc"
        _insert_contributor(
            session,
            cid=cid,
            handle=handle,
            display=f"Chain Hop {i:02d}",
            created_at=_ts(2000 + i),
            status="merged",
            merged_into=previous,
        )
        ids["chain"].insert(0, cid)
        ids["chain_handles"].insert(0, handle)
        previous = cid
    # ids["chain"][0] is the deepest row (9 hops from chain_end) and the
    # earliest-created merged row, so its walk runs before any shortcut exists.

    # =====================================================================
    # 5d. MACHINE-SOURCE DISPLAY ALIAS (the prod-dominant shape): the ONLY
    #     alias is a provider-observed copy of the display; the migration must
    #     FLIP it to resolving rather than insert a duplicate row.
    # =====================================================================
    ids["machine_alias"] = uuid4()
    _insert_contributor(
        session,
        cid=ids["machine_alias"],
        handle="machine-alias-m0",
        display="Machine Alias Only",
        created_at=_ts(2020),
        with_display_alias=False,
    )
    _insert_alias(
        session,
        cid=ids["machine_alias"],
        alias="Machine Alias Only",
        source="metadata_enrichment",
        alias_kind="display",
    )

    # =====================================================================
    # 6. CREDIT SALVAGE + MANUAL FLAG.
    # =====================================================================
    ids["media_manual"] = uuid4()
    ids["cm_manual"] = uuid4()
    ids["cm_machine"] = uuid4()
    _insert_media(session, mid=ids["media_manual"], title="Manual Flag Work")
    _insert_contributor(
        session,
        cid=ids["cm_manual"],
        handle="manual-author-one",
        display="Manual Author One",
        created_at=_ts(2020),
    )
    _insert_contributor(
        session,
        cid=ids["cm_machine"],
        handle="machine-author-two",
        display="Machine Author Two",
        created_at=_ts(2020),
    )
    _insert_credit(
        session,
        cid=ids["cm_manual"],
        role="author",
        ordinal=0,
        source="manual",
        media=ids["media_manual"],
    )
    _insert_credit(
        session,
        cid=ids["cm_machine"],
        role="author",
        ordinal=1,
        source="metadata_enrichment",
        media=ids["media_manual"],
    )

    ids["media_auto"] = uuid4()
    ids["ca_auto"] = uuid4()
    _insert_media(session, mid=ids["media_auto"], title="Automatic Work")
    _insert_contributor(
        session,
        cid=ids["ca_auto"],
        handle="auto-author-one",
        display="Auto Author One",
        created_at=_ts(2020),
    )
    _insert_credit(
        session,
        cid=ids["ca_auto"],
        role="author",
        ordinal=0,
        source="metadata_enrichment",
        media=ids["media_auto"],
    )

    # collapse-dedup: two same-source author credits on one media, one via a
    # loser -> after collapse both are (winner, author) -> dedup to one.
    ids["media_shared"] = uuid4()
    _insert_media(session, mid=ids["media_shared"], title="Shared Credit Work")
    _insert_credit(
        session,
        cid=ids["winner"],
        role="author",
        ordinal=0,
        source="metadata_enrichment",
        media=ids["media_shared"],
    )
    _insert_credit(
        session,
        cid=ids["loser1"],
        role="author",
        ordinal=1,
        source="metadata_enrichment",
        media=ids["media_shared"],
    )

    # translator/host/guest slices on media + podcast + gutenberg targets.
    ids["media_roles"] = uuid4()
    ids["role_auth"] = uuid4()
    ids["role_trans"] = uuid4()
    _insert_media(session, mid=ids["media_roles"], title="Roles Work")
    _insert_contributor(
        session,
        cid=ids["role_auth"],
        handle="role-author-r0",
        display="Role Author",
        created_at=_ts(2020),
    )
    _insert_contributor(
        session,
        cid=ids["role_trans"],
        handle="role-translator-r0",
        display="Role Translator",
        created_at=_ts(2020),
    )
    _insert_credit(
        session,
        cid=ids["role_auth"],
        role="author",
        ordinal=0,
        source="epub_opf",
        media=ids["media_roles"],
    )
    _insert_credit(
        session,
        cid=ids["role_trans"],
        role="translator",
        ordinal=1,
        source="epub_opf",
        media=ids["media_roles"],
    )

    ids["podcast"] = uuid4()
    ids["role_host"] = uuid4()
    ids["role_guest"] = uuid4()
    session.execute(
        text(
            """
            INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
            VALUES (:id, 'podcast_index', 'pi-1', 'Roles Podcast', 'https://feed.example/p')
            """
        ),
        {"id": ids["podcast"]},
    )
    _insert_contributor(
        session,
        cid=ids["role_host"],
        handle="role-host-r0",
        display="Role Host",
        created_at=_ts(2020),
    )
    _insert_contributor(
        session,
        cid=ids["role_guest"],
        handle="role-guest-r0",
        display="Role Guest",
        created_at=_ts(2020),
    )
    _insert_credit(
        session,
        cid=ids["role_host"],
        role="host",
        ordinal=0,
        source="podcast_index",
        podcast=ids["podcast"],
    )
    _insert_credit(
        session,
        cid=ids["role_guest"],
        role="guest",
        ordinal=1,
        source="podcast_index",
        podcast=ids["podcast"],
    )

    ids["ebook"] = 777001
    ids["gut_auth"] = uuid4()
    session.execute(
        text(
            """
            INSERT INTO project_gutenberg_catalog (ebook_id, title)
            VALUES (:e, 'A Public Domain Book')
            """
        ),
        {"e": ids["ebook"]},
    )
    _insert_contributor(
        session,
        cid=ids["gut_auth"],
        handle="gutenberg-author-g0",
        display="Gutenberg Author",
        created_at=_ts(2020),
    )
    _insert_credit(
        session,
        cid=ids["gut_auth"],
        role="author",
        ordinal=0,
        source="project_gutenberg_catalog",
        gutenberg=ids["ebook"],
    )

    # x_user recovery: a loser credit whose source_ref carries x_user_id ->
    # mined onto the survivor before source_ref is dropped.
    ids["media_xuser"] = uuid4()
    ids["x_user_id"] = "1234567890"
    _insert_media(session, mid=ids["media_xuser"], title="X User Work")
    _insert_credit(
        session,
        cid=ids["loser1"],
        role="author",
        ordinal=0,
        source="x_oembed_article",
        media=ids["media_xuser"],
        source_ref={"media_id": str(ids["media_xuser"]), "x_user_id": ids["x_user_id"]},
    )

    # >20 author slice -> truncated to dense 20.
    ids["media_big"] = uuid4()
    ids["big_authors"] = []
    _insert_media(session, mid=ids["media_big"], title="Anthology Work")
    for i in range(25):
        cid = uuid4()
        ids["big_authors"].append(cid)
        _insert_contributor(
            session,
            cid=cid,
            handle=f"big-author-{i:02d}-hh",
            display=f"Big Author {i:02d}",
            created_at=_ts(2020),
        )
        _insert_credit(
            session,
            cid=cid,
            role="author",
            ordinal=i,
            source="metadata_enrichment",
            media=ids["media_big"],
        )

    # machine-vs-machine recency: the source slice with the greatest
    # MAX(updated_at) wins the role (web_article_byline, newer); the stale
    # metadata_enrichment slice is deleted despite having more rows.
    ids["media_recency"] = uuid4()
    ids["rec_old_a"] = uuid4()
    ids["rec_old_b"] = uuid4()
    ids["rec_new"] = uuid4()
    _insert_media(session, mid=ids["media_recency"], title="Recency Work")
    for key, handle, display in (
        ("rec_old_a", "recency-old-a0", "Recency Old A"),
        ("rec_old_b", "recency-old-b0", "Recency Old B"),
        ("rec_new", "recency-new-n0", "Recency New"),
    ):
        _insert_contributor(
            session, cid=ids[key], handle=handle, display=display, created_at=_ts(2020)
        )
    _insert_credit(
        session,
        cid=ids["rec_old_a"],
        role="author",
        ordinal=0,
        source="metadata_enrichment",
        media=ids["media_recency"],
        updated_at=_ts(2021),
    )
    _insert_credit(
        session,
        cid=ids["rec_old_b"],
        role="author",
        ordinal=1,
        source="metadata_enrichment",
        media=ids["media_recency"],
        updated_at=_ts(2021, 6),
    )
    _insert_credit(
        session,
        cid=ids["rec_new"],
        role="author",
        ordinal=0,
        source="web_article_byline",
        media=ids["media_recency"],
        updated_at=_ts(2023),
    )
    # exact MAX(updated_at) tie -> source name ascending (metadata_enrichment).
    ids["media_tie"] = uuid4()
    ids["tie_meta"] = uuid4()
    ids["tie_web"] = uuid4()
    _insert_media(session, mid=ids["media_tie"], title="Tie Work")
    _insert_contributor(
        session, cid=ids["tie_meta"], handle="tie-meta-t0", display="Tie Meta", created_at=_ts(2020)
    )
    _insert_contributor(
        session, cid=ids["tie_web"], handle="tie-web-t0", display="Tie Web", created_at=_ts(2020)
    )
    _insert_credit(
        session,
        cid=ids["tie_meta"],
        role="author",
        ordinal=0,
        source="metadata_enrichment",
        media=ids["media_tie"],
        updated_at=_ts(2022),
    )
    _insert_credit(
        session,
        cid=ids["tie_web"],
        role="author",
        ordinal=0,
        source="web_article_byline",
        media=ids["media_tie"],
        updated_at=_ts(2022),
    )

    # =====================================================================
    # 7. RECONCILIATION / IDENTITY-EVENT / JOB rows (all deleted).
    # =====================================================================
    run_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO contributor_reconciliation_runs (
                id, algorithm_version, candidate_count, evaluated_pair_count
            )
            VALUES (:id, 'v1', 1, 1)
            """
        ),
        {"id": run_id},
    )
    session.execute(
        text(
            """
            INSERT INTO contributor_reconciliation_candidates (
                run_id, contributor_a_id, contributor_b_id,
                proposed_source_contributor_id, proposed_target_contributor_id,
                source_snapshot_handle, source_snapshot_display_name,
                source_snapshot_sort_name, source_snapshot_kind,
                source_snapshot_status, source_snapshot_work_count,
                target_snapshot_handle, target_snapshot_display_name,
                target_snapshot_sort_name, target_snapshot_kind,
                target_snapshot_status, target_snapshot_work_count,
                status, score, evidence
            )
            VALUES (
                :run, :a, :b, :a, :b,
                :ah, 'Ursula K. Le Guin', 'ursula', 'unknown', 'unverified', 1,
                :bh, 'Ursula K. Le Guin', 'ursula', 'unknown', 'unverified', 1,
                'pending', 90,
                CAST(:evi AS jsonb)
            )
            """
        ),
        {
            "run": run_id,
            "a": ids["loser1"],
            "b": ids["winner"],
            "ah": ids["loser1_h"],
            "bh": ids["winner_h"],
            "evi": _dumps({"type": "contributor", "id": ids["loser1_h"]}),
        },
    )
    for state in ("pending", "running", "succeeded", "failed"):
        session.execute(
            text(
                """
                INSERT INTO background_jobs (kind, payload, status)
                VALUES ('contributor_reconciliation', CAST(:p AS jsonb), :st)
                """
            ),
            {"p": _dumps({"scope": "media", "reason": "seed"}), "st": state},
        )

    # =====================================================================
    # 8. REFERENCE / GRAPH ROWS (all owned by ids["user"]).
    # =====================================================================
    u = ids["user"]
    loser1_uri = f"contributor:{ids['loser1']}"
    l1h = ids["loser1_h"]

    def typed_ref(handle: str) -> dict:
        return {
            "type": "contributor",
            "id": handle,
            "contributor_handle": handle,
            "deep_link": f"/authors/{handle}",
        }

    # ---- resource_edges -----------------------------------------------------
    ids["edge_keep"] = uuid4()
    ids["edge_collide"] = uuid4()
    ids["edge_self"] = uuid4()
    ids["edge_vs"] = uuid4()
    ids["edge_snap"] = uuid4()

    def edge(eid, *, origin, kind, ss, si, tsch, ti, created, ordinal=None, snapshot=None):
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    id, user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, ordinal, snapshot, created_at
                )
                VALUES (:id, :u, :k, :o, :ss, :si, :ts, :ti, :ord,
                        CAST(:snap AS jsonb), :ca)
                """
            ),
            {
                "id": eid,
                "u": u,
                "k": kind,
                "o": origin,
                "ss": ss,
                "si": si,
                "ts": tsch,
                "ti": ti,
                "ord": ordinal,
                "snap": _dumps(snapshot) if snapshot is not None else None,
                "ca": created,
            },
        )

    # bare-pair collision: keep the earlier edge_keep; edge_collide merges into it.
    edge(
        ids["edge_keep"],
        origin="user",
        kind="context",
        ss="contributor",
        si=ids["winner"],
        tsch="media",
        ti=ids["graph_media_x"],
        created=_ts(2020),
    )
    edge(
        ids["edge_collide"],
        origin="user",
        kind="context",
        ss="contributor",
        si=ids["loser1"],
        tsch="media",
        ti=ids["graph_media_x"],
        created=_ts(2021),
    )
    # self-edge after repoint (loser2 -> winner) -> removed.
    edge(
        ids["edge_self"],
        origin="user",
        kind="context",
        ss="contributor",
        si=ids["loser2"],
        tsch="contributor",
        ti=ids["winner"],
        created=_ts(2021),
    )
    # survives; anchors the view-state edge-occurrence collision.
    edge(
        ids["edge_vs"],
        origin="user",
        kind="context",
        ss="contributor",
        si=ids["winner"],
        tsch="media",
        ti=ids["graph_media_z"],
        created=_ts(2020),
    )
    # citation edge -> contributor target with a snapshot nesting a typed ref.
    edge(
        ids["edge_snap"],
        origin="citation",
        kind="context",
        ss="message",
        si=ids["msg_cited"],
        tsch="contributor",
        ti=ids["loser1"],
        created=_ts(2020),
        ordinal=1,
        snapshot={
            "title": "Cited work",
            "excerpt": "an excerpt",
            "result_type": "contributor",
            "deep_link": f"/authors/{l1h}",
            "contributor": typed_ref(l1h),
        },
    )

    # ---- user_pinned_objects ------------------------------------------------
    ids["pin_a"] = uuid4()
    ids["pin_b"] = uuid4()
    ids["pin_c"] = uuid4()

    def pin(pid, oid, surface, order, *, deleted=None):
        session.execute(
            text(
                """
                INSERT INTO user_pinned_objects (
                    id, user_id, object_type, object_id, surface_key, order_key,
                    created_at, updated_at, deleted_at
                )
                VALUES (:id, :u, 'contributor', :oid, :sk, :ok, :ca, :ca, :del)
                """
            ),
            {
                "id": pid,
                "u": u,
                "oid": oid,
                "sk": surface,
                "ok": order,
                "ca": _ts(2020),
                "del": deleted,
            },
        )

    pin(ids["pin_a"], ids["loser1"], "sidebar", "a")  # simple repoint
    pin(ids["pin_b"], ids["winner"], "home", "b")  # active winner pin
    pin(ids["pin_c"], ids["loser1"], "home", "c", deleted=_ts(2021))  # soft-deleted collision

    # ---- resource_versions --------------------------------------------------
    ids["rv1"] = uuid4()
    ids["rv2"] = uuid4()
    ids["rv3"] = uuid4()

    def rv(vid, rid, lane, version, updated):
        session.execute(
            text(
                """
                INSERT INTO resource_versions (
                    id, user_id, resource_scheme, resource_id, lane, version,
                    created_at, updated_at
                )
                VALUES (:id, :u, 'contributor', :rid, :lane, :v, :ua, :ua)
                """
            ),
            {"id": vid, "u": u, "rid": rid, "lane": lane, "v": version, "ua": updated},
        )

    rv(ids["rv1"], ids["loser1"], "title", 1, _ts(2020))  # simple repoint
    rv(ids["rv2"], ids["winner"], "body", 3, _ts(2022))  # collision winner (v3)
    rv(ids["rv3"], ids["loser1"], "body", 2, _ts(2021))  # collision loser (v2)

    # ---- resource_view_states ----------------------------------------------
    ids["vs_surf"] = uuid4()
    ids["vs_target"] = uuid4()
    ids["vs_edge"] = uuid4()
    ids["vs_e1"] = uuid4()
    ids["vs_e2"] = uuid4()

    def vs(vid, *, s_scheme, s_id, edge_id=None, t_scheme=None, t_id=None, updated):
        session.execute(
            text(
                """
                INSERT INTO resource_view_states (
                    id, user_id, surface_scheme, surface_id, edge_id,
                    target_scheme, target_id, state, created_at, updated_at
                )
                VALUES (:id, :u, :ss, :si, :eid, :ts, :ti, '{}'::jsonb, :ua, :ua)
                """
            ),
            {
                "id": vid,
                "u": u,
                "ss": s_scheme,
                "si": s_id,
                "eid": edge_id,
                "ts": t_scheme,
                "ti": t_id,
                "ua": updated,
            },
        )

    vs(ids["vs_surf"], s_scheme="contributor", s_id=ids["loser1"], updated=_ts(2020))
    vs(
        ids["vs_target"],
        s_scheme="media",
        s_id=ids["graph_media_x"],
        t_scheme="contributor",
        t_id=ids["loser1"],
        updated=_ts(2020),
    )
    vs(
        ids["vs_edge"],
        s_scheme="media",
        s_id=ids["graph_media_y"],
        edge_id=ids["edge_collide"],
        updated=_ts(2020),
    )
    vs(
        ids["vs_e1"],
        s_scheme="contributor",
        s_id=ids["winner"],
        edge_id=ids["edge_vs"],
        updated=_ts(2022),
    )  # collision winner (later)
    vs(
        ids["vs_e2"],
        s_scheme="contributor",
        s_id=ids["loser1"],
        edge_id=ids["edge_vs"],
        updated=_ts(2021),
    )  # collision loser (earlier)

    # ---- synapse_suppressions (delete exemption, both endpoints) -------------
    session.execute(
        text(
            """
            INSERT INTO synapse_suppressions (
                user_id, source_scheme, source_id, target_scheme, target_id
            )
            VALUES (:u, 'media', :mx, 'contributor', :l1)
            """
        ),
        {"u": u, "mx": ids["graph_media_x"], "l1": ids["loser1"]},
    )
    session.execute(
        text(
            """
            INSERT INTO synapse_suppressions (
                user_id, source_scheme, source_id, target_scheme, target_id
            )
            VALUES (:u, 'contributor', :l2, 'media', :mx)
            """
        ),
        {"u": u, "l2": ids["loser2"], "mx": ids["graph_media_x"]},
    )

    # ---- husk references: purged/dropped/deleted, never repointed ------------
    ids["husk_pin"] = uuid4()
    pin(ids["husk_pin"], ids["husk"], "sidebar", "z")
    rv(uuid4(), ids["husk"], "title", 1, _ts(2020))
    vs(uuid4(), s_scheme="contributor", s_id=ids["husk"], updated=_ts(2020))
    ids["husk_edge"] = uuid4()
    edge(
        ids["husk_edge"],
        origin="user",
        kind="context",
        ss="contributor",
        si=ids["husk"],
        tsch="media",
        ti=ids["graph_media_x"],
        created=_ts(2020),
    )
    session.execute(
        text(
            """
            INSERT INTO synapse_suppressions (
                user_id, source_scheme, source_id, target_scheme, target_id
            )
            VALUES (:u, 'contributor', :hk, 'media', :my)
            """
        ),
        {"u": u, "hk": ids["husk"], "my": ids["graph_media_y"]},
    )

    # ---- deep-chain reference: must repoint to chain_end, never purge --------
    ids["chain_pin"] = uuid4()
    pin(ids["chain_pin"], ids["chain"][0], "sidebar", "q")  # 9 hops from chain_end

    # ---- oracle_reading_folios (required edge rebind through collision) ------
    session.execute(
        text(
            """
            INSERT INTO oracle_reading_folios (
                reading_id, phase, edge_id, source_kind, locator_label,
                attribution_text, marginalia_text
            )
            VALUES (:r, 'descent', :e, 'user_media', 'loc', 'attr', 'marg')
            """
        ),
        {"r": ids["reading"], "e": ids["edge_collide"]},
    )

    # ---- message_tool_calls + retrievals + candidate ledger -----------------
    ids["tool_call"] = uuid4()
    session.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id, conversation_id, user_message_id, assistant_message_id,
                tool_name, tool_call_index, scope, status,
                result_refs, selected_context_refs
            )
            VALUES (:id, :c, :mu, :ma, 'app_search', 0, 'all', 'complete',
                    CAST(:rr AS jsonb), CAST(:sc AS jsonb))
            """
        ),
        {
            "id": ids["tool_call"],
            "c": ids["conversation"],
            "mu": ids["msg_user"],
            "ma": ids["msg_assistant"],
            "rr": _dumps([typed_ref(l1h)]),
            "sc": _dumps([{"type": "contributor", "id": l1h}]),
        },
    )
    ids["mr_contrib"] = uuid4()
    ids["mr_media"] = uuid4()
    session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                id, tool_call_id, ordinal, result_type, source_id, context_ref,
                result_ref, deep_link, cited_edge_id
            )
            VALUES (:id, :tc, 0, 'contributor', :sid, CAST(:ctx AS jsonb),
                    CAST(:res AS jsonb), :dl, :ce)
            """
        ),
        {
            "id": ids["mr_contrib"],
            "tc": ids["tool_call"],
            "sid": l1h,
            "ctx": _dumps({"type": "contributor", "id": l1h}),
            "res": _dumps(typed_ref(l1h)),
            "dl": f"/authors/{l1h}",
            "ce": ids["edge_collide"],  # rebind to edge_keep
        },
    )
    session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                id, tool_call_id, ordinal, result_type, source_id, context_ref,
                result_ref, cited_edge_id
            )
            VALUES (:id, :tc, 1, 'media', :sid, CAST(:ctx AS jsonb),
                    CAST(:res AS jsonb), :ce)
            """
        ),
        {
            "id": ids["mr_media"],
            "tc": ids["tool_call"],
            "sid": str(ids["graph_media_x"]),
            "ctx": _dumps({"type": "media", "id": str(ids["graph_media_x"])}),
            "res": _dumps({"type": "media", "id": str(ids["graph_media_x"])}),
            "ce": ids["edge_self"],  # self-edge removed -> null
        },
    )
    session.execute(
        text(
            """
            INSERT INTO message_retrieval_candidate_ledgers (
                tool_call_id, ordinal, result_type, source_id, selected,
                included_in_prompt, selection_status, selection_reason, result_ref
            )
            VALUES (:tc, 0, 'contributor', :sid, false, false, 'retrieved',
                    'seed', CAST(:res AS jsonb))
            """
        ),
        {"tc": ids["tool_call"], "sid": l1h, "res": _dumps(typed_ref(l1h))},
    )

    # ---- chat_prompt_assemblies (typed refs + URI strings) ------------------
    session.execute(
        text(
            """
            INSERT INTO chat_prompt_assemblies (
                id, chat_run_id, conversation_id, assistant_message_id, model_id,
                cacheable_input_tokens_estimate, max_context_tokens,
                reserved_output_tokens, reserved_reasoning_tokens,
                input_budget_tokens, estimated_input_tokens,
                included_context_refs, prompt_block_manifest, dropped_items
            )
            VALUES (
                :id, :run, :c, :ma, :model, 0, 200000, 1, 1, 100, 10,
                CAST(:inc AS jsonb), CAST(:man AS jsonb), CAST(:drop AS jsonb)
            )
            """
        ),
        {
            "id": uuid4(),
            "run": ids["chat_run"],
            "c": ids["conversation"],
            "ma": ids["msg_assistant"],
            "model": ids["model"],
            "inc": _dumps(
                [
                    {"type": "context_ref", "id": str(ids["arb_edge"]), "resource_uri": loser1_uri},
                    {
                        # collapsed edge id -> must rebind to edge_keep (D-18.2)
                        "type": "context_ref",
                        "id": str(ids["edge_collide"]),
                        "resource_uri": loser1_uri,
                    },
                    typed_ref(l1h),
                ]
            ),
            "man": _dumps({"blocks": [{"source_refs": [{"resource_uri": loser1_uri}]}]}),
            "drop": _dumps([{"resource_uri": loser1_uri, "reason": "budget"}]),
        },
    )

    # ---- chat_run_events (meta URIs + tool_result handles/filters) ----------
    session.execute(
        text(
            """
            INSERT INTO chat_run_events (run_id, seq, event_type, payload)
            VALUES (:run, 1, 'meta', CAST(:p AS jsonb))
            """
        ),
        {
            "run": ids["chat_run"],
            "p": _dumps(
                {
                    "chat_subject": {
                        "requested_resource_ref": loser1_uri,
                        "resource_ref": loser1_uri,
                    },
                    "context_edge_id": str(ids["edge_collide"]),  # rebinds to edge_keep
                    "unrelated_edge_id": str(ids["arb_edge"]),  # unknown ids pass through
                    "companions": [loser1_uri],
                }
            ),
        },
    )
    session.execute(
        text(
            """
            INSERT INTO chat_run_events (run_id, seq, event_type, payload)
            VALUES (:run, 2, 'tool_result', CAST(:p AS jsonb))
            """
        ),
        {
            "run": ids["chat_run"],
            "p": _dumps(
                {
                    "results": [typed_ref(l1h)],
                    "filters": {"authors": [l1h]},
                }
            ),
        },
    )

    # ---- resource_mutations (response refs + a memo scoped to a loser) -------
    session.execute(
        text(
            """
            INSERT INTO resource_mutations (
                user_id, mutation_scope, client_mutation_id, request_hash,
                changed_lanes, response_json
            )
            VALUES (:u, :scope, 'cm-ref', :h, '{}'::jsonb, CAST(:r AS jsonb))
            """
        ),
        {
            "u": u,
            "scope": f"resource:page:{ids['graph_media_y']}:outgoing_edges",
            "h": _HASH64,
            "r": _dumps(
                {
                    "items": [
                        {
                            "ref": loser1_uri,
                            "activation": {"href": f"/authors/{l1h}"},
                        }
                    ]
                }
            ),
        },
    )
    session.execute(
        text(
            """
            INSERT INTO resource_mutations (
                user_id, mutation_scope, client_mutation_id, request_hash,
                changed_lanes, response_json
            )
            VALUES (:u, :scope, 'cm-del', :h, '{}'::jsonb, CAST(:r AS jsonb))
            """
        ),
        {
            "u": u,
            "scope": f"contributor:{ids['loser1']}:display-name",  # DELETED
            "h": _HASH64,
            "r": _dumps({"handle": l1h, "displayName": "Ursula K. Le Guin"}),
        },
    )
    session.execute(
        text(
            """
            INSERT INTO resource_mutations (
                user_id, mutation_scope, client_mutation_id, request_hash,
                changed_lanes, response_json
            )
            VALUES (:u, :scope, 'cm-keep', :h, '{}'::jsonb, CAST(:r AS jsonb))
            """
        ),
        {
            "u": u,
            "scope": f"contributor:{ids['winner']}:display-name",  # survives
            "h": _HASH64,
            "r": _dumps({"handle": ids["winner_h"], "displayName": "Ursula K. Le Guin"}),
        },
    )
    # husk-scoped memo: deleted with the loser scope (and its own-handle
    # response_json must NOT trip the deferred husk-residue scan afterwards)
    session.execute(
        text(
            """
            INSERT INTO resource_mutations (
                user_id, mutation_scope, client_mutation_id, request_hash,
                changed_lanes, response_json
            )
            VALUES (:u, :scope, 'cm-husk', :h, '{}'::jsonb, CAST(:r AS jsonb))
            """
        ),
        {
            "u": u,
            "scope": f"contributor:{ids['husk']}:display-name",  # DELETED (husk-scoped)
            "h": _HASH64,
            "r": _dumps({"handle": ids["husk_h"], "displayName": "Husk Solo"}),
        },
    )
    # pre-existing junk: a contributor scope whose uuid never keyed a
    # contributor row — not this migration's residue; must survive untouched.
    ids["junk_scope_uuid"] = uuid4()
    session.execute(
        text(
            """
            INSERT INTO resource_mutations (
                user_id, mutation_scope, client_mutation_id, request_hash,
                changed_lanes, response_json
            )
            VALUES (:u, :scope, 'cm-junk', :h, '{}'::jsonb, CAST(:r AS jsonb))
            """
        ),
        {
            "u": u,
            "scope": f"contributor:{ids['junk_scope_uuid']}:display-name",
            "h": _HASH64,
            "r": _dumps({"note": "junk scope, never a contributor"}),
        },
    )

    # ---- note_blocks (PM object_ref / object_embed nodes) -------------------
    session.execute(
        text(
            """
            INSERT INTO note_blocks (user_id, body_pm_json, body_text)
            VALUES (:u, CAST(:pm AS jsonb), 'mentions')
            """
        ),
        {
            "u": u,
            "pm": _dumps(
                {
                    "type": "doc",
                    "content": [
                        {
                            "type": "object_ref",
                            "attrs": {"objectType": "contributor", "objectId": str(ids["loser1"])},
                        },
                        {
                            "type": "object_embed",
                            "attrs": {"objectType": "contributor", "objectId": str(ids["loser2"])},
                        },
                    ],
                }
            ),
        },
    )

    # ---- chat_run_turn_contexts (both pairs + self-edge context) ------------
    session.execute(
        text(
            """
            INSERT INTO chat_run_turn_contexts (
                chat_run_id, requested_subject_scheme, requested_subject_id,
                subject_scheme, subject_id, subject_context_edge_id
            )
            VALUES (:run, 'contributor', :l1, 'contributor', :l1, :edge)
            """
        ),
        {"run": ids["chat_run"], "l1": ids["loser1"], "edge": ids["edge_self"]},
    )

    session.commit()

    ids["loser_uuids"] = [
        ids["loser1"],
        ids["loser2"],
        ids["merged"],
        ids["tomb"],
        ids["husk"],
        *ids["chain"],
    ]
    ids["loser_handles"] = [
        ids["loser1_h"],
        ids["loser2_h"],
        ids["merged_h"],
        ids["tomb_h"],
        ids["husk_h"],
        *ids["chain_handles"],
    ]
    return ids


class TestMigration0179LightweightAuthorDedup:
    """0179 collapses exact-name duplicates, migrates authorities, salvages
    credits, rewrites every §8/D-18 reference owner, and drops the reconciliation
    product — on a representative 0178 fixture (AC 31-34)."""

    @pytest.fixture(scope="class")
    def migrated(self):
        reset_test_schema()
        assert run_alembic_command(f"upgrade {_MIG_PREV}").returncode == 0
        engine = create_engine(get_test_database_url())
        with Session(engine) as session:
            ids = _build_0179_success_fixture(session)
        result = run_alembic_command(f"upgrade {_MIG_REV}")
        assert result.returncode == 0, f"0179 upgrade failed: {result.stderr}"
        yield engine, ids
        engine.dispose()
        reset_test_schema()
        run_alembic_command("upgrade head")

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _scalar(session, sql, **params):
        return session.execute(text(sql), params).scalar()

    @staticmethod
    def _rows(session, sql, **params):
        return session.execute(text(sql), params).fetchall()

    # === identity collapse ================================================
    def test_triplicate_collapses_to_earliest_active_survivor(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s, "SELECT id, handle FROM contributors WHERE display_name = 'Ursula K. Le Guin'"
            )
            assert len(rows) == 1, "triplicate+merged+tomb must collapse to one"
            assert str(rows[0][0]) == str(ids["winner"])
            assert rows[0][1] == ids["winner_h"], "survivor keeps its own handle"
            # every loser (incl. the earlier merged/tombstoned rows) is gone
            for lid in ids["loser_uuids"]:
                assert (
                    self._scalar(s, "SELECT count(*) FROM contributors WHERE id = :id", id=lid) == 0
                )

    def test_same_name_same_authority_conflict_stays_distinct(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s, "SELECT id FROM contributors WHERE display_name = 'John Smith' ORDER BY handle"
            )
            assert len(rows) == 2, "conflicting same-authority keys must not merge"
            keys = self._rows(
                s,
                "SELECT c.handle, x.external_key FROM contributors c"
                " JOIN contributor_external_ids x ON x.contributor_id = c.id"
                " WHERE c.display_name = 'John Smith' AND x.authority = 'wikidata'"
                " ORDER BY c.handle",
            )
            assert {r[1] for r in keys} == {"Q1001", "Q1002"}

    # === aliases ===========================================================
    def test_duplicate_normalized_alias_deduped_keeping_resolving(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s,
                "SELECT resolves_identity FROM contributor_aliases"
                " WHERE contributor_id = :w AND normalized_alias = 'ursula k. le guin'",
                w=ids["winner"],
            )
            assert len(rows) == 1, "duplicate (owner, normalized_alias) must dedup to one"
            assert rows[0][0] is True, "the resolving literal wins the collision"
            # a distinct non-resolving searchable alias survives
            assert (
                self._scalar(
                    s,
                    "SELECT resolves_identity FROM contributor_aliases WHERE contributor_id = :w"
                    " AND normalized_alias = 'ursula kroeber le guin'",
                    w=ids["winner"],
                )
                is False
            )
            # a loser's distinct alias repointed onto the survivor
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_aliases WHERE contributor_id = :w"
                    " AND normalized_alias = 'u. k. le guin'",
                    w=ids["winner"],
                )
                == 1
            )

    def test_alias_source_resolution_classification(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s,
                "SELECT normalized_alias, resolves_identity FROM contributor_aliases"
                " WHERE contributor_id = :c",
                c=ids["classify"],
            )
            by_norm = {r[0]: r[1] for r in rows}
            for norm in ids["classify_resolving"]:
                assert by_norm.get(norm) is True, f"{norm} should resolve"
            for norm in ids["classify_nonresolving"]:
                assert by_norm.get(norm) is False, f"{norm} should be searchable-only"

    def test_every_display_has_resolving_alias(self, migrated):
        engine, _ = migrated
        with Session(engine) as s:
            orphaned = self._scalar(
                s,
                "SELECT count(*) FROM contributors c WHERE NOT EXISTS ("
                " SELECT 1 FROM contributor_aliases a"
                " WHERE a.contributor_id = c.id AND a.resolves_identity)",
            )
            assert orphaned == 0

    # === authorities =======================================================
    def test_authority_dispositions(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            keep = self._rows(
                s,
                "SELECT authority, external_key FROM contributor_external_ids"
                " WHERE contributor_id = :c ORDER BY authority",
                c=ids["auth_keep"],
            )
            assert {r[0] for r in keep} == {
                "orcid",
                "isni",
                "viaf",
                "wikidata",
                "openalex",
                "lcnaf",
            }
            assert dict(keep)["orcid"] == ids["orcid_keep"], "canonical orcid preserved"

            email = self._rows(
                s,
                "SELECT authority, external_key FROM contributor_external_ids WHERE contributor_id = :c",
                c=ids["auth_email"],
            )
            assert email == [("email_address", "alice@example.com")]

            yt = self._rows(
                s,
                "SELECT authority, external_key FROM contributor_external_ids WHERE contributor_id = :c",
                c=ids["auth_yt"],
            )
            assert yt == [("youtube_channel", ids["yt_channel"])], "channel kept, video dropped"

            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_external_ids WHERE contributor_id = :c",
                    c=ids["auth_drop"],
                )
                == 0
            ), "podcast_index/rss/gutenberg all dropped"

            # global: no legacy authority survives anywhere
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_external_ids"
                    " WHERE authority IN ('email','youtube','podcast_index','rss','gutenberg')",
                )
                == 0
            )

    def test_x_user_id_recovered_onto_survivor(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_external_ids"
                    " WHERE contributor_id = :w AND authority = 'x_user' AND external_key = :k",
                    w=ids["winner"],
                    k=ids["x_user_id"],
                )
                == 1
            )

    # === privacy ===========================================================
    def test_privacy_cleanup(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            display = self._scalar(
                s, "SELECT display_name FROM contributors WHERE id = :c", c=ids["priv"]
            )
            assert "@" not in display and display.strip() != ""
            # no email/URL survives in any display or alias, globally
            assert (
                self._scalar(s, "SELECT count(*) FROM contributors WHERE display_name LIKE '%@%'")
                == 0
            )
            assert (
                self._scalar(s, "SELECT count(*) FROM contributor_aliases WHERE alias LIKE '%@%'")
                == 0
            )
            assert (
                self._scalar(s, "SELECT count(*) FROM contributor_aliases WHERE alias LIKE 'http%'")
                == 0
            )
            # still has a resolving alias
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_aliases"
                    " WHERE contributor_id = :c AND resolves_identity",
                    c=ids["priv"],
                )
                >= 1
            )

    def test_embedded_email_display_stripped_to_remainder(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            # usable human remainder kept; address, wrapper and trailing "."
            # separator all gone.
            assert (
                self._scalar(
                    s, "SELECT display_name FROM contributors WHERE id = :c", c=ids["priv_embed"]
                )
                == "Dr. Jane Roe"
            )
            # no alias for this contributor carries an address
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_aliases"
                    " WHERE contributor_id = :c AND alias LIKE '%@%'",
                    c=ids["priv_embed"],
                )
                == 0
            )
            # the sanitized remainder is the resolving canonical display alias
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_aliases WHERE contributor_id = :c"
                    " AND resolves_identity AND alias = 'Dr. Jane Roe'",
                    c=ids["priv_embed"],
                )
                >= 1
            )
            # embedded-address-only display falls back to the sanitized local part
            solo = self._scalar(
                s, "SELECT display_name FROM contributors WHERE id = :c", c=ids["priv_embed_only"]
            )
            assert solo == "solo" and "@" not in solo

    # === credit salvage ====================================================
    def test_manual_salvage_sets_flag_and_drops_machine(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s,
                    "SELECT authors_manually_managed FROM media WHERE id = :m",
                    m=ids["media_manual"],
                )
                is True
            )
            rows = self._rows(
                s,
                "SELECT contributor_id FROM contributor_credits WHERE media_id = :m AND role = 'author'",
                m=ids["media_manual"],
            )
            assert len(rows) == 1 and str(rows[0][0]) == str(ids["cm_manual"])

    def test_machine_only_media_stays_automatic(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s,
                    "SELECT authors_manually_managed FROM media WHERE id = :m",
                    m=ids["media_auto"],
                )
                is False
            )
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_credits WHERE media_id = :m",
                    m=ids["media_auto"],
                )
                == 1
            )

    def test_credit_dedup_after_collapse(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s,
                "SELECT contributor_id, ordinal FROM contributor_credits"
                " WHERE media_id = :m AND role = 'author'",
                m=ids["media_shared"],
            )
            assert len(rows) == 1, "two same-role credits on one target dedup after collapse"
            assert str(rows[0][0]) == str(ids["winner"])
            assert rows[0][1] == 0, "dense renumber"

    def test_non_author_roles_preserved(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            media = dict(
                self._rows(
                    s,
                    "SELECT role, ordinal FROM contributor_credits WHERE media_id = :m",
                    m=ids["media_roles"],
                )
            )
            assert media == {"author": 0, "translator": 1}
            pod = dict(
                self._rows(
                    s,
                    "SELECT role, ordinal FROM contributor_credits WHERE podcast_id = :p",
                    p=ids["podcast"],
                )
            )
            assert pod == {"host": 0, "guest": 1}
            assert (
                self._scalar(
                    s,
                    "SELECT role FROM contributor_credits WHERE project_gutenberg_catalog_ebook_id = :e",
                    e=ids["ebook"],
                )
                == "author"
            )

    def test_over_limit_slice_truncated_to_dense_twenty(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            ordinals = [
                r[0]
                for r in self._rows(
                    s,
                    "SELECT ordinal FROM contributor_credits WHERE media_id = :m ORDER BY ordinal",
                    m=ids["media_big"],
                )
            ]
            assert ordinals == list(range(20)), "truncated to first 20 with dense ordinals"
            # the tail contributors lost their only credit on this target
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM contributor_credits WHERE media_id = :m AND contributor_id = :c",
                    m=ids["media_big"],
                    c=ids["big_authors"][24],
                )
                == 0
            )

    def test_dense_ordinals_and_no_duplicate_role_per_target(self, migrated):
        engine, _ = migrated
        with Session(engine) as s:
            # dense per-target ordinals (0..n-1) for every target column
            for col in ("media_id", "podcast_id", "project_gutenberg_catalog_ebook_id"):
                by_target: dict = {}
                for target, ordinal in self._rows(
                    s,
                    f"SELECT {col}, ordinal FROM contributor_credits"
                    f" WHERE {col} IS NOT NULL ORDER BY {col}, ordinal",
                ):
                    by_target.setdefault(target, []).append(ordinal)
                for target, ordinals in by_target.items():
                    assert ordinals == list(range(len(ordinals))), (
                        f"non-dense ordinals for {col}={target}: {ordinals}"
                    )
            # no duplicate (target, contributor, role)
            dup = self._rows(
                s,
                "SELECT media_id, contributor_id, role FROM contributor_credits"
                " WHERE media_id IS NOT NULL GROUP BY media_id, contributor_id, role"
                " HAVING count(*) > 1",
            )
            assert dup == []

    # === reconciliation deletion ==========================================
    def test_reconciliation_product_deleted(self, migrated):
        engine, _ = migrated
        with Session(engine) as s:
            for table in (
                "contributor_reconciliation_runs",
                "contributor_reconciliation_candidates",
                "contributor_identity_events",
            ):
                assert (
                    self._scalar(
                        s,
                        "SELECT count(*) FROM information_schema.tables WHERE table_name = :t",
                        t=table,
                    )
                    == 0
                ), f"{table} must be dropped"
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM background_jobs WHERE kind = 'contributor_reconciliation'",
                )
                == 0
            )

    # === reference / graph rewrites =======================================
    def test_pin_repoint_and_softdeleted_collision(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            # simple repoint
            assert (
                self._scalar(
                    s, "SELECT object_id FROM user_pinned_objects WHERE id = :p", p=ids["pin_a"]
                )
                == ids["winner"]
            )
            # active winner pin survives; soft-deleted colliding pin is removed
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM user_pinned_objects WHERE id = :p", p=ids["pin_b"]
                )
                == 1
            )
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM user_pinned_objects WHERE id = :p", p=ids["pin_c"]
                )
                == 0
            )
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM user_pinned_objects"
                    " WHERE surface_key = 'home' AND object_type = 'contributor' AND object_id = :w",
                    w=ids["winner"],
                )
                == 1
            )

    def test_resource_version_collision(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s, "SELECT resource_id FROM resource_versions WHERE id = :v", v=ids["rv1"]
                )
                == ids["winner"]
            )
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_versions WHERE id = :v", v=ids["rv2"]
                )
                == 1
            ), "greatest (version, updated_at, id) kept"
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_versions WHERE id = :v", v=ids["rv3"]
                )
                == 0
            )

    def test_view_state_surface_target_edge_and_collision(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s, "SELECT surface_id FROM resource_view_states WHERE id = :v", v=ids["vs_surf"]
                )
                == ids["winner"]
            )
            assert (
                self._scalar(
                    s,
                    "SELECT target_id FROM resource_view_states WHERE id = :v",
                    v=ids["vs_target"],
                )
                == ids["winner"]
            )
            assert (
                self._scalar(
                    s, "SELECT edge_id FROM resource_view_states WHERE id = :v", v=ids["vs_edge"]
                )
                == ids["edge_keep"]
            ), "edge rebound to collision winner"
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_view_states WHERE id = :v", v=ids["vs_e1"]
                )
                == 1
            ), "latest (updated_at, id) kept"
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_view_states WHERE id = :v", v=ids["vs_e2"]
                )
                == 0
            )

    def test_turn_context_both_pairs_and_self_edge_null(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            row = self._rows(
                s,
                "SELECT requested_subject_id, subject_id, subject_context_edge_id"
                " FROM chat_run_turn_contexts WHERE chat_run_id = :r",
                r=ids["chat_run"],
            )[0]
            assert row[0] == ids["winner"]
            assert row[1] == ids["winner"]
            assert row[2] is None, "removed self-edge nulls the context edge"

    def test_edges_collision_self_and_snapshot(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_edges WHERE id = :e", e=ids["edge_keep"]
                )
                == 1
            )
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_edges WHERE id = :e", e=ids["edge_collide"]
                )
                == 0
            ), "bare-pair collision collapsed"
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_edges WHERE id = :e", e=ids["edge_self"]
                )
                == 0
            ), "self-edge removed"
            snap_target, snap = self._rows(
                s,
                "SELECT target_id, snapshot::text FROM resource_edges WHERE id = :e",
                e=ids["edge_snap"],
            )[0]
            assert snap_target == ids["winner"], "citation target endpoint repointed"
            assert ids["winner_h"] in snap and ids["loser1_h"] not in snap

    def test_folio_required_rebind_and_cited_edge(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(
                    s,
                    "SELECT edge_id FROM oracle_reading_folios WHERE reading_id = :r",
                    r=ids["reading"],
                )
                == ids["edge_keep"]
            ), "required folio edge rebound to collision winner"
            assert (
                self._scalar(
                    s,
                    "SELECT cited_edge_id FROM message_retrievals WHERE id = :m",
                    m=ids["mr_contrib"],
                )
                == ids["edge_keep"]
            )
            assert (
                self._scalar(
                    s,
                    "SELECT cited_edge_id FROM message_retrievals WHERE id = :m",
                    m=ids["mr_media"],
                )
                is None
            ), "cited edge to a removed self-edge is nulled"

    def test_synapse_suppression_delete_exemption(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            # both contributor-endpoint suppressions deleted, not repointed
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM synapse_suppressions"
                    " WHERE source_scheme = 'contributor' OR target_scheme = 'contributor'",
                )
                == 0
            )
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM synapse_suppressions"
                    " WHERE source_id = :w OR target_id = :w",
                    w=ids["winner"],
                )
                == 0
            ), "survivor did not inherit a negative pair"

    def test_retrieval_scalar_and_json_refs_rewritten(self, migrated):
        engine, ids = migrated
        wh = ids["winner_h"]
        with Session(engine) as s:
            row = self._rows(
                s,
                "SELECT source_id, deep_link, context_ref::text, result_ref::text"
                " FROM message_retrievals WHERE id = :m",
                m=ids["mr_contrib"],
            )[0]
            assert row[0] == wh
            assert row[1] == f"/authors/{wh}"
            assert wh in row[2] and wh in row[3]

    def test_chat_json_refs_rewritten_to_winner(self, migrated):
        # loser-absence is covered by the generic scanner; here we prove the
        # refs were REWRITTEN to the survivor rather than merely deleted.
        engine, ids = migrated
        wh, wuri = ids["winner_h"], f"contributor:{ids['winner']}"
        with Session(engine) as s:
            tc = self._rows(
                s,
                "SELECT result_refs::text, selected_context_refs::text"
                " FROM message_tool_calls WHERE id = :t",
                t=ids["tool_call"],
            )[0]
            assert wh in tc[0] and wh in tc[1]
            ledger = self._scalar(
                s,
                "SELECT result_ref::text FROM message_retrieval_candidate_ledgers"
                " WHERE tool_call_id = :t",
                t=ids["tool_call"],
            )
            assert wh in ledger
            pa = self._rows(
                s,
                "SELECT included_context_refs::text, prompt_block_manifest::text,"
                " dropped_items::text FROM chat_prompt_assemblies WHERE chat_run_id = :r",
                r=ids["chat_run"],
            )[0]
            assert wuri in pa[0] and wh in pa[0]  # URI string + typed object
            assert wuri in pa[1] and wuri in pa[2]
            # collapsed edge id rebinds to the collision winner (D-18.2);
            # non-collapsed edge ids pass through untouched
            assert str(ids["edge_keep"]) in pa[0]
            assert str(ids["edge_collide"]) not in pa[0]
            assert str(ids["arb_edge"]) in pa[0]
            meta = self._scalar(
                s,
                "SELECT payload::text FROM chat_run_events"
                " WHERE run_id = :r AND event_type = 'meta'",
                r=ids["chat_run"],
            )
            assert wuri in meta
            assert str(ids["edge_keep"]) in meta
            assert str(ids["edge_collide"]) not in meta
            assert str(ids["arb_edge"]) in meta
            tool = self._scalar(
                s,
                "SELECT payload::text FROM chat_run_events"
                " WHERE run_id = :r AND event_type = 'tool_result'",
                r=ids["chat_run"],
            )
            assert wh in tool  # results handles + filters authors

    def test_note_body_pm_nodes_rewritten(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            body = self._scalar(
                s, "SELECT body_pm_json::text FROM note_blocks WHERE user_id = :u", u=ids["user"]
            )
            assert str(ids["winner"]) in body
            assert str(ids["loser1"]) not in body and str(ids["loser2"]) not in body

    def test_mutation_memos(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            # memo scoped to a losing contributor UUID is deleted
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM resource_mutations WHERE mutation_scope = :sc",
                    sc=f"contributor:{ids['loser1']}:display-name",
                )
                == 0
            )
            # the winner-scoped memo survives
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM resource_mutations WHERE mutation_scope = :sc",
                    sc=f"contributor:{ids['winner']}:display-name",
                )
                == 1
            )
            # response-ref memo survives with rewritten refs
            body = self._scalar(
                s,
                "SELECT response_json::text FROM resource_mutations WHERE client_mutation_id = 'cm-ref'",
            )
            assert str(ids["winner"]) in body and ids["winner_h"] in body
            # the husk-scoped memo is deleted with the loser scope
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM resource_mutations WHERE mutation_scope = :sc",
                    sc=f"contributor:{ids['husk']}:display-name",
                )
                == 0
            )
            # pre-existing junk contributor scope (uuid never keyed a
            # contributor) survives untouched and does not abort postconditions
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM resource_mutations WHERE mutation_scope = :sc",
                    sc=f"contributor:{ids['junk_scope_uuid']}:display-name",
                )
                == 1
            )

    # === husk / chain / alias-flip / salvage-recency ======================
    def test_husk_no_survivor_references_purged(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            assert (
                self._scalar(s, "SELECT count(*) FROM contributors WHERE id = :c", c=ids["husk"])
                == 0
            )
            assert (
                self._scalar(
                    s,
                    "SELECT count(*) FROM user_pinned_objects WHERE id = :p",
                    p=ids["husk_pin"],
                )
                == 0
            ), "husk pin must be purged, never repointed"
            assert (
                self._scalar(
                    s, "SELECT count(*) FROM resource_edges WHERE id = :e", e=ids["husk_edge"]
                )
                == 0
            ), "husk-endpoint edge dropped with no winner"
            for table, col in (
                ("resource_versions", "resource_id"),
                ("resource_view_states", "surface_id"),
                ("synapse_suppressions", "source_id"),
                ("contributor_aliases", "contributor_id"),
                ("contributor_external_ids", "contributor_id"),
            ):
                assert (
                    self._scalar(s, f"SELECT count(*) FROM {table} WHERE {col} = :c", c=ids["husk"])
                    == 0
                ), f"{table} still references the husk"

    def test_deep_merged_chain_maps_to_survivor(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            for cid in ids["chain"]:
                assert (
                    self._scalar(s, "SELECT count(*) FROM contributors WHERE id = :c", c=cid) == 0
                )
            assert str(
                self._scalar(
                    s,
                    "SELECT object_id FROM user_pinned_objects WHERE id = :p",
                    p=ids["chain_pin"],
                )
            ) == str(ids["chain_end"]), (
                "a nine-deep merged chain must still repoint to the active end"
                " (never silently degrade to a husk and delete the reference)"
            )

    def test_machine_display_alias_force_flipped_resolving(self, migrated):
        # ALL prod display aliases are machine-source copies (S0 preflight);
        # this flip is what satisfies "every display owns a resolving alias".
        engine, ids = migrated
        with Session(engine) as s:
            rows = self._rows(
                s,
                "SELECT alias, resolves_identity FROM contributor_aliases"
                " WHERE contributor_id = :c",
                c=ids["machine_alias"],
            )
            assert rows == [("Machine Alias Only", True)], (
                "the provider display copy must FLIP to resolving (no duplicate row)"
            )

    def test_machine_slice_recency_and_tie_salvage(self, migrated):
        engine, ids = migrated
        with Session(engine) as s:
            recency = self._rows(
                s,
                "SELECT contributor_id FROM contributor_credits WHERE media_id = :m",
                m=ids["media_recency"],
            )
            assert [str(r[0]) for r in recency] == [str(ids["rec_new"])], (
                "the newer web_article_byline slice beats the stale metadata_enrichment slice"
            )
            tie = self._rows(
                s,
                "SELECT contributor_id FROM contributor_credits WHERE media_id = :m",
                m=ids["media_tie"],
            )
            assert [str(r[0]) for r in tie] == [str(ids["tie_meta"])], (
                "an exact MAX(updated_at) tie falls to source name ascending"
            )

    # === the generic no-losing-ref scanner (AC 32) ========================
    def test_no_losing_reference_survives_anywhere(self, migrated):
        engine, ids = migrated
        needles = [str(x) for x in ids["loser_uuids"]] + list(ids["loser_handles"])
        with Session(engine) as s:
            hits: list[str] = []
            for table, col in _JSONB_REF_COLUMNS + _SCALAR_REF_COLUMNS:
                cast = f"{col}::text" if (table, col) in _JSONB_REF_COLUMNS else col
                for needle in needles:
                    n = self._scalar(
                        s,
                        f"SELECT count(*) FROM {table} WHERE {cast} LIKE :pat",
                        pat=f"%{needle}%",
                    )
                    if n:
                        hits.append(f"{table}.{col} contains {needle} ({n} rows)")
            for table, disc, idcol in _POLY_UUID_COLUMNS:
                for lid in ids["loser_uuids"]:
                    n = self._scalar(
                        s,
                        f"SELECT count(*) FROM {table} WHERE {disc} = 'contributor' AND {idcol} = :id",
                        id=lid,
                    )
                    if n:
                        hits.append(f"{table}.{idcol} points at loser {lid} ({n} rows)")
            assert hits == [], f"losing references survived: {hits}"

    # === preflight failures — abort + no partial state (AC 33) ============
    def _assert_no_partial_state(self, engine, before):
        with Session(engine) as s:
            assert self._scalar(s, "SELECT version_num FROM alembic_version") == _MIG_PREV
            for table, expected in before.items():
                assert self._scalar(s, f"SELECT count(*) FROM {table}") == expected, table

    def _snapshot_counts(self, engine):
        with Session(engine) as s:
            return {
                t: self._scalar(s, f"SELECT count(*) FROM {t}")
                for t in (
                    "contributors",
                    "contributor_aliases",
                    "contributor_external_ids",
                    "contributor_credits",
                )
            }

    def _run_failure_case(self, seed):
        reset_test_schema()
        assert run_alembic_command(f"upgrade {_MIG_PREV}").returncode == 0
        engine = create_engine(get_test_database_url())
        try:
            with Session(engine) as s:
                seed(s)
                s.commit()
            before = self._snapshot_counts(engine)
            result = run_alembic_command(f"upgrade {_MIG_REV}")
            combined = (result.stdout or "") + (result.stderr or "")
            assert result.returncode != 0, f"expected abort; got success: {combined}"
            assert "0179" in combined
            self._assert_no_partial_state(engine, before)
            return combined
        finally:
            engine.dispose()
            reset_test_schema()
            run_alembic_command("upgrade head")

    def test_preflight_rejects_unknown_alias_source(self):
        def seed(s):
            cid = uuid4()
            _insert_contributor(
                s, cid=cid, handle="unknown-src-x0", display="Unknown Source", created_at=_ts(2020)
            )
            _insert_alias(s, cid=cid, alias="Other Spelling", source="totally_unknown_source")

        combined = self._run_failure_case(seed)
        assert "preflight" in combined

    def test_preflight_rejects_unknown_authority(self):
        def seed(s):
            cid = uuid4()
            _insert_contributor(
                s,
                cid=cid,
                handle="unknown-auth-x0",
                display="Unknown Authority",
                created_at=_ts(2020),
            )
            # drop the 0178 CHECK so an authority the migration doesn't classify
            # can exist; the migration must not blindly trust the old constraint.
            s.execute(
                text(
                    "ALTER TABLE contributor_external_ids"
                    " DROP CONSTRAINT ck_contributor_external_ids_authority"
                )
            )
            _insert_xid(s, cid=cid, authority="mystery_authority", external_key="k1")

        self._run_failure_case(seed)

    def test_preflight_rejects_unknown_ref_shape_in_unlisted_column(self):
        # Three rows in an unlisted jsonb column, one per structural needle
        # class: a typed object, a credit-blob contributor_handle key, and a
        # '/authors/' deep-link value. The diagnostic must count all three (a
        # needle regression would report fewer).
        def seed(s):
            for payload in (
                {"type": "contributor", "id": "ghost-handle"},
                {"result": {"contributor_handle": "ghost-handle"}},
                {"nav": {"href": "/authors/ghost-handle"}},
            ):
                s.execute(
                    text(
                        "INSERT INTO background_jobs (kind, payload, status)"
                        " VALUES ('media_ingest', CAST(:p AS jsonb), 'pending')"
                    ),
                    {"p": _dumps(payload)},
                )

        combined = self._run_failure_case(seed)
        assert "preflight" in combined
        assert "('background_jobs', 'payload', 3)" in combined

    def test_preflight_rejects_unknown_role(self):
        def seed(s):
            cid, mid = uuid4(), uuid4()
            _insert_contributor(
                s, cid=cid, handle="unknown-role-x0", display="Unknown Role", created_at=_ts(2020)
            )
            _insert_media(s, mid=mid, title="Unknown Role Work")
            # drop the 0178 CHECK so a role the migration doesn't classify can
            # exist; the migration must diagnose the value, not KeyError on it.
            s.execute(
                text("ALTER TABLE contributor_credits DROP CONSTRAINT ck_contributor_credits_role")
            )
            _insert_credit(s, cid=cid, role="illustrator", ordinal=0, source="epub_opf", media=mid)

        combined = self._run_failure_case(seed)
        assert "preflight" in combined
        assert "illustrator" in combined

    def test_preflight_rejects_provider_key_display(self):
        # A display equal to the RAW (undashed) form of a stored ORCID: not an
        # email (no re-derivation rule) and invisible to canonical-only or
        # alias-side checks — must fail preflight, never survive as a
        # key-leaking display.
        def seed(s):
            cid = uuid4()
            _insert_contributor(
                s,
                cid=cid,
                handle="key-display-k0",
                display="0000000218250097",
                created_at=_ts(2020),
            )
            _insert_xid(s, cid=cid, authority="orcid", external_key="0000000218250097")

        combined = self._run_failure_case(seed)
        assert "preflight" in combined
        assert "re-derivation rule" in combined

    def test_husk_foreign_references_block_before_destructive_ddl(self):
        # A no-survivor husk referenced by a FOREIGN-scoped memo and by the
        # snapshot of an edge whose endpoints are NOT the husk: neither can be
        # repointed (no survivor) nor safely deleted (foreign owners), so
        # phase 5 must abort with both owners named — before destructive DDL,
        # with no partial state.
        def seed(s):
            u, husk, page = uuid4(), uuid4(), uuid4()
            s.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u})
            _insert_contributor(
                s,
                cid=husk,
                handle="husk-foreign-f0",
                display="Husk Foreign",
                created_at=_ts(2020),
                status="tombstoned",
            )
            s.execute(
                text(
                    """
                    INSERT INTO resource_mutations (
                        user_id, mutation_scope, client_mutation_id, request_hash,
                        changed_lanes, response_json
                    )
                    VALUES (:u, :scope, 'cm-foreign', :h, '{}'::jsonb, CAST(:r AS jsonb))
                    """
                ),
                {
                    "u": u,
                    "scope": f"resource:page:{page}:outgoing_edges",
                    "h": _HASH64,
                    "r": _dumps({"items": [{"ref": f"contributor:{husk}"}]}),
                },
            )
            s.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        id, user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, ordinal, snapshot, created_at
                    )
                    VALUES (:id, :u, 'context', 'citation', 'message', :m,
                            'media', :md, 1, CAST(:snap AS jsonb), :ca)
                    """
                ),
                {
                    "id": uuid4(),
                    "u": u,
                    "m": uuid4(),
                    "md": uuid4(),
                    "snap": _dumps({"title": "x", "contributor_handle": "husk-foreign-f0"}),
                    "ca": _ts(2020),
                },
            )

        combined = self._run_failure_case(seed)
        # the DEFERRED phase-5 husk scan must fire (failing before phase 6's
        # destructive DDL), not the late phase-7 postcondition re-scan
        assert "cannot be repointed or safely deleted" in combined
        assert "response_json" in combined and "snapshot" in combined
        assert "postcondition" not in combined

    def test_bare_scalar_source_id_only_reference_rewritten(self):
        # A loser whose ONLY stored reference is the BARE handle in a scalar
        # source_id column (handle-free result_ref): quoted / deep-link needles
        # are provably blind here, so the rewrite gate and the phase-7 re-scan
        # must probe scalars by exact equality — phase 5 must run and rewrite.
        reset_test_schema()
        assert run_alembic_command(f"upgrade {_MIG_PREV}").returncode == 0
        engine = create_engine(get_test_database_url())
        try:
            ids: dict = {
                "user": uuid4(),
                "model": uuid4(),
                "conversation": uuid4(),
                "msg_user": uuid4(),
                "msg_assistant": uuid4(),
                "chat_run": uuid4(),
                "reading": uuid4(),
            }
            winner, loser, tool_call = uuid4(), uuid4(), uuid4()
            with Session(engine) as s:
                _build_chat_parents(s, ids)
                _insert_contributor(
                    s,
                    cid=winner,
                    handle="scal-winner-w1",
                    display="Scalar Person",
                    created_at=_ts(2020),
                )
                _insert_contributor(
                    s,
                    cid=loser,
                    handle="scal-loser-l2",
                    display="Scalar Person",
                    created_at=_ts(2021),
                )
                s.execute(
                    text(
                        """
                        INSERT INTO message_tool_calls (
                            id, conversation_id, user_message_id, assistant_message_id,
                            tool_name, tool_call_index, scope, status,
                            result_refs, selected_context_refs
                        )
                        VALUES (:id, :c, :mu, :ma, 'app_search', 0, 'all', 'complete',
                                '[]'::jsonb, '[]'::jsonb)
                        """
                    ),
                    {
                        "id": tool_call,
                        "c": ids["conversation"],
                        "mu": ids["msg_user"],
                        "ma": ids["msg_assistant"],
                    },
                )
                s.execute(
                    text(
                        """
                        INSERT INTO message_retrieval_candidate_ledgers (
                            tool_call_id, ordinal, result_type, source_id, selected,
                            included_in_prompt, selection_status, selection_reason, result_ref
                        )
                        VALUES (:tc, 0, 'contributor', 'scal-loser-l2', false, false,
                                'retrieved', 'seed', CAST(:res AS jsonb))
                        """
                    ),
                    {"tc": tool_call, "res": _dumps({"note": "handle-free result ref"})},
                )
                s.commit()
            result = run_alembic_command(f"upgrade {_MIG_REV}")
            assert result.returncode == 0, f"0179 upgrade failed: {result.stderr}"
            with Session(engine) as s:
                assert (
                    self._scalar(
                        s,
                        "SELECT source_id FROM message_retrieval_candidate_ledgers"
                        " WHERE tool_call_id = :t",
                        t=tool_call,
                    )
                    == "scal-winner-w1"
                ), "bare source_id must be rewritten to the survivor handle"
                assert self._scalar(s, "SELECT count(*) FROM contributors") == 1
        finally:
            engine.dispose()
            reset_test_schema()
            run_alembic_command("upgrade head")

    def test_abort_on_folio_edge_without_winner(self):
        # Exercises the phase-5 reference-rewrite abort (the deep rebind check
        # is deliberately NOT phase-1 preflight); the load-bearing assertions
        # are rc != 0 plus no-partial-state.
        def seed(s):
            u = uuid4()
            winner, loser = uuid4(), uuid4()
            reading, edge = uuid4(), uuid4()
            s.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": u})
            _insert_contributor(
                s,
                cid=winner,
                handle="folio-winner-w0",
                display="Folio Person",
                created_at=_ts(2020),
            )
            _insert_contributor(
                s, cid=loser, handle="folio-loser-l0", display="Folio Person", created_at=_ts(2021)
            )
            s.execute(
                text(
                    """
                    INSERT INTO oracle_readings (id, user_id, folio_number, question_text, status)
                    VALUES (:id, :u, 1, 'A question.', 'pending')
                    """
                ),
                {"id": reading, "u": u},
            )
            # edge collapses to a self-edge (loser->winner becomes winner->winner)
            s.execute(
                text(
                    """
                    INSERT INTO resource_edges (
                        id, user_id, kind, origin, source_scheme, source_id,
                        target_scheme, target_id, created_at
                    )
                    VALUES (:id, :u, 'context', 'user', 'contributor', :l,
                            'contributor', :w, :ca)
                    """
                ),
                {"id": edge, "u": u, "l": loser, "w": winner, "ca": _ts(2021)},
            )
            s.execute(
                text(
                    """
                    INSERT INTO oracle_reading_folios (
                        reading_id, phase, edge_id, source_kind, locator_label,
                        attribution_text, marginalia_text
                    )
                    VALUES (:r, 'descent', :e, 'user_media', 'l', 'a', 'm')
                    """
                ),
                {"r": reading, "e": edge},
            )

        combined = self._run_failure_case(seed)
        assert "oracle_reading_folios" in combined

    def test_preflight_rejects_reserved_handle(self):
        def seed(s):
            _insert_contributor(
                s, cid=uuid4(), handle="directory", display="Reserved One", created_at=_ts(2020)
            )

        combined = self._run_failure_case(seed)
        assert "preflight" in combined

    # === downgrade blocked + fresh-DB head shape ==========================
    def test_0179_downgrade_is_blocked(self):
        reset_test_schema()
        try:
            assert run_alembic_command(f"upgrade {_MIG_REV}").returncode == 0
            result = run_alembic_command(f"downgrade {_MIG_PREV}")
            assert result.returncode != 0
            combined = (result.stdout or "") + (result.stderr or "")
            assert "Hard cutover" in combined
        finally:
            reset_test_schema()
            run_alembic_command("upgrade head")

    def test_fresh_db_head_shape(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            assert run_alembic_command("upgrade head").returncode == 0
            with Session(engine) as s:

                def cols(t):
                    return {
                        r[0]
                        for r in self._rows(
                            s,
                            "SELECT column_name FROM information_schema.columns WHERE table_name = :t",
                            t=t,
                        )
                    }

                def idx(t):
                    return {
                        r[0]: r[1]
                        for r in self._rows(
                            s,
                            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = :t",
                            t=t,
                        )
                    }

                assert cols("contributors") == {
                    "id",
                    "handle",
                    "display_name",
                    "created_at",
                    "updated_at",
                }
                assert cols("contributor_aliases") == {
                    "id",
                    "contributor_id",
                    "alias",
                    "normalized_alias",
                    "resolves_identity",
                    "created_at",
                }
                assert "external_url" not in cols("contributor_external_ids")
                assert "source" not in cols("contributor_external_ids")
                credit_cols = cols("contributor_credits")
                for dead in ("source_ref", "resolution_status", "confidence"):
                    assert dead not in credit_cols

                # media flag default
                default = self._scalar(
                    s,
                    "SELECT column_default FROM information_schema.columns"
                    " WHERE table_name = 'media' AND column_name = 'authors_manually_managed'",
                )
                assert default is not None and "false" in default

                # no CHECK constraints remain on contributor tables
                assert (
                    self._scalar(
                        s,
                        "SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conrelid::regclass::text IN"
                        " ('contributors','contributor_aliases','contributor_external_ids','contributor_credits')",
                    )
                    == 0
                )

                alias_idx = idx("contributor_aliases")
                assert "uq_contributor_aliases_owner_normalized" in alias_idx
                assert "ix_contributor_aliases_resolution" in alias_idx
                assert "ix_contributor_aliases_normalized_alias" not in alias_idx

                credit_idx = idx("contributor_credits")
                assert "ix_contributor_credits_contributor_id" in credit_idx
                for dead in (
                    "ix_contributor_credits_media_id",
                    "ix_contributor_credits_podcast_id",
                    "ix_contributor_credits_gutenberg_ebook_id",
                ):
                    assert dead not in credit_idx
                # the six partial-unique indexes with their exact predicates
                expected_predicates = {
                    "uq_contributor_credits_media_ordinal": "(media_id IS NOT NULL)",
                    "uq_contributor_credits_media_contributor_role": "(media_id IS NOT NULL)",
                    "uq_contributor_credits_podcast_ordinal": "(podcast_id IS NOT NULL)",
                    "uq_contributor_credits_podcast_contributor_role": "(podcast_id IS NOT NULL)",
                    "uq_contributor_credits_gutenberg_ordinal": "(project_gutenberg_catalog_ebook_id IS NOT NULL)",
                    "uq_contributor_credits_gutenberg_contributor_role": "(project_gutenberg_catalog_ebook_id IS NOT NULL)",
                }
                for name, predicate in expected_predicates.items():
                    assert name in credit_idx, f"missing {name}"
                    assert "UNIQUE" in credit_idx[name]
                    assert predicate in credit_idx[name], f"{name} predicate: {credit_idx[name]}"

                assert "ix_contributors_sort_name" not in idx("contributors")
        finally:
            engine.dispose()
            reset_test_schema()


class TestMigration0180ReaderProgressContinuity:
    """0180 cuts reader_media_state to one non-null locator plus a revision
    conflict token, recreates its FKs under stable non-cascading names, and
    backfills a zero-dwell reading_sessions row for cursors that lack one."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_head_locator_not_null_revision_default_and_legacy_check_dropped(self, head_engine):
        with Session(head_engine) as session:
            columns = {
                row[0]: row
                for row in session.execute(
                    text(
                        """
                        SELECT column_name, is_nullable, data_type, column_default
                        FROM information_schema.columns
                        WHERE table_name = 'reader_media_state'
                          AND column_name IN ('locator', 'revision')
                        """
                    )
                ).fetchall()
            }
            constraints = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT conname FROM pg_constraint"
                        " WHERE conrelid = 'reader_media_state'::regclass"
                    )
                ).fetchall()
            }

        assert columns["locator"][1] == "NO", columns["locator"]
        assert columns["revision"][1] == "NO", columns["revision"]
        assert columns["revision"][2] == "bigint", columns["revision"]
        assert columns["revision"][3] is not None and "1" in columns["revision"][3]
        assert "ck_reader_media_state_locator" not in constraints

        # The NOT NULL is real, not just metadata: a NULL-locator insert is rejected.
        with Session(head_engine) as session:
            user_id = uuid4()
            media_id = uuid4()
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status)"
                    " VALUES (:id, 'web_article', 'M', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            session.commit()

            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO reader_media_state (id, user_id, media_id, locator)"
                        " VALUES (:id, :user_id, :media_id, NULL)"
                    ),
                    {"id": uuid4(), "user_id": user_id, "media_id": media_id},
                )
                session.commit()
            session.rollback()

            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_head_foreign_keys_are_stable_named_and_non_cascading(self, head_engine):
        with Session(head_engine) as session:
            fk_rows = session.execute(
                text(
                    "SELECT conname, confdeltype FROM pg_constraint"
                    " WHERE conrelid = 'reader_media_state'::regclass AND contype = 'f'"
                )
            ).fetchall()

        fk_by_name = {row[0]: row[1] for row in fk_rows}
        assert set(fk_by_name) == {"fk_reader_media_state_user", "fk_reader_media_state_media"}
        assert fk_by_name["fk_reader_media_state_user"] == "a", (
            "user FK must be NO ACTION: there is no product user-delete flow yet"
        )
        assert fk_by_name["fk_reader_media_state_media"] == "a", (
            "media FK must be NO ACTION: media deletion already removes child rows itself"
        )

    def test_upgrade_deletes_null_locator_rows_and_versions_survivors(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0178")
            assert result.returncode == 0, f"upgrade 0178 failed: {result.stderr}"

            null_locator_user = uuid4()
            null_locator_media = uuid4()
            surviving_user = uuid4()
            surviving_media = uuid4()

            with Session(engine) as session:
                for user_id, media_id in (
                    (null_locator_user, null_locator_media),
                    (surviving_user, surviving_media),
                ):
                    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                    session.execute(
                        text(
                            "INSERT INTO media (id, kind, title, processing_status)"
                            " VALUES (:id, 'web_article', 'M', 'ready_for_reading')"
                        ),
                        {"id": media_id},
                    )
                session.execute(
                    text(
                        "INSERT INTO reader_media_state (id, user_id, media_id, locator)"
                        " VALUES (:id, :user_id, :media_id, NULL)"
                    ),
                    {
                        "id": uuid4(),
                        "user_id": null_locator_user,
                        "media_id": null_locator_media,
                    },
                )
                session.execute(
                    text(
                        "INSERT INTO reader_media_state (id, user_id, media_id, locator)"
                        " VALUES (:id, :user_id, :media_id, CAST(:locator AS jsonb))"
                    ),
                    {
                        "id": uuid4(),
                        "user_id": surviving_user,
                        "media_id": surviving_media,
                        "locator": json.dumps({"kind": "pdf", "page": 1, "zoom": 1.0}),
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                null_row = session.execute(
                    text("SELECT 1 FROM reader_media_state WHERE user_id = :u AND media_id = :m"),
                    {"u": null_locator_user, "m": null_locator_media},
                ).scalar_one_or_none()
                surviving_revision = session.execute(
                    text(
                        "SELECT revision FROM reader_media_state"
                        " WHERE user_id = :u AND media_id = :m"
                    ),
                    {"u": surviving_user, "m": surviving_media},
                ).scalar_one_or_none()

            assert null_row is None, (
                "null-locator rows were the removed clear semantics and must be deleted"
            )
            assert surviving_revision == 1
        finally:
            reset_test_schema()
            engine.dispose()

    def test_backfill_seeds_zero_dwell_sessions_for_cursors_without_one(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0178")
            assert result.returncode == 0, f"upgrade 0178 failed: {result.stderr}"

            user_id = uuid4()
            # No prior session: must gain a zero-dwell '__migrated__' session.
            fresh_media_id = uuid4()
            # Already has a session: the NOT EXISTS guard must add nothing more.
            covered_media_id = uuid4()

            cursor_updated_at = datetime(2026, 7, 1, 12, 0, 0, tzinfo=UTC)
            existing_session_id = uuid4()

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                for media_id, kind in (
                    (fresh_media_id, "web_article"),
                    (covered_media_id, "web_article"),
                ):
                    session.execute(
                        text(
                            "INSERT INTO media (id, kind, title, processing_status)"
                            " VALUES (:id, :kind, 'M', 'ready_for_reading')"
                        ),
                        {"id": media_id, "kind": kind},
                    )

                def _insert_cursor(media_id, locator: dict) -> None:
                    session.execute(
                        text(
                            """
                            INSERT INTO reader_media_state (id, user_id, media_id, locator, updated_at)
                            VALUES (:id, :user_id, :media_id, CAST(:locator AS jsonb), :updated_at)
                            """
                        ),
                        {
                            "id": uuid4(),
                            "user_id": user_id,
                            "media_id": media_id,
                            "locator": json.dumps(locator),
                            "updated_at": cursor_updated_at,
                        },
                    )

                _insert_cursor(
                    fresh_media_id,
                    {"kind": "web", "locations": {"total_progression": 0.75}},
                )
                _insert_cursor(
                    covered_media_id,
                    {"kind": "web", "locations": {"total_progression": 0.5}},
                )

                session.execute(
                    text(
                        """
                        INSERT INTO reading_sessions (
                            id, user_id, media_id, device_id,
                            started_at, last_active_at, dwell_ms, max_progression, spans
                        )
                        VALUES (
                            :id, :user_id, :media_id, 'device-1',
                            now(), now(), 45000, 0.9, '[]'::jsonb
                        )
                        """
                    ),
                    {"id": existing_session_id, "user_id": user_id, "media_id": covered_media_id},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                fresh_sessions = session.execute(
                    text(
                        "SELECT device_id, dwell_ms, started_at, last_active_at, max_progression"
                        " FROM reading_sessions WHERE user_id = :u AND media_id = :m"
                    ),
                    {"u": user_id, "m": fresh_media_id},
                ).fetchall()
                covered_sessions = session.execute(
                    text(
                        "SELECT id, device_id FROM reading_sessions"
                        " WHERE user_id = :u AND media_id = :m"
                    ),
                    {"u": user_id, "m": covered_media_id},
                ).fetchall()

            assert len(fresh_sessions) == 1
            device_id, dwell_ms, started_at, last_active_at, max_progression = fresh_sessions[0]
            assert device_id == "__migrated__"
            assert dwell_ms == 0
            assert started_at == cursor_updated_at
            assert last_active_at == cursor_updated_at
            assert max_progression == pytest.approx(0.75)

            assert len(covered_sessions) == 1, "NOT EXISTS guard must not add a second session"
            assert covered_sessions[0][0] == existing_session_id
            assert covered_sessions[0][1] == "device-1"
        finally:
            reset_test_schema()
            engine.dispose()

    def test_backfill_pdf_locator_without_locations_key_yields_null_max_progression(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0178")
            assert result.returncode == 0, f"upgrade 0178 failed: {result.stderr}"

            user_id = uuid4()
            pdf_media_id = uuid4()
            cursor_updated_at = datetime(2026, 7, 1, 12, 0, 0, tzinfo=UTC)

            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status)"
                        " VALUES (:id, 'pdf', 'M', 'ready_for_reading')"
                    ),
                    {"id": pdf_media_id},
                )
                session.execute(
                    text(
                        """
                        INSERT INTO reader_media_state (id, user_id, media_id, locator, updated_at)
                        VALUES (:id, :user_id, :media_id, CAST(:locator AS jsonb), :updated_at)
                        """
                    ),
                    {
                        "id": uuid4(),
                        "user_id": user_id,
                        "media_id": pdf_media_id,
                        "locator": json.dumps({"kind": "pdf", "page": 3, "zoom": 1.0}),
                        "updated_at": cursor_updated_at,
                    },
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                pdf_sessions = session.execute(
                    text(
                        "SELECT device_id, dwell_ms, max_progression"
                        " FROM reading_sessions WHERE user_id = :u AND media_id = :m"
                    ),
                    {"u": user_id, "m": pdf_media_id},
                ).fetchall()

            assert len(pdf_sessions) == 1
            pdf_device_id, pdf_dwell_ms, pdf_max_progression = pdf_sessions[0]
            assert pdf_device_id == "__migrated__"
            assert pdf_dwell_ms == 0
            assert pdf_max_progression is None
        finally:
            reset_test_schema()
            engine.dispose()


class TestMigration0181LecternPlayerLifecycle:
    """0181 adds media_teardown_intents, podcast_subscriptions.
    auto_queue_watermark_at, media_source_attempts.signed_upload_expires_at
    (with a conservative pending-upload backfill), and podcast_listening_states.
    {write_revision,reset_epoch}; drops the dead consumption_queue_items /
    consumption_overrides source/status CHECKs; and recreates the four in-scope
    tables' user/media FKs under stable non-cascading names."""

    @pytest.fixture(scope="class")
    def head_engine(self):
        reset_test_schema()
        result = run_alembic_command("upgrade head")
        if result.returncode != 0:
            pytest.fail(f"Migration upgrade failed: {result.stderr}")
        engine = create_engine(get_test_database_url())
        yield engine
        engine.dispose()
        reset_test_schema()

    def test_media_teardown_intents_table_shape(self, head_engine):
        with Session(head_engine) as session:
            columns = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        """
                        SELECT column_name, is_nullable
                        FROM information_schema.columns
                        WHERE table_name = 'media_teardown_intents'
                        """
                    )
                ).fetchall()
            }
            constraint_types = {
                row[0]: row[1]
                for row in session.execute(
                    text(
                        "SELECT conname, contype FROM pg_constraint"
                        " WHERE conrelid = 'media_teardown_intents'::regclass"
                    )
                ).fetchall()
            }
            fk_delete_rule = session.execute(
                text(
                    "SELECT confdeltype FROM pg_constraint"
                    " WHERE conrelid = 'media_teardown_intents'::regclass"
                    "   AND conname = 'fk_media_teardown_intents_media'"
                )
            ).scalar_one()
            id_default = session.execute(
                text(
                    "SELECT column_default FROM information_schema.columns"
                    " WHERE table_name = 'media_teardown_intents' AND column_name = 'id'"
                )
            ).scalar_one_or_none()

        assert set(columns) == {"id", "media_id", "created_at"}, columns
        assert columns["media_id"] == "NO", "media_id must be NOT NULL"
        assert columns["created_at"] == "NO", "created_at must be NOT NULL"
        assert constraint_types.get("uq_media_teardown_intents_media") == "u", constraint_types
        assert constraint_types.get("fk_media_teardown_intents_media") == "f", constraint_types
        assert fk_delete_rule == "a", (
            "media FK must be NO ACTION: teardown deletes child rows through its own owners"
        )
        assert id_default is None, (
            "id must be application-generated (UUIDv7), not a database default"
        )

    def test_media_teardown_intents_enforces_one_intent_per_media(self, head_engine):
        media_id = uuid4()
        with Session(head_engine) as session:
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status)"
                    " VALUES (:id, 'web_article', 'M', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            session.execute(
                text("INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"),
                {"id": uuid4(), "media_id": media_id},
            )
            session.commit()

            with pytest.raises(IntegrityError):
                session.execute(
                    text(
                        "INSERT INTO media_teardown_intents (id, media_id) VALUES (:id, :media_id)"
                    ),
                    {"id": uuid4(), "media_id": media_id},
                )
            session.rollback()

            session.execute(
                text("DELETE FROM media_teardown_intents WHERE media_id = :id"), {"id": media_id}
            )
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.commit()

    def test_auto_queue_watermark_and_signed_upload_expiry_columns_are_nullable(self, head_engine):
        with Session(head_engine) as session:
            rows = {
                (row[0], row[1]): row[2]
                for row in session.execute(
                    text(
                        """
                        SELECT table_name, column_name, is_nullable
                        FROM information_schema.columns
                        WHERE (table_name = 'podcast_subscriptions'
                                AND column_name = 'auto_queue_watermark_at')
                           OR (table_name = 'media_source_attempts'
                                AND column_name = 'signed_upload_expires_at')
                        """
                    )
                ).fetchall()
            }
        assert rows[("podcast_subscriptions", "auto_queue_watermark_at")] == "YES", rows
        assert rows[("media_source_attempts", "signed_upload_expires_at")] == "YES", rows

    def test_write_revision_and_reset_epoch_default_to_zero(self, head_engine):
        with Session(head_engine) as session:
            columns = {
                row[0]: row
                for row in session.execute(
                    text(
                        """
                        SELECT column_name, is_nullable, column_default
                        FROM information_schema.columns
                        WHERE table_name = 'podcast_listening_states'
                          AND column_name IN ('write_revision', 'reset_epoch')
                        """
                    )
                ).fetchall()
            }
        assert columns["write_revision"][1] == "NO", columns["write_revision"]
        assert columns["reset_epoch"][1] == "NO", columns["reset_epoch"]
        assert columns["write_revision"][2] is not None and "0" in columns["write_revision"][2]
        assert columns["reset_epoch"][2] is not None and "0" in columns["reset_epoch"][2]

        # A live insert proves the default is real, not just reported metadata.
        user_id = uuid4()
        media_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status)"
                    " VALUES (:id, 'podcast_episode', 'M', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            session.execute(
                text("INSERT INTO podcast_listening_states (user_id, media_id) VALUES (:u, :m)"),
                {"u": user_id, "m": media_id},
            )
            session.commit()

            write_revision, reset_epoch = session.execute(
                text(
                    "SELECT write_revision, reset_epoch FROM podcast_listening_states"
                    " WHERE user_id = :u AND media_id = :m"
                ),
                {"u": user_id, "m": media_id},
            ).one()
            assert write_revision == 0
            assert reset_epoch == 0

            session.execute(
                text("DELETE FROM podcast_listening_states WHERE user_id = :u AND media_id = :m"),
                {"u": user_id, "m": media_id},
            )
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_dropped_checks_are_gone_and_arbitrary_source_status_now_succeed(self, head_engine):
        with Session(head_engine) as session:
            constraint_names = {
                row[0]
                for row in session.execute(
                    text(
                        "SELECT conname FROM pg_constraint"
                        " WHERE conrelid IN ("
                        "   'consumption_queue_items'::regclass,"
                        "   'consumption_overrides'::regclass"
                        " )"
                    )
                ).fetchall()
            }
        assert "ck_consumption_queue_items_source" not in constraint_names
        assert "ck_consumption_overrides_status" not in constraint_names

        user_id = uuid4()
        media_id = uuid4()
        with Session(head_engine) as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status)"
                    " VALUES (:id, 'web_article', 'M', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            # An arbitrary, never-enumerated source/status value now succeeds —
            # the vocabulary is owned by persistence adapters, not a CHECK.
            session.execute(
                text(
                    "INSERT INTO consumption_queue_items (user_id, media_id, position, source)"
                    " VALUES (:u, :m, 0, 'anything')"
                ),
                {"u": user_id, "m": media_id},
            )
            session.execute(
                text(
                    "INSERT INTO consumption_overrides (user_id, media_id, status)"
                    " VALUES (:u, :m, 'anything')"
                ),
                {"u": user_id, "m": media_id},
            )
            session.commit()

            session.execute(
                text("DELETE FROM consumption_queue_items WHERE user_id = :u AND media_id = :m"),
                {"u": user_id, "m": media_id},
            )
            session.execute(
                text("DELETE FROM consumption_overrides WHERE user_id = :u AND media_id = :m"),
                {"u": user_id, "m": media_id},
            )
            session.execute(text("DELETE FROM media WHERE id = :id"), {"id": media_id})
            session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            session.commit()

    def test_four_owner_tables_user_and_media_fks_are_named_and_non_cascading(self, head_engine):
        with Session(head_engine) as session:
            rows = session.execute(
                text(
                    """
                    SELECT tc.table_name, tc.constraint_name, rc.delete_rule
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.referential_constraints rc
                      ON rc.constraint_name = tc.constraint_name
                     AND rc.constraint_schema = tc.constraint_schema
                    WHERE tc.table_name IN (
                        'consumption_queue_items', 'consumption_overrides',
                        'podcast_listening_states', 'reading_sessions'
                    )
                    AND tc.constraint_type = 'FOREIGN KEY'
                    """
                )
            ).fetchall()

        by_table: dict[str, dict[str, str]] = {}
        for table_name, constraint_name, delete_rule in rows:
            by_table.setdefault(table_name, {})[constraint_name] = delete_rule

        for table in (
            "consumption_queue_items",
            "consumption_overrides",
            "podcast_listening_states",
            "reading_sessions",
        ):
            fks = by_table[table]
            assert set(fks) == {f"fk_{table}_user", f"fk_{table}_media"}, (table, fks)
            assert fks[f"fk_{table}_user"] == "NO ACTION", (
                f"{table} user FK must be NO ACTION: there is no product user-delete flow yet"
            )
            assert fks[f"fk_{table}_media"] == "NO ACTION", (
                f"{table} media FK must be NO ACTION: media deletion removes child rows itself"
            )

    def test_preflight_aborts_on_auto_playlist_provenance(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0180")
            assert result.returncode == 0, f"upgrade 0180 failed: {result.stderr}"

            user_id = uuid4()
            media_id = uuid4()
            with Session(engine) as session:
                session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
                session.execute(
                    text(
                        "INSERT INTO media (id, kind, title, processing_status)"
                        " VALUES (:id, 'podcast_episode', 'M', 'ready_for_reading')"
                    ),
                    {"id": media_id},
                )
                session.execute(
                    text(
                        "INSERT INTO consumption_queue_items (user_id, media_id, position, source)"
                        " VALUES (:u, :m, 0, 'auto_playlist')"
                    ),
                    {"u": user_id, "m": media_id},
                )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode != 0, "upgrade must abort on undisposed auto_playlist rows"
            assert "auto_playlist" in result.stderr
        finally:
            reset_test_schema()
            engine.dispose()

    def test_signed_upload_expiry_backfills_pending_upload_attempts_only(self):
        reset_test_schema()
        engine = create_engine(get_test_database_url())
        try:
            result = run_alembic_command("upgrade 0180")
            assert result.returncode == 0, f"upgrade 0180 failed: {result.stderr}"

            media_ids = {
                name: uuid4()
                for name in (
                    "pending_upload",
                    "queued_upload",
                    "succeeded_upload",
                    "other_source_type",
                )
            }
            with Session(engine) as session:
                for media_id in media_ids.values():
                    session.execute(
                        text(
                            "INSERT INTO media (id, kind, title, processing_status)"
                            " VALUES (:id, 'pdf', 'M', 'ready_for_reading')"
                        ),
                        {"id": media_id},
                    )
                attempt_specs = [
                    ("pending_upload", "uploaded_pdf_file", "accepted"),
                    ("queued_upload", "uploaded_epub_file", "queued"),
                    ("succeeded_upload", "uploaded_pdf_file", "succeeded"),
                    ("other_source_type", "generic_web_url", "accepted"),
                ]
                for name, source_type, status in attempt_specs:
                    session.execute(
                        text(
                            """
                            INSERT INTO media_source_attempts (
                                id, media_id, source_type, attempt_no, status,
                                intent_key, source_payload
                            )
                            VALUES (
                                :id, :media_id, :source_type, 1, :status,
                                :intent_key, '{}'::jsonb
                            )
                            """
                        ),
                        {
                            "id": uuid4(),
                            "media_id": media_ids[name],
                            "source_type": source_type,
                            "status": status,
                            "intent_key": f"test:{name}",
                        },
                    )
                session.commit()

            result = run_alembic_command("upgrade head")
            assert result.returncode == 0, f"upgrade head failed: {result.stderr}"

            with Session(engine) as session:
                expiry_by_name = {
                    name: session.execute(
                        text(
                            "SELECT signed_upload_expires_at FROM media_source_attempts"
                            " WHERE media_id = :m"
                        ),
                        {"m": media_id},
                    ).scalar_one()
                    for name, media_id in media_ids.items()
                }

            assert expiry_by_name["pending_upload"] is not None
            assert expiry_by_name["queued_upload"] is not None
            assert expiry_by_name["succeeded_upload"] is None, (
                "a succeeded attempt is not pending and must not be backfilled"
            )
            assert expiry_by_name["other_source_type"] is None, (
                "only uploaded_pdf_file/uploaded_epub_file are signed browser uploads"
            )
        finally:
            reset_test_schema()
            engine.dispose()
