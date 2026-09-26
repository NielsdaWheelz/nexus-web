"""Route-neutral parent/child generation ledger and replay fences.

Every helper stages work in its caller-owned transaction and never commits.
External model or tool I/O happens only after the matching uncertain dispatch
fact has committed. The owner advisory lock precedes every row lock so the
dense ``generation_seq`` and ``turn_seq`` positions cannot collide.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Never, cast
from uuid import UUID

from sqlalchemy import delete, func, select, text, tuple_
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall, LLMModelTurn, LLMModelTurnContinuation, LLMToolPosition
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_continuations import (
    GenerationContinuationCipher,
    GenerationContinuationContext,
    SealedGenerationContinuation,
)
from nexus.services.generation_spec import GenerationSpec, decode_generation_spec_document

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type LlmCallOwnerKind = Literal[
    "chat_run",
    "oracle_reading",
    "artifact_build",
    "artifact_learn_request",
    "media_summary",
    "synapse_scan",
    "media_enrichment",
]
type GenerationOutcome = Literal["Succeeded", "Failed", "Cancelled"]

# The operation -> owner map is a hard contract: llm_calls.owner_kind must equal
# the owner kind of the frozen spec's operation.
_OPERATION_OWNER_KINDS: dict[str, LlmCallOwnerKind] = {
    "metadata_enrichment": "media_enrichment",
    "media_summary": "media_summary",
    "synapse": "synapse_scan",
    "oracle": "oracle_reading",
    "dossier_page": "artifact_build",
    "dossier_note": "artifact_build",
    "dossier_media": "artifact_build",
    "dossier_conversation": "artifact_build",
    "dossier_library": "artifact_build",
    "dossier_podcast": "artifact_build",
    "dossier_contributor": "artifact_build",
    "dossier_idea": "artifact_build",
    "chat": "chat_run",
}
_TERMINAL_KINDS = frozenset({"Succeeded", "Failed", "Cancelled"})


@dataclass(frozen=True, slots=True)
class LlmCallOwner:
    """Durable owner of one ordered logical generation."""

    kind: LlmCallOwnerKind
    id: UUID


@dataclass(frozen=True, slots=True)
class GenerationStart:
    """Replay-stable parent facts staged with owning durable work."""

    generation_id: UUID
    owner: LlmCallOwner
    spec: GenerationSpec

    def __post_init__(self) -> None:
        expected = _OPERATION_OWNER_KINDS.get(self.spec.operation)
        if expected != self.owner.kind:
            raise ValueError(
                f"generation operation {self.spec.operation!r} requires owner kind {expected!r}"
            )


@dataclass(frozen=True, slots=True)
class GenerationRecord:
    """Detached typed parent projection."""

    id: UUID
    owner: LlmCallOwner
    generation_seq: int
    spec: GenerationSpec
    outcome: GenerationOutcome | None
    failure_code: str | None
    terminal: dict[str, JsonValue] | None
    created_at: datetime
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class ModelTurnStart:
    """Exact identity of one prepared route-native model call."""

    model_turn_id: UUID
    generation_id: UUID
    turn_seq: int
    request_fingerprint: str
    route_request_identity: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.turn_seq < 1:
            raise ValueError("model turn sequence must be positive")


@dataclass(frozen=True, slots=True)
class ModelTurnRecord:
    """Detached typed child projection."""

    id: UUID
    generation_id: UUID
    turn_seq: int
    request_fingerprint: str
    route_request_identity: dict[str, JsonValue]
    terminal: dict[str, JsonValue] | None
    usage: dict[str, JsonValue] | None
    billability: dict[str, JsonValue] | None
    created_at: datetime
    dispatch_started_at: datetime | None
    accepted_at: datetime | None
    completed_at: datetime | None


@dataclass(frozen=True, slots=True)
class ModelTurnCompletion:
    """Terminal child facts and its optional atomic successor continuation."""

    terminal: Mapping[str, object]
    usage: Presence[Mapping[str, object]]
    billability: Presence[Mapping[str, object]]
    accepted_at: Presence[datetime]
    successor: Presence[SealedGenerationContinuation]

    def __post_init__(self) -> None:
        if self.terminal.get("kind") not in _TERMINAL_KINDS:
            raise ValueError("model turn terminal kind is not closed")


@dataclass(frozen=True, slots=True)
class PendingGenerationContinuation:
    """One terminal child whose sealed successor is safe to resume."""

    source_turn: ModelTurnRecord
    context: GenerationContinuationContext
    canonical_continuation: bytes = field(repr=False)


def lock_generation_owner_in_current_transaction(db: Session, owner: LlmCallOwner) -> None:
    """Take the stable owner lock before every generation/child/tool row lock."""

    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"{owner.kind}:{owner.id}"},
    )


def start_generation_in_current_transaction(db: Session, start: GenerationStart) -> UUID:
    """Stage exactly one parent generation without reading mutable policy."""

    lock_generation_owner_in_current_transaction(db, start.owner)
    document = cast(dict[str, object], start.spec.model_dump(mode="json", by_alias=True))
    existing = db.get(LLMCall, start.generation_id)
    if existing is not None:
        if (existing.owner_kind, existing.owner_id, existing.generation_fingerprint) != (
            start.owner.kind,
            start.owner.id,
            start.spec.fingerprint,
        ):
            raise AssertionError(
                f"generation_id={start.generation_id} was reused with different parent facts"
            )
        return existing.id
    call = LLMCall(
        id=start.generation_id,
        owner_kind=start.owner.kind,
        owner_id=start.owner.id,
        generation_seq=_next_generation_seq(db, start.owner),
        generation_spec=document,
        generation_fingerprint=start.spec.fingerprint,
    )
    db.add(call)
    db.flush()
    return call.id


def complete_generation_in_current_transaction(
    db: Session, *, owner: LlmCallOwner, generation_id: UUID, terminal: Mapping[str, object]
) -> None:
    """Stage one parent terminal after its final child has committed."""

    document = dict(terminal)
    outcome = document.get("kind")
    failure_code = document.get("failure_code")
    if outcome not in _TERMINAL_KINDS:
        raise ValueError("generation terminal kind is not closed")
    if (outcome == "Failed") != isinstance(failure_code, str):
        raise ValueError("a failed generation terminal requires exactly one failure_code")

    call = _lock_owned_generation(db, owner=owner, generation_id=generation_id)
    unfinished_tool = db.scalar(
        select(LLMToolPosition.id)
        .where(
            LLMToolPosition.generation_id == generation_id,
            LLMToolPosition.replay_status != "Completed",
        )
        .limit(1)
    )
    if unfinished_tool is not None:
        raise RuntimeError(
            f"generation {generation_id} cannot complete with unfinished tool position "
            f"{unfinished_tool}"
        )
    if call.terminal is not None:
        if call.terminal != document:
            _ledger_defect(call, "terminal replay differs from committed terminal")
        return
    latest_turn = db.scalar(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id == generation_id)
        .order_by(LLMModelTurn.turn_seq.desc())
        .limit(1)
    )
    if latest_turn is None or latest_turn.terminal is None:
        _ledger_defect(call, "parent terminal precedes a terminal model child")
    pending = db.scalar(
        select(LLMModelTurnContinuation.id)
        .where(LLMModelTurnContinuation.generation_id == generation_id)
        .limit(1)
    )
    if pending is not None:
        _ledger_defect(call, "parent terminal precedes its sealed successor continuation")
    call.outcome = cast(GenerationOutcome, outcome)
    call.failure_code = cast(str | None, failure_code)
    call.terminal = document
    call.completed_at = func.now()
    db.flush()


def stop_generation_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    source_turn_seq: int,
    reason: Literal["cancelled", "turn_limit"],
) -> None:
    """Retire a committed successor and close its parent without a new model turn."""

    call = _lock_owned_generation(db, owner=owner, generation_id=generation_id)
    _assert_parent_open(call)
    source = db.scalar(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id == generation_id)
        .order_by(LLMModelTurn.turn_seq.desc())
        .limit(1)
        .with_for_update()
    )
    if source is None or source.turn_seq != source_turn_seq or source.terminal is None:
        _ledger_defect(call, "generation stop lacks its exact terminal source child")
    continuation = db.scalar(
        select(LLMModelTurnContinuation)
        .where(LLMModelTurnContinuation.generation_id == generation_id)
        .with_for_update()
    )
    if continuation is None or continuation.source_model_turn_id != source.id:
        _ledger_defect(call, "generation stop lacks its exact pending continuation")
    db.delete(continuation)
    db.flush()
    terminal: dict[str, object] = {
        "kind": "Cancelled" if reason == "cancelled" else "Failed",
        "orchestration_stop": reason,
        "final_model_turn_seq": source_turn_seq,
        "model_turn_terminal": dict(source.terminal),
    }
    if reason == "turn_limit":
        terminal["failure_code"] = reason
    complete_generation_in_current_transaction(
        db, owner=owner, generation_id=generation_id, terminal=terminal
    )


def start_model_turn_in_current_transaction(db: Session, start: ModelTurnStart) -> UUID:
    """Allocate the initial child under the locked parent sequence fence."""

    if start.turn_seq != 1:
        raise ValueError(
            "only the initial model child may start directly; "
            "successors require sealed continuation resume"
        )
    call = _lock_generation_by_id(db, start.generation_id)
    _assert_parent_open(call)
    return _start_model_turn_under_parent_lock(db, call=call, start=start).id


def arm_model_turn_dispatch_in_current_transaction(
    db: Session, *, generation_id: UUID, model_turn_id: UUID
) -> None:
    """Record uncertainty before provider I/O; replay never clears this fact."""

    call = _lock_generation_by_id(db, generation_id)
    _assert_parent_open(call)
    turn = _lock_model_turn(db, generation_id=generation_id, model_turn_id=model_turn_id)
    if turn.terminal is not None:
        _turn_defect(turn, "terminal turn cannot be armed")
    if turn.dispatch_started_at is None:
        turn.dispatch_started_at = func.now()
        db.flush()


def complete_model_turn_in_current_transaction(
    db: Session, *, generation_id: UUID, model_turn_id: UUID, completion: ModelTurnCompletion
) -> None:
    """Atomically commit child terminal facts and its sealed successor."""

    call = _lock_generation_by_id(db, generation_id)
    _assert_parent_open(call)
    turn = _lock_model_turn(db, generation_id=generation_id, model_turn_id=model_turn_id)
    terminal = dict(completion.terminal)
    usage = _nullable(completion.usage)
    billability = _nullable(completion.billability)
    accepted_at = (
        completion.accepted_at.value if isinstance(completion.accepted_at, Present) else None
    )
    if turn.dispatch_started_at is None:
        _turn_defect(turn, "terminal turn was never armed before provider I/O")
    if turn.terminal is not None:
        if (turn.terminal, turn.usage, turn.billability, turn.accepted_at) != (
            terminal,
            usage,
            billability,
            accepted_at,
        ):
            _turn_defect(turn, "terminal replay differs from committed child terminal")
        _assert_successor_identity(db, turn=turn, successor=completion.successor)
        return

    turn.terminal = terminal
    turn.usage = usage
    turn.billability = billability
    turn.accepted_at = accepted_at
    turn.completed_at = func.now()
    db.execute(
        delete(LLMModelTurnContinuation).where(
            LLMModelTurnContinuation.generation_id == generation_id,
            LLMModelTurnContinuation.successor_turn_seq == turn.turn_seq,
        )
    )
    if isinstance(completion.successor, Present):
        _stage_successor_continuation(db, turn=turn, sealed=completion.successor.value)
    db.flush()


def open_generation_continuation_in_current_transaction(
    db: Session,
    *,
    source_model_turn_id: UUID,
    expected_context: GenerationContinuationContext,
    cipher: GenerationContinuationCipher,
) -> bytes:
    """Authenticate one sealed successor without consuming or preparing it.

    Opening is read-only on purpose: a crash afterwards may safely reopen the
    same envelope, while consumption stays atomic with successor arming.
    """

    call = _lock_generation_by_id(db, expected_context.generation_id)
    _assert_parent_open(call)
    source = _lock_model_turn(
        db, generation_id=expected_context.generation_id, model_turn_id=source_model_turn_id
    )
    if source.turn_seq != expected_context.source_turn_seq or source.terminal is None:
        _turn_defect(source, "cannot open continuation from the requested source child")
    continuation = db.scalar(
        select(LLMModelTurnContinuation)
        .where(
            LLMModelTurnContinuation.generation_id == expected_context.generation_id,
            LLMModelTurnContinuation.source_model_turn_id == source_model_turn_id,
        )
        .with_for_update()
    )
    if continuation is None:
        _turn_defect(source, "terminal source child has no sealed successor continuation")
    return cipher.open(
        sealed=_sealed_from_row(continuation, source_turn_seq=source.turn_seq),
        expected_context=expected_context,
    )


def read_pending_generation_continuation_in_current_transaction(
    db: Session, *, generation_id: UUID, cipher: GenerationContinuationCipher
) -> PendingGenerationContinuation | None:
    """Read the sole reopenable provider successor under the parent fence."""

    call = _lock_generation_by_id(db, generation_id)
    _assert_parent_open(call)
    rows = db.scalars(
        select(LLMModelTurnContinuation)
        .where(LLMModelTurnContinuation.generation_id == generation_id)
        .with_for_update()
    ).all()
    if not rows:
        return None
    if len(rows) != 1:
        _ledger_defect(call, "generation has more than one pending continuation")
    row = rows[0]
    source = _lock_model_turn(
        db, generation_id=generation_id, model_turn_id=row.source_model_turn_id
    )
    if source.terminal is None or source.completed_at is None:
        _turn_defect(source, "pending continuation belongs to a nonterminal source child")
    sealed = _sealed_from_row(row, source_turn_seq=source.turn_seq)
    return PendingGenerationContinuation(
        source_turn=_turn_record(source),
        context=sealed.context,
        canonical_continuation=cipher.open(sealed=sealed, expected_context=sealed.context),
    )


def arm_resumed_model_turn_dispatch_in_current_transaction(
    db: Session, *, source_model_turn_id: UUID, successor: ModelTurnStart
) -> ModelTurnRecord:
    """Prepare, arm, and consume one successor under the parent fence.

    This is the sole destructive continuation transition: the envelope stays
    present while the successor request is derived, then disappears in the same
    transaction that records dispatch uncertainty. A crash is therefore always
    reopenable or already armed, never a licence to duplicate a provider call.
    """

    call = _lock_generation_by_id(db, successor.generation_id)
    _assert_parent_open(call)
    source = _lock_model_turn(
        db, generation_id=successor.generation_id, model_turn_id=source_model_turn_id
    )
    if source.terminal is None:
        _turn_defect(source, "cannot resume from a nonterminal source child")
    continuation = db.scalar(
        select(LLMModelTurnContinuation)
        .where(
            LLMModelTurnContinuation.generation_id == successor.generation_id,
            LLMModelTurnContinuation.source_model_turn_id == source_model_turn_id,
        )
        .with_for_update()
    )
    if continuation is None:
        _turn_defect(source, "terminal source child has no successor continuation")
    if successor.turn_seq != continuation.successor_turn_seq:
        _turn_defect(source, "successor child sequence differs from sealed continuation")
    existing = db.scalar(
        select(LLMModelTurn).where(
            LLMModelTurn.generation_id == successor.generation_id,
            LLMModelTurn.turn_seq == successor.turn_seq,
        )
    )
    turn = (
        _start_model_turn_under_parent_lock(db, call=call, start=successor)
        if existing is None
        else existing
    )
    _assert_model_turn_identity(turn, successor)
    if turn.dispatch_started_at is not None or turn.terminal is not None:
        raise AssertionError(
            f"llm_model_turns row id={turn.id} is corrupt: successor model turn was already armed"
        )
    arm_model_turn_dispatch_in_current_transaction(
        db, generation_id=successor.generation_id, model_turn_id=successor.model_turn_id
    )
    deleted = db.execute(
        delete(LLMModelTurnContinuation).where(
            LLMModelTurnContinuation.generation_id == successor.generation_id,
            LLMModelTurnContinuation.source_model_turn_id == source_model_turn_id,
            LLMModelTurnContinuation.successor_turn_seq == successor.turn_seq,
        )
    )
    if not isinstance(deleted, CursorResult) or deleted.rowcount != 1:
        raise AssertionError(
            f"llm_model_turns row id={turn.id} is corrupt: "
            "successor continuation was not consumed exactly once"
        )
    db.flush()
    return _turn_record(turn)


def read_model_turns(db: Session, *, generation_id: UUID) -> tuple[ModelTurnRecord, ...]:
    turns = db.scalars(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id == generation_id)
        .order_by(LLMModelTurn.turn_seq)
    ).all()
    return tuple(_turn_record(turn) for turn in turns)


def read_model_turns_for_generations(
    db: Session, *, generation_ids: Collection[UUID]
) -> dict[UUID, tuple[ModelTurnRecord, ...]]:
    """Read every child for a bounded parent set without an N+1 query."""

    distinct_ids = tuple(dict.fromkeys(generation_ids))
    if not distinct_ids:
        return {}
    turns = db.scalars(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id.in_(distinct_ids))
        .order_by(LLMModelTurn.generation_id, LLMModelTurn.turn_seq)
    ).all()
    grouped: dict[UUID, list[ModelTurnRecord]] = {item: [] for item in distinct_ids}
    for turn in turns:
        grouped[turn.generation_id].append(_turn_record(turn))
    return {generation_id: tuple(records) for generation_id, records in grouped.items()}


def read_latest_generations_for_owners(
    db: Session, *, owners: Collection[LlmCallOwner], outcome: GenerationOutcome | None = None
) -> dict[LlmCallOwner, GenerationRecord]:
    distinct_owners = tuple(dict.fromkeys(owners))
    if not distinct_owners:
        return {}
    identity = tuple_(LLMCall.owner_kind, LLMCall.owner_id)
    latest = select(
        LLMCall.owner_kind.label("owner_kind"),
        LLMCall.owner_id.label("owner_id"),
        func.max(LLMCall.generation_seq).label("generation_seq"),
    ).where(identity.in_([(owner.kind, owner.id) for owner in distinct_owners]))
    if outcome is not None:
        latest = latest.where(LLMCall.outcome == outcome)
    latest_rows = latest.group_by(LLMCall.owner_kind, LLMCall.owner_id).subquery()
    calls = db.scalars(
        select(LLMCall).join(
            latest_rows,
            (LLMCall.owner_kind == latest_rows.c.owner_kind)
            & (LLMCall.owner_id == latest_rows.c.owner_id)
            & (LLMCall.generation_seq == latest_rows.c.generation_seq),
        )
    ).all()
    records = [_generation_record(call) for call in calls]
    return {record.owner: record for record in records}


def read_latest_generation_for_owner(
    db: Session, *, owner: LlmCallOwner
) -> GenerationRecord | None:
    call = db.scalar(
        select(LLMCall)
        .where(LLMCall.owner_kind == owner.kind, LLMCall.owner_id == owner.id)
        .order_by(LLMCall.generation_seq.desc())
        .limit(1)
    )
    return None if call is None else _generation_record(call)


def lock_generation_for_authority_in_current_transaction(
    db: Session, *, owner: LlmCallOwner, generation_id: UUID
) -> GenerationRecord | None:
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(
        select(LLMCall)
        .where(
            LLMCall.id == generation_id,
            LLMCall.owner_kind == owner.kind,
            LLMCall.owner_id == owner.id,
        )
        .with_for_update()
    )
    return None if call is None else _generation_record(call)


def lock_active_generation_for_authority_in_current_transaction(
    db: Session, *, owner: LlmCallOwner, generation_id: UUID
) -> GenerationRecord | None:
    record = lock_generation_for_authority_in_current_transaction(
        db, owner=owner, generation_id=generation_id
    )
    return None if record is None or record.outcome is not None else record


def _start_model_turn_under_parent_lock(
    db: Session, *, call: LLMCall, start: ModelTurnStart
) -> LLMModelTurn:
    existing = db.get(LLMModelTurn, start.model_turn_id) or db.scalar(
        select(LLMModelTurn).where(
            LLMModelTurn.generation_id == start.generation_id,
            LLMModelTurn.turn_seq == start.turn_seq,
        )
    )
    if existing is not None:
        _assert_model_turn_identity(existing, start)
        return existing
    next_seq = db.scalar(
        select(func.coalesce(func.max(LLMModelTurn.turn_seq), 0) + 1).where(
            LLMModelTurn.generation_id == call.id
        )
    )
    if start.turn_seq != next_seq:
        raise ValueError(
            f"model turn sequence must be the next parent position {next_seq}, got {start.turn_seq}"
        )
    turn = LLMModelTurn(
        id=start.model_turn_id,
        generation_id=start.generation_id,
        turn_seq=start.turn_seq,
        request_fingerprint=start.request_fingerprint,
        route_request_identity=dict(start.route_request_identity),
    )
    db.add(turn)
    db.flush()
    return turn


def _stage_successor_continuation(
    db: Session, *, turn: LLMModelTurn, sealed: SealedGenerationContinuation
) -> None:
    context = sealed.context
    _assert_successor_context(turn, context)
    existing = db.scalar(
        select(LLMModelTurnContinuation).where(
            LLMModelTurnContinuation.source_model_turn_id == turn.id
        )
    )
    if existing is not None:
        _assert_continuation_row(existing, sealed)
        return
    db.add(
        LLMModelTurnContinuation(
            generation_id=turn.generation_id,
            source_model_turn_id=turn.id,
            successor_turn_seq=context.successor_turn_seq,
            target_fingerprint=context.target_fingerprint,
            codec_id=context.codec_id,
            policy_revision=context.policy_revision,
            envelope_version=sealed.envelope_version,
            nonce=sealed.nonce,
            ciphertext=sealed.ciphertext,
        )
    )


def _assert_successor_identity(
    db: Session, *, turn: LLMModelTurn, successor: Presence[SealedGenerationContinuation]
) -> None:
    existing = db.scalar(
        select(LLMModelTurnContinuation).where(
            LLMModelTurnContinuation.source_model_turn_id == turn.id
        )
    )
    consumed = db.scalar(
        select(LLMModelTurn.id).where(
            LLMModelTurn.generation_id == turn.generation_id,
            LLMModelTurn.turn_seq == turn.turn_seq + 1,
        )
    )
    if isinstance(successor, Absent):
        if existing is not None or consumed is not None:
            _turn_defect(turn, "terminal replay omitted its committed successor")
        return
    _assert_successor_context(turn, successor.value.context)
    if existing is None:
        if consumed is not None:
            return
        _turn_defect(turn, "terminal replay added a successor after commit")
    _assert_continuation_row(existing, successor.value)


def _assert_successor_context(turn: LLMModelTurn, context: GenerationContinuationContext) -> None:
    if (context.generation_id, context.source_turn_seq, context.successor_turn_seq) != (
        turn.generation_id,
        turn.turn_seq,
        turn.turn_seq + 1,
    ):
        _turn_defect(turn, "successor continuation identity differs from source child")


def _assert_continuation_row(
    row: LLMModelTurnContinuation, sealed: SealedGenerationContinuation
) -> None:
    if _sealed_from_row(row, source_turn_seq=sealed.context.source_turn_seq) != sealed:
        raise AssertionError(
            f"continuation source_model_turn_id={row.source_model_turn_id} "
            "was replayed with different sealed facts"
        )


def _assert_model_turn_identity(turn: LLMModelTurn, start: ModelTurnStart) -> None:
    if (turn.id, turn.generation_id, turn.turn_seq, turn.request_fingerprint) != (
        start.model_turn_id,
        start.generation_id,
        start.turn_seq,
        start.request_fingerprint,
    ):
        raise AssertionError(
            f"model_turn_id={start.model_turn_id} was reused with different child facts"
        )


def _sealed_from_row(
    row: LLMModelTurnContinuation, *, source_turn_seq: int
) -> SealedGenerationContinuation:
    return SealedGenerationContinuation(
        context=GenerationContinuationContext(
            generation_id=row.generation_id,
            source_turn_seq=source_turn_seq,
            successor_turn_seq=row.successor_turn_seq,
            target_fingerprint=row.target_fingerprint,
            codec_id=row.codec_id,
            policy_revision=row.policy_revision,
        ),
        envelope_version=row.envelope_version,
        nonce=bytes(row.nonce),
        ciphertext=bytes(row.ciphertext),
    )


def _lock_generation_by_id(db: Session, generation_id: UUID) -> LLMCall:
    identity = db.execute(
        select(LLMCall.owner_kind, LLMCall.owner_id).where(LLMCall.id == generation_id)
    ).one_or_none()
    if identity is None:
        raise AssertionError(f"generation_id={generation_id} is missing")
    lock_generation_owner_in_current_transaction(
        db, LlmCallOwner(kind=cast(LlmCallOwnerKind, identity[0]), id=identity[1])
    )
    call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
    if call is None:
        raise AssertionError(f"generation_id={generation_id} disappeared under owner lock")
    return call


def _lock_owned_generation(db: Session, *, owner: LlmCallOwner, generation_id: UUID) -> LLMCall:
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(
        select(LLMCall)
        .where(
            LLMCall.id == generation_id,
            LLMCall.owner_kind == owner.kind,
            LLMCall.owner_id == owner.id,
        )
        .with_for_update()
    )
    if call is None:
        raise AssertionError(f"generation_id={generation_id} is missing or cross-owner")
    return call


def _lock_model_turn(db: Session, *, generation_id: UUID, model_turn_id: UUID) -> LLMModelTurn:
    turn = db.scalar(
        select(LLMModelTurn)
        .where(LLMModelTurn.id == model_turn_id, LLMModelTurn.generation_id == generation_id)
        .with_for_update()
    )
    if turn is None:
        raise AssertionError(
            f"model_turn_id={model_turn_id} is missing from generation_id={generation_id}"
        )
    return turn


def _generation_record(call: LLMCall) -> GenerationRecord:
    return GenerationRecord(
        id=call.id,
        owner=LlmCallOwner(kind=cast(LlmCallOwnerKind, call.owner_kind), id=call.owner_id),
        generation_seq=call.generation_seq,
        spec=decode_generation_spec_document(call.generation_spec),
        outcome=cast(GenerationOutcome | None, call.outcome),
        failure_code=call.failure_code,
        terminal=cast(dict[str, JsonValue] | None, call.terminal),
        created_at=call.created_at,
        completed_at=call.completed_at,
    )


def _turn_record(turn: LLMModelTurn) -> ModelTurnRecord:
    return ModelTurnRecord(
        id=turn.id,
        generation_id=turn.generation_id,
        turn_seq=turn.turn_seq,
        request_fingerprint=turn.request_fingerprint,
        route_request_identity=cast(dict[str, JsonValue], turn.route_request_identity),
        terminal=cast(dict[str, JsonValue] | None, turn.terminal),
        usage=cast(dict[str, JsonValue] | None, turn.usage),
        billability=cast(dict[str, JsonValue] | None, turn.billability),
        created_at=turn.created_at,
        dispatch_started_at=turn.dispatch_started_at,
        accepted_at=turn.accepted_at,
        completed_at=turn.completed_at,
    )


def _assert_parent_open(call: LLMCall) -> None:
    if call.terminal is not None or call.completed_at is not None:
        _ledger_defect(call, "terminal parent cannot accept another child transition")


def _next_generation_seq(db: Session, owner: LlmCallOwner) -> int:
    return int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(generation_seq), 0) + 1 FROM llm_calls "
                "WHERE owner_kind = :kind AND owner_id = :id"
            ),
            {"kind": owner.kind, "id": owner.id},
        ).scalar_one()
    )


def _nullable(value: Presence[Mapping[str, object]]) -> dict[str, object] | None:
    return dict(value.value) if isinstance(value, Present) else None


def _ledger_defect(call: LLMCall, detail: str) -> Never:
    # justify-defect: this module is the sole writer for trusted generation rows.
    raise AssertionError(f"llm_calls row id={call.id} is corrupt: {detail}")


def _turn_defect(turn: LLMModelTurn, detail: str) -> Never:
    # justify-defect: this module is the sole writer for trusted child rows.
    raise AssertionError(f"llm_model_turns row id={turn.id} is corrupt: {detail}")
