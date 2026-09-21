"""Anchor selection and the bounded acquisition SQL behind one Slate read.

Every lane joins a viewer-visibility relation owned by another module, is
capped at ``SLATE_FAMILY_CANDIDATE_LIMIT`` per contextual family, and measures
every window against the caller's single ``as_of`` instant. Each relational
lane emits its rows in strength order, and that position becomes the evidence
value's ``rank``: the one place any of these orders is decided.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.services import highlights, library_entries, notes
from nexus.services.consumption import projection
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.resonance._slate import (
    ARRIVAL_WINDOW_DAYS,
    CONTINUITY_MAX_IDLE_DAYS,
    REDISCOVERY_MIN_AGE_DAYS,
    RESONANCE_EDGE_ORIGINS,
    SEMANTIC_DIMENSIONS,
    SEMANTIC_MIN_SIMILARITY,
    SEMANTIC_MODEL,
    SEMANTIC_PROVIDER,
    SLATE_ANCHOR_LIMIT,
    SLATE_FAMILY_CANDIDATE_LIMIT,
    Anchor,
    ArrivalEvidence,
    CandidateEvidence,
    ContinuityEvidence,
    EdgeEvidence,
    RelationEvidence,
    SemanticEvidence,
    SharedAuthorEvidence,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.semantic_chunks import media_neighbor_rows_sql

SEMANTIC_CHUNK_CANDIDATE_MULTIPLIER = 20
SEMANTIC_CHUNK_CANDIDATE_MINIMUM = 100


# The one reading of ``media.original_published_date`` as a real calendar day.
def exact_day_date_sql(value_sql: str) -> str:
    """A total PostgreSQL expression: the column as a date, or NULL."""
    year = f"substring({value_sql} from 1 for 4)::integer"
    month = f"substring({value_sql} from 6 for 2)::integer"
    day = f"substring({value_sql} from 9 for 2)::integer"
    last_day = f"""
        CASE
            WHEN {month} = 2 THEN
                CASE
                    WHEN {year} % 400 = 0
                      OR ({year} % 4 = 0 AND {year} % 100 <> 0)
                    THEN 29
                    ELSE 28
                END
            WHEN {month} IN (4, 6, 9, 11) THEN 30
            ELSE 31
        END
    """
    return f"""
        CASE
            WHEN {value_sql} ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$' THEN
                CASE
                    WHEN {year} BETWEEN 1 AND 9999
                     AND {month} BETWEEN 1 AND 12
                     AND {day} BETWEEN 1 AND ({last_day})
                    THEN make_date({year}, {month}, {day})
                END
        END
    """


def capture_as_of(db: Session) -> datetime:
    """The request snapshot's single authoritative UTC instant."""
    return db.execute(text("SELECT now()")).scalar_one().astimezone(UTC)


def lectern_anchors(db: Session, *, viewer_id: UUID) -> tuple[Anchor, ...]:
    """The five newest objects the viewer touched, engagement before notes."""
    gathered: list[tuple[datetime, int, ResourceRef]] = []
    for fact in projection.recent_engagement_anchor_facts(
        db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT
    ):
        gathered.append((fact.activity_at, 0, ResourceRef(scheme="media", id=fact.media_id)))
    for fact in highlights.recent_highlight_anchor_facts(
        db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT
    ):
        gathered.append((fact.activity_at, 1, ResourceRef(scheme="media", id=fact.media_id)))
    for note_fact in notes.recent_note_anchor_facts(
        db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT
    ):
        source_priority = 2 if note_fact.ref.scheme == "note_block" else 3
        gathered.append((note_fact.activity_at, source_priority, note_fact.ref))
    gathered.sort(key=lambda row: (-row[0].timestamp(), row[1], row[2].uri))
    refs: list[ResourceRef] = []
    seen: set[str] = set()
    for _, _, ref in gathered:
        if ref.uri in seen:
            continue
        seen.add(ref.uri)
        refs.append(ref)
        if len(refs) == SLATE_ANCHOR_LIMIT:
            break
    return tuple(Anchor(ref=ref, rank=rank) for rank, ref in enumerate(refs))


