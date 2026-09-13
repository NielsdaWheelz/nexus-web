"""Chat citation candidate numbering, canonicalization, and final publication."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import NotFoundError
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.resource_graph import cleanup as graph_cleanup
from nexus.services.resource_graph.citations import (
    GeneratedMarkdownCitationMarker,
    build_citation_outs,
    parse_generated_markdown_citation_markers,
    replace_citations_for_output,
)
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    admits_resource_for_conversation_read,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.retrieval_citation import (
    RetrievalCitation,
    citation_from_search_result,
    insert_retrieval_row,
)
from nexus.services.search import get_search_result

CitationPublicationWarningCode = Literal["CitationsUnavailable"]


@dataclass(frozen=True, slots=True)
class NumberedCitationCandidate:
    retrieval_id: UUID
    retrieval_ordinal: int
    candidate_ordinal: int | None


@dataclass(frozen=True, slots=True)
class CitationCandidateNumbering:
    rows: tuple[NumberedCitationCandidate, ...]
    next_ordinal: int


@dataclass(frozen=True, slots=True)
class CitationCandidate:
    candidate_ordinal: int
    retrieval_id: UUID
    target: ResourceRef
    snapshot: CitationSnapshot


@dataclass(frozen=True, slots=True)
class CanonicalCitation:
    candidate_ordinal: int
    final_ordinal: int


@dataclass(frozen=True, slots=True)
class PublishedCitations:
    kind: Literal["Published"]
    content_md: str
    citations: tuple[CanonicalCitation, ...]

    @property
    def citation_count(self) -> int:
        return len(self.citations)


@dataclass(frozen=True, slots=True)
class DegradedCitations:
    kind: Literal["Degraded"]
    content_md: str
    warning_code: CitationPublicationWarningCode
    detail: str

    @property
    def citation_count(self) -> int:
        return 0


CanonicalCitationResult = PublishedCitations | DegradedCitations


def number_tool_citation_candidates(
    db: Session,
    *,
    tool_call_id: UUID | None,
    start_ordinal: int,
) -> CitationCandidateNumbering:
    """Assign model-facing ordinals to selected citable rows; write no edges."""
    # justify-service-invariant-check: the next turn-global ordinal crosses
    # persisted retrieval rows and provider output, while its API type is int.
    if start_ordinal < 1:
        raise AssertionError(f"citation candidate ordinals must be positive; got {start_ordinal}")
    if tool_call_id is None:
        return CitationCandidateNumbering(rows=(), next_ordinal=start_ordinal)

    rows = (
        db.execute(
            text(
                """
                SELECT id, ordinal, result_ref, citation_candidate_ordinal
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                ORDER BY ordinal
                """
            ),
            {"tool_call_id": tool_call_id},
        )
        .mappings()
        .all()
    )
    numbered: list[NumberedCitationCandidate] = []
    next_ordinal = start_ordinal
    for row in rows:
        candidate_ordinal = next_ordinal if _citation_target_ref(dict(row)) is not None else None
        if candidate_ordinal is not None:
            next_ordinal += 1
        existing_ordinal = row["citation_candidate_ordinal"]
        # justify-service-invariant-check: candidate immutability spans the
        # persisted row and this numbering pass and cannot live in either type.
        if existing_ordinal is not None and existing_ordinal != candidate_ordinal:
            raise AssertionError(
                f"retrieval {row['id']} citation candidate ordinal changed "
                f"from {existing_ordinal} to {candidate_ordinal}"
            )
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET citation_candidate_ordinal = :candidate_ordinal,
                    included_in_prompt = true
                WHERE id = :retrieval_id
                """
            ),
            {
                "retrieval_id": row["id"],
                "candidate_ordinal": candidate_ordinal,
            },
        )
        numbered.append(
            NumberedCitationCandidate(
                retrieval_id=row["id"],
                retrieval_ordinal=row["ordinal"],
                candidate_ordinal=candidate_ordinal,
            )
        )
    return CitationCandidateNumbering(rows=tuple(numbered), next_ordinal=next_ordinal)


