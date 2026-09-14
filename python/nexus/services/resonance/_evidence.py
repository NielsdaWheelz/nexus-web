"""Owned evidence records and bounded database acquisition for Resonance."""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.schemas.resonance import ResonanceEdgeOrigin
from nexus.services import highlights, library_entries, notes
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.resonance._ranking import (
    ARRIVAL_WINDOW_DAYS,
    CONTINUITY_MAX_IDLE_DAYS,
    REDISCOVERY_MIN_AGE_DAYS,
    RESONANCE_EDGE_ORIGINS,
    SLATE_ANCHOR_LIMIT,
    SLATE_FAMILY_CANDIDATE_LIMIT,
    SLATE_SEMANTIC_CALIBRATION,
    exact_day_date_sql,
    semantic_chunk_candidate_limit,
    slate_semantic_qualifies,
)
from nexus.services.resource_graph.connection_summaries import edge_fact_rows_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs, resource_owner_rows_sql
from nexus.services.resource_graph.schemas import EdgeKind
from nexus.services.semantic_chunks import media_neighbor_rows_sql

_DAY_PRECISION_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True, slots=True)
class Anchor:
    ref: ResourceRef
    label: str
    rank: int


@dataclass(frozen=True, slots=True)
class ContinuityEvidence:
    progress: float | None
    last_engaged_at: datetime


@dataclass(frozen=True, slots=True)
class AddedToNexusEvidence:
    kind: Literal["AddedToNexus"]
    added_at: datetime

    @property
    def occurred_on(self) -> date:
        return self.added_at.astimezone(UTC).date()

    @property
    def occurred_at(self) -> datetime:
        return self.added_at


@dataclass(frozen=True, slots=True)
class PublishedEvidence:
    kind: Literal["Published"]
    published_on: date

    @property
    def occurred_on(self) -> date:
        return self.published_on

    @property
    def occurred_at(self) -> None:
        return None


@dataclass(frozen=True, slots=True)
class NewEpisodeEvidence:
    kind: Literal["NewEpisode"]
    published_at: datetime

    @property
    def occurred_on(self) -> date:
        return self.published_at.astimezone(UTC).date()

    @property
    def occurred_at(self) -> datetime:
        return self.published_at


type ArrivalEvidence = AddedToNexusEvidence | PublishedEvidence | NewEpisodeEvidence


@dataclass(frozen=True, slots=True)
class EdgeEvidence:
    anchor: Anchor
    edge_id: UUID
    edge_kind: EdgeKind
    edge_origin: ResonanceEdgeOrigin
    created_at: datetime


@dataclass(frozen=True, slots=True, order=True)
class Author:
    id: UUID
    display_name: str


@dataclass(frozen=True, slots=True)
class SharedAuthorEvidence:
    anchor: Anchor
    authors: tuple[Author, ...]

    def __post_init__(self) -> None:
        if not self.authors:
            # justify-defect: the type represents qualified SharedAuthor evidence.
            raise AssertionError("SharedAuthor evidence requires at least one author")
        by_id: dict[UUID, Author] = {}
        for author in self.authors:
            existing = by_id.setdefault(author.id, author)
            if existing.display_name != author.display_name:
                # justify-defect: one canonical contributor id has one canonical
                # display name inside a repeatable-read snapshot.
                raise AssertionError(f"conflicting author names for {author.id}")
        object.__setattr__(
            self,
            "authors",
            tuple(sorted(by_id.values(), key=lambda author: str(author.id))),
        )


@dataclass(frozen=True, slots=True)
class SemanticEvidence:
    anchor: Anchor
    similarity: float


@dataclass(frozen=True, slots=True)
class CandidateEvidence:
    target_ref: ResourceRef
    media_kind: MediaKind | None
    continuity: ContinuityEvidence | None
    arrivals: tuple[ArrivalEvidence, ...]
    edges: tuple[EdgeEvidence, ...]
    shared_authors: tuple[SharedAuthorEvidence, ...]
    semantics: tuple[SemanticEvidence, ...]
    last_engaged_at: datetime | None
    latest_exact_arrival_at: datetime | None
    latest_exact_activity_at: datetime | None