def library_anchors(db: Session, *, viewer_id: UUID, library_id: UUID) -> tuple[Anchor, ...]:
    refs = library_entries.library_anchor_facts(
        db, viewer_id=viewer_id, library_id=library_id, limit=SLATE_ANCHOR_LIMIT
    )
    return tuple(Anchor(ref=ref, rank=rank) for rank, ref in enumerate(refs))


def acquire_slate_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    as_of: datetime,
    anchors: tuple[Anchor, ...],
    target_relation: str,
    relation_params: dict[str, object],
    surface: Literal["lectern", "library"],
) -> list[CandidateEvidence]:
    """One bounded evidence union over the surface's eligible-target relation.

    ``target_relation`` is checked-in SQL exposing one row per eligible target.
    Lectern also takes the two non-relational lanes and, because a candidate
    belongs to exactly one family, keeps their targets out of the relational
    lanes so those lanes spend their budget on relational candidates.
    """
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "as_of": as_of,
        "continuity_days": CONTINUITY_MAX_IDLE_DAYS,
        "arrival_days": ARRIVAL_WINDOW_DAYS,
        "arrival_calendar_days": ARRIVAL_WINDOW_DAYS - 1,
        "rediscovery_days": REDISCOVERY_MIN_AGE_DAYS,
        **relation_params,
    }
    lectern = surface == "lectern"
    candidate_refs: dict[str, ResourceRef] = {}
    if lectern:
        for media_id in _nonrelational_media_ids(db, target_relation, params=params):
            ref = ResourceRef(scheme="media", id=media_id)
            candidate_refs.setdefault(ref.uri, ref)

    relational = _relational_target_relation(target_relation, exclude_nonrelational=lectern)
    anchor_by_rank = {anchor.rank: anchor for anchor in anchors}
    relations: dict[str, RelationEvidence] = {}

    for rank, row in enumerate(
        _edge_rows(db, viewer_id=viewer_id, anchors=anchors, relation=relational, params=params)
    ):
        ref = _target_ref(row)
        candidate_refs.setdefault(ref.uri, ref)
        relations[ref.uri] = EdgeEvidence(
            anchor=anchor_by_rank[int(row["anchor_rank"])],
            rank=rank,
        )

    for rank, row in enumerate(
        _shared_author_rows(
            db,
            viewer_id=viewer_id,
            anchors=anchors,
            relation=relational,
            params=params,
            library_secondary=not lectern,
        )
    ):
        ref = _target_ref(row)
        candidate_refs.setdefault(ref.uri, ref)
        relations.setdefault(
            ref.uri,
            SharedAuthorEvidence(
                anchor=anchor_by_rank[int(row["anchor_rank"])],
                rank=rank,
                author_id=UUID(str(row["first_author_id"])),
            ),
        )

    for rank, row in enumerate(
        _semantic_rows(
            db,
            viewer_id=viewer_id,
            anchors=anchors,
            relation=relational,
            params=params,
            library_secondary=not lectern,
        )
    ):
        ref = ResourceRef(scheme="media", id=UUID(str(row["peer_media_id"])))
        candidate_refs.setdefault(ref.uri, ref)
        relations.setdefault(
            ref.uri,
            SemanticEvidence(anchor=anchor_by_rank[int(row["anchor_rank"])], rank=rank),
        )

    refs = list(candidate_refs.values())
    if not refs:
        return []
    facts = {
        _target_ref(row).uri: row
        for row in _target_fact_rows(
            db, viewer_id=viewer_id, refs=refs, relation=target_relation, params=params
        )
    }
    return [_candidate(ref, facts[ref.uri], relations.get(ref.uri), as_of=as_of) for ref in refs]


def _candidate(
    ref: ResourceRef, row: Any, relation: RelationEvidence | None, *, as_of: datetime
) -> CandidateEvidence:
    engaged = row["last_engaged_at"]
    created_at = row["created_at"]
    published_at = row["published_at"]
    arrivals: list[ArrivalEvidence] = []
    if created_at is not None:
        arrivals.append(
            ArrivalEvidence(
                kind="AddedToNexus",
                occurred_on=created_at.astimezone(UTC).date(),
                occurred_at=created_at,
            )
        )
    if row["published_on"] is not None:
        arrivals.append(
            ArrivalEvidence(kind="Published", occurred_on=row["published_on"], occurred_at=None)
        )
    if published_at is not None:
        arrivals.append(
            ArrivalEvidence(
                kind="NewEpisode",
                occurred_on=published_at.astimezone(UTC).date(),
                occurred_at=published_at,
            )
        )
    exact_activity = [
        fact for fact in (created_at, published_at, engaged) if fact is not None and fact <= as_of
    ]
    media_kind = row["media_kind"]
    return CandidateEvidence(
        target_ref=ref,
        media_kind=MediaKind(str(media_kind)) if media_kind is not None else None,
        continuity=(
            ContinuityEvidence(last_engaged_at=engaged)
            if row["read_state"] == "InProgress" and engaged is not None
            else None
        ),
        arrivals=tuple(arrivals),
        relation=relation,
        latest_exact_activity_at=max(exact_activity) if exact_activity else None,
    )


