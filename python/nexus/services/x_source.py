"""Current X evidence, source labels and the retained-publication predicate."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

import regex
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import XSourceSnapshot as StoredXSourceSnapshot
from nexus.ids import new_uuid7
from nexus.schemas.media import XSourceContext
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.schemas.x_source import XSourcePost, XSourceSnapshot
from nexus.services.x_identity import classify_x_url


@dataclass(frozen=True, slots=True)
class PublishedXSource:
    source_attempt_id: UUID
    snapshot: XSourceSnapshot


def load_x_source(db: Session, *, media_id: UUID) -> Presence[PublishedXSource]:
    row = db.scalar(select(StoredXSourceSnapshot).where(StoredXSourceSnapshot.media_id == media_id))
    if row is None:
        return absent()
    return present(
        PublishedXSource(
            row.source_attempt_id, XSourceSnapshot.model_validate_json(json.dumps(row.payload))
        )
    )


def x_source_attempt_ids(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, UUID]:
    if not media_ids:
        return {}
    return dict(
        db.execute(
            select(StoredXSourceSnapshot.media_id, StoredXSourceSnapshot.source_attempt_id).where(
                StoredXSourceSnapshot.media_id.in_(media_ids)
            )
        )
        .tuples()
        .all()
    )


def publish_x_source(
    db: Session, *, media_id: UUID, source_attempt_id: UUID, snapshot: XSourceSnapshot
) -> None:
    """Replace the one current evidence row; caller owns source/publication locks and commit."""
    existing = db.scalar(
        select(StoredXSourceSnapshot.id).where(StoredXSourceSnapshot.media_id == media_id)
    )
    if existing is not None:
        deleted = db.execute(
            text("DELETE FROM x_source_snapshots WHERE id = :id RETURNING id"), {"id": existing}
        ).scalar_one()
        assert deleted == existing
    db.add(
        StoredXSourceSnapshot(
            id=new_uuid7(),
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            payload=snapshot.model_dump(mode="json"),
        )
    )
    db.flush()


def retained_x_publication_sql(alias: str) -> str:
    """A successful readable copy, including one predating normalized X evidence."""
    return f"""({alias}.kind = 'web_article' AND {alias}.provider = 'x'
        AND EXISTS (SELECT 1 FROM reader_publications rp WHERE rp.media_id = {alias}.id)
        AND EXISTS (SELECT 1 FROM fragments f WHERE f.media_id = {alias}.id
                    AND length(btrim(f.canonical_text)) > 0))"""


def has_retained_x_publication(db: Session, *, media_id: UUID) -> bool:
    return bool(
        db.scalar(
            text(f"SELECT {retained_x_publication_sql('m')} FROM media m WHERE m.id = :media_id"),
            {"media_id": media_id},
        )
    )


def authored_text(post: XSourcePost, *, remove_attachment_urls: bool = True) -> str:
    """Remove identified quote tokens; title evidence also omits attachment tokens."""
    quotes = {reference.post_id for reference in post.references if reference.kind == "quoted"}
    value = post.text
    for entity in post.urls:
        quote = any(
            (identity := classify_x_url(url)) is not None and identity.provider_id in quotes
            for url in (
                entity.url,
                entity.expanded_url.value if isinstance(entity.expanded_url, Present) else "",
            )
        )
        if quote or (remove_attachment_urls and isinstance(entity.attachment_media_key, Present)):
            value = value.replace(entity.url, "")
    return value.strip()


def source_label(snapshot: XSourceSnapshot) -> str:
    """The first authored opening, at most 120 code points with intact graphemes."""
    for post_id in snapshot.primary_post_ids:
        value = " ".join(authored_text(snapshot.posts[post_id]).split())
        if not value:
            continue
        if len(value) <= 120:
            return value
        grapheme_ends = set()
        for match in regex.finditer(r"\X", value):
            if match.end() > 119:
                break
            grapheme_ends.add(match.end())
        if not grapheme_ends:
            break
        end = max(grapheme_ends)
        boundary = 0
        for match in regex.finditer(r"\b", value, regex.WORD):
            if match.start() > end:
                break
            if match.start() in grapheme_ends:
                boundary = match.start()
        # A mention/hashtag alone is not an excerpt of the body that follows it.
        if boundary and regex.fullmatch(r"(?:[@#]\S*\s*)+", value[:boundary]):
            boundary = 0
        return value[: boundary or end].rstrip() + "…"
    author = snapshot.posts[snapshot.requested_post_id].author
    kind = "thread" if snapshot.source_kind == "author_thread" else "post"
    return f"x {kind} by @{author.username}"


def quoted_post_snapshot(snapshot: XSourceSnapshot, post_id: str) -> XSourceSnapshot:
    """A child's own evidence uses only direct context already captured for its parent."""
    primary = snapshot.posts[post_id]
    ids = {
        post_id,
        *(
            reference.post_id
            for reference in primary.references
            if reference.availability == "available"
        ),
    }
    posts = {
        identity: post.model_copy(
            update={
                "references": tuple(
                    reference.model_copy(update={"availability": "not_captured"})
                    if reference.availability == "available" and reference.post_id not in ids
                    else reference
                    for reference in post.references
                )
            }
        )
        for identity, post in snapshot.posts.items()
        if identity in ids
    }
    return XSourceSnapshot(
        source_kind="post",
        requested_post_id=post_id,
        primary_post_ids=(post_id,),
        posts=posts,
        enumeration="exhausted",
    )


def x_source_contexts(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, XSourceContext]:
    """Batch the public capture coverage without exposing its private evidence payload."""
    if not media_ids:
        return {}
    result = {}
    for row in db.scalars(
        select(StoredXSourceSnapshot).where(StoredXSourceSnapshot.media_id.in_(media_ids))
    ):
        snapshot = XSourceSnapshot.model_validate_json(json.dumps(row.payload))
        references = [
            reference for post in snapshot.posts.values() for reference in post.references
        ]
        result[row.media_id] = XSourceContext(
            source_attempt_id=row.source_attempt_id,
            published_at=row.published_at,
            enumeration=snapshot.enumeration,
            unavailable_context_count=len(
                {
                    reference.post_id
                    for reference in references
                    if reference.availability == "unavailable"
                }
            ),
            uncaptured_context_count=len(
                {
                    reference.post_id
                    for reference in references
                    if reference.availability == "not_captured"
                }
            ),
        )
    return result
