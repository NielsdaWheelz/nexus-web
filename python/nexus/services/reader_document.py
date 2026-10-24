"""The reader's one publication read: every unit, section and contents entry from one snapshot.

``GET /media/{id}/reader``, the offline reading copy and the public share all
build their document here; the caller supplies the pdf file (signed url, copy
member or public route) and stabilizes the publication with a repeatable-read
snapshot (private/offline) or a media-row FOR SHARE lock (public).
Only lightweight unit identities are collected before body assembly. Fragment
bodies cross a one-row server cursor into their final typed units, so EPUB link
rewriting never retains a second whole publication beside the response.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.reader import (
    NavigationTextPointOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.reader_document import (
    ReaderPdfDocumentOut,
    ReaderPdfFileOut,
    ReaderPointOut,
    ReaderSectionOut,
    ReaderTextDocumentOut,
    ReaderTocNodeOut,
    ReaderTranscriptDocumentOut,
    ReaderUnitOut,
    ReaderXCaptureOut,
    ReaderXPostOut,
    ReaderXPostOwnerOut,
    ReaderXReferenceOut,
)
from nexus.schemas.x_source import XPostContent, XSourceCoverage, XSourcePost
from nexus.services.capabilities import is_text_document_ready
from nexus.services.document_embeds import list_document_embeds_for_fragments
from nexus.services.epub_read import rewrite_epub_fragment_links
from nexus.services.media_file_access import get_signed_download_url
from nexus.services.reader_navigation import read_media_navigation
from nexus.services.reader_publication import (
    read_publication_source_issues,
    read_ready_publication_generation,
)
from nexus.services.transcript_navigation import (
    project_transcript_navigation,
    read_transcript_navigation_source,
)
from nexus.services.x_source import x_article_content_facts

_MEDIA_SQL = """
    SELECT m.kind, m.title, m.processing_status, m.page_count,
           mts.transcript_state, mts.transcript_coverage
    FROM media m LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    WHERE m.id = :media_id
"""
_UNIT_ROWS_SQL = """
    FROM fragments f
    LEFT JOIN epub_fragment_sources source
      ON source.media_id = f.media_id AND source.fragment_id = f.id
    WHERE f.media_id = :media_id
    ORDER BY f.t_start_ms ASC NULLS LAST, f.idx ASC
