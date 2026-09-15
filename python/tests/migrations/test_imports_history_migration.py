"""0227 proof: import history storage installs and baselines every extant import.

Risk: migration failure and schema/data incompatibility. The Imports workspace
reads `media_upload_events` / `media_processing_events` as the only record of
what happened to an import, so a missing table, a cascading foreign key, a
drifted ORM declaration, or a lost pre-cut resource is silent data loss.
The oracle is `docs/cutovers/imports-workspace-hard-cutover.md` and contract
D2/D5, never the migration's own output.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from nexus.db.models import Base
from nexus.schemas.import_history import (
    FullHistoryCoverage,
    MediaHistoryOwner,
    PartialHistoryCoverage,
    SourceFailed,
    SourceFailureProgress,
    SourceSucceeded,
    UploadFailed,
    UploadHistoryOwner,
)
from nexus.schemas.presence import absent, present
from nexus.schemas.upload_failures import UploadTransportHttpRejectedFailure
from nexus.services.import_history import (
    append_processing_event,
    append_upload_event,
    delete_processing_history_in_current_transaction,
    delete_upload_history_in_current_transaction,
    history_coverage,
    read_history_page,
)
from tests.testkit.unreachable_state import insert_processing_event, read_events

_HISTORY_TABLES = ("media_upload_events", "media_processing_events")


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _declared_columns(table_name: str) -> dict[str, tuple[str, bool]]:
    table = Base.metadata.tables[table_name]
    return {
        column.name: (column.type.compile(postgresql.dialect()), column.nullable)
        for column in table.columns
    }


def _reflected_columns(engine: Engine, table_name: str) -> dict[str, tuple[str, bool]]:
    return {
        column["name"]: (column["type"].compile(postgresql.dialect()), column["nullable"])
        for column in inspect(engine).get_columns(table_name)
    }


def _declared_indexes(table_name: str) -> dict[str, list[str]]:
    table = Base.metadata.tables[table_name]
    return {index.name: [column.name for column in index.columns] for index in table.indexes}


def _reflected_indexes(engine: Engine, table_name: str) -> dict[str, list[str]]:
    return {
        index["name"]: list(index["column_names"])
        for index in inspect(engine).get_indexes(table_name)
    }


def _foreign_key_delete_rules(engine: Engine) -> dict[str, str]:
    with engine.connect() as connection:
        return dict(
            connection.execute(
                text(
                    """
                    SELECT constraint_name, delete_rule
                    FROM information_schema.referential_constraints
                    WHERE constraint_schema = 'public'
                      AND constraint_name IN (
                          'fk_media_upload_events_session',
                          'fk_media_processing_events_media'
                      )
                    """
                )
            ).all()
        )


_UPLOAD_EVENTS_QUERY = """
    SELECT session_id AS owner_id, event_type, stage, failure_code, payload,
           occurred_at >= now() - interval '5 minutes' AS recorded_now
    FROM media_upload_events
    ORDER BY session_id
"""

_PROCESSING_EVENTS_QUERY = """
    SELECT media_id AS owner_id, event_type, stage, failure_code, payload,
           occurred_at >= now() - interval '5 minutes' AS recorded_now
    FROM media_processing_events
    ORDER BY payload->>'attempt_no'