type RelationEvidence = EdgeEvidence | SharedAuthorEvidence | SemanticEvidence


@dataclass(frozen=True, slots=True)
class _SemanticRow:
    peer_media_id: UUID
    anchor_rank: int
    similarity: float
    partition: Literal["GraphThread", "Rediscovery"]
    last_engaged_at: datetime | None
    latest_exact_arrival_at: datetime | None


def capture_as_of(db: Session) -> datetime:
    """Capture the request snapshot's single authoritative UTC instant."""
    value = db.execute(text("SELECT now()")).scalar_one()
    if not isinstance(value, datetime):
        # justify-defect: PostgreSQL now() is a timestamptz in this schema.
        raise AssertionError("database now() did not return an instant")
    if value.tzinfo is None:
        # justify-defect: PostgreSQL timestamptz values are timezone-aware.
        raise AssertionError("database now() returned a naive instant")
    return value.astimezone(UTC)


def lectern_anchors(db: Session, *, viewer_id: UUID) -> tuple[Anchor, ...]:
    """Select, normalize, resolve, and label the five canonical Lectern anchors."""
    gathered: list[tuple[datetime, int, ResourceRef]] = []
    for fact in consumption_service.recent_engagement_anchor_facts(
        db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT
    ):
        gathered.append((fact.activity_at, 0, ResourceRef(scheme="media", id=fact.media_id)))
    for fact in highlights.recent_highlight_anchor_facts(
        db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT
    ):
        gathered.append((fact.activity_at, 1, ResourceRef(scheme="media", id=fact.media_id)))
    for fact in notes.recent_note_anchor_facts(db, viewer_id=viewer_id, limit=SLATE_ANCHOR_LIMIT):
        source_priority = 2 if fact.ref.scheme == "note_block" else 3
        gathered.append((fact.activity_at, source_priority, fact.ref))
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
    return _resolved_anchors(db, viewer_id=viewer_id, refs=refs)


def library_anchors(db: Session, *, viewer_id: UUID, library_id: UUID) -> tuple[Anchor, ...]:
    facts = library_entries.library_anchor_facts(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        limit=SLATE_ANCHOR_LIMIT,
    )
    return _resolved_anchors(
        db,
        viewer_id=viewer_id,
        refs=[fact.ref for fact in facts],
    )


def _resolved_anchors(
    db: Session, *, viewer_id: UUID, refs: list[ResourceRef]
) -> tuple[Anchor, ...]:
    if not refs:
        return ()
    resolved = resolve_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        include_media_document_summary=False,
    )
    anchors: list[Anchor] = []
    for ref, item in zip(refs, resolved, strict=True):
        if item.missing:
            # justify-defect: every anchor owner already proved this ref readable in
            # the same repeatable-read snapshot before asking the resolver to label it.
            raise AssertionError(f"Readable Slate anchor did not resolve: {ref.uri}")
        anchors.append(Anchor(ref=ref, label=item.label, rank=len(anchors)))
    return tuple(anchors)


