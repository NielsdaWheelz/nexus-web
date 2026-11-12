"""Feed-scoped entry identities, shared media observations and insertion-only delivery.

The locked feed serializes aliases, entry creation and each complete page. An entry
has strong publisher identity or a stable permalink/enclosure, never title or time.
Conflicting identities skip the observation. A new occurrence may reuse an existing
article media; that occurrence still grants one arrival to current subscriptions.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobFailure
from nexus.logging import get_logger
from nexus.services import media_locks, source_attempts
from nexus.services.search import projection
from nexus.services.url_normalize import normalize_url_for_display, normalize_url_for_identity

from .parsing import ArticleFacts, EntryFacts, EpisodeFacts, is_safe_url

if TYPE_CHECKING:
    from nexus.services.feed_articles import PreparedFeedArticle

logger = get_logger(__name__)
type Scheme = Literal["PodcastIndex", "RssGuid", "RssEnclosure", "Permalink"]
_PRIORITY = {"PodcastIndex": 0, "RssGuid": 1, "RssEnclosure": 2, "Permalink": 3}


@dataclass(frozen=True, order=True, slots=True)
class Alias:
    scheme: Scheme
    value: str


@dataclass(frozen=True, slots=True)
class IngestResult:
    media_ids: list[UUID | None]
    inserted_entry_media_ids: list[UUID]
    private_skipped: bool
    unsafe_links: bool

    @property
    def skipped(self) -> int:
        return self.media_ids.count(None)


class _Skipped(Exception):
    pass


def identity_conflict() -> ConflictError:
    return ConflictError(ApiErrorCode.E_FEED_IDENTITY_CONFLICT, "Feed entry identity is ambiguous")


def aliases_of(entry: EntryFacts) -> tuple[Alias, ...]:
    aliases: list[Alias] = []
    if entry.guid:
        aliases.append(Alias("RssGuid", entry.guid))
    if isinstance(entry, EpisodeFacts):
        if entry.provider_ref:
            aliases.append(Alias("PodcastIndex", entry.provider_ref))
        if entry.audio_url and is_safe_url(entry.audio_url):
            aliases.append(Alias("RssEnclosure", normalize_url_for_display(entry.audio_url)))
    elif entry.entry_url and is_safe_url(entry.entry_url):
        aliases.append(Alias("Permalink", normalize_url_for_display(entry.entry_url)))
    return tuple(sorted(set(aliases)))


def _resolve(
    db: Session, feed_id: UUID, item: tuple[Alias, ...]
) -> tuple[UUID | None, UUID | None, set[Alias], str | None]:
    rows = db.execute(
        text("""SELECT i.scheme,i.value,i.entry_id,e.media_id,e.source_fingerprint
        FROM feed_entry_identities i JOIN feed_entries e ON e.id=i.entry_id
        WHERE i.feed_id=:feed AND i.entry_id IN (
            SELECT entry_id FROM feed_entry_identities WHERE feed_id=:feed AND (scheme,value) IN (
                SELECT * FROM unnest(CAST(:schemes AS text[]),CAST(:values AS text[]))))"""),
        {"feed": feed_id, "schemes": [a.scheme for a in item], "values": [a.value for a in item]},
    ).all()
    owners = {r.entry_id for r in rows}
    if len(owners) > 1:
        raise _Skipped("ambiguous_identity")
    if not owners:
        return None, None, set(), None
    stored = {Alias(r.scheme, r.value) for r in rows}
    for scheme in ("PodcastIndex", "RssGuid"):
        if len({a.value for a in stored | set(item) if a.scheme == scheme}) > 1:
            raise _Skipped("ambiguous_identity")
    return rows[0].entry_id, rows[0].media_id, stored, rows[0].source_fingerprint


def _article_fingerprint(facts: ArticleFacts) -> str:
    return hashlib.sha256(
        json.dumps(asdict(facts), sort_keys=True, default=str).encode()
    ).hexdigest()


def articles_needing_preparation(
    db: Session, *, feed_id: UUID, entries: Sequence[EntryFacts]
) -> set[int]:
    """Read-only preflight; publication repeats identity/fingerprint checks under its feed lock."""
    needed = set()
    for index, facts in enumerate(entries):
        if not isinstance(facts, ArticleFacts):
            continue
        item = aliases_of(facts)
        if not item or (facts.entry_url and not is_safe_url(facts.entry_url)):
            continue
        try:
            _, media_id, _, previous = _resolve(db, feed_id, item)
        except _Skipped:
            continue
        if media_id is None or previous != _article_fingerprint(facts):
            needed.add(index)
    return needed


def actor_for_feed(db: Session, feed_id: UUID) -> UUID | None:
    return db.scalar(
        text("""SELECT user_id FROM (
        SELECT user_id,0 AS priority FROM feed_catalog_access WHERE feed_id=:feed
        UNION SELECT l.owner_user_id,1 FROM libraries l
            JOIN library_feed_subscriptions s ON s.library_id=l.id WHERE s.feed_id=:feed
        UNION SELECT l.owner_user_id,2 FROM libraries l JOIN library_feed_imports i ON i.library_id=l.id
            JOIN feed_runs r ON r.id=i.run_id WHERE r.feed_id=:feed
            AND r.completed_at IS NULL AND r.cancelled_at IS NULL
        ) actors ORDER BY priority,user_id LIMIT 1"""),
        {"feed": feed_id},
    )


def ingest_entries(
    db: Session,
    *,
    feed_id: UUID,
    entries: Sequence[EntryFacts],
    prepared: Sequence[PreparedFeedArticle | None],
    actor_id: UUID | None = None,
) -> IngestResult:
    from nexus.services import feed_articles
    from nexus.services.podcasts import ingest as audio

    article_urls = sorted(
        {
            normalize_url_for_display(entry.entry_url)
            for entry in entries
            if isinstance(entry, ArticleFacts) and entry.entry_url and is_safe_url(entry.entry_url)
        }
    )
    for identity in sorted({normalize_url_for_identity(url) for url in article_urls}):
        source_attempts.lock_identity(db, f"web:{identity}")
    aliases = [aliases_of(entry) for entry in entries]
    existing_media = list(
        db.scalars(
            text("""SELECT DISTINCT e.media_id FROM feed_entries e
        JOIN feed_entry_identities i ON i.entry_id=e.id WHERE i.feed_id=:feed
        AND (i.scheme,i.value) IN (SELECT * FROM unnest(CAST(:schemes AS text[]),CAST(:values AS text[])))"""),
            {
                "feed": feed_id,
                "schemes": [a.scheme for items in aliases for a in items],
                "values": [a.value for items in aliases for a in items],
            },
        )
    )
    canonical_media = db.scalars(
        text("SELECT id FROM media WHERE kind='web_article' AND canonical_url=ANY(:urls)"),
        {"urls": article_urls},
    ).all()
    media_locks.lock_media_rows_in_order(db, sorted(set(existing_media) | set(canonical_media)))
    actor_id = actor_id or actor_for_feed(db, feed_id)
    media_ids: list[UUID | None] = [None] * len(entries)
    arrivals: list[UUID] = []
    written_audio: list[UUID] = []
    private_skipped = False
    unsafe_links = False
    for index, (facts, item, body) in enumerate(zip(entries, aliases, prepared, strict=True)):
        try:
            if not item:
                raise _Skipped("no_identity")
            entry_id, media_id, stored, previous_fingerprint = _resolve(db, feed_id, item)
            is_new = entry_id is None
            if isinstance(facts, EpisodeFacts):
                media_id = media_id or new_uuid7()
                entry_id = entry_id or media_id
                fingerprint, audio_changed = audio.observe(
                    db,
                    feed_id=feed_id,
                    media_id=media_id,
                    facts=facts,
                    provider_id=min(
                        stored | set(item), key=lambda a: (_PRIORITY[a.scheme], a.value)
                    ).value,
                    is_new=is_new,
                    actor_id=actor_id,
                )
                if audio_changed:
                    written_audio.append(media_id)
                unsafe_links = unsafe_links or bool(
                    facts.audio_url and not is_safe_url(facts.audio_url)
                )
                entry_url = facts.entry_url if is_safe_url(facts.entry_url) else None
            else:
                if facts.entry_url and not is_safe_url(facts.entry_url):
                    raise _Skipped("unsafe_entry_url")
                if actor_id is None:
                    raise _Skipped("no_source_authority")
                entry_id = entry_id or new_uuid7()
                fingerprint = _article_fingerprint(facts)
                if media_id is None or fingerprint != previous_fingerprint:
                    if body is None:
                        raise JobFailure(
                            ApiErrorCode.E_RESOURCE_CONFLICT.value,
                            "Feed observation changed during preparation",
                            "bounded_retry",
                        )
                    try:
                        observation = feed_articles.observe(
                            db,
                            feed_id=feed_id,
                            entry_id=entry_id,
                            facts=facts,
                            prepared=body,
                            existing_media_id=media_id,
                            actor_id=actor_id,
                        )
                        media_id = observation.media_id
                        if observation.deferred:
                            fingerprint = previous_fingerprint
                    except ApiError as exc:
                        if exc.code != ApiErrorCode.E_FEED_PRIVATE_SOURCE:
                            raise
                        raise _Skipped("private_source") from exc
                entry_url = (
                    facts.entry_url if facts.entry_url and is_safe_url(facts.entry_url) else None
                )
            db.execute(
                text("""INSERT INTO feed_entries(id,feed_id,media_id,entry_url,published_at,published_on,
                publication_evidence,publisher_updated_at,source_fingerprint)
                VALUES (:id,:feed,:media,:url,:published_at,:published_on,:evidence,:updated,:fingerprint)
                ON CONFLICT(id) DO UPDATE SET entry_url=COALESCE(excluded.entry_url,feed_entries.entry_url),
                published_at=COALESCE(excluded.published_at,feed_entries.published_at),
                published_on=CASE WHEN excluded.published_at IS NOT NULL OR feed_entries.published_at IS NOT NULL THEN NULL
                    ELSE COALESCE(excluded.published_on,feed_entries.published_on) END,
                publication_evidence=CASE WHEN excluded.publication_evidence='publisher' THEN 'publisher'
                    ELSE feed_entries.publication_evidence END,
                publisher_updated_at=COALESCE(excluded.publisher_updated_at,feed_entries.publisher_updated_at),
                source_fingerprint=excluded.source_fingerprint"""),
                {
                    "id": entry_id,
                    "feed": feed_id,
                    "media": media_id,
                    "url": entry_url,
                    "published_at": facts.published_at,
                    "published_on": facts.published_on,
                    "evidence": "publisher"
                    if facts.published_at or facts.published_on
                    else "unverified",
                    "updated": facts.publisher_updated_at,
                    "fingerprint": fingerprint,
                },
            )
            for alias in set(item) - stored:
                db.execute(
                    text("""INSERT INTO feed_entry_identities(id,feed_id,entry_id,scheme,value)
                    VALUES (:id,:feed,:entry,:scheme,:value)"""),
                    {
                        "id": new_uuid7(),
                        "feed": feed_id,
                        "entry": entry_id,
                        "scheme": alias.scheme,
                        "value": alias.value,
                    },
                )
            media_ids[index] = media_id
            if is_new:
                arrivals.append(media_id)
        except _Skipped as exc:
            private_skipped = private_skipped or str(exc) == "private_source"
            logger.warning("feed_entry_skipped", feed_id=str(feed_id), reason=str(exc))
    projection.refresh(db, "media", written_audio)
    return IngestResult(media_ids, list(dict.fromkeys(arrivals)), private_skipped, unsafe_links)
