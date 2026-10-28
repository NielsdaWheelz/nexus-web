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
from typing import Literal
from urllib.parse import unquote, urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from lxml.html import fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.reader import (
    NavigationTextPointOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.reader_document import (
    ReaderCaptureDocumentOut,
    ReaderPartDocumentOut,
    ReaderPartExtentOut,
    ReaderPartExtentPointOut,
    ReaderPartProvenanceOut,
    ReaderPartUnitOut,
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
from nexus.schemas.x_source import XSourceCoverage
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.capabilities import is_text_document_ready
from nexus.services.document_embeds import list_document_embeds_for_fragments
from nexus.services.epub_read import rewrite_epub_fragment_links
from nexus.services.html_tree import inner_html
from nexus.services.media_file_access import get_signed_download_url
from nexus.services.media_text_scope import (
    MediaTextScope,
    read_media_text_scope,
    read_scope_fragment,
)
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
) -> (
    ReaderTextDocumentOut
    | ReaderPartDocumentOut
    | ReaderTranscriptDocumentOut
    | ReaderPdfDocumentOut
):
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    def signed() -> ReaderPdfFileOut:
        file = get_signed_download_url(db, viewer_id, media_id)
        return ReaderPdfFileOut(url=file["url"], expires_at=file["expires_at"])

    return build_reader_document(db, media_id=media_id, viewer_id=viewer_id, pdf_file=signed)


def x_document_identity(generation: int, units: list[ReaderUnitOut]) -> str:
    """Publication generation and its authorized visible capture manifest."""
    occurrences = [
        f"{unit.id}:{unit.x_post.owner.capture_id}"
        for unit in units
        if unit.x_post is not None and unit.x_post.owner is not None
    ]
    if not occurrences:
        return f"g{generation}"
    digest = hashlib.sha256("\n".join(occurrences).encode()).hexdigest()[:24]
    return f"g{generation}:x{digest}"


def build_reader_document(
    db: Session,
    *,
    media_id: UUID,
    viewer_id: UUID | None,
    pdf_file: Callable[[], ReaderPdfFileOut],
    public_grant_id: UUID | None = None,
    materialize_x_assets: bool = False,
) -> (
    ReaderTextDocumentOut
    | ReaderPartDocumentOut
    | ReaderTranscriptDocumentOut
    | ReaderPdfDocumentOut
):
    """An authorized publication; public reads include its X bodies without child grants."""
    media = db.execute(text(_MEDIA_SQL), {"media_id": media_id}).one()
    title = str(media.title)
    if media.kind == "text_part":
        return build_part_document(db, scope=read_media_text_scope(db, media_id), title=title)
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
            publication_generation=generation,
            title=title,
            page_count=media.page_count,
            file=pdf_file(),
        )

    kind = "epub" if media.kind == "epub" else "web_article"
    native_x = _native_x_units(
        db,
        media_id=media_id,
        viewer_id=viewer_id,
        public_grant_id=public_grant_id,
        materialize_x_assets=materialize_x_assets,
    )
    if native_x is not None:
        units, capture = native_x
        return ReaderTextDocumentOut(
            kind=kind,
            identity=x_document_identity(generation, units),
            publication_generation=None,
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
            embeds=_x_article_embeds(
                db, units=units, viewer_id=viewer_id, reading_media_id=media_id
            ),
            x_capture=capture,
            x_article_content=None,
        )
    units, embeds = _units(db, media_id=media_id, epub=kind == "epub", viewer_id=viewer_id)
    units = _with_x_embeds(
        db,
        media_id=media_id,
        units=units,
        viewer_id=viewer_id,
        public_grant_id=public_grant_id,
        materialize_x_assets=materialize_x_assets,
    )
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
        identity=x_document_identity(generation, units),
        publication_generation=generation,
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