"""


def read_reader_document(
    db: Session, viewer_id: UUID, media_id: UUID
) -> ReaderTextDocumentOut | ReaderTranscriptDocumentOut | ReaderPdfDocumentOut:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    def signed() -> ReaderPdfFileOut:
        file = get_signed_download_url(db, viewer_id, media_id)
        return ReaderPdfFileOut(url=file["url"], expires_at=file["expires_at"])

    return build_reader_document(db, media_id=media_id, viewer_id=viewer_id, pdf_file=signed)


def build_reader_document(
    db: Session,
    *,
    media_id: UUID,
    viewer_id: UUID | None,
    pdf_file: Callable[[], ReaderPdfFileOut],
) -> ReaderTextDocumentOut | ReaderTranscriptDocumentOut | ReaderPdfDocumentOut:
    """An authorized publication; public reads include its X bodies without child grants."""
    media = db.execute(text(_MEDIA_SQL), {"media_id": media_id}).one()
    title = str(media.title)
    if media.kind in ("podcast_episode", "video"):
        if not is_text_document_ready(
            media.kind, media.processing_status, media.transcript_state, media.transcript_coverage
        ):
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
        units, embeds = _units(db, media_id=media_id, epub=False, viewer_id=viewer_id)
        navigation = read_transcript_navigation_source(db, media_id=media_id)
        return ReaderTranscriptDocumentOut(
            kind="transcript",
            identity=transcript_identity([unit.id for unit in units]),
            title=title,
            units=units,
            sections=[],
            toc_nodes=[],
            source_issues=[],
            embeds=embeds,
            x_article_content=None,
            transcript_coverage=media.transcript_coverage,
            transcript_navigation=project_transcript_navigation(navigation, units),
        )
    if media.kind not in ("web_article", "epub", "pdf"):
        error = ApiError(ApiErrorCode.E_INVALID_KIND, "Media has no reader document")
        error.status_code = 409
        raise error
    generation = read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")
    if media.kind == "pdf":
        return ReaderPdfDocumentOut(
            kind="pdf",
            identity=f"g{generation}",
            title=title,
            page_count=media.page_count,
            file=pdf_file(),
        )

    kind = "epub" if media.kind == "epub" else "web_article"
    native_x = _native_x_units(db, media_id=media_id, viewer_id=viewer_id)
    if native_x is not None:
        units, capture = native_x
        return ReaderTextDocumentOut(
            kind=kind,
            identity=f"g{generation}",
            title=title,
            units=units,
            sections=[
                ReaderSectionOut(
                    id=unit.id,
                    label=f"post {index + 1}",
                    depth=0,
                    at=ReaderPointOut(unit_id=unit.id, offset=0),
                    anchor_id=None,
                )
                for index, unit in enumerate(
                    unit for unit in units if unit.x_post and unit.x_post.relation == "primary"
                )
            ],
            toc_nodes=[],
            source_issues=read_publication_source_issues(
                db, media_id=media_id, generation=generation
            ),
            embeds=_x_article_embeds(db, units=units, viewer_id=viewer_id),
            x_capture=capture,
            x_article_content=None,
        )
    units, embeds = _units(db, media_id=media_id, epub=kind == "epub", viewer_id=viewer_id)
    units = _with_x_embeds(db, media_id=media_id, units=units, viewer_id=viewer_id)
    rendered_x_slots = {
        (unit.x_post.parent_unit_id, unit.x_post.embed_occurrence_key)
        for unit in units
        if unit.x_post is not None and unit.x_post.relation == "embedded"
    }
    embeds = [
        embed
        for embed in embeds
        if embed.provider != "x"
        or (str(embed.fragment_id), embed.occurrence_key) not in rendered_x_slots
    ]
    embeds.extend(_x_article_embeds(db, units=units, viewer_id=viewer_id))
    navigation = read_media_navigation(db, media_id=media_id, kind=kind, generation=generation)
    parents = {section.section_id: section.parent_section_id for section in navigation.sections}

    def depth(section: ReaderNavigationSectionOut) -> int:
        levels, parent = 0, section.parent_section_id
        while parent is not None and parent in parents:
            levels, parent = levels + 1, parents[parent]
        return levels

    def node(toc: ReaderNavigationTocNodeOut) -> ReaderTocNodeOut:
        return ReaderTocNodeOut(
            id=toc.id,
            label=toc.label,
            at=_point(toc.target) if toc.target is not None else None,
            section_id=toc.section_id,
            children=[node(child) for child in toc.children],
        )

    return ReaderTextDocumentOut(
        kind=kind,
        identity=f"g{generation}",
        title=title,
        units=units,
        sections=[
            ReaderSectionOut(
                id=section.section_id,
                label=section.label,
                depth=depth(section),
                at=_point(section.target),
                anchor_id=section.anchor_id,
            )
            for section in navigation.sections
        ],
        toc_nodes=[node(toc) for toc in navigation.toc_nodes],
        source_issues=navigation.source_issues,
        embeds=embeds,
        x_article_content=x_article_content_facts(db, media_ids=[media_id]).get(media_id),
    )


def transcript_identity(unit_ids: list[str]) -> str:
    """A transcript's identity: a digest of its segment ids in reading order."""
    return f"t{hashlib.sha256('\n'.join(unit_ids).encode()).hexdigest()[:24]}"


