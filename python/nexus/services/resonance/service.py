"""Resonance's three deterministic contextual reads.

Read-only: no model call, no provider call, no job, no persisted
recommendation state. Each read composes policy-neutral relations owned by
other modules and hydrates through their compact target ports.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.schemas.presence import absent, present
from nexus.schemas.resonance import (
    AddedToNexusSlateReasonOut,
    ConnectedSlateReasonOut,
    ContinueSlateReasonOut,
    MediaSlateTargetOut,
    NewEpisodeSlateReasonOut,
    PodcastSlateTargetOut,
    PublishedSlateReasonOut,
    SharedAuthorSlateReasonOut,
    SimilarSlateReasonOut,
    SlateAnchorOut,
    SlateItemOut,
    SlateOut,
    SlateReasonOut,
)
from nexus.services import library_entries, library_governance
from nexus.services import media as media_service
from nexus.services.consumption import projection
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.podcasts.subscriptions_query import (
    active_subscription_rows_sql,
    hydrate_compact_podcast_targets,
)
from nexus.services.resonance import _evidence, _slate
from nexus.services.resonance._slate import (
    ContinuityEvidence,
    EdgeEvidence,
    RankedCandidate,
    SemanticEvidence,
    SharedAuthorEvidence,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import ConnectionEndpoint
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.semantic_chunks import media_neighbor_rows_sql, transcript_embedding_dimensions


def related_media(
    db: Session, *, viewer_id: UUID, media_id: UUID, limit: int = 8
) -> list[ConnectionEndpoint]:
    """A media's peers: nearest semantic neighbours first, then shared authors."""
    media_service.get_media_for_viewer(db, viewer_id, media_id)
    if limit < 1:
        return []
    candidate_limit = _evidence.semantic_chunk_candidate_limit(limit)
    params = {
        "viewer_id": viewer_id,
        "anchor_media_id": media_id,
        "embedding_dimensions": transcript_embedding_dimensions(),
        "candidate_limit": candidate_limit,
    }
    semantic_rows = db.execute(
        text(
            media_neighbor_rows_sql(f"""
                SELECT media_id, 'Related'::text AS candidate_partition
                FROM ({visible_media_ids_cte_sql()}) visible_media
            """)
        ),
        params,
    ).mappings()
    # (semantic rank, nearest distance, -shared authors, id): a semantic peer
    # outranks every shared-author-only peer.
    ordering: dict[UUID, tuple[int, float, int, str]] = {
        UUID(str(row["peer_media_id"])): (0, float(row["distance"]), 0, str(row["peer_media_id"]))
        for row in semantic_rows
    }
    author_rows = db.execute(
        text(f"""
            WITH authors AS ({visible_author_credit_rows_sql()})
            SELECT
                peer.media_id AS peer_media_id,
                COUNT(DISTINCT peer.contributor_id) AS shared_author_count
            FROM authors anchor
            JOIN authors peer
              ON peer.contributor_id = anchor.contributor_id
             AND peer.media_id IS NOT NULL
             AND peer.media_id <> :anchor_media_id
            WHERE anchor.media_id = :anchor_media_id
            GROUP BY peer.media_id
            ORDER BY shared_author_count DESC, peer.media_id ASC
            LIMIT :candidate_limit
        """),
        params,
    ).mappings()
    for row in author_rows:
        peer_id = UUID(str(row["peer_media_id"]))
        if peer_id not in ordering:
            ordering[peer_id] = (1, 0.0, -int(row["shared_author_count"]), str(peer_id))
    refs = [
        ResourceRef(scheme="media", id=peer_id)
        for peer_id in sorted(ordering, key=lambda peer_id: ordering[peer_id])[:limit]
    ]
    resolved = resolve_refs(
        db, viewer_id=viewer_id, refs=refs, include_media_document_summary=False
    )
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris={
            ref.uri for ref, item in zip(refs, resolved, strict=True) if item.missing
        },
    )
    return [
        ConnectionEndpoint(
            ref=ref,
            label=item.label,
            description=item.summary or None,
            activation=activations[ref.uri],
            href=activations[ref.uri].href,
            missing=item.missing,
        )
        for ref, item in zip(refs, resolved, strict=True)
    ]


