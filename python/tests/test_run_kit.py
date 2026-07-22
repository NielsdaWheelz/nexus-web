"""run_kit.mark_terminal: error-floor stamping per run-parent kind."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    ArtifactRevision,
    ChatRun,
    OracleReading,
    SynthesisArtifact,
)
from nexus.services import run_kit
from tests.factories import (
    create_test_conversation_with_message,
    create_test_library,
    create_test_message,
)

pytestmark = pytest.mark.integration


def _insert_user(db) -> UUID:
    user_id = uuid4()
    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.flush()
    return user_id


def _running_chat_run(db) -> ChatRun:
    user_id = _insert_user(db)
    conversation_id, user_message_id = create_test_conversation_with_message(db, user_id)
    assistant_message_id = create_test_message(
        db, conversation_id, seq=2, role="assistant", content="", status="pending"
    )
    run = ChatRun(
        id=uuid4(),
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=f"run-kit-{uuid4()}",
        payload_hash="hash",
        status="running",
        profile_id="balanced",
        reasoning_option_id="medium",
    )
    db.add(run)
    db.flush()
    return run


def _streaming_reading(db) -> OracleReading:
    reading = OracleReading(
        id=uuid4(),
        user_id=_insert_user(db),
        folio_number=1,
        question_text="What breaks?",
        status="streaming",
    )
    db.add(reading)
    db.flush()
    return reading


def _building_revision(db) -> ArtifactRevision:
    user_id = _insert_user(db)
    library_id = create_test_library(db, user_id)
    artifact = SynthesisArtifact(
        id=uuid4(),
        subject_scheme="library",
        subject_id=library_id,
        kind="library_dossier",
        user_id=user_id,
    )
    db.add(artifact)
    db.flush()
    revision = ArtifactRevision(
        id=uuid4(), artifact_id=artifact.id, covered_targets=[], status="building"
    )
    db.add(revision)
    db.flush()
    return revision


def _event_types(db, table: str, fk: str, parent_id) -> list[str]:
    return list(
        db.execute(
            text(f"SELECT event_type FROM {table} WHERE {fk} = :id ORDER BY seq"),
            {"id": parent_id},
        ).scalars()
    )


def test_mark_terminal_stamps_error_pair_on_chat_run(db_session):
    run = _running_chat_run(db_session)

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.chat_run_stream(run),
        status="error",
        done_payload={"status": "error", "error_code": "E_INTERNAL"},
        error_code="E_INTERNAL",
        error_detail="RuntimeError: boom",
    )

    assert (run.status, run.error_code, run.error_detail) == (
        "error",
        "E_INTERNAL",
        "RuntimeError: boom",
    )
    assert run.completed_at is not None
    assert _event_types(db_session, "chat_run_events", "run_id", run.id) == ["done"]


def test_mark_terminal_without_error_args_leaves_columns_untouched(db_session):
    """Existing callers pass neither argument and keep their behavior."""
    run = _running_chat_run(db_session)
    run.error_code = "E_PREEXISTING"
    db_session.flush()

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.chat_run_stream(run),
        status="complete",
        done_payload={"status": "complete"},
    )

    assert run.status == "complete"
    assert run.error_code == "E_PREEXISTING", "omitted error_code must not clobber the column"
    assert run.error_detail is None


def test_mark_terminal_failed_oracle_reading_sets_failed_at_and_satisfies_check(db_session):
    reading = _streaming_reading(db_session)

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.oracle_reading_stream(reading),
        status="failed",
        done_payload={"status": "failed", "error_code": "E_INTERNAL"},
        error_code="E_INTERNAL",
        error_detail="ValueError: bad plate",
    )
    # The ck_oracle_readings_failed_has_error CHECK is enforced at this flush.
    db_session.flush()

    assert reading.status == "failed"
    assert reading.failed_at is not None, "failed oracle readings must get failed_at stamped"
    assert (reading.error_code, reading.error_detail) == ("E_INTERNAL", "ValueError: bad plate")
    assert _event_types(db_session, "oracle_reading_events", "reading_id", reading.id) == ["done"]


def test_mark_terminal_complete_oracle_reading_does_not_set_failed_at(db_session):
    reading = _streaming_reading(db_session)

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.oracle_reading_stream(reading),
        status="complete",
        done_payload={"status": "complete"},
    )

    assert reading.status == "complete"
    assert reading.failed_at is None


def test_mark_terminal_stamps_error_pair_on_li_revision(db_session):
    revision = _building_revision(db_session)

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.artifact_revision_stream(revision),
        status="failed",
        done_payload={"error": "llm_failure"},
        error_code="timeout",
        error_detail="took too long",
    )

    assert (revision.status, revision.error_code, revision.error_detail) == (
        "failed",
        "timeout",
        "took too long",
    )
    assert revision.completed_at is not None


def test_mark_terminal_is_noop_on_already_terminal_parent(db_session):
    run = _running_chat_run(db_session)
    run.status = "complete"
    db_session.flush()

    run_kit.mark_terminal(
        db_session,
        stream=run_kit.chat_run_stream(run),
        status="error",
        done_payload={"status": "error"},
        error_code="E_INTERNAL",
        error_detail="late failure",
    )

    assert run.status == "complete"
    assert run.error_code is None and run.error_detail is None
    assert _event_types(db_session, "chat_run_events", "run_id", run.id) == []


# ---------------------------------------------------------------------------
# fail_run_after_worker_exception
# ---------------------------------------------------------------------------


def _li_write_failure(db, revision) -> None:
    run_kit.mark_terminal(
        db,
        stream=run_kit.artifact_revision_stream(revision),
        status="failed",
        done_payload={"error": "E_INTERNAL"},
        error_code="E_INTERNAL",
        error_detail="RuntimeError: boom",
    )


def _li_load(revision_id):
    return lambda db: db.get(ArtifactRevision, revision_id)


def _li_is_terminal(revision) -> bool:
    return revision.status in ("ready", "failed")


def test_fail_run_after_worker_exception_writes_failure_on_nonterminal_parent(db_session):
    revision = _building_revision(db_session)
    revision_id = revision.id
    db_session.commit()
    # Dirty, uncommitted state stands in for the broken worker transaction; the
    # helper must roll it back before writing the failure.
    revision.content_md = "junk from the broken attempt"

    parent, failed_now = run_kit.fail_run_after_worker_exception(
        db_session,
        load_parent=_li_load(revision_id),
        is_terminal=_li_is_terminal,
        write_failure=_li_write_failure,
    )

    assert failed_now is True
    assert parent is not None and parent.id == revision_id
    assert (parent.status, parent.error_code, parent.error_detail) == (
        "failed",
        "E_INTERNAL",
        "RuntimeError: boom",
    )
    assert parent.content_md == "", "the broken transaction's writes must be rolled back"
    assert _event_types(db_session, "artifact_revision_events", "revision_id", revision_id) == [
        "done"
    ]


def test_fail_run_after_worker_exception_noops_on_terminal_parent(db_session):
    revision = _building_revision(db_session)
    revision.status = "ready"
    revision_id = revision.id
    db_session.commit()

    parent, failed_now = run_kit.fail_run_after_worker_exception(
        db_session,
        load_parent=_li_load(revision_id),
        is_terminal=_li_is_terminal,
        write_failure=_li_write_failure,
    )

    assert failed_now is False
    assert parent is not None and parent.status == "ready"
    assert parent.error_code is None and parent.error_detail is None
    assert _event_types(db_session, "artifact_revision_events", "revision_id", revision_id) == []


def test_fail_run_after_worker_exception_noops_on_missing_parent(db_session):
    parent, failed_now = run_kit.fail_run_after_worker_exception(
        db_session,
        load_parent=_li_load(uuid4()),
        is_terminal=_li_is_terminal,
        write_failure=_li_write_failure,
    )

    assert (parent, failed_now) == (None, False)
