"""The episode writer: observed episodes become media, by stable identity, exactly once.

Identity is a set of aliases per show: at most one PodcastIndex ref, at most one rss guid,
and any number of canonical enclosure urls. Title, date and random values are never
identity. An item whose identity is ambiguous is skipped and counted, never guessed.

Lock order, shared by every podcast writer: the caller's own row (subscription or
backfill), then the batch's alias advisory locks in canonical order, then the show row,
then media rows, library rows and the user row (lectern). Two writers of one show (two
syncs, a sync and a backfill, an add) therefore serialize per alias, and a repeated batch
converges on the same rows.
"""

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.services import library_entries
from nexus.services.collection_revisions import ENTRY_VISIBILITY_FAMILIES
from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.metadata_dispatch import enqueue_metadata_enrichment
from nexus.services.resource_mutation_replay import canonical_json_bytes
from nexus.services.transcripts.state import ensure_media_transcript_state_row
from nexus.services.url_normalize import normalize_url_for_display

from .feed import EpisodeFacts, is_safe_url
from .provider import PROVIDER
from .shows import bump_audience

logger = get_logger(__name__)

Scheme = Literal["PodcastIndex", "RssGuid", "RssEnclosure"]
_PRIORITY = {"PodcastIndex": 0, "RssGuid": 1, "RssEnclosure": 2}
# The feed's observed bibliography: an unchanged observation never undoes enrichment.
_FINGERPRINTED = (
    "title",
    "canonical_source_url",
    "external_playback_url",
    "description",
    "description_text",
    "edition_published_date",
    "language",
    "author_names",
)


@dataclass(frozen=True, order=True, slots=True)
class Alias:
    scheme: Scheme
    value: str


@dataclass(frozen=True, slots=True)
class IngestResult:
    media_ids: list[UUID | None]  # aligned with the input; None = skipped
    inserted: int
    added_to_all: int

    @property
    def skipped(self) -> int:
        return self.media_ids.count(None)


class _Skipped(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason


def identity_conflict() -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_PODCAST_EPISODE_IDENTITY_CONFLICT, "Podcast episode identity is ambiguous"
    )


def aliases_of(episode: EpisodeFacts) -> tuple[Alias, ...]:
    """Sorted; an enclosure counts only when it is a safe url, in display form."""
    aliases = [
        Alias("PodcastIndex", episode.provider_ref) if episode.provider_ref else None,
        Alias("RssGuid", episode.guid) if episode.guid else None,
        Alias("RssEnclosure", normalize_url_for_display(episode.audio_url))
        if episode.audio_url and is_safe_url(episode.audio_url)
        else None,
    ]
    return tuple(sorted({alias for alias in aliases if alias is not None}))


def lock_aliases(db: Session, show_identity: str, aliases: Iterable[Alias]) -> None:
    """``show_identity`` is ``provider:provider_podcast_id``, known before the show row is."""
    for alias in sorted(set(aliases)):
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"podcast-episode:{show_identity}:{alias.scheme}:{alias.value}"},
        )