"""


def _events(engine: Engine, query: str) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        return [dict(row._mapping) for row in connection.execute(text(query)).all()]


def _seed_supported_snapshot(engine: Engine) -> dict[str, UUID]:
    """One user, one media with a failed and a succeeded attempt, two sessions."""
    now = datetime.now(UTC)
    identities = {
        "user_id": uuid4(),
        "media_id": uuid4(),
        "failed_attempt_id": uuid4(),
        "succeeded_attempt_id": uuid4(),
        "open_session_id": uuid4(),
        "published_session_id": uuid4(),
    }
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO users (id, email) VALUES (:id, :email)"),
            {
                "id": identities["user_id"],
                "email": f"imports-history-{identities['user_id']}@example.invalid",
            },
        )
        connection.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'pdf', 'Pre-cut import', 'ready_for_reading', :user_id)
                """
            ),
            {"id": identities["media_id"], "user_id": identities["user_id"]},
        )
        connection.execute(
            text(
                """
                INSERT INTO media_source_attempts (
                    id, media_id, created_by_user_id, source_type, attempt_no, status,
                    intent_key, error_code, finished_at
                ) VALUES (
                    :id, :media_id, :user_id, 'uploaded_pdf_file', :attempt_no, :status,
                    :intent_key, :error_code, now()
                )
                """
            ),
            [
                {
                    "id": identities["failed_attempt_id"],
                    "media_id": identities["media_id"],
                    "user_id": identities["user_id"],
                    "attempt_no": 1,
                    "status": "failed",
                    "intent_key": "imports-history-attempt-1",
                    "error_code": "E_SOURCE_INTEGRITY",
                },
                {
                    "id": identities["succeeded_attempt_id"],
                    "media_id": identities["media_id"],
                    "user_id": identities["user_id"],
                    "attempt_no": 2,
                    "status": "succeeded",
                    "intent_key": "imports-history-attempt-2",
                    "error_code": None,
                },
            ],
        )
        connection.execute(
            text(
                """
                INSERT INTO media_upload_sessions (
                    id, created_by_user_id, candidate_media_id, kind, filename, content_type,
                    expected_size_bytes, idempotency_key, request_id, upload_generation,
                    upload_url_expires_at, transport_failure_kind, transport_http_status,
                    transport_failed_at, published_media_id, published_source_attempt_id,
                    published_at
                ) VALUES (
                    :id, :user_id, :candidate_media_id, 'pdf', :filename, 'application/pdf',
                    1024, :idempotency_key, :request_id, :upload_generation,
                    now() + interval '1 hour', :transport_failure_kind, :transport_http_status,
                    :transport_failed_at, :published_media_id, :published_source_attempt_id,
                    :published_at
                )
                """
            ),
            [
                {
                    "id": identities["open_session_id"],
                    "user_id": identities["user_id"],
                    "candidate_media_id": uuid4(),
                    "filename": "stalled.pdf",
                    "idempotency_key": "imports-history-open",
                    "request_id": "imports-history-open",
                    "upload_generation": 3,
                    "transport_failure_kind": "HttpRejected",
                    "transport_http_status": 503,
                    "transport_failed_at": now,
                    "published_media_id": None,
                    "published_source_attempt_id": None,
                    "published_at": None,
                },
                {
                    "id": identities["published_session_id"],
                    "user_id": identities["user_id"],
                    "candidate_media_id": identities["media_id"],
                    "filename": "published.pdf",
                    "idempotency_key": "imports-history-published",
                    "request_id": "imports-history-published",
                    "upload_generation": 1,
                    "transport_failure_kind": None,
                    "transport_http_status": None,
                    "transport_failed_at": None,
                    "published_media_id": identities["media_id"],
                    "published_source_attempt_id": identities["succeeded_attempt_id"],
                    "published_at": now,
                },
            ],
        )
    return identities


