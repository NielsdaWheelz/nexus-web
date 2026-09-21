"""The Chat view below the canonical generation tool-position ledger.

One tool call produces, in the position recorder's own transaction, the
``message_tool_calls`` row, its ``tool_call_start``/``tool_call_done`` and
``tool_result`` events, its ``message_retrievals`` rows, and — for
``web.search`` — one ``resource_external_snapshots`` row per hit. The model's
output is the same result rendered with its numbered citations.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID

from llm_tools import (
    WEB_SEARCH_SPEC,
    PromptAttribute,
    PromptAttributeName,
    PromptJson,
    PromptSection,
    PromptSectionKind,
    PromptSections,
    ToolEffect,
    ToolResult,
    canonical_json_bytes,
    render_prompt,
)
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.schemas.conversation import ChatRunToolResultEventPayload, StoredToolProjection
from nexus.schemas.retrieval import RetrievalResultRef
from nexus.services.chat_run_citations import (
    CitationCandidateNumbering,
    number_tool_citation_candidates,
)
from nexus.services.chat_run_event_store import (
    ChatRunEventEmitter,
    append_run_event,
    lock_chat_run_for_update,
)
from nexus.services.chat_run_tools import (
    RecordKind,
    bind_provider_tool_call_events,
    current_tool_record_identity,
    persist_current_tool_record,
    persist_tool_call_start,
)
from nexus.services.retrieval_citation import RetrievalCitation, insert_retrieval_row
from nexus.services.tool_authority import (
    ToolAuditProjection,
    ToolAuthority,
    ToolAuthorityRefused,
    ToolPositionRecord,
)
from nexus.services.tool_runtime.catalog import (
    WEB_SEARCH_CONTEXT_CHARS,
    WEB_SEARCH_SELECTED_RESULTS,
)
from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

if TYPE_CHECKING:
    from nexus.services.llm_ledger import LlmCallOwner


@dataclass(frozen=True, slots=True)
class ChatToolExecutionProjection:
    """Bind one Chat run and the citation ordinal its assistant message starts at."""

    run_id: UUID
    initial_citation_ordinal: int

    def __post_init__(self) -> None:
        if self.initial_citation_ordinal < 1:
            raise ValueError("Chat citation ordinal must be positive")

    @property
    def scope_label(self) -> str:
        return "conversation_context"

    def lock_owner(self, db: Session, *, user_id: UUID, owner: LlmCallOwner) -> None:
        if owner.kind != "chat_run" or owner.id != self.run_id:
            raise ToolAuthorityRefused("Chat projection differs from generation owner")
        run = lock_chat_run_for_update(db, self.run_id)
        if (
            run is None
            or run.owner_user_id != user_id
            or run.status != "running"
            or run.cancel_requested_at is not None
        ):
            raise ToolAuthorityRefused("Chat projection owner is not live")

    def stage_started(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> None:
        run = self._run(db, authority=authority)
        declaration = CHAT_TOOL_DECLARATIONS_BY_ID[position.canonical_tool_id]
        effect = declaration.spec.effect
        common = {
            **StoredToolProjection(
                record_kind=RecordKind.current_execution.value,
                canonical_tool_id=position.canonical_tool_id,
                provider_wire_name=provider_wire_name,
                effect=effect,
                result_kind=declaration.result_kind,
                activity_label=declaration.activity_label,
                error_type=None,
                canonical_input_sha256=position.canonical_input_digest,
                tool_contract_revision=position.tool_contract_revision,
                binding_policy_revision=position.binding_revision,
            ).model_dump(mode="json"),
            "tool_call_id": None,
            "assistant_message_id": str(run.assistant_message_id),
            "tool_call_index": position.position,
            "provider_tool_call_id": position.transport_call_id,
            # The canonical position is the route-neutral observation order;
            # provider/host sequence remains child transport evidence.
            "provider_event_seq_start": position.position,
            "provider_event_seq_end": position.position,
        }
        append_run_event(db, run, "tool_call_start", common)
        append_run_event(db, run, "tool_call_done", {**common, "input": dict(arguments)})
        tool_call_id = persist_tool_call_start(
            db,
            run=run,
            tool_call_index=position.position,
            tool_position_id=position.id,
            identity=current_tool_record_identity(
                canonical_tool_id=position.canonical_tool_id,
                canonical_input_sha256=position.canonical_input_digest,
                binding_policy_revision=position.binding_revision,
            ),
            provider_wire_name=provider_wire_name,
            scope="assistant_write" if effect is ToolEffect.Write else "conversation_context",
            requested_types=[],
        )
        bind_provider_tool_call_events(
            db,
            run=run,
            tool_call_index=position.position,
            tool_call_id=tool_call_id,
        )

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: ToolAuditProjection,
    ) -> None:
        run = self._run(db, authority=authority)
        declaration = CHAT_TOOL_DECLARATIONS_BY_ID[position.canonical_tool_id]
        provider_wire_name = _provider_wire_name(db, run=run, tool_call_index=position.position)
        if position.canonical_tool_id == "web.search":
            audit = _build_web_search_audit(
                db,
                run=run,
                arguments=_provider_arguments(db, run=run, tool_call_index=position.position),
                result=result,
            )
        is_error = result["type"] == "Failure"
        error_code = str(cast("dict[str, object]", result["error"])["type"]) if is_error else None
        tool_call_id = persist_current_tool_record(
            db,
            conversation_id=run.conversation_id,
            user_message_id=run.user_message_id,
            assistant_message_id=run.assistant_message_id,
            tool_call_index=position.position,
            tool_position_id=position.id,
            identity=current_tool_record_identity(
                canonical_tool_id=position.canonical_tool_id,
                canonical_input_sha256=position.canonical_input_digest,
                binding_policy_revision=position.binding_revision,
            ),
            provider_wire_name=provider_wire_name,
            search_query_fingerprint=audit.search_query_fingerprint,
            scope=audit.scope,
            requested_types=audit.requested_types,
            result_refs=(
                audit.created_refs
                if declaration.spec.effect is ToolEffect.Write
                else [citation.result_ref_json() for citation in audit.citations]
            ),
            selected_context_refs=[citation.context_ref for citation in audit.selected_citations],
            provider_request_ids=audit.provider_request_ids,
            latency_ms=audit.latency_ms,
            status="error" if is_error else "complete",
            error_code=error_code,
            clear_reverted=declaration.spec.effect is ToolEffect.Write,
        )
        for ordinal, citation in enumerate(audit.citations):
            insert_retrieval_row(
                db,
                tool_call_id=tool_call_id,
                ordinal=ordinal,
                citation=citation,
                selected=citation in audit.selected_citations,
                scope=audit.scope,
                retrieval_status="retrieved",
            )
        ChatRunEventEmitter(db, run).tool_result(
            ChatRunToolResultEventPayload(
                record_kind=RecordKind.current_execution.value,
                canonical_tool_id=position.canonical_tool_id,
                provider_wire_name=provider_wire_name,
                effect=declaration.spec.effect,
                result_kind=declaration.result_kind,
                activity_label=declaration.activity_label,
                error_type=error_code,
                canonical_input_sha256=position.canonical_input_digest,
                tool_contract_revision=position.tool_contract_revision,
                binding_policy_revision=position.binding_revision,
                tool_call_id=tool_call_id,
                assistant_message_id=run.assistant_message_id,
                tool_call_index=position.position,
                status="error" if is_error else "complete",
                scope=audit.scope,
                types=audit.requested_types,
                filters=audit.filters,
                error_code=error_code,
                result_count=len(audit.citations),
                selected_count=len(audit.selected_citations),
                latency_ms=audit.latency_ms,
                provider_request_ids=audit.provider_request_ids,
                results=[
                    TypeAdapter(RetrievalResultRef).validate_python(citation.result_ref_json())
                    for citation in audit.citations
                ],
            )
        )
        if not is_error and declaration.spec.effect is ToolEffect.Write:
            from nexus.services.assistant_write_authorship import (
                persist_assistant_write_authorships,
            )

            persist_assistant_write_authorships(
                db,
                viewer_id=authority.user_id,
                tool_call_id=tool_call_id,
                position=position,
                created_refs=audit.created_refs,
            )

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str:
        run = self._run(db, authority=authority)
        tool_call_id = db.execute(
            text(
                """
                SELECT id
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                """
            ),
            {
                "assistant_message_id": run.assistant_message_id,
                "tool_call_index": position.position,
            },
        ).scalar_one()
        numbering = number_tool_citation_candidates(
            db,
            tool_call_id=tool_call_id,
            start_ordinal=self._starting_citation_ordinal(db, run=run, position=position.position),
        )
        return _render_chat_tool_result(result, numbering)

    def live_write_count(self, db: Session, *, authority: ToolAuthority) -> int:
        from nexus.services.chat_run_tools import assistant_write_tool_call_count
        from nexus.services.tool_runtime.catalog import write_tool_ids

        return assistant_write_tool_call_count(
            db,
            assistant_message_id=self._run(db, authority=authority).assistant_message_id,
            canonical_tool_ids=write_tool_ids(),
        )

    def _run(self, db: Session, *, authority: ToolAuthority) -> ChatRun:
        run = lock_chat_run_for_update(db, self.run_id)
        if (
            run is None
            or authority.owner.kind != "chat_run"
            or authority.owner.id != run.id
            or authority.user_id != run.owner_user_id
            or run.status != "running"
            or run.cancel_requested_at is not None
        ):
            raise ToolAuthorityRefused("Chat projection owner is not live")
        return run

    def _starting_citation_ordinal(self, db: Session, *, run: ChatRun, position: int) -> int:
        previous = db.scalar(
            text(
                """
                SELECT max(retrieval.citation_candidate_ordinal)
                FROM message_retrievals AS retrieval
                JOIN message_tool_calls AS tool_call ON tool_call.id = retrieval.tool_call_id
                WHERE tool_call.assistant_message_id = :assistant_message_id
                  AND tool_call.tool_call_index < :tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id, "tool_call_index": position},
        )
        if previous is None:
            return self.initial_citation_ordinal
        if type(previous) is not int or previous < self.initial_citation_ordinal:
            raise AssertionError("Chat citation candidate cursor is malformed")
        return previous + 1


