"""Resonance: three deterministic next-read slates over one snapshot.

Read-only and model-free; the caller's REPEATABLE READ transaction makes
``now()`` one instant. SQL decides each target's one family (Continuity,
Arrival, then Rediscovery or GraphThread) and its order within it; a relational
target needs evidence from an anchor (Connected, SharedAuthor, Similar, in that
priority). Python only composes.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.schemas.presence import absent
from nexus.schemas.resonance import (
    MediaSlateTargetOut,
    PodcastSlateTargetOut,
    QuickReadsOut,
    SlateItemOut,
    SlateOut,
)
from nexus.services import highlights, library_entries, library_governance, notes, reading_time
from nexus.services import media as media_service
from nexus.services.consumption import projection
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.podcasts.subscriptions_query import (
    active_subscription_rows_sql,
    hydrate_compact_podcast_targets,
)
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.semantic_chunks import media_neighbor_rows_sql

_ANCHORS = 5
_PER_FAMILY = 20
_EDGE_ORIGINS = ["user", "citation", "note_body", "highlight_note", "document_embed", "synapse"]
# Human-reviewed calibration: a neighbour ranks only under this exact embedding
# identity at this similarity. Another model yields no Similar evidence.
_EMBEDDING = ("openai", "openai_text_embedding_3_small_256_v1", 256)
_MIN_SIMILARITY = 0.80

Surface = Literal["lectern", "quick_reads", "library", "default_library"]


@dataclass(frozen=True, slots=True)
class _Candidate:
    scheme: Literal["media", "podcast"]
    id: UUID
    family: str
    lane: int  # 0 Connected, 1 SharedAuthor, 2 Similar; 3 for the direct families
    lane_strength: int | None  # position in the lane's own strength order
    strength: int  # position inside the family
    reason: str
    media_kind: str | None
    anchor: int | None
    author: UUID | None


def build_lectern_slate(db: Session, *, viewer_id: UUID) -> SlateOut:
    """Up to ten next reads; empty while the Lectern is at capacity."""
    if not consumption_service.lectern_has_capacity(db, viewer_id=viewer_id):
        return SlateOut(items=[])
    candidates = _candidates(db, viewer_id, _lectern_anchors(db, viewer_id), "lectern", {})
    return SlateOut(items=_hydrate(db, viewer_id, _rotate(candidates, limit=10)))


def build_quick_reads(db: Session, *, viewer_id: UUID) -> QuickReadsOut:
    """Up to five unfinished documents with under ten minutes left."""
    candidates = _candidates(db, viewer_id, _lectern_anchors(db, viewer_id), "quick_reads", {})
    return QuickReadsOut(items=_hydrate(db, viewer_id, _rotate(candidates, limit=5)))


def build_library_slate(db: Session, *, viewer_id: UUID, library_id: UUID) -> SlateOut:
    """Up to ten relational suggestions for an admin-owned, non-system library."""
    context = library_governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if context.system_key is not None or context.role != "admin":
        return SlateOut(items=[])
    anchors = library_entries.library_anchor_facts(
        db, viewer_id=viewer_id, library_id=library_id, limit=_ANCHORS
    )
    surface: Surface = "default_library" if context.is_default else "library"
    candidates = _candidates(db, viewer_id, anchors, surface, {"library_id": library_id})
    ordered = sorted(candidates, key=lambda c: (c.lane, c.lane_strength, c.scheme, c.id))
    picked: list[_Candidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    while len(picked) < 10 and _take(ordered, picked, counts):
        pass
    return SlateOut(items=_hydrate(db, viewer_id, picked))


def _lectern_anchors(db: Session, viewer_id: UUID) -> tuple[ResourceRef, ...]:
    """The five newest touched objects; engagement before highlights before notes."""
    media_reads = (
        projection.recent_engagement_anchor_facts,
        highlights.recent_highlight_anchor_facts,
    )
    facts = [
        (f.activity_at, tier, ResourceRef(scheme="media", id=f.media_id))
        for tier, read in enumerate(media_reads)
        for f in read(db, viewer_id=viewer_id, limit=_ANCHORS)
    ]
    facts += [
        (f.activity_at, 2 if f.ref.scheme == "note_block" else 3, f.ref)
        for f in notes.recent_note_anchor_facts(db, viewer_id=viewer_id, limit=_ANCHORS)
    ]
    facts.sort(key=lambda fact: (-fact[0].timestamp(), fact[1], fact[2].uri))
    return tuple(dict.fromkeys(ref for _, _, ref in facts))[:_ANCHORS]


def _targets_sql(surface: Surface) -> str:
    """Eligible targets with their facts and their one family. Binds :viewer_id
    (and :library_id for the library surfaces)."""
    lectern = surface in ("lectern", "quick_reads")
    eligibility = {
        "lectern": f"""COALESCE(e.read_state, 'Unread') <> 'Finished'
            AND m.id NOT IN (SELECT media_id FROM ({projection.lectern_membership_rows_sql()}) q)""",
        "quick_reads": f"""COALESCE(e.read_state, 'Unread') <> 'Finished'
            AND m.id IN (SELECT media_id FROM ({reading_time.reading_time_rows_sql()}) d
                         WHERE d.remaining_seconds > 0 AND d.remaining_seconds < 600)""",
        "library": "m.id NOT IN (SELECT media_id FROM membership WHERE media_id IS NOT NULL)",
        "default_library": "m.id NOT IN (SELECT media_id FROM membership WHERE media_id IS NOT NULL)",
    }[surface]
    podcasts = (
        f"""
        UNION ALL
        SELECT 'podcast', s.podcast_id, NULL, NULL, MAX(pe.published_at) FILTER (
                   WHERE pe.published_at <= now()), NULL, NULL,
               MAX(e.last_engaged_at) FILTER (WHERE e.last_engaged_at <= now())
        FROM ({active_subscription_rows_sql()}) s
        JOIN ({visible_podcast_ids_cte_sql()}) vp USING (podcast_id)
        LEFT JOIN episodes pe
          ON pe.podcast_id = s.podcast_id AND pe.media_id IN (SELECT media_id FROM visible)
        LEFT JOIN engagement e ON e.media_id = pe.media_id
        WHERE s.podcast_id NOT IN (
            SELECT podcast_id FROM membership WHERE podcast_id IS NOT NULL)
        GROUP BY s.podcast_id
        """
        if surface == "library"
        else ""
    )
    membership = (
        f"membership AS ({library_entries.destination_membership_rows_sql()}),"
        if surface in ("library", "default_library")
        else ""
    )
    day = "to_char((now() AT TIME ZONE 'UTC')::date - {n}, 'YYYY-MM-DD')"
    return f"""
        WITH visible AS ({visible_media_ids_cte_sql()}),
        engagement AS ({projection.engagement_fact_rows_sql()}),
        episodes AS ({episode_publication_rows_sql()}),
        {membership}
        facts AS (
            SELECT 'media'::text AS target_scheme, m.id AS target_id, m.kind::text AS media_kind,
                   m.created_at, pe.published_at AS episode_at,
                   CASE WHEN m.original_published_date ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$'
                        THEN m.original_published_date END AS published_on,
                   e.read_state,
                   CASE WHEN e.last_engaged_at <= now() THEN e.last_engaged_at END AS engaged_at
            FROM media m
            JOIN visible v ON v.media_id = m.id
            LEFT JOIN engagement e ON e.media_id = m.id
            LEFT JOIN episodes pe ON pe.media_id = m.id
            WHERE {eligibility}
            {podcasts}
        ),
        dated AS (
            SELECT facts.*,
                   CASE WHEN created_at BETWEEN now() - interval '14 days' AND now()
                        THEN to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS added_day,
                   CASE WHEN episode_at BETWEEN now() - interval '14 days' AND now()
                        THEN to_char(episode_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS episode_day,
                   CASE WHEN published_on BETWEEN {day.format(n=13)} AND {day.format(n=0)}
                        THEN published_on END AS published_day
            FROM facts
        )
        SELECT dated.*,
               GREATEST(added_day, episode_day, published_day) AS arrival_day,
               CASE
                   WHEN {str(lectern).lower()} AND read_state = 'InProgress'
                        AND engaged_at >= now() - interval '30 days' THEN 'Continuity'
                   WHEN {str(lectern).lower()}
                        AND COALESCE(added_day, episode_day, published_day) IS NOT NULL
                        THEN 'Arrival'
                   WHEN GREATEST(CASE WHEN created_at <= now() THEN created_at END,
                                 CASE WHEN episode_at <= now() THEN episode_at END, engaged_at)
                        <= now() - interval '90 days' THEN 'Rediscovery'
                   ELSE 'GraphThread'
               END AS family
        FROM dated
    """


def _candidates(
    db: Session,
    viewer_id: UUID,
    anchors: tuple[ResourceRef, ...],
    surface: Surface,
    params: dict[str, object],
) -> list[_Candidate]:
    """Each eligible target's family, its strongest evidence (a relational
    family's only), and its order; at most twenty per family."""
    library = surface in ("library", "default_library")
    tiebreak = (
        "MAX(t.engaged_at) DESC NULLS LAST, MAX(GREATEST(t.created_at, t.episode_at)) DESC NULLS LAST,"
        if library
        else ""
    )
    targets = _targets_sql(surface)
    params = {
        "viewer_id": viewer_id,
        "anchors": json.dumps(
            [{"scheme": a.scheme, "id": str(a.id), "rank": i} for i, a in enumerate(anchors)]
        ),
        "similar": json.dumps(_similar(db, viewer_id, anchors, targets, params)),
        "origins": _EDGE_ORIGINS,
        **params,
    }
    rows = db.execute(
        text(f"""
            WITH targets AS ({targets}),
            anchors AS (
                SELECT * FROM jsonb_to_recordset(CAST(:anchors AS jsonb))
                    AS a(scheme text, id uuid, rank integer)
            ),
            edges AS (
                SELECT * FROM resource_edges
                WHERE user_id = :viewer_id AND origin = ANY(:origins)
            ),
            owners AS ({
            owner_rows_sql('''
                SELECT source_scheme AS scheme, source_id AS id FROM edges
                UNION SELECT target_scheme, target_id FROM edges
            ''')
        }),
            connected AS (
                SELECT p.target_scheme, p.target_id, a.rank AS anchor_rank, NULL::uuid AS author_id,
                       ROW_NUMBER() OVER (ORDER BY array_position(:origins, e.origin),
                           e.created_at DESC,
                           array_position(ARRAY['context', 'supports', 'contradicts'], e.kind),
                           e.id, a.rank) AS strength
                FROM edges e
                JOIN owners s ON s.scheme = e.source_scheme AND s.id = e.source_id
                JOIN owners t ON t.scheme = e.target_scheme AND t.id = e.target_id
                CROSS JOIN LATERAL (VALUES
                    (s.owner_scheme, s.owner_id, t.owner_scheme, t.owner_id),
                    (t.owner_scheme, t.owner_id, s.owner_scheme, s.owner_id)
                ) AS p(anchor_scheme, anchor_id, target_scheme, target_id)
                JOIN anchors a ON a.scheme = p.anchor_scheme AND a.id = p.anchor_id
                WHERE (p.target_scheme, p.target_id) <> (p.anchor_scheme, p.anchor_id)
            ),
            authors AS ({visible_author_credit_rows_sql()}),
            authored AS (
                SELECT t.target_scheme, t.target_id, a.rank AS anchor_rank,
                       MIN(ta.contributor_id::text)::uuid AS author_id,
                       ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT ta.contributor_id) DESC,
                           MIN(ta.contributor_id::text), {tiebreak} a.rank, t.target_scheme,
                           t.target_id) AS strength
                FROM anchors a
                JOIN authors aa ON (a.scheme = 'media' AND aa.media_id = a.id)
                                OR (a.scheme = 'podcast' AND aa.podcast_id = a.id)
                JOIN authors ta ON ta.contributor_id = aa.contributor_id
                JOIN targets t ON (t.target_scheme = 'media' AND t.target_id = ta.media_id)
                               OR (t.target_scheme = 'podcast' AND t.target_id = ta.podcast_id)
                WHERE (t.target_scheme, t.target_id) <> (a.scheme, a.id)
                GROUP BY t.target_scheme, t.target_id, a.rank
            ),
            neighbours AS (
                SELECT 'media'::text AS target_scheme, id AS target_id, rank AS anchor_rank,
                       NULL::uuid AS author_id,
                       ROW_NUMBER() OVER (ORDER BY ordinal) AS strength
                FROM jsonb_to_recordset(CAST(:similar AS jsonb))
                    AS x(id uuid, rank integer, ordinal integer)
            ),
            evidence AS (
                SELECT DISTINCT ON (target_scheme, target_id) *
                FROM (
                    SELECT 0 AS lane, 'Connected' AS reason, * FROM connected
                    UNION ALL SELECT 1, 'SharedAuthor', * FROM authored
                    UNION ALL SELECT 2, 'Similar', * FROM neighbours
                ) lanes
                ORDER BY target_scheme, target_id, lane, strength
            ),
            ranked AS (
                SELECT t.target_scheme, t.target_id, t.media_kind, t.family,
                       COALESCE(ev.lane, 3) AS lane,
                       CASE t.family
                           WHEN 'Continuity' THEN 'Continue'
                           WHEN 'Arrival' THEN CASE t.arrival_day
                               WHEN t.episode_day THEN 'NewEpisode'
                               WHEN t.published_day THEN 'Published'
                               ELSE 'AddedToNexus' END
                           ELSE ev.reason
                       END AS reason,
                       ev.strength AS lane_strength, ev.anchor_rank, ev.author_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY t.family
                           ORDER BY
                               CASE WHEN t.family = 'Continuity' THEN t.engaged_at END
                                   DESC NULLS LAST,
                               CASE WHEN t.family = 'Arrival' THEN t.arrival_day END
                                   DESC NULLS LAST,
                               CASE WHEN t.family = 'Arrival' THEN CASE t.arrival_day
                                   WHEN t.episode_day THEN 0 WHEN t.published_day THEN 1
                                   ELSE 2 END END,
                               CASE WHEN t.family = 'Arrival' THEN GREATEST(
                                   CASE WHEN t.added_day = t.arrival_day THEN t.created_at END,
                                   CASE WHEN t.episode_day = t.arrival_day THEN t.episode_at END)
                               END DESC NULLS LAST,
                               ev.lane, ev.strength, t.target_scheme, t.target_id
                       ) AS strength
                FROM targets t
                LEFT JOIN evidence ev ON t.family NOT IN ('Continuity', 'Arrival')
                     AND (ev.target_scheme, ev.target_id) = (t.target_scheme, t.target_id)
                WHERE t.family IN ('Continuity', 'Arrival') OR ev.lane IS NOT NULL
            )
            SELECT target_scheme AS scheme, target_id AS id, family, lane, lane_strength,
                   strength, reason,
                   media_kind, anchor_rank AS anchor, author_id AS author
            FROM ranked WHERE strength <= {_PER_FAMILY}
            ORDER BY family, strength
        """),
        params,
    ).mappings()
    return [_Candidate(**row) for row in rows]


def _similar(
    db: Session,
    viewer_id: UUID,
    anchors: tuple[ResourceRef, ...],
    targets: str,
    params: dict[str, object],
) -> list[dict[str, object]]:
    """Calibrated nearest media neighbours of each media anchor, best first.

    The anchor's first chunk vector stands for its work; the ANN limit applies
    per family so one family cannot crowd out the other."""
    provider, model, dimensions = _EMBEDDING
    rows: list[tuple[float, int, UUID]] = []
    for rank, anchor in enumerate(anchors):
        if anchor.scheme != "media":
            continue
        neighbours = media_neighbor_rows_sql(f"""
            SELECT target_id AS media_id, family AS candidate_partition
            FROM ({targets}) t
            WHERE target_scheme = 'media' AND family IN ('GraphThread', 'Rediscovery')
        """)
        for peer_id, distance in db.execute(
            text(f"SELECT peer_media_id, distance FROM ({neighbours}) n WHERE distance <= :max"),
            {
                "viewer_id": viewer_id,
                "anchor_media_id": anchor.id,
                "embedding_provider": provider,
                "embedding_model": model,
                "embedding_dimensions": dimensions,
                "candidate_limit": 400,
                "max": 1 - _MIN_SIMILARITY,
                **params,
            },
        ):
            rows.append((distance, rank, peer_id))
    rows.sort()
    return [
        {"id": str(peer_id), "rank": rank, "ordinal": ordinal}
        for ordinal, (_, rank, peer_id) in enumerate(rows)
    ]


def _rotate(candidates: list[_Candidate], *, limit: int) -> list[_Candidate]:
    """Lectern: one per family in turn (C, G, A, R), then backfill G, C, R, A."""
    by_family = {
        family: [c for c in candidates if c.family == family]
        for family in ("Continuity", "GraphThread", "Arrival", "Rediscovery")
    }
    picked: list[_Candidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    for family in (tuple(by_family) * 3)[:limit]:
        _take(by_family[family], picked, counts)
    while len(picked) < limit:
        backfill = ("GraphThread", "Continuity", "Rediscovery", "Arrival")
        if not any([_take(by_family[f], picked, counts) for f in backfill if len(picked) < limit]):
            break
    return picked


def _take(
    remaining: list[_Candidate], picked: list[_Candidate], counts: Counter[tuple[str, object]]
) -> bool:
    """Take the best row that keeps every attribute under two, else the best row."""
    if not remaining:
        return False

    def attributes(c: _Candidate) -> list[tuple[str, object]]:
        return [
            (key, value)
            for key, value in (
                ("reason", c.reason),
                ("media_kind", c.media_kind),
                ("anchor", c.anchor),
                ("author", c.author),
            )
            if value is not None
        ]

    choice = next((c for c in remaining if all(counts[a] < 2 for a in attributes(c))), remaining[0])
    remaining.remove(choice)
    picked.append(choice)
    counts.update(attributes(choice))
    return True


def _hydrate(db: Session, viewer_id: UUID, picked: list[_Candidate]) -> list[SlateItemOut]:
    media_ids = [c.id for c in picked if c.scheme == "media"]
    media = media_service.hydrate_compact_media_targets(
        db, viewer_id=viewer_id, media_ids=media_ids
    )
    consumption = projection.consumption_for_media(db, viewer_id=viewer_id, media_ids=media_ids)
    podcasts = hydrate_compact_podcast_targets(
        db, viewer_id=viewer_id, podcast_ids=[c.id for c in picked if c.scheme == "podcast"]
    )
    items: list[SlateItemOut] = []
    for c in picked:
        if c.scheme == "media":
            target = media[c.id]
            items.append(
                SlateItemOut(
                    target=MediaSlateTargetOut(
                        ref=f"{c.scheme}:{c.id}",
                        media_summary=target.summary,
                        image_url=target.image_url,
                        href=target.href,
                    ),
                    consumption=consumption[c.id],
                )
            )
        else:
            podcast = podcasts[c.id]
            items.append(
                SlateItemOut(
                    target=PodcastSlateTargetOut(
                        ref=f"{c.scheme}:{c.id}",
                        title=podcast.title,
                        subtitle=podcast.subtitle,
                        image_url=podcast.image_url,
                        href=podcast.href,
                    ),
                    consumption=absent(),
                )
            )
    return items
