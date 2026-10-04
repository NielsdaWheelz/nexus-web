"""What one subject offers the model, collected purely, and the fingerprint of it.

Each collector ``(db, subject_id, viewer_id) -> Collected`` only reads, so a build and
a head's freshness check call the same function and agree by construction. The
viewer is the audience's input viewer; the subject's visibility is the caller's.
``ensure`` is the one side effect: it asks media intelligence for the projections a
media or aggregate subject needs before its claims can be offered.
"""

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.dossier import CoverageUnit
from nexus.services.contributor_credits import load_visible_contributor_media_ids
from nexus.services.media_intelligence import (
    MediaOmission,
    MediaOmissionReason,
    MediaUnit,
    ensure_current_many,
    get_media_unit,
)
from nexus.services.resource_graph.adjacency import load_page_surface
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.context import list_context_refs
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import (
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
)

EXCERPT_CHARS = 600
INPUT_CHARS = 80_000
MEDIA_INPUT_CHARS = 60_000
MAX_MESSAGES = MAX_BLOCKS = 1_000
MAX_CONNECTIONS = 500
ENSURE_BUDGET = 8
type Readiness = Literal["Ready", "Pending", "Failed"]
type Members = Literal["media", "library", "podcast", "contributor"]
_LINKABLE: tuple[ResourceScheme, ...] = tuple(
    s for s in RESOURCE_SCHEMES if s not in ("artifact", "artifact_revision")
)


class InputTooLarge(Exception):
    """The subject exceeds its deterministic input budget."""


@dataclass(frozen=True, slots=True)
class Candidate:
    """One exact resource offered to the model; its index is its position."""

    target: ResourceRef
    text: str
    snapshot: CitationSnapshot


class Coverage(BaseModel):
    """Stored in ``artifacts.coverage``: the counts shown, and what freshness compares."""

    model_config = ConfigDict(extra="forbid")

    unit: CoverageUnit
    included: int
    omitted: int
    fingerprint: str
    sources: list[tuple[str, str]]


@dataclass(frozen=True, slots=True)
class Collected:
    heading: str
    context: str
    candidates: tuple[Candidate, ...]
    coverage: Coverage


def collect(
    unit: CoverageUnit,
    heading: str,
    context: str,
    candidates: Sequence[Candidate],
    *,
    included: int | None = None,
    omitted: int = 0,
    sources: Sequence[tuple[str, str]] = (),
) -> Collected:
    """Seal one collection; the fingerprint covers everything the model reads."""
    facts = [heading, context, [[c.target.uri, _sha256(c.text)] for c in candidates]]
    coverage = Coverage(
        unit=unit,
        included=len(candidates) if included is None else included,
        omitted=omitted,
        fingerprint=_sha256(json.dumps(facts, separators=(",", ":"))),
        sources=list(sources),
    )
    return Collected(heading, context, tuple(candidates), coverage)


def offer(
    target: ResourceRef, text: str, excerpt: str, link: str | None, title: str | None = None
) -> Candidate:
    snapshot = CitationSnapshot(title, excerpt[:EXCERPT_CHARS], None, target.scheme, link)
    return Candidate(target, text, snapshot)


def media(db: Session, media_id: UUID, viewer_id: UUID) -> Collected:
    """The document's current claims, each bound to its evidence span; 60k characters."""
    unit = get_media_unit(db, media_id=media_id)
    if not isinstance(unit, MediaUnit):
        return collect("claim", "DOCUMENT CLAIMS", "", [])
    title = db.execute(text("SELECT title FROM media WHERE id = :id"), {"id": media_id}).scalar()
    claims = _claims(db, unit, title, f"/media/{media_id}", MEDIA_INPUT_CHARS)
    summary = f"DOCUMENT SUMMARY:\n{unit.summary_md}"
    omitted = len(unit.claims) - len(claims)
    return collect("claim", "DOCUMENT CLAIMS", summary, claims, omitted=omitted)


def conversation(db: Session, conversation_id: UUID, viewer_id: UUID) -> Collected:
    """Every complete message on every branch, then the attached context."""
    messages = db.execute(
        text(
            "SELECT id, seq, role, content, parent_message_id FROM messages "
            "WHERE conversation_id = :id AND status = 'complete' ORDER BY seq, id"
        ),
        {"id": conversation_id},
    ).all()
    contexts = [
        (ref, ref.resolved.inline_body or ref.resolved.summary or ref.resolved.label)
        for ref in list_context_refs(db, viewer_id=viewer_id, conversation_id=conversation_id)
        if not ref.resolved.missing
    ]
    chars = sum(len(m.content) for m in messages) + sum(len(body) for _, body in contexts)
    if len(messages) > MAX_MESSAGES or chars > INPUT_CHARS:
        raise InputTooLarge
    candidates = [
        offer(
            ResourceRef("message", m.id),
            f"{m.role} message seq={m.seq} parent={m.parent_message_id or 'root'}:\n{m.content}",
            m.content,
            f"/conversations/{conversation_id}?message={m.id}",
            f"{m.role.title()} message",
        )
        for m in messages
        if m.content.strip()
    ]
    for ref, body in contexts:
        label = ref.resolved.label
        candidates.append(
            offer(
                ref.target, f"Attached Context — {label}:\n{body}", body, ref.activation.href, label
            )
        )
    heading = "ALL-BRANCH CONVERSATION MESSAGES AND ATTACHED CONTEXT"
    context = (
        "Shared prefixes occur once. Parent facts in each message describe the branch "
        "topology; synthesize across every branch."
    )
    return collect("source", heading, context, candidates)