def build_lectern_slate(db: Session, *, viewer_id: UUID) -> SlateOut:
    """Up to ten next reads, empty while the Lectern queue is at capacity."""
    if not consumption_service.lectern_has_capacity(db, viewer_id=viewer_id):
        return SlateOut(items=[])
    as_of = _evidence.capture_as_of(db)
    candidates = _evidence.acquire_slate_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=_evidence.lectern_anchors(db, viewer_id=viewer_id),
        target_relation=_media_target_relation(
            projection.lectern_membership_rows_sql(),
            extra_predicate="AND COALESCE(engagement.read_state, 'Unread') <> 'Finished'",
        ),
        relation_params={},
        surface="lectern",
    )
    selected = _slate.compose_lectern(_slate.rank_lectern_candidates(candidates, as_of=as_of))
    return _hydrate_slate(db, viewer_id=viewer_id, selected=selected)


def build_library_slate(db: Session, *, viewer_id: UUID, library_id: UUID) -> SlateOut:
    """Up to ten relational suggestions for one admin-owned, non-system library."""
    context = library_governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if context.system_key is not None or context.role != "admin":
        return SlateOut(items=[])
    as_of = _evidence.capture_as_of(db)
    anchors = _evidence.library_anchors(db, viewer_id=viewer_id, library_id=library_id)
    if not anchors:
        return SlateOut(items=[])
    media_targets = _media_target_relation(library_entries.destination_membership_rows_sql())
    candidates = _evidence.acquire_slate_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=anchors,
        target_relation=(
            media_targets if context.is_default else _library_target_relation(media_targets)
        ),
        relation_params={"library_id": library_id},
        surface="library",
    )
    selected = _slate.compose_library(_slate.rank_library_candidates(candidates, as_of=as_of))
    return _hydrate_slate(db, viewer_id=viewer_id, selected=selected)


def _media_target_relation(membership_rows_sql: str, *, extra_predicate: str = "") -> str:
    """Visible media the surface does not already hold, with its dating facts.

    ``membership_rows_sql`` is the surface's own held-media relation and
    ``extra_predicate`` its own eligibility filter; both are checked-in SQL.
    """
    return f"""
        WITH candidates AS ({media_service.media_candidate_rows_sql()}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        membership AS ({membership_rows_sql}),
        engagement AS ({projection.engagement_fact_rows_sql()}),
        episodes AS ({episode_publication_rows_sql()})
        SELECT
            'media'::text AS target_scheme,
            candidates.media_id AS target_id,
            candidates.media_kind,
            candidates.created_at,
            candidates.original_published_date,
            engagement.read_state,
            engagement.progress_fraction,
            CASE
                WHEN engagement.last_engaged_at <= :as_of
                THEN engagement.last_engaged_at
            END AS last_engaged_at,
            episodes.published_at
        FROM candidates
        JOIN visible_media USING (media_id)
        LEFT JOIN engagement USING (media_id)
        LEFT JOIN episodes USING (media_id)
        WHERE NOT EXISTS (
            SELECT 1 FROM membership WHERE membership.media_id = candidates.media_id
        )
          {extra_predicate}
    """


