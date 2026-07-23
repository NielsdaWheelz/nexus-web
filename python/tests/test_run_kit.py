"""run_kit.mark_terminal: error-floor stamping per run-parent kind."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    ArtifactBuild,
    ArtifactBuildFailure,
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


def _active_artifact_build(db) -> ArtifactBuild:
    user_id = _insert_user(db)
    library_id = create_test_library(db, user_id)
    artifact = SynthesisArtifact(
        id=uuid4(),
        subject_scheme="library",
        subject_id=library_id,
        audience_scheme="library",
        audience_id=str(library_id),
    )
    db.add(artifact)
    db.flush()
    build = ArtifactBuild(
        id=uuid4(),
        artifact_id=artifact.id,
        requester_user_id=user_id,
        idempotency_key=f"run-kit-{uuid4()}",
    )
    db.add(build)
    db.flush()
    return build


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


def test_artifact_build_stream_replays_events_and_derives_terminal_child(db_session):
    build = _active_artifact_build(db_session)
    seq = run_kit.append_event(
        db_session,
        stream=run_kit.artifact_build_stream(build),
        event_type="Progress",
        payload={"phase": "Collecting", "message": "Collecting evidence"},
    )

    events, terminal = run_kit.get_run_events(
        db_session, run_kit.RunStreamKind.ArtifactBuild, build.id, after=0
    )
    assert seq == 1
    assert [event.event_type for event in events] == ["Progress"]
    assert terminal is False

    db_session.add(
        ArtifactBuildFailure(
            build_id=build.id,
            failure_code="ProviderIncomplete",
            detail="provider stopped",
        )
    )
    db_session.flush()
    assert run_kit.is_run_terminal(db_session, run_kit.RunStreamKind.ArtifactBuild, build.id)


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
