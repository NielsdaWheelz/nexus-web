"""Bounded committed intent for every selection mode; source owners retain their facts."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.services import highlights, notes
from nexus.services.consumption import projection
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import sources

ANCHOR_LIMIT = 5
_MESSAGE_TEXT_LIMIT = 2000
_LEXICAL_WINDOW = 400


@dataclass(frozen=True, slots=True)
class IntentAnchor:
    ref: ResourceRef
    activity_at: datetime
    terms: str | None = None


def recent_intent(db: Session, *, viewer_id: UUID) -> tuple[IntentAnchor, ...]:
    """One latest user turn per conversation; repeated actions never add votes."""
    facts = [
        IntentAnchor(ResourceRef("media", fact.media_id), fact.activity_at)
        for read in (
            projection.recent_engagement_anchor_facts,
            highlights.recent_highlight_anchor_facts,
        )
        for fact in read(db, viewer_id=viewer_id, limit=ANCHOR_LIMIT)
    ]
    facts += [
        IntentAnchor(fact.ref, fact.activity_at)
        for fact in notes.recent_note_anchor_facts(db, viewer_id=viewer_id, limit=ANCHOR_LIMIT)
    ]
    rows = db.execute(
        text(f"""
            WITH visible AS MATERIALIZED ({visible_media_ids_cte_sql()}),
            user_turns AS (
                SELECT DISTINCT ON (m.conversation_id) m.id,m.created_at,m.content,
                    m.reader_selection_snapshot #>> '{{evidence,target,owner_ref}}' AS quoted_ref
                FROM messages m JOIN conversations c ON c.id=m.conversation_id
                WHERE c.owner_user_id=:viewer_id AND m.role='user' AND m.status='complete'
                  AND (m.content<>'' OR m.reader_selection_snapshot IS NOT NULL)
                ORDER BY m.conversation_id,m.created_at DESC,m.id DESC
            ), recent AS (
                SELECT * FROM user_turns ORDER BY created_at DESC,id DESC LIMIT :limit
            )
            SELECT r.id,r.created_at,NULLIF(left(r.content,:text_limit),'') AS terms,v.media_id
            FROM recent r LEFT JOIN visible v ON r.quoted_ref='media:' || v.media_id::text
            ORDER BY r.created_at DESC,r.id DESC
        """),
        {"viewer_id": viewer_id, "limit": ANCHOR_LIMIT, "text_limit": _MESSAGE_TEXT_LIMIT},
    )
    facts += [
        IntentAnchor(
            ResourceRef("media", row.media_id) if row.media_id else ResourceRef("message", row.id),
            row.created_at,
            row.terms,
        )
        for row in rows
    ]
    saved = db.execute(
        text(f"""
            SELECT d.media_id,d.last_manually_saved_at
            FROM viewer_media_discoveries d
            WHERE d.user_id=:viewer_id AND d.manually_saved
              AND d.last_manually_saved_at IS NOT NULL
              AND d.media_id IN ({visible_media_ids_cte_sql()})
            ORDER BY d.last_manually_saved_at DESC,d.media_id LIMIT :limit
        """),
        {"viewer_id": viewer_id, "limit": ANCHOR_LIMIT},
    )
    facts += [
        IntentAnchor(ResourceRef("media", row.media_id), row.last_manually_saved_at)
        for row in saved
    ]
    facts.sort(key=lambda fact: (-fact.activity_at.timestamp(), fact.ref.uri, fact.terms is None))
    distinct: dict[ResourceRef, IntentAnchor] = {}
    for fact in facts:
        prior = distinct.get(fact.ref)
        if prior is None:
            distinct[fact.ref] = fact
        elif prior.terms is None and fact.terms is not None:
            # Reading/saving a quoted work advances its activity, not the user's words.
            # The sorted, bounded message facts supply its latest accepted text once.
            distinct[fact.ref] = IntentAnchor(prior.ref, prior.activity_at, fact.terms)
    return tuple(distinct.values())[:ANCHOR_LIMIT]


def lexical_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[ResourceRef, ...],
    intent: tuple[IntentAnchor, ...],
    media_ids: list[UUID],
) -> list[dict[str, object]]:
    """Reuse exact lexical retrieval over the already eligible candidate set."""
    if not media_ids:
        return []
    ranks = {ref: rank for rank, ref in enumerate(anchors)}
    matches: list[tuple[float, int, UUID]] = []
    for fact in intent:
        if fact.terms is None or fact.ref not in ranks:
            continue
        for hit in sources.rank_readings(
            db, viewer_id=viewer_id, terms=fact.terms, media_ids=media_ids, limit=_LEXICAL_WINDOW
        ):
            media_id = hit.reading_media_id if hit.type == "content_chunk" else hit.id
            if media_id is not None:
                matches.append((-hit.score, ranks[fact.ref], media_id))
    matches.sort()
    return [
        {"id": str(media_id), "rank": rank, "ordinal": ordinal}
        for ordinal, (_, rank, media_id) in enumerate(matches)
    ]
