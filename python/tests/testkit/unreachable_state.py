"""Narrow raw-SQL owner for states production APIs cannot create on demand."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.schemas.presence import Presence, Present, present
from nexus.services.durable_step_journal import (
    Completed,
    ToolExecutionState,
    decode_step_states,
    payload_with_step_state,
)

_DOSSIER_WEB_STEP_PATHS = frozenset(
    {
        "research/web-search/0",
        "research/web-search/1",
        "research/web-search/2",
    }
)


def install_deferred_media_insert_failure(
    engine: Engine, *, media_id: UUID, discriminator: str
) -> tuple[str, str]:
    """Force one synthetic Media insert to fail only at the real commit boundary."""
    trigger_name = f"fail_upload_publication_{discriminator}"
    function_name = f"fail_upload_publication_{discriminator}"
    with engine.begin() as connection:
        connection.execute(
            text(
                f"""
                CREATE FUNCTION {function_name}() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.id = '{media_id}'::uuid THEN
                        RAISE EXCEPTION 'forced upload publication commit failure';
                    END IF;
                    RETURN NEW;
                END
                $$
                """
            )
        )
        connection.execute(
            text(
                f"""
                CREATE CONSTRAINT TRIGGER {trigger_name}
                AFTER INSERT ON media
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION {function_name}()
                """
            )
        )
    return trigger_name, function_name


def remove_deferred_media_insert_failure(
    engine: Engine, *, trigger_name: str, function_name: str
) -> None:
    with engine.begin() as connection:
        connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name} ON media"))
        connection.execute(text(f"DROP FUNCTION IF EXISTS {function_name}()"))


def cleanup_committed_upload_user(engine: Engine, *, user_id: UUID) -> None:
    """Remove every row committed by a dedicated upload-session proof user."""
    with engine.begin() as connection:
        upload_session_ids = (
            connection.execute(
                text(
                    "SELECT id::text FROM media_upload_sessions WHERE created_by_user_id = :user_id"
                ),
                {"user_id": user_id},
            )
            .scalars()
            .all()
        )
        connection.execute(
            text(
                """
                DELETE FROM media_upload_session_destinations
                WHERE upload_session_id IN (
                    SELECT id FROM media_upload_sessions
                    WHERE created_by_user_id = :user_id
                )
                """
            ),
            {"user_id": user_id},
        )
        connection.execute(
            text("DELETE FROM media_upload_sessions WHERE created_by_user_id = :user_id"),
            {"user_id": user_id},
        )
        connection.execute(
            text(
                """
                DELETE FROM library_entries
                WHERE media_id IN (SELECT id FROM media WHERE created_by_user_id = :user_id)
                """
            ),
            {"user_id": user_id},
        )
        connection.execute(
            text("DELETE FROM media_source_attempts WHERE created_by_user_id = :user_id"),
            {"user_id": user_id},
        )
        connection.execute(
            text(
                """
                DELETE FROM background_jobs
                WHERE payload->>'actor_user_id' = :user_id
                   OR payload->>'uploadSessionId' = ANY(:session_ids)
                """
            ),
            {"user_id": str(user_id), "session_ids": upload_session_ids},
        )
        connection.execute(
            text(
                """
                DELETE FROM reader_publications
                WHERE media_id IN (SELECT id FROM media WHERE created_by_user_id = :user_id)
                """
            ),
            {"user_id": user_id},
        )
        connection.execute(
            text(
                """
                DELETE FROM pdf_page_text_spans
                WHERE media_id IN (SELECT id FROM media WHERE created_by_user_id = :user_id)
                """
            ),
            {"user_id": user_id},
        )
        connection.execute(
            text("DELETE FROM media WHERE created_by_user_id = :user_id"),
            {"user_id": user_id},
        )
        connection.execute(
            text("DELETE FROM libraries WHERE owner_user_id = :user_id"),
            {"user_id": user_id},
        )
        connection.execute(
            text("DELETE FROM viewer_collection_revisions WHERE viewer_id = :user_id"),
            {"user_id": user_id},
        )
        connection.execute(text("DELETE FROM users WHERE id = :user_id"), {"user_id": user_id})


def prioritize_job_for_worker_proof(db: Session, *, job_id: UUID) -> None:
    """Make one known synthetic job precede unrelated rows in a shared test database."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET priority = 0
            WHERE id = :job_id
            RETURNING id
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    assert updated == job_id


