"""Read canonical X bodies, proved membership and current capture facts.

Relational columns own identity, lineage and availability; payload owns authored
content. Reads reconstruct that one contract. No aggregate body or legacy reader
exists. Callers needing several related reads own the database snapshot.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

import regex
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    DocumentEmbed,
    Media,
    MediaSourceAttempt,
    XArticleInspection,
    XArticleSource,
    XPostAlias,
    XPostSource,
    XThreadPost,
    XThreadSource,
)
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.media import XSourceContext
from nexus.schemas.x_source import (
    XArticleContent,
    XPostContent,
    XPriorPost,
    XPriorSource,
    XSourceCoverage,
    XSourcePost,
    XSourceScope,
)
from nexus.services import source_types as st
from nexus.services.x_identity import x_article_provider_id


@dataclass(frozen=True, slots=True)
class PublishedXSource:
    source_attempt_id: UUID
    published_at: datetime
    scope: XSourceScope
    primary_posts: tuple[XSourcePost, ...]
    root_revision_id: str | None
    coverage: XSourceCoverage


def x_article_content_facts(
    db: Session, *, media_ids: Sequence[UUID]
) -> dict[UUID, XArticleContent]:
    """Current published provenance, in the caller's read snapshot; absence is no body.

    A later pending or failed attempt cannot relabel an earlier publication. These
    facts carry no authorization: callers project only their authorized media.
    """
    facts = {}
    for article, attempt in db.execute(
        select(XArticleSource, MediaSourceAttempt)
        .join(MediaSourceAttempt, MediaSourceAttempt.id == XArticleSource.source_attempt_id)
        .where(XArticleSource.media_id.in_(media_ids))
    ).tuples():
        assert attempt.media_id == article.media_id  # publication owns both identities
        if attempt.source_type == st.X_ARTICLE:
            representation = "api_text"
        else:
            assert attempt.source_type == st.BROWSER_ARTICLE_CAPTURE
            representation = "browser_capture"
        facts[article.media_id] = XArticleContent.model_validate(
            {"representation": representation, "completeness": article.completeness}
        )
    return facts


def post_from_row(row: XPostSource) -> XSourcePost:
    """Decode the only canonical body owner; malformed stored evidence fails loudly."""
    return XSourcePost.model_validate(
        {
            "source_revision_id": row.source_revision_id,
            "logical_post_id": row.logical_post_id,
            "edit_history_ids": tuple(row.edit_history_ids)
            if row.edit_history_ids is not None
            else None,
            "content": XPostContent.model_validate_json(json.dumps(row.payload)),
            "availability": row.availability,
            "body_captured_at": row.body_captured_at,
            "checked_at": row.checked_at,
        }
    )


def load_x_post(db: Session, *, media_id: UUID) -> XSourcePost | None:
    row = db.scalar(select(XPostSource).where(XPostSource.media_id == media_id))
    return post_from_row(row) if row is not None else None


def x_article_child_media_ids(db: Session, *, thread_media_ids: Sequence[UUID]) -> set[UUID]:
    """Acquired children, including failed ones without a reader publication."""
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


def x_article_link(db: Session, *, post: XPostSource) -> tuple[str, UUID | None] | None:
    """The current carrier revision's association in its proved thread.

    A saved older revision never supplies an article for an edited body. Failed
    unrelated imports carry no membership authority over a canonical post.
    """
    rows = db.execute(
        select(
            XArticleInspection.article_id,
            XArticleInspection.article_media_id,
            Media.provider,
            Media.provider_id,
        )
        .outerjoin(Media, Media.id == XArticleInspection.article_media_id)
        .where(
            XArticleInspection.carrier_post_id == post.source_revision_id,
            XArticleInspection.thread_media_id.in_(
                select(XThreadPost.thread_media_id).where(
                    XThreadPost.post_media_id == post.media_id
                )
            ),
        )
    ).all()
    links = {(row.article_id, row.article_media_id) for row in rows}
    if len(links) > 1:
        raise ConflictError(ApiErrorCode.E_X_SOURCE_CONFLICT, "The article association changed.")
    for row in rows:
        if row.article_media_id is not None:
            assert row.provider == "x" and row.provider_id == x_article_provider_id(row.article_id)
    link = next(iter(links), None)
    return link if link is not None and link[0] is not None else None


def reconcile_x_article_inspections(
    db: Session, *, loser_id: UUID, winner_id: UUID, observations: Mapping[str, str | None]
) -> None:
    """Keep current acquired associations and move them to the proved thread.

    Fresh contradictory evidence removes a stale preview; it never admits another
    article. Only the submitted carrier lookup owns independent child admission.
    """
    for row in db.scalars(
        select(XArticleInspection).where(
            XArticleInspection.thread_media_id.in_((loser_id, winner_id)),
            XArticleInspection.carrier_post_id.in_(observations),
        )
    ):
        if row.article_id != observations[row.carrier_post_id]:
            db.delete(row)
    db.flush()
    if loser_id == winner_id:
        return
    for row in list(
        db.scalars(select(XArticleInspection).where(XArticleInspection.thread_media_id == loser_id))
    ):
        existing = db.get(XArticleInspection, (winner_id, row.carrier_post_id))
        if existing is None:
            row.thread_media_id = winner_id
        else:
            if existing.article_id != row.article_id:
                raise ConflictError(
                    ApiErrorCode.E_X_SOURCE_CONFLICT, "The article association changed."
                )
            elif existing.article_media_id is None:
                existing.article_media_id = row.article_media_id
            elif row.article_media_id not in (None, existing.article_media_id):
                raise ConflictError(
                    ApiErrorCode.E_X_SOURCE_CONFLICT, "The saved article identity changed."
                )
            db.delete(row)
    db.flush()


def load_x_source(db: Session, *, media_id: UUID) -> PublishedXSource | None:
    return _load_sources(db, media_ids=[media_id]).get(media_id)


def _load_sources(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, PublishedXSource]:
    threads = {
        row.media_id: row
        for row in db.scalars(select(XThreadSource).where(XThreadSource.media_id.in_(media_ids)))
    }
    members: dict[UUID, list[UUID]] = {identity: [] for identity in threads}
    for member in db.scalars(
        select(XThreadPost)
        .where(XThreadPost.thread_media_id.in_(threads))
        .order_by(XThreadPost.thread_media_id, XThreadPost.ordinal)
    ):
        members[member.thread_media_id].append(member.post_media_id)
    post_ids = set(media_ids) | {identity for ids in members.values() for identity in ids}
    rows = {
        row.media_id: row
        for row in db.scalars(select(XPostSource).where(XPostSource.media_id.in_(post_ids)))
    }
    posts = {identity: post_from_row(row) for identity, row in rows.items()}
    attempts = {
        row.id: row
        for row in db.scalars(
            select(MediaSourceAttempt).where(
                MediaSourceAttempt.id.in_(
                    [
                        row.source_attempt_id
                        for identity, row in rows.items()
                        if identity in media_ids
                    ]
                )
            )
        )
    }
    result = {}
    for media_id in media_ids:
        if media_id in threads:
            thread = threads[media_id]
            primary = tuple(posts[identity] for identity in members[media_id])
            if not primary or any(post.content.author.id != thread.author_id for post in primary):
                raise ValueError("stored thread membership must retain one author")
            result[media_id] = PublishedXSource(
                source_attempt_id=thread.source_attempt_id,
                published_at=thread.published_at,
                scope="author_thread",
                primary_posts=primary,
                root_revision_id=posts[thread.root_post_media_id].source_revision_id
                if thread.root_post_media_id is not None
                else None,
                coverage=XSourceCoverage.model_validate_json(json.dumps(thread.coverage)),
            )
        elif media_id in posts:
            row = rows[media_id]
            published_at = attempts[row.source_attempt_id].finished_at
            if published_at is None:
                raise ValueError("published post source must own a finished attempt")
            result[media_id] = PublishedXSource(
                source_attempt_id=row.source_attempt_id,
                published_at=published_at,
                scope="post",
                primary_posts=(posts[media_id],),
                root_revision_id=None,
                coverage=XSourceCoverage(
                    search_exhausted=None,
                    limits=(),
                    unresolved_parent_revision_ids=(),
                    unchecked_primary_post_media_ids=(),
                ),
            )
    return result


def load_prior_x_source(
    db: Session, *, media_id: UUID, requested_revision_id: str, scope: XSourceScope
) -> XPriorSource:
    """Detach saved primaries, direct context and aliases before provider work."""
    requested_media_id = db.scalar(
        select(XPostAlias.post_media_id).where(XPostAlias.revision_id == requested_revision_id)
    )
    thread = None
    primary: tuple[UUID, ...] = ()
    if scope == "author_thread":
        thread_ids = set(
            db.scalars(select(XThreadSource.media_id).where(XThreadSource.media_id == media_id))
        )
        if requested_media_id is not None:
            thread_ids.update(
                db.scalars(
                    select(XThreadPost.thread_media_id).where(
                        XThreadPost.post_media_id == requested_media_id
                    )
                )
            )
        if len(thread_ids) > 1:
            raise ConflictError(
                ApiErrorCode.E_X_IDENTITY_CONFLICT,
                "these saved threads overlap. both were kept; repair is required.",
            )
        if thread_ids:
            thread = db.scalar(
                select(XThreadSource).where(XThreadSource.media_id == next(iter(thread_ids)))
            )
            assert thread is not None
            primary = tuple(
                db.scalars(
                    select(XThreadPost.post_media_id)
                    .where(XThreadPost.thread_media_id == thread.media_id)
                    .order_by(XThreadPost.ordinal)
                )
            )
    else:
        own = db.scalar(select(XPostSource.media_id).where(XPostSource.media_id == media_id))
        if own is not None:
            primary = (own,)
        elif (
            requested_media_id is not None
            and db.scalar(
                select(XPostSource.media_id).where(XPostSource.media_id == requested_media_id)
            )
            is not None
        ):
            primary = (requested_media_id,)
    ids = set(primary)
    if requested_media_id is not None:
        ids.add(requested_media_id)
    rows = {
        row.media_id: row
        for row in db.scalars(select(XPostSource).where(XPostSource.media_id.in_(ids)))
    }
    direct = {
        ref.target_revision_id
        for row in rows.values()
        for ref in post_from_row(row).content.references
    }
    context_ids = (
        set(db.scalars(select(XPostAlias.post_media_id).where(XPostAlias.revision_id.in_(direct))))
        - ids
    )
    rows.update(
        (row.media_id, row)
        for row in db.scalars(select(XPostSource).where(XPostSource.media_id.in_(context_ids)))
    )
    aliases: dict[UUID, list[str]] = {identity: [] for identity in rows}
    for revision_id, owner_id in db.execute(
        select(XPostAlias.revision_id, XPostAlias.post_media_id).where(
            XPostAlias.post_media_id.in_(rows)
        )
    ).tuples():
        aliases[owner_id].append(revision_id)
    return XPriorSource(
        posts=tuple(
            XPriorPost(
                media_id=identity,
                post=post_from_row(row),
                revision_ids=tuple(sorted(aliases[identity], key=int)),
            )
            for identity, row in sorted(rows.items())
        ),
        primary_post_media_ids=primary,
        root_post_media_id=thread.root_post_media_id if thread is not None else None,
    )


def x_source_attempt_ids(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, UUID]:
    if not media_ids:
        return {}
    statement = (
        select(XPostSource.media_id, XPostSource.source_attempt_id)
        .where(XPostSource.media_id.in_(media_ids))
        .union_all(
            select(XThreadSource.media_id, XThreadSource.source_attempt_id).where(
                XThreadSource.media_id.in_(media_ids)
            )
        )
    )
    return dict(db.execute(statement).tuples().all())


def retained_x_publication_sql(alias: str) -> str:
    """A published canonical body or nonempty proved composition is a saved copy."""
    return f"""({alias}.kind = 'web_article' AND {alias}.provider = 'x'
        AND EXISTS (SELECT 1 FROM reader_publications rp WHERE rp.media_id = {alias}.id)
        AND (EXISTS (SELECT 1 FROM x_post_sources xs WHERE xs.media_id = {alias}.id)
            OR EXISTS (SELECT 1 FROM x_thread_posts xp WHERE xp.thread_media_id = {alias}.id)
            OR EXISTS (SELECT 1 FROM x_article_sources xa WHERE xa.media_id = {alias}.id)))"""


def has_retained_x_publication(db: Session, *, media_id: UUID) -> bool:
    return bool(
        db.scalar(
            text(f"SELECT {retained_x_publication_sql('m')} FROM media m WHERE m.id = :media_id"),
            {"media_id": media_id},
        )
    )


def post_label(post: XSourcePost) -> str:
    return source_label((post,), scope="post")


def source_label(posts: Sequence[XSourcePost], *, scope: XSourceScope) -> str:
    """An authored opening, at most 120 code points without splitting graphemes."""
    if not posts:
        raise ValueError("source label requires a primary post")
    for post in posts:
        value = " ".join(post.content.text.split())
        if not value:
            continue
        if len(value) <= 120:
            return value
        grapheme_ends = {
            match.end() for match in regex.finditer(r"\X", value) if match.end() <= 119
        }
        if not grapheme_ends:
            break
        end = max(grapheme_ends)
        boundaries = [
            match.start()
            for match in regex.finditer(r"\b", value, regex.WORD)
            if match.start() in grapheme_ends
        ]
        boundary = max(boundaries, default=0)
        if boundary and regex.fullmatch(r"(?:[@#]\S*\s*)+", value[:boundary]):
            boundary = 0
        return value[: boundary or end].rstrip() + "…"
    kind = "thread" if scope == "author_thread" else "post"
    return f"x {kind} by @{posts[0].content.author.username}"


def x_source_contexts(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, XSourceContext]:
    """Current capture coverage; body/status authority remains the canonical posts."""
    if not media_ids:
        return {}
    sources = _load_sources(db, media_ids=media_ids)
    revisions = {
        post.source_revision_id for source in sources.values() for post in source.primary_posts
    }
    owners = dict(
        db.execute(
            select(XPostAlias.revision_id, XPostAlias.post_media_id).where(
                XPostAlias.revision_id.in_(revisions)
            )
        )
        .tuples()
        .all()
    )
    embeds = list(
        db.scalars(
            select(DocumentEmbed).where(
                DocumentEmbed.media_id.in_(owners.values()),
                DocumentEmbed.provider == "x",
                DocumentEmbed.embed_kind == "post",
            )
        )
    )
    unavailable_targets = set(
        db.scalars(
            select(XPostSource.media_id).where(
                XPostSource.media_id.in_(
                    [row.target_media_id for row in embeds if row.target_media_id is not None]
                ),
                XPostSource.availability == "unavailable",
            )
        )
    )
    result = {}
    for identity, source in sources.items():
        primary_ids = {owners[post.source_revision_id] for post in source.primary_posts}
        direct = [
            row
            for row in embeds
            if row.media_id in primary_ids and row.target_media_id not in primary_ids
        ]
        unavailable = {
            row.provider_target_ref
            for row in direct
            if row.target_media_id in unavailable_targets
            or (
                row.target_media_id is None
                and row.error_code == ApiErrorCode.E_X_POST_UNAVAILABLE.value
            )
        }
        uncaptured = {
            row.provider_target_ref
            for row in direct
            if row.target_media_id is None
            and row.error_code != ApiErrorCode.E_X_POST_UNAVAILABLE.value
        }
        result[identity] = XSourceContext(
            source_attempt_id=source.source_attempt_id,
            published_at=source.published_at,
            scope=source.scope,
            primary_post_count=len(source.primary_posts),
            root_revision_id=source.root_revision_id,
            search_exhausted=source.coverage.search_exhausted,
            limits=list(source.coverage.limits),
            unresolved_parent_count=len(source.coverage.unresolved_parent_revision_ids),
            unchecked_post_count=len(source.coverage.unchecked_primary_post_media_ids),
            unavailable_context_count=len(unavailable),
            uncaptured_context_count=len(uncaptured),
        )
    return result