def _x_article_embeds(
    db: Session, *, units: list[ReaderUnitOut], viewer_id: UUID | None
) -> list[DocumentEmbedOut]:
    """Bind source-owned article previews to each displayed carrier occurrence."""
    fragments = {
        unit.x_post.owner.fragment_id
        for unit in units
        if unit.x_post is not None and unit.x_post.owner is not None
    }
    by_fragment = list_document_embeds_for_fragments(
        db, viewer_id=viewer_id, fragment_ids=sorted(fragments)
    )
    return [
        embed.model_copy(
            update={
                "occurrence_key": f"{unit.id}:{embed.occurrence_key}",
                "locator": embed.locator.model_copy(update={"unit_id": unit.id}),
            }
        )
        for unit in units
        if unit.x_post is not None and unit.x_post.owner is not None
        for embed in by_fragment.get(unit.x_post.owner.fragment_id, [])
        if embed.provider == "x" and embed.kind == "link_preview"
    ]


def x_occurrence_id(
    media_id: UUID,
    post_media_id: UUID,
    *,
    parent_unit_id: str | None = None,
    relation: str = "primary",
    embed_occurrence_key: str | None = None,
) -> str:
    """A native occurrence survives source edits; ordinary embeds keep their slot identity."""
    return str(
        uuid5(
            NAMESPACE_URL,
            f"nexus:x:{media_id}:{parent_unit_id or ''}:{post_media_id}:{relation}:"
            f"{embed_occurrence_key or ''}",
        )
    )


@dataclass(frozen=True, slots=True)
class _Post:
    source: XSourcePost
    owner: ReaderXPostOwnerOut
    html: str
    text: str


def _posts(db: Session, media_ids: list[UUID], viewer_id: UUID | None) -> dict[UUID, _Post]:
    if not media_ids:
        return {}
    visible = "" if viewer_id is None else f"AND p.media_id IN ({visible_media_ids_cte_sql()})"
    result: dict[UUID, _Post] = {}
    for row in db.execute(
        text(f"""
            SELECT p.*, f.id AS fragment_id, f.html_sanitized, f.canonical_text, r.generation
            FROM x_post_sources p
            JOIN fragments f ON f.media_id = p.media_id
            JOIN reader_publications r ON r.media_id = p.media_id
            WHERE p.media_id = ANY(:ids)
              AND NOT EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id=p.media_id)
              {visible}
            ORDER BY p.media_id, f.idx
        """),
        {"ids": media_ids, "viewer_id": viewer_id},
    ):
        if row.media_id in result:
            # justify-defect: a canonical post has exactly one derived fragment.
            raise AssertionError("Canonical X post has multiple source fragments")
        result[row.media_id] = _Post(
            source=XSourcePost(
                source_revision_id=row.source_revision_id,
                logical_post_id=row.logical_post_id,
                edit_history_ids=None
                if row.edit_history_ids is None
                else tuple(row.edit_history_ids),
                content=XPostContent.model_validate_json(json.dumps(row.payload)),
                availability=row.availability,
                body_captured_at=row.body_captured_at,
                checked_at=row.checked_at,
            ),
            owner=ReaderXPostOwnerOut(
                media_id=row.media_id, generation=row.generation, fragment_id=row.fragment_id
            ),
            html=row.html_sanitized,
            text=row.canonical_text,
        )
    return result


def _references(
    db: Session, posts: dict[UUID, _Post]
) -> dict[str, tuple[UUID | None, Literal["available", "unavailable", "not_captured"]]]:
    revisions = list(
        {
            ref.target_revision_id
            for post in posts.values()
            for ref in post.source.content.references
        }
    )
    if not revisions:
        return {}
    references: dict[
        str, tuple[UUID | None, Literal["available", "unavailable", "not_captured"]]
    ] = {
        row.revision_id: (row.post_media_id, row.availability)
        for row in db.execute(
            text("""
                SELECT a.revision_id, a.post_media_id, p.availability
                FROM x_post_aliases a JOIN x_post_sources p ON p.media_id=a.post_media_id
                WHERE a.revision_id=ANY(:ids)
            """),
            {"ids": revisions},
        )
    }
    for revision in db.scalars(
        text("""SELECT provider_target_ref FROM document_embeds WHERE media_id=ANY(:ids)
                AND provider='x' AND error_code=:code"""),
        {"ids": list(posts), "code": ApiErrorCode.E_X_POST_UNAVAILABLE.value},
    ):
        if revision is not None:
            references.setdefault(revision, (None, "unavailable"))
    return references


