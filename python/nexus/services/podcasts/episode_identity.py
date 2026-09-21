"""Strict episode alias normalization, locking and reconciliation."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.ids import new_uuid7
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from ._normalize import normalize_optional_text

EpisodeIdentityScheme = Literal["PodcastIndex", "RssGuid", "RssEnclosure"]


@dataclass(frozen=True, order=True, slots=True)
class EpisodeAlias:
    scheme: EpisodeIdentityScheme
    value: str


class EpisodeIdentityConflict(ConflictError):
    """Stored aliases or one provider batch make episode identity ambiguous."""

    def __init__(self, message: str):
        super().__init__(ApiErrorCode.E_PODCAST_EPISODE_IDENTITY_CONFLICT, message)


def aliases_from_episode(episode: dict[str, Any]) -> tuple[EpisodeAlias, ...]:
    aliases: list[EpisodeAlias] = []
    provider_ref = normalize_optional_text(episode.get("podcast_index_episode_ref"))
    if provider_ref is not None:
        aliases.append(EpisodeAlias("PodcastIndex", provider_ref))
    guid = normalize_optional_text(episode.get("guid"))
    if guid is not None:
        aliases.append(EpisodeAlias("RssGuid", guid))
    enclosure = _canonical_enclosure(episode.get("audio_url"))
    if enclosure is not None:
        aliases.append(EpisodeAlias("RssEnclosure", enclosure))
    return tuple(sorted(set(aliases)))


def validate_episode_alias_batch(
    episodes: Sequence[dict[str, Any]],
) -> tuple[tuple[EpisodeAlias, ...], ...]:
    """Reject one provider batch whose items claim the same strong alias."""
    aliases_by_item = tuple(aliases_from_episode(episode) for episode in episodes)
    owners: dict[EpisodeAlias, int] = {}
    for item_index, aliases in enumerate(aliases_by_item):
        for alias in aliases:
            if alias.scheme == "RssEnclosure":
                continue
            prior_index = owners.setdefault(alias, item_index)
            if prior_index == item_index:
                continue
            shares_provider_ref = any(
                candidate.scheme == "PodcastIndex" and candidate in aliases_by_item[prior_index]
                for candidate in aliases
            )
            if alias.scheme == "RssGuid" and shares_provider_ref:
                continue
            raise EpisodeIdentityConflict(
                f"distinct provider items claim the same {alias.scheme} alias"
            )
    return aliases_by_item


def lock_episode_aliases(db: Session, podcast_id: UUID, aliases: Iterable[EpisodeAlias]) -> None:
    """Take the batch's alias locks in canonical order under the show identity."""
    identity = db.execute(
        text("SELECT provider, provider_podcast_id FROM podcasts WHERE id = :podcast_id"),
        {"podcast_id": podcast_id},
    ).first()
    if identity is None:
        raise EpisodeIdentityConflict("episode Podcast identity is missing")
    lock_episode_aliases_for_podcast_identity(
        db,
        podcast_identity=f"{identity[0]}:{identity[1]}",
        aliases=aliases,
    )


def lock_episode_aliases_for_podcast_identity(
    db: Session,
    *,
    podcast_identity: str,
    aliases: Iterable[EpisodeAlias],
) -> None:
    for alias in sorted(set(aliases)):
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
            {"lock_key": f"podcast-episode:{podcast_identity}:{alias.scheme}:{alias.value}"},
        )


def resolve_episode_aliases_in_current_transaction(
    db: Session,
    *,
    podcast_id: UUID,
    aliases: Sequence[EpisodeAlias],
) -> UUID | None:
    """Resolve the one episode these aliases name, or fail closed.

    The caller holds the batch alias locks taken by :func:`lock_episode_aliases`.
    """
    if not aliases:
        return None
    rows = _stored_aliases(db, podcast_id=podcast_id, aliases=aliases)
    media_ids = {media_id for _alias, media_id in rows}
    if len(media_ids) > 1:
        raise EpisodeIdentityConflict("candidate aliases resolve to multiple Podcast episodes")
    if not media_ids:
        return None

    media_id = next(iter(media_ids))
    existing = _media_aliases(db, podcast_id=podcast_id, media_id=media_id)
    incoming = set(aliases)
    _require_one_strong_alias_per_scheme(existing | incoming)

    existing_guid = next((alias for alias in existing if alias.scheme == "RssGuid"), None)
    incoming_guid = next((alias for alias in incoming if alias.scheme == "RssGuid"), None)
    if (
        existing_guid is not None
        and incoming_guid == existing_guid
        and any(alias.scheme == "RssEnclosure" and alias not in existing for alias in incoming)
        and not any(alias.scheme == "PodcastIndex" and alias in existing for alias in incoming)
    ):
        raise EpisodeIdentityConflict(
            "duplicate RSS GUID with a new enclosure lacks Podcast Index equivalence"
        )
    return media_id