def build_part_document(db: Session, *, scope: MediaTextScope, title: str) -> ReaderPartDocumentOut:
    """Only proved rich slices enter the child reader; every durable point stays canonical."""
    media_id = scope.reading_media_id
    paths: dict[UUID, str] = {
        row.fragment_id: row.package_href
        for row in db.execute(
            text("SELECT fragment_id,package_href FROM epub_fragment_sources WHERE media_id=:id"),
            {"id": scope.source_media_id},
        )
    }
    units: list[ReaderPartUnitOut] = []
    for interval in scope.fragment_intervals:
        sliced = read_scope_fragment(db, scope, interval)
        units.append(
            ReaderPartUnitOut(
                id=str(interval.fragment_id),
                idx=len(units),
                html_sanitized=sliced.html_sanitized,
                canonical_text=sliced.canonical_text,
                char_count=len(sliced.canonical_text),
                source_start_offset=sliced.source_start_offset,
                href_path=paths.get(interval.fragment_id),
                t_start_ms=None,
                t_end_ms=None,
                speaker_label=None,
                x_post=None,
            )
        )
    anchors = {unit.id: set(canonicalize_structure(unit.html_sanitized).anchors) for unit in units}
    paths_to_units = {unit.href_path: unit.id for unit in units if unit.href_path is not None}
    for unit in units:
        root = fragment_fromstring(unit.html_sanitized, create_parent=True)
        for node in root.iter():
            for attribute, value in list(node.attrib.items()):
                node.set(
                    attribute,
                    value.replace(
                        f"/media/{scope.source_media_id}/assets/", f"/media/{media_id}/assets/"
                    ),
                )
            raw_href = node.get("href")
            if node.tag != "a" or raw_href is None:
                continue
            if node.get("data-reader-apparatus-item-id") is not None or node.xpath(
                ".//*[@data-reader-apparatus-item-id]"
            ):
                node.set("href", "#")
                continue
            href = urlsplit(raw_href)
            if href.scheme or href.netloc:
                continue
            target_id = (
                paths_to_units.get(href.path or unit.href_path or "")
                if scope.source_format == "epub"
                else unit.id
            )
            target_anchor = unquote(href.fragment)
            if target_id is None or (target_anchor and target_anchor not in anchors[target_id]):
                node.attrib.pop("href", None)
                continue
            node.set("href", "#")
            node.set("data-nexus-fragment-id", target_id)
            if target_anchor:
                node.set("data-nexus-anchor-id", target_anchor)
        unit.html_sanitized = inner_html(root)
    navigation = read_media_navigation(
        db,
        media_id=scope.source_media_id,
        kind=scope.source_format,
        generation=scope.source_generation,
    )
    by_id = {unit.id: unit for unit in units}
    sections: list[ReaderSectionOut] = []
    for section in navigation.sections:
        unit = by_id.get(str(section.target.fragment_id))
        if (
            unit is not None
            and unit.source_start_offset
            <= section.target.offset
            < unit.source_start_offset + unit.char_count
        ):
            sections.append(
                ReaderSectionOut(
                    id=section.section_id,
                    label=section.label,
                    depth=0,
                    at=ReaderPointOut(
                        unit_id=unit.id, offset=section.target.offset - unit.source_start_offset
                    ),
                    anchor_id=section.anchor_id,
                )
            )
    first, last = scope.fragment_intervals[0], scope.fragment_intervals[-1]
    return ReaderPartDocumentOut(
        kind="text_part",
        source_format=scope.source_format,
        provenance=ReaderPartProvenanceOut(
            source_media_id=scope.source_media_id,
            source_generation=scope.source_generation,
            extent=ReaderPartExtentOut(
                start=ReaderPartExtentPointOut(
                    fragment_id=first.fragment_id, offset=first.start_offset
                ),
                end=ReaderPartExtentPointOut(fragment_id=last.fragment_id, offset=last.end_offset),
            ),
        ),
        identity=f"g{scope.body_generation}",
        title=title,
        units=units,
        sections=sections,
        toc_nodes=[
            ReaderTocNodeOut(
                id=section.id,
                label=section.label,
                at=section.at,
                section_id=section.id,
                children=[],
            )
            for section in sections
        ],
        source_issues=[],
        embeds=[],
        x_capture=None,
        x_article_content=None,
    )


def transcript_identity(unit_ids: list[str]) -> str:
    """A transcript's identity: a digest of its segment ids in reading order."""
    return f"t{hashlib.sha256('\n'.join(unit_ids).encode()).hexdigest()[:24]}"


