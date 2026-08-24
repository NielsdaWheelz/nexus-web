"""Sole durable writer for native-agent turn audit facts.

The product job journal owns replayable inputs and completed results. This
ledger owns only immutable request fingerprints, normalized terminal facts,
opaque native session identity, usage, and executable provenance.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from provider_runtime.agent_runtime import AgentSessionRef, ref_from_json, ref_to_json
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from nexus.db.models import AgentTurn

_MAX_IDENTITY_LENGTH = 200
_MAX_ERROR_CODE_LENGTH = 200
_MAX_ERROR_DETAIL_LENGTH = 1000
_MAX_VERSION_LENGTH = 200
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True, slots=True)
class AgentTurnOwner:
    """Durable product owner of one ordered native-agent turn."""

    kind: Literal["media_enrichment"]
    id: UUID


@dataclass(frozen=True, slots=True)
class AgentTurnStart:
    """Replay-stable immutable facts persisted before native dispatch."""

    id: UUID
    owner: AgentTurnOwner
    operation: Literal["metadata_enrichment"]
    operation_revision: str
    backend: Literal["codex"]
    transport: Literal["sdk"]
    auth_profile: Literal["codex-personal"]
    model_name: str
    requested_reasoning: str
    request_fingerprint: str
    policy_fingerprint: str
    output_schema_fingerprint: str

    def __post_init__(self) -> None:
        # justify-service-invariant-check: spec §7 requires operation_revision,
        # model_name and requested_reasoning to be bounded normalized text, a
        # bound the database deliberately does not enforce (the columns are
        # Text) and that ``str`` cannot express.
        for name, value in (
            ("operation_revision", self.operation_revision),
            ("model_name", self.model_name),
            ("requested_reasoning", self.requested_reasoning),
        ):
            _require_bounded_text(value, name, maximum=_MAX_IDENTITY_LENGTH)
        # justify-service-invariant-check: spec §7 stores request_fingerprint,
        # policy_fingerprint and output_schema_fingerprint as sha256 hashes.
        # "a lowercase 64-character hex digest" is not expressible as a type,
        # and no other layer bounds these three Text columns.
        for name, value in (
            ("request_fingerprint", self.request_fingerprint),
            ("policy_fingerprint", self.policy_fingerprint),
            ("output_schema_fingerprint", self.output_schema_fingerprint),
        ):
            _require_sha256_hex(value, name)


@dataclass(frozen=True, slots=True)
class AgentTurnTerminal:
    """Normalized terminal audit facts returned by the native-agent boundary."""

    outcome: Literal["succeeded", "failed", "cancelled"]
    session_ref: AgentSessionRef | Mapping[str, object] | None
    error_code: str | None
    error_detail: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    reasoning_tokens: int | None
    cache_read_input_tokens: int | None
    cache_write_input_tokens: int | None
    sdk_version: str | None
    runtime_version: str | None

    def __post_init__(self) -> None:
        normalized_ref = _validate_session_ref(self.session_ref)
        object.__setattr__(self, "session_ref", normalized_ref)
        # justify-service-invariant-check: which fields one outcome may carry is
        # a cross-field rule this flat audit record cannot express in its types.
        if self.outcome == "succeeded":
            if normalized_ref is None:
                raise ValueError("succeeded AgentTurnTerminal requires session_ref")
            if self.error_code is not None or self.error_detail is not None:
                raise ValueError("succeeded AgentTurnTerminal cannot carry an error")
        elif self.outcome == "failed":
            _require_bounded_text(
                self.error_code,
                "error_code",
                maximum=_MAX_ERROR_CODE_LENGTH,
            )
            _require_text(self.error_detail, "error_detail")
        elif self.error_code is not None or self.error_detail is not None:
            raise ValueError("cancelled AgentTurnTerminal cannot carry an error")

        # justify-service-invariant-check: all-or-nothing usage is a cross-field
        # rule not expressible in the per-field types.
        core_usage = (self.input_tokens, self.output_tokens, self.total_tokens)
        if any(value is None for value in core_usage) and any(
            value is not None
            for value in (
                *core_usage,
                self.reasoning_tokens,
                self.cache_read_input_tokens,
                self.cache_write_input_tokens,
            )
        ):
            raise ValueError("AgentTurnTerminal usage must be wholly absent or have core totals")
        # justify-service-invariant-check: version presence depends on whether
        # the turn was accepted, a cross-field rule not expressible in types.
        versions = (self.sdk_version, self.runtime_version)
        if any(value is None for value in versions):
            if not (
                all(value is None for value in versions)
                and self.outcome == "failed"
                and normalized_ref is None
                and all(
                    value is None
                    for value in (
                        self.input_tokens,
                        self.output_tokens,
                        self.total_tokens,
                        self.reasoning_tokens,
                        self.cache_read_input_tokens,
                        self.cache_write_input_tokens,
                    )
                )
            ):
                raise ValueError(
                    "missing runtime versions are valid only for a pre-accept failed terminal"
                )
        else:
            _require_bounded_text(
                self.sdk_version,
                "sdk_version",
                maximum=_MAX_VERSION_LENGTH,
            )
            _require_bounded_text(
                self.runtime_version,
                "runtime_version",
                maximum=_MAX_VERSION_LENGTH,
            )


def lock_turn_owner_in_current_transaction(db: Session, owner: AgentTurnOwner) -> None:
    """Take this owner's ledger lock for the rest of the caller's transaction.

    Lock-ordering rule: every transaction that will take this advisory owner
    lock takes it FIRST, before any media row or queue row lock. Without one
    designed order the dispatch transaction (media -> jobs, then the ledger)
    and the terminal checkpoint (ledger, then its job row) are an AB-BA
    inversion. Callers reaching the ledger only through
    ``start_turn_in_current_transaction`` or
    ``complete_turn_in_current_transaction`` still call this at the top of the
    transaction whenever they lock rows before those calls;
    ``pg_advisory_xact_lock`` is reentrant, so the inner acquisition is free.
    """
    _lock_owner(db, owner_kind=owner.kind, owner_id=owner.id)


def start_turn_in_current_transaction(db: Session, start: AgentTurnStart) -> UUID:
    """Stage one start in the caller's lease-fenced dispatch transaction.

    The row becomes durable only when the caller's Uncertain checkpoint
    commits, so an incomplete ledger row can exist only if native dispatch was
    actually armed. An exact replay is the only idempotent reuse.
    """
    _lock_owner(db, owner_kind=start.owner.kind, owner_id=start.owner.id)
    existing = db.get(AgentTurn, start.id)
    if existing is not None:
        _assert_start_identity(existing, start)
        return start.id

    db.add(
        AgentTurn(
            id=start.id,
            owner_kind=start.owner.kind,
            owner_id=start.owner.id,
            turn_seq=_next_turn_seq(db, owner=start.owner),
            operation=start.operation,
            operation_revision=start.operation_revision,
            backend=start.backend,
            transport=start.transport,
            auth_profile=start.auth_profile,
            model_name=start.model_name,
            requested_reasoning=start.requested_reasoning,
            request_fingerprint=start.request_fingerprint,
            policy_fingerprint=start.policy_fingerprint,
            output_schema_fingerprint=start.output_schema_fingerprint,
        )
    )
    return start.id


def complete_turn_in_current_transaction(
    db: Session,
    turn_id: UUID,
    terminal: AgentTurnTerminal,
) -> None:
    """Stage one terminal in the caller's job-checkpoint transaction."""
    if not complete_turn_if_started_in_current_transaction(db, turn_id, terminal):
        # justify-defect: the caller must durably start before checkpoint/dispatch.
        raise AssertionError(f"agent_turns row missing for turn_id={turn_id}")


