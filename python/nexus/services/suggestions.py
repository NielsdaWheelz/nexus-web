"""Suggestions: three deterministic next-read lists over one snapshot.

read-only, without provider calls; the caller's repeatable-read transaction makes
``now()`` one instant. SQL decides each target's one family (Continuity,
Arrival, then Rediscovery or GraphThread) and its order within it; a relational
target needs evidence from an anchor (Connected, SharedAuthor, Similar, in that
priority). Complete target and visibility facts are acquired once per caller-owned
snapshot and reused by semantic and final ranking; Python only composes.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    visible_content_credit_rows_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.schemas.suggestions import (
    MediaSuggestionTargetOut,
    PodcastSuggestionTargetOut,
    QuickReadsOut,
    SuggestionItemOut,
)
from nexus.services import highlights, libraries, library_entries, notes, reading_time
from nexus.services import media as media_service
from nexus.services.consumption import lectern, projection
from nexus.services.content_indexing import reading_chunks_sql
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.podcasts.subscriptions_query import (
    active_subscription_rows_sql,
    hydrate_compact_podcast_targets,
)
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.semantic import ChunkDomain, bounded_eligible_count, nearest_chunks

SUGGESTION_ANCHOR_LIMIT = 5
_PER_FAMILY = 20
_EDGE_ORIGINS = ["user", "citation", "note_body", "highlight_note", "document_embed", "discovery"]
# Human-reviewed calibration: a neighbour ranks only under this exact embedding
# identity at this similarity. Another model yields no Similar evidence.
_EMBEDDING = ("openai", "openai_text_embedding_3_small_256_v1", 256)
_MIN_SIMILARITY = 0.80

Surface = Literal["lectern", "library", "default_library"]


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


def build_quick_reads(db: Session, *, viewer_id: UUID) -> QuickReadsOut:
    """Up to five visible unfinished documents with under ten minutes left, Lectern members
    included: in progress first (most recently read), then newest added."""
    media_ids = db.scalars(
        text(f"""
            WITH eligible AS (
                SELECT d.media_id, COALESCE(part.source_media_id,m.id) AS family_id,
                       e.read_state,e.last_engaged_at,
                       COALESCE(source.created_at,m.created_at) AS source_recency,
                       m.kind='text_part' AS is_piece,
                       (e.last_engaged_at IS NOT NULL OR EXISTS (
                           SELECT 1 FROM consumption_queue_items q
                           WHERE q.media_id=m.id AND q.user_id=:viewer_id
                       ) OR EXISTS (
                           SELECT 1 FROM library_entries entry JOIN libraries library ON library.id=entry.library_id
                           JOIN memberships member ON member.library_id=library.id AND member.user_id=:viewer_id
                           WHERE entry.media_id=m.id AND library.system_key IS NULL
                       )) AS deliberate
                FROM ({reading_time.reading_time_rows_sql()}) d
                JOIN ({visible_media_ids_cte_sql()}) v ON v.media_id=d.media_id
                JOIN media m ON m.id=d.media_id
                LEFT JOIN media_parts part ON part.media_id=m.id
                LEFT JOIN media source ON source.id=part.source_media_id
                LEFT JOIN ({projection.engagement_fact_rows_sql()}) e ON e.media_id=d.media_id
                WHERE d.remaining_seconds>0 AND d.remaining_seconds<600
                  AND COALESCE(e.read_state,'Unread')<>'Finished'
            ), ranked AS (
                SELECT *,ROW_NUMBER() OVER (
                    PARTITION BY family_id,deliberate ORDER BY is_piece,media_id
                ) AS family_rank FROM eligible
            )
            SELECT media_id FROM ranked WHERE deliberate OR family_rank=1
            ORDER BY read_state='InProgress' DESC NULLS LAST,
                     last_engaged_at DESC NULLS LAST,source_recency DESC,media_id
            LIMIT 5
        """),
        {"viewer_id": viewer_id},
    ).all()
    picked = [ResourceRef("media", media_id) for media_id in media_ids]
    return QuickReadsOut(items=_hydrate(db, viewer_id, picked))


def suggestion_surface(db: Session, *, viewer_id: UUID, library_id: UUID | None) -> Surface | None:
    """Authorize a destination before inspecting its publication or candidates."""
    if library_id is None:
        return "lectern"
    context = libraries.access(db, viewer_id, library_id, lock=False)
    if context.system_key is not None or context.role != "admin":
        return None
    return "default_library" if context.is_default else "library"


def rank_suggestion_refs(
    db: Session, *, viewer_id: UUID, library_id: UUID | None = None
) -> list[ResourceRef]:
    """Exact ranking for one worker snapshot; the original ten lead the bounded pool."""
    surface = suggestion_surface(db, viewer_id=viewer_id, library_id=library_id)
    if surface is None:
        return []
    candidates = _candidates(db, viewer_id, surface, {"library_id": library_id})
    if library_id is None:
        return [ResourceRef(c.scheme, c.id) for c in _rotate(candidates, limit=80)]
    ordered = sorted(candidates, key=lambda c: (c.lane, c.lane_strength, c.scheme, c.id))
    picked: list[_Candidate] = []
    counts: Counter[tuple[str, object]] = Counter()
    while len(picked) < 80 and _take(ordered, picked, counts):
        pass
    return [ResourceRef(c.scheme, c.id) for c in picked]


def lectern_anchor_refs(db: Session, *, viewer_id: UUID) -> tuple[ResourceRef, ...]:
    """The five newest touched objects; engagement before highlights before notes."""
    media_reads = (
        projection.recent_engagement_anchor_facts,
        highlights.recent_highlight_anchor_facts,
    )
    facts = [
        (f.activity_at, tier, ResourceRef(scheme="media", id=f.media_id))
        for tier, read in enumerate(media_reads)
        for f in read(db, viewer_id=viewer_id, limit=SUGGESTION_ANCHOR_LIMIT)
    ]
    facts += [
        (f.activity_at, 2 if f.ref.scheme == "note_block" else 3, f.ref)
        for f in notes.recent_note_anchor_facts(
            db, viewer_id=viewer_id, limit=SUGGESTION_ANCHOR_LIMIT
        )
    ]
    facts.sort(key=lambda fact: (-fact[0].timestamp(), fact[1], fact[2].uri))
    return tuple(dict.fromkeys(ref for _, _, ref in facts))[:SUGGESTION_ANCHOR_LIMIT]


def _eligible_media_sql(surface: Surface) -> str:
    """A visible media `m` the destination may be offered. The lectern's predicate needs `e`,
    the viewer's engagement with `m`; a library's needs `held`, everything it holds."""
    if surface == "lectern":
        return f"""COALESCE(e.read_state, 'Unread') <> 'Finished'
            AND m.id NOT IN ({lectern.membership_rows_sql()})"""
    return "m.id NOT IN (SELECT media_id FROM held WHERE media_id IS NOT NULL)"


# A followed visible show `s` a named library does not file; needs `held`.
_ELIGIBLE_SHOW_SQL = (
    "s.podcast_id NOT IN (SELECT podcast_id FROM held WHERE podcast_id IS NOT NULL)"
)


def hydrate_current_suggestions(
    db: Session, *, viewer_id: UUID, library_id: UUID | None, refs: Sequence[ResourceRef]
) -> list[SuggestionItemOut]:
    """Revalidate only supplied identities; no ranking, graph or embedding acquisition."""
    surface = suggestion_surface(db, viewer_id=viewer_id, library_id=library_id)
    if surface is None or not refs:
        return []
    params = {
        "viewer_id": viewer_id,
        "library_id": library_id,
        "media_ids": [ref.id for ref in refs if ref.scheme == "media"],
        "podcast_ids": [ref.id for ref in refs if ref.scheme == "podcast"],
    }
    held = (
        ""
        if surface == "lectern"
        else f"WITH held AS ({library_entries.destination_membership_rows_sql()})"
    )
    engagement = (
        f"""LEFT JOIN ({projection.engagement_fact_rows_sql(media_ids_param="media_ids")}) e
        ON e.media_id = m.id"""
        if surface == "lectern"
        else ""
    )
    shows = f"""
        UNION ALL
        SELECT 'podcast', s.podcast_id FROM ({active_subscription_rows_sql()}) s
        JOIN ({visible_podcast_ids_cte_sql()}) visible USING (podcast_id)
        WHERE s.podcast_id = ANY(:podcast_ids) AND {_ELIGIBLE_SHOW_SQL}
    """
    eligible = {
        ResourceRef(row.scheme, row.id)
        for row in db.execute(
            text(f"""
                {held}
                SELECT 'media' AS scheme, m.id FROM media m
                JOIN ({visible_media_ids_cte_sql()}) visible ON visible.media_id = m.id
                {engagement}
                WHERE m.id = ANY(:media_ids) AND {_eligible_media_sql(surface)}
                {shows if surface == "library" else ""}
            """),
            params,
        )
    }
    return _hydrate(db, viewer_id, [ref for ref in refs if ref in eligible])


def _targets_sql(surface: Surface) -> str:
    """Target policy over caller CTEs visible, visible_podcasts, engagement, episodes,
    and held (library surfaces). Binds :viewer_id and, for libraries, :library_id.
    """
    on_lectern = surface == "lectern"
    podcasts = (
        f"""
        UNION ALL
        SELECT 'podcast', s.podcast_id, NULL, NULL, MAX(pe.published_at) FILTER (
                   WHERE pe.published_at <= now()), NULL, NULL,
               MAX(e.last_engaged_at) FILTER (WHERE e.last_engaged_at <= now())
        FROM ({active_subscription_rows_sql()}) s
        JOIN visible_podcasts vp USING (podcast_id)
        LEFT JOIN episodes pe
          ON pe.podcast_id = s.podcast_id AND pe.media_id IN (SELECT media_id FROM visible)
        LEFT JOIN engagement e ON e.media_id = pe.media_id
        WHERE {_ELIGIBLE_SHOW_SQL}
        GROUP BY s.podcast_id
        """
        if surface == "library"
        else ""
    )
    day = "to_char((now() AT TIME ZONE 'UTC')::date - {n}, 'YYYY-MM-DD')"
    return f"""
        WITH facts AS (
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
            WHERE {_eligible_media_sql(surface)}
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
                   WHEN {str(on_lectern).lower()} AND read_state = 'InProgress'
                        AND engaged_at >= now() - interval '30 days' THEN 'Continuity'
                   WHEN {str(on_lectern).lower()}
                        AND COALESCE(added_day, episode_day, published_day) IS NOT NULL
                        THEN 'Arrival'
                   WHEN GREATEST(CASE WHEN created_at <= now() THEN created_at END,
                                 CASE WHEN episode_at <= now() THEN episode_at END, engaged_at)
                        <= now() - interval '90 days' THEN 'Rediscovery'
                   ELSE 'GraphThread'
               END AS family
        FROM dated
    """


_TARGET_FIELDS = (
    ("target_scheme", "text"),
    ("target_id", "uuid"),
    ("media_kind", "text"),
    ("created_at", "timestamptz"),
    ("episode_at", "timestamptz"),
    ("published_on", "text"),
    ("read_state", "text"),
    ("engaged_at", "timestamptz"),
    ("added_day", "text"),
    ("episode_day", "text"),
    ("published_day", "text"),
    ("arrival_day", "text"),
    ("family", "text"),
)


@dataclass(frozen=True)
class _SnapshotFacts:
    anchors: tuple[ResourceRef, ...]
    targets: list[RowMapping]
    visible_media: list[UUID]
    visible_podcasts: list[UUID]


def _snapshot_facts(
    db: Session, viewer_id: UUID, surface: Surface, params: dict[str, object]
) -> _SnapshotFacts:
    """Capture complete canonical facts once inside this caller's RR; never retain across reads."""
    anchors = lectern_anchor_refs(db, viewer_id=viewer_id) if surface == "lectern" else ()
    held = (
        f"""held AS MATERIALIZED ({
            library_entries.destination_membership_rows_sql(
                visible_media_sql="SELECT media_id FROM visible_media"
            )
        }),"""
        "destination AS (SELECT * FROM held),"
        if surface != "lectern"
        else ""
    )
    anchor_rows = (
        library_entries.library_anchor_rows_sql()
        if surface != "lectern"
        else (
            "SELECT NULL::text AS target_scheme,NULL::uuid AS target_id,NULL::bigint AS ordinal WHERE false"
        )
    )
    empty = ",".join(f"NULL::{kind}" for _, kind in _TARGET_FIELDS[2:])
    rows = (
        db.execute(
            text(f"""
        WITH visible_media AS MATERIALIZED ({visible_media_ids_cte_sql()}),
        visible_podcasts AS MATERIALIZED ({
                visible_podcast_ids_cte_sql(visible_media_sql="SELECT media_id FROM visible_media")
            }),
        visible AS (SELECT media_id FROM visible_media),
        engagement AS MATERIALIZED ({projection.engagement_fact_rows_sql()}),
        episodes AS MATERIALIZED ({episode_publication_rows_sql()}),
        {held}
        targets AS ({_targets_sql(surface)}), anchor_rows AS ({anchor_rows})
        SELECT 'target' AS row_kind,NULL::bigint AS ordinal,t.*,
               COALESCE(p.source_media_id,t.target_id) AS source_id
        FROM targets t LEFT JOIN media_parts p ON p.media_id=t.target_id
        UNION ALL SELECT 'anchor',ordinal,target_scheme,target_id,{
                empty
            },NULL::uuid FROM anchor_rows
        UNION ALL SELECT 'visible_media',NULL,'media',media_id,{empty},NULL::uuid FROM visible_media
        UNION ALL SELECT 'visible_podcast',NULL,'podcast',podcast_id,{
                empty
            },NULL::uuid FROM visible_podcasts
    """),
            params | {"viewer_id": viewer_id, "anchor_limit": SUGGESTION_ANCHOR_LIMIT},
        )
        .mappings()
        .all()
    )
    if surface != "lectern":
        anchors = tuple(
            ResourceRef(row["target_scheme"], row["target_id"])
            for row in sorted(
                (row for row in rows if row["row_kind"] == "anchor"), key=lambda row: row["ordinal"]
            )
        )
    return _SnapshotFacts(
        anchors,
        [row for row in rows if row["row_kind"] == "target"],
        [row["target_id"] for row in rows if row["row_kind"] == "visible_media"],
        [row["target_id"] for row in rows if row["row_kind"] == "visible_podcast"],
    )


def _candidates(
    db: Session,
    viewer_id: UUID,
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
    facts = _snapshot_facts(db, viewer_id, surface, params)
    anchors = facts.anchors
    targets = (
        "SELECT * FROM unnest("
        + ",".join(f"CAST(:target_{name} AS {kind}[])" for name, kind in _TARGET_FIELDS)
        + ") AS t("
        + ",".join(name for name, _ in _TARGET_FIELDS)
        + ")"
    )
    readings = list(
        dict.fromkeys(
            (row["target_id"], row["family"], row["source_id"])
            for row in facts.targets
            if row["target_scheme"] == "media" and row["family"] in ("GraphThread", "Rediscovery")
        )
    )
    params = {
        "viewer_id": viewer_id,
        "anchor_schemes": [anchor.scheme for anchor in anchors],
        "anchor_ids": [anchor.id for anchor in anchors],
        "anchor_ranks": list(range(len(anchors))),
        "similar": json.dumps(_similar(db, viewer_id, anchors, readings, params)),
        "visible_media_ids": facts.visible_media,
        "visible_podcast_ids": facts.visible_podcasts,
        **{f"target_{name}": [row[name] for row in facts.targets] for name, _ in _TARGET_FIELDS},
        "origins": _EDGE_ORIGINS,
        **params,
    }
    rows = db.execute(
        text(f"""
            WITH targets AS ({targets}),
            anchors AS (
                SELECT * FROM unnest(CAST(:anchor_schemes AS text[]),
                    CAST(:anchor_ids AS uuid[]), CAST(:anchor_ranks AS integer[]))
                    AS a(scheme, id, rank)
            ),
            edges AS (
                SELECT * FROM resource_edges e
                WHERE user_id = :viewer_id AND origin = ANY(:origins) AND {edge_live_sql("e")}
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
            credit_visible_media AS (SELECT unnest(CAST(:visible_media_ids AS uuid[])) AS media_id),
            credit_visible_podcasts AS (SELECT unnest(CAST(:visible_podcast_ids AS uuid[])) AS podcast_id),
            authors AS NOT MATERIALIZED (
                SELECT vcc.contributor_id, vcc.media_id, vcc.podcast_id
                FROM ({
            visible_content_credit_rows_sql(
                visible_media="credit_visible_media", visible_podcasts="credit_visible_podcasts"
            )
        }) vcc
                WHERE vcc.role='author'
                  AND (vcc.media_id IS NOT NULL OR vcc.podcast_id IS NOT NULL)
            ),
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


def _reading_membership(
    readings: Sequence[tuple[UUID, str, UUID]],
    family: str,
    excluded_ids: set[UUID],
    *,
    prefix: str,
) -> tuple[str, str, dict[str, object]]:
    """Same-snapshot own/piece admission; callers give each family a distinct bind prefix."""
    selected = [row for row in readings if row[1] == family and row[0] not in excluded_ids]
    direct_ids = [media_id for media_id, _, _ in selected]
    piece_ids = [media_id for media_id, _, source_id in selected if media_id != source_id]
    params: dict[str, object] = {
        f"{prefix}direct_ids": direct_ids,
        f"{prefix}piece_ids": piece_ids,
        f"{prefix}source_ids": list({row[2] for row in selected} | set(direct_ids)),
    }
    direct = f"cc.owner_id=ANY(CAST(:{prefix}direct_ids AS uuid[]))"
    membership = direct
    projection = f"SELECT cc.owner_id AS reading_media_id,cc.id AS chunk_id WHERE {direct}"
    if piece_ids:
        pieces = reading_chunks_sql(f"""SELECT p.media_id FROM media_parts p
            WHERE p.source_media_id=cc.owner_id
              AND p.media_id=ANY(CAST(:{prefix}piece_ids AS uuid[]))""")
        membership = f"""cc.owner_id=ANY(CAST(:{prefix}source_ids AS uuid[])) AND (
            ({direct}) OR EXISTS (SELECT 1 FROM ({pieces}) admitted
                WHERE admitted.chunk_id=cc.id OFFSET 0))"""
        projection += f""" UNION ALL SELECT reading_media_id,chunk_id
            FROM ({pieces}) piece_admission WHERE chunk_id=cc.id"""
    return f"cc.owner_kind='media' AND ({membership})", projection, params


def _similar(
    db: Session,
    viewer_id: UUID,
    anchors: tuple[ResourceRef, ...],
    eligible_readings: Sequence[tuple[UUID, str, UUID]],
    params: dict[str, object],
) -> list[dict[str, object]]:
    """approximate candidate membership, exact calibrated scores and reading projection.

    Preserve original anchor ordinals and each first admitted stored vector.
    Whole-only counts excluding ALL anchors prove lower bounds for each actual
    family domain, which excludes only the current reading. Pieces retain the
    canonical bounds owned by reading_chunks_sql. Families share one ANN traversal
    per anchor while keeping independent admission, routing and 400-chunk windows.
    No provider runs in this scope.
    """
    media_anchors = [
        (rank, anchor.id) for rank, anchor in enumerate(anchors) if anchor.scheme == "media"
    ]
    if not media_anchors:
        return []
    provider, model, dimensions = _EMBEDDING
    bindings = {
        **params,
        "viewer_id": viewer_id,
        "anchor_ids": [media_id for _, media_id in media_anchors],
        "anchor_ranks": [rank for rank, _ in media_anchors],
        "embedding_provider": provider,
        "embedding_model": model,
        "embedding_dimensions": dimensions,
    }
    stored_anchors = db.execute(
        text(f"""
        WITH anchors AS (
            SELECT * FROM unnest(CAST(:anchor_ids AS uuid[]), CAST(:anchor_ranks AS integer[]))
                AS a(id, rank)
        ), anchor_chunks AS ({reading_chunks_sql("SELECT a.id AS media_id FROM anchors a JOIN media_parts p ON p.media_id=a.id")})
        SELECT a.id,a.rank,first_chunk.id AS chunk_id,ce.embedding_vector::text AS vector_text
        FROM anchors a
        JOIN content_index_states cis ON cis.owner_kind='media' AND cis.owner_id=a.id
            AND cis.status='ready' AND (cis.lexical_revision=cis.revision) IS TRUE
            AND cis.active_embedding_provider=:embedding_provider
            AND cis.active_embedding_model=:embedding_model
        CROSS JOIN LATERAL (
            SELECT cc.id FROM content_chunks cc
            WHERE cc.owner_kind='media' AND cc.owner_id=a.id
            ORDER BY cc.chunk_idx,cc.id LIMIT 1
        ) first_chunk
        JOIN content_embeddings ce ON ce.chunk_id=first_chunk.id
            AND ce.embedding_provider=:embedding_provider
            AND ce.embedding_model=:embedding_model
            AND ce.embedding_dimensions=:embedding_dimensions
            AND ce.embedding_vector IS NOT NULL
        WHERE NOT EXISTS (SELECT 1 FROM media_parts p WHERE p.media_id=a.id)
        UNION ALL
        SELECT a.id,a.rank,av.chunk_id,av.vector_text FROM anchors a
        CROSS JOIN LATERAL (
            SELECT cc.id AS chunk_id, ce.embedding_vector::text AS vector_text
            FROM anchor_chunks admitted
            JOIN content_chunks cc ON cc.id=admitted.chunk_id
            JOIN content_embeddings ce ON ce.chunk_id=cc.id
            JOIN content_index_states cis ON cis.owner_kind=cc.owner_kind
                AND cis.owner_id=cc.owner_id AND cis.status='ready'
                AND (cis.lexical_revision=cis.revision) IS TRUE
                AND cis.active_embedding_provider=:embedding_provider
                AND cis.active_embedding_model=:embedding_model
            WHERE admitted.reading_media_id=a.id AND cc.owner_kind='media'
                AND ce.embedding_provider=:embedding_provider
                AND ce.embedding_model=:embedding_model
                AND ce.embedding_dimensions=:embedding_dimensions
                AND ce.embedding_vector IS NOT NULL
            ORDER BY cc.chunk_idx,cc.id LIMIT 1
        ) av
        WHERE EXISTS (SELECT 1 FROM media_parts p WHERE p.media_id=a.id)
        ORDER BY 2
    """),
        bindings,
    ).all()
    if not stored_anchors:
        return []
    excluded_all = {anchor.id for anchor in anchors if anchor.scheme == "media"}
    # Whole-only, all-anchor-excluded chunks are a subset of every self-only
    # domain, even when another eligible piece shares an anchor's parent.
    whole_readings = [row for row in eligible_readings if row[0] == row[2]]
    families = (("GraphThread", "graph_"), ("Rediscovery", "rediscovery_"))
    lower_bounds: dict[str, int] = {}
    for family, prefix in families:
        owner, _, proof_params = _reading_membership(
            whole_readings, family, excluded_all, prefix=prefix
        )
        lower_bounds[family] = (
            bounded_eligible_count(
                db, model=model, owner=owner, params=bindings | proof_params, ctes=""
            )
            if proof_params[f"{prefix}direct_ids"]
            else 0
        )
    rows: list[tuple[float, int, UUID]] = []
    for anchor_id, rank, anchor_chunk_id, vector_text in stored_anchors:
        domains = []
        projections = []
        local = bindings | {"anchor_chunk_id": anchor_chunk_id}
        for family, prefix in families:
            owner, chunk_readings, membership_params = _reading_membership(
                eligible_readings, family, {anchor_id}, prefix=prefix
            )
            domains.append(
                ChunkDomain(owner=owner, eligible_count_lower_bound=lower_bounds[family])
            )
            projections.append(chunk_readings)
            local.update(membership_params)
        windows = nearest_chunks(
            db,
            (model, json.loads(vector_text)),
            domains=domains,
            params=local,
            limit=400,
            ctes="",
            maximum_distance=1 - _MIN_SIMILARITY,
        )
        for chunk_readings, candidates in zip(projections, windows, strict=True):
            if not candidates:
                continue
            scored = db.execute(
                text(f"""
                WITH retained AS (
                    SELECT admitted.reading_media_id AS peer_id,
                           ce.embedding_vector <=> av.embedding_vector AS distance
                    FROM content_embeddings ce
                    JOIN content_chunks cc ON cc.id=ce.chunk_id
                    JOIN LATERAL (SELECT * FROM ({chunk_readings}) family_admission WHERE family_admission.chunk_id=cc.id OFFSET 0) admitted ON true
                    JOIN content_embeddings av ON av.chunk_id=:anchor_chunk_id
                        AND av.embedding_provider=:embedding_provider
                        AND av.embedding_model=:embedding_model
                        AND av.embedding_dimensions=:embedding_dimensions
                    WHERE ce.chunk_id=ANY(CAST(:candidate_ids AS uuid[]))
                        AND ce.embedding_provider=:embedding_provider
                        AND ce.embedding_model=:embedding_model
                        AND ce.embedding_dimensions=:embedding_dimensions
                        AND ce.embedding_vector IS NOT NULL
                        AND ce.embedding_vector <=> av.embedding_vector <= :max_distance
                    ORDER BY distance,admitted.reading_media_id,ce.chunk_id LIMIT 400
                ) SELECT peer_id,MIN(distance) FROM retained GROUP BY peer_id
            """),
                local
                | {
                    "candidate_ids": [chunk_id for chunk_id, _ in candidates],
                    "max_distance": 1 - _MIN_SIMILARITY,
                },
            )
            rows.extend((float(distance), rank, peer_id) for peer_id, distance in scored)
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
    for family in (tuple(by_family) * 3)[: min(limit, 10)]:
        _take(by_family[family], picked, counts)
    # Finish the original ten before extending: otherwise empty initial-family
    # turns can move the old backfill rows and change the first page.
    for stop in (min(limit, 10), limit):
        while len(picked) < stop:
            backfill = ("GraphThread", "Continuity", "Rediscovery", "Arrival")
            if not any(
                [_take(by_family[f], picked, counts) for f in backfill if len(picked) < stop]
            ):
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


def _hydrate(
    db: Session, viewer_id: UUID, picked: Sequence[ResourceRef]
) -> list[SuggestionItemOut]:
    media = media_service.hydrate_compact_media_targets(
        db, viewer_id=viewer_id, media_ids=[c.id for c in picked if c.scheme == "media"]
    )
    podcasts = hydrate_compact_podcast_targets(
        db, viewer_id=viewer_id, podcast_ids=[c.id for c in picked if c.scheme == "podcast"]
    )
    return [
        SuggestionItemOut(
            target=MediaSuggestionTargetOut(
                kind="Media",
                ref=f"media:{c.id}",
                media_summary=media[c.id].summary,
                href=media[c.id].href,
            )
            if c.scheme == "media"
            else PodcastSuggestionTargetOut(
                kind="Podcast",
                ref=f"podcast:{c.id}",
                title=podcasts[c.id].title,
                subtitle=podcasts[c.id].subtitle,
                href=podcasts[c.id].href,
            )
        )
        for c in picked
    ]