def _library_target_relation(media_targets: str) -> str:
    """The media arm plus the subscribed podcasts a non-default library can hold.

    A podcast has no dating facts of its own: its arrival and engagement are
    aggregated from the visible episodes of that podcast.
    """
    return f"""
        WITH media_targets AS ({media_targets}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
        subscriptions AS ({active_subscription_rows_sql()}),
        membership AS ({library_entries.destination_membership_rows_sql()}),
        episode_publications AS ({episode_publication_rows_sql()}),
        engagement AS ({projection.engagement_fact_rows_sql()}),
        podcast_publications AS (
            SELECT
                episode_publications.podcast_id,
                MAX(episode_publications.published_at) AS published_at
            FROM episode_publications
            JOIN visible_media
              ON visible_media.media_id = episode_publications.media_id
            WHERE episode_publications.published_at <= :as_of
            GROUP BY episode_publications.podcast_id
        ),
        podcast_engagement AS (
            SELECT
                episode_publications.podcast_id,
                MAX(engagement.last_engaged_at) FILTER (
                    WHERE engagement.last_engaged_at <= :as_of
                ) AS last_engaged_at
            FROM episode_publications
            JOIN visible_media ON visible_media.media_id = episode_publications.media_id
            JOIN engagement ON engagement.media_id = episode_publications.media_id
            GROUP BY episode_publications.podcast_id
        )
        SELECT * FROM media_targets
        UNION ALL
        SELECT
            'podcast'::text AS target_scheme,
            subscriptions.podcast_id AS target_id,
            NULL::text AS media_kind,
            NULL::timestamptz AS created_at,
            NULL::text AS original_published_date,
            NULL::text AS read_state,
            NULL::float8 AS progress_fraction,
            podcast_engagement.last_engaged_at,
            podcast_publications.published_at
        FROM subscriptions
        JOIN visible_podcasts USING (podcast_id)
        LEFT JOIN podcast_publications USING (podcast_id)
        LEFT JOIN podcast_engagement USING (podcast_id)
        WHERE NOT EXISTS (
            SELECT 1 FROM membership WHERE membership.podcast_id = subscriptions.podcast_id
        )
    """


def _hydrate_slate(db: Session, *, viewer_id: UUID, selected: list[RankedCandidate]) -> SlateOut:
    media_targets = media_service.hydrate_compact_media_targets(
        db,
        viewer_id=viewer_id,
        media_ids=[row.target_ref.id for row in selected if row.target_ref.scheme == "media"],
    )
    podcast_targets = hydrate_compact_podcast_targets(
        db,
        viewer_id=viewer_id,
        podcast_ids=[row.target_ref.id for row in selected if row.target_ref.scheme == "podcast"],
    )
    items: list[SlateItemOut] = []
    for ranked in selected:
        ref = ranked.target_ref
        target_out: MediaSlateTargetOut | PodcastSlateTargetOut
        if ref.scheme == "media":
            media = media_targets[ref.id]
            target_out = MediaSlateTargetOut(
                ref=ref.uri,
                media_kind=media.media_kind,
                title=media.title,
                subtitle=media.subtitle,
                image_url=media.image_url,
                href=media.href,
            )
        else:
            podcast = podcast_targets[ref.id]
            target_out = PodcastSlateTargetOut(
                ref=ref.uri,
                title=podcast.title,
                subtitle=podcast.subtitle,
                image_url=podcast.image_url,
                href=podcast.href,
            )
        items.append(SlateItemOut(target=target_out, reason=_reason_out(ranked)))
    return SlateOut(items=items)


def _reason_out(ranked: RankedCandidate) -> SlateReasonOut:
    reason = ranked.reason
    if isinstance(reason, EdgeEvidence):
        return ConnectedSlateReasonOut(
            anchor=_anchor_out(reason.anchor), edge_origin=reason.edge_origin
        )
    if isinstance(reason, SharedAuthorEvidence):
        return SharedAuthorSlateReasonOut(
            anchor=_anchor_out(reason.anchor), author_name=reason.author_name
        )
    if isinstance(reason, SemanticEvidence):
        return SimilarSlateReasonOut(anchor=_anchor_out(reason.anchor))
    if isinstance(reason, ContinuityEvidence):
        return ContinueSlateReasonOut(
            progress=present(reason.progress) if reason.progress is not None else absent(),
            last_engaged_at=reason.last_engaged_at,
        )
    # An arrival with no exact instant is a publication date, which is a day.
    instant = reason.occurred_at
    if reason.kind == "AddedToNexus" and instant is not None:
        return AddedToNexusSlateReasonOut(added_at=instant)
    if reason.kind == "NewEpisode" and instant is not None:
        return NewEpisodeSlateReasonOut(published_at=instant)
    return PublishedSlateReasonOut(published_on=reason.occurred_on)


def _anchor_out(anchor: _slate.Anchor) -> SlateAnchorOut:
    return SlateAnchorOut(ref=anchor.ref.uri, label=anchor.label)