def _post_unit(
    post: _Post,
    *,
    occurrence_id: str,
    relation: Literal["primary", "quoted", "replied_to", "retweeted", "embedded"],
    parent_unit_id: str | None,
    insertion_offset: int | None,
    embed_occurrence_key: str | None,
    referenced_revision_id: str | None,
    checked: bool | None,
    references: dict[str, tuple[UUID | None, Literal["available", "unavailable", "not_captured"]]],
    targets: dict[tuple[str, str], str],
) -> ReaderUnitOut:
    source = post.source
    metadata = ReaderXPostOut(
        logical_post_id=source.logical_post_id,
        source_revision_id=source.source_revision_id,
        relation=relation,
        parent_unit_id=parent_unit_id,
        embed_occurrence_key=embed_occurrence_key,
        insertion_offset=insertion_offset,
        referenced_revision_id=referenced_revision_id,
        checked_in_capture=checked,
        source_url=f"https://x.com/i/status/{source.source_revision_id}",
        author=source.content.author,
        created_at=source.content.created_at,
        is_edited=source.edit_history_ids is not None and len(source.edit_history_ids) > 1,
        availability=source.availability,
        body_captured_at=source.body_captured_at,
        checked_at=source.checked_at,
        references=[
            ReaderXReferenceOut(
                relation=ref.kind,
                referenced_revision_id=ref.target_revision_id,
                source_url=f"https://x.com/i/status/{ref.target_revision_id}",
                target_unit_id=targets.get((ref.kind, ref.target_revision_id)),
                availability=references[ref.target_revision_id][1]
                if ref.target_revision_id in references
                else "not_captured",
            )
            for ref in source.content.references
        ],
        owner=post.owner,
    )
    return ReaderUnitOut(
        id=occurrence_id,
        idx=0,
        html_sanitized=post.html,
        canonical_text=post.text,
        char_count=len(post.text),
        href_path=None,
        t_start_ms=None,
        t_end_ms=None,
        speaker_label=None,
        x_post=metadata,
    )