def _x_article_embeds(
    db: Session,
    *,
    units: list[ReaderUnitOut],
    viewer_id: UUID | None,
    reading_media_id: UUID | None = None,
) -> list[DocumentEmbedOut]:
    """Project proved carrier article associations onto their displayed occurrences."""
    from nexus.db.models import Media, ProcessingStatus, XPostCapture
    from nexus.services.x_identity import canonical_x_article_url
    from nexus.services.x_source import x_article_link

    result: list[DocumentEmbedOut] = []
    if reading_media_id is None:
        return result
    for unit in units:
        owner = unit.x_post.owner if unit.x_post and unit.x_post.relation == "primary" else None
        if owner is None:
            continue
        capture = db.get(XPostCapture, owner.capture_id)
        if capture is None:
            continue
        link = x_article_link(db, capture=capture, reading_media_id=reading_media_id)
        if link is None:
            continue
        article_id, article_media_id = link
        url = canonical_x_article_url(article_id)
        readable = (
            article_media_id is not None
            and viewer_id is not None
            and can_read_media(db, viewer_id, article_media_id)
        )
        media = db.get(Media, article_media_id) if readable else None
        ready = media is not None and media.processing_status is ProcessingStatus.ready_for_reading
        slot = f"{unit.id}:article:{article_id}"
        present_url = {"status": "present", "value": url, "error_code": None, "reason": None}
        absent_text = {"kind": "absent", "value": None, "reason": "not_applicable"}
        result.append(
            DocumentEmbedOut.model_validate(
                {
                    "id": uuid5(NAMESPACE_URL, f"nexus:x-article:{slot}"),
                    "media_id": None,
                    "fragment_id": owner.fragment_id,
                    "occurrence_key": slot,
                    "ordinal": len(result),
                    "provider": "x",
                    "kind": "link_preview",
                    "source_shape": "provider_json",
                    "resolution_status": None,
                    "source_url": present_url,
                    "canonical_url": present_url,
                    "provider_target_ref": {
                        "kind": "present",
                        "value": f"article:{article_id}",
                        "reason": None,
                    },
                    "title": absent_text,
                    "description": absent_text,
                    "thumbnail_url": {
                        "status": "absent",
                        "value": None,
                        "error_code": None,
                        "reason": "not_applicable",
                    },
                    "authored_text": absent_text,
                    "error_code": absent_text,
                    "retrieval": None,
                    "locator": {
                        "kind": "unanchored",
                        "unit_id": unit.id,
                        "fragment_id": None,
                        "canonical_start_offset": None,
                        "canonical_end_offset": None,
                        "document_order_key": slot,
                        "placeholder_text": "x article",
                    },
                    "target": {
                        "status": "exact" if ready else "partial" if media else "forbidden",
                        "media_id": article_media_id if media else None,
                        "capture_id": None,
                        "resource_ref": f"media:{article_media_id}" if media else None,
                        "href": f"/media/{article_media_id}" if ready else None,
                        "kind": media.kind if media else None,
                        "title": media.title if ready and media is not None else None,
                        "byline": None,
                        "x_article_content": x_article_content_facts(
                            db, media_ids=[article_media_id]
                        ).get(article_media_id)
                        if ready and article_media_id
                        else None,
                        "thumbnail_url": None,
                        "playback": None,
                    },
                    "display": {
                        "mode": None,
                        "label": "x article",
                        "description": None,
                        "actions": [
                            {
                                "kind": "open_child_media",
                                "label": "open article",
                                "href": f"/media/{article_media_id}",
                            }
                        ]
                        if ready
                        else [{"kind": "open_original", "label": "open on x", "href": url}],
                    },
                }
            )
        )
    return result


def x_occurrence_id(
    media_id: UUID,
    capture_id: UUID,
    *,
    parent_unit_id: str | None = None,
    relation: str = "primary",
    embed_occurrence_key: str | None = None,
) -> str:
    return str(
        uuid5(
            NAMESPACE_URL,
            f"nexus:x:{media_id}:{parent_unit_id or ''}:{capture_id}:{relation}:{embed_occurrence_key or ''}",
        )
    )