def page(db: Session, page_id: UUID, viewer_id: UUID) -> Collected:
    """The page's blocks in reading order, then its one-hop connections."""
    surface = load_page_surface(db, user_id=viewer_id, page_id=page_id)
    candidates: list[Candidate] = []
    blocks = chars = 0
    stack = list(reversed(surface.roots))
    while stack:
        node = stack.pop()
        body, block_id = node.block.body_text, node.block.id
        blocks, chars = blocks + 1, chars + len(body)
        if blocks > MAX_BLOCKS or chars > INPUT_CHARS:
            raise InputTooLarge
        if body.strip():
            text_ = f"Linked note block ({node.order_key}):\n{body}"
            ref = ResourceRef("note_block", block_id)
            candidates.append(offer(ref, text_, body, f"/notes/{block_id}", surface.page.title))
        stack.extend(reversed(node.children))
    candidates += _connections(db, ResourceRef("page", page_id), viewer_id)
    heading = "ORDERED NOTE BLOCKS AND ONE-HOP CONNECTIONS"
    return collect("source", heading, f"PAGE: {surface.page.title}", candidates)


def note(db: Session, note_id: UUID, viewer_id: UUID) -> Collected:
    """One atomic note: its owned evidence spans, else its body; then its connections."""
    body = db.execute(
        text("SELECT body_text FROM note_blocks WHERE id = :id"), {"id": note_id}
    ).scalar_one()
    spans = db.execute(
        text(
            "SELECT id, span_text FROM evidence_spans "
            "WHERE owner_kind = 'note_block' AND owner_id = :id ORDER BY id"
        ),
        {"id": note_id},
    ).all()
    if len(body) + sum(len(span.span_text) for span in spans) > INPUT_CHARS:
        raise InputTooLarge
    candidates = [
        offer(
            ResourceRef("evidence_span", span.id),
            f"Owned note evidence:\n{span.span_text or body}",
            span.span_text or body,
            f"/notes/{note_id}#evidence-{span.id}",
        )
        for span in spans
        if (span.span_text or body).strip()
    ]
    if not candidates and body.strip():
        note_ref = ResourceRef("note_block", note_id)
        candidates = [
            offer(note_ref, f"Exact atomic note body:\n{body}", body, f"/notes/{note_id}")
        ]
    candidates += _connections(db, ResourceRef("note_block", note_id), viewer_id)
    heading = "ATOMIC NOTE BODY AND ONE-HOP CONNECTIONS"
    context = (
        "Treat the note as one atomic body. Evidence-span candidates are exact owned "
        "evidence; otherwise the note candidate snapshots the body."
    )
    return collect("source", heading, context, candidates)


# Per aggregate: the coverage unit, the candidates heading, the subject line's sql.
_AGGREGATES: dict[str, tuple[CoverageUnit, str, str]] = {
    "library": ("media", "LIBRARY MEDIA", "'LIBRARY: ' || name FROM libraries"),
    "podcast": ("episode", "PODCAST EPISODES", "'PODCAST: ' || title FROM podcasts"),
    "contributor": (
        "work",
        "CONTRIBUTOR WORKS",
        "'CONTRIBUTOR: ' || display_name FROM contributors",
    ),
}


def aggregate(scheme: Members, db: Session, subject_id: UUID, viewer_id: UUID) -> Collected:
    """The claims of the first ``ENSURE_BUDGET`` members whose units are ready; 80k chars."""
    unit_name, heading, subject_sql = _AGGREGATES[scheme]
    members = _members(scheme, db, subject_id, viewer_id)
    rows = db.execute(
        text("SELECT id, title FROM media WHERE id = ANY(:ids)"), {"ids": members[:ENSURE_BUDGET]}
    )
    titles = {row.id: row.title for row in rows}
    candidates: list[Candidate] = []
    context = [
        db.execute(text(f"SELECT {subject_sql} WHERE id = :id"), {"id": subject_id}).scalar_one()
    ]
    chars = 0
    for media_id in members[:ENSURE_BUDGET]:
        unit = get_media_unit(db, media_id=media_id)
        if not isinstance(unit, MediaUnit):
            continue
        title = titles[media_id]
        claims = _claims(db, unit, title, f"/media/{media_id}", None, prefix=f"{title}: ")
        cost = sum(len(c.text) + len(c.snapshot.excerpt or "") for c in claims)
        if claims and (not candidates or chars + cost <= INPUT_CHARS):
            candidates, chars = candidates + claims, chars + cost
            context.append(f"{title}: {unit.summary_md}")
    included = len(context) - 1
    return collect(
        unit_name,
        f"GROUNDED CLAIMS FROM {heading}",
        "\n\n".join(context),
        candidates,
        included=included,
        omitted=len(members) - included,
    )


