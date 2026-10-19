"""Current X evidence, carrier/article associations and retained publication.

Inspections survive failed thread publication and native identity deduplication.
Absence of a row means uninspected; a null article id is a qualified negative.
Deleting an article clears its media link while retaining the known public identity.
Only source admission recreates that child; reads never perform acquisition.
Native articles dedupe only by provider identity; their public source URL does not
claim the generic-web canonical URL key, so independent captures remain separate.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

import regex
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, XArticleInspection
from nexus.db.models import XSourceSnapshot as StoredXSourceSnapshot
from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.schemas.media import XSourceContext
from nexus.schemas.x_source import XSourcePost, XSourceSnapshot
from nexus.services.x_identity import classify_x_url, x_article_provider_id


@dataclass(frozen=True, slots=True)
class PublishedXSource:
    source_attempt_id: UUID
    snapshot: XSourceSnapshot


def x_article_child_media_ids(db: Session, *, thread_media_ids: Sequence[UUID]) -> set[UUID]:
    """The acquired children, including pending/failed ones without reader embeds."""
    return {
        media_id
        for media_id in db.scalars(
            select(XArticleInspection.article_media_id).where(
                XArticleInspection.thread_media_id.in_(thread_media_ids),
                XArticleInspection.article_media_id.is_not(None),
            )
        )
        if media_id is not None
    }


def x_article_links(
    db: Session,
    *,
    media_id: UUID,
    snapshot: XSourceSnapshot,
    observations: Mapping[str, str | None],
) -> dict[str, tuple[str, UUID | None]]:
    """Applicable acquired references, never inferred from unrelated thread posts.

    Fresh qualified evidence may suppress a stale association. An omitted observation
    is uninspected, not negative. Deletion keeps the identified public source link.
    """
    links: dict[str, tuple[str, UUID | None]] = {}
    for row in db.scalars(
        select(XArticleInspection).where(
            XArticleInspection.thread_media_id == media_id,
            XArticleInspection.carrier_post_id.in_(snapshot.primary_post_ids),
        )
    ):
        if row.article_id is None or (
            row.carrier_post_id in observations
            and observations[row.carrier_post_id] != row.article_id
        ):
            continue
        if row.article_media_id is not None:
            child = db.get(Media, row.article_media_id)
            assert child is not None and child.provider == "x"
            assert child.provider_id == x_article_provider_id(row.article_id)
        links[row.carrier_post_id] = (row.article_id, row.article_media_id)
    return links


def rehome_x_article_inspections(db: Session, *, loser_id: UUID, winner_id: UUID) -> None:
    """Merge current associations before loser teardown, under both media locks."""
    rows = list(
        db.scalars(select(XArticleInspection).where(XArticleInspection.thread_media_id == loser_id))
    )
    for row in rows:
        existing = db.get(XArticleInspection, (winner_id, row.carrier_post_id))
        if existing is None:
            row.thread_media_id = winner_id
        else:
            if existing.article_id != row.article_id:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "The article association changed."
                )
            if existing.article_media_id is None:
                existing.article_media_id = row.article_media_id
            elif row.article_media_id not in (None, existing.article_media_id):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "The saved article identity changed."
                )
            db.delete(row)
    db.flush()


def load_x_source(db: Session, *, media_id: UUID) -> PublishedXSource | None:
    row = db.scalar(select(StoredXSourceSnapshot).where(StoredXSourceSnapshot.media_id == media_id))
    if row is None:
        return None
    return PublishedXSource(
        row.source_attempt_id, XSourceSnapshot.model_validate_json(json.dumps(row.payload))
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
                entity.expanded_url or "",
            )
        )
        if quote or (remove_attachment_urls and entity.attachment_media_key is not None):
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
