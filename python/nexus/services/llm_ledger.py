"""Sole staged writer and typed reader for the Codex generation ledger.

Ledger writes never commit. The durable owner stages a start beside its
``Uncertain`` checkpoint and stages a terminal beside ``Completed`` in the
same caller-owned transaction.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Never, cast, get_args
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import func, select, text, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import LLMCall
from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationUsage,
    NormalizedFailureCode,
    NormalizedOutcome,
    command_policy,
    normalized_failure,
    normalized_outcome,
    request_fingerprint,
    retained_terminal_error_detail,
)
from nexus.services.generation_intent import TextOutput

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
if set(_OPERATION_OWNER_KINDS) != {*generation_policy.OPERATIONS, "chat"}:
    raise AssertionError("generation ledger owners do not cover the exact operation catalog")

_MAX_ERROR_DETAIL_LENGTH = 1_000
_MAX_RUNTIME_VERSION_LENGTH = 128
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_NORMALIZED_FAILURE_CODES: frozenset[str] = frozenset(get_args(NormalizedFailureCode))


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
    """Replay-stable generation facts staged immediately before dispatch."""

    owner: LlmCallOwner
    command: GenerationCommand
    streaming: bool

    def __post_init__(self) -> None:
        operation = self.command.operation.kind
        expected_owner = _OPERATION_OWNER_KINDS.get(operation)
        if expected_owner is None:
            raise AssertionError(f"generation operation {operation!r} has no ledger owner")
        if self.owner.kind != expected_owner:
            raise ValueError(
                f"generation operation {operation!r} requires owner kind {expected_owner!r}"
            )


@dataclass(frozen=True, slots=True)
class GenerationRecord:
    """Detached typed projection of one ledger row."""

    id: UUID
    owner_kind: LlmCallOwnerKind
    owner_id: UUID
    generation_seq: int
    operation: str
    plan_id: generation_policy.PlanId
    plan_revision: str
    backend: Literal["codex"]
    transport: Literal["sdk"]
    auth_profile: Literal["codex-personal"]
    model_name: str
    reasoning_effort: str
    capability_kind: generation_policy.Capability
    request_fingerprint: str
    output_schema_fingerprint: str
    tool_plan_fingerprint: str | None
    streaming: bool
    session_ref: dict[str, object] | None
    outcome: NormalizedOutcome | None
    error_code: NormalizedFailureCode | None
    error_detail: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    reasoning_tokens: int | None
    cache_read_input_tokens: int | None
    cache_write_input_tokens: int | None
    sdk_version: str | None
    runtime_version: str | None
    latency_ms: int | None
    created_at: datetime
    accepted_at: datetime | None
    completed_at: datetime | None


def lock_generation_owner_in_current_transaction(
    db: Session,
    owner: LlmCallOwner,
) -> None:
    """Take the ledger owner lock before any domain or queue row lock."""

    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"{owner.kind}:{owner.id}"},
    )


def start_generation_in_current_transaction(
    db: Session,
    start: GenerationStart,
) -> UUID:
    """Stage one exact-replay start without committing its transaction."""

    owner = start.owner
    command = start.command
    lock_generation_owner_in_current_transaction(db, owner)
    existing = db.get(LLMCall, command.request_id)
    if existing is not None:
        _validate_persisted_call(existing)
        _assert_start_identity(existing, start)
        return existing.id

    policy = command_policy(command)
    call = LLMCall(
        id=command.request_id,
        owner_kind=owner.kind,
        owner_id=owner.id,
        generation_seq=_next_generation_seq(db, owner),
        operation=command.operation.kind,
        plan_id=policy.plan_id,
        plan_revision=generation_policy.POLICY_REVISION,
        backend="codex",
        transport="sdk",
        auth_profile="codex-personal",
        model_name=policy.model,
        reasoning_effort=policy.effort,
        capability_kind=policy.capability,
        request_fingerprint=request_fingerprint(command),
        output_schema_fingerprint=_output_schema_fingerprint(command),
        tool_plan_fingerprint=_tool_plan_fingerprint(command),
        streaming=start.streaming,
    )
    db.add(call)
    _flush_and_validate_staged_call(db, call)
    return call.id


def complete_generation_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    terminal: GenerationTerminal,
    latency_ms: int,
    accepted_failure_code: Literal["invalid_output"] | None = None,
) -> None:
    """Stage an accepted host terminal without committing its transaction."""

    if accepted_failure_code not in {None, "invalid_output"}:
        raise ValueError(f"unknown accepted failure override {accepted_failure_code!r}")
    if latency_ms < 0:
        raise ValueError("generation latency_ms must not be negative")
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
    if call is None:
        raise AssertionError(f"llm_calls row missing for generation_id={generation_id}")
    _validate_persisted_call(call)
    _assert_owner(call, owner)
    _assert_no_terminal(call)

    if accepted_failure_code is not None:
        if terminal.status != "succeeded":
            raise ValueError("only a successful host terminal can be semantically overridden")
        outcome: NormalizedOutcome = "Failed"
        error_code: NormalizedFailureCode | None = accepted_failure_code
    else:
        outcome = normalized_outcome(terminal)
        error_code = (
            normalized_failure(terminal.failure.kind) if terminal.failure is not None else None
        )
    if outcome == "Failed" and error_code is None:
        raise AssertionError("failed generation terminal has no normalized failure")
    if outcome != "Failed" and error_code is not None:
        raise AssertionError("non-failed generation terminal carries a failure code")

    session_ref = (
        terminal.session_ref.model_dump(mode="json") if terminal.session_ref is not None else None
    )
    if session_ref is not None and (
        session_ref["backend"],
        session_ref["transport"],
        session_ref["profile_key"],
    ) != (call.backend, call.transport, call.auth_profile):
        raise AssertionError("generation terminal session route differs from its start")

    usage = terminal.usage
    call.session_ref = session_ref
    call.outcome = outcome
    call.error_code = error_code
    call.error_detail = (
        "codex generation invalid output"
        if accepted_failure_code is not None
        else retained_terminal_error_detail(terminal)
    )
    call.input_tokens = usage.input_tokens if usage is not None else None
    call.output_tokens = usage.output_tokens if usage is not None else None
    call.total_tokens = usage.total_tokens if usage is not None else None
    call.reasoning_tokens = usage.reasoning_tokens if usage is not None else None
    call.cache_read_input_tokens = usage.cache_read_input_tokens if usage is not None else None
    call.cache_write_input_tokens = usage.cache_write_input_tokens if usage is not None else None
    call.sdk_version = terminal.sdk_version
    call.runtime_version = terminal.runtime_version
    call.latency_ms = latency_ms
    call.accepted_at = datetime.fromisoformat(terminal.accepted_at[:-1] + "+00:00")
    call.completed_at = func.now()
    _flush_and_validate_staged_call(db, call)


def complete_preaccept_failure_if_started_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    error_code: NormalizedFailureCode,
    error_detail: str,
) -> bool:
    """Stage a known pre-accept failure only when dispatch had been armed."""

    if error_code not in _NORMALIZED_FAILURE_CODES:
        raise ValueError(f"unknown normalized pre-accept failure code {error_code!r}")
    retained_detail = _retained_preaccept_detail(error_detail, label="failure detail")
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
    if call is None:
        return False
    _validate_persisted_call(call)
    _assert_owner(call, owner)
    _assert_no_terminal(call)
    call.outcome = "Failed"
    call.error_code = error_code
    call.error_detail = retained_detail
    call.completed_at = func.now()
    _flush_and_validate_staged_call(db, call)
    return True


def cancel_preaccept_generation_if_started_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
    reason: str,
) -> bool:
    """Stage an owner-side cancellation proven to precede host acceptance."""

    retained_reason = _retained_preaccept_detail(reason, label="cancellation reason")
    lock_generation_owner_in_current_transaction(db, owner)
    call = db.scalar(select(LLMCall).where(LLMCall.id == generation_id).with_for_update())
    if call is None:
        return False
    _validate_persisted_call(call)
    _assert_owner(call, owner)
    _assert_no_terminal(call)
    call.outcome = "Cancelled"
    call.error_detail = retained_reason
    call.completed_at = func.now()
    _flush_and_validate_staged_call(db, call)
    return True


def read_generation(
    db: Session,
    *,
    generation_id: UUID,
) -> GenerationRecord | None:
    """Read one detached ledger record through the sole typed accessor."""

    call = db.get(LLMCall, generation_id)
    return None if call is None else _record(call)


def read_latest_generations_for_owners(
    db: Session,
    *,
    owners: Collection[LlmCallOwner],
    outcome: NormalizedOutcome | None = None,
) -> dict[LlmCallOwner, GenerationRecord]:
    """Bulk-read each typed owner's newest matching generation in one query."""

    distinct_owners = tuple(dict.fromkeys(owners))
    if not distinct_owners:
        return {}

    owner_identity = tuple_(LLMCall.owner_kind, LLMCall.owner_id)
    latest_generation_query = select(
        LLMCall.owner_kind.label("owner_kind"),
        LLMCall.owner_id.label("owner_id"),
        func.max(LLMCall.generation_seq).label("generation_seq"),
    ).where(owner_identity.in_([(owner.kind, owner.id) for owner in distinct_owners]))
    if outcome is not None:
        latest_generation_query = latest_generation_query.where(LLMCall.outcome == outcome)
    latest_generations = latest_generation_query.group_by(
        LLMCall.owner_kind, LLMCall.owner_id
    ).subquery()
    calls = db.scalars(
        select(LLMCall).join(
            latest_generations,
            (LLMCall.owner_kind == latest_generations.c.owner_kind)
            & (LLMCall.owner_id == latest_generations.c.owner_id)
            & (LLMCall.generation_seq == latest_generations.c.generation_seq),
        )
    ).all()
    records = [_record(call) for call in calls]
    return {LlmCallOwner(kind=record.owner_kind, id=record.owner_id): record for record in records}