def expire_job_claim(db: Session, *, job_id: UUID) -> None:
    """Model passage of a dead worker's lease without waiting in a proof."""
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET lease_expires_at = now() - interval '1 second'
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id},
    )


def miscorrelate_running_chat_job(
    db: Session,
    *,
    job_id: UUID,
    foreign_kind: str,
    foreign_run_id: UUID,
) -> None:
    """Point a claimed Chat job at another run without changing its lease identity."""

    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET kind = :foreign_kind,
                payload = jsonb_set(
                payload,
                '{run_id}',
                to_jsonb(CAST(:foreign_run_id AS text))
            )
            WHERE id = :job_id
              AND kind = 'chat_run'
              AND status = 'running'
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "foreign_kind": foreign_kind,
            "foreign_run_id": str(foreign_run_id),
        },
    ).scalar_one()
    assert updated == job_id


def expire_artifact_learn_resolver_lease(db: Session, *, request_id: UUID) -> None:
    """Model an abandoned request-scoped Idea resolver without waiting."""

    updated = db.execute(
        text(
            "UPDATE artifact_learn_requests "
            "SET resolver_lease_expires_at = now() - interval '1 second' "
            "WHERE id = :request_id "
            "RETURNING id"
        ),
        {"request_id": request_id},
    ).scalar_one()
    assert updated == request_id


def force_upload_cleanup_job_due(db: Session, *, job_id: UUID) -> None:
    """Advance one upload cleanup reservation past both durable deletion fences."""
    deadline = "1970-01-01T00:00:00+00:00"
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = now() - interval '1 second',
                payload = jsonb_set(
                    jsonb_set(
                        payload,
                        '{retainUntil}',
                        to_jsonb(CAST(:deadline AS text))
                    ),
                    '{writeMayLandUntil}',
                    to_jsonb(CAST(:deadline AS text))
                )
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id, "deadline": deadline},
    )
    db.commit()


def expire_upload_verification_lease(db: Session, *, session_id: UUID) -> UUID:
    """Lapse a live verification lease in place, keeping its token and generation.

    Production reaches this state by a verifier outliving its renewal period; the
    proof reaches it directly so the clock is not part of the assertion.
    """
    token = db.execute(
        text(
            """
            UPDATE media_upload_sessions
            SET verification_expires_at = now() - interval '1 second'
            WHERE id = :session_id
              AND verification_token IS NOT NULL
            RETURNING verification_token
            """
        ),
        {"session_id": session_id},
    ).scalar_one()
    db.commit()
    return UUID(str(token))


def make_upload_cleanup_job_available_before_its_fence(db: Session, *, job_id: UUID) -> None:
    """Expose one cleanup job while preserving its future durable writer fences."""
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = now() - interval '1 second'
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id},
    )
    db.commit()


def age_completed_job(engine: Engine, *, job_id: UUID, seconds: int) -> None:
    """Place one terminal job outside a freshness window for readiness proof."""
    if seconds < 1:
        raise ValueError("completed-job age must be positive")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE background_jobs
                SET finished_at = now() - (CAST(:seconds AS integer) * interval '1 second')
                WHERE id = :job_id
                  AND status = 'succeeded'
                """
            ),
            {"job_id": job_id, "seconds": seconds},
        )


def expire_heavy_job_claim(db: Session, *, job_id: UUID) -> None:
    """Model database-clock expiry of one exact Heavy worker and capacity lease."""
    expire_job_claim(db, job_id=job_id)
    updated = db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET lease_expires_at = now() - interval '1 second'
            WHERE resource_class = 'Heavy'
              AND job_id = :job_id
            RETURNING job_id
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    assert updated == job_id


def expire_claim_and_handoff_code(db: Session, *, job_id: UUID, user_id: UUID) -> None:
    """Model a worker crash after claim and an already-expired one-use auth code."""
    expire_job_claim(db, job_id=job_id)
    db.execute(
        text(
            """
            UPDATE auth_handoff_codes
            SET created_at = now() - interval '10 minutes',
                expires_at = now() - interval '5 minutes'
            WHERE user_id = :user_id
            """
        ),
        {"user_id": user_id},
    )


def clear_heavy_capacity_holder(db: Session, *, job_id: UUID) -> None:
    """Create the impossible state of a running Heavy job without capacity."""
    updated = db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET job_id = NULL,
                worker_id = NULL,
                attempt_no = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE resource_class = 'Heavy'
              AND job_id = :job_id
            RETURNING resource_class
            """
        ),
        {"job_id": job_id},
    ).first()
    if updated is None:
        raise AssertionError("expected exact Heavy capacity holder")