def complete_turn_if_started_in_current_transaction(
    db: Session,
    turn_id: UUID,
    terminal: AgentTurnTerminal,
) -> bool:
    """Stage a terminal when a replay-stable turn was previously started.

    Prepared work may have no ledger row when dispatch was never armed, while a
    Prepared retry after a typed pre-accept refusal reuses an incomplete row.
    The owner calls this only after taking the ledger advisory lock first, then
    its media and queue locks in canonical order. Returning ``False`` preserves
    the honest no-turn case instead of fabricating dispatch provenance.
    """
    turn = db.get(AgentTurn, turn_id)
    if turn is None:
        return False
    # Lock-ordering rule (see lock_turn_owner_in_current_transaction): the
    # advisory owner lock comes FIRST, before the job row this checkpoint's
    # lease-fenced payload update locks. The lookup above is an unlocked read.
    _lock_owner(db, owner_kind=turn.owner_kind, owner_id=turn.owner_id)
    db.refresh(turn)
    if turn.outcome is not None or turn.completed_at is not None:
        # justify-defect: one accepted native turn has exactly one terminal.
        raise AssertionError(f"turn_id={turn_id} already has terminal outcome={turn.outcome}")
    if any(
        value is not None
        for value in (
            turn.session_ref,
            turn.error_code,
            turn.error_detail,
            turn.input_tokens,
            turn.output_tokens,
            turn.total_tokens,
            turn.reasoning_tokens,
            turn.cache_read_input_tokens,
            turn.cache_write_input_tokens,
            turn.sdk_version,
            turn.runtime_version,
        )
    ):
        # justify-defect: terminal facts may not be partially persisted.
        raise AssertionError(f"turn_id={turn_id} has an incomplete terminal lifecycle")

    session_ref = _session_ref_json(terminal.session_ref)
    if session_ref is not None and (
        session_ref["backend"],
        session_ref["transport"],
        session_ref["profile_key"],
    ) != (turn.backend, turn.transport, turn.auth_profile):
        # justify-defect: a terminal cannot change the route of its started session.
        raise AssertionError(f"turn_id={turn_id} terminal session route does not match start")

    turn.session_ref = session_ref
    turn.outcome = terminal.outcome
    turn.error_code = terminal.error_code
    turn.error_detail = (
        terminal.error_detail[:_MAX_ERROR_DETAIL_LENGTH]
        if terminal.error_detail is not None
        else None
    )
    turn.input_tokens = terminal.input_tokens
    turn.output_tokens = terminal.output_tokens
    turn.total_tokens = terminal.total_tokens
    turn.reasoning_tokens = terminal.reasoning_tokens
    turn.cache_read_input_tokens = terminal.cache_read_input_tokens
    turn.cache_write_input_tokens = terminal.cache_write_input_tokens
    turn.sdk_version = terminal.sdk_version
    turn.runtime_version = terminal.runtime_version
    turn.completed_at = func.now()
    return True