# The windows every lane measures against the caller's single :as_of instant.
_CONTINUITY_WINDOW = (
    "read_state = 'InProgress' AND last_engaged_at"
    " BETWEEN :as_of - :continuity_days * interval '1 day' AND :as_of"
)
_PUBLISHED_ON_WINDOW = (
    "published_on BETWEEN (:as_of AT TIME ZONE 'UTC')::date - :arrival_calendar_days"
    " AND (:as_of AT TIME ZONE 'UTC')::date"
)


def _arrival_window(column: str) -> str:
    return f"{column} BETWEEN :as_of - :arrival_days * interval '1 day' AND :as_of"


def _exact_instant(column: str) -> str:
    return f"CASE WHEN {column} <= :as_of THEN {column} END"


def _nonrelational_media_ids(
    db: Session, target_relation: str, *, params: dict[str, object]
) -> list[UUID]:
    """Lectern's two direct lanes: what is in progress, and what just arrived."""
    media_targets = f"""
        SELECT
            target_id AS media_id, created_at, original_published_date,
            read_state, last_engaged_at, published_at
        FROM ({target_relation}) targets
        WHERE target_scheme = 'media'
    """
    continuity = db.execute(
        text(f"""
            WITH eligible_media AS ({media_targets})
            SELECT media_id
            FROM eligible_media
            WHERE {_CONTINUITY_WINDOW}
            ORDER BY last_engaged_at DESC, media_id ASC
            LIMIT {SLATE_FAMILY_CANDIDATE_LIMIT}
        """),
        params,
    ).mappings()
    arrival = db.execute(
        text(f"""
            WITH eligible_media AS ({media_targets}),
            dated AS (
                SELECT
                    eligible_media.*,
                    CASE WHEN {_arrival_window("created_at")}
                        THEN (created_at AT TIME ZONE 'UTC')::date END AS added_on,
                    CASE WHEN {_arrival_window("published_at")}
                        THEN (published_at AT TIME ZONE 'UTC')::date END AS episode_on,
                    CASE WHEN {_PUBLISHED_ON_WINDOW} THEN published_on END AS media_published_on
                FROM (
                    SELECT
                        eligible_media.*,
                        ({exact_day_date_sql("original_published_date")}) AS published_on
                    FROM eligible_media
                ) eligible_media
            ),
            arrived AS (
                SELECT dated.*, GREATEST(added_on, episode_on, media_published_on) AS arrived_on
                FROM dated
                WHERE added_on IS NOT NULL
                   OR episode_on IS NOT NULL
                   OR media_published_on IS NOT NULL
            )
            SELECT media_id
            FROM arrived
            WHERE NOT COALESCE({_CONTINUITY_WINDOW}, false)
            ORDER BY
                arrived_on DESC,
                CASE
                    WHEN episode_on IS NOT NULL THEN 0
                    WHEN media_published_on IS NOT NULL THEN 1
                    ELSE 2
                END,
                GREATEST(
                    CASE WHEN added_on = arrived_on THEN created_at END,
                    CASE WHEN episode_on = arrived_on THEN published_at END
                ) DESC NULLS LAST,
                media_id ASC
            LIMIT {SLATE_FAMILY_CANDIDATE_LIMIT}
        """),
        params,
    ).mappings()
    return [UUID(str(row["media_id"])) for row in (*continuity, *arrival)]