def acquire_slate_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    as_of: datetime,
    anchors: tuple[Anchor, ...],
    eligible_media_relation: str,
    eligible_target_relation: str,
    relation_params: dict[str, object],
    include_nonrelational: bool,
) -> list[CandidateEvidence]:
    """Acquire one bounded, normalized evidence union over checked-in owner ports."""
    params = {
        "viewer_id": viewer_id,
        "as_of": as_of,
        "continuity_days": CONTINUITY_MAX_IDLE_DAYS,
        "arrival_days": ARRIVAL_WINDOW_DAYS,
        "arrival_calendar_days": ARRIVAL_WINDOW_DAYS - 1,
        "rediscovery_days": REDISCOVERY_MIN_AGE_DAYS,
        **relation_params,
    }
    candidate_refs: dict[str, ResourceRef] = {}

    if include_nonrelational:
        rows = db.execute(
            text(f"""
                WITH eligible_media AS ({eligible_media_relation})
                SELECT 'continuity' AS lane, media_id
                FROM eligible_media
                WHERE read_state = 'InProgress'
                  AND last_engaged_at BETWEEN
                      :as_of - :continuity_days * interval '1 day' AND :as_of
                ORDER BY last_engaged_at DESC, media_id ASC
                LIMIT {SLATE_FAMILY_CANDIDATE_LIMIT}
            """),
            params,
        ).mappings()
        for row in rows:
            ref = ResourceRef(scheme="media", id=UUID(str(row["media_id"])))
            candidate_refs.setdefault(ref.uri, ref)

        rows = db.execute(
            text(f"""
                WITH eligible_media AS ({eligible_media_relation}),
                normalized AS (
                    SELECT
                        eligible_media.*,
                        ({exact_day_date_sql("published_date")}) AS published_on
                    FROM eligible_media
                ),
                qualifying AS (
                    SELECT
                        normalized.*,
                        CASE WHEN created_at BETWEEN
                                :as_of - :arrival_days * interval '1 day' AND :as_of
                            THEN (created_at AT TIME ZONE 'UTC')::date END
                            AS added_on,
                        CASE WHEN published_at BETWEEN
                                :as_of - :arrival_days * interval '1 day' AND :as_of
                            THEN (published_at AT TIME ZONE 'UTC')::date END
                            AS episode_on,
                        CASE
                            WHEN published_on BETWEEN
                                (:as_of AT TIME ZONE 'UTC')::date - :arrival_calendar_days
                                AND (:as_of AT TIME ZONE 'UTC')::date
                            THEN published_on
                        END AS media_published_on
                    FROM normalized
                ),
                dated AS (
                    SELECT
                        qualifying.*,
                        GREATEST(added_on, episode_on, media_published_on)
                            AS newest_arrival_on
                    FROM qualifying
                    WHERE added_on IS NOT NULL
                       OR episode_on IS NOT NULL
                       OR media_published_on IS NOT NULL
                ),
                ranked AS (
                    SELECT
                        dated.*,
                        GREATEST(
                            CASE WHEN added_on = newest_arrival_on THEN created_at END,
                            CASE WHEN episode_on = newest_arrival_on THEN published_at END
                        ) AS newest_exact_at
                    FROM dated
                )
                SELECT media_id
                FROM ranked
                WHERE NOT COALESCE(
                    read_state = 'InProgress'
                    AND last_engaged_at BETWEEN
                        :as_of - :continuity_days * interval '1 day' AND :as_of,
                    false
                )
                ORDER BY
                    newest_arrival_on DESC,
                    CASE
                        WHEN episode_on IS NOT NULL THEN 0
                        WHEN media_published_on IS NOT NULL THEN 1
                        ELSE 2
                    END,
                    newest_exact_at DESC NULLS LAST,
                    media_id ASC
                LIMIT {SLATE_FAMILY_CANDIDATE_LIMIT}
            """),
            params,
        ).mappings()
        for row in rows:
            ref = ResourceRef(scheme="media", id=UUID(str(row["media_id"])))
            candidate_refs.setdefault(ref.uri, ref)

    relational_targets = _relational_target_relation(
        eligible_target_relation,
        exclude_nonrelational=include_nonrelational,
    )
    edge_rows = _edge_rows(
        db,
        viewer_id=viewer_id,
        anchors=anchors,
        eligible_target_relation=relational_targets,
        params=params,
    )
    for row in edge_rows:
        ref = _target_ref(row)
        candidate_refs.setdefault(ref.uri, ref)

    author_rows = _shared_author_rows(
        db,
        viewer_id=viewer_id,
        anchors=anchors,
        eligible_target_relation=relational_targets,
        params=params,
        use_library_secondary=not include_nonrelational,
    )
    for row in author_rows:
        ref = _target_ref(row)
        candidate_refs.setdefault(ref.uri, ref)

    semantic_rows = _semantic_rows(
        db,
        viewer_id=viewer_id,
        anchors=anchors,
        eligible_media_relation=f"""
            SELECT
                target_id AS media_id,
                slate_family AS candidate_partition,
                last_engaged_at,
                latest_exact_arrival_at
            FROM ({relational_targets}) relational_targets
            WHERE target_scheme = 'media'
        """,
        params=params,
        use_library_secondary=not include_nonrelational,
    )
    for row in semantic_rows:
        ref = ResourceRef(scheme="media", id=row.peer_media_id)
        candidate_refs.setdefault(ref.uri, ref)

    # Two direct lanes and two family partitions from each of the three
    # relational sources contribute at most twenty unique targets apiece.
    refs = list(candidate_refs.values())
    if len(refs) > 8 * SLATE_FAMILY_CANDIDATE_LIMIT:
        # justify-defect: the eight fixed acquisition lanes above are each capped.
        raise AssertionError("Slate raw evidence union exceeded its fixed bound")
    if not refs:
        return []
    facts = _target_fact_rows(
        db,
        viewer_id=viewer_id,
        refs=refs,
        eligible_target_relation=eligible_target_relation,
        params=params,
    )
    fact_uris = [_target_ref(row).uri for row in facts]
    requested_uris = [ref.uri for ref in refs]
    if len(fact_uris) != len(requested_uris) or set(fact_uris) != set(requested_uris):
        # justify-defect: every bounded candidate came from this closed eligible-target
        # relation in the same repeatable-read snapshot, which yields one row per ref.
        raise AssertionError(
            f"Slate target facts drifted: expected {requested_uris}, got {fact_uris}"
        )
    by_uri = {_target_ref(row).uri: row for row in facts}
    anchor_by_rank = {anchor.rank: anchor for anchor in anchors}
    edges_by_uri: dict[str, list[EdgeEvidence]] = defaultdict(list)
    for row in edge_rows:
        ref = _target_ref(row)
        edges_by_uri[ref.uri].append(
            EdgeEvidence(
                anchor=anchor_by_rank[int(row["anchor_rank"])],
                edge_id=UUID(str(row["edge_id"])),
                edge_kind=cast(EdgeKind, str(row["edge_kind"])),
                edge_origin=cast(ResonanceEdgeOrigin, str(row["edge_origin"])),
                created_at=row["created_at"],
            )
        )
    authors_by_uri: dict[str, list[SharedAuthorEvidence]] = defaultdict(list)
    grouped_authors: dict[tuple[str, int], list[Author]] = defaultdict(list)
    for row in author_rows:
        ref = _target_ref(row)
        grouped_authors[(ref.uri, int(row["anchor_rank"]))].append(
            Author(
                id=UUID(str(row["contributor_id"])),
                display_name=str(row["display_name"]),
            )
        )
    for (uri, rank), authors in grouped_authors.items():
        authors_by_uri[uri].append(
            SharedAuthorEvidence(anchor=anchor_by_rank[rank], authors=tuple(authors))
        )
    semantic_by_uri: dict[str, list[SemanticEvidence]] = defaultdict(list)
    for row in semantic_rows:
        ref = ResourceRef(scheme="media", id=row.peer_media_id)
        semantic_by_uri[ref.uri].append(
            SemanticEvidence(
                anchor=anchor_by_rank[row.anchor_rank],
                similarity=row.similarity,
            )
        )

    candidates: list[CandidateEvidence] = []
    for ref in refs:
        row = by_uri[ref.uri]
        read_state = str(row["read_state"]) if row["read_state"] is not None else None
        engaged = row["last_engaged_at"]
        continuity = (
            ContinuityEvidence(
                progress=(
                    float(row["progress_fraction"])
                    if row["progress_fraction"] is not None
                    else None
                ),
                last_engaged_at=engaged,
            )
            if read_state == "InProgress" and engaged is not None
            else None
        )
        arrivals: list[ArrivalEvidence] = []
        created_at = row["created_at"]
        if created_at is not None:
            arrivals.append(AddedToNexusEvidence(kind="AddedToNexus", added_at=created_at))
        published_on = _day_precision_published_on(row["published_date"])
        if published_on is not None:
            arrivals.append(PublishedEvidence(kind="Published", published_on=published_on))
        published_at = row["published_at"]
        if published_at is not None:
            arrivals.append(NewEpisodeEvidence(kind="NewEpisode", published_at=published_at))
        exact_arrivals = [
            fact for fact in (created_at, published_at) if fact is not None and fact <= as_of
        ]
        exact_activity = [
            fact
            for fact in (created_at, published_at, engaged)
            if fact is not None and fact <= as_of
        ]
        media_kind_raw = row["media_kind"]
        candidates.append(
            CandidateEvidence(
                target_ref=ref,
                media_kind=(MediaKind(str(media_kind_raw)) if media_kind_raw is not None else None),
                continuity=continuity,
                arrivals=tuple(arrivals),
                edges=tuple(edges_by_uri[ref.uri]),
                shared_authors=tuple(authors_by_uri[ref.uri]),
                semantics=tuple(semantic_by_uri[ref.uri]),
                last_engaged_at=engaged,
                latest_exact_arrival_at=(max(exact_arrivals) if exact_arrivals else None),
                latest_exact_activity_at=(max(exact_activity) if exact_activity else None),
            )
        )
    return candidates