def attach_episode_aliases_in_current_transaction(
    db: Session,
    *,
    podcast_id: UUID,
    media_id: UUID,
    aliases: Sequence[EpisodeAlias],
) -> set[EpisodeAlias]:
    """Bind every candidate alias to this episode and return its whole set."""
    if not aliases:
        raise EpisodeIdentityConflict("episode has no stable identity alias")
    existing = _media_aliases(db, podcast_id=podcast_id, media_id=media_id)
    _require_one_strong_alias_per_scheme(existing | set(aliases))
    bound = dict(_stored_aliases(db, podcast_id=podcast_id, aliases=aliases))
    for alias in aliases:
        owner = bound.get(alias)
        if owner is not None:
            if owner != media_id:
                raise EpisodeIdentityConflict("episode alias is already bound to another Media")
            continue
        db.execute(
            text(
                """
                INSERT INTO podcast_episode_identities (
                    id, podcast_id, scheme, value, episode_media_id
                )
                VALUES (:id, :podcast_id, :scheme, :value, :media_id)
                """
            ),
            {
                "id": new_uuid7(),
                "podcast_id": podcast_id,
                "scheme": alias.scheme,
                "value": alias.value,
                "media_id": media_id,
            },
        )
    return existing | set(aliases)


def diagnostic_episode_alias(aliases: Iterable[EpisodeAlias]) -> EpisodeAlias:
    """Pick the monotone display alias: Podcast Index, then GUID, then enclosure."""
    priority = {"PodcastIndex": 0, "RssGuid": 1, "RssEnclosure": 2}
    ordered = sorted(aliases, key=lambda alias: (priority[alias.scheme], alias.value))
    if not ordered:
        raise EpisodeIdentityConflict("episode has no stable identity alias")
    return ordered[0]


def select_visible_episode_media_id_by_podcast_index_ref(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_ref: str,
    episode_ref: str,
) -> UUID | None:
    """Resolve an acquired Podcast Index episode without leaking hidden Media."""
    return db.scalar(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT identity.episode_media_id
            FROM podcasts podcast
            JOIN podcast_episode_identities identity
              ON identity.podcast_id = podcast.id
             AND identity.scheme = 'PodcastIndex'
             AND identity.value = :episode_ref
            JOIN visible_media ON visible_media.media_id = identity.episode_media_id
            WHERE podcast.provider = 'podcast_index'
              AND podcast.provider_podcast_id = :podcast_ref
            """
        ),
        {"viewer_id": viewer_id, "podcast_ref": podcast_ref, "episode_ref": episode_ref},
    )


def _stored_aliases(
    db: Session, *, podcast_id: UUID, aliases: Sequence[EpisodeAlias]
) -> list[tuple[EpisodeAlias, UUID]]:
    rows = db.execute(
        text(
            """
            SELECT scheme, value, episode_media_id
            FROM podcast_episode_identities
            WHERE podcast_id = :podcast_id
              AND (scheme, value) IN (
                  SELECT alias.scheme, alias.value
                  FROM unnest(CAST(:schemes AS text[]), CAST(:values AS text[]))
                    AS alias(scheme, value)
              )
            """
        ),
        {
            "podcast_id": podcast_id,
            "schemes": [alias.scheme for alias in aliases],
            "values": [alias.value for alias in aliases],
        },
    ).all()
    return [(EpisodeAlias(row[0], str(row[1])), UUID(str(row[2]))) for row in rows]


def _media_aliases(db: Session, *, podcast_id: UUID, media_id: UUID) -> set[EpisodeAlias]:
    rows = db.execute(
        text(
            """
            SELECT scheme, value
            FROM podcast_episode_identities
            WHERE podcast_id = :podcast_id AND episode_media_id = :media_id
            """
        ),
        {"podcast_id": podcast_id, "media_id": media_id},
    ).all()
    return {EpisodeAlias(row[0], str(row[1])) for row in rows}


def _require_one_strong_alias_per_scheme(aliases: Iterable[EpisodeAlias]) -> None:
    resolved = list(aliases)
    for scheme in ("PodcastIndex", "RssGuid"):
        if len({alias.value for alias in resolved if alias.scheme == scheme}) > 1:
            raise EpisodeIdentityConflict(f"episode has multiple {scheme} aliases")


def _canonical_enclosure(value: object) -> str | None:
    raw = normalize_optional_text(value)
    if raw is None:
        return None
    try:
        validate_requested_url(raw)
    except InvalidRequestError:
        return None
    return normalize_url_for_display(raw)
