"""Citation candidates the model sees as [N], and the final edges readers follow.

Candidate ordinals are dense from 1 across one answer and fixed once numbered: each
numbering continues after the answer's largest ordinal so far, under the run lock.
Attached evidence (retrieved by no call) is numbered at admission, so it holds 1..k and
every tool call's candidates follow it, in whatever order the calls complete.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import NotFoundError
from nexus.schemas.conversation import ChatRunContextRefAddedEventPayload
from nexus.schemas.resource_evidence import CapturedEvidence
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.services.chat import events
from nexus.services.chat.retrievals import RetrievalCitation, insert_retrieval, lock_retrieval_media
from nexus.services.resource_graph.citations import (
    CitationInput,
    parse_generated_markdown_citation_markers,
    replace_citations_for_output,
)
from nexus.services.resource_graph.context import add_context_ref_without_commit, context_version
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out


@dataclass(frozen=True, slots=True)
class Numbered:
    retrieval_ordinal: int
    candidate_ordinal: int | None
    result_ref: dict[str, Any]


@dataclass(frozen=True, slots=True)
class Published:
    content: str


@dataclass(frozen=True, slots=True)
class Degraded:
    """Marker-free prose: the model used a linked or unknown [N]."""

    content: str
    detail: str


def citable_target(result_ref: dict[str, Any]) -> ResourceRef | None:
    """The search-owned citable target a retrieval row stores, if it has one."""

    raw = result_ref.get("citation_target")
    if raw is None:
        return None
    target = parse_resource_ref(str(raw))
    if (
        isinstance(target, ResourceRefParseFailure)
        or capability(target.scheme).citable_result_type is None
    ):
        raise AssertionError(f"retrieval citation_target is not citable: {raw!r}")
    return target


def number_candidates(
    db: Session, *, assistant_message_id: UUID, tool_call_id: UUID | None
) -> list[Numbered]:
    """Number one call's (None: the attached context's) selected citable rows after the
    answer's largest [N] so far.

    The caller holds the run lock. Every selected row is marked included in the prompt.
    """

    rows = db.execute(
        text(
            """
            SELECT id, ordinal, result_ref, citation_candidate_ordinal AS n
            FROM message_retrievals
            WHERE assistant_message_id = :answer
              AND tool_call_id IS NOT DISTINCT FROM CAST(:call AS uuid) AND selected
            ORDER BY ordinal
            """
        ),
        {"answer": assistant_message_id, "call": tool_call_id},
    ).all()
    last: int = db.execute(
        text(
            "SELECT COALESCE(MAX(citation_candidate_ordinal), 0) FROM message_retrievals"
            " WHERE assistant_message_id = :answer"
        ),
        {"answer": assistant_message_id},
    ).scalar_one()
    numbered: list[Numbered] = []
    for row in rows:
        n = row.n
        if n is None and citable_target(row.result_ref) is not None:
            last += 1
            n = last
        db.execute(
            text(
                "UPDATE message_retrievals SET citation_candidate_ordinal = :n,"
                " included_in_prompt = true WHERE id = :id"
            ),
            {"n": n, "id": row.id},
        )
        numbered.append(Numbered(row.ordinal, n, row.result_ref))
    return numbered


def persist_attached(db: Session, run: ChatRun, citations: Sequence[RetrievalCitation]) -> None:
    """The citable ``<resources>`` as the answer's attached retrievals, candidates 1..k
    (their ``n`` attributes)."""

    lock_retrieval_media(db, citations)
    for ordinal, citation in enumerate(citations):
        insert_retrieval(
            db,
            assistant_message_id=run.assistant_message_id,
            tool_call_id=None,
            ordinal=ordinal,
            citation=citation,
            selected=True,
            scope="attached_context",
            retrieval_status="attached_context",
            included_in_prompt=True,
        )
    number_candidates(db, assistant_message_id=run.assistant_message_id, tool_call_id=None)


def publish(db: Session, run: ChatRun, markdown: str) -> Published | Degraded:
    """Canonicalize the used markers by first appearance and publish them.

    Writes the citation edges, their retrieval back-pointers, the cited resources'
    context refs and their events. The caller holds conversation, run, then job locks.
    Never commits.
    """

    rows = db.execute(
        text(
            """
            SELECT id, citation_candidate_ordinal AS n, result_type, source_title,
                   section_label, exact_snippet, deep_link, result_ref, captured_evidence
            FROM message_retrievals
            WHERE assistant_message_id = :answer AND citation_candidate_ordinal IS NOT NULL
            ORDER BY citation_candidate_ordinal
            """
        ),
        {"answer": run.assistant_message_id},
    ).all()
    by_n = {row.n: row for row in rows}
    markers = parse_generated_markdown_citation_markers(markdown)
    bad = sorted(
        {marker.ordinal for marker in markers if marker.linked or marker.ordinal not in by_n}
    )
    final: dict[int, int] = {}
    if not bad:
        for marker in markers:
            final.setdefault(marker.ordinal, len(final) + 1)
    chunks: list[str] = []
    cursor = 0
    for marker in markers:
        chunks.append(markdown[cursor : marker.start])
        if final:
            chunks.append(f"[{final[marker.ordinal]}]")
        cursor = marker.end
    content = "".join(chunks) + markdown[cursor:]
    if bad:
        return Degraded(content, f"linked or unknown markers {bad}")
    citations: list[CitationInput] = []
    for n, ordinal in final.items():
        row = by_n[n]
        target = cast(ResourceRef, citable_target(row.result_ref))  # only citable rows are numbered
        snapshot = CitationSnapshot(evidence=CapturedEvidence.model_validate(row.captured_evidence))
        citations.append(CitationInput(target, ordinal, "context", snapshot))
    edges = replace_citations_for_output(
        db,
        viewer_id=run.owner_user_id,
        source=ResourceRef("message", run.assistant_message_id),
        citations=citations,
    )
    # Caller holds the chat lock: one decision covers the complete automatic batch.
    admit_context = (
        run.admitted_context_version is not None
        and run.admitted_context_version
        == context_version(db, viewer_id=run.owner_user_id, conversation_id=run.conversation_id)
    )
    visible = (
        {
            item.ref
            for item in resource_items_out(
                db,
                viewer_id=run.owner_user_id,
                refs=[edge.target for edge in edges if edge.target.scheme != "external_snapshot"],
            )
            if not item.missing
        }
        if admit_context
        else set()
    )
    for n, edge in zip(final, edges, strict=True):
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id = :edge WHERE id = :id"),
            {"edge": edge.id, "id": by_n[n].id},
        )
        if edge.target.uri not in visible:
            continue
        try:
            added = add_context_ref_without_commit(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                target=edge.target,
                origin="citation",
            )
        except NotFoundError:
            # Access may disappear after the batch read. The admission writer
            # checks visibility before mutating; the historical citation survives.
            continue
        if added is not None:
            event = ChatRunContextRefAddedEventPayload(
                id=added.edge_id,
                resource_ref=added.target.uri,
            )
            events.append(db, run, event)
    return Published(content)
