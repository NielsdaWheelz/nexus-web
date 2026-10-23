"""Add one discovered episode to the viewer's libraries without following its show."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas import podcast as wire
from nexus.services import libraries, library_entries, users
from nexus.services.browse.targets import ResolvedEpisode
from nexus.services.suggestion_changes import record_input_change

from . import imports
from .feed import EpisodeFacts
from .ingest import aliases_of, identity_conflict, ingest_episodes, lock_aliases
from .provider import PROVIDER
from .shows import upsert_show


def acquire_episode(
    db: Session, viewer_id: UUID, body: wire.PodcastEpisodeFromDiscoveryRequest
) -> wire.PodcastEpisodeFromDiscoveryOut:
    """Upsert the show and the episode, file the episode in All and the named libraries.
    Retry rule: identity deduplicates catalog rows; every fresh admission validates
    its frozen removal/destination guards. There is no receipt to bypass stale guards."""
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
            users.lock_viewer(db, viewer_id)
            # The alias locks precede the show row lock, as for every episode writer.
            lock_aliases(db, f"{PROVIDER}:{show.podcast_ref}", aliases_of(episode))
            podcast_id = upsert_show(db, show)
            db.execute(text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
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
            rule_libraries = list(
                db.scalars(
                    text(
                        "SELECT library_id FROM library_podcast_subscriptions WHERE podcast_id=:id"
                    ),
                    {"id": podcast_id},
                )
            )
            libraries.lock_library_rows_in_order(
                db,
                [
                    libraries.default_library_id(db, viewer_id),
                    *[guard.library_id for guard in body.destinations],
                    *rule_libraries,
                ],
            )
            destinations = library_entries.validate_acquisition_destinations(
                db,
                viewer_id=viewer_id,
                expected_removal_revision=int(body.expected_removal_revision),
                destinations=body.destinations,
            )
            outcomes = {}
            for library_id in destinations:
                outcomes[library_id] = (
                    "AlreadyPresent"
                    if library_entries.entry_exists(
                        db, library_id, library_entries.media_target(media_id)
                    )
                    else "Added"
                )
            imports.publish_episodes(
                db,
                podcast_id=podcast_id,
                media_ids=[media_id],
                new_media_ids=result.inserted_media_ids,
                import_id=None,
            )
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, media_id, destinations
            )
            library_entries.finish_acquisition_destinations(db, destinations=body.destinations)
            record_input_change(db)
            return wire.PodcastEpisodeFromDiscoveryOut(
                href=f"/media/{media_id}",
                media_id=media_id,
                destination_outcomes=[
                    wire.PodcastDestinationOutcomeOut(library_id=library_id, outcome=outcome)
                    for library_id, outcome in outcomes.items()
                ],
            )

    return retry_read_committed(db, "acquire_podcast_episode", attempt)
