"""Public deterministic contextual queries for Resonance.

This module composes policy-neutral owner ports. It performs no writes, model
calls, provider calls, or direct reads of sibling-owned storage.
"""

from __future__ import annotations

import base64
import json
import math
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.library import LibraryEntryOut, LibraryPageInfo
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
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.podcasts.subscriptions_query import (
    active_subscription_rows_sql,
    hydrate_compact_podcast_targets,
)
from nexus.services.resonance import _evidence
from nexus.services.resonance._evidence import (
    AddedToNexusEvidence,
    EdgeEvidence,
    NewEpisodeEvidence,
    PublishedEvidence,
    SemanticEvidence,
    SharedAuthorEvidence,
)
from nexus.services.resonance._ranking import (
    RelatedHit,
    rank_library_entries,
    rank_related,
    semantic_chunk_candidate_limit,
)
from nexus.services.resonance._reading_slate import (
    RankedCandidate,
    compose_lectern,
    compose_library,
    rank_lectern_candidates,
    rank_library_candidates,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import ConnectionEndpoint
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.semantic_chunks import media_neighbor_rows_sql, transcript_embedding_dimensions

_RESONANCE_CURSOR_KIND = "library_entries:resonance:v2"


def related_media(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    limit: int = 8,
) -> list[ConnectionEndpoint]:
    """Preserve Related's semantic/shared-author policy under Resonance ownership."""
    media_service.get_media_for_viewer(db, viewer_id, media_id)
    if limit < 1:
        return []
    visible_relation = f"""
        SELECT media_id, 'Related'::text AS candidate_partition
        FROM ({visible_media_ids_cte_sql()}) visible_media
    """
    candidate_limit = semantic_chunk_candidate_limit(limit)
    semantic_rows = db.execute(
        text(media_neighbor_rows_sql(visible_relation)),
        {
            "viewer_id": viewer_id,
            "anchor_media_id": media_id,
            "embedding_dimensions": transcript_embedding_dimensions(),
            "candidate_limit": candidate_limit,
        },
    ).mappings()
    by_id: dict[UUID, RelatedHit] = {
        UUID(str(row["peer_media_id"])): RelatedHit(
            media_id=UUID(str(row["peer_media_id"])),
            best_distance=float(row["distance"]),
            shared_author_count=0,
        )
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
        {
            "viewer_id": viewer_id,
            "anchor_media_id": media_id,
            "candidate_limit": candidate_limit,
        },
    ).mappings()
    for row in author_rows:
        peer_id = UUID(str(row["peer_media_id"]))
        existing = by_id.get(peer_id)
        by_id[peer_id] = RelatedHit(
            media_id=peer_id,
            best_distance=existing.best_distance if existing is not None else None,
            shared_author_count=int(row["shared_author_count"]),
        )
    ordered = rank_related(list(by_id.values()), limit=limit)
    refs = [ResourceRef(scheme="media", id=hit.media_id) for hit in ordered]
    resolved = resolve_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        include_media_document_summary=False,
    )
    missing_ref_uris = {ref.uri for ref, item in zip(refs, resolved, strict=True) if item.missing}
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris=missing_ref_uris,
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
    if not consumption_service.lectern_has_capacity(db, viewer_id=viewer_id):
        return SlateOut(items=[])
    as_of = _evidence.capture_as_of(db)
    anchors = _evidence.lectern_anchors(db, viewer_id=viewer_id)
    eligible_media = _lectern_eligible_media_relation()
    candidates = _evidence.acquire_slate_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=anchors,
        eligible_media_relation=eligible_media,
        eligible_target_relation=_media_target_relation(eligible_media),
        relation_params={},
        include_nonrelational=True,
    )
    selected = compose_lectern(rank_lectern_candidates(candidates, as_of=as_of))
    return _hydrate_slate(db, viewer_id=viewer_id, selected=selected)


def build_library_slate(db: Session, *, viewer_id: UUID, library_id: UUID) -> SlateOut:
    context = library_governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if context.system_key is not None or context.role != "admin":
        return SlateOut(items=[])
    as_of = _evidence.capture_as_of(db)
    anchors = _evidence.library_anchors(db, viewer_id=viewer_id, library_id=library_id)
    if not anchors:
        return SlateOut(items=[])
    eligible_media = _library_eligible_media_relation()
    eligible_targets = (
        _media_target_relation(eligible_media)
        if context.is_default
        else _library_target_relation(eligible_media)
    )
    candidates = _evidence.acquire_slate_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=anchors,
        eligible_media_relation=eligible_media,
        eligible_target_relation=eligible_targets,
        relation_params={"library_id": library_id},
        include_nonrelational=False,
    )
    selected = compose_library(rank_library_candidates(candidates, as_of=as_of))
    return _hydrate_slate(db, viewer_id=viewer_id, selected=selected)