def canonicalize_chat_citations(
    generated_markdown: str,
    candidates: Sequence[CitationCandidate],
) -> CanonicalCitationResult:
    """Accept generated candidate markers into canonical reader citation syntax."""
    candidate_ordinals = [candidate.candidate_ordinal for candidate in candidates]
    # justify-service-invariant-check: density and uniqueness are properties of
    # the complete persisted candidate set, not one CitationCandidate value.
    if sorted(candidate_ordinals) != list(range(1, len(candidate_ordinals) + 1)):
        raise AssertionError(
            f"chat citation candidate ordinals must be dense and unique; got {candidate_ordinals}"
        )

    markers = parse_generated_markdown_citation_markers(generated_markdown)
    known_ordinals = set(candidate_ordinals)
    linked_ordinals = sorted({marker.ordinal for marker in markers if marker.linked})
    unknown_ordinals = sorted(
        {marker.ordinal for marker in markers if marker.ordinal not in known_ordinals}
    )
    if linked_ordinals or unknown_ordinals:
        details = []
        if linked_ordinals:
            details.append(f"linked_markers={linked_ordinals}")
        if unknown_ordinals:
            details.append(f"unknown_markers={unknown_ordinals}")
        return DegradedCitations(
            kind="Degraded",
            content_md=_rewrite_markers(generated_markdown, markers, {}),
            warning_code="CitationsUnavailable",
            detail=", ".join(details),
        )

    final_ordinal_by_candidate: dict[int, int] = {}
    for marker in markers:
        final_ordinal_by_candidate.setdefault(
            marker.ordinal,
            len(final_ordinal_by_candidate) + 1,
        )
    return PublishedCitations(
        kind="Published",
        content_md=_rewrite_markers(
            generated_markdown,
            markers,
            final_ordinal_by_candidate,
        ),
        citations=tuple(
            CanonicalCitation(
                candidate_ordinal=candidate_ordinal,
                final_ordinal=final_ordinal,
            )
            for candidate_ordinal, final_ordinal in final_ordinal_by_candidate.items()
        ),
    )


def _rewrite_markers(
    content_md: str,
    markers: Sequence[GeneratedMarkdownCitationMarker],
    final_ordinal_by_candidate: Mapping[int, int],
) -> str:
    chunks: list[str] = []
    cursor = 0
    for marker in markers:
        chunks.append(content_md[cursor : marker.start])
        if final_ordinal_by_candidate:
            chunks.append(f"[{final_ordinal_by_candidate[marker.ordinal]}]")
        cursor = marker.end
    chunks.append(content_md[cursor:])
    return "".join(chunks)


def _citation_target_ref(row: Mapping[str, Any]) -> ResourceRef | None:
    """Return the search-owned citable target stored on a retrieval row."""
    # justify-service-invariant-check: result_ref is validated on write but is
    # read back from mutable JSONB and must still satisfy that stored contract.
    result_ref = row["result_ref"]
    if not isinstance(result_ref, Mapping):
        raise AssertionError("message_retrievals.result_ref must be an object")
    raw_target = result_ref.get("citation_target")
    if raw_target is None:
        return None
    if not isinstance(raw_target, str):
        raise AssertionError("message_retrievals.result_ref.citation_target must be a string")
    target = parse_resource_ref(raw_target)
    if isinstance(target, ResourceRefParseFailure):
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is invalid: {raw_target!r}"
        )
    if resource_citation_result_type(target) is None:
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is not citable: {raw_target}"
        )
    return target


def persist_attached_citations(
    db: Session,
    run: ChatRun,
    citations: tuple[RetrievalCitation, ...],
) -> CitationCandidateNumbering:
    """Persist attached evidence candidates and return the next turn ordinal."""
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :assistant_message_id "
            "AND tool_call_index = 0 FOR UPDATE"
        ),
        {"assistant_message_id": run.assistant_message_id},
    ).first()
    if not citations:
        if existing is not None:
            tool_call_id = existing[0]
            prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
            db.execute(
                text("DELETE FROM message_tool_calls WHERE id = :tool_call_id"),
                {"tool_call_id": tool_call_id},
            )
        return CitationCandidateNumbering(rows=(), next_ordinal=1)

    tool_call_id = (
        existing[0]
        if existing is not None
        else db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id, user_message_id, assistant_message_id, tool_name,
                    tool_call_index, scope, requested_types, result_refs,
                    selected_context_refs, provider_request_ids, status
                )
                VALUES (
                    :conversation_id, :user_message_id, :assistant_message_id,
                    'attached_resources', 0, 'attached_context', '[]'::jsonb,
                    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'complete'
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
    )
    for ordinal, citation in enumerate(citations):
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=citation,
            selected=True,
            scope="attached_context",
            retrieval_status="attached_context",
            included_in_prompt=True,
        )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id, min_ordinal=len(citations))
    return number_tool_citation_candidates(
        db,
        tool_call_id=tool_call_id,
        start_ordinal=1,
    )