def ingest_episodes(
    db: Session, *, viewer_id: UUID, podcast_id: UUID, feed_url: str, episodes: list[EpisodeFacts]
) -> IngestResult:
    """Upsert a batch newest first (undated last); every written episode lands in the
    viewer's All. An item without an alias, one claiming a strong alias a newer item of the
    batch claimed, or one whose aliases name two stored episodes is skipped. A batch that
    inserted or changed an episode moves its show audience's collections."""
    order = sorted(
        range(len(episodes)),
        key=lambda i: episodes[i].published_at or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    aliases = [aliases_of(episode) for episode in episodes]
    show = db.execute(
        text("SELECT provider, provider_podcast_id FROM podcasts WHERE id = :id"),
        {"id": podcast_id},
    ).one()
    lock_aliases(db, f"{show.provider}:{show.provider_podcast_id}", (a for x in aliases for a in x))
    db.execute(text("SELECT 1 FROM podcasts WHERE id = :id FOR UPDATE"), {"id": podcast_id})
    show_authors = [
        credit.credited_name
        for credit in load_contributor_credits_for_podcasts(db, [podcast_id]).get(podcast_id, [])
        if credit.role == "author" and credit.credited_name
    ]
    media_ids: list[UUID | None] = [None] * len(episodes)
    claimed: set[Alias] = set()
    inserted = added = 0
    moved = False
    for i in order:
        episode = episodes[i]
        item = aliases[i]
        try:
            if not item:
                raise _Skipped("no_identity")
            if any(alias in claimed for alias in item):
                raise _Skipped("alias_claimed_in_batch")
            claimed.update(alias for alias in item if alias.scheme != "RssEnclosure")
            media_id, stored = _resolve(db, podcast_id, item)
        except _Skipped as skip:
            logger.warning(
                "podcast_episode_skipped",
                podcast_id=str(podcast_id),
                reason=skip.reason,
                aliases=[f"{alias.scheme}:{alias.value}" for alias in item],
            )
            continue
        row = _row(episode, feed_url, show_authors)
        if media_id is None:
            media_id = new_uuid7()
            _insert(db, viewer_id, podcast_id, media_id, row, _display_alias(item))
            inserted += 1
            dirty = keys_moved = True
        else:
            dirty, keys_moved = _update(db, media_id, row, _display_alias({*stored, *item}))
        unbound = [alias for alias in item if alias not in stored]
        if unbound:
            db.execute(
                text("""
                    INSERT INTO podcast_episode_identities (
                        id, podcast_id, scheme, value, episode_media_id
                    )
                    VALUES (:id, :podcast_id, :scheme, :value, :media_id)
                """),
                [
                    {
                        "id": new_uuid7(),
                        "podcast_id": podcast_id,
                        "scheme": alias.scheme,
                        "value": alias.value,
                        "media_id": media_id,
                    }
                    for alias in unbound
                ],
            )
        if dirty:
            entries = [RawCreditEntry(credited_name=name) for name in row["author_names"]]
            apply_observed_role_slices_in_current_transaction(
                db,
                target=MediaTarget(media_id),
                observation=build_observation({"author": entries})[0],
                source="rss",
            )
            enqueue_metadata_enrichment(
                db, media_id=media_id, requester_user_id=viewer_id, request_id=None
            )
        added += library_entries.ensure_media_in_default_library(db, viewer_id, media_id)
        _replace_chapters(db, media_id, episode.chapters)
        media_ids[i] = media_id
        moved = moved or keys_moved
    if moved:
        bump_audience(db, podcast_id, ENTRY_VISIBILITY_FAMILIES)
    return IngestResult(media_ids=media_ids, inserted=inserted, added_to_all=added)


def _resolve(
    db: Session, podcast_id: UUID, item: tuple[Alias, ...]
) -> tuple[UUID | None, set[Alias]]:
    """The one stored episode these aliases name and all its aliases, or (None, {})."""
    rows = db.execute(
        text("""
            SELECT scheme, value, episode_media_id FROM podcast_episode_identities
            WHERE podcast_id = :podcast_id AND episode_media_id IN (
                SELECT episode_media_id FROM podcast_episode_identities
                WHERE podcast_id = :podcast_id AND (scheme, value) IN (
                    SELECT * FROM unnest(CAST(:schemes AS text[]), CAST(:values AS text[]))
                )
            )
        """),
        {
            "podcast_id": podcast_id,
            "schemes": [a.scheme for a in item],
            "values": [a.value for a in item],
        },
    ).all()
    owners = {row.episode_media_id for row in rows}
    if len(owners) > 1:
        raise _Skipped("ambiguous_identity")
    if not owners:
        return None, set()
    stored = {Alias(row.scheme, row.value) for row in rows}
    merged = stored | set(item)
    for scheme in ("PodcastIndex", "RssGuid"):
        if len({a.value for a in merged if a.scheme == scheme}) > 1:
            raise _Skipped("ambiguous_identity")
    new_enclosure = any(a.scheme == "RssEnclosure" and a not in stored for a in item)
    known_guid = any(a.scheme == "RssGuid" and a in stored for a in item)
    known_ref = any(a.scheme == "PodcastIndex" and a in stored for a in item)
    if new_enclosure and known_guid and not known_ref:  # a reused guid, re-hosted
        raise _Skipped("ambiguous_identity")
    return owners.pop(), stored


def _display_alias(aliases: Iterable[Alias]) -> str:
    return min(aliases, key=lambda a: (_PRIORITY[a.scheme], a.value)).value


def _row(episode: EpisodeFacts, feed_url: str, show_authors: list[str]) -> dict[str, Any]:
    published = episode.published_at
    return {
        "title": episode.title,
        "canonical_source_url": feed_url,
        "external_playback_url": episode.audio_url,
        "description": episode.description_text[:2000] if episode.description_text else None,
        "description_html": episode.description_html,
        "description_text": episode.description_text,
        "edition_published_date": published.date().isoformat() if published else None,
        "published_at": published,
        "duration_seconds": episode.duration_seconds,
        "language": episode.language,
        "rss_transcript_url": episode.transcript_url,
        "author_names": episode.authors or show_authors,
    }


def _fingerprint(row: dict[str, Any]) -> str:
    observed = {name: row[name] for name in _FINGERPRINTED}
    return hashlib.sha256(canonical_json_bytes(observed)).hexdigest()


def _insert(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    media_id: UUID,
    row: dict[str, Any],
    provider_id: str,
) -> None:
    params = row | {
        "media_id": media_id,
        "podcast_id": podcast_id,
        "provider": PROVIDER,
        "provider_id": provider_id,
        "viewer_id": viewer_id,
        "fingerprint": _fingerprint(row),
    }
    db.execute(
        text("""
            INSERT INTO media (
                id, kind, title, canonical_source_url, processing_status,
                external_playback_url, provider, provider_id, description,
                edition_published_date, language, created_by_user_id
            )
            VALUES (
                :media_id, 'podcast_episode', :title, :canonical_source_url, 'pending',
                :external_playback_url, :provider, :provider_id, :description,
                :edition_published_date, :language, :viewer_id
            )
        """),
        params,
    )
    ensure_media_transcript_state_row(db, media_id=media_id, now=datetime.now(UTC))
    db.execute(
        text("""
            INSERT INTO podcast_episodes (
                media_id, podcast_id, published_at, duration_seconds, description_html,
                description_text, rss_transcript_url, rss_metadata_fingerprint
            )
            VALUES (
                :media_id, :podcast_id, :published_at, :duration_seconds, :description_html,
                :description_text, :rss_transcript_url, :fingerprint
            )
        """),
        params,
    )


def _update(
    db: Session, media_id: UUID, row: dict[str, Any], provider_id: str
) -> tuple[bool, bool]:
    """Refresh one episode: bibliography only when the feed's observation changed, and a
    missing value never erases a stored one (show notes, sidecar, duration, date). Returns
    (observation changed, a list key changed)."""
    fingerprint = _fingerprint(row)
    previous = db.execute(
        text("""
            SELECT pe.rss_metadata_fingerprint, pe.published_at, pe.duration_seconds
            FROM media m JOIN podcast_episodes pe ON pe.media_id = m.id
            WHERE m.id = :media_id FOR UPDATE OF m
        """),
        {"media_id": media_id},
    ).one()
    dirty = previous.rss_metadata_fingerprint != fingerprint
    keys_moved = dirty or any(
        row[name] is not None and row[name] != getattr(previous, name)
        for name in ("published_at", "duration_seconds")
    )
    params = row | {"media_id": media_id, "provider_id": provider_id, "fingerprint": fingerprint}
    db.execute(
        text(
            """
            UPDATE media
            SET title = :title,
                canonical_source_url = :canonical_source_url,
                external_playback_url = :external_playback_url,
                description = COALESCE(:description, description),
                edition_published_date = COALESCE(:edition_published_date, edition_published_date),
                language = COALESCE(:language, language),
                provider = 'podcast_index', provider_id = :provider_id, updated_at = now()
            WHERE id = :media_id
            """
            if dirty
            # More aliases refine the display identity without restoring bibliography.
            else """
            UPDATE media SET provider = 'podcast_index', provider_id = :provider_id,
                updated_at = now()
            WHERE id = :media_id AND provider_id IS DISTINCT FROM :provider_id
            """
        ),
        params,
    )
    db.execute(
        text("""
            UPDATE podcast_episodes
            SET description_html = COALESCE(:description_html, description_html),
                description_text = COALESCE(:description_text, description_text),
                published_at = COALESCE(:published_at, published_at),
                duration_seconds = COALESCE(:duration_seconds, duration_seconds),
                rss_transcript_url = COALESCE(:rss_transcript_url, rss_transcript_url),
                rss_metadata_fingerprint = :fingerprint
            WHERE media_id = :media_id
        """),
        params,
    )
    return dirty, keys_moved


def _replace_chapters(db: Session, media_id: UUID, chapters: list[dict] | None) -> None:
    """None means the feed said nothing about chapters; a list replaces them."""
    if chapters is None:
        return
    db.execute(text("DELETE FROM podcast_episode_chapters WHERE media_id = :id"), {"id": media_id})
    unique: dict[tuple[int, str], dict] = {}
    for chapter in chapters:
        unique.setdefault((chapter["t_start_ms"], chapter["title"].lower()), chapter)
    if unique:
        db.execute(
            text("""
                INSERT INTO podcast_episode_chapters (
                    media_id, chapter_idx, title, t_start_ms, t_end_ms, url, image_url, source
                )
                VALUES (
                    :media_id, :idx, :title, :t_start_ms, :t_end_ms, :url, :image_url, :source
                )
            """),
            [c | {"media_id": media_id, "idx": i} for i, c in enumerate(unique.values())],
        )


def select_visible_episode_media_id_by_podcast_index_ref(
    db: Session, *, viewer_id: UUID, podcast_ref: str, episode_ref: str
) -> UUID | None:
    """An acquired Podcast Index episode the viewer can see (browse's owned check)."""
    return db.scalar(
        text(f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT i.episode_media_id
            FROM podcasts p
            JOIN podcast_episode_identities i
              ON i.podcast_id = p.id AND i.scheme = 'PodcastIndex' AND i.value = :episode_ref
            JOIN visible_media v ON v.media_id = i.episode_media_id
            WHERE p.provider = 'podcast_index' AND p.provider_podcast_id = :podcast_ref
        """),
        {"viewer_id": viewer_id, "podcast_ref": podcast_ref, "episode_ref": episode_ref},
    )
