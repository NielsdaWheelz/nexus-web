"""Directory episode resolution into the shared feed catalogue, without saving."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas import podcast as wire
from nexus.services.browse.targets import ResolvedEpisode
from nexus.services.feeds import catalog, imports
from nexus.services.feeds.ingest import identity_conflict, ingest_entries
from nexus.services.feeds.parsing import EpisodeFacts
from nexus.services.suggestion_changes import record_input_change


def resolve_episode(
    db: Session, viewer_id: UUID, body: wire.PodcastResolveRequest
) -> wire.PodcastEpisodeResolveOut:
    from nexus.services.browse.service import resolve_podcast_discovery_target

    resolved = resolve_podcast_discovery_target(body.target)
    if not isinstance(resolved, ResolvedEpisode):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast episode"
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

    def attempt() -> wire.PodcastEpisodeResolveOut:
        feed_id = catalog.adopt_resolved(db, viewer_id, catalog.from_podcast(resolved.podcast))
        result = ingest_entries(
            db,
            actor_id=viewer_id,
            feed_id=feed_id,
            entries=[episode],
            prepared=[None],
        )
        media_id = result.media_ids[0]
        if media_id is None:
            raise identity_conflict()
        imports.publish_entries(
            db,
            feed_id=feed_id,
            media_ids=[media_id],
            new_entry_media_ids=result.inserted_entry_media_ids,
        )
        record_input_change(db, owners=(f"media:{media_id}",))
        return wire.PodcastEpisodeResolveOut(
            podcast_id=feed_id, media_id=media_id, href=f"/media/{media_id}"
        )

    return retry_serializable(db, "resolve_podcast_episode", attempt)


def select_episode_media_id_by_podcast_index_ref(
    db: Session, *, viewer_id: UUID, podcast_ref: str, episode_ref: str
) -> UUID | None:
    return db.scalar(
        text(f"""SELECT e.media_id FROM feeds p
        JOIN feed_entry_identities i ON i.feed_id=p.id AND i.scheme='PodcastIndex' AND i.value=:episode_ref
        JOIN feed_entries e ON e.id=i.entry_id
        WHERE p.kind='podcast' AND p.provider='podcast_index' AND p.provider_podcast_id=:podcast_ref
        AND e.media_id IN ({requested_media_ids_cte_sql()})"""),
        {"viewer_id": viewer_id, "podcast_ref": podcast_ref, "episode_ref": episode_ref},
    )