def _relational_target_relation(
    eligible_target_relation: str, *, exclude_nonrelational: bool
) -> str:
    latest_exact_arrival = """
        GREATEST(
            CASE WHEN created_at <= :as_of THEN created_at END,
            CASE WHEN published_at <= :as_of THEN published_at END
        )
    """
    latest_exact_activity = """
        GREATEST(
            CASE WHEN created_at <= :as_of THEN created_at END,
            CASE WHEN published_at <= :as_of THEN published_at END,
            CASE WHEN last_engaged_at <= :as_of THEN last_engaged_at END
        )
    """
    nonrelational_exclusion = ""
    normalized_published_on = "NULL::date"
    if exclude_nonrelational:
        normalized_published_on = exact_day_date_sql("published_date")
        nonrelational_exclusion = """
            AND NOT COALESCE(
                read_state = 'InProgress'
                AND last_engaged_at BETWEEN
                    :as_of - :continuity_days * interval '1 day' AND :as_of,
                false
            )
            AND NOT (
                COALESCE(
                    created_at BETWEEN
                        :as_of - :arrival_days * interval '1 day' AND :as_of,
                    false
                )
                OR COALESCE(
                    published_at BETWEEN
                        :as_of - :arrival_days * interval '1 day' AND :as_of,
                    false
                )
                OR COALESCE(
                    published_on BETWEEN
                        (:as_of AT TIME ZONE 'UTC')::date - :arrival_calendar_days
                        AND (:as_of AT TIME ZONE 'UTC')::date,
                    false
                )
            )
        """
    return f"""
        WITH eligible_targets AS ({eligible_target_relation}),
        normalized AS (
            SELECT
                eligible_targets.*,
                ({normalized_published_on}) AS published_on
            FROM eligible_targets
        )
        SELECT
            normalized.*,
            ({latest_exact_arrival}) AS latest_exact_arrival_at,
            CASE
                WHEN ({latest_exact_activity}) <=
                    :as_of - :rediscovery_days * interval '1 day'
                THEN 'Rediscovery'
                ELSE 'GraphThread'
            END AS slate_family
        FROM normalized
        WHERE true
        {nonrelational_exclusion}
    """