def _capture_units(
    db: Session,
    *,
    capture_id: UUID,
    occurrence_id: str,
    relation: Literal["primary", "quoted", "replied_to", "retweeted", "embedded"],
    parent_unit_id: str | None,
    insertion_offset: int | None,
    embed_occurrence_key: str | None,
    viewer_id: UUID | None,
    expand: bool = True,
    public_grant_id: UUID | None = None,
    materialize_x_assets: bool = False,
) -> list[ReaderUnitOut]:
    from urllib.parse import quote

    from nexus.schemas.x_source import XArticleExcerptCapture, XCompletePostCapture
    from nexus.services.image_placeholder import replace_image_with_placeholder
    from nexus.services.x_rendering import capture_image_urls
    from nexus.services.x_source import readable_x_capture_ids_sql

    visible = "" if viewer_id is None else f"AND c.id IN ({readable_x_capture_ids_sql()})"
    if public_grant_id is not None:
        visible += " AND c.id IN (SELECT capture_id FROM resource_grant_captures WHERE grant_id=:public_grant_id)"
    row = db.execute(
        text(f"""
        SELECT c.*, p.logical_post_id, p.edit_history_ids, f.id AS fragment_id,
               f.html_sanitized, f.canonical_text, a.availability, a.checked_at
        FROM x_post_captures c JOIN x_post_sources p ON p.id=c.post_id
        JOIN fragments f ON f.x_post_capture_id=c.id
        LEFT JOIN x_post_aliases a ON a.revision_id=c.source_revision_id AND a.post_id=c.post_id
        WHERE c.id=:capture_id {visible}
    """),
        {"capture_id": capture_id, "viewer_id": viewer_id, "public_grant_id": public_grant_id},
    ).one_or_none()
    if row is None:
        return []
    payload = row.payload
    complete = payload["kind"] == "complete_post"
    if complete:
        content = XCompletePostCapture.model_validate_json(json.dumps(payload)).content
        author, created_at, attribution = content.author, content.created_at, None
        parent_source_url, parent_title = None, None
    else:
        excerpt = XArticleExcerptCapture.model_validate_json(json.dumps(payload))
        author, created_at, attribution = None, None, excerpt.attribution_text
        parent_source_url, parent_title = excerpt.parent_source_url, excerpt.parent_title
    available = set(
        db.scalars(
            text("SELECT asset_key FROM x_post_capture_assets WHERE capture_id=:id"),
            {"id": capture_id},
        )
    )
    urls = {
        f"/api/x/captures/{capture_id}/assets/{key}": key for key in capture_image_urls(payload)
    }
    raw = row.html_sanitized
    if "<img" in raw.lower():
        container = fragment_fromstring(raw, create_parent=True)
        for image in list(container.iter("img")):
            key = urls.get(image.get("src"))
            if key is None or key not in available or not materialize_x_assets:
                alt = image.get("alt") or ""
                parent = image.getparent()
                position = parent.index(image)
                replace_image_with_placeholder(image)
                placeholder = parent[position]
                if placeholder is not None:
                    if key is not None:
                        placeholder.set("data-nexus-x-capture", str(capture_id))
                        placeholder.set("data-nexus-x-asset", key)
                        placeholder.set("data-nexus-x-alt", alt)
                    label = (
                        f"image unavailable in saved capture: {alt}"
                        if alt
                        else "image unavailable in saved capture"
                    )
                    placeholder.set("aria-label", label)
                    if len(placeholder):
                        placeholder[0].text = label
            else:
                image.set("src", f"/api/x/captures/{capture_id}/assets/{quote(key, safe='')}")
        raw = inner_html(container)
    contexts = db.execute(
        text("""
        SELECT * FROM x_post_capture_contexts WHERE capture_id=:id ORDER BY ordinal
    """),
        {"id": capture_id},
    ).all()
    children: list[ReaderUnitOut] = []
    references: list[ReaderXReferenceOut] = []
    for context in contexts:
        child_id = (
            x_occurrence_id(
                capture_id,
                context.target_capture_id,
                parent_unit_id=occurrence_id,
                relation=context.relation,
            )
            if context.target_capture_id
            else None
        )
        child = (
            _capture_units(
                db,
                capture_id=context.target_capture_id,
                occurrence_id=child_id,
                relation=context.relation,
                parent_unit_id=occurrence_id,
                insertion_offset=len(row.canonical_text),
                embed_occurrence_key=None,
                viewer_id=viewer_id,
                expand=False,
                public_grant_id=public_grant_id,
                materialize_x_assets=materialize_x_assets,
            )
            if child_id and expand
            else []
        )
        # Context expansion is one hop; children retain links to their own references.
        children.extend(child)
        references.append(
            ReaderXReferenceOut(
                relation=context.relation,
                referenced_revision_id=context.referenced_revision_id,
                source_url=f"https://x.com/i/status/{context.referenced_revision_id}",
                target_unit_id=child_id if child else None,
                availability="available"
                if child
                else ("unavailable" if context.outcome == "unavailable" else "not_captured"),
            )
        )
    saved_media_id = (
        db.scalar(
            text("SELECT media_id FROM x_post_media WHERE capture_id=:id"), {"id": capture_id}
        )
        if viewer_id is not None
        else None
    )
    if (
        saved_media_id is not None
        and viewer_id is not None
        and not can_read_media(db, viewer_id, saved_media_id)
    ):
        saved_media_id = None
    metadata = ReaderXPostOut(
        logical_post_id=row.logical_post_id,
        source_revision_id=row.source_revision_id,
        relation=relation,
        parent_unit_id=parent_unit_id,
        embed_occurrence_key=embed_occurrence_key,
        insertion_offset=insertion_offset,
        referenced_revision_id=None,
        checked_in_capture=None,
        source_url=f"https://x.com/i/status/{row.source_revision_id}",
        author=author,
        attribution_text=attribution,
        parent_source_url=parent_source_url,
        parent_title=parent_title,
        capture_kind=payload["kind"],
        saved_media_id=saved_media_id,
        created_at=created_at,
        is_edited=row.edit_history_ids is not None and len(row.edit_history_ids) > 1,
        availability=row.availability,
        body_captured_at=row.captured_at,
        checked_at=row.checked_at,
        references=references,
        owner=ReaderXPostOwnerOut(capture_id=capture_id, fragment_id=row.fragment_id),
    )
    unit = ReaderUnitOut(
        id=occurrence_id,
        idx=0,
        html_sanitized=raw,
        canonical_text=row.canonical_text,
        char_count=len(row.canonical_text),
        href_path=None,
        t_start_ms=None,
        t_end_ms=None,
        speaker_label=None,
        x_post=metadata,
    )
    return [unit, *children]


