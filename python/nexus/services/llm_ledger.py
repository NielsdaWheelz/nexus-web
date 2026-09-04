"""Route-neutral parent/child generation ledger and replay fences.

Every helper stages work in its caller-owned transaction and never commits.
External model/tool I/O must happen only after the corresponding uncertain
dispatch fact has committed.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Never, Protocol, cast
from uuid import UUID

from sqlalchemy import delete, func, select, text, tuple_
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.db.models import (
    LLMCall,
    LLMModelTurn,
    LLMModelTurnContinuation,
)
from nexus.schemas.presence import Absent, Presence, Present
from nexus.services.generation_continuations import (
    GenerationContinuationCipher,
    GenerationContinuationContext,
    SealedGenerationContinuation,
)

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type LlmCallOwnerKind = Literal[
    "chat_run",
    "oracle_reading",
    "artifact_build",
    "artifact_learn_request",
    "media_summary",
    "synapse_scan",
    "dawn_write",
    "media_enrichment",
]
type GenerationOutcome = Literal["Succeeded", "Failed", "Cancelled"]

_OPERATION_OWNER_KINDS: dict[str, LlmCallOwnerKind] = {
    "metadata_enrichment": "media_enrichment",
    "media_summary": "media_summary",
    "synapse": "synapse_scan",
    "dawn_write": "dawn_write",
    "oracle": "oracle_reading",
    "dossier_page": "artifact_build",
    "dossier_note": "artifact_build",
    "dossier_media": "artifact_build",
    "dossier_conversation": "artifact_build",
    "dossier_library": "artifact_build",
    "dossier_podcast": "artifact_build",
    "dossier_contributor": "artifact_build",
    "dossier_idea": "artifact_build",
    "dossier_idea_resolve": "artifact_learn_request",
    "chat": "chat_run",
}
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_GENERATION_SPEC_SCHEMA_VERSION = "nexus-generation-spec.v1"
_GENERATION_SPEC_KEYS = frozenset(
    {
        "schema_version",
        "operation",
        "selection",
        "selection_source",
        "resolved_dispatch_target",
        "source_catalog_definition_revision",
        "source_row_fingerprint",
        "agent_definition_revision",
        "source_context_window",
        "source_max_output_tokens",
        "effective_context_budget_tokens",
        "effective_output_budget_tokens",
        "bounds",
        "prompt_template_revision",
        "prompt_payload_ref",
        "instructions_digest",
        "input_digest",
        "output_contract",
        "output_contract_fingerprint",
        "display_at_dispatch",
        "host_tool_plan_snapshot",
        "host_evidence_revision",
        "model_tool_plan_snapshot",
        "tool_effect_mode",
        "admitted_tool_scope",
        "admitted_tool_scope_digest",
        "catalog_definition_revision",
        "policy_revision",
        "backend_contract_revision",
        "provider_registry_revision",
        "fingerprint",
    }
)
_PRESENCE_SPEC_KEYS = (
    "agent_definition_revision",
    "source_context_window",
    "source_max_output_tokens",
    "host_tool_plan_snapshot",
    "host_evidence_revision",
    "model_tool_plan_snapshot",
    "tool_effect_mode",
    "admitted_tool_scope",
    "admitted_tool_scope_digest",
    "provider_registry_revision",
)
_MODEL_TOOL_SPEC_KEYS = (
    "model_tool_plan_snapshot",
    "tool_effect_mode",
    "admitted_tool_scope",
    "admitted_tool_scope_digest",
)


class GenerationSpecLike(Protocol):
    """Dependency-light boundary implemented by the semantic GenerationSpec."""

    def model_dump(self, *, mode: Literal["json"], by_alias: bool) -> dict[str, object]: ...


@dataclass(frozen=True, slots=True)
class GenerationSpecDocument:
    """Canonical, validated persistence document for one frozen generation."""

    value: dict[str, JsonValue]
    fingerprint: str
    operation: str
    route: Literal["CodexPersonal", "ProviderApi"]


@dataclass(frozen=True, slots=True)
class LlmCallOwner:
    """Durable owner of one ordered logical generation."""

    kind: LlmCallOwnerKind
    id: UUID

    def __post_init__(self) -> None:
        if self.kind not in _OPERATION_OWNER_KINDS.values():
            raise ValueError(f"unknown generation owner kind {self.kind!r}")


@dataclass(frozen=True, slots=True)
class GenerationStart:
    """Replay-stable parent facts staged with owning durable work."""

    generation_id: UUID
    owner: LlmCallOwner
    spec: GenerationSpecDocument

    def __post_init__(self) -> None:
        expected_owner = _OPERATION_OWNER_KINDS.get(self.spec.operation)
        if expected_owner is None:
            raise ValueError(f"unknown generation operation {self.spec.operation!r}")
        if expected_owner != self.owner.kind:
            raise ValueError(
                f"generation operation {self.spec.operation!r} requires "
                f"owner kind {expected_owner!r}"
            )


@dataclass(frozen=True, slots=True)
class GenerationRecord:
    """Detached typed parent projection."""

    id: UUID
    owner: LlmCallOwner
    generation_seq: int
    spec: GenerationSpecDocument
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
        _require_sha256(self.request_fingerprint, label="model turn request fingerprint")
        _freeze_json_object(self.route_request_identity, label="route request identity")


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
        terminal = _freeze_json_object(self.terminal, label="model turn terminal")
        if terminal.get("kind") not in {"Succeeded", "Failed", "Cancelled"}:
            raise ValueError("model turn terminal kind is not closed")
        _presence_json_object(self.usage, label="model turn usage")
        _presence_json_object(self.billability, label="model turn billability")
        if not isinstance(self.accepted_at, (Absent, Present)):
            raise TypeError("accepted_at must use Presence")
        if isinstance(self.accepted_at, Present) and not isinstance(
            self.accepted_at.value, datetime
        ):
            raise TypeError("accepted_at Present value must be datetime")
        if isinstance(self.accepted_at, Present) and self.accepted_at.value.utcoffset() is None:
            raise ValueError("accepted_at Present value must be timezone-aware")
        if not isinstance(self.successor, (Absent, Present)):
            raise TypeError("successor must use Presence")
        if isinstance(self.successor, Present) and not isinstance(
            self.successor.value, SealedGenerationContinuation
        ):
            raise TypeError("successor Present value must be sealed")


@dataclass(frozen=True, slots=True)
class DispatchableModelTurn:
    """A prepared child whose provider continuation may be dispatched once."""

    kind: Literal["Dispatchable"] = "Dispatchable"
    turn: ModelTurnRecord = field(kw_only=True)
    canonical_continuation: bytes = field(kw_only=True, repr=False)


@dataclass(frozen=True, slots=True)
class RedispatchForbiddenModelTurn:
    """An uncertain/terminal child for which automatic redispatch is forbidden."""

    kind: Literal["RedispatchForbidden"] = "RedispatchForbidden"
    turn: ModelTurnRecord = field(kw_only=True)


type ContinuationResume = DispatchableModelTurn | RedispatchForbiddenModelTurn


@dataclass(frozen=True, slots=True)
class PendingGenerationContinuation:
    """One terminal child whose sealed successor is safe to resume."""

    source_turn: ModelTurnRecord
    context: GenerationContinuationContext
    canonical_continuation: bytes = field(repr=False)


def generation_spec_document(
    spec: GenerationSpecLike | Mapping[str, object],
) -> GenerationSpecDocument:
    """Validate and freeze the semantic GenerationSpec at its DB adapter."""

    raw = (
        spec.model_dump(mode="json", by_alias=True) if not isinstance(spec, Mapping) else dict(spec)
    )
    value = _freeze_json_object(raw, label="GenerationSpec")
    if set(value) != _GENERATION_SPEC_KEYS:
        missing = sorted(_GENERATION_SPEC_KEYS - set(value))
        extra = sorted(set(value) - _GENERATION_SPEC_KEYS)
        raise ValueError(f"GenerationSpec keys differ; missing={missing!r} extra={extra!r}")
    if value["schema_version"] != _GENERATION_SPEC_SCHEMA_VERSION:
        raise ValueError("GenerationSpec schema_version is unsupported")

    operation = _bounded_text(value["operation"], label="GenerationSpec operation")
    selection = _require_object(value["selection"], label="GenerationSpec selection")
    route = selection.get("route")
    if route not in {"CodexPersonal", "ProviderApi"}:
        raise ValueError("GenerationSpec selection route is not closed")
    selection_source = value["selection_source"]
    if selection_source not in {"ChatRun", "BackgroundPolicy"}:
        raise ValueError("GenerationSpec selection_source is not closed")
    if (operation == "chat") != (selection_source == "ChatRun"):
        raise ValueError("GenerationSpec operation and selection_source disagree")

    for key in _PRESENCE_SPEC_KEYS:
        _presence_document(value[key], label=f"GenerationSpec {key}")
    tool_presence = {
        cast(str, cast(dict[str, JsonValue], value[key])["kind"]) for key in _MODEL_TOOL_SPEC_KEYS
    }
    if len(tool_presence) != 1:
        raise ValueError("GenerationSpec model-tool fields must be wholly Absent or Present")
    if route == "CodexPersonal":
        if cast(dict[str, JsonValue], value["agent_definition_revision"])["kind"] != "Present":
            raise ValueError("CodexPersonal GenerationSpec lacks Agent definition revision")
        if cast(dict[str, JsonValue], value["provider_registry_revision"])["kind"] != "Absent":
            raise ValueError("CodexPersonal GenerationSpec carries provider registry state")
    else:
        if cast(dict[str, JsonValue], value["agent_definition_revision"])["kind"] != "Absent":
            raise ValueError("ProviderApi GenerationSpec carries Agent definition state")
        if cast(dict[str, JsonValue], value["provider_registry_revision"])["kind"] != "Present":
            raise ValueError("ProviderApi GenerationSpec lacks provider registry revision")

    for key in ("effective_context_budget_tokens", "effective_output_budget_tokens"):
        _positive_int(value[key], label=f"GenerationSpec {key}")
    for key in (
        "source_row_fingerprint",
        "instructions_digest",
        "input_digest",
        "output_contract_fingerprint",
        "catalog_definition_revision",
    ):
        _require_sha256(value[key], label=f"GenerationSpec {key}")
    for key in (
        "resolved_dispatch_target",
        "bounds",
        "prompt_payload_ref",
        "output_contract",
        "display_at_dispatch",
    ):
        _require_object(value[key], label=f"GenerationSpec {key}")
    for key in (
        "source_catalog_definition_revision",
        "prompt_template_revision",
        "policy_revision",
        "backend_contract_revision",
    ):
        _bounded_text(value[key], label=f"GenerationSpec {key}")

    fingerprint = cast(str, value["fingerprint"])
    _require_sha256(fingerprint, label="GenerationSpec fingerprint")
    fingerprinted = dict(value)
    del fingerprinted["fingerprint"]
    expected = _digest(fingerprinted)
    if fingerprint != expected:
        raise ValueError(
            f"GenerationSpec fingerprint differs from canonical content: {fingerprint!r}"
        )
    return GenerationSpecDocument(
        value=value,
        fingerprint=fingerprint,
        operation=operation,
        route=cast(Literal["CodexPersonal", "ProviderApi"], route),
    )


def lock_generation_owner_in_current_transaction(
    db: Session,
    owner: LlmCallOwner,
) -> None:
    """Take the stable owner lock before every generation/child/tool row lock."""

    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"{owner.kind}:{owner.id}"},
    )


def start_generation_in_current_transaction(db: Session, start: GenerationStart) -> UUID:
    """Stage exactly one parent generation without reading mutable policy."""

    lock_generation_owner_in_current_transaction(db, start.owner)
    existing = db.get(LLMCall, start.generation_id)
    if existing is not None:
        _assert_generation_start_identity(existing, start)
        return existing.id
    call = LLMCall(
        id=start.generation_id,
        owner_kind=start.owner.kind,
        owner_id=start.owner.id,
        generation_seq=_next_generation_seq(db, start.owner),
        generation_spec=start.spec.value,
        generation_fingerprint=start.spec.fingerprint,
    )
    db.add(call)
    db.flush()
    _validate_call(call)
    return call.id


def complete_generation_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    terminal: Mapping[str, object],
) -> None:
    """Stage one parent terminal after its final child has committed."""

    terminal_document = _freeze_json_object(terminal, label="generation terminal")
    outcome = terminal_document.get("kind")
    if outcome not in {"Succeeded", "Failed", "Cancelled"}:
        raise ValueError("generation terminal kind is not closed")
    failure_code = terminal_document.get("failure_code")
    if outcome == "Failed":
        _bounded_text(failure_code, label="generation failure_code")
    elif failure_code is not None:
        raise ValueError("nonfailed generation terminal carries failure_code")

    call = _lock_owned_generation(db, owner=owner, generation_id=generation_id)
    if call.terminal is not None:
        if call.terminal != terminal_document:
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
    pending_successor = db.scalar(
        select(LLMModelTurnContinuation.id)
        .where(LLMModelTurnContinuation.generation_id == generation_id)
        .limit(1)
    )
    if pending_successor is not None:
        _ledger_defect(call, "parent terminal precedes its sealed successor continuation")
    call.outcome = cast(GenerationOutcome, outcome)
    call.failure_code = cast(str | None, failure_code)
    call.terminal = cast(dict[str, object], terminal_document)
    call.completed_at = func.now()
    db.flush()
    _validate_call(call)


def start_model_turn_in_current_transaction(db: Session, start: ModelTurnStart) -> UUID:
    """Allocate the initial child under the locked parent sequence fence."""

    if start.turn_seq != 1:
        raise ValueError(
            "only the initial model child may start directly; "
            "successors require sealed continuation resume"
        )

    call = _lock_generation_by_id(db, start.generation_id)
    _assert_parent_open(call)
    turn = _start_model_turn_under_parent_lock(db, call=call, start=start)
    return turn.id


def arm_model_turn_dispatch_in_current_transaction(
    db: Session,
    *,
    generation_id: UUID,
    model_turn_id: UUID,
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
    db: Session,
    *,
    generation_id: UUID,
    model_turn_id: UUID,
    completion: ModelTurnCompletion,
) -> None:
    """Atomically commit child terminal facts and its sealed successor."""

    call = _lock_generation_by_id(db, generation_id)
    _assert_parent_open(call)
    turn = _lock_model_turn(db, generation_id=generation_id, model_turn_id=model_turn_id)
    terminal = _freeze_json_object(completion.terminal, label="model turn terminal")
    usage = _nullable_json_object(completion.usage, label="model turn usage")
    billability = _nullable_json_object(completion.billability, label="model turn billability")
    accepted_at = (
        completion.accepted_at.value if isinstance(completion.accepted_at, Present) else None
    )

    if turn.dispatch_started_at is None:
        _turn_defect(turn, "terminal turn was never armed before provider I/O")
    if turn.terminal is not None:
        expected = (terminal, usage, billability, accepted_at)
        actual = (turn.terminal, turn.usage, turn.billability, turn.accepted_at)
        if actual != expected:
            _turn_defect(turn, "terminal replay differs from committed child terminal")
        _assert_successor_identity(db, turn=turn, successor=completion.successor)
        return

    turn.terminal = cast(dict[str, object], terminal)
    turn.usage = cast(dict[str, object] | None, usage)
    turn.billability = cast(dict[str, object] | None, billability)
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
    _validate_turn(turn)


def resume_generation_continuation_in_current_transaction(
    db: Session,
    *,
    source_model_turn_id: UUID,
    successor: ModelTurnStart,
    expected_context: GenerationContinuationContext,
    cipher: GenerationContinuationCipher,
) -> ContinuationResume:
    """Idempotently materialize one successor child from sealed state."""

    call = _lock_generation_by_id(db, successor.generation_id)
    _assert_parent_open(call)
    source = _lock_model_turn(
        db,
        generation_id=successor.generation_id,
        model_turn_id=source_model_turn_id,
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
        consumed_turn = db.scalar(
            select(LLMModelTurn).where(
                LLMModelTurn.generation_id == successor.generation_id,
                LLMModelTurn.turn_seq == successor.turn_seq,
            )
        )
        if consumed_turn is None:
            _turn_defect(source, "terminal source child has no successor continuation")
        _assert_model_turn_start_identity(consumed_turn, successor)
        if consumed_turn.dispatch_started_at is None and consumed_turn.terminal is None:
            _turn_defect(
                consumed_turn,
                "prepared successor lost its continuation before dispatch",
            )
        return RedispatchForbiddenModelTurn(turn=_turn_record(consumed_turn))
    if successor.turn_seq != continuation.successor_turn_seq:
        _turn_defect(source, "successor child sequence differs from sealed continuation")

    sealed = _sealed_from_row(continuation, source_turn_seq=source.turn_seq)
    if sealed.context != expected_context:
        cipher.open(sealed=sealed, expected_context=expected_context)

    existing = db.scalar(
        select(LLMModelTurn).where(
            LLMModelTurn.generation_id == successor.generation_id,
            LLMModelTurn.turn_seq == successor.turn_seq,
        )
    )
    plaintext = cipher.open(sealed=sealed, expected_context=expected_context)
    turn = (
        _start_model_turn_under_parent_lock(db, call=call, start=successor)
        if existing is None
        else existing
    )
    _assert_model_turn_start_identity(turn, successor)
    record = _turn_record(turn)
    if turn.dispatch_started_at is not None or turn.terminal is not None:
        return RedispatchForbiddenModelTurn(turn=record)
    return DispatchableModelTurn(turn=record, canonical_continuation=plaintext)


def open_generation_continuation_in_current_transaction(
    db: Session,
    *,
    source_model_turn_id: UUID,
    expected_context: GenerationContinuationContext,
    cipher: GenerationContinuationCipher,
) -> bytes:
    """Authenticate one sealed successor without consuming or preparing it.

    The provider adapter needs the canonical continuation to derive the exact
    successor request before that request can be durably armed.  Opening is
    intentionally read-only: a crash after this transaction may safely reopen
    the same envelope, while consumption remains atomic with successor arming.
    """

    call = _lock_generation_by_id(db, expected_context.generation_id)
    _assert_parent_open(call)
    source = _lock_model_turn(
        db,
        generation_id=expected_context.generation_id,
        model_turn_id=source_model_turn_id,
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
    sealed = _sealed_from_row(continuation, source_turn_seq=source.turn_seq)
    return cipher.open(sealed=sealed, expected_context=expected_context)


def read_pending_generation_continuation_in_current_transaction(
    db: Session,
    *,
    generation_id: UUID,
    cipher: GenerationContinuationCipher,
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
        db,
        generation_id=generation_id,
        model_turn_id=row.source_model_turn_id,
    )
    if source.terminal is None or source.completed_at is None:
        _turn_defect(source, "pending continuation belongs to a nonterminal source child")
    sealed = _sealed_from_row(row, source_turn_seq=source.turn_seq)
    plaintext = cipher.open(sealed=sealed, expected_context=sealed.context)
    return PendingGenerationContinuation(
        source_turn=_turn_record(source),
        context=sealed.context,
        canonical_continuation=plaintext,
    )


def arm_resumed_model_turn_dispatch_in_current_transaction(
    db: Session,
    *,
    source_model_turn_id: UUID,
    successor: ModelTurnStart,
    expected_context: GenerationContinuationContext,
    cipher: GenerationContinuationCipher,
) -> ModelTurnRecord:
    """Prepare, arm, and consume one successor under the parent fence.

    This is the sole destructive continuation transition.  The encrypted
    envelope remains present while callers derive the successor request, then
    disappears in the same transaction that records dispatch uncertainty.
    Consequently a crash is always classified as either reopenable or already
    armed; it can never authorize an automatic duplicate provider call.
    """

    resumed = resume_generation_continuation_in_current_transaction(
        db,
        source_model_turn_id=source_model_turn_id,
        successor=successor,
        expected_context=expected_context,
        cipher=cipher,
    )
    if isinstance(resumed, RedispatchForbiddenModelTurn):
        raise AssertionError(
            f"llm_model_turns row id={resumed.turn.id} is corrupt: "
            "successor model turn was already armed"
        )
    if resumed.canonical_continuation != open_generation_continuation_in_current_transaction(
        db,
        source_model_turn_id=source_model_turn_id,
        expected_context=expected_context,
        cipher=cipher,
    ):
        raise AssertionError(
            f"llm_model_turns row id={resumed.turn.id} is corrupt: "
            "successor continuation changed while arming"
        )
    arm_model_turn_dispatch_in_current_transaction(
        db,
        generation_id=successor.generation_id,
        model_turn_id=successor.model_turn_id,
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
            f"llm_model_turns row id={resumed.turn.id} is corrupt: "
            "successor continuation was not consumed exactly once"
        )
    db.flush()
    return resumed.turn


def read_generation(db: Session, *, generation_id: UUID) -> GenerationRecord | None:
    call = db.get(LLMCall, generation_id)
    return None if call is None else _generation_record(call)


def read_model_turns(
    db: Session,
    *,
    generation_id: UUID,
) -> tuple[ModelTurnRecord, ...]:
    turns = db.scalars(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id == generation_id)
        .order_by(LLMModelTurn.turn_seq)
    ).all()
    return tuple(_turn_record(turn) for turn in turns)


def read_model_turns_for_generations(
    db: Session,
    *,
    generation_ids: Collection[UUID],
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
    db: Session,
    *,
    owners: Collection[LlmCallOwner],
    outcome: GenerationOutcome | None = None,
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
    db: Session,
    *,
    owner: LlmCallOwner,
) -> GenerationRecord | None:
    call = db.scalar(
        select(LLMCall)
        .where(LLMCall.owner_kind == owner.kind, LLMCall.owner_id == owner.id)
        .order_by(LLMCall.generation_seq.desc())
        .limit(1)
    )
    return None if call is None else _generation_record(call)


def read_generation_for_owner_sequence(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_seq: int,
) -> GenerationRecord | None:
    if generation_seq < 1:
        raise ValueError("generation_seq must be positive")
    call = db.scalar(
        select(LLMCall).where(
            LLMCall.owner_kind == owner.kind,
            LLMCall.owner_id == owner.id,
            LLMCall.generation_seq == generation_seq,
        )
    )
    return None if call is None else _generation_record(call)


def lock_generation_for_authority_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
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
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
) -> GenerationRecord | None:
    record = lock_generation_for_authority_in_current_transaction(
        db, owner=owner, generation_id=generation_id
    )
    return None if record is None or record.outcome is not None else record


def reset_generation_after_proven_non_dispatch_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    generation_fingerprint: str,
) -> None:
    """Remove only an externally proven, never-dispatched open attempt.

    The journal transition back to Prepared is committed by the caller in the
    same transaction. This operator-only repair is deliberately unavailable to
    automatic replay and refuses any terminal child or continuation evidence.
    """

    _require_sha256(generation_fingerprint, label="generation fingerprint")
    call = _lock_owned_generation(db, owner=owner, generation_id=generation_id)
    _assert_parent_open(call)
    if call.generation_fingerprint != generation_fingerprint:
        _ledger_defect(call, "proven non-dispatch fingerprint drifted")
    turns = db.scalars(
        select(LLMModelTurn)
        .where(LLMModelTurn.generation_id == generation_id)
        .order_by(LLMModelTurn.turn_seq)
        .with_for_update()
    ).all()
    if not turns:
        _ledger_defect(call, "proven non-dispatch has no prepared model child")
    if any(turn.terminal is not None or turn.completed_at is not None for turn in turns):
        _ledger_defect(call, "proven non-dispatch has terminal model evidence")
    continuation = db.scalar(
        select(LLMModelTurnContinuation.id)
        .where(LLMModelTurnContinuation.generation_id == generation_id)
        .limit(1)
    )
    if continuation is not None:
        _ledger_defect(call, "proven non-dispatch has a successor continuation")
    db.execute(delete(LLMModelTurn).where(LLMModelTurn.generation_id == generation_id))
    db.delete(call)
    db.flush()


def _start_model_turn_under_parent_lock(
    db: Session,
    *,
    call: LLMCall,
    start: ModelTurnStart,
) -> LLMModelTurn:
    existing_by_id = db.get(LLMModelTurn, start.model_turn_id)
    if existing_by_id is not None:
        _assert_model_turn_start_identity(existing_by_id, start)
        return existing_by_id
    existing_by_seq = db.scalar(
        select(LLMModelTurn).where(
            LLMModelTurn.generation_id == start.generation_id,
            LLMModelTurn.turn_seq == start.turn_seq,
        )
    )
    if existing_by_seq is not None:
        _assert_model_turn_start_identity(existing_by_seq, start)
        return existing_by_seq
    next_seq_value = db.scalar(
        select(func.coalesce(func.max(LLMModelTurn.turn_seq), 0) + 1).where(
            LLMModelTurn.generation_id == call.id
        )
    )
    if next_seq_value is None:
        _ledger_defect(call, "model turn sequence query returned no scalar")
    next_seq = int(next_seq_value)
    if start.turn_seq != next_seq:
        raise ValueError(
            f"model turn sequence must be the next parent position {next_seq}, got {start.turn_seq}"
        )
    turn = LLMModelTurn(
        id=start.model_turn_id,
        generation_id=start.generation_id,
        turn_seq=start.turn_seq,
        request_fingerprint=start.request_fingerprint,
        route_request_identity=_freeze_json_object(
            start.route_request_identity, label="route request identity"
        ),
    )
    db.add(turn)
    db.flush()
    _validate_turn(turn)
    return turn


def _stage_successor_continuation(
    db: Session,
    *,
    turn: LLMModelTurn,
    sealed: SealedGenerationContinuation,
) -> None:
    context = sealed.context
    _assert_successor_context_identity(turn, context)
    existing = db.scalar(
        select(LLMModelTurnContinuation).where(
            LLMModelTurnContinuation.source_model_turn_id == turn.id
        )
    )
    if existing is not None:
        _assert_continuation_row(existing, sealed)
        return
    continuation = LLMModelTurnContinuation(
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
    db.add(continuation)


def _assert_successor_identity(
    db: Session,
    *,
    turn: LLMModelTurn,
    successor: Presence[SealedGenerationContinuation],
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
        if existing is not None:
            _turn_defect(turn, "terminal replay omitted its committed successor")
        if consumed is not None:
            _turn_defect(turn, "terminal replay omitted its consumed successor")
        return
    _assert_successor_context_identity(turn, successor.value.context)
    if existing is None:
        if consumed is not None:
            return
        _turn_defect(turn, "terminal replay added a successor after commit")
    _assert_continuation_row(existing, successor.value)


def _assert_successor_context_identity(
    turn: LLMModelTurn,
    context: GenerationContinuationContext,
) -> None:
    if (
        context.generation_id,
        context.source_turn_seq,
        context.successor_turn_seq,
    ) != (turn.generation_id, turn.turn_seq, turn.turn_seq + 1):
        _turn_defect(turn, "successor continuation identity differs from source child")


def _assert_continuation_row(
    row: LLMModelTurnContinuation,
    sealed: SealedGenerationContinuation,
) -> None:
    context = sealed.context
    actual = (
        row.generation_id,
        row.successor_turn_seq,
        row.target_fingerprint,
        row.codec_id,
        row.policy_revision,
        row.envelope_version,
        row.nonce,
        row.ciphertext,
    )
    expected = (
        context.generation_id,
        context.successor_turn_seq,
        context.target_fingerprint,
        context.codec_id,
        context.policy_revision,
        sealed.envelope_version,
        sealed.nonce,
        sealed.ciphertext,
    )
    if actual != expected:
        raise AssertionError(
            f"continuation source_model_turn_id={row.source_model_turn_id} "
            "was replayed with different sealed facts"
        )


def _sealed_from_row(
    row: LLMModelTurnContinuation,
    *,
    source_turn_seq: int,
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
    owner = LlmCallOwner(kind=cast(LlmCallOwnerKind, identity[0]), id=identity[1])
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
    if call is None:
        raise AssertionError(f"generation_id={generation_id} disappeared under owner lock")
    _validate_call(call)
    return call


def _lock_owned_generation(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
) -> LLMCall:
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
    _validate_call(call)
    return call


def _lock_model_turn(
    db: Session,
    *,
    generation_id: UUID,
    model_turn_id: UUID,
) -> LLMModelTurn:
    turn = db.scalar(
        select(LLMModelTurn)
        .where(
            LLMModelTurn.id == model_turn_id,
            LLMModelTurn.generation_id == generation_id,
        )
        .with_for_update()
    )
    if turn is None:
        raise AssertionError(
            f"model_turn_id={model_turn_id} is missing from generation_id={generation_id}"
        )
    _validate_turn(turn)
    return turn


def _validate_call(call: LLMCall) -> None:
    if call.generation_seq < 1:
        _ledger_defect(call, "generation_seq is not positive")
    spec = generation_spec_document(call.generation_spec)
    if call.generation_fingerprint != spec.fingerprint:
        _ledger_defect(call, "generation_fingerprint differs from GenerationSpec")
    expected_owner = _OPERATION_OWNER_KINDS.get(spec.operation)
    if expected_owner != call.owner_kind:
        _ledger_defect(call, "owner and GenerationSpec operation disagree")
    if call.terminal is None:
        if (
            call.outcome is not None
            or call.failure_code is not None
            or call.completed_at is not None
        ):
            _ledger_defect(call, "nonterminal parent carries terminal facts")
        return
    terminal = _freeze_json_object(call.terminal, label="generation terminal")
    if terminal.get("kind") != call.outcome or call.completed_at is None:
        _ledger_defect(call, "parent terminal projection is inconsistent")
    if call.outcome == "Failed":
        if terminal.get("failure_code") != call.failure_code:
            _ledger_defect(call, "parent failure projection is inconsistent")
    elif call.failure_code is not None:
        _ledger_defect(call, "nonfailed parent carries failure_code")


def _validate_turn(turn: LLMModelTurn) -> None:
    if turn.turn_seq < 1:
        _turn_defect(turn, "turn_seq is not positive")
    _require_sha256(turn.request_fingerprint, label="model turn request fingerprint")
    _freeze_json_object(turn.route_request_identity, label="route request identity")
    terminal_facts = (
        turn.terminal,
        turn.usage,
        turn.billability,
        turn.accepted_at,
        turn.completed_at,
    )
    if turn.terminal is None:
        if any(value is not None for value in terminal_facts[1:]):
            _turn_defect(turn, "nonterminal child carries terminal facts")
        return
    if turn.dispatch_started_at is None or turn.completed_at is None:
        _turn_defect(turn, "terminal child was not armed and completed")
    terminal = _freeze_json_object(turn.terminal, label="model turn terminal")
    if terminal.get("kind") not in {"Succeeded", "Failed", "Cancelled"}:
        _turn_defect(turn, "terminal kind is not closed")
    if turn.usage is not None:
        _freeze_json_object(turn.usage, label="model turn usage")
    if turn.billability is not None:
        _freeze_json_object(turn.billability, label="model turn billability")


def _generation_record(call: LLMCall) -> GenerationRecord:
    _validate_call(call)
    return GenerationRecord(
        id=call.id,
        owner=LlmCallOwner(kind=cast(LlmCallOwnerKind, call.owner_kind), id=call.owner_id),
        generation_seq=call.generation_seq,
        spec=generation_spec_document(call.generation_spec),
        outcome=cast(GenerationOutcome | None, call.outcome),
        failure_code=call.failure_code,
        terminal=(
            _freeze_json_object(call.terminal, label="generation terminal")
            if call.terminal is not None
            else None
        ),
        created_at=call.created_at,
        completed_at=call.completed_at,
    )


def _turn_record(turn: LLMModelTurn) -> ModelTurnRecord:
    _validate_turn(turn)
    return ModelTurnRecord(
        id=turn.id,
        generation_id=turn.generation_id,
        turn_seq=turn.turn_seq,
        request_fingerprint=turn.request_fingerprint,
        route_request_identity=_freeze_json_object(
            turn.route_request_identity, label="route request identity"
        ),
        terminal=(
            _freeze_json_object(turn.terminal, label="model turn terminal")
            if turn.terminal is not None
            else None
        ),
        usage=(
            _freeze_json_object(turn.usage, label="model turn usage")
            if turn.usage is not None
            else None
        ),
        billability=(
            _freeze_json_object(turn.billability, label="model turn billability")
            if turn.billability is not None
            else None
        ),
        created_at=turn.created_at,
        dispatch_started_at=turn.dispatch_started_at,
        accepted_at=turn.accepted_at,
        completed_at=turn.completed_at,
    )


def _assert_generation_start_identity(call: LLMCall, start: GenerationStart) -> None:
    _validate_call(call)
    actual = (
        call.owner_kind,
        call.owner_id,
        call.generation_spec,
        call.generation_fingerprint,
    )
    expected = (
        start.owner.kind,
        start.owner.id,
        start.spec.value,
        start.spec.fingerprint,
    )
    if actual != expected:
        raise AssertionError(
            f"generation_id={start.generation_id} was reused with different parent facts"
        )


def _assert_model_turn_start_identity(turn: LLMModelTurn, start: ModelTurnStart) -> None:
    _validate_turn(turn)
    actual = (
        turn.id,
        turn.generation_id,
        turn.turn_seq,
        turn.request_fingerprint,
        turn.route_request_identity,
    )
    expected = (
        start.model_turn_id,
        start.generation_id,
        start.turn_seq,
        start.request_fingerprint,
        _freeze_json_object(start.route_request_identity, label="route request identity"),
    )
    if actual != expected:
        raise AssertionError(
            f"model_turn_id={start.model_turn_id} was reused with different child facts"
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


def _presence_json_object(
    value: Presence[Mapping[str, object]],
    *,
    label: str,
) -> None:
    if not isinstance(value, (Absent, Present)):
        raise TypeError(f"{label} must use Presence")
    if isinstance(value, Present):
        _freeze_json_object(value.value, label=label)


def _nullable_json_object(
    value: Presence[Mapping[str, object]],
    *,
    label: str,
) -> dict[str, JsonValue] | None:
    _presence_json_object(value, label=label)
    return _freeze_json_object(value.value, label=label) if isinstance(value, Present) else None


def _presence_document(value: JsonValue, *, label: str) -> None:
    document = _require_object(value, label=label)
    kind = document.get("kind")
    if kind == "Absent":
        if set(document) != {"kind"}:
            raise ValueError(f"{label} Absent has extra fields")
        return
    if kind == "Present":
        if set(document) != {"kind", "value"}:
            raise ValueError(f"{label} Present shape is invalid")
        return
    raise ValueError(f"{label} is not Presence")


def _freeze_json_object(value: Mapping[str, object], *, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{label} must be an object")
    try:
        encoded = json.dumps(
            dict(value),
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        decoded = json.loads(encoded)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not canonical JSON") from error
    if not isinstance(decoded, dict) or any(not isinstance(key, str) for key in decoded):
        raise ValueError(f"{label} must be a string-keyed JSON object")
    return cast(dict[str, JsonValue], decoded)


def _require_object(value: JsonValue, *, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _bounded_text(value: object, *, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError(f"{label} must be bounded nonblank text")
    return value


def _positive_int(value: object, *, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _require_sha256(value: object, *, label: str) -> str:
    if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} must be lowercase SHA-256")
    return value


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _ledger_defect(call: LLMCall, detail: str) -> Never:
    # justify-defect: this module is the sole writer for trusted generation rows.
    raise AssertionError(f"llm_calls row id={call.id} is corrupt: {detail}")


def _turn_defect(turn: LLMModelTurn, detail: str) -> Never:
    # justify-defect: this module is the sole writer for trusted child rows.
    raise AssertionError(f"llm_model_turns row id={turn.id} is corrupt: {detail}")


__all__ = [
    "ContinuationResume",
    "DispatchableModelTurn",
    "GenerationOutcome",
    "GenerationRecord",
    "GenerationSpecDocument",
    "GenerationSpecLike",
    "GenerationStart",
    "LlmCallOwner",
    "LlmCallOwnerKind",
    "ModelTurnCompletion",
    "ModelTurnRecord",
    "ModelTurnStart",
    "PendingGenerationContinuation",
    "RedispatchForbiddenModelTurn",
    "arm_model_turn_dispatch_in_current_transaction",
    "complete_generation_in_current_transaction",
    "complete_model_turn_in_current_transaction",
    "generation_spec_document",
    "lock_active_generation_for_authority_in_current_transaction",
    "lock_generation_for_authority_in_current_transaction",
    "lock_generation_owner_in_current_transaction",
    "open_generation_continuation_in_current_transaction",
    "read_generation",
    "read_generation_for_owner_sequence",
    "read_latest_generation_for_owner",
    "read_latest_generations_for_owners",
    "read_model_turns",
    "read_model_turns_for_generations",
    "read_pending_generation_continuation_in_current_transaction",
    "reset_generation_after_proven_non_dispatch_in_current_transaction",
    "arm_resumed_model_turn_dispatch_in_current_transaction",
    "resume_generation_continuation_in_current_transaction",
    "start_generation_in_current_transaction",
    "start_model_turn_in_current_transaction",
]
