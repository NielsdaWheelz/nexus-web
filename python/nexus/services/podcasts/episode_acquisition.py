"""Commit one Podcast episode discovery target into canonical Media."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.contributors import ContributorCreditIn
from nexus.schemas.podcast import (
    PodcastDestinationOutcomeOut,
    PodcastEpisodeFromDiscoveryOut,
    PodcastEpisodeFromDiscoveryRequest,
    PodcastSourceFacts,
)
from nexus.services import library_entries
from nexus.services.browse.models import ResolvedEpisode
from nexus.services.collection_revisions import CollectionFamily, read_collection_revision
from nexus.services.resource_mutation_replay import lookup_replay, record_replay

from .episode_identity import aliases_from_episode, lock_episode_aliases_for_podcast_identity
from .identity import (
    apply_podcast_contributor_credits_in_current_transaction,
    upsert_podcast,
    validate_and_normalize_feed_url,
)
from .ingest import sync_subscription_ingest
from .subscriptions import (
    PODCAST_CONTROL_REPLAY_SCOPE,
    lookup_podcast_control_replay,
    podcast_control_request_bytes,
)


def acquire_episode_from_discovery(
    db: Session,
    *,
    viewer_id: UUID,
    body: PodcastEpisodeFromDiscoveryRequest,
    idempotency_key: str,
) -> PodcastEpisodeFromDiscoveryOut:
    """Ingest exactly one discovered episode and place its Media in libraries."""
    from nexus.services.browse.service import resolve_podcast_discovery_target

    request_bytes = podcast_control_request_bytes(
        "POST", "/podcast-episodes/from-discovery", body.model_dump(mode="json", by_alias=True)
    )
    replay = lookup_podcast_control_replay(db, viewer_id, idempotency_key, request_bytes)
    if replay is not None:
        return PodcastEpisodeFromDiscoveryOut.model_validate(replay)

    resolved = resolve_podcast_discovery_target(body.target)
    if not isinstance(resolved, ResolvedEpisode):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a Podcast episode"
        )
    source = PodcastSourceFacts(
        provider_podcast_id=resolved.podcast.podcast_ref,
        title=resolved.podcast.title,
        contributors=(
            [ContributorCreditIn(credited_name=resolved.podcast.author, role="author")]
            if resolved.podcast.author
            else []
        ),
        feed_url=validate_and_normalize_feed_url(resolved.podcast.feed_url),
        website_url=resolved.podcast.website_url,
        image_url=resolved.podcast.image_url,
        description=resolved.podcast.description,
    )
    episode = {
        "podcast_index_episode_ref": resolved.episode_ref,
        "guid": resolved.guid,
        "title": resolved.title,
        "description_text": resolved.description,
        "description_html": None,
        "audio_url": resolved.audio_url,
        "published_at": resolved.published_at,
        "duration_seconds": resolved.duration_seconds,
        "authors": None,
        "rss_transcript_url": None,
        "rss_chapters": None,
        "language": None,
        "feed_language": None,
    }

    def attempt() -> PodcastEpisodeFromDiscoveryOut:
        with transaction(db):
            lock_episode_aliases_for_podcast_identity(
                db,
                podcast_identity=f"podcast_index:{source.provider_podcast_id}",
                aliases=aliases_from_episode(episode),
            )
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
            )
            if replay is not None:
                return PodcastEpisodeFromDiscoveryOut.model_validate(replay)

            now = datetime.now(UTC)
            podcast_id = upsert_podcast(db, source, now=now)
            apply_podcast_contributor_credits_in_current_transaction(
                db, podcast_id=podcast_id, contributors=source.contributors
            )
            sync_subscription_ingest(
                db=db,
                viewer_id=viewer_id,
                podcast_id=podcast_id,
                feed_url=source.feed_url,
                selected_episodes=[episode],
                now=now,
            )
            media_id = UUID(
                str(
                    db.execute(
                        text(
                            """
                            SELECT episode_media_id
                            FROM podcast_episode_identities
                            WHERE podcast_id = :podcast_id
                              AND scheme = 'PodcastIndex'
                              AND value = :episode_ref
                            """
                        ),
                        {"podcast_id": podcast_id, "episode_ref": resolved.episode_ref},
                    ).scalar_one()
                )
            )
            before = {
                library_id: (
                    library_entries.entry_exists(
                        db, library_id, library_entries.media_target(media_id)
                    ),
                    library_entries.entry_exists(
                        db, library_id, library_entries.podcast_target(podcast_id)
                    ),
                )
                for library_id in dict.fromkeys(body.named_library_ids)
            }
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, media_id, body.named_library_ids
            )
            response = PodcastEpisodeFromDiscoveryOut(
                href=f"/media/{media_id}",
                media_id=media_id,
                destination_outcomes=[
                    PodcastDestinationOutcomeOut(
                        library_id=library_id,
                        outcome=(
                            "IncludedThroughPodcast"
                            if parent_present
                            else ("AlreadyPresent" if media_present else "Added")
                        ),
                    )
                    for library_id, (media_present, parent_present) in before.items()
                ],
                collection_revision=read_collection_revision(
                    db, viewer_id=viewer_id, family=CollectionFamily.LibraryEntries
                ),
            )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=PODCAST_CONTROL_REPLAY_SCOPE,
                client_mutation_id=idempotency_key,
                request_bytes=request_bytes,
                response_json=response.model_dump(mode="json", by_alias=True),
            )
            return response

    return retry_read_committed(db, "acquire_podcast_episode", attempt)