def _relational_target_relation(target_relation: str, *, exclude_nonrelational: bool) -> str:
    """Eligible targets plus their contextual family and exact arrival instant.

    ``exclude_nonrelational`` drops the targets Lectern renders under
    continuity or arrival instead, so the relational lanes spend their whole
    budget on relational candidates.
    """
    exclusion = (
        f"""
            AND NOT COALESCE({_CONTINUITY_WINDOW}, false)
            AND NOT (
                COALESCE({_arrival_window("created_at")}, false)
                OR COALESCE({_arrival_window("published_at")}, false)
                OR COALESCE({_PUBLISHED_ON_WINDOW}, false)
            )
        """
        if exclude_nonrelational
        else ""
    )
    return f"""
        WITH normalized AS (
            SELECT
                eligible_targets.*,
                ({exact_day_date_sql("original_published_date")}) AS published_on
            FROM ({target_relation}) eligible_targets
        )
        SELECT
            normalized.*,
            GREATEST({_exact_instant("created_at")}, {_exact_instant("published_at")})
                AS latest_exact_arrival_at,
            CASE
                WHEN GREATEST(
                    {_exact_instant("created_at")},
                    {_exact_instant("published_at")},
                    {_exact_instant("last_engaged_at")}
                ) <= :as_of - :rediscovery_days * interval '1 day'
                THEN 'Rediscovery'
                ELSE 'GraphThread'
            END AS slate_family
        FROM normalized
        WHERE true
        {exclusion}
    """


_EDGE_STRENGTH_ORDER = """
    array_position(CAST(:edge_origins AS text[]), edge_origin),
    created_at DESC,
    CASE edge_kind WHEN 'context' THEN 0 WHEN 'supports' THEN 1 ELSE 2 END,
    edge_id ASC,
    anchor_rank ASC,
    target_scheme ASC,
    target_id ASC
"""


def _edge_rows(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[Anchor, ...],
    relation: str,
    params: dict[str, object],
) -> list[Any]:
    """One row per eligible target reachable from an anchor by one graph edge.

    Both endpoints are normalized to their owning object, so a highlight or a
    passage of a work connects that work. Strength ends in a unique edge id,
    so one cap serves both surfaces.
    """
    if not anchors:
        return []
    rows = db.execute(
        text(f"""
            WITH anchors AS (
                SELECT scheme, id, rank
                FROM jsonb_to_recordset(CAST(:anchors AS jsonb))
                    AS x(scheme text, id uuid, rank integer)
            ),
            edges AS (
                SELECT e.id AS edge_id, e.kind AS edge_kind, e.origin AS edge_origin,
                       e.source_scheme, e.source_id, e.target_scheme, e.target_id, e.created_at
                FROM resource_edges e
                WHERE e.user_id = :viewer_id AND e.origin = ANY(:edge_origins)
            ),
            edge_endpoints AS (
                SELECT source_scheme AS scheme, source_id AS id FROM edges
                UNION
                SELECT target_scheme, target_id FROM edges
            ),
            owners AS ({_resource_owner_rows_sql()}),
            eligible_targets AS ({relation}),
            incident AS (
                SELECT pair.anchor_scheme, pair.anchor_id, pair.target_scheme, pair.target_id,
                       edges.edge_id, edges.edge_kind, edges.edge_origin, edges.created_at
                FROM edges
                JOIN owners source_owner
                  ON source_owner.resource_scheme = edges.source_scheme
                 AND source_owner.resource_id = edges.source_id
                JOIN owners target_owner
                  ON target_owner.resource_scheme = edges.target_scheme
                 AND target_owner.resource_id = edges.target_id
                -- One edge is incident both ways: either owner can be the anchor.
                CROSS JOIN LATERAL (
                    VALUES
                        (source_owner.owner_scheme, source_owner.owner_id,
                         target_owner.owner_scheme, target_owner.owner_id),
                        (target_owner.owner_scheme, target_owner.owner_id,
                         source_owner.owner_scheme, source_owner.owner_id)
                ) AS pair(anchor_scheme, anchor_id, target_scheme, target_id)
            ),
            qualified AS (
                SELECT incident.target_scheme, incident.target_id, eligible.slate_family,
                       anchors.rank AS anchor_rank, incident.edge_id, incident.edge_kind,
                       incident.edge_origin, incident.created_at
                FROM incident
                JOIN anchors
                  ON anchors.scheme = incident.anchor_scheme AND anchors.id = incident.anchor_id
                JOIN eligible_targets eligible
                  ON eligible.target_scheme = incident.target_scheme
                 AND eligible.target_id = incident.target_id
                WHERE (incident.target_scheme, incident.target_id)
                    <> (incident.anchor_scheme, incident.anchor_id)
            ),
            strongest_per_target AS (
                SELECT DISTINCT ON (target_scheme, target_id) *
                FROM qualified
                ORDER BY target_scheme, target_id, {_EDGE_STRENGTH_ORDER}
            )
            SELECT * FROM (
                SELECT strongest_per_target.*,
                       ROW_NUMBER() OVER (
                           PARTITION BY slate_family ORDER BY {_EDGE_STRENGTH_ORDER}
                       ) AS family_rank
                FROM strongest_per_target
            ) ranked
            WHERE family_rank <= {SLATE_FAMILY_CANDIDATE_LIMIT}
            ORDER BY {_EDGE_STRENGTH_ORDER}
        """),
        {
            "viewer_id": viewer_id,
            "anchors": _anchors_json(anchors),
            "edge_origins": list(RESONANCE_EDGE_ORIGINS),
            **params,
        },
    ).mappings()
    return list(rows)