def _provider_wire_name(db: Session, *, run: ChatRun, tool_call_index: int) -> str:
    name = db.execute(
        text(
            """
            SELECT provider_wire_name
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = :tool_call_index
            """
        ),
        {"assistant_message_id": run.assistant_message_id, "tool_call_index": tool_call_index},
    ).scalar_one()
    if not isinstance(name, str) or not name:
        raise AssertionError("Chat tool projection lost its provider wire name")
    return name


def _provider_arguments(db: Session, *, run: ChatRun, tool_call_index: int) -> object:
    """Read the admitted request back from the durable started event.

    Reconciliation has no live handler context by definition, so the event the
    position wrote before dispatch is the only record of what the model sent.
    """

    return db.execute(
        text(
            """
            SELECT payload->'input'
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type = 'tool_call_done'
              AND payload->>'tool_call_index' = :tool_call_index
            ORDER BY seq DESC
            LIMIT 1
            """
        ),
        {"run_id": run.id, "tool_call_index": str(tool_call_index)},
    ).scalar_one_or_none()


def _build_web_search_audit(
    db: Session,
    *,
    run: ChatRun,
    arguments: object,
    result: ToolResult,
) -> ToolAuditProjection:
    """Mint Nexus snapshot identities for one portable web terminal."""

    from nexus.db.models import ResourceExternalSnapshot
    from nexus.ids import new_uuid7
    from nexus.schemas.retrieval import ExternalSnapshotId
    from nexus.services.agent_tools.web_search import web_result_locator_json, web_result_ref_json

    projected_input: dict[str, object] | None = None
    if isinstance(arguments, dict):
        adapter = TypeAdapter(WEB_SEARCH_SPEC.input_type)
        try:
            projected = adapter.dump_python(
                adapter.validate_json(canonical_json_bytes(arguments), strict=True),
                mode="json",
            )
        except ValidationError:
            projected = None
        if isinstance(projected, dict):
            projected_input = cast("dict[str, object]", projected)
    if projected_input is None and result["type"] == "Success":
        raise AssertionError("web.search success lacks its valid provider tool input")
    query = projected_input.get("query") if projected_input is not None else None
    if query is not None and not isinstance(query, str):
        raise AssertionError("web.search projected query is malformed")
    audit = ToolAuditProjection(
        scope="public_web",
        requested_types=["mixed"],
        filters={
            "freshness_days": (
                projected_input.get("freshness_days") if projected_input is not None else None
            ),
            "allowed_domains": [],
            "blocked_domains": [],
        },
        search_query_fingerprint=(
            hashlib.sha256(query.encode("utf-8")).hexdigest() if query is not None else None
        ),
    )
    if result["type"] == "Failure":
        return audit

    value = cast("dict[str, Any]", result["value"])
    raw_hits = value.get("results")
    if not isinstance(raw_hits, list):
        raise AssertionError("web.search success omitted its closed result list")
    selected_indexes = _selected_web_result_indexes(raw_hits)
    for index, raw_hit in enumerate(raw_hits):
        if not isinstance(raw_hit, dict):
            raise AssertionError("web.search success contains a malformed result")
        hit = cast("dict[str, Any]", raw_hit)
        snapshot_id = ExternalSnapshotId(new_uuid7())
        selected = index in selected_indexes
        db.add(
            ResourceExternalSnapshot(
                id=snapshot_id,
                user_id=run.owner_user_id,
                provider=str(hit["provider"]),
                url=str(hit["url"]),
                title=str(hit["title"]),
                snippet=str(hit["snippet"]),
            )
        )
        citation = RetrievalCitation(
            result_type="web_result",
            source_id=str(snapshot_id),
            title=str(hit["title"]),
            source_label=None,
            snippet=str(hit["snippet"]),
            deep_link=str(hit["url"]),
            citation_target=f"external_snapshot:{snapshot_id}",
            citation_label=None,
            locator=web_result_locator_json(hit),
            context_ref={"type": "web_result", "id": str(snapshot_id)},
            evidence_span_id=None,
            media_id=None,
            media_kind=None,
            score=1.0 / max(int(hit["rank"]), 1),
            result_ref=web_result_ref_json(hit, snapshot_id=snapshot_id, selected=selected),
            selected=selected,
        )
        audit.citations.append(citation)
        if selected:
            audit.selected_citations.append(citation)
    # Raw retrieval inserts reference these new snapshot rows; flush the ORM
    # identity owner without committing the caller's atomic terminal boundary.
    db.flush()
    provider_request_id = value.get("provider_request_id")
    if provider_request_id is not None and not isinstance(provider_request_id, str):
        raise AssertionError("web.search provider request id is malformed")
    audit.provider_request_ids = [provider_request_id] if provider_request_id else []
    return audit