def prune_tool_call_retrievals(
    db: Session,
    *,
    tool_call_id: UUID,
    min_ordinal: int | None = None,
) -> None:
    """Delete pre-publication retrieval telemetry and orphaned web snapshots."""
    ordinal_clause = "" if min_ordinal is None else " AND ordinal >= :min_ordinal"
    params: dict[str, Any] = {"tool_call_id": tool_call_id}
    if min_ordinal is not None:
        params["min_ordinal"] = min_ordinal
    web_snapshot_ids = [
        snapshot_id
        for snapshot_id in (
            _uuid_or_none(source_id)
            for source_id in db.execute(
                text(
                    "SELECT source_id FROM message_retrievals "
                    f"WHERE tool_call_id = :tool_call_id{ordinal_clause} "
                    "AND result_type = 'web_result'"
                ),
                params,
            ).scalars()
        )
        if snapshot_id is not None
    ]
    db.execute(
        text(f"DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id{ordinal_clause}"),
        params,
    )
    graph_cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=web_snapshot_ids)


def persist_read_evidence_candidate(
    db: Session,
    *,
    run: ChatRun,
    tool_call_id: UUID,
    result: Any,
    start_ordinal: int,
) -> CitationCandidateNumbering | None:
    """Persist and number one citable read result for provider tool output."""
    if result.is_error or result.citation_result_type is None or result.citation_source_id is None:
        return None
    try:
        search_result = get_search_result(
            db,
            run.owner_user_id,
            result.citation_result_type,
            result.citation_source_id,
        )
        citation = citation_from_search_result(search_result, filters={})
        citation.selected = True
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation=citation,
            selected=True,
            scope="read_resource",
            retrieval_status="selected",
            included_in_prompt=True,
        )
    except (NotFoundError, ValueError):
        # justify-ignore-error: an unanchored read still returns its body, but it
        # is not exposed as a citation candidate.
        return None
    numbering = number_tool_citation_candidates(
        db,
        tool_call_id=tool_call_id,
        start_ordinal=start_ordinal,
    )
    # justify-service-invariant-check: one read tool call owns at most one
    # retrieval row, an invariant spanning two persisted tables.
    if len(numbering.rows) != 1:
        raise AssertionError(
            f"read tool call {tool_call_id} must own exactly one selected retrieval"
        )
    return numbering


