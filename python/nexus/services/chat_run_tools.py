"""Chat-run tool dispatch and output.

Sole owner of the strict ``message_tool_calls`` tagged union, its constructors,
and the provider-tool-event binding. Execution and citation owners supply
already-admitted canonical identity; raw SQL elsewhere may only read rows.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, MessageToolCall
from nexus.schemas.conversation import ChatRunToolResultEventPayload

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class RecordKind(StrEnum):
    current_execution = "current_execution"
    historical_execution = "historical_execution"
    attached_context = "attached_context"


@dataclass(frozen=True, slots=True)
class PersistedToolRecord:
    id: UUID
    assistant_message_id: UUID
    canonical_tool_id: str | None
    record_kind: RecordKind
    provider_wire_name: str | None
    canonical_input_sha256: str | None
    tool_contract_revision: str | None
    binding_policy_revision: str | None
    tool_call_index: int
    scope: str
    status: str
    error_code: str | None


@dataclass(frozen=True, slots=True)
class CurrentToolRecordIdentity:
    canonical_tool_id: str
    canonical_input_sha256: str
    tool_contract_revision: str
    binding_policy_revision: str

    def __post_init__(self) -> None:
        _validate_current_identity(self)


# Frozen counterparts of the migration-owned attestations, keyed by the only
# old-id-free identity that survives the cut. Historical rows are audit-only;
# accepting any other pair would silently grant unreviewed history a decoder.
_HISTORICAL_REVISIONS = {
    "nexus.search": (
        "d1c8f823aef01b881579b71163c0e3071ab3e596efcc2aa45805db3878f465bb",
        "f8731f6eefe1417042bc5df503b37a54c86c5a2d456083b4dafe772cef543c30",
    ),
    "web.search": (
        "aad6364a2e2fe69779ffbf60d398f0859750c2d1e657c9571fd82735182d5d1b",
        "47bb5782180fe4523475c300678b2c6b69da25bce294e5f1826e60874704bd43",
    ),
    "nexus.resource.read": (
        "372fc75f6296f24660f7db2945389a06963636514101564f7135ebfa6578a503",
        "60d7fff8bb08a98d3a5e96ec640171e6866ca977c5504885c538900a88051443",
    ),
    "nexus.resource.inspect": (
        "90834fafb0d24e3de526a551051886a93dcbb5f936f1f024f7c7bcb66961eef0",
        "2715414c17264bd2883f299c328c49070fcc470cfa5d6b5103c8d2459b71625c",
    ),
    "nexus.library.add": (
        "6e9a5c5e2be1f4b173b5c6ee1ab6bd8703334c7c822722157ca2444730cfcdc3",
        "d5f578f326e56b9521b8c365378040e364615c884da0955d950897f7636b0f83",
    ),
    "nexus.note.create": (
        "f7869475114f4f493b935f54901da75be5cdabf8ea06076c474365477178c7e1",
        "f24656bdc18691978ebec7648a38fde17da4367b3e3acfd99b4b942ad3884959",
    ),
    "nexus.highlight.create": (
        "b057eb05eb4905b8d3a3254e57429eee3410b129a44ff42ed687ae8365433c40",
        "7ba9ddd5d08a315a6b8afbe5a7c2f18a906e0916dc20370ab1a0db9315b6d6ee",
    ),
    "nexus.edge.create": (
        "c0d481a523e5d2b82b4d2d29e2b81d6f925bc69dae3fce6c95084da4d8064214",
        "3e0aa318f1b36e2ddfc459844c959aa1013527de02180221eb6fcd689e30c6c9",
    ),
    "nexus.queue.add": (
        "9c15eeb3521da405523f099bc83d2defe7ea6e78ccb1009656d0f77418c3b3c7",
        "7932c98ea936d4f5075c662d764ffa84f59cb6cbf9d5d83cbd9a82dccbbdd68d",
    ),
}


def _digest(value: str | None) -> bool:
    return value is not None and _SHA256.fullmatch(value) is not None


def _current_declaration(canonical_tool_id: str) -> Any:
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

    declaration = CHAT_TOOL_DECLARATIONS_BY_ID.get(canonical_tool_id)
    if declaration is None:
        raise ValueError(f"unknown current tool id: {canonical_tool_id!r}")
    return declaration


def _validate_current_identity(identity: CurrentToolRecordIdentity) -> None:
    declaration = _current_declaration(identity.canonical_tool_id)
    if identity.tool_contract_revision != declaration.spec.tool_contract_revision:
        raise ValueError("current tool identity has the wrong contract revision")
    if not _digest(identity.canonical_input_sha256):
        raise ValueError("current tool identity has an invalid canonical-input digest")
    if not _digest(identity.binding_policy_revision):
        raise ValueError("current tool identity has an invalid binding-policy revision")


def current_tool_record_identity(
    *,
    canonical_tool_id: str,
    canonical_input_sha256: str,
    binding_policy_revision: str,
) -> CurrentToolRecordIdentity:
    """Bind storage identity to the digest already occupied by ToolExecutor."""

    declaration = _current_declaration(canonical_tool_id)
    return CurrentToolRecordIdentity(
        canonical_tool_id=canonical_tool_id,
        canonical_input_sha256=canonical_input_sha256,
        tool_contract_revision=declaration.spec.tool_contract_revision,
        binding_policy_revision=binding_policy_revision,
    )


def decode_persisted_tool_record(row: MessageToolCall) -> PersistedToolRecord:
    try:
        kind = RecordKind(row.record_kind)
    except (TypeError, ValueError) as exc:
        raise AssertionError("invalid persisted tool record: unknown record kind") from exc

    canonical = row.canonical_tool_id
    provider = row.provider_wire_name
    input_digest = row.canonical_input_sha256
    tool_revision = row.tool_contract_revision
    binding_revision = row.binding_policy_revision
    valid = False
    if kind is RecordKind.current_execution:
        try:
            identity = CurrentToolRecordIdentity(
                canonical_tool_id=canonical or "",
                canonical_input_sha256=input_digest or "",
                tool_contract_revision=tool_revision or "",
                binding_policy_revision=binding_revision or "",
            )
        except ValueError:
            valid = False
        else:
            valid = (
                provider in {None, identity.canonical_tool_id}
                and identity.canonical_tool_id == canonical
                and row.tool_call_index >= 1
            )
    elif kind is RecordKind.historical_execution:
        revisions = _HISTORICAL_REVISIONS.get(canonical or "")
        valid = (
            revisions is not None
            and provider is None
            and (input_digest is None or _digest(input_digest))
            and (tool_revision, binding_revision) == revisions
            and row.tool_call_index >= 1
            and row.status in {"complete", "error", "cancelled"}
        )
    elif kind is RecordKind.attached_context:
        valid = (
            canonical is None
            and provider is None
            and input_digest is None
            and tool_revision is None
            and binding_revision is None
            and row.scope == "attached_context"
            and row.tool_call_index == 0
            and row.status == "complete"
            and row.error_code is None
        )
    if not valid:
        raise AssertionError("invalid persisted tool record: tagged fields disagree")
    return PersistedToolRecord(
        id=row.id,
        assistant_message_id=row.assistant_message_id,
        canonical_tool_id=canonical,
        record_kind=kind,
        provider_wire_name=provider,
        canonical_input_sha256=input_digest,
        tool_contract_revision=tool_revision,
        binding_policy_revision=binding_revision,
        tool_call_index=row.tool_call_index,
        scope=row.scope,
        status=row.status,
        error_code=row.error_code,
    )


class _ToolStepModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ToolModelOutput(_ToolStepModel):
    call_id: str = Field(min_length=1)
    output: str
    is_error: bool


class ToolStepResult(_ToolStepModel):
    tool_call_id: UUID
    canonical_tool_id: str = Field(min_length=1, max_length=128)
    record_kind: Literal[RecordKind.current_execution]
    canonical_input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_contract_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    binding_policy_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_call_index: int = Field(ge=1)
    model_output: ToolModelOutput
    next_citation_ordinal: int = Field(ge=1)
    result_event: ChatRunToolResultEventPayload


def _assert_current_position(
    row: Any,
    *,
    identity: CurrentToolRecordIdentity,
    provider_wire_name: str | None,
    tool_position_id: UUID | None,
) -> None:
    if (
        row["canonical_tool_id"] != identity.canonical_tool_id
        or row["record_kind"] != RecordKind.current_execution
        or row["provider_wire_name"] != provider_wire_name
        or row["canonical_input_sha256"] != identity.canonical_input_sha256
        or row["tool_contract_revision"] != identity.tool_contract_revision
        or row["binding_policy_revision"] != identity.binding_policy_revision
        or row["tool_position_id"] != tool_position_id
    ):
        raise AssertionError("occupied tool position changed canonical replay identity")


def persist_current_tool_record(
    db: Session,
    *,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    tool_call_index: int,
    tool_position_id: UUID | None,
    identity: CurrentToolRecordIdentity,
    provider_wire_name: str | None = None,
    search_query_fingerprint: str | None,
    scope: str,
    requested_types: list[str],
    result_refs: list[dict[str, Any]],
    selected_context_refs: list[dict[str, Any]],
    provider_request_ids: list[str],
    latency_ms: int | None,
    status: str,
    error_code: str | None,
    clear_reverted: bool = False,
) -> UUID:
    """Insert or update one current row without changing position identity."""

    if tool_call_index < 1:
        raise ValueError("current tool-call index must be positive")
    _validate_current_identity(identity)
    params = {
        "conversation_id": conversation_id,
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_message_id,
        "tool_call_index": tool_call_index,
        "tool_position_id": tool_position_id,
        "canonical_tool_id": identity.canonical_tool_id,
        "provider_wire_name": provider_wire_name,
        "canonical_input_sha256": identity.canonical_input_sha256,
        "tool_contract_revision": identity.tool_contract_revision,
        "binding_policy_revision": identity.binding_policy_revision,
        "search_query_fingerprint": search_query_fingerprint,
        "scope": scope,
        "requested_types": requested_types,
        "result_refs": result_refs,
        "selected_context_refs": selected_context_refs,
        "provider_request_ids": provider_request_ids,
        "latency_ms": latency_ms,
        "status": status,
        "error_code": error_code,
        "clear_reverted": clear_reverted,
    }
    existing = (
        db.execute(
            text(
                """
                SELECT id, canonical_tool_id, record_kind, provider_wire_name,
                       canonical_input_sha256, tool_contract_revision,
                       binding_policy_revision, tool_position_id
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                FOR UPDATE
                """
            ),
            params,
        )
        .mappings()
        .first()
    )
    if existing is None:
        return db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    canonical_tool_id,
                    record_kind,
                    provider_wire_name,
                    canonical_input_sha256,
                    tool_contract_revision,
                    binding_policy_revision,
                    tool_position_id,
                    tool_call_index,
                    search_query_fingerprint,
                    scope,
                    requested_types,
                    result_refs,
                    selected_context_refs,
                    provider_request_ids,
                    latency_ms,
                    status,
                    error_code
                ) VALUES (
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    :canonical_tool_id,
                    'current_execution',
                    :provider_wire_name,
                    :canonical_input_sha256,
                    :tool_contract_revision,
                    :binding_policy_revision,
                    :tool_position_id,
                    :tool_call_index,
                    :search_query_fingerprint,
                    :scope,
                    :requested_types,
                    :result_refs,
                    :selected_context_refs,
                    :provider_request_ids,
                    :latency_ms,
                    :status,
                    :error_code
                )
                RETURNING id
                """
            ).bindparams(
                bindparam("requested_types", type_=JSONB),
                bindparam("result_refs", type_=JSONB),
                bindparam("selected_context_refs", type_=JSONB),
                bindparam("provider_request_ids", type_=JSONB),
            ),
            params,
        ).scalar_one()

    _assert_current_position(
        existing,
        identity=identity,
        provider_wire_name=provider_wire_name,
        tool_position_id=tool_position_id,
    )
    tool_call_id = existing["id"]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET provider_wire_name = :provider_wire_name,
                search_query_fingerprint = :search_query_fingerprint,
                scope = :scope,
                requested_types = :requested_types,
                result_refs = :result_refs,
                selected_context_refs = :selected_context_refs,
                provider_request_ids = :provider_request_ids,
                latency_ms = :latency_ms,
                status = :status,
                error_code = :error_code,
                reverted_at = CASE WHEN :clear_reverted THEN NULL ELSE reverted_at END,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ).bindparams(
            bindparam("requested_types", type_=JSONB),
            bindparam("result_refs", type_=JSONB),
            bindparam("selected_context_refs", type_=JSONB),
            bindparam("provider_request_ids", type_=JSONB),
        ),
        {**params, "tool_call_id": tool_call_id},
    )
    return tool_call_id


