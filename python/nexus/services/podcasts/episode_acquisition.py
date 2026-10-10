"""Add one discovered episode to the viewer's libraries without following its show."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas import podcast as wire
from nexus.services import library_entries
from nexus.services.browse.targets import ResolvedEpisode

from .feed import EpisodeFacts
from .ingest import aliases_of, identity_conflict, ingest_episodes, lock_aliases
from .provider import PROVIDER
from .shows import upsert_show


def acquire_episode(
    db: Session, viewer_id: UUID, body: wire.PodcastEpisodeFromDiscoveryRequest
) -> wire.PodcastEpisodeFromDiscoveryOut:
    """Upsert the show and the episode, file the episode in All and the named libraries.
    A repeat finds the same media and reports its destinations AlreadyPresent."""
    from nexus.services.browse.service import resolve_podcast_discovery_target  # imports us

    resolved = resolve_podcast_discovery_target(body.target)  # provider i/o, no txn
    if not isinstance(resolved, ResolvedEpisode):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a Podcast episode"
        )
    episode = EpisodeFacts(
        title=resolved.title,
        audio_url=resolved.audio_url,
        provider_ref=resolved.episode_ref,
        guid=resolved.guid,
        published_at=resolved.published_at,
        duration_seconds=resolved.duration_seconds,
        description_text=resolved.description,
    )
    show = resolved.podcast

    def attempt() -> wire.PodcastEpisodeFromDiscoveryOut:
        with transaction(db):
            # The alias locks precede the show row lock, as for every episode writer.
            lock_aliases(db, f"{PROVIDER}:{show.podcast_ref}", aliases_of(episode))
            podcast_id = upsert_show(db, show)
            result = ingest_episodes(
                db,
                viewer_id=viewer_id,
                podcast_id=podcast_id,
                feed_url=show.feed_url,
                episodes=[episode],
            )
            media_id = result.media_ids[0]
            if media_id is None:
                raise identity_conflict()
            outcomes = {}
            for library_id in dict.fromkeys(body.named_library_ids):
                if library_entries.entry_exists(
                    db, library_id, library_entries.podcast_target(podcast_id)
                ):
                    outcomes[library_id] = "IncludedThroughPodcast"
                elif library_entries.entry_exists(
                    db, library_id, library_entries.media_target(media_id)
                ):
                    outcomes[library_id] = "AlreadyPresent"
                else:
                    outcomes[library_id] = "Added"
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, media_id, body.named_library_ids
            )
            return wire.PodcastEpisodeFromDiscoveryOut(
                href=f"/media/{media_id}",
                media_id=media_id,
                destination_outcomes=[
                    wire.PodcastDestinationOutcomeOut(library_id=library_id, outcome=outcome)
                    for library_id, outcome in outcomes.items()
                ],
            )

    return retry_read_committed(db, "acquire_podcast_episode", attempt)
