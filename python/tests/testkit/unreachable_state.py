"""Narrow raw-SQL owner for states production APIs cannot create on demand."""

from __future__ import annotations

import json
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


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


def replace_completed_chat_tool_arguments(
    db: Session,
    *,
    job_id: UUID,
    tool_call_index: int,
    arguments: dict[str, object],
) -> None:
    """Model a changed provider invocation inside one completed Chat generation."""

    payload = db.execute(
        text("SELECT payload FROM background_jobs WHERE id = :job_id FOR UPDATE"),
        {"job_id": job_id},
    ).scalar_one()
    changed = json.loads(json.dumps(payload))
    generation = changed["coordination"]["turn/0/generation"]
    terminal = generation["terminal_result"]
    assert terminal["kind"] == "Present"
    assistant_turn = json.loads(terminal["value"])
    calls = assistant_turn["tool_calls"]
    assert len(calls) >= tool_call_index
    calls[tool_call_index - 1]["arguments"] = arguments
    terminal["value"] = json.dumps(
        assistant_turn,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    db.execute(
        text("UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :job_id"),
        {"job_id": job_id, "payload": json.dumps(changed)},
    )


def make_pending_job_due(db: Session, *, job_id: UUID) -> None:
    """Advance only one synthetic pending job past its scheduler deadline."""

    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET available_at = now()
            WHERE id = :job_id
              AND status = 'pending'
            RETURNING id
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    assert updated == job_id


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
    assert isinstance(before["result"], dict) and before["result"].get("status") == "success"
    coordination = before["payload"].get("coordination")
    assert isinstance(coordination, dict)
    step = coordination.get("codex/metadata")
    assert isinstance(step, dict) and step.get("dispatch_phase") == "Completed"
    terminal_result = step.get("terminal_result")
    assert isinstance(terminal_result, dict) and terminal_result.get("kind") == "Present"
    decoded_terminal = json.loads(str(terminal_result.get("value")))
    publication_result = decoded_terminal.get("publication_result")
    assert isinstance(publication_result, dict)
    assert {key: value for key, value in publication_result.items() if value is not None} == before[
        "result"
    ]

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


def delete_jobs_of_kinds(db: Session, *, kinds: Sequence[str]) -> None:
    """Remove committed probe queue rows created by a capacity proof module."""
    db.execute(
        text("DELETE FROM background_jobs WHERE kind = ANY(CAST(:kinds AS text[]))"),
        {"kinds": list(kinds)},
    )