def _anchors_json(anchors: tuple[Anchor, ...]) -> str:
    import json

    return json.dumps(
        [
            {"scheme": anchor.ref.scheme, "id": str(anchor.ref.id), "rank": anchor.rank}
            for anchor in anchors
        ],
        separators=(",", ":"),
    )


def _edge_rows(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[Anchor, ...],
    eligible_target_relation: str,
    params: dict[str, object],
) -> list[Any]:
    if not anchors:
        return []
    # Edge strength ends in a globally unique edge id. Distinct targets therefore
    # cannot tie far enough for Library's engagement/arrival secondary keys to
    # reorder them, so this shared cap also preserves Lectern's relational order.
    rows = db.execute(
        text(f"""
            WITH anchors AS (
                SELECT scheme, id, rank
                FROM jsonb_to_recordset(CAST(:anchors AS jsonb))
                    AS x(scheme text, id uuid, rank integer)
            ),
            edges AS ({edge_fact_rows_sql()}),
            edge_endpoints AS (
                SELECT source_scheme AS scheme, source_id AS id FROM edges
                UNION
                SELECT target_scheme, target_id FROM edges
            ),
            owners AS (
                {
            resource_owner_rows_sql('''
                    SELECT scheme AS resource_scheme, id AS resource_id
                    FROM edge_endpoints
                ''')
        }
            ),
            eligible_targets AS ({eligible_target_relation}),
            incident AS (
                SELECT
                    so.owner_scheme AS anchor_scheme,
                    so.owner_id AS anchor_id,
                    target.owner_scheme AS target_scheme,
                    target.owner_id AS target_id,
                    edges.edge_id,
                    edges.edge_kind,
                    edges.edge_origin,
                    edges.created_at
                FROM edges
                JOIN owners so
                  ON so.resource_scheme = edges.source_scheme
                 AND so.resource_id = edges.source_id
                JOIN owners target
                  ON target.resource_scheme = edges.target_scheme
                 AND target.resource_id = edges.target_id
                UNION ALL
                SELECT
                    target.owner_scheme,
                    target.owner_id,
                    so.owner_scheme,
                    so.owner_id,
                    edges.edge_id,
                    edges.edge_kind,
                    edges.edge_origin,
                    edges.created_at
                FROM edges
                JOIN owners so
                  ON so.resource_scheme = edges.source_scheme
                 AND so.resource_id = edges.source_id
                JOIN owners target
                  ON target.resource_scheme = edges.target_scheme
                 AND target.resource_id = edges.target_id
            )
            , qualified AS (
                SELECT
                    incident.target_scheme,
                    incident.target_id,
                    eligible.slate_family,
                    anchors.rank AS anchor_rank,
                    incident.edge_id,
                    incident.edge_kind,
                    incident.edge_origin,
                    incident.created_at
                FROM incident
                JOIN anchors
                  ON anchors.scheme = incident.anchor_scheme
                 AND anchors.id = incident.anchor_id
                JOIN eligible_targets eligible
                  ON eligible.target_scheme = incident.target_scheme
                 AND eligible.target_id = incident.target_id
                WHERE (incident.target_scheme, incident.target_id)
                    <> (incident.anchor_scheme, incident.anchor_id)
            ),
            strongest_per_target AS (
                SELECT DISTINCT ON (target_scheme, target_id) *
                FROM qualified
                ORDER BY
                    target_scheme,
                    target_id,
                    array_position(CAST(:edge_origins AS text[]), edge_origin),
                    created_at DESC,
                    CASE edge_kind
                        WHEN 'context' THEN 0 WHEN 'supports' THEN 1 ELSE 2
                    END,
                    edge_id ASC,
                    anchor_rank ASC
            ),
            ranked AS (
                SELECT
                    strongest_per_target.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY slate_family
                        ORDER BY
                            array_position(
                                CAST(:edge_origins AS text[]), edge_origin
                            ),
                            created_at DESC,
                            CASE edge_kind
                                WHEN 'context' THEN 0
                                WHEN 'supports' THEN 1
                                ELSE 2
                            END,
                            edge_id ASC,
                            anchor_rank ASC,
                            target_scheme ASC,
                            target_id ASC
                    ) AS family_rank
                FROM strongest_per_target
            )
            SELECT * FROM ranked
            WHERE family_rank <= {SLATE_FAMILY_CANDIDATE_LIMIT}
            ORDER BY
                slate_family ASC,
                array_position(CAST(:edge_origins AS text[]), edge_origin),
                created_at DESC,
                CASE edge_kind
                    WHEN 'context' THEN 0 WHEN 'supports' THEN 1 ELSE 2
                END,
                edge_id ASC,
                anchor_rank ASC,
                target_scheme ASC,
                target_id ASC
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
    eligible_target_relation: str,
    params: dict[str, object],
    use_library_secondary: bool,
) -> list[Any]:
    author_anchors = tuple(
        anchor for anchor in anchors if anchor.ref.scheme in ("media", "podcast")
    )
    if not author_anchors:
        return []
    library_secondary_order = ""
    library_secondary_output_order = ""
    if use_library_secondary:
        library_secondary_order = """
            last_engaged_at DESC NULLS LAST,
            latest_exact_arrival_at DESC NULLS LAST,
        """
        library_secondary_output_order = """
            ranked_pairs.last_engaged_at DESC NULLS LAST,
            ranked_pairs.latest_exact_arrival_at DESC NULLS LAST,
        """
    rows = db.execute(
        text(f"""
            WITH anchors AS (
                SELECT scheme, id, rank
                FROM jsonb_to_recordset(CAST(:anchors AS jsonb))
                    AS x(scheme text, id uuid, rank integer)
            ),
            authors AS ({visible_author_credit_rows_sql()}),
            eligible_targets AS ({eligible_target_relation}),
            pairs AS (
                SELECT DISTINCT
                    eligible.target_scheme,
                    eligible.target_id,
                    eligible.slate_family,
                    anchors.rank AS anchor_rank,
                    eligible.last_engaged_at,
                    eligible.latest_exact_arrival_at,
                    target_author.contributor_id,
                    target_author.display_name
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
                    target_scheme,
                    target_id,
                    slate_family,
                    anchor_rank,
                    last_engaged_at,
                    latest_exact_arrival_at,
                    COUNT(*) AS author_count,
                    (ARRAY_AGG(contributor_id ORDER BY contributor_id ASC))[1]
                        AS first_author_id
                FROM pairs
                GROUP BY
                    target_scheme,
                    target_id,
                    slate_family,
                    anchor_rank,
                    last_engaged_at,
                    latest_exact_arrival_at
            ),
            strongest_per_target AS (
                SELECT DISTINCT ON (target_scheme, target_id) *
                FROM pair_strength
                ORDER BY
                    target_scheme,
                    target_id,
                    author_count DESC,
                    first_author_id ASC,
                    anchor_rank ASC
            ),
            ranked_pairs AS (
                SELECT
                    strongest_per_target.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY slate_family
                        ORDER BY
                            author_count DESC,
                            first_author_id ASC,
                            {library_secondary_order}
                            anchor_rank ASC,
                            target_scheme ASC,
                            target_id ASC
                    ) AS family_rank
                FROM strongest_per_target
            )
            SELECT pairs.*
            FROM ranked_pairs
            JOIN pairs USING (target_scheme, target_id, slate_family, anchor_rank)
            WHERE ranked_pairs.family_rank <= {SLATE_FAMILY_CANDIDATE_LIMIT}
            ORDER BY
                ranked_pairs.slate_family ASC,
                ranked_pairs.author_count DESC,
                ranked_pairs.first_author_id ASC,
                {library_secondary_output_order}
                ranked_pairs.anchor_rank ASC,
                ranked_pairs.target_scheme ASC,
                ranked_pairs.target_id ASC,
                pairs.contributor_id ASC
        """),
        {"viewer_id": viewer_id, "anchors": _anchors_json(author_anchors), **params},
    ).mappings()
    return list(rows)


def _semantic_rows(
    db: Session,
    *,
    viewer_id: UUID,
    anchors: tuple[Anchor, ...],
    eligible_media_relation: str,
    params: dict[str, object],
    use_library_secondary: bool,
) -> list[_SemanticRow]:
    calibration = SLATE_SEMANTIC_CALIBRATION
    results: list[_SemanticRow] = []
    for anchor in anchors:
        if anchor.ref.scheme != "media":
            continue
        rows = db.execute(
            text(f"""
                WITH eligible_context AS ({eligible_media_relation}),
                neighbors AS (
                    {
                media_neighbor_rows_sql('''
                        SELECT media_id, candidate_partition
                        FROM eligible_context
                    ''')
            }
                )
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
                "embedding_dimensions": calibration.dimensions,
                "candidate_limit": semantic_chunk_candidate_limit(SLATE_FAMILY_CANDIDATE_LIMIT),
                **params,
            },
        ).mappings()
        for row in rows:
            partition_raw = str(row["candidate_partition"])
            if partition_raw not in ("GraphThread", "Rediscovery"):
                # justify-defect: Resonance supplies the closed contextual relation.
                raise AssertionError(f"unexpected semantic partition: {partition_raw!r}")
            similarity = 1.0 - float(row["distance"])
            if slate_semantic_qualifies(
                provider=str(row["embedding_provider"]),
                model=str(row["embedding_model"]),
                dimensions=int(row["embedding_dimensions"]),
                similarity=similarity,
            ):
                results.append(
                    _SemanticRow(
                        peer_media_id=UUID(str(row["peer_media_id"])),
                        anchor_rank=anchor.rank,
                        similarity=similarity,
                        partition=cast(Literal["GraphThread", "Rediscovery"], partition_raw),
                        last_engaged_at=row["last_engaged_at"],
                        latest_exact_arrival_at=row["latest_exact_arrival_at"],
                    )
                )

    def sort_key(row: _SemanticRow) -> tuple[object, ...]:
        library_secondary: tuple[object, ...] = ()
        if use_library_secondary:
            library_secondary = (
                (
                    -row.last_engaged_at.timestamp()
                    if row.last_engaged_at is not None
                    else float("inf")
                ),
                (
                    -row.latest_exact_arrival_at.timestamp()
                    if row.latest_exact_arrival_at is not None
                    else float("inf")
                ),
            )
        return (
            0 if row.partition == "GraphThread" else 1,
            -row.similarity,
            *library_secondary,
            row.anchor_rank,
            str(row.peer_media_id),
        )

    results.sort(key=sort_key)
    unique: list[_SemanticRow] = []
    seen: set[str] = set()
    family_counts = {"GraphThread": 0, "Rediscovery": 0}
    for row in results:
        peer_uri = f"media:{row.peer_media_id}"
        if peer_uri in seen:
            continue
        if family_counts[row.partition] == SLATE_FAMILY_CANDIDATE_LIMIT:
            continue
        seen.add(peer_uri)
        unique.append(row)
        family_counts[row.partition] += 1
    return unique