def test_0227_installs_history_storage_agreeing_with_the_orm_declaration(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()

    command.upgrade(config, "0227")

    engine = create_engine(empty_migration_database_url)
    try:
        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
        reflected = {name: _reflected_columns(engine, name) for name in _HISTORY_TABLES}
        declared = {name: _declared_columns(name) for name in _HISTORY_TABLES}
        reflected_indexes = {name: _reflected_indexes(engine, name) for name in _HISTORY_TABLES}
        declared_indexes = {name: _declared_indexes(name) for name in _HISTORY_TABLES}
        delete_rules = _foreign_key_delete_rules(engine)
        execution_id = _reflected_columns(engine, "background_jobs")["execution_id"]
    finally:
        engine.dispose()

    assert actual_head == "0227", f"0227 did not become the applied head: {actual_head!r}"
    for name in _HISTORY_TABLES:
        assert reflected[name] == declared[name], (
            f"{name} storage shape disagrees with nexus.db.models: "
            f"database={reflected[name]!r} models={declared[name]!r}"
        )
        assert reflected_indexes[name] == declared_indexes[name], (
            f"{name} indexes disagree with nexus.db.models: "
            f"database={reflected_indexes[name]!r} models={declared_indexes[name]!r}"
        )
    assert delete_rules == {
        "fk_media_upload_events_session": "NO ACTION",
        "fk_media_processing_events_media": "NO ACTION",
    }, f"history foreign keys must never cascade: {delete_rules!r}"
    assert execution_id == ("UUID", True), (
        f"background_jobs.execution_id must be a nullable uuid: {execution_id!r}"
    )


def test_0227_records_one_baseline_per_extant_upload_session_and_source_attempt(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0226")
    engine = create_engine(empty_migration_database_url)
    try:
        identities = _seed_supported_snapshot(engine)

        command.upgrade(config, "0227")

        upload_events = _events(engine, _UPLOAD_EVENTS_QUERY)
        processing_events = _events(engine, _PROCESSING_EVENTS_QUERY)
        with engine.connect() as connection:
            retained_attempts = set(
                connection.scalars(text("SELECT id FROM media_source_attempts"))
            )
            retained_sessions = set(
                connection.scalars(text("SELECT id FROM media_upload_sessions"))
            )
    finally:
        engine.dispose()

    assert retained_attempts == {
        identities["failed_attempt_id"],
        identities["succeeded_attempt_id"],
    }, f"0227 lost pre-cut source attempts: {retained_attempts!r}"
    assert retained_sessions == {
        identities["open_session_id"],
        identities["published_session_id"],
    }, f"0227 lost pre-cut upload sessions: {retained_sessions!r}"

    assert [event["event_type"] for event in upload_events] == [
        "HistoryBaseline",
        "HistoryBaseline",
    ], f"0227 must record exactly one upload baseline per session: {upload_events!r}"
    assert {event["owner_id"]: event["payload"] for event in upload_events} == {
        identities["open_session_id"]: {"generation": 3},
        identities["published_session_id"]: {"generation": 1},
    }, f"upload baselines must carry only the extant generation: {upload_events!r}"

    assert [event["event_type"] for event in processing_events] == [
        "HistoryBaseline",
        "HistoryBaseline",
    ], f"0227 must record exactly one processing baseline per attempt: {processing_events!r}"
    assert [event["payload"] for event in processing_events] == [
        {
            "source_attempt_id": str(identities["failed_attempt_id"]),
            "attempt_no": 1,
            "outcome": {"kind": "Failed", "failure_code": "E_SOURCE_INTEGRITY"},
        },
        {
            "source_attempt_id": str(identities["succeeded_attempt_id"]),
            "attempt_no": 2,
            "outcome": {"kind": "Succeeded"},
        },
    ], f"attempt baselines must carry the extant attempt outcome: {processing_events!r}"

    for event in [*upload_events, *processing_events]:
        assert event["stage"] is None and event["failure_code"] is None, (
            f"a baseline names no stage and no failure: {event!r}"
        )
        assert event["recorded_now"], (
            f"baseline time is recording time, never an invented failure time: {event!r}"
        )


def test_0227_preflight_rejects_an_uncatalogued_attempt_error_code(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0226")
    engine = create_engine(empty_migration_database_url)
    try:
        identities = _seed_supported_snapshot(engine)
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE media_source_attempts SET error_code = :code WHERE id = :id"),
                {"code": "E_NOT_A_CATALOGUED_CODE", "id": identities["failed_attempt_id"]},
            )

        with pytest.raises(RuntimeError) as rejection:
            command.upgrade(config, "0227")

        with engine.connect() as connection:
            actual_head = connection.scalar(text("SELECT version_num FROM alembic_version"))
            history_tables = set(inspect(engine).get_table_names()) & set(_HISTORY_TABLES)
    finally:
        engine.dispose()

    assert "E_NOT_A_CATALOGUED_CODE" in str(rejection.value), (
        f"the preflight must name the offending code: {rejection.value}"
    )
    assert actual_head == "0226", (
        f"a rejected preflight leaves the schema at 0226: head={actual_head!r}"
    )
    assert not history_tables, (
        f"a rejected preflight runs before any DDL: {sorted(history_tables)!r}"
    )


def test_0227_downgrade_is_unsupported() -> None:
    config = _migration_config()

    module = ScriptDirectory.from_config(config).get_revision("0227").module

    with pytest.raises(NotImplementedError):
        module.downgrade()


def test_history_recorded_after_the_cut_reads_back_over_the_baseline_and_dies_with_its_owner(
    empty_migration_database_url: str,
) -> None:
    config = _migration_config()
    command.upgrade(config, "0226")
    engine = create_engine(empty_migration_database_url)
    try:
        identities = _seed_supported_snapshot(engine)
        command.upgrade(config, "0227")
        owner = UploadHistoryOwner(
            session_id=identities["published_session_id"],
            media_id=present(identities["media_id"]),
        )
        historical_facts = SourceFailed(
            source_attempt_id=identities["failed_attempt_id"],
            execution_id=absent(),
            origin="Domain",
            terminal=True,
            progress=present(
                SourceFailureProgress(completed=4, total=present(11), unit=present("page"))
            ),
        )
        upload_facts = UploadFailed(
            generation=1, transport=present(UploadTransportHttpRejectedFailure(status=503))
        )
        source_facts = SourceSucceeded(
            source_attempt_id=identities["succeeded_attempt_id"], execution_id=absent()
        )

        with Session(engine) as db:
            insert_processing_event(
                db,
                media_id=identities["media_id"],
                facts=historical_facts,
                stage=present("Extract"),
                failure_code=present("E_SOURCE_INTEGRITY"),
                occurred_at=datetime(2026, 1, 2, tzinfo=UTC),
            )
            append_upload_event(
                db,
                session_id=identities["published_session_id"],
                facts=upload_facts,
                stage=present("Upload"),
                failure_code=present("E_UPLOAD_TRANSPORT_FAILED"),
            )
            append_processing_event(
                db,
                media_id=identities["media_id"],
                facts=source_facts,
                stage=absent(),
                failure_code=absent(),
            )
            db.commit()

            newest = read_history_page(db, owner=owner, before=absent(), limit=2)
            older = read_history_page(
                db,
                owner=owner,
                before=present((newest[-1].occurred_at, newest[-1].id)),
                limit=10,
            )
            media_only = read_history_page(
                db,
                owner=MediaHistoryOwner(media_id=identities["media_id"]),
                before=absent(),
                limit=10,
            )
            partial = history_coverage(db, owner=owner)

            delete_upload_history_in_current_transaction(
                db, session_id=identities["published_session_id"]
            )
            delete_processing_history_in_current_transaction(db, media_id=identities["media_id"])
            db.commit()
            remaining = read_events(db, owner=owner)
            full = history_coverage(db, owner=owner)
            surviving_open_session = read_events(
                db,
                owner=UploadHistoryOwner(
                    session_id=identities["open_session_id"], media_id=absent()
                ),
            )
    finally:
        engine.dispose()

    assert [entry.facts for entry in newest] == [source_facts, upload_facts], (
        f"the newest page must hold the two events just recorded, newest first: {newest!r}"
    )
    assert newest[1].stage == present("Upload") and newest[1].failure_code == present(
        "E_UPLOAD_TRANSPORT_FAILED"
    ), f"the envelope columns must survive the round trip: {newest[1]!r}"
    assert sorted(type(entry.facts).__name__ for entry in older) == [
        "SourceFailed",
        "SourceHistoryBaseline",
        "SourceHistoryBaseline",
        "UploadHistoryBaseline",
    ], (
        "continuation must return this import's three baselines and the older recorded "
        f"failure, and no other session's baseline: {older!r}"
    )
    assert type(older[-1].facts).__name__ == "SourceFailed", (
        "the three baselines share one recording time, so only the older recorded "
        f"failure has an ordered position: {older!r}"
    )
    assert older[-1].facts == historical_facts, (
        f"a recorded failure must decode back to exactly its stored variant: {older[-1]!r}"
    )
    assert {entry.id for entry in newest}.isdisjoint({entry.id for entry in older}), (
        f"keyset continuation must not repeat an entry: {newest!r} {older!r}"
    )
    assert [type(entry.facts).__name__ for entry in media_only] == [
        "SourceSucceeded",
        "SourceHistoryBaseline",
        "SourceHistoryBaseline",
        "SourceFailed",
    ], f"a media owner reads its processing history and no upload session's: {media_only!r}"
    assert partial == PartialHistoryCoverage(
        recorded_since=min(entry.occurred_at for entry in older[:3])
    ), f"a baselined import reports partial coverage from its earliest baseline: {partial!r}"
    assert remaining == [], f"teardown must leave no history for its owner: {remaining!r}"
    assert full == FullHistoryCoverage(), (
        f"an import with no baseline row reports full coverage: {full!r}"
    )
    assert len(surviving_open_session) == 1, (
        f"teardown must delete only the named owner's history: {surviving_open_session!r}"
    )