def assign_dead_job_to_heavy_capacity(db: Session, *, job_id: UUID) -> None:
    """Create the impossible state of a dead job retaining Heavy capacity."""
    updated = db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET job_id = :job_id,
                worker_id = 'unreachable-dead-holder',
                attempt_no = 1,
                lease_expires_at = now() + interval '5 minutes',
                updated_at = clock_timestamp()
            WHERE resource_class = 'Heavy'
              AND job_id IS NULL
            RETURNING resource_class
            """
        ),
        {"job_id": job_id},
    ).first()
    if updated is None:
        raise AssertionError("expected unheld Heavy capacity")


def make_failed_job_retryable(db: Session, *, job_id: UUID) -> None:
    """Advance only a known failed synthetic job past its production backoff."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = now(), updated_at = now()
            WHERE id = :job_id
              AND status = 'failed'
              AND claimed_by IS NULL
            RETURNING kind
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": updated})


def set_pending_job_max_attempts(
    db: Session,
    *,
    job_id: UUID,
    max_attempts: int,
) -> None:
    """Give one pending synthetic job the exact retry budget required by a replay proof."""

    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET max_attempts = :max_attempts
            WHERE id = :job_id
              AND status = 'pending'
            RETURNING id
            """
        ),
        {"job_id": job_id, "max_attempts": max_attempts},
    ).scalar_one()
    assert updated == job_id


def replace_dead_dossier_step_tool_execution(
    db: Session,
    *,
    job_id: UUID,
    step_path: str,
    tool_execution: Presence[ToolExecutionState],
) -> Presence[ToolExecutionState]:
    """Replace one known dead Dossier Web position's stored binding metadata."""

    if step_path not in _DOSSIER_WEB_STEP_PATHS:
        raise AssertionError(f"not a Dossier Web position: {step_path!r}")
    row = (
        db.execute(
            text("SELECT kind, status, payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    if row["kind"] != "dossier_build" or row["status"] != "dead":
        raise AssertionError("tool metadata mutation requires one dead Dossier job")
    payload = dict(row["payload"])
    states = decode_step_states(payload)
    state = states.get(step_path)
    if state is None:
        raise AssertionError(f"dead Dossier job lacks step {step_path!r}")
    previous = state.tool_execution
    changed = state.model_copy(update={"tool_execution": tool_execution})
    next_payload = payload_with_step_state(
        payload,
        step_path=step_path,
        state=changed,
    )
    updated = db.execute(
        text(
            "UPDATE background_jobs SET payload = CAST(:payload AS jsonb) "
            "WHERE id = :job_id AND kind = 'dossier_build' AND status = 'dead' "
            "RETURNING id"
        ),
        {"job_id": job_id, "payload": json.dumps(next_payload)},
    ).scalar_one()
    assert updated == job_id
    return previous


def replace_completed_chat_tool_terminal(
    db: Session,
    *,
    job_id: UUID,
    step_path: str,
    terminal_result: str,
) -> str:
    """Model a policy-invalid completed terminal with internally exact accounting."""

    if (
        json.dumps(
            json.loads(terminal_result),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        != terminal_result
    ):
        raise AssertionError("replacement Chat tool terminal must be canonical JSON")
    row = (
        db.execute(
            text("SELECT kind, status, payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    if row["kind"] != "chat_run" or row["status"] not in {"failed", "pending", "running"}:
        raise AssertionError("tool terminal mutation requires one replayable Chat job")
    payload = dict(row["payload"])
    states = decode_step_states(payload)
    state = states.get(step_path)
    if (
        state is None
        or state.dispatch_phase is not Completed
        or not isinstance(state.terminal_result, Present)
        or not isinstance(state.tool_execution, Present)
        or not isinstance(state.tool_execution.value.settlement, Present)
    ):
        raise AssertionError("tool terminal mutation requires one settled completed position")
    previous = state.terminal_result.value
    settlement = state.tool_execution.value.settlement.value.model_copy(
        update={"actual_output_bytes": len(terminal_result.encode("utf-8"))}
    )
    execution = state.tool_execution.value.model_copy(update={"settlement": present(settlement)})
    changed = state.model_copy(
        update={
            "terminal_result": present(terminal_result),
            "tool_execution": present(execution),
        }
    )
    next_payload = payload_with_step_state(payload, step_path=step_path, state=changed)
    updated = db.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"job_id": job_id, "payload": json.dumps(next_payload)},
    ).rowcount
    assert updated == 1
    return previous


def replace_completed_chat_prepare_admitted_resource_uris(
    db: Session,
    *,
    job_id: UUID,
    admitted_resource_uris: tuple[str, ...],
) -> tuple[str, ...]:
    """Model a tampered authority snapshot behind an unchanged prepare fingerprint."""

    payload = db.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
        {"job_id": job_id},
    ).scalar_one()
    changed = json.loads(json.dumps(payload))
    prepare = changed["coordination"]["prepare"]
    terminal = prepare["terminal_result"]
    assert terminal["kind"] == "Present"
    prepared = json.loads(terminal["value"])
    original = tuple(prepared["admitted_resource_uris"])
    prepared["admitted_resource_uris"] = list(admitted_resource_uris)
    terminal["value"] = json.dumps(
        prepared,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    db.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"job_id": job_id, "payload": json.dumps(changed)},
    )
    return original


def remove_dossier_nexus_research_steps(db: Session, *, job_id: UUID) -> None:
    """Preserve occupied Web positions while modeling changed Dossier host inputs."""

    payload = db.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
        {"job_id": job_id},
    ).scalar_one()
    changed = json.loads(json.dumps(payload))
    coordination = changed["coordination"]
    for path in tuple(coordination):
        if path.startswith("research/nexus-"):
            del coordination[path]
    db.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"job_id": job_id, "payload": json.dumps(changed)},
    )


