"""The Chat view below the canonical generation tool-position ledger.

One tool call produces, in the position recorder's own transaction, the
``message_tool_calls`` row, then its ``tool_call_start``/``tool_call_done`` and
``tool_result`` events, its ``message_retrievals`` rows, and — for
``web.search`` — one ``resource_external_snapshots`` row per hit. The model's
output is the same result rendered with its numbered citations.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
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
from nexus.schemas.conversation import (
    ChatRunToolCallDoneEventOut,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
)
from nexus.services.chat import events, tool_calls
from nexus.services.chat.citations import Numbered, number_candidates
from nexus.services.chat.retrievals import RetrievalCitation, insert_retrieval
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
    from nexus.services.generation.contract import Owner


@dataclass(frozen=True, slots=True)
class ChatToolExecutionProjection:
    """Bind one Chat run; its citation numbering continues after the answer's last [N]."""

    run_id: UUID

    @property
    def scope_label(self) -> str:
        return "conversation_context"

    def lock_owner(self, db: Session, *, user_id: UUID, owner: Owner) -> None:
        if owner.kind != "chat_run" or owner.id != self.run_id:
            raise ToolAuthorityRefused("Chat projection differs from generation owner")
        run = events.lock_run(db, self.run_id)
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
        tool_call_id = tool_calls.start(
            db,
            run=run,
            index=position.position,
            position_id=position.id,
            canonical_tool_id=position.canonical_tool_id,
            input_sha256=position.canonical_input_digest,
            contract_revision=declaration.spec.tool_contract_revision,
            binding_revision=position.binding_revision,
            wire_name=provider_wire_name,
            scope=(
                "assistant_write"
                if effect is ToolEffect.Write
                else "public_web"
                if position.canonical_tool_id.startswith("web.")
                else "conversation_context"
            ),
        )
        started = ChatRunToolCallStartEventOut(
            record_kind="current_execution",
            canonical_tool_id=position.canonical_tool_id,
            provider_wire_name=provider_wire_name,
            effect=effect,
            result_kind=declaration.result_kind,
            activity_label=declaration.activity_label,
            error_type=None,
            tool_call_id=tool_call_id,
            tool_call_index=position.position,
        )
        events.append(db, run, started)
        done = ChatRunToolCallDoneEventOut(**started.model_dump(), input=dict(arguments))
        events.append(db, run, done)

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: ToolAuditProjection,
    ) -> None:
        run = self._run(db, authority=authority, execution=False)
        declaration = CHAT_TOOL_DECLARATIONS_BY_ID[position.canonical_tool_id]
        if position.canonical_tool_id == "web.search":
            audit = _build_web_search_audit(
                db,
                run=run,
                arguments=_provider_arguments(db, run=run, tool_call_index=position.position),
                result=result,
            )
        is_error = result["type"] == "Failure"
        error_code = str(cast("dict[str, object]", result["error"])["type"]) if is_error else None
        tool_call_id, provider_wire_name = tool_calls.finish(
            db,
            assistant_message_id=run.assistant_message_id,
            index=position.position,
            error_code=error_code,
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
        )
        for ordinal, citation in enumerate(audit.citations):
            insert_retrieval(
                db,
                tool_call_id=tool_call_id,
                ordinal=ordinal,
                citation=citation,
                selected=citation in audit.selected_citations,
                scope=audit.scope,
                retrieval_status="retrieved",
            )
        finished = ChatRunToolResultEventOut(
            record_kind="current_execution",
            canonical_tool_id=position.canonical_tool_id,
            provider_wire_name=provider_wire_name,
            effect=declaration.spec.effect,
            result_kind=declaration.result_kind,
            activity_label=declaration.activity_label,
            error_type=error_code,
            tool_call_id=tool_call_id,
            tool_call_index=position.position,
            status="error" if is_error else "complete",
        )
        events.append(db, run, finished)

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str:
        run = self._run(db, authority=authority, execution=False)
        numbered = number_candidates(
            db, assistant_message_id=run.assistant_message_id, tool_call_index=position.position
        )
        return _render_chat_tool_result(result, numbered)

    def live_write_count(self, db: Session, *, authority: ToolAuthority) -> int:
        from nexus.services.tool_runtime.catalog import write_tool_ids

        return tool_calls.live_write_count(
            db,
            assistant_message_id=self._run(db, authority=authority).assistant_message_id,
            tool_ids=write_tool_ids(),
        )

    def _run(self, db: Session, *, authority: ToolAuthority, execution: bool = True) -> ChatRun:
        run = events.lock_run(db, self.run_id)
        if (
            run is None
            or authority.owner.kind != "chat_run"
            or authority.owner.id != run.id
            or authority.user_id != run.owner_user_id
            or execution
            and (run.status != "running" or run.cancel_requested_at is not None)
        ):
            raise ToolAuthorityRefused("Chat projection owner is not live")
        return run


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


def _render_chat_tool_result(result: ToolResult, numbered: Sequence[Numbered]) -> str:
    citable_rows = tuple(row for row in numbered if row.candidate_ordinal is not None)
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