def lock_active_generation_for_authority_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
) -> GenerationRecord | None:
    """Lock one nonterminal owned generation before a tool-authority row lock.

    The owner advisory lock is always first, matching dispatch and terminal
    ordering. A missing, cross-owner, or already-terminal identity is not
    authority and is returned as absent rather than exposed to the caller.
    """

    record = lock_generation_for_authority_in_current_transaction(
        db,
        owner=owner,
        generation_id=generation_id,
    )
    if record is None or record.outcome is not None or record.completed_at is not None:
        return None
    return record


def lock_generation_for_authority_in_current_transaction(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_id: UUID,
) -> GenerationRecord | None:
    """Lock one exact owned generation, including an already-terminal row."""

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
    return None if call is None else _record(call)


def read_latest_generation_for_owner(
    db: Session,
    *,
    owner: LlmCallOwner,
) -> GenerationRecord | None:
    """Read the newest generation for one owner through the typed ledger."""

    call = db.scalar(
        select(LLMCall)
        .where(LLMCall.owner_kind == owner.kind, LLMCall.owner_id == owner.id)
        .order_by(LLMCall.generation_seq.desc())
        .limit(1)
    )
    return None if call is None else _record(call)


def read_generation_for_owner_sequence(
    db: Session,
    *,
    owner: LlmCallOwner,
    generation_seq: int,
) -> GenerationRecord | None:
    """Read one owner-local generation ordinal through the typed ledger."""

    if generation_seq < 1:
        raise ValueError("generation_seq must be positive")
    call = db.scalar(
        select(LLMCall).where(
            LLMCall.owner_kind == owner.kind,
            LLMCall.owner_id == owner.id,
            LLMCall.generation_seq == generation_seq,
        )
    )
    return None if call is None else _record(call)