def _assert_start_identity(turn: AgentTurn, start: AgentTurnStart) -> None:
    actual = (
        turn.owner_kind,
        turn.owner_id,
        turn.operation,
        turn.operation_revision,
        turn.backend,
        turn.transport,
        turn.auth_profile,
        turn.model_name,
        turn.requested_reasoning,
        turn.request_fingerprint,
        turn.policy_fingerprint,
        turn.output_schema_fingerprint,
    )
    expected = (
        start.owner.kind,
        start.owner.id,
        start.operation,
        start.operation_revision,
        start.backend,
        start.transport,
        start.auth_profile,
        start.model_name,
        start.requested_reasoning,
        start.request_fingerprint,
        start.policy_fingerprint,
        start.output_schema_fingerprint,
    )
    if actual != expected:
        # justify-defect: one replay-stable id cannot identify two native turns.
        raise AssertionError(f"turn_id={start.id} was reused with different immutable start facts")


def _next_turn_seq(db: Session, *, owner: AgentTurnOwner) -> int:
    return int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(turn_seq), 0) + 1 FROM agent_turns "
                "WHERE owner_kind = :kind AND owner_id = :id"
            ),
            {"kind": owner.kind, "id": owner.id},
        ).scalar_one()
    )


def _lock_owner(db: Session, *, owner_kind: str, owner_id: UUID) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:owner_key, 0))"),
        {"owner_key": f"{owner_kind}:{owner_id}"},
    )


def _validate_session_ref(
    value: AgentSessionRef | Mapping[str, object] | None,
) -> AgentSessionRef | None:
    if value is None:
        return None
    if isinstance(value, AgentSessionRef):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("AgentTurnTerminal.session_ref must be AgentSessionRef or a mapping")
    return ref_from_json(value)


def _session_ref_json(
    value: AgentSessionRef | Mapping[str, object] | None,
) -> dict[str, object] | None:
    validated = _validate_session_ref(value)
    return dict(ref_to_json(validated)) if validated is not None else None


def _require_bounded_text(value: object, name: str, *, maximum: int) -> None:
    text_value = _require_text(value, name)
    if len(text_value) > maximum:
        raise ValueError(f"{name} exceeds {maximum} characters")


def _require_sha256_hex(value: object, name: str) -> None:
    text_value = _require_text(value, name)
    if _SHA256_HEX.fullmatch(text_value) is None:
        raise ValueError(f"{name} must be a lowercase sha256 hex digest")


def _require_text(value: object, name: str) -> str:
    if type(value) is not str or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value
