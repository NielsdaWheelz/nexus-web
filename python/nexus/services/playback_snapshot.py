"""Frozen playback sources. Listing owners supply exact membership and total order.

A read-only repeatable-read transaction freezes provenance and identities together.
Filtering pins browser NFC/lowercase substring matching to Unicode 15 (Python 3.12) over title and every
credited/canonical author name. Only playable episodes enter a queue; shows never
expand. Selection loss and oversized results refuse the entire capture.
"""

from unicodedata import normalize
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas import playback_sessions as wire
from nexus.services import library_listing
from nexus.services.playback_source import episode_playback_source
from nexus.services.podcasts import episodes

MAX_ENTRIES = 10_000
# ECMAScript String.trim's whitespace and line terminators, unlike Python's strip.
_JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def capture(
    db: Session, viewer_id: UUID, body: wire.PlaybackSnapshotRequest
) -> wire.PlaybackSnapshotOut:
    source = body.source
    query = normalize("NFC", source.query.strip(_JS_WHITESPACE)).lower()
    if isinstance(source, wire.LibraryQueueCapture):
        label, ids = library_listing.ordered_selection_ids(
            db,
            viewer_id,
            source.library_id,
            library_listing.EntryView(
                source.sort, source.entry_type, source.projection, source.completion
            ),
        )
        provenance = wire.LibraryQueueSource(**source.model_dump(), label=label)
    else:
        label, ids = episodes.ordered_selection_ids(
            db, viewer_id, source.podcast_id, state=source.state, sort=source.sort
        )
        provenance = wire.PodcastQueueSource(**source.model_dump(), label=label)
    provenance.query = query
    eligible = playable_episode_fields(db, viewer_id, ids)
    matches = [
        media_id
        for media_id in ids
        if media_id in eligible
        and (
            not query
            or any(query in normalize("NFC", field).lower() for field in eligible[media_id])
        )
    ]
    if len(matches) > MAX_ENTRIES:
        raise ConflictError(ApiErrorCode.E_LIMIT, "Too many episodes; narrow this view")
    if body.selected_media_id not in matches:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Selected episode left the view")
    return wire.PlaybackSnapshotOut(source=provenance, media_ids=matches)


def playable_episode_fields(
    db: Session, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, list[str]]:
    """Visible playable episodes and their filter fields, without creating descriptors."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT m.id, m.kind, m.title, m.external_playback_url, m.canonical_source_url,
                   m.provider, m.provider_id
            FROM media m JOIN podcast_episodes pe ON pe.media_id = m.id
            WHERE m.id = ANY(:media_ids) AND m.id IN ({requested_media_ids_cte_sql()})
              AND m.kind = 'podcast_episode'
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    fields = {
        row.id: [row.title]
        for row in rows
        if episode_playback_source(
            kind=row.kind,
            has_episode=True,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        is not None
    }
    for row in db.execute(
        text("""
            SELECT cc.media_id, cc.credited_name, c.display_name
            FROM contributor_credits cc JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = ANY(:media_ids) AND cc.role = 'author'
        """),
        {"media_ids": list(fields)},
    ):
        fields[row.media_id].append(row.credited_name)
        if row.display_name is not None:
            fields[row.media_id].append(row.display_name)
    return fields