def lose_metadata_queue_completion_after_published_checkpoint(
    db: Session,
    *,
    job_id: UUID,
) -> None:
    """Model a crash that lost queue success after exact metadata publication."""
    before = (
        db.execute(
            text(
                """
                SELECT id, kind, status, attempts, claimed_by, lease_expires_at,
                       result, payload
                FROM background_jobs
                WHERE id = :job_id
                FOR UPDATE
                """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    assert before["id"] == job_id
    assert before["kind"] == "enrich_metadata"
    assert before["status"] == "succeeded"
    assert before["attempts"] == 1
    assert before["claimed_by"] is None
    assert before["lease_expires_at"] is None
    # The queue row's own status is "succeeded"; its published result carries the
    # repo-wide status-keyed projection of the domain success, failure, or skip.
    assert isinstance(before["result"], dict)
    published_status = before["result"].get("status")
    assert published_status in {"success", "failed", "skipped"}
    coordination = before["payload"].get("coordination")
    assert isinstance(coordination, dict)
    step = coordination.get("codex/metadata")
    assert isinstance(step, dict) and step.get("dispatch_phase") == "Completed"
    terminal_result = step.get("terminal_result")
    assert isinstance(terminal_result, dict) and terminal_result.get("kind") == "Present"
    decoded_terminal = json.loads(str(terminal_result.get("value")))
    publication_result = decoded_terminal.get("publication_result")
    assert isinstance(publication_result, dict)
    assert publication_result.get("kind") == "Present"
    # The durable memo keeps the kind-discriminated publication union while the
    # queue row publishes the status-keyed projection of the same facts.
    memo_value = publication_result.get("value")
    assert isinstance(memo_value, dict) and memo_value.get("kind") == published_status
    assert {key: value for key, value in memo_value.items() if key != "kind"} == {
        key: value for key, value in before["result"].items() if key != "status"
    }

    after = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET status = 'failed',
                    result = NULL,
                    finished_at = NULL,
                    available_at = now(),
                    updated_at = now()
                WHERE id = :job_id
                  AND kind = 'enrich_metadata'
                  AND status = 'succeeded'
                  AND attempts = 1
                  AND claimed_by IS NULL
                  AND lease_expires_at IS NULL
                RETURNING id, kind, status, attempts, claimed_by,
                          lease_expires_at, result, finished_at, payload
                """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    assert after["id"] == before["id"] == job_id
    assert after["kind"] == before["kind"] == "enrich_metadata"
    assert after["status"] == "failed"
    assert after["attempts"] == before["attempts"] == 1
    assert after["claimed_by"] is None and after["lease_expires_at"] is None
    assert after["result"] is None and after["finished_at"] is None
    assert after["payload"] == before["payload"]


def supersede_content_index_revision(
    db: Session,
    *,
    owner_id: UUID,
    expected_revision: int,
) -> None:
    """Advance a synthetic index owner without creating its successor job."""
    revision = db.execute(
        text(
            """
            UPDATE content_index_states
            SET revision = revision + 1,
                status = 'pending',
                updated_at = now()
            WHERE owner_kind = 'media'
              AND owner_id = :owner_id
              AND revision = :expected_revision
            RETURNING revision
            """
        ),
        {"owner_id": owner_id, "expected_revision": expected_revision},
    ).scalar_one()
    assert revision == expected_revision + 1


def release_heavy_capacity_row(db: Session) -> None:
    """Return the single Heavy capacity row to its unheld seeded shape.

    Capacity proofs need committed multi-connection visibility, so they mutate
    the one global row directly. This is their teardown: without it a failed
    scenario leaves the lease held and every later module sharing the run
    database inherits that failure.
    """
    db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET job_id = NULL,
                worker_id = NULL,
                attempt_no = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE resource_class = 'Heavy'
            """
        )
    )


def make_pending_job_due(db: Session, *, job_id: UUID) -> None:
    """Make one exact synthetic pending job claimable while retaining its row lock."""
    kind = db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = :job_id
              AND status = 'pending'
              AND claimed_by IS NULL
            RETURNING kind
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})


