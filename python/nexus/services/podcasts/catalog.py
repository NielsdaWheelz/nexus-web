"""Resolve source discoveries into canonical catalogue identities without saving them.

Provider reads happen before the owned database transaction. Retries dedupe by
show identity and episode aliases. Resolution creates no holding, rule, transcript
or model work; newly inserted episodes are published to existing delivery rules.
Local identity lookup is read-only and does not require personal membership.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas import podcast as wire
from nexus.services.browse.targets import ResolvedEpisode, ResolvedPodcast
from nexus.services.suggestion_changes import record_input_change

from . import imports
from .feed import EpisodeFacts
from .ingest import aliases_of, identity_conflict, ingest_episodes, lock_aliases
from .provider import PROVIDER
from .shows import upsert_show


def resolve_podcast(db: Session, body: wire.PodcastResolveRequest) -> wire.PodcastResolveOut:
    from nexus.services.browse.service import resolve_podcast_discovery_target

    show = resolve_podcast_discovery_target(body.target)
    if not isinstance(show, ResolvedPodcast):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_DISCOVERY_TARGET, "Discovery target is not a podcast"
        )

    def attempt() -> wire.PodcastResolveOut:
        podcast_id = upsert_show(db, show)
        record_input_change(db, owners=(f"podcast:{podcast_id}",))
        return wire.PodcastResolveOut(podcast_id=podcast_id, href=f"/podcasts/{podcast_id}")

    return retry_serializable(db, "resolve_podcast", attempt)


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
    show = resolved.podcast

    def attempt() -> wire.PodcastEpisodeResolveOut:
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
        imports.publish_episodes(
            db,
            podcast_id=podcast_id,
            media_ids=[media_id],
            new_media_ids=result.inserted_media_ids,
            import_id=None,
        )
        record_input_change(db, owners=(f"media:{media_id}",))
        return wire.PodcastEpisodeResolveOut(
            podcast_id=podcast_id, media_id=media_id, href=f"/media/{media_id}"
        )

    return retry_serializable(db, "resolve_podcast_episode", attempt)


def select_episode_media_id_by_podcast_index_ref(
    db: Session, *, viewer_id: UUID, podcast_ref: str, episode_ref: str
) -> UUID | None:
    """A locally known, eligible episode; lookup neither visits its source nor saves it."""
    return db.scalar(
        text(f"""
            SELECT i.episode_media_id
            FROM podcasts p
            JOIN podcast_episode_identities i
              ON i.podcast_id=p.id AND i.scheme='PodcastIndex' AND i.value=:episode_ref
            WHERE p.provider='podcast_index' AND p.provider_podcast_id=:podcast_ref
              AND i.episode_media_id IN ({requested_media_ids_cte_sql()})
        """),
        {"viewer_id": viewer_id, "podcast_ref": podcast_ref, "episode_ref": episode_ref},
    )