def publish_chat_citations(
    db: Session,
    *,
    run: ChatRun,
    generated_markdown: str,
    emitter: ChatRunEventEmitter,
) -> CanonicalCitationResult:
    """Publish final edges, back-pointers, context refs, and events; do not commit."""
    rows = (
        db.execute(
            text(
                """
                SELECT retrieval.id, retrieval.citation_candidate_ordinal,
                       retrieval.result_type, retrieval.source_title,
                       retrieval.section_label, retrieval.exact_snippet,
                       retrieval.deep_link, retrieval.result_ref
                FROM message_retrievals AS retrieval
                JOIN message_tool_calls AS tool_call
                  ON tool_call.id = retrieval.tool_call_id
                WHERE tool_call.assistant_message_id = :assistant_message_id
                  AND retrieval.citation_candidate_ordinal IS NOT NULL
                ORDER BY retrieval.citation_candidate_ordinal
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        )
        .mappings()
        .all()
    )
    candidates = tuple(
        CitationCandidate(
            candidate_ordinal=row["citation_candidate_ordinal"],
            retrieval_id=row["id"],
            target=_required_citation_target(dict(row)),
            snapshot=CitationSnapshot(
                title=row["source_title"],
                excerpt=row["exact_snippet"],
                section_label=row["section_label"],
                result_type=row["result_type"],
                deep_link=row["deep_link"],
            ),
        )
        for row in rows
    )
    result = canonicalize_chat_citations(generated_markdown, candidates)
    message_ref = ResourceRef(scheme="message", id=run.assistant_message_id)

    db.execute(
        text(
            """
            UPDATE message_retrievals AS retrieval
            SET cited_edge_id = NULL
            FROM message_tool_calls AS tool_call
            WHERE tool_call.id = retrieval.tool_call_id
              AND tool_call.assistant_message_id = :assistant_message_id
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    )
    candidate_by_ordinal = {candidate.candidate_ordinal: candidate for candidate in candidates}
    citation_inputs = (
        [
            CitationInput(
                target=candidate_by_ordinal[citation.candidate_ordinal].target,
                ordinal=citation.final_ordinal,
                kind="context",
                snapshot=candidate_by_ordinal[citation.candidate_ordinal].snapshot,
            )
            for citation in result.citations
        ]
        if result.kind == "Published"
        else []
    )
    edges = replace_citations_for_output(
        db,
        viewer_id=run.owner_user_id,
        source=message_ref,
        citations=citation_inputs,
    )
    if result.kind == "Degraded":
        return result
    if not edges:
        return result

    # justify-service-invariant-check: graph replacement and canonicalization
    # have separate owners whose complete output counts must agree here.
    if len(edges) != len(result.citations):
        raise AssertionError(
            f"chat citation edge count mismatch: {len(edges)} != {len(result.citations)}"
        )
    edge_id_by_ordinal = {}
    for citation, edge in zip(result.citations, edges, strict=True):
        updated_retrieval_id = db.execute(
            text(
                "UPDATE message_retrievals SET cited_edge_id = :edge_id "
                "WHERE id = :retrieval_id RETURNING id"
            ),
            {
                "edge_id": edge.id,
                "retrieval_id": candidate_by_ordinal[citation.candidate_ordinal].retrieval_id,
            },
        ).scalar_one_or_none()
        # justify-service-invariant-check: the retrieval row was locked into
        # the candidate set earlier in this same publication transaction.
        if updated_retrieval_id != candidate_by_ordinal[citation.candidate_ordinal].retrieval_id:
            raise AssertionError(
                f"citation retrieval {citation.candidate_ordinal} disappeared during publication"
            )
        edge_id_by_ordinal[citation.final_ordinal] = edge.id

    citation_outs = build_citation_outs(
        db,
        viewer_id=run.owner_user_id,
        source=message_ref,
    )
    # justify-service-invariant-check: the graph read model must project every
    # edge written by this transaction exactly once.
    if len(citation_outs) != len(edges):
        raise AssertionError(
            f"citation read model count mismatch for message {run.assistant_message_id}"
        )
    emitter.citation_index(
        {
            "assistant_message_id": str(run.assistant_message_id),
            "citations": [
                {
                    "citation_edge_id": str(edge_id_by_ordinal[citation.ordinal]),
                    "citation": citation.model_dump(mode="json"),
                }
                for citation in citation_outs
            ],
        }
    )
    for edge in edges:
        if edge.target.scheme == "external_snapshot":
            continue
        if admits_resource_for_conversation_read(
            db,
            conversation_id=run.conversation_id,
            target=edge.target,
        ):
            continue
        context_ref = add_context_ref_without_commit(
            db,
            viewer_id=run.owner_user_id,
            conversation_id=run.conversation_id,
            target=edge.target,
            origin="citation",
        )
        emitter.context_ref_added(
            {
                "id": str(context_ref.edge_id),
                "conversation_id": str(context_ref.conversation_id),
                "resource_ref": context_ref.target.uri,
                "activation": context_ref.activation.model_dump(mode="json"),
                "label": context_ref.resolved.label,
                "summary": context_ref.resolved.summary,
                "missing": context_ref.resolved.missing,
                "created_at": context_ref.created_at,
                "citation_edge_id": str(edge.id),
            }
        )
    return result


def _required_citation_target(row: Mapping[str, Any]) -> ResourceRef:
    target = _citation_target_ref(row)
    # justify-service-invariant-check: only citable retrievals receive a
    # candidate ordinal, a cross-column invariant of the persisted row.
    if target is None:
        raise AssertionError(f"numbered retrieval {row['id']} has no citable target")
    return target


def _uuid_or_none(raw: object) -> UUID | None:
    if isinstance(raw, UUID):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        parsed = UUID(raw)
    except ValueError:
        return None
    return parsed if str(parsed) == raw else None