def _selected_web_result_indexes(raw_hits: list[object]) -> frozenset[int]:
    """Select prompt citations under the binding's canonical JSON budget."""

    selected: set[int] = set()
    total_chars = 0
    for index, raw_hit in enumerate(raw_hits[:WEB_SEARCH_SELECTED_RESULTS]):
        if not isinstance(raw_hit, dict):
            raise AssertionError("web.search success contains a malformed result")
        block_chars = len(canonical_json_bytes(raw_hit).decode("utf-8"))
        if total_chars + block_chars > WEB_SEARCH_CONTEXT_CHARS:
            break
        selected.add(index)
        total_chars += block_chars
    return frozenset(selected)


def _render_chat_tool_result(result: ToolResult, numbering: CitationCandidateNumbering) -> str:
    citable_rows = tuple(row for row in numbering.rows if row.candidate_ordinal is not None)
    if not citable_rows:
        return canonical_json_bytes(result).decode("utf-8")
    sections = [
        PromptSection(
            kind=PromptSectionKind("payload"),
            attributes=(),
            body=PromptJson(cast(Any, result)),
        )
    ]
    sections.extend(
        PromptSection(
            kind=PromptSectionKind("tool_citation"),
            attributes=(
                PromptAttribute(PromptAttributeName("n"), cast(int, row.candidate_ordinal)),
                PromptAttribute(PromptAttributeName("retrieval_ordinal"), row.retrieval_ordinal),
            ),
            body=PromptJson(cast(Any, row.result_ref)),
        )
        for row in citable_rows
    )
    return render_prompt(
        PromptSection(
            kind=PromptSectionKind("tool_result"),
            attributes=(),
            body=PromptSections(sections),
        )
    )


__all__ = ["ChatToolExecutionProjection"]
