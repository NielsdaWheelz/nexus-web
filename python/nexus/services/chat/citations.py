"""Citation candidates the model sees as [N], and the final edges readers follow.

Candidate ordinals are dense from 1 across one answer and fixed once numbered: each
numbering continues after the answer's largest ordinal so far, under the run lock.
Attached references (retrieved by no call) are numbered at execution, so it holds 1..k and
every tool call's candidates follow it, in whatever order the calls complete.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.schemas.live_reference import SavedResourceTarget, SavedRetrievalTarget
from nexus.services.chat.markdown_citations import Marker, parse_markers
from nexus.services.chat.retrievals import RetrievalCitation, insert_retrieval
from nexus.services.resource_graph.citations import (
    CitationInput,
    replace_citations_for_source,
)
from nexus.services.resource_graph.refs import ResourceRef, require_ref
from nexus.services.resource_items.items import ref_visible


@dataclass(frozen=True, slots=True)
class Numbered:
    retrieval_ordinal: int
    candidate_ordinal: int | None


@dataclass(frozen=True, slots=True)
class Published:
    content: str


@dataclass(frozen=True, slots=True)
class Degraded:
    """marker-free prose: a candidate is unknown or renumbering changes markdown syntax."""

    content: str
    detail: str


def number_candidates(
    db: Session, *, assistant_message_id: UUID, tool_call_id: UUID | None
) -> list[Numbered]:
    """Number one call's (None: the attached context's) selected citable rows after the
    answer's largest [N] so far.

    The caller holds the run lock.
    """

    rows = db.execute(
        text(
            """
            SELECT id, ordinal, citation_candidate_ordinal AS n
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
        if n is None:
            last += 1
            n = last
        db.execute(
            text("UPDATE message_retrievals SET citation_candidate_ordinal = :n WHERE id = :id"),
            {"n": n, "id": row.id},
        )
        numbered.append(Numbered(row.ordinal, n))
    return numbered


def persist_attached(db: Session, run: ChatRun, citations: Sequence[RetrievalCitation]) -> None:
    """The citable ``<resources>`` as the answer's attached retrievals, candidates 1..k
    (their ``n`` attributes)."""

    for ordinal, citation in enumerate(citations):
        insert_retrieval(
            db,
            assistant_message_id=run.assistant_message_id,
            tool_call_id=None,
            ordinal=ordinal,
            citation=citation,
            selected=True,
        )
    number_candidates(db, assistant_message_id=run.assistant_message_id, tool_call_id=None)


def unpublished(markdown: str) -> str:
    """An answer that ends unpublished (stopped, failed) keeps no candidate [N]: they
    name nothing a reader can open."""

    chunks: list[str] = []
    cursor = 0
    for marker in parse_markers(markdown):
        chunks.append(markdown[cursor : marker.start])
        cursor = marker.end
    return "".join(chunks) + markdown[cursor:]


def publish(db: Session, run: ChatRun, markdown: str) -> Published | Degraded:
    """Canonicalize the used markers by first appearance and publish them.

    Writes message-owned ordinals and optional local-resource edge projections.
    The caller holds account, run, then job locks.
    Never commits.
    """

    rows = db.execute(
        text(
            """
            SELECT id, citation_candidate_ordinal AS n, target
            FROM message_retrievals
            WHERE assistant_message_id = :answer AND citation_candidate_ordinal IS NOT NULL
            ORDER BY citation_candidate_ordinal
            """
        ),
        {"answer": run.assistant_message_id},
    ).all()
    by_n = {str(row.n): row for row in rows}
    markers = parse_markers(markdown)
    bad = sorted({marker.ordinal_text for marker in markers if marker.ordinal_text not in by_n})
    if bad:
        return Degraded(unpublished(markdown), f"unknown markers {bad}")
    final: dict[str, int] = {}
    chunks: list[str] = []
    expected: list[Marker] = []
    cursor = 0
    shift = 0
    for marker in markers:
        ordinal_text = str(final.setdefault(marker.ordinal_text, len(final) + 1))
        replacement = f"[{ordinal_text}]"
        chunks.append(markdown[cursor : marker.start] + replacement)
        start = marker.start + shift
        expected.append(Marker(ordinal_text, start, start + len(replacement)))
        shift += len(replacement) - (marker.end - marker.start)
        cursor = marker.end
    content = "".join(chunks) + markdown[cursor:]
    if parse_markers(content) != tuple(expected):
        return Degraded(unpublished(markdown), "renumbered markers change markdown syntax")
    targets = TypeAdapter(SavedRetrievalTarget)
    local: list[CitationInput] = []
    local_ids: list[UUID] = []
    for n, ordinal in final.items():
        row = by_n[n]
        db.execute(
            text("UPDATE message_retrievals SET citation_ordinal=:ordinal WHERE id=:id"),
            {"ordinal": ordinal, "id": row.id},
        )
        target = targets.validate_python(row.target)
        if isinstance(target, SavedResourceTarget):
            ref = require_ref(target.reference.resource_ref)
            if ref_visible(db, viewer_id=run.owner_user_id, ref=ref):
                local.append(CitationInput(ref, ordinal, None))
                local_ids.append(row.id)
    edges = replace_citations_for_source(
        db, source=ResourceRef("message", run.assistant_message_id), citations=local
    )
    for retrieval_id, edge in zip(local_ids, edges, strict=True):
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id=:edge WHERE id=:id"),
            {"edge": edge.id, "id": retrieval_id},
        )
    return Published(content)