def read_capture_document(
    db: Session, viewer_id: UUID, capture_id: UUID
) -> ReaderCaptureDocumentOut:
    units = _capture_units(
        db,
        capture_id=capture_id,
        occurrence_id=str(capture_id),
        relation="primary",
        parent_unit_id=None,
        insertion_offset=None,
        embed_occurrence_key=None,
        viewer_id=viewer_id,
    )
    if not units:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Source not found")
    for index, unit in enumerate(units):
        unit.idx = index
    return ReaderCaptureDocumentOut(
        kind="x_capture",
        capture_id=capture_id,
        publication_generation=None,
        identity=f"capture:{capture_id}:"
        + hashlib.sha256(
            "\n".join(
                f"{unit.id}:{unit.x_post.owner.capture_id}"
                for unit in units
                if unit.x_post is not None and unit.x_post.owner is not None
            ).encode()
        ).hexdigest()[:24],
        title="post",
        units=units,
        sections=[],
        toc_nodes=[],
        source_issues=[],
        embeds=_x_article_embeds(db, units=units, viewer_id=viewer_id),
        x_capture=None,
        x_article_content=None,
    )


def _native_x_units(
    db: Session,
    *,
    media_id: UUID,
    viewer_id: UUID | None,
    public_grant_id: UUID | None = None,
    materialize_x_assets: bool = False,
) -> tuple[list[ReaderUnitOut], ReaderXCaptureOut] | None:
    thread = db.execute(
        text("SELECT * FROM x_thread_sources WHERE media_id=:id"), {"id": media_id}
    ).one_or_none()
    binding = db.execute(
        text("SELECT capture_id FROM x_post_media WHERE media_id=:id"), {"id": media_id}
    ).one_or_none()
    if thread is None and binding is None:
        return None
    members: list[tuple[UUID, UUID]]
    if thread is not None:
        members = [
            (row.id, row.capture_id)
            for row in db.execute(
                text(
                    "SELECT id, capture_id FROM x_thread_posts WHERE thread_media_id=:id ORDER BY ordinal"
                ),
                {"id": media_id},
            )
        ]
    else:
        assert binding is not None
        members = [(media_id, binding.capture_id)]
    coverage = XSourceCoverage.model_validate_json(json.dumps(thread.coverage)) if thread else None
    post_ids = dict(
        db.execute(
            text("SELECT id, post_id FROM x_post_captures WHERE id=ANY(:ids)"),
            {"ids": [capture for _, capture in members]},
        )
        .tuples()
        .all()
    )
    units: list[ReaderUnitOut] = []
    for occurrence, capture in members:
        selected = _capture_units(
            db,
            capture_id=capture,
            occurrence_id=str(occurrence),
            relation="primary",
            parent_unit_id=None,
            insertion_offset=None,
            embed_occurrence_key=None,
            viewer_id=viewer_id,
            public_grant_id=public_grant_id,
            materialize_x_assets=materialize_x_assets,
        )
        if not selected:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Source post unavailable")
        if coverage is not None and thread is not None and thread.membership_checked_at is not None:
            assert selected[0].x_post is not None
            selected[0].x_post.checked_in_capture = (
                post_ids[capture] not in coverage.unchecked_primary_post_ids
            )
        units.extend(selected)
    primary_by_revision = {
        unit.x_post.source_revision_id: unit.id
        for unit in units
        if unit.x_post is not None and unit.x_post.relation == "primary"
    }
    redundant: set[str] = set()
    for unit in units:
        if unit.x_post is None or unit.x_post.relation != "primary":
            continue
        references = []
        for ref in unit.x_post.references:
            target = (
                primary_by_revision.get(ref.referenced_revision_id)
                if ref.relation == "replied_to"
                else None
            )
            if target is not None:
                if ref.target_unit_id is not None:
                    redundant.add(ref.target_unit_id)
                ref = ref.model_copy(update={"target_unit_id": target, "availability": "available"})
            references.append(ref)
        unit.x_post = unit.x_post.model_copy(update={"references": references})
    units = [unit for unit in units if unit.id not in redundant]
    for index, unit in enumerate(units):
        unit.idx = index
    root = (
        db.scalar(
            text("SELECT source_revision_id FROM x_post_captures WHERE id=:id"),
            {"id": thread.root_capture_id},
        )
        if thread and thread.root_capture_id
        else None
    )
    refs = [
        ref
        for unit in units
        if unit.x_post and unit.x_post.relation == "primary"
        for ref in unit.x_post.references
    ]
    if thread is not None:
        saved_at = thread.published_at
    else:
        assert binding is not None
        saved_at = db.scalar(
            text("SELECT captured_at FROM x_post_captures WHERE id=:id"), {"id": binding.capture_id}
        )
    return units, ReaderXCaptureOut(
        scope="author_thread" if thread else "post",
        saved_at=saved_at,
        primary_post_count=len(members),
        root_revision_id=root,
        search_exhausted=coverage.search_exhausted if coverage else None,
        limits=list(coverage.limits) if coverage else [],
        unresolved_parent_count=len(coverage.unresolved_parent_revision_ids) if coverage else 0,
        unchecked_post_count=len(coverage.unchecked_primary_post_ids) if coverage else 0,
        unavailable_context_count=sum(ref.availability == "unavailable" for ref in refs),
        uncaptured_context_count=sum(ref.availability == "not_captured" for ref in refs),
    )