def _target_fact_rows(
    db: Session,
    *,
    viewer_id: UUID,
    refs: list[ResourceRef],
    eligible_target_relation: str,
    params: dict[str, object],
) -> list[Any]:
    rows = db.execute(
        text(f"""
            WITH requested AS (
                SELECT scheme, id
                FROM jsonb_to_recordset(CAST(:targets AS jsonb))
                    AS x(scheme text, id uuid)
            ),
            eligible_targets AS ({eligible_target_relation})
            SELECT eligible_targets.*
            FROM eligible_targets
            JOIN requested
              ON requested.scheme = eligible_targets.target_scheme
             AND requested.id = eligible_targets.target_id
        """),
        {
            "viewer_id": viewer_id,
            "targets": _refs_json(refs),
            **params,
        },
    ).mappings()
    return list(rows)


def _target_ref(row: Any) -> ResourceRef:
    return ResourceRef(
        scheme=cast(Any, str(row["target_scheme"])),
        id=UUID(str(row["target_id"])),
    )


def _refs_json(refs: list[ResourceRef]) -> str:
    import json

    return json.dumps(
        [{"scheme": ref.scheme, "id": str(ref.id)} for ref in refs],
        separators=(",", ":"),
    )


def _day_precision_published_on(value: object) -> date | None:
    if not isinstance(value, str) or _DAY_PRECISION_DATE_RE.fullmatch(value) is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None