def _native_x_units(
    db: Session, *, media_id: UUID, viewer_id: UUID | None
) -> tuple[list[ReaderUnitOut], ReaderXCaptureOut] | None:
    thread = db.execute(
        text("SELECT * FROM x_thread_sources WHERE media_id=:id"), {"id": media_id}
    ).one_or_none()
    if thread is None and not db.scalar(
        text("SELECT EXISTS (SELECT 1 FROM x_post_sources WHERE media_id=:id)"), {"id": media_id}
    ):
        return None
    primary_ids = (
        list(
            db.scalars(
                text(
                    "SELECT post_media_id FROM x_thread_posts WHERE thread_media_id=:id ORDER BY ordinal"
                ),
                {"id": media_id},
            )
        )
        if thread is not None
        else [media_id]
    )
    primary = _posts(db, primary_ids, viewer_id)
    if len(primary) != len(primary_ids):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Source post unavailable")
    embeds = db.execute(
        text("""SELECT media_id, provider_target_ref, target_media_id FROM document_embeds
                WHERE media_id=ANY(:ids) AND provider='x' AND embed_kind='post'
                  AND resolution_status='resolved' AND canonical_end_offset IS NOT NULL
                ORDER BY document_order_key"""),
        {"ids": primary_ids},
    ).all()
    contained = {
        (row.media_id, row.provider_target_ref): row.target_media_id
        for row in embeds
        if row.target_media_id is not None
    }
    posts = primary | _posts(db, list(set(contained.values()) - primary.keys()), viewer_id)
    references = _references(db, posts)
    primary_units = {post_id: x_occurrence_id(media_id, post_id) for post_id in primary_ids}
    coverage = (
        XSourceCoverage.model_validate_json(json.dumps(thread.coverage))
        if thread is not None
        else None
    )
    units: list[ReaderUnitOut] = []
    unavailable = uncaptured = 0
    for post_id in primary_ids:
        post, unit_id = posts[post_id], primary_units[post_id]
        targets: dict[tuple[str, str], str] = {}
        children: list[ReaderUnitOut] = []
        for ref in post.source.content.references:
            target = contained.get((post_id, ref.target_revision_id))
            known = references.get(ref.target_revision_id)
            if ref.kind == "replied_to" and known is not None and known[0] in primary_units:
                targets[(ref.kind, ref.target_revision_id)] = primary_units[known[0]]
                continue
            unavailable += int(known is not None and known[1] == "unavailable")
            if target is None or target not in posts:
                uncaptured += int(known is None or known[1] != "unavailable")
                continue
            child_id = x_occurrence_id(media_id, target, parent_unit_id=unit_id, relation=ref.kind)
            targets[(ref.kind, ref.target_revision_id)] = child_id
            children.append(
                _post_unit(
                    posts[target],
                    occurrence_id=child_id,
                    relation=ref.kind,
                    parent_unit_id=unit_id,
                    insertion_offset=len(post.text),
                    embed_occurrence_key=None,
                    referenced_revision_id=ref.target_revision_id,
                    checked=None,
                    references=references,
                    targets={},
                )
            )
        checked = (
            post_id not in coverage.unchecked_primary_post_media_ids
            if coverage is not None
            and thread is not None
            and thread.membership_checked_at is not None
            else None
        )
        units.append(
            _post_unit(
                post,
                occurrence_id=unit_id,
                relation="primary",
                parent_unit_id=None,
                insertion_offset=None,
                embed_occurrence_key=None,
                referenced_revision_id=None,
                checked=checked,
                references=references,
                targets=targets,
            )
        )
        units.extend(children)
    for index, unit in enumerate(units):
        unit.idx = index
    saved_at = (
        thread.published_at
        if thread is not None
        else posts[media_id].source.body_captured_at
        or db.scalar(text("SELECT created_at FROM media WHERE id=:id"), {"id": media_id})
    )
    root = posts.get(thread.root_post_media_id) if thread is not None else None
    return units, ReaderXCaptureOut(
        scope="author_thread" if thread is not None else "post",
        saved_at=saved_at,
        primary_post_count=len(primary_ids),
        root_revision_id=root.source.source_revision_id if root is not None else None,
        search_exhausted=coverage.search_exhausted if coverage is not None else None,
        limits=list(coverage.limits) if coverage is not None else [],
        unresolved_parent_count=len(coverage.unresolved_parent_revision_ids) if coverage else 0,
        unchecked_post_count=len(coverage.unchecked_primary_post_media_ids) if coverage else 0,
        unavailable_context_count=unavailable,
        uncaptured_context_count=uncaptured,
    )