def _shared_author_rows(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[Anchor, ...],
    relation: str,
    params: dict[str, object],
    library_secondary: bool,
) -> list[Any]:
    """One row per eligible target sharing an author with an anchor.

    Strength is the shared-author count; Library breaks its ties by engagement
    and arrival recency, which Lectern instead reaches through its families.
    """
    author_anchors = tuple(
        anchor for anchor in anchors if anchor.ref.scheme in ("media", "podcast")
    )
    if not author_anchors:
        return []
    secondary = (
        "last_engaged_at DESC NULLS LAST, latest_exact_arrival_at DESC NULLS LAST,"
        if library_secondary
        else ""
    )
    strength = f"""
        author_count DESC, first_author_id ASC, {secondary}
        anchor_rank ASC, target_scheme ASC, target_id ASC
    """
    rows = db.execute(
        text(f"""
            WITH anchors AS (
                SELECT scheme, id, rank
                FROM jsonb_to_recordset(CAST(:anchors AS jsonb))
                    AS x(scheme text, id uuid, rank integer)
            ),
            authors AS ({visible_author_credit_rows_sql()}),
            eligible_targets AS ({relation}),
            pairs AS (
                SELECT DISTINCT
                    eligible.target_scheme, eligible.target_id, eligible.slate_family,
                    anchors.rank AS anchor_rank, eligible.last_engaged_at,
                    eligible.latest_exact_arrival_at, target_author.contributor_id
                FROM anchors
                JOIN authors anchor_author ON (
                    (anchors.scheme = 'media' AND anchor_author.media_id = anchors.id)
                    OR (anchors.scheme = 'podcast' AND anchor_author.podcast_id = anchors.id)
                )
                JOIN authors target_author
                  ON target_author.contributor_id = anchor_author.contributor_id
                JOIN eligible_targets eligible ON (
                    (eligible.target_scheme = 'media'
                     AND eligible.target_id = target_author.media_id)
                    OR (eligible.target_scheme = 'podcast'
                     AND eligible.target_id = target_author.podcast_id)
                )
                WHERE (eligible.target_scheme, eligible.target_id)
                    <> (anchors.scheme, anchors.id)
            ),
            pair_strength AS (
                SELECT
                    target_scheme, target_id, slate_family, anchor_rank,
                    last_engaged_at, latest_exact_arrival_at, COUNT(*) AS author_count,
                    (ARRAY_AGG(contributor_id ORDER BY contributor_id ASC))[1] AS first_author_id
                FROM pairs
                GROUP BY
                    target_scheme, target_id, slate_family, anchor_rank,
                    last_engaged_at, latest_exact_arrival_at
            ),
            strongest_per_target AS (
                SELECT DISTINCT ON (target_scheme, target_id) *
                FROM pair_strength
                ORDER BY target_scheme, target_id, {strength}
            ),
            ranked AS (
                SELECT strongest_per_target.*,
                       ROW_NUMBER() OVER (
                           PARTITION BY slate_family ORDER BY {strength}
                       ) AS family_rank
                FROM strongest_per_target
            )
            SELECT ranked.*
            FROM ranked
            WHERE ranked.family_rank <= {SLATE_FAMILY_CANDIDATE_LIMIT}
            ORDER BY {strength}
        """),
        {"viewer_id": viewer_id, "anchors": _anchors_json(author_anchors), **params},
    ).mappings()
    return list(rows)