def delete_jobs_of_kinds(db: Session, *, kinds: Sequence[str]) -> None:
    """Remove committed probe queue rows created by a capacity proof module."""
    db.execute(
        text("DELETE FROM background_jobs WHERE kind = ANY(CAST(:kinds AS text[]))"),
        {"kinds": list(kinds)},
    )


def delete_source_probe_owners_by_job_kind(db: Session, *, kind: str) -> None:
    """Remove exact synthetic attempt/media/note-block owners named by one probe job kind."""
    owners = db.execute(
        text(
            """
            SELECT payload->>'attempt_id', payload->>'media_id'
            FROM background_jobs
            WHERE kind = :kind
              AND payload ? 'attempt_id'
              AND payload ? 'media_id'
            """
        ),
        {"kind": kind},
    ).all()
    attempt_ids = [UUID(str(row[0])) for row in owners]
    media_ids = [UUID(str(row[1])) for row in owners]
    note_block_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                """
                SELECT payload->>'note_block_id'
                FROM background_jobs
                WHERE kind = :kind AND payload ? 'note_block_id'
                """
            ),
            {"kind": kind},
        ).all()
    ]
    if media_ids:
        db.execute(
            text(
                """
                DELETE FROM content_index_states
                WHERE owner_kind = 'media'
                  AND owner_id = ANY(CAST(:ids AS uuid[]))
                """
            ),
            {"ids": media_ids},
        )
    if note_block_ids:
        db.execute(
            text(
                """
                DELETE FROM content_index_states
                WHERE owner_kind = 'note_block'
                  AND owner_id = ANY(CAST(:ids AS uuid[]))
                """
            ),
            {"ids": note_block_ids},
        )
    if attempt_ids:
        db.execute(
            text("DELETE FROM media_source_attempts WHERE id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": attempt_ids},
        )
    if media_ids:
        db.execute(
            text("DELETE FROM pdf_page_text_spans WHERE media_id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": media_ids},
        )
        db.execute(
            text("DELETE FROM media WHERE id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": media_ids},
        )


def delete_jobs_by_ids(db: Session, *, job_ids: Sequence[UUID]) -> None:
    """Remove only committed queue rows owned by one exact service proof."""
    if not job_ids:
        return
    db.execute(
        text("DELETE FROM background_jobs WHERE id = ANY(CAST(:job_ids AS uuid[]))"),
        {"job_ids": list(job_ids)},
    )


