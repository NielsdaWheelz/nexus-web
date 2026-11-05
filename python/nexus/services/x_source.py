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
    Media,
    MediaSourceAttempt,
    XArticleInspection,
    XArticleSource,
    XPostAlias,
    XPostCapture,
    XPostCaptureContext,
    XPostMedia,
    XPostSource,
    XThreadPost,
    XThreadSource,
)
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.media import XSourceContext
from nexus.schemas.x_source import (
    XArticleContent,
    XCaptureInput,
    XPostContent,
    XPriorPost,
    XPriorSource,
    XSourceCoverage,
    XSourcePost,
    XSourceScope,
)
from nexus.services import source_types as st
from nexus.services.x_identity import native_x_article_id, x_article_provider_id


@dataclass(frozen=True, slots=True)
class PublishedXSource:
    source_attempt_id: UUID
    published_at: datetime
    scope: XSourceScope
    primary_posts: tuple[XSourcePost, ...]
    root_revision_id: str | None
    coverage: XSourceCoverage


def x_primary_post_captures_sql() -> str:
    """Selected primary identities only; callers own readability and personal holdings."""
    return """
        SELECT tp.thread_media_id AS media_id, tp.capture_id, c.post_id,
               'author_thread'::text AS scope
        FROM x_thread_posts tp JOIN x_post_captures c ON c.id=tp.capture_id
        UNION ALL
        SELECT pm.media_id, pm.capture_id, c.post_id, 'post'::text AS scope
        FROM x_post_media pm JOIN x_post_captures c ON c.id=pm.capture_id
    """


def x_thread_candidates(
    db: Session, *, viewer_id: UUID, revision_ids: Sequence[str]
) -> dict[str, tuple[UUID, ...]]:
    """Readable primary holders first, otherwise latest unresolved unpublished work.

    A request address is not published membership. Frozen input matches its logical
    post but grants no access; visibility still belongs to the live media. Ambiguity
    remains per revision so commands and batched saved-state reads share this relation.
    """
    from nexus.auth.permissions import visible_media_ids_cte_sql

    candidates: dict[str, list[UUID]] = {revision: [] for revision in revision_ids}
    rows = db.execute(
        text(f"""
            WITH requested AS (
                SELECT revision_id, alias.post_id
                FROM unnest(CAST(:revision_ids AS text[])) AS requested(revision_id)
                LEFT JOIN x_post_aliases alias USING (revision_id)
            ), visible AS ({visible_media_ids_cte_sql()}), primary_holders AS (
                SELECT DISTINCT requested.revision_id, primary_post.media_id
                FROM requested JOIN ({x_primary_post_captures_sql()}) primary_post
                  ON primary_post.post_id=requested.post_id
                JOIN visible ON visible.media_id=primary_post.media_id
                WHERE primary_post.scope='author_thread'
            ), latest AS (
                SELECT DISTINCT ON (a.media_id) a.* FROM media_source_attempts a
                JOIN visible ON visible.media_id=a.media_id
                ORDER BY a.media_id, {st.LATEST_ORDER_SQL}
            )
            SELECT revision_id, media_id FROM primary_holders
            UNION
            SELECT requested.revision_id, latest.media_id
            FROM requested JOIN latest ON latest.source_type='x_author_thread'
              AND latest.status IN ('accepted','queued','running','failed')
            LEFT JOIN x_post_aliases target ON target.revision_id=latest.provider_target_ref
            LEFT JOIN x_post_captures seed
              ON seed.id::text=latest.source_payload #>> '{{capture_input,capture_id}}'
            WHERE (latest.provider_target_ref=requested.revision_id
                OR target.post_id=requested.post_id OR seed.post_id=requested.post_id)
              AND NOT EXISTS (SELECT 1 FROM reader_publications rp
                  WHERE rp.media_id=latest.media_id)
              AND NOT EXISTS (SELECT 1 FROM primary_holders holder
                  WHERE holder.revision_id=requested.revision_id)
            ORDER BY revision_id, media_id
        """),
        {"viewer_id": viewer_id, "revision_ids": list(candidates)},
    )
    for revision, media_id in rows:
        candidates[revision].append(media_id)
    return {revision: tuple(ids) for revision, ids in candidates.items()}