def _semantic_rows(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[Anchor, ...],
    relation: str,
    params: dict[str, object],
    library_secondary: bool,
) -> list[dict[str, Any]]:
    """Calibrated nearest media neighbours of each media anchor, best first.

    A row qualifies only under the checked-in embedding identity: a
    re-embedding under another model drops out rather than ranking.
    """
    eligible_context = f"""
        SELECT
            target_id AS media_id,
            slate_family AS candidate_partition,
            last_engaged_at,
            latest_exact_arrival_at
        FROM ({relation}) relational_targets
        WHERE target_scheme = 'media'
    """
    qualified: list[dict[str, Any]] = []
    for anchor in anchors:
        if anchor.ref.scheme != "media":
            continue
        rows = db.execute(
            text(f"""
                WITH eligible_context AS ({eligible_context}),
                neighbors AS ({
                media_neighbor_rows_sql('''
                    SELECT media_id, candidate_partition
                    FROM eligible_context
                ''')
            })
                SELECT
                    neighbors.*,
                    eligible_context.last_engaged_at,
                    eligible_context.latest_exact_arrival_at
                FROM neighbors
                JOIN eligible_context
                  ON eligible_context.media_id = neighbors.peer_media_id
                 AND eligible_context.candidate_partition = neighbors.candidate_partition
            """),
            {
                "viewer_id": viewer_id,
                "anchor_media_id": anchor.ref.id,
                "embedding_dimensions": SEMANTIC_DIMENSIONS,
                "candidate_limit": max(
                    SLATE_FAMILY_CANDIDATE_LIMIT * SEMANTIC_CHUNK_CANDIDATE_MULTIPLIER,
                    SEMANTIC_CHUNK_CANDIDATE_MINIMUM,
                ),
                **params,
            },
        ).mappings()
        for row in rows:
            similarity = 1.0 - float(row["distance"])
            if (
                str(row["embedding_provider"]) == SEMANTIC_PROVIDER
                and str(row["embedding_model"]) == SEMANTIC_MODEL
                and int(row["embedding_dimensions"]) == SEMANTIC_DIMENSIONS
                and math.isfinite(similarity)
                and similarity >= SEMANTIC_MIN_SIMILARITY
            ):
                qualified.append(
                    {
                        "peer_media_id": row["peer_media_id"],
                        "anchor_rank": anchor.rank,
                        "similarity": similarity,
                        "partition": str(row["candidate_partition"]),
                        "last_engaged_at": row["last_engaged_at"],
                        "latest_exact_arrival_at": row["latest_exact_arrival_at"],
                    }
                )

    def strength(row: dict[str, Any]) -> tuple[object, ...]:
        secondary: tuple[object, ...] = ()
        if library_secondary:
            secondary = (
                _descending_instant(row["last_engaged_at"]),
                _descending_instant(row["latest_exact_arrival_at"]),
            )
        return (-row["similarity"], *secondary, row["anchor_rank"], str(row["peer_media_id"]))

    qualified.sort(key=strength)
    ranked: list[dict[str, Any]] = []
    seen: set[UUID] = set()
    family_counts = {"GraphThread": 0, "Rediscovery": 0}
    for row in qualified:
        peer_id = UUID(str(row["peer_media_id"]))
        if peer_id in seen or family_counts[row["partition"]] == SLATE_FAMILY_CANDIDATE_LIMIT:
            continue
        seen.add(peer_id)
        family_counts[row["partition"]] += 1
        ranked.append(row)
    return ranked


def _descending_instant(value: datetime | None) -> float:
    return -value.timestamp() if value is not None else float("inf")


