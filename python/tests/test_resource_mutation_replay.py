"""Tests for the shared resource-mutation replay ledger (spec
lectern-player-lifecycle-hard-cutover.md §5).

``resource_mutation_replay`` was extracted from five duplicate implementations
(``notes.py``, ``_contributor_replay.py``, ``contributors.py``,
``resource_items/mutations.py``, ``resource_items/surfaces.py``). The one
non-negotiable invariant of that extraction is byte-for-byte hash compatibility
with every pre-extraction scope: existing ``resource_mutations`` rows must keep
replaying correctly. (a) below pins the historical sha256 algorithm
independent of the module's own implementation. (b)/(c) exercise the shared
lookup/record contract directly. (d) proves the concurrency-gap fix that
landed alongside the extraction: ``notes.quick_capture`` now wraps its whole
claim/validate/write/memo body in ``retry_serializable``, so a duplicate
same-key submit converges on the first recorded response instead of
surfacing a raw ``IntegrityError``.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.notes import QuickCaptureRequest
from nexus.services import notes
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)


def _paragraph(text_value: str) -> dict[str, object]:
    return {"type": "paragraph", "content": [{"type": "text", "text": text_value}]}


@pytest.mark.unit
def test_canonical_json_bytes_matches_historical_sha256_algorithm() -> None:
    # Every pre-extraction implementation hashed sha256(json.dumps(payload,
    # sort_keys=True, separators=(",", ":")).encode("utf-8")). Compute that
    # independently here so a change to canonical_json_bytes's dump basis fails
    # this test even though nothing else in the suite recomputes the hash by
    # hand.
    payload = {"b": 2, "a": [3, 1, 2], "c": {"z": "y", "x": None}, "clientMutationId": "cmid-1"}
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    actual = hashlib.sha256(canonical_json_bytes(payload)).hexdigest()

    assert actual == expected, (
        "canonical_json_bytes drifted from the dump basis every pre-extraction scope "
        f"hashed against: expected sha256 {expected!r}, got {actual!r} for payload {payload!r}"
    )


@pytest.mark.integration
def test_lookup_replay_returns_none_on_first_sight(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    result = lookup_replay(
        db_session,
        viewer_id=bootstrapped_user,
        scope="test:resource_mutation_replay:first_sight",
        client_mutation_id=str(uuid4()),
        request_bytes=canonical_json_bytes({"value": "first"}),
    )

    assert result is None, "an unrecorded key must read as first sight, not a replay hit"


@pytest.mark.integration
def test_lookup_replay_returns_recorded_response_for_exact_replay(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    scope = "test:resource_mutation_replay:exact_replay"
    client_mutation_id = str(uuid4())
    request_bytes = canonical_json_bytes({"value": "first"})

    record_replay(
        db_session,
        viewer_id=bootstrapped_user,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        response_json={"result": "ok"},
        changed_lanes={"a-lane": True},
    )
    db_session.commit()

    replayed = lookup_replay(
        db_session,
        viewer_id=bootstrapped_user,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
    )

    assert replayed == {"result": "ok"}, "an exact replay must return the memoized response as-is"


@pytest.mark.integration
def test_lookup_replay_raises_on_hash_mismatch(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    scope = "test:resource_mutation_replay:mismatch"
    client_mutation_id = str(uuid4())
    record_replay(
        db_session,
        viewer_id=bootstrapped_user,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=canonical_json_bytes({"value": "first"}),
        response_json={"result": "ok"},
        changed_lanes={},
    )
    db_session.commit()

    with pytest.raises(ConflictError) as excinfo:
        lookup_replay(
            db_session,
            viewer_id=bootstrapped_user,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=canonical_json_bytes({"value": "different"}),
        )

    assert excinfo.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH, (
        f"expected E_IDEMPOTENCY_KEY_REPLAY_MISMATCH, got {excinfo.value.code}"
    )


@pytest.mark.integration
def test_quick_capture_duplicate_submit_converges_on_recorded_response(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    # notes.quick_capture's claim/validate/write/memo body is now wrapped in
    # retry_serializable (requirement 3): a duplicate submit under the same
    # clientMutationId must converge on the first recorded response rather
    # than raising a raw IntegrityError on the second write attempt.
    request = QuickCaptureRequest(
        id=uuid4(),
        client_mutation_id="quick-capture-duplicate-submit",
        local_date=date(2026, 6, 13),
        body_pm_json=_paragraph("captured once"),
    )

    first = notes.quick_capture(db_session, bootstrapped_user, request=request)
    second = notes.quick_capture(db_session, bootstrapped_user, request=request)

    assert second == first, "a duplicate same-key submit must return the identical response"
    assert second.id == request.id

    edges = db_session.scalars(
        select(ResourceEdge).where(
            ResourceEdge.user_id == bootstrapped_user,
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == request.id,
        )
    ).all()
    assert len(edges) == 1, "the replayed duplicate must not create a second ordered edge"