def _with_x_embeds(
    db: Session,
    *,
    media_id: UUID,
    units: list[ReaderUnitOut],
    viewer_id: UUID | None,
    public_grant_id: UUID | None = None,
    materialize_x_assets: bool = False,
) -> list[ReaderUnitOut]:
    rows = db.execute(
        text("""SELECT * FROM document_embeds WHERE media_id=:id AND provider='x'
        AND embed_kind='post' AND target_x_post_capture_id IS NOT NULL
        AND canonical_end_offset IS NOT NULL ORDER BY canonical_end_offset, document_order_key"""),
        {"id": media_id},
    ).all()
    result: list[ReaderUnitOut] = []
    for unit in units:
        result.append(unit)
        for row in rows:
            if (
                str(row.fragment_id) != unit.id
                or not 0 <= row.canonical_end_offset <= unit.char_count
            ):
                continue
            result.extend(
                _capture_units(
                    db,
                    capture_id=row.target_x_post_capture_id,
                    occurrence_id=str(row.id),
                    relation="embedded",
                    parent_unit_id=unit.id,
                    insertion_offset=row.canonical_end_offset,
                    embed_occurrence_key=row.occurrence_key,
                    viewer_id=viewer_id,
                    public_grant_id=public_grant_id,
                    materialize_x_assets=materialize_x_assets,
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

    def append(unit: ReaderUnitOut) -> None:
        start = 0
        for child in children.get(unit.id, []):
            slot = child.x_post.insertion_offset if child.x_post is not None else None
            if slot is None or not start <= slot <= unit.char_count:
                raise AssertionError("X occurrence has invalid source placement")
            result.append((unit, start, slot))
            append(child)
            start = slot
        result.append((unit, start, unit.char_count))

    for unit in units:
        if unit.x_post is None or unit.x_post.parent_unit_id is None:
            append(unit)
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