def _target_fact_rows(
    db: Session,
    *,
    viewer_id: UUID,
    refs: list[ResourceRef],
    relation: str,
    params: dict[str, object],
) -> list[Any]:
    """Display and dating facts for the acquired targets, one row per ref."""
    rows = db.execute(
        text(f"""
            WITH requested AS (
                SELECT scheme, id
                FROM jsonb_to_recordset(CAST(:targets AS jsonb))
                    AS x(scheme text, id uuid)
            ),
            eligible_targets AS ({relation})
            SELECT
                eligible_targets.*,
                ({exact_day_date_sql("original_published_date")}) AS published_on
            FROM eligible_targets
            JOIN requested
              ON requested.scheme = eligible_targets.target_scheme
             AND requested.id = eligible_targets.target_id
        """),
        {
            "viewer_id": viewer_id,
            "targets": json.dumps(
                [{"scheme": ref.scheme, "id": str(ref.id)} for ref in refs],
                separators=(",", ":"),
            ),
            **params,
        },
    ).mappings()
    return list(rows)


def _resource_owner_rows_sql() -> str:
    """Normalize every edge endpoint one hop to the object that owns it.

    Reads ``edge_endpoints(scheme, id)``; returns ``resource_scheme``,
    ``resource_id``, ``owner_scheme``, ``owner_id``. Media, podcasts, Pages and
    NoteBlocks own themselves; fragments, highlights, spans, chunks and
    apparatus items resolve to their media or their exact NoteBlock. Starting
    from the distinct supplied endpoints keeps the work bounded by the edges.
    """
    return """
        WITH owner_endpoints AS (
            SELECT DISTINCT scheme AS resource_scheme, id AS resource_id
            FROM edge_endpoints
            WHERE scheme IS NOT NULL AND id IS NOT NULL
        )
        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'media'::text AS owner_scheme, m.id AS owner_id
        FROM owner_endpoints endpoint
        JOIN media m ON endpoint.resource_scheme = 'media' AND m.id = endpoint.resource_id

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'podcast'::text AS owner_scheme, p.id AS owner_id
        FROM owner_endpoints endpoint
        JOIN podcasts p ON endpoint.resource_scheme = 'podcast' AND p.id = endpoint.resource_id

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'page'::text AS owner_scheme, p.id AS owner_id
        FROM owner_endpoints endpoint
        JOIN pages p ON endpoint.resource_scheme = 'page' AND p.id = endpoint.resource_id

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'note_block'::text AS owner_scheme, nb.id AS owner_id
        FROM owner_endpoints endpoint
        JOIN note_blocks nb
          ON endpoint.resource_scheme = 'note_block' AND nb.id = endpoint.resource_id

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'media'::text AS owner_scheme, f.media_id AS owner_id
        FROM owner_endpoints endpoint
        JOIN fragments f ON endpoint.resource_scheme = 'fragment' AND f.id = endpoint.resource_id

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'media'::text AS owner_scheme, h.anchor_media_id AS owner_id
        FROM owner_endpoints endpoint
        JOIN highlights h
          ON endpoint.resource_scheme = 'highlight' AND h.id = endpoint.resource_id
        WHERE h.anchor_media_id IS NOT NULL

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               es.owner_kind AS owner_scheme, es.owner_id
        FROM owner_endpoints endpoint
        JOIN evidence_spans es
          ON endpoint.resource_scheme = 'evidence_span' AND es.id = endpoint.resource_id
        WHERE es.owner_kind IN ('media', 'note_block')

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               cc.owner_kind AS owner_scheme, cc.owner_id
        FROM owner_endpoints endpoint
        JOIN content_chunks cc
          ON endpoint.resource_scheme = 'content_chunk' AND cc.id = endpoint.resource_id
        WHERE cc.owner_kind IN ('media', 'note_block')

        UNION ALL

        SELECT endpoint.resource_scheme, endpoint.resource_id,
               'media'::text AS owner_scheme, rai.media_id AS owner_id
        FROM owner_endpoints endpoint
        JOIN reader_apparatus_items rai
          ON endpoint.resource_scheme = 'reader_apparatus_item' AND rai.id = endpoint.resource_id
    """


def _anchors_json(anchors: tuple[Anchor, ...]) -> str:
    return json.dumps(
        [
            {"scheme": anchor.ref.scheme, "id": str(anchor.ref.id), "rank": anchor.rank}
            for anchor in anchors
        ],
        separators=(",", ":"),
    )


def _target_ref(row: Any) -> ResourceRef:
    return ResourceRef(scheme=cast(Any, str(row["target_scheme"])), id=UUID(str(row["target_id"])))