def _with_x_embeds(
    db: Session, *, media_id: UUID, units: list[ReaderUnitOut], viewer_id: UUID | None
) -> list[ReaderUnitOut]:
    rows = db.execute(
        text("""SELECT * FROM document_embeds WHERE media_id=:id AND provider='x' AND embed_kind='post'
                AND resolution_status='resolved' AND canonical_end_offset IS NOT NULL
                AND target_media_id IS NOT NULL
                ORDER BY canonical_end_offset, document_order_key"""),
        {"id": media_id},
    ).all()
    posts = _posts(db, list({row.target_media_id for row in rows}), viewer_id)
    references = _references(db, posts)
    result: list[ReaderUnitOut] = []
    for unit in units:
        result.append(unit)
        for row in rows:
            if str(row.fragment_id) != unit.id or row.target_media_id not in posts:
                continue
            offset = row.canonical_end_offset
            if offset is None or not 0 <= offset <= unit.char_count:
                continue
            result.append(
                _post_unit(
                    posts[row.target_media_id],
                    occurrence_id=x_occurrence_id(
                        media_id,
                        row.target_media_id,
                        parent_unit_id=unit.id,
                        relation="embedded",
                        embed_occurrence_key=row.occurrence_key,
                    ),
                    relation="embedded",
                    parent_unit_id=unit.id,
                    insertion_offset=offset,
                    embed_occurrence_key=row.occurrence_key,
                    referenced_revision_id=row.provider_target_ref,
                    checked=None,
                    references=references,
                    targets={},
                )
            )
    for index, unit in enumerate(result):
        unit.idx = index
    return result


def reading_source_ranges(units: list[ReaderUnitOut]) -> list[tuple[ReaderUnitOut, int, int]]:
    """The bounded direct-X reading order; all offsets remain source-local."""
    result: list[tuple[ReaderUnitOut, int, int]] = []
    children: dict[str, list[ReaderUnitOut]] = {}
    for unit in units:
        if unit.x_post is not None and unit.x_post.parent_unit_id is not None:
            children.setdefault(unit.x_post.parent_unit_id, []).append(unit)
    for unit in units:
        if unit.x_post is not None and unit.x_post.parent_unit_id is not None:
            continue
        start = 0
        for child in children.get(unit.id, []):
            slot = child.x_post.insertion_offset if child.x_post is not None else None
            if slot is None or not start <= slot <= unit.char_count:
                # justify-defect: placement is validated by this projection's source owner.
                raise AssertionError("X occurrence has invalid source placement")
            result.append((unit, start, slot))
            result.append((child, 0, child.char_count))
            start = slot
        result.append((unit, start, unit.char_count))
    return result


def _units(
    db: Session, *, media_id: UUID, epub: bool, viewer_id: UUID | None
) -> tuple[list[ReaderUnitOut], list[DocumentEmbedOut]]:
    """Units in reading order (transcripts by time); epub links bound to their units."""
    identities = db.execute(
        text("SELECT f.id, source.package_href " + _UNIT_ROWS_SQL), {"media_id": media_id}
    ).all()
    links = {row.package_href: row.id for row in identities if row.package_href is not None}
    rows = db.execute(
        text(
            "SELECT f.id, f.idx, f.html_sanitized, f.canonical_text, f.t_start_ms, f.t_end_ms,"
            " f.speaker_label, source.package_href " + _UNIT_ROWS_SQL
        ),
        {"media_id": media_id},
        execution_options={"yield_per": 1},
    ).mappings()
    try:
        units = [
            ReaderUnitOut(
                id=str(row["id"]),
                idx=row["idx"],
                html_sanitized=rewrite_epub_fragment_links(
                    row["html_sanitized"], href_path=row["package_href"], fragment_ids_by_path=links
                )
                if epub
                else row["html_sanitized"],
                canonical_text=row["canonical_text"],
                char_count=len(row["canonical_text"]),
                href_path=row["package_href"],
                t_start_ms=row["t_start_ms"],
                t_end_ms=row["t_end_ms"],
                speaker_label=row["speaker_label"],
            )
            for row in rows
        ]
    finally:
        rows.close()
    if viewer_id is None:
        return units, []
    by_fragment = list_document_embeds_for_fragments(
        db, viewer_id=viewer_id, fragment_ids=[row.id for row in identities]
    )
    return units, [embed for row in identities for embed in by_fragment.get(row.id, [])]


def _point(point: NavigationTextPointOut) -> ReaderPointOut:
    return ReaderPointOut(unit_id=str(point.fragment_id), offset=point.offset)