def current_tool_plan_fingerprint() -> str:
    """Return the ledger representation of the one pinned Chat tool plan."""

    return _digest({"tool_plan_revision": generation_policy.TOOL_PLAN_REVISION})


def _flush_and_validate_staged_call(db: Session, call: LLMCall) -> None:
    """Resolve database-owned facts and validate without committing the caller's work."""

    db.flush()
    _validate_persisted_call(call)


def _validate_persisted_call(call: LLMCall) -> None:
    """Defect unless one trusted row matches the sole writer's exact contract."""

    if call.generation_seq < 1:
        _ledger_defect(call, f"generation_seq={call.generation_seq} is not positive")

    expected_owner = _OPERATION_OWNER_KINDS.get(call.operation)
    if expected_owner is None or call.owner_kind != expected_owner:
        _ledger_defect(
            call,
            f"owner/operation pair {(call.owner_kind, call.operation)!r} is not catalogued",
        )

    if call.plan_revision != generation_policy.POLICY_REVISION:
        _ledger_defect(call, f"plan revision {call.plan_revision!r} is not current")
    policy_facts = (
        call.plan_id,
        call.model_name,
        call.reasoning_effort,
        call.capability_kind,
    )
    if call.operation == "chat":
        allowed_chat_facts = {
            (policy.plan_id, policy.model, policy.effort, policy.capability)
            for policy in (
                generation_policy.chat_policy(profile)
                for profile in generation_policy.CHAT_PROFILES
            )
        }
        if policy_facts not in allowed_chat_facts:
            _ledger_defect(call, f"chat plan facts {policy_facts!r} are not catalogued")
    else:
        try:
            policy = generation_policy.operation_policy(call.operation)
        except ValueError:
            _ledger_defect(call, f"operation {call.operation!r} has no synthesis policy")
        expected_policy_facts = (
            policy.plan_id,
            policy.model,
            policy.effort,
            policy.capability,
        )
        if policy_facts != expected_policy_facts:
            _ledger_defect(
                call,
                f"plan facts {policy_facts!r} differ from {expected_policy_facts!r}",
            )

    route = (call.backend, call.transport, call.auth_profile)
    if route != ("codex", "sdk", "codex-personal"):
        _ledger_defect(call, f"route {route!r} is not Codex Personal")

    if _SHA256_PATTERN.fullmatch(call.request_fingerprint) is None:
        _ledger_defect(call, "request_fingerprint is not lowercase SHA-256")
    if _SHA256_PATTERN.fullmatch(call.output_schema_fingerprint) is None:
        _ledger_defect(call, "output_schema_fingerprint is not lowercase SHA-256")
    if call.operation == "chat":
        if call.output_schema_fingerprint != _chat_output_schema_fingerprint():
            _ledger_defect(call, "Chat output_schema_fingerprint is not the Text contract")
        if call.tool_plan_fingerprint != current_tool_plan_fingerprint():
            _ledger_defect(call, "Chat tool_plan_fingerprint is not the pinned plan")
    elif call.tool_plan_fingerprint is not None:
        _ledger_defect(call, "Synthesis generation carries a tool_plan_fingerprint")

    _validate_session_ref(call)
    _validate_usage(call)
    _validate_lifecycle(call)