def cleanup_committed_chat_user(engine: Engine, *, user_id: UUID) -> None:
    """Remove the exact synthetic user's committed chat and bootstrap state."""
    from nexus.services.conversations import delete_conversation_rows_without_commit

    with Session(engine) as db:
        parameters = {"user_id": user_id}
        generation_ids = db.scalars(
            text(
                "SELECT id FROM llm_calls WHERE owner_kind='chat_run' AND owner_id IN "
                "(SELECT id FROM chat_runs WHERE owner_user_id=:user_id)"
            ),
            parameters,
        ).all()
        job_ids = db.scalars(
            text(
                "SELECT id FROM background_jobs WHERE kind='chat_run' AND payload->>'run_id' IN "
                "(SELECT id::text FROM chat_runs WHERE owner_user_id=:user_id)"
            ),
            parameters,
        ).all()
        delete_generations_by_ids(db, generation_ids=generation_ids)
        conversation_ids = db.scalars(
            text("SELECT id FROM conversations WHERE owner_user_id=:user_id"), parameters
        ).all()
        for conversation_id in conversation_ids:
            delete_conversation_rows_without_commit(db, conversation_id)
        delete_jobs_by_ids(db, job_ids=job_ids)
        for table in (
            "resource_mutations",
            "rate_limit_request_log",
            "billing_entitlement_override_events",
            "billing_entitlement_overrides",
        ):
            db.execute(text(f"DELETE FROM {table} WHERE user_id=:user_id"), parameters)
        db.execute(text("DELETE FROM libraries WHERE owner_user_id=:user_id"), parameters)
        db.execute(
            text("DELETE FROM viewer_collection_revisions WHERE viewer_id=:user_id"), parameters
        )
        db.execute(text("DELETE FROM users WHERE id=:user_id"), parameters)
        db.commit()


type GenerationLedgerCorruption = Literal[
    "nonpositive_sequence",
    "owner_operation",
    "plan_selection",
    "model_tool_plan",
    "route",
    "fingerprint",
    "session_ref",
    "usage",
    "lifecycle",
]


def corrupt_generation_ledger_row(
    db: Session,
    *,
    generation_id: UUID,
    corruption: GenerationLedgerCorruption,
) -> None:
    """Create one closed invalid ledger-row shape for trusted-read defect proof."""

    match corruption:
        case "nonpositive_sequence":
            statement = (
                "UPDATE llm_calls SET generation_seq = 0 WHERE id = :generation_id RETURNING id"
            )
        case "owner_operation":
            statement = (
                "UPDATE llm_calls SET owner_kind = 'chat_run' "
                "WHERE id = :generation_id RETURNING id"
            )
        case "plan_selection":
            statement = (
                "UPDATE llm_calls SET model_name = 'gpt-5.6-sol' "
                "WHERE id = :generation_id RETURNING id"
            )
        case "model_tool_plan":
            statement = (
                "UPDATE llm_calls SET model_tool_plan_snapshot = "
                '\'{"kind":"Present","value":{}}\'::jsonb '
                "WHERE id = :generation_id RETURNING id"
            )
        case "route":
            statement = (
                "UPDATE llm_calls SET auth_profile = 'api-key' "
                "WHERE id = :generation_id RETURNING id"
            )
        case "fingerprint":
            statement = (
                "UPDATE llm_calls SET request_fingerprint = repeat('A', 64) "
                "WHERE id = :generation_id RETURNING id"
            )
        case "session_ref":
            statement = (
                "UPDATE llm_calls SET session_ref = "
                '\'{"schema_version":"wrong"}\'::jsonb '
                "WHERE id = :generation_id RETURNING id"
            )
        case "usage":
            statement = (
                "UPDATE llm_calls SET input_tokens = 1 WHERE id = :generation_id RETURNING id"
            )
        case "lifecycle":
            statement = (
                "UPDATE llm_calls SET completed_at = now() WHERE id = :generation_id RETURNING id"
            )
        case unreachable:
            assert_never(unreachable)
    updated = db.execute(text(statement), {"generation_id": generation_id})
    assert updated.scalar_one() == generation_id