def persist_tool_call_start(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_position_id: UUID | None,
    identity: CurrentToolRecordIdentity,
    provider_wire_name: str | None = None,
    scope: str,
    requested_types: list[str],
) -> UUID:
    tool_call_id = persist_current_tool_record(
        db,
        conversation_id=run.conversation_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        tool_call_index=tool_call_index,
        tool_position_id=tool_position_id,
        identity=identity,
        provider_wire_name=provider_wire_name,
        search_query_fingerprint=None,
        scope=scope,
        requested_types=requested_types,
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[],
        latency_ms=None,
        status="running",
        error_code=None,
    )
    from nexus.services.chat_run_citations import prune_tool_call_retrievals

    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def upsert_attached_context_tool_call(db: Session, *, run: ChatRun) -> UUID:
    existing = (
        db.execute(
            text(
                """
                SELECT id, canonical_tool_id, record_kind, provider_wire_name,
                       canonical_input_sha256, tool_contract_revision,
                       binding_policy_revision, scope, status, error_code
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = 0
                FOR UPDATE
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        )
        .mappings()
        .first()
    )
    expected = (
        None,
        RecordKind.attached_context,
        None,
        None,
        None,
        None,
        "attached_context",
        "complete",
        None,
    )
    if existing is not None:
        observed = tuple(
            existing[key]
            for key in (
                "canonical_tool_id",
                "record_kind",
                "provider_wire_name",
                "canonical_input_sha256",
                "tool_contract_revision",
                "binding_policy_revision",
                "scope",
                "status",
                "error_code",
            )
        )
        if observed != expected:
            raise AssertionError("tool index zero is not the attached-context record")
        return existing["id"]
    return db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id, user_message_id, assistant_message_id,
                canonical_tool_id, record_kind, provider_wire_name,
                canonical_input_sha256, tool_contract_revision,
                binding_policy_revision, tool_call_index, scope,
                requested_types, result_refs, selected_context_refs,
                provider_request_ids, status, error_code
            ) VALUES (
                :conversation_id, :user_message_id, :assistant_message_id,
                NULL, 'attached_context', NULL, NULL, NULL, NULL, 0,
                'attached_context', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '[]'::jsonb, 'complete', NULL
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": run.conversation_id,
            "user_message_id": run.user_message_id,
            "assistant_message_id": run.assistant_message_id,
        },
    ).scalar_one()


def bind_provider_tool_call_events(
    db: Session, *, run: ChatRun, tool_call_index: int, tool_call_id: UUID
) -> None:
    db.execute(
        text(
            """
            UPDATE chat_run_events
            SET payload = jsonb_set(
                payload,
                '{tool_call_id}',
                to_jsonb(CAST(:tool_call_id AS text)),
                true
            )
            WHERE run_id = :run_id
              AND event_type IN ('tool_call_start', 'tool_call_delta', 'tool_call_done')
              AND payload->>'tool_call_index' = :tool_call_index
            """
        ),
        {
            "run_id": run.id,
            "tool_call_index": str(tool_call_index),
            "tool_call_id": str(tool_call_id),
        },
    )


def assistant_write_tool_call_count(
    db: Session, *, assistant_message_id: UUID, canonical_tool_ids: Sequence[str]
) -> int:
    """Committed, non-reverted assistant write tool calls for this message.

    The per-run write cap (amanuensis D-6/AC-9) counts rows WHERE
    ``reverted_at IS NULL`` and ``status = 'complete'`` — so undo reclaims budget.
    """
    return int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND status = 'complete'
                  AND reverted_at IS NULL
                  AND record_kind = 'current_execution'
                  AND canonical_tool_id = ANY(:canonical_tool_ids)
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "canonical_tool_ids": list(canonical_tool_ids),
            },
        ).scalar_one()
    )