def _validate_session_ref(call: LLMCall) -> None:
    if call.session_ref is None:
        return
    try:
        GenerationSessionRef.model_validate(call.session_ref, strict=True)
    except ValidationError as error:
        _ledger_defect(
            call,
            f"session_ref is invalid: {error.errors(include_url=False, include_input=False)!r}",
        )


def _validate_usage(call: LLMCall) -> None:
    usage = {
        "input_tokens": call.input_tokens,
        "output_tokens": call.output_tokens,
        "total_tokens": call.total_tokens,
        "reasoning_tokens": call.reasoning_tokens,
        "cache_read_input_tokens": call.cache_read_input_tokens,
        "cache_write_input_tokens": call.cache_write_input_tokens,
    }
    if all(value is None for value in usage.values()):
        return
    try:
        GenerationUsage.model_validate(usage, strict=True)
    except ValidationError as error:
        _ledger_defect(
            call,
            f"usage is invalid: {error.errors(include_url=False, include_input=False)!r}",
        )


def _validate_lifecycle(call: LLMCall) -> None:
    terminal_facts = (
        call.session_ref,
        call.error_code,
        call.error_detail,
        call.input_tokens,
        call.output_tokens,
        call.total_tokens,
        call.reasoning_tokens,
        call.cache_read_input_tokens,
        call.cache_write_input_tokens,
        call.sdk_version,
        call.runtime_version,
        call.latency_ms,
        call.accepted_at,
        call.completed_at,
    )
    if call.outcome is None:
        if any(value is not None for value in terminal_facts):
            _ledger_defect(call, "nonterminal lifecycle carries terminal facts")
        return

    if call.outcome not in {"Succeeded", "Failed", "Cancelled"}:
        _ledger_defect(call, f"outcome {call.outcome!r} is not normalized")
    if call.completed_at is None:
        _ledger_defect(call, "terminal lifecycle has no completed_at")
    _validate_terminal_error_facts(call)

    if call.accepted_at is None:
        if call.outcome == "Succeeded":
            _ledger_defect(call, "pre-accept lifecycle cannot succeed")
        preaccept_forbidden = (
            call.session_ref,
            call.input_tokens,
            call.output_tokens,
            call.total_tokens,
            call.reasoning_tokens,
            call.cache_read_input_tokens,
            call.cache_write_input_tokens,
            call.sdk_version,
            call.runtime_version,
            call.latency_ms,
        )
        if any(value is not None for value in preaccept_forbidden):
            _ledger_defect(call, "pre-accept lifecycle carries accepted-host facts")
        return

    if not _bounded_version(call.sdk_version):
        _ledger_defect(call, f"sdk_version {call.sdk_version!r} is not bounded")
    if not _bounded_version(call.runtime_version):
        _ledger_defect(call, f"runtime_version {call.runtime_version!r} is not bounded")
    if call.latency_ms is None or call.latency_ms < 0:
        _ledger_defect(call, f"latency_ms {call.latency_ms!r} is invalid")
    if call.outcome == "Succeeded" and call.session_ref is None:
        _ledger_defect(call, "accepted success has no session_ref")


