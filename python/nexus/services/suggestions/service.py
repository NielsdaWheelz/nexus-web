"""Three deterministic contextual suggestion reads.

Read-only: no model call, no provider call, no job, no persisted
recommendation state. Each read composes policy-neutral relations owned by
other modules and hydrates through their compact target ports.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.schemas.consumption import ConsumptionOut, ConsumptionStateValue
from nexus.schemas.presence import absent, present
from nexus.schemas.suggestions import (
    MediaSuggestionTargetOut,
    PodcastSuggestionTargetOut,
    QuickReadsOut,
    SuggestionItemOut,
    SuggestionsOut,
)
from nexus.services import library_entries, library_governance, reading_time
from nexus.services import media as media_service
from nexus.services.consumption import projection
from nexus.services.consumption import service as consumption_service
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.podcasts.subscriptions_query import (
    active_subscription_rows_sql,
    hydrate_compact_podcast_targets,
)
from nexus.services.suggestions import _evidence, _ranking
from nexus.services.suggestions._ranking import RankedCandidate


def build_lectern_suggestions(db: Session, *, viewer_id: UUID) -> SuggestionsOut:
    """Up to ten next reads, empty while the Lectern queue is at capacity."""
    if not consumption_service.lectern_has_capacity(db, viewer_id=viewer_id):
        return SuggestionsOut(items=[])
    as_of = _evidence.capture_as_of(db)
    candidates = _evidence.acquire_suggestion_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=_evidence.lectern_anchors(db, viewer_id=viewer_id),
        target_relation=f"""
            SELECT targets.*
            FROM ({_media_target_relation()}) targets
            WHERE COALESCE(targets.read_state, 'Unread') <> 'Finished'
              AND NOT EXISTS (
                  SELECT 1 FROM ({projection.lectern_membership_rows_sql()}) membership
                  WHERE membership.media_id = targets.target_id
              )
        """,
        relation_params={},
        surface="lectern",
    )
    selected = _ranking.compose_lectern(
        _ranking.rank_lectern_candidates(candidates, as_of=as_of), limit=10
    )
    return SuggestionsOut(
        items=_hydrate_suggestion_items(db, viewer_id=viewer_id, selected=selected)
    )


def build_quick_reads(db: Session, *, viewer_id: UUID) -> QuickReadsOut:
    """Up to five unfinished documents under ten minutes from the current cursor."""
    as_of = _evidence.capture_as_of(db)
    candidates = _evidence.acquire_suggestion_candidates(
        db,
        viewer_id=viewer_id,
        as_of=as_of,
        anchors=_evidence.lectern_anchors(db, viewer_id=viewer_id),
        target_relation=f"""
            SELECT targets.*
            FROM ({_media_target_relation()}) targets
            JOIN ({reading_time.reading_time_rows_sql()}) duration
              ON duration.media_id = targets.target_id
            WHERE COALESCE(targets.read_state, 'Unread') <> 'Finished'
              AND duration.remaining_seconds > 0
              AND duration.remaining_seconds < 600
        """,
        relation_params={},
        surface="lectern",
    )
    selected = _ranking.compose_lectern(
        _ranking.rank_lectern_candidates(candidates, as_of=as_of), limit=5
    )
    return QuickReadsOut(
        items=_hydrate_suggestion_items(db, viewer_id=viewer_id, selected=selected)
    )


def build_library_suggestions(db: Session, *, viewer_id: UUID, library_id: UUID) -> SuggestionsOut:
    """Up to ten relational suggestions for one admin-owned, non-system library."""
    context = library_governance.lock_library_for_member(db, viewer_id, library_id, lock=False)
    if context.system_key is not None or context.role != "admin":
        return SuggestionsOut(items=[])
    as_of = _evidence.capture_as_of(db)
    anchors = _evidence.library_anchors(db, viewer_id=viewer_id, library_id=library_id)
    if not anchors:
        return SuggestionsOut(items=[])
    media_targets = f"""
        SELECT targets.*
        FROM ({_media_target_relation()}) targets
        WHERE NOT EXISTS (
            SELECT 1 FROM ({library_entries.destination_membership_rows_sql()}) membership
            WHERE membership.media_id = targets.target_id
        )
    """
    candidates = _evidence.acquire_suggestion_candidates(
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
    selected = _ranking.compose_library(_ranking.rank_library_candidates(candidates, as_of=as_of))
    return SuggestionsOut(
        items=_hydrate_suggestion_items(db, viewer_id=viewer_id, selected=selected)
    )


def _media_target_relation() -> str:
    """Visible media and contextual facts, before surface-specific eligibility."""
    return f"""
        WITH candidates AS ({media_service.media_candidate_rows_sql()}),
        visible_media AS ({visible_media_ids_cte_sql()}),
        engagement AS ({projection.engagement_fact_rows_sql()}),
        episodes AS ({episode_publication_rows_sql()})
        SELECT
            'media'::text AS target_scheme,
            candidates.media_id AS target_id,
            candidates.media_kind,
            candidates.created_at,
            candidates.original_published_date,
            engagement.read_state,
            CASE
                WHEN engagement.last_engaged_at <= :as_of
                THEN engagement.last_engaged_at
            END AS last_engaged_at,
            episodes.published_at
        FROM candidates
        JOIN visible_media USING (media_id)
        LEFT JOIN engagement USING (media_id)
        LEFT JOIN episodes USING (media_id)
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


def _hydrate_suggestion_items(
    db: Session, *, viewer_id: UUID, selected: list[RankedCandidate]
) -> list[SuggestionItemOut]:
    media_ids = [row.target_ref.id for row in selected if row.target_ref.scheme == "media"]
    media_targets = media_service.hydrate_compact_media_targets(
        db, viewer_id=viewer_id, media_ids=media_ids
    )
    consumption = projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)
    podcast_targets = hydrate_compact_podcast_targets(
        db,
        viewer_id=viewer_id,
        podcast_ids=[row.target_ref.id for row in selected if row.target_ref.scheme == "podcast"],
    )
    state_values: dict[str, ConsumptionStateValue] = {
        "unread": "Unread",
        "in_progress": "InProgress",
        "finished": "Finished",
    }
    items: list[SuggestionItemOut] = []
    for ranked in selected:
        ref = ranked.target_ref
        if ref.scheme == "media":
            media = media_targets[ref.id]
            consumed = consumption[ref.id]
            items.append(
                SuggestionItemOut(
                    target=MediaSuggestionTargetOut(
                        ref=ref.uri,
                        media_summary=media.summary,
                        image_url=media.image_url,
                        href=media.href,
                    ),
                    consumption=present(
                        ConsumptionOut(
                            state=state_values[consumed.state],
                            progress=(
                                present(consumed.progress_fraction)
                                if consumed.progress_fraction is not None
                                else absent()
                            ),
                            progress_resettable=consumed.progress_resettable,
                        )
                    ),
                )
            )
        else:
            podcast = podcast_targets[ref.id]
            items.append(
                SuggestionItemOut(
                    target=PodcastSuggestionTargetOut(
                        ref=ref.uri,
                        title=podcast.title,
                        subtitle=podcast.subtitle,
                        image_url=podcast.image_url,
                        href=podcast.href,
                    ),
                    consumption=absent(),
                )
            )
    return items