def delete_generations_by_ids(db: Session, *, generation_ids: Sequence[UUID]) -> None:
    """Remove only committed generation ledger rows owned by one exact proof."""
    if not generation_ids:
        return
    parameters = {"generation_ids": list(generation_ids)}
    # Chat projections and machine-authorship rows deliberately use restrictive
    # links to the canonical tool position.  Remove only the projections owned
    # by these proof generations before deleting their ledger rows; broad
    # cascade semantics would weaken the production contract this test helper
    # is meant to preserve.
    db.execute(
        text(
            """
            DELETE FROM message_retrievals
            WHERE tool_call_id IN (
                SELECT call.id
                FROM message_tool_calls AS call
                JOIN llm_tool_positions AS position ON position.id = call.tool_position_id
                WHERE position.generation_id = ANY(CAST(:generation_ids AS uuid[]))
            )
            """
        ),
        parameters,
    )
    db.execute(
        text(
            """
            DELETE FROM chat_run_events
            WHERE payload->>'tool_call_id' IN (
                SELECT CAST(call.id AS text)
                FROM message_tool_calls AS call
                JOIN llm_tool_positions AS position ON position.id = call.tool_position_id
                WHERE position.generation_id = ANY(CAST(:generation_ids AS uuid[]))
            )
            """
        ),
        parameters,
    )
    db.execute(
        text(
            """
            DELETE FROM assistant_write_authorships
            WHERE tool_position_id IN (
                SELECT id
                FROM llm_tool_positions
                WHERE generation_id = ANY(CAST(:generation_ids AS uuid[]))
            )
            """
        ),
        parameters,
    )
    db.execute(
        text(
            """
            DELETE FROM message_tool_calls
            WHERE tool_position_id IN (
                SELECT id
                FROM llm_tool_positions
                WHERE generation_id = ANY(CAST(:generation_ids AS uuid[]))
            )
            """
        ),
        parameters,
    )
    db.execute(
        text(
            "DELETE FROM llm_model_turn_continuations "
            "WHERE generation_id = ANY(CAST(:generation_ids AS uuid[]))"
        ),
        parameters,
    )
    db.execute(
        text(
            "DELETE FROM llm_tool_positions "
            "WHERE generation_id = ANY(CAST(:generation_ids AS uuid[]))"
        ),
        parameters,
    )
    db.execute(
        text(
            "DELETE FROM llm_model_turns WHERE generation_id = ANY(CAST(:generation_ids AS uuid[]))"
        ),
        parameters,
    )
    db.execute(
        text("DELETE FROM llm_calls WHERE id = ANY(CAST(:generation_ids AS uuid[]))"),
        parameters,
    )


def delete_source_attempt_and_media(
    db: Session,
    *,
    attempt_id: UUID,
    media_id: UUID,
) -> None:
    """Remove one committed synthetic source owner after its readiness proof."""
    delete_source_attempts_and_media(
        db,
        attempt_ids=(attempt_id,),
        media_id=media_id,
    )


def delete_source_attempts_and_media(
    db: Session,
    *,
    attempt_ids: Sequence[UUID],
    media_id: UUID,
) -> None:
    """Remove exact committed synthetic source owners and their shared media."""
    db.execute(
        text("DELETE FROM media_source_attempts WHERE id = ANY(CAST(:attempt_ids AS uuid[]))"),
        {"attempt_ids": list(attempt_ids)},
    )
    db.execute(
        text("DELETE FROM pdf_page_text_spans WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM media WHERE id = :media_id"), {"media_id": media_id})


def publish_source_probe_success(
    db: Session,
    *,
    attempt_id: UUID,
    media_id: UUID,
    job_id: UUID,
) -> None:
    """Inject the exact durable-success window before a probe child is killed."""
    db.execute(
        text(
            """
            UPDATE media_source_attempts
            SET status = 'succeeded', finished_at = now(), updated_at = now()
            WHERE id = :attempt_id AND job_id = :job_id
            """
        ),
        {"attempt_id": attempt_id, "job_id": job_id},
    )
    db.execute(
        text(
            """
            UPDATE media
            SET processing_status = 'ready_for_reading',
                processing_completed_at = now(), updated_at = now()
            WHERE id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            INSERT INTO fragments (media_id, idx, canonical_text, html_sanitized)
            VALUES (:media_id, 0, 'durable artifact sentinel', '<p>durable artifact sentinel</p>')
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind, owner_id, revision, status, status_reason
            )
            VALUES ('media', :media_id, 1, 'pending', 'source_success')
            """
        ),
        {"media_id": media_id},
    )