def _validate_terminal_error_facts(call: LLMCall) -> None:
    if call.outcome == "Succeeded":
        if call.error_code is not None or call.error_detail is not None:
            _ledger_defect(call, "successful lifecycle carries failure facts")
        return
    if call.outcome == "Failed":
        if call.error_code not in _NORMALIZED_FAILURE_CODES:
            _ledger_defect(call, f"failure code {call.error_code!r} is not normalized")
    elif call.error_code is not None:
        _ledger_defect(call, "cancelled lifecycle carries a failure code")
    if not _bounded_error_detail(call.error_detail):
        _ledger_defect(call, "terminal error_detail is invalid")


def _bounded_version(value: str | None) -> bool:
    return value is not None and 1 <= len(value) <= _MAX_RUNTIME_VERSION_LENGTH


def _bounded_error_detail(value: str | None) -> bool:
    return value is not None and len(value) <= _MAX_ERROR_DETAIL_LENGTH and bool(value.strip())


def _retained_preaccept_detail(value: str, *, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"pre-accept {label} must be text")
    retained = value[:_MAX_ERROR_DETAIL_LENGTH]
    if not retained.strip():
        raise ValueError(f"pre-accept {label} must not be blank")
    return retained


def _chat_output_schema_fingerprint() -> str:
    return _digest(TextOutput().model_dump(mode="json", by_alias=True))


def _ledger_defect(call: LLMCall, detail: str) -> Never:
    # justify-defect: llm_ledger is the sole writer, so an invalid trusted row is corruption.
    raise AssertionError(f"llm_calls row id={call.id} is corrupt: {detail}")