def ensure(scheme: Members, db: Session, subject_id: UUID, viewer_id: UUID) -> Readiness:
    """Enqueue the missing projections of the first ``ENSURE_BUDGET`` members."""
    members = _members(scheme, db, subject_id, viewer_id)[:ENSURE_BUDGET]
    projections = ensure_current_many(
        db, media_ids=members, requester_user_id=viewer_id, max_concurrency=ENSURE_BUDGET
    )
    reasons = {item.reason for item in projections if isinstance(item, MediaOmission)}
    if MediaOmissionReason.ProjectionPending in reasons:
        return "Pending"
    failed = {MediaOmissionReason.ProjectionFailed, MediaOmissionReason.ProjectionSuspended}
    return "Failed" if reasons & failed else "Ready"


def _members(scheme: Members, db: Session, subject_id: UUID, viewer_id: UUID) -> list[UUID]:
    """The subject's visible media in its own order: library position, newest episode."""
    if scheme == "media":
        return [subject_id]
    if scheme == "contributor":
        return load_visible_contributor_media_ids(
            db, contributor_id=subject_id, viewer_id=viewer_id
        )
    expanded = (
        "SELECT media_id, 0 AS position, 1 AS lane, published_at FROM podcast_episodes "
        "WHERE podcast_id = :id"
        if scheme == "podcast"
        else "SELECT media_id, position, 0 AS lane, NULL::timestamptz AS published_at "
        "FROM library_entries WHERE library_id = :id AND media_id IS NOT NULL UNION ALL "
        "SELECT pe.media_id, le.position, 1, pe.published_at FROM library_entries le "
        "JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id WHERE le.library_id = :id"
    )
    rows = db.execute(
        text(
            f"SELECT e.media_id FROM ({expanded}) e "
            f"WHERE e.media_id IN ({visible_media_ids_cte_sql()}) "
            "ORDER BY e.position, e.lane, e.published_at DESC NULLS LAST, e.media_id"
        ),
        {"id": subject_id, "viewer_id": viewer_id},
    )
    return list(dict.fromkeys(rows.scalars()))


def _claims(
    db: Session, unit: MediaUnit, title: str | None, href: str, budget: int | None, prefix: str = ""
) -> list[Candidate]:
    """A unit's claims whose evidence span still exists, until ``budget`` characters."""
    spans = db.execute(
        text("SELECT id, span_text, citation_label FROM evidence_spans WHERE id = ANY(:ids)"),
        {"ids": [claim.evidence_span_id for claim in unit.claims]},
    )
    by_id = {span.id: span for span in spans}
    candidates: list[Candidate] = []
    chars = 0
    for claim in unit.claims:
        span = by_id.get(claim.evidence_span_id)
        if span is None:
            continue
        excerpt = (span.span_text or claim.claim_text)[:EXCERPT_CHARS]
        chars += len(claim.claim_text) + len(excerpt)
        if budget is not None and candidates and chars > budget:
            break
        snapshot = CitationSnapshot(
            title, excerpt, span.citation_label, "evidence_span", f"{href}#evidence-{span.id}"
        )
        target = ResourceRef("evidence_span", span.id)
        candidates.append(Candidate(target, f"{prefix}{claim.claim_text}", snapshot))
    return candidates


def _connections(db: Session, ref: ResourceRef, viewer_id: UUID) -> list[Candidate]:
    """Every exact non-dossier connection endpoint, at most ``MAX_CONNECTIONS``."""
    candidates: list[Candidate] = []
    cursor: str | None = None
    seen = 0
    while True:
        filters = ConnectionFilters(source_schemes=_LINKABLE, target_schemes=_LINKABLE)
        query = ConnectionQuery((ref,), "both", "exact", filters, 100, cursor)
        connections = query_connections(db, viewer_id=viewer_id, query=query)
        seen += len(connections.items)
        for connection in connections.items:
            end = connection.other
            if not end.missing and end.ref != ref:
                body = end.description or end.label or end.ref.uri
                kind = f"{connection.kind}, {connection.direction}"
                text_ = f"Connection ({kind}) — {end.label or end.ref.uri}:\n{body}"
                candidates.append(offer(end.ref, text_, body, end.href, end.label))
        if connections.next_cursor is None:
            return candidates
        if seen >= MAX_CONNECTIONS:
            raise InputTooLarge
        cursor = connections.next_cursor


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