def x_article_content_facts(
    db: Session, *, media_ids: Sequence[UUID]
) -> dict[UUID, XArticleContent]:
    """Current published provenance, in the caller's read snapshot; absence is no body.

    A later pending or failed attempt cannot relabel an earlier publication. These
    facts carry no authorization: callers project only their authorized media.
    Only native article identities have source facts; other media need no article read.
    """
    native_media_ids = [
        media_id
        for media_id, kind, provider, provider_id in db.execute(
            select(Media.id, Media.kind, Media.provider, Media.provider_id).where(
                Media.id.in_(media_ids)
            )
        ).tuples()
        if native_x_article_id(kind=kind, provider=provider, provider_id=provider_id) is not None
    ]
    if not native_media_ids:
        return {}
    facts = {}
    for article, attempt in db.execute(
        select(XArticleSource, MediaSourceAttempt)
        .join(MediaSourceAttempt, MediaSourceAttempt.id == XArticleSource.source_attempt_id)
        .where(XArticleSource.media_id.in_(native_media_ids))
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


def post_from_capture(capture: XPostCapture, source: XPostSource, alias: XPostAlias) -> XSourcePost:
    """Decode a complete capture with its exact revision observation."""
    if capture.post_id != source.id or alias.post_id != source.id:
        raise ValueError("capture and alias must belong to the same logical post")
    if (
        alias.revision_id != capture.source_revision_id
        or capture.payload.get("kind") != "complete_post"
    ):
        raise ValueError("complete capture requires its exact revision alias")
    return XSourcePost.model_validate(
        {
            "source_revision_id": capture.source_revision_id,
            "logical_post_id": source.logical_post_id,
            "edit_history_ids": tuple(source.edit_history_ids)
            if source.edit_history_ids is not None
            else None,
            "content": XPostContent.model_validate_json(json.dumps(capture.payload["content"])),
            "availability": alias.availability or "available",
            "body_captured_at": capture.captured_at,
            "checked_at": alias.checked_at,
        }
    )


def _capture_posts(db: Session, capture_ids: Sequence[UUID]) -> dict[UUID, XSourcePost]:
    return {
        capture.id: post_from_capture(capture, source, alias)
        for capture, source, alias in db.execute(
            select(XPostCapture, XPostSource, XPostAlias)
            .join(XPostSource, XPostSource.id == XPostCapture.post_id)
            .join(
                XPostAlias,
                (XPostAlias.post_id == XPostSource.id)
                & (XPostAlias.revision_id == XPostCapture.source_revision_id),
            )
            .where(XPostCapture.id.in_(capture_ids))
        ).tuples()
    }


def load_x_post(db: Session, *, media_id: UUID) -> XSourcePost | None:
    capture_id = db.scalar(select(XPostMedia.capture_id).where(XPostMedia.media_id == media_id))
    return _capture_posts(db, [capture_id]).get(capture_id) if capture_id is not None else None


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


def x_article_link(
    db: Session, *, capture: XPostCapture, reading_media_id: UUID
) -> tuple[str, UUID | None] | None:
    """An association in the authorized reading thread, for this exact captured revision.

    The caller must authorize the reading publication before invoking this helper.
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
            XArticleInspection.carrier_post_id == capture.source_revision_id,
            XArticleInspection.thread_media_id == reading_media_id,
            XArticleInspection.thread_media_id.in_(
                select(XThreadPost.thread_media_id).where(XThreadPost.capture_id == capture.id)
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
        members[member.thread_media_id].append(member.capture_id)
    bindings = {
        row.media_id: row
        for row in db.scalars(select(XPostMedia).where(XPostMedia.media_id.in_(media_ids)))
    }
    capture_ids = {row.capture_id for row in bindings.values()}
    capture_ids.update(identity for ids in members.values() for identity in ids)
    posts = _capture_posts(db, list(capture_ids))
    result = {}
    for media_id, thread in threads.items():
        primary = tuple(posts[identity] for identity in members[media_id])
        if not primary or any(post.content.author.id != thread.author_id for post in primary):
            raise ValueError("stored thread membership must retain one author")
        result[media_id] = PublishedXSource(
            source_attempt_id=thread.source_attempt_id,
            published_at=thread.published_at,
            scope="author_thread",
            primary_posts=primary,
            root_revision_id=posts[thread.root_capture_id].source_revision_id
            if thread.root_capture_id is not None
            else None,
            coverage=XSourceCoverage.model_validate_json(json.dumps(thread.coverage)),
        )
    for media_id, binding in bindings.items():
        attempt = db.scalar(
            select(MediaSourceAttempt)
            .where(
                MediaSourceAttempt.media_id == media_id,
                MediaSourceAttempt.status == "succeeded",
            )
            .order_by(MediaSourceAttempt.attempt_no.desc())
            .limit(1)
        )
        if attempt is None or attempt.finished_at is None:
            raise ValueError("published post requires a finished source attempt")
        result[media_id] = PublishedXSource(
            source_attempt_id=attempt.id,
            published_at=attempt.finished_at,
            scope="post",
            primary_posts=(posts[binding.capture_id],),
            root_revision_id=None,
            coverage=XSourceCoverage(
                search_exhausted=None,
                limits=(),
                unresolved_parent_revision_ids=(),
                unchecked_primary_post_ids=(),
            ),
        )
    return result


def load_prior_x_source(
    db: Session,
    *,
    media_id: UUID,
    requested_revision_id: str,
    scope: XSourceScope,
    viewer_id: UUID,
    capture_input: XCaptureInput | None,
) -> XPriorSource:
    """Detach selected primaries plus the admission's frozen, complete source evidence.

    Only the frozen root adds membership. Context cannot displace a primary; among
    primary revisions the newest proved body wins, with the selected capture winning
    an equal-revision tie. The frozen manifest is worker input, never read authority.
    """
    from nexus.auth.permissions import visible_media_ids_cte_sql

    visible_media = set(db.scalars(text(visible_media_ids_cte_sql()), {"viewer_id": viewer_id}))
    readable_captures = set(
        db.scalars(text(readable_x_capture_ids_sql()), {"viewer_id": viewer_id})
    )
    requested_post_id = db.scalar(
        select(XPostAlias.post_id).where(XPostAlias.revision_id == requested_revision_id)
    )
    thread = None
    capture_ids: list[UUID] = []
    if scope == "author_thread":
        thread_ids = set(
            db.scalars(select(XThreadSource.media_id).where(XThreadSource.media_id == media_id))
        )
        if requested_post_id is not None:
            thread_ids.update(
                db.scalars(
                    select(XThreadPost.thread_media_id)
                    .join(XPostCapture, XPostCapture.id == XThreadPost.capture_id)
                    .where(XPostCapture.post_id == requested_post_id)
                )
            )
        thread_ids.intersection_update(visible_media)
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
            capture_ids = list(
                db.scalars(
                    select(XThreadPost.capture_id)
                    .where(XThreadPost.thread_media_id == thread.media_id)
                    .order_by(XThreadPost.ordinal)
                )
            )
    else:
        binding = db.scalar(select(XPostMedia).where(XPostMedia.media_id == media_id))
        if binding is None and requested_post_id is not None:
            binding = db.scalar(select(XPostMedia).where(XPostMedia.post_id == requested_post_id))
        if binding is not None and binding.capture_id in readable_captures:
            capture_ids = [binding.capture_id]
    capture_ids = [identity for identity in capture_ids if identity in readable_captures]
    primary_rows = list(db.scalars(select(XPostCapture).where(XPostCapture.id.in_(capture_ids))))
    primary_by_capture = {row.id: row.post_id for row in primary_rows}
    primary = [primary_by_capture[identity] for identity in capture_ids]
    capture_ids.extend(
        identity
        for identity in db.scalars(
            select(XPostCaptureContext.target_capture_id).where(
                XPostCaptureContext.capture_id.in_(capture_ids),
                XPostCaptureContext.target_capture_id.is_not(None),
            )
        )
        if identity is not None and identity in readable_captures
    )
    root = None
    if capture_input is not None:
        root = db.get(XPostCapture, capture_input.capture_id)
        assert root is not None  # immutable evidence outlives the accepted presentation
        if root.payload["kind"] == "complete_post":
            capture_ids.extend(capture_input.authorized_capture_ids)
            if root.post_id not in primary:
                primary.append(root.post_id)
        else:
            root = None  # an article excerpt supplies the permalink, never a full body
    captures = list(
        db.scalars(
            select(XPostCapture).where(
                XPostCapture.id.in_(capture_ids),
                XPostCapture.payload["kind"].astext == "complete_post",
            )
        )
    )
    posts = _capture_posts(db, [row.id for row in captures])
    selected: dict[UUID, XPostCapture] = {}
    selected_primary_ids = {row.id for row in primary_rows}
    primary_capture_ids = selected_primary_ids | ({root.id} if root is not None else set())
    for row in captures:
        previous = selected.get(row.post_id)
        if previous is None:
            selected[row.post_id] = row
            continue
        history = posts[row.id].edit_history_ids
        if history is None and row.source_revision_id != previous.source_revision_id:
            raise ConflictError(ApiErrorCode.E_X_IDENTITY_CONFLICT, "saved revisions lack lineage")

        row_priority = (
            row.id in primary_capture_ids,
            history.index(row.source_revision_id) if history is not None else 0,
            row.id in selected_primary_ids,
        )
        previous_priority = (
            previous.id in primary_capture_ids,
            history.index(previous.source_revision_id) if history is not None else 0,
            previous.id in selected_primary_ids,
        )
        if row_priority > previous_priority:
            selected[row.post_id] = row
    aliases: dict[UUID, list[str]] = {identity: [] for identity in selected}
    for revision_id, post_id in db.execute(
        select(XPostAlias.revision_id, XPostAlias.post_id).where(XPostAlias.post_id.in_(selected))
    ).tuples():
        aliases[post_id].append(revision_id)
    return XPriorSource(
        posts=tuple(
            XPriorPost(
                post_id=identity,
                capture_id=row.id,
                post=posts[row.id],
                revision_ids=tuple(sorted(aliases[identity], key=int)),
            )
            for identity, row in sorted(selected.items())
        ),
        primary_post_ids=tuple(primary),
        root_post_id=primary_by_capture.get(thread.root_capture_id)
        if thread is not None and thread.root_capture_id is not None
        else None,
    )


def x_source_attempt_ids(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, UUID]:
    sources = _load_sources(db, media_ids=media_ids)
    return {media_id: source.source_attempt_id for media_id, source in sources.items()}


def retained_x_publication_sql(alias: str) -> str:
    """A selected post, thread, or article publication is a saved copy."""
    return f"""({alias}.kind = 'web_article' AND {alias}.provider = 'x'
        AND EXISTS (SELECT 1 FROM reader_publications rp WHERE rp.media_id = {alias}.id)
        AND (EXISTS (SELECT 1 FROM x_post_media xm WHERE xm.media_id = {alias}.id)
            OR EXISTS (SELECT 1 FROM x_thread_posts xp WHERE xp.thread_media_id = {alias}.id)
            OR EXISTS (SELECT 1 FROM x_article_sources xa WHERE xa.media_id = {alias}.id)))"""


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
    """Current thread coverage and pinned direct-context outcomes."""
    sources = _load_sources(db, media_ids=media_ids)
    bindings = {
        row.media_id: [row.capture_id]
        for row in db.scalars(select(XPostMedia).where(XPostMedia.media_id.in_(media_ids)))
    }
    for row in db.scalars(select(XThreadPost).where(XThreadPost.thread_media_id.in_(media_ids))):
        bindings.setdefault(row.thread_media_id, []).append(row.capture_id)
    contexts: dict[UUID, list[XPostCaptureContext]] = {}
    for row in db.scalars(
        select(XPostCaptureContext).where(
            XPostCaptureContext.capture_id.in_(
                [capture for ids in bindings.values() for capture in ids]
            )
        )
    ):
        contexts.setdefault(row.capture_id, []).append(row)
    result = {}
    for media_id, source in sources.items():
        direct = [
            row for capture_id in bindings.get(media_id, ()) for row in contexts.get(capture_id, ())
        ]
        result[media_id] = XSourceContext(
            source_attempt_id=source.source_attempt_id,
            published_at=source.published_at,
            scope=source.scope,
            primary_post_count=len(source.primary_posts),
            root_revision_id=source.root_revision_id,
            search_exhausted=source.coverage.search_exhausted,
            limits=list(source.coverage.limits),
            unresolved_parent_count=len(source.coverage.unresolved_parent_revision_ids),
            unchecked_post_count=len(source.coverage.unchecked_primary_post_ids),
            unavailable_context_count=sum(row.outcome == "unavailable" for row in direct),
            uncaptured_context_count=sum(row.outcome == "not_captured" for row in direct),
        )
    return result


def readable_x_capture_ids_sql(viewer_id: str = ":viewer_id") -> str:
    """Selected readable roots and their admitted direct context, never recursive context."""
    from nexus.auth.permissions import visible_media_ids_cte_sql
    from nexus.services.resource_grants import highlight_grant_path_exists_sql
    from nexus.services.resource_graph.liveness import edge_live_sql

    visible_media = visible_media_ids_cte_sql().replace(":viewer_id", viewer_id)
    return f"""
        WITH visible_media AS ({visible_media}), roots AS (
            SELECT xm.capture_id FROM x_post_media xm
            JOIN visible_media vm ON vm.media_id=xm.media_id
            UNION
            SELECT tp.capture_id FROM x_thread_posts tp
            JOIN visible_media vm ON vm.media_id=tp.thread_media_id
            UNION
            SELECT de.target_x_post_capture_id FROM document_embeds de
            JOIN visible_media vm ON vm.media_id=de.media_id
            WHERE de.provider='x' AND de.embed_kind='post'
              AND de.canonical_end_offset IS NOT NULL AND de.target_x_post_capture_id IS NOT NULL
            UNION
            SELECT f.x_post_capture_id FROM highlights h
            JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
            JOIN fragments f ON f.id=a.fragment_id
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id={viewer_id}
            WHERE (h.user_id={viewer_id} OR {highlight_grant_path_exists_sql("h.id", viewer_id)})
              AND h.authored_visible
              AND f.x_post_capture_id IS NOT NULL
            UNION
            SELECT f.x_post_capture_id FROM passage_anchors pa
            JOIN fragments f ON pa.owner_scheme='fragment' AND pa.owner_id=f.id
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id={viewer_id}
            WHERE pa.user_id={viewer_id} AND EXISTS (
                SELECT 1 FROM resource_edges e WHERE e.user_id=pa.user_id
                  AND {edge_live_sql("e")}
                  AND ((e.source_scheme='passage_anchor' AND e.source_id=pa.id)
                    OR (e.target_scheme='passage_anchor' AND e.target_id=pa.id)))
            UNION
            SELECT f.x_post_capture_id FROM message_retrievals r
            JOIN messages m ON m.id=r.assistant_message_id
            JOIN conversations c ON c.id=m.conversation_id
            JOIN fragments f ON f.id::text=r.locator->>'fragment_id'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id={viewer_id}
            WHERE c.owner_user_id={viewer_id} AND r.locator->>'type'='x_capture_offsets'
              AND r.locator->>'capture_id'=f.x_post_capture_id::text
            UNION
            SELECT f.x_post_capture_id FROM messages m
            JOIN conversations c ON c.id=m.conversation_id
            JOIN fragments f ON f.id::text=m.reader_selection_snapshot #>> '{{evidence,target,locator,fragment_id}}'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id={viewer_id}
            WHERE c.owner_user_id={viewer_id}
              AND m.reader_selection_snapshot #>> '{{evidence,target,locator,type}}'='x_capture_offsets'
              AND m.reader_selection_snapshot #>> '{{evidence,target,locator,capture_id}}'=f.x_post_capture_id::text
            UNION
            SELECT f.x_post_capture_id FROM resource_edges e
            JOIN fragments f ON f.id::text=e.snapshot #>> '{{evidence,target,locator,fragment_id}}'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id={viewer_id}
            WHERE e.user_id={viewer_id} AND e.origin='citation' AND {edge_live_sql("e")}
              AND e.snapshot #>> '{{evidence,target,locator,type}}'='x_capture_offsets'
              AND e.snapshot #>> '{{evidence,target,locator,capture_id}}'=f.x_post_capture_id::text
        )
        SELECT capture_id FROM roots
        UNION
        SELECT context.target_capture_id FROM roots
        JOIN x_post_capture_contexts context ON context.capture_id=roots.capture_id
        JOIN x_post_capture_admissions admission
          ON admission.capture_id=context.target_capture_id AND admission.user_id={viewer_id}
        WHERE context.target_capture_id IS NOT NULL
    """


def admit_x_captures_for_accounts(
    db: Session, *, account_ids: Sequence[UUID], capture_ids: Sequence[UUID]
) -> None:
    """Record an already-authorized manifest; callers establish its pre-mutation authority."""
    from sqlalchemy.dialects.postgresql import insert

    from nexus.db.models import XPostCaptureAdmission
    from nexus.ids import new_uuid7

    values = [
        {"id": new_uuid7(), "user_id": account_id, "capture_id": capture_id}
        for account_id in set(account_ids)
        for capture_id in set(capture_ids)
    ]
    if values:
        db.execute(
            insert(XPostCaptureAdmission)
            .values(values)
            .on_conflict_do_nothing(index_elements=["user_id", "capture_id"])
        )


def require_readable_x_capture(db: Session, *, viewer_id: UUID, capture_id: UUID) -> XPostCapture:
    """Mask absent and unauthorized captures behind the same not-found response."""
    from sqlalchemy import text

    from nexus.errors import NotFoundError

    readable = db.scalar(
        text(f"SELECT :capture_id IN ({readable_x_capture_ids_sql()})"),
        {"viewer_id": viewer_id, "capture_id": capture_id},
    )
    capture = db.get(XPostCapture, capture_id) if readable else None
    if capture is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Capture not found")
    return capture