def _record(call: LLMCall) -> GenerationRecord:
    _validate_persisted_call(call)
    return GenerationRecord(
        id=call.id,
        owner_kind=cast(LlmCallOwnerKind, call.owner_kind),
        owner_id=call.owner_id,
        generation_seq=call.generation_seq,
        operation=call.operation,
        plan_id=cast(generation_policy.PlanId, call.plan_id),
        plan_revision=call.plan_revision,
        backend=cast(Literal["codex"], call.backend),
        transport=cast(Literal["sdk"], call.transport),
        auth_profile=cast(Literal["codex-personal"], call.auth_profile),
        model_name=call.model_name,
        reasoning_effort=call.reasoning_effort,
        capability_kind=cast(generation_policy.Capability, call.capability_kind),
        request_fingerprint=call.request_fingerprint,
        output_schema_fingerprint=call.output_schema_fingerprint,
        tool_plan_fingerprint=call.tool_plan_fingerprint,
        streaming=call.streaming,
        session_ref=dict(call.session_ref) if call.session_ref is not None else None,
        outcome=cast(NormalizedOutcome | None, call.outcome),
        error_code=cast(NormalizedFailureCode | None, call.error_code),
        error_detail=call.error_detail,
        input_tokens=call.input_tokens,
        output_tokens=call.output_tokens,
        total_tokens=call.total_tokens,
        reasoning_tokens=call.reasoning_tokens,
        cache_read_input_tokens=call.cache_read_input_tokens,
        cache_write_input_tokens=call.cache_write_input_tokens,
        sdk_version=call.sdk_version,
        runtime_version=call.runtime_version,
        latency_ms=call.latency_ms,
        created_at=call.created_at,
        accepted_at=call.accepted_at,
        completed_at=call.completed_at,
    )


def _assert_start_identity(call: LLMCall, start: GenerationStart) -> None:
    policy = command_policy(start.command)
    expected = (
        start.owner.kind,
        start.owner.id,
        start.command.operation.kind,
        policy.plan_id,
        generation_policy.POLICY_REVISION,
        "codex",
        "sdk",
        "codex-personal",
        policy.model,
        policy.effort,
        policy.capability,
        request_fingerprint(start.command),
        _output_schema_fingerprint(start.command),
        _tool_plan_fingerprint(start.command),
        start.streaming,
    )
    actual = (
        call.owner_kind,
        call.owner_id,
        call.operation,
        call.plan_id,
        call.plan_revision,
        call.backend,
        call.transport,
        call.auth_profile,
        call.model_name,
        call.reasoning_effort,
        call.capability_kind,
        call.request_fingerprint,
        call.output_schema_fingerprint,
        call.tool_plan_fingerprint,
        call.streaming,
    )
    if actual != expected:
        raise AssertionError(
            f"generation_id={start.command.request_id} was reused with different start facts"
        )


def _assert_owner(call: LLMCall, owner: LlmCallOwner) -> None:
    if (call.owner_kind, call.owner_id) != (owner.kind, owner.id):
        raise AssertionError(f"generation_id={call.id} changed durable owner")


def _assert_no_terminal(call: LLMCall) -> None:
    if call.outcome is not None or call.completed_at is not None:
        raise AssertionError(f"generation_id={call.id} already has terminal outcome={call.outcome}")
    if any(
        value is not None
        for value in (
            call.session_ref,
            call.error_code,
            call.error_detail,
            call.input_tokens,
            call.output_tokens,
            call.total_tokens,
            call.reasoning_tokens,
            call.cache_read_input_tokens,
            call.cache_write_input_tokens,
            call.sdk_version,
            call.runtime_version,
            call.latency_ms,
            call.accepted_at,
        )
    ):
        raise AssertionError(f"generation_id={call.id} has partial terminal facts")


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


def _output_schema_fingerprint(command: GenerationCommand) -> str:
    return _digest(command.intent.output.model_dump(mode="json", by_alias=True))


def _tool_plan_fingerprint(command: GenerationCommand) -> str | None:
    if not isinstance(command.operation, ChatOperation):
        return None
    return current_tool_plan_fingerprint()


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


__all__ = [
    "GenerationRecord",
    "GenerationStart",
    "LlmCallOwner",
    "LlmCallOwnerKind",
    "complete_generation_in_current_transaction",
    "complete_preaccept_failure_if_started_in_current_transaction",
    "cancel_preaccept_generation_if_started_in_current_transaction",
    "current_tool_plan_fingerprint",
    "lock_active_generation_for_authority_in_current_transaction",
    "lock_generation_for_authority_in_current_transaction",
    "lock_generation_owner_in_current_transaction",
    "read_generation",
    "read_generation_for_owner_sequence",
    "read_latest_generations_for_owners",
    "read_latest_generation_for_owner",
    "start_generation_in_current_transaction",
]
