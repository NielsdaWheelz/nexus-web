"""Podcast audio materialization. Shared feed entries own identity and publication."""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.contributor_credits import load_contributor_credits_for_podcasts
from nexus.services.contributor_taxonomy import RawCreditEntry, build_observation
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.feeds.parsing import EpisodeFacts, is_safe_url
from nexus.services.transcripts.state import ensure_media_transcript_state_row

from . import chapters
from .provider import PROVIDER

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


def observe(
    db: Session,
    *,
    feed_id: UUID,
    media_id: UUID,
    facts: EpisodeFacts,
    provider_id: str,
    is_new: bool,
    actor_id: UUID | None,
) -> tuple[str, bool]:
    authors = [
        credit.credited_name
        for credit in load_contributor_credits_for_podcasts(db, [feed_id]).get(feed_id, [])
        if credit.role == "author" and credit.credited_name
    ]
    row = _row(facts, authors)
    if is_new:
        _insert(db, actor_id, media_id, row, provider_id)
        dirty = changed = True
    else:
        dirty, changed = _update(db, media_id, row, provider_id)
    if dirty:
        observation, _ = build_observation(
            {"author": [RawCreditEntry(credited_name=name) for name in row["author_names"]]}
        )
        apply_observed_role_slices_in_current_transaction(
            db, target=MediaTarget(media_id), observation=observation, source="rss"
        )
    chapters.observe(
        db, media_id=media_id, inline=facts.chapters, source_url=facts.chapters_source_url
    )
    return _fingerprint(row), changed


def _row(episode: EpisodeFacts, show_authors: list[str]) -> dict[str, Any]:
    published = episode.published_at
    return {
        "title": episode.title,
        "canonical_source_url": episode.entry_url if is_safe_url(episode.entry_url) else None,
        "external_playback_url": episode.audio_url if is_safe_url(episode.audio_url) else None,
        "description": episode.description_text[:2000] if episode.description_text else None,
        "description_html": episode.description_html,
        "description_text": episode.description_text,
        "edition_published_date": published.date().isoformat()
        if published
        else episode.published_on.isoformat()
        if episode.published_on
        else None,
        "published_at": published,
        "duration_seconds": episode.duration_seconds,
        "language": episode.language,
        "rss_transcript_url": episode.transcript_url,
        "author_names": episode.authors or show_authors,
    }


def _fingerprint(row: dict[str, Any]) -> str:
    observed = {name: row[name] for name in _FINGERPRINTED}
    encoded = json.dumps(observed, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _insert(
    db: Session,
    viewer_id: UUID | None,
    media_id: UUID,
    row: dict[str, Any],
    provider_id: str,
) -> None:
    params = row | {
        "media_id": media_id,
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
                media_id, duration_seconds, description_html,
                description_text, rss_transcript_url
            )
            VALUES (
                :media_id, :duration_seconds, :description_html,
                :description_text, :rss_transcript_url
            )
        """),
        params,
    )


def _update(
    db: Session, media_id: UUID, row: dict[str, Any], provider_id: str
) -> tuple[bool, bool]:
    """Refresh one episode: bibliography only when the feed's observation changed, and a
    missing value never erases a stored one (show notes, sidecar, duration, date). Returns
    whether the bibliography and recommendation inputs changed, respectively."""
    fingerprint = _fingerprint(row)
    previous = db.execute(
        text("""
            SELECT e.source_fingerprint AS rss_metadata_fingerprint, e.published_at, pe.duration_seconds
            FROM media m JOIN podcast_episodes pe ON pe.media_id = m.id
            JOIN feed_entries e ON e.id=pe.media_id
            WHERE m.id = :media_id FOR UPDATE OF m
        """),
        {"media_id": media_id},
    ).one()
    dirty = previous.rss_metadata_fingerprint != fingerprint
    params = row | {"media_id": media_id, "provider_id": provider_id, "fingerprint": fingerprint}
    db.execute(
        text(
            """
            UPDATE media
            SET title = :title,
                canonical_source_url = COALESCE(:canonical_source_url, canonical_source_url),
                external_playback_url = COALESCE(:external_playback_url, external_playback_url),
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
                duration_seconds = COALESCE(:duration_seconds, duration_seconds),
                rss_transcript_url = COALESCE(:rss_transcript_url, rss_transcript_url)
            WHERE media_id = :media_id
        """),
        params,
    )
    changed = dirty or any(
        row[key] is not None and row[key] != getattr(previous, key)
        for key in ("published_at", "duration_seconds")
    )
    return dirty, changed