def rank_library_entry_page(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    limit: int = 100,
    cursor: str | None = None,
) -> tuple[list[LibraryEntryOut], LibraryPageInfo]:
    """Rank complete visible physical membership before strict v2 keyset paging."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, 200)
    context = library_governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    library_governance.require_non_default(context.is_default)

    after_score: float | None = None
    after_entry_id: UUID | None = None
    if cursor is None:
        as_of = _evidence.capture_as_of(db)
    else:
        payload = _decode_resonance_cursor(cursor, viewer_id=viewer_id, library_id=library_id)
        try:
            as_of = datetime.fromisoformat(str(payload["as_of"]))
            raw_score = payload["score"]
            if isinstance(raw_score, bool) or not isinstance(raw_score, int | float):
                raise ValueError
            after_score = float(raw_score)
            after_entry_id = UUID(str(payload["entry_id"]))
            if not math.isfinite(after_score) or as_of.utcoffset() != timedelta(0):
                raise ValueError
        except ValueError:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None

    rows = rank_library_entries(
        db,
        viewer_id=viewer_id,
        library_id=library_id,
        as_of=as_of,
        after_score=after_score,
        after_entry_id=after_entry_id,
        limit=limit + 1,
    )
    page_rows = rows[:limit]
    has_more = len(rows) > limit
    entries = library_entries.hydrate_entry_page(
        db,
        viewer_id=viewer_id,
        facts=[row.hydration for row in page_rows],
    )
    next_cursor = None
    if has_more and page_rows:
        tail = page_rows[-1]
        next_cursor = _encode_resonance_cursor(
            {
                "k": _RESONANCE_CURSOR_KIND,
                "viewer_id": str(viewer_id),
                "library_id": str(library_id),
                "sort": "resonance",
                "as_of": as_of.isoformat(),
                "score": tail.score,
                "entry_id": str(tail.hydration.id),
            }
        )
    return entries, LibraryPageInfo(has_more=has_more, next_cursor=next_cursor)


def _lectern_eligible_media_relation() -> str:
    return f"""
        WITH candidates AS ({media_service.media_candidate_rows_sql()}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        membership AS ({consumption_service.lectern_membership_rows_sql()}),
        engagement AS ({consumption_service.engagement_fact_rows_sql()}),
        episodes AS ({episode_publication_rows_sql()})
        SELECT
            candidates.media_id,
            candidates.media_kind,
            candidates.created_at,
            candidates.published_date,
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
          AND COALESCE(engagement.read_state, 'Unread') <> 'Finished'
    """


def _library_eligible_media_relation() -> str:
    return f"""
        WITH candidates AS ({media_service.media_candidate_rows_sql()}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        membership AS ({library_entries.destination_membership_rows_sql()}),
        engagement AS ({consumption_service.engagement_fact_rows_sql()}),
        episodes AS ({episode_publication_rows_sql()})
        SELECT
            candidates.media_id,
            candidates.media_kind,
            candidates.created_at,
            candidates.published_date,
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
    """


def _media_target_relation(eligible_media_relation: str) -> str:
    return f"""
        SELECT
            'media'::text AS target_scheme,
            media_id AS target_id,
            media_kind,
            created_at,
            published_date,
            read_state,
            progress_fraction,
            last_engaged_at,
            published_at
        FROM ({eligible_media_relation}) eligible_media
    """


def _library_target_relation(eligible_media_relation: str) -> str:
    return f"""
        WITH media_targets AS ({_media_target_relation(eligible_media_relation)}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
        subscriptions AS ({active_subscription_rows_sql()}),
        membership AS ({library_entries.destination_membership_rows_sql()}),
        episode_publications AS ({episode_publication_rows_sql()}),
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
        engagement AS ({consumption_service.engagement_fact_rows_sql()}),
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
            NULL::text AS published_date,
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


def _hydrate_slate(
    db: Session,
    *,
    viewer_id: UUID,
    selected: list[RankedCandidate],
) -> SlateOut:
    media_ids = [row.target_ref.id for row in selected if row.target_ref.scheme == "media"]
    podcast_ids = [row.target_ref.id for row in selected if row.target_ref.scheme == "podcast"]
    media_targets = media_service.hydrate_compact_media_targets(
        db, viewer_id=viewer_id, media_ids=media_ids
    )
    podcast_targets = hydrate_compact_podcast_targets(
        db, viewer_id=viewer_id, podcast_ids=podcast_ids
    )
    if len(media_targets) != len(media_ids) or set(media_targets) != set(media_ids):
        # justify-defect: every selected media target was eligible and visible in this
        # repeatable-read snapshot, so compact hydration must preserve the exact set.
        raise AssertionError(
            f"Media Slate hydration drifted: expected {media_ids}, got {list(media_targets)}"
        )
    if len(podcast_targets) != len(podcast_ids) or set(podcast_targets) != set(podcast_ids):
        # justify-defect: every selected podcast target was eligible and visible in this
        # repeatable-read snapshot, so compact hydration must preserve the exact set.
        raise AssertionError(
            f"Podcast Slate hydration drifted: expected {podcast_ids}, got {list(podcast_targets)}"
        )
    items: list[SlateItemOut] = []
    for ranked in selected:
        ref = ranked.target_ref
        if ref.scheme == "media":
            target = media_targets[ref.id]
            target_out = MediaSlateTargetOut(
                ref=ref.uri,
                media_kind=target.media_kind,
                title=target.title,
                subtitle=target.subtitle,
                image_url=target.image_url,
                href=target.href,
            )
        elif ref.scheme == "podcast":
            target = podcast_targets[ref.id]
            target_out = PodcastSlateTargetOut(
                ref=ref.uri,
                title=target.title,
                subtitle=target.subtitle,
                image_url=target.image_url,
                href=target.href,
            )
        else:
            # justify-defect: acquisition emits only destination-addable targets.
            raise AssertionError(f"non-addable Slate target: {ref.uri}")
        items.append(SlateItemOut(target=target_out, reason=_reason_out(ranked)))
    return SlateOut(items=items)


def _reason_out(ranked: RankedCandidate) -> SlateReasonOut:
    evidence = ranked.evidence
    if ranked.family == "Continuity":
        continuity = evidence.continuity
        if continuity is None:
            raise AssertionError("Continuity item has no evidence")
        return ContinueSlateReasonOut(
            progress=(
                present(continuity.progress) if continuity.progress is not None else absent()
            ),
            last_engaged_at=continuity.last_engaged_at,
        )
    reason = ranked.reason
    if isinstance(reason, AddedToNexusEvidence):
        return AddedToNexusSlateReasonOut(added_at=reason.added_at)
    if isinstance(reason, PublishedEvidence):
        return PublishedSlateReasonOut(published_on=reason.published_on)
    if isinstance(reason, NewEpisodeEvidence):
        return NewEpisodeSlateReasonOut(published_at=reason.published_at)
    if isinstance(reason, EdgeEvidence):
        return ConnectedSlateReasonOut(
            anchor=_anchor_out(reason.anchor), edge_origin=reason.edge_origin
        )
    if isinstance(reason, SharedAuthorEvidence):
        return SharedAuthorSlateReasonOut(
            anchor=_anchor_out(reason.anchor), author_name=reason.authors[0].display_name
        )
    if isinstance(reason, SemanticEvidence):
        return SimilarSlateReasonOut(anchor=_anchor_out(reason.anchor))
    raise AssertionError(f"Slate item has no renderable reason: {ranked.target_ref.uri}")


def _anchor_out(anchor: _evidence.Anchor) -> SlateAnchorOut:
    return SlateAnchorOut(ref=anchor.ref.uri, label=anchor.label)


def _encode_resonance_cursor(payload: dict[str, object]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    # justify-base64url-over-base64: this opaque value is transported in a URL
    # query parameter and must not introduce reserved path/form characters.
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_resonance_cursor(cursor: str, *, viewer_id: UUID, library_id: UUID) -> dict[str, Any]:
    try:
        if not cursor or len(cursor) > 2048 or "=" in cursor:
            raise ValueError
        padded = cursor + "=" * (-len(cursor) % 4)
        # justify-base64url-over-base64: the canonical cursor alphabet is URL-safe
        # because this opaque value is transported in a query parameter.
        raw = base64.urlsafe_b64decode(padded)
        if base64.urlsafe_b64encode(raw).decode().rstrip("=") != cursor:
            raise ValueError
        payload = json.loads(raw.decode())
        if (
            not isinstance(payload, dict)
            or set(payload)
            != {"k", "viewer_id", "library_id", "sort", "as_of", "score", "entry_id"}
            or payload["k"] != _RESONANCE_CURSOR_KIND
            or payload["sort"] != "resonance"
            or not isinstance(payload["viewer_id"], str)
            or not isinstance(payload["library_id"], str)
            or not isinstance(payload["as_of"], str)
            or not isinstance(payload["entry_id"], str)
            or str(UUID(payload["viewer_id"])) != payload["viewer_id"]
            or str(UUID(payload["library_id"])) != payload["library_id"]
            or str(UUID(payload["entry_id"])) != payload["entry_id"]
            or UUID(payload["viewer_id"]) != viewer_id
            or UUID(payload["library_id"]) != library_id
        ):
            raise ValueError
        return payload
    except (ValueError, RecursionError):
        # justify-ignore-error: malformed cursor input is expected; ValueError covers
        # base64, UTF-8, JSON, UUID, and explicit shape validation failures.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None
