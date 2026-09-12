"""EPUB source navigation and independently addressable render units."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit
from uuid import UUID

from lxml.html import fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import (
    EpubFragmentOut,
    MediaNavigationOut,
    NavigationTextPointOut,
    NavigationTextRangeOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.schemas.presence import absent, presence_from_nullable, present
from nexus.services.capabilities import is_document_status_ready
from nexus.services.html_tree import inner_html
from nexus.services.reader_publication import read_publication_generation


@dataclass(frozen=True, slots=True)
class EpubFragmentSourceContent:
    """Unique render-unit facts for the public sharing projection."""

    ordinal: int
    label: str
    depth: int
    html_sanitized: str
    canonical_text: str


def list_epub_fragment_sources(
    db: Session,
    *,
    media_id: UUID,
    after_ordinal: int | None = None,
    limit: int,
) -> list[EpubFragmentSourceContent]:
    """Read each source fragment once; the caller establishes audience authority."""
    rows = db.execute(
        text("""
            SELECT f.idx, COALESCE(n.label, source.package_href) AS label,
                   COALESCE(toc.depth, 0) AS depth, f.html_sanitized, f.canonical_text
            FROM fragments f
            JOIN epub_fragment_sources source
              ON source.media_id = f.media_id AND source.fragment_id = f.id
            LEFT JOIN LATERAL (
                SELECT label, source_node_id FROM epub_nav_locations
                WHERE media_id = f.media_id AND fragment_idx = f.idx
                ORDER BY start_offset, ordinal LIMIT 1
            ) n ON TRUE
            LEFT JOIN epub_toc_nodes toc
              ON toc.media_id = f.media_id AND toc.node_id = n.source_node_id
            WHERE f.media_id = :media_id
              AND (CAST(:after_ordinal AS INTEGER) IS NULL OR f.idx > :after_ordinal)
            ORDER BY f.idx LIMIT :limit
        """),
        {"media_id": media_id, "after_ordinal": after_ordinal, "limit": limit},
    ).mappings()
    return [
        EpubFragmentSourceContent(
            ordinal=row["idx"],
            label=row["label"],
            depth=row["depth"],
            html_sanitized=row["html_sanitized"],
            canonical_text=row["canonical_text"],
        )
        for row in rows
    ]


def get_epub_fragment_source(
    db: Session,
    *,
    media_id: UUID,
    ordinal: int,
) -> EpubFragmentSourceContent | None:
    rows = list_epub_fragment_sources(db, media_id=media_id, after_ordinal=ordinal - 1, limit=1)
    return rows[0] if rows and rows[0].ordinal == ordinal else None


def require_readable_epub(db: Session, viewer_id: UUID, media_id: UUID) -> None:
    """Enforce visibility before kind and readiness."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = db.execute(
        text("SELECT kind, processing_status FROM media WHERE id = :mid"),
        {"mid": media_id},
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if row.kind != "epub":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Endpoint only supports EPUB media")
    if not is_document_status_ready(str(row.processing_status)):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")


def get_epub_navigation_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaNavigationOut:
    require_readable_epub(db, viewer_id, media_id)
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None:
        # justify-defect: readable EPUB content is installed by the publication owner.
        raise AssertionError("Readable EPUB has no reader publication")
    return read_epub_navigation(db, media_id=media_id, generation=generation)


def read_epub_navigation(
    db: Session,
    *,
    media_id: UUID,
    generation: int,
) -> MediaNavigationOut:
    """Build navigation from the caller's coherent, authorized publication snapshot."""
    fragment_rows = (
        db.execute(
            text("""
            SELECT id, idx, char_length(canonical_text) AS char_count
            FROM fragments WHERE media_id = :mid ORDER BY idx
        """),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    fragment_ids = {row["idx"]: row["id"] for row in fragment_rows}
    section_rows = (
        db.execute(
            text("""
            SELECT location_id, label, parent_section_id, fragment_idx, start_offset,
                   end_fragment_idx, end_offset, source_node_id, source, href_fragment
            FROM epub_nav_locations WHERE media_id = :mid
            ORDER BY fragment_idx, start_offset, ordinal
        """),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    sections: list[ReaderNavigationSectionOut] = []
    for row in section_rows:
        target = NavigationTextPointOut(
            fragment_id=fragment_ids[row["fragment_idx"]],
            offset=row["start_offset"],
        )
        extent = absent()
        if row["end_fragment_idx"] is not None:
            extent = present(
                NavigationTextRangeOut(
                    start=target,
                    end=NavigationTextPointOut(
                        fragment_id=fragment_ids[row["end_fragment_idx"]],
                        offset=row["end_offset"],
                    ),
                )
            )
        elif row["end_offset"] is not None:
            # justify-defect: the structure write owner stores both extent coordinates together.
            raise AssertionError("EPUB semantic extent has an unpaired end offset")
        sections.append(
            ReaderNavigationSectionOut(
                section_id=row["location_id"],
                label=row["label"],
                parent_section_id=presence_from_nullable(row["parent_section_id"]),
                target=target,
                anchor_id=presence_from_nullable(row["href_fragment"]),
                extent=extent,
                source=row["source"],
            )
        )

    toc_rows = (
        db.execute(
            text("""
            SELECT node_id, nav_type, parent_node_id, label, fragment_idx, target_offset
            FROM epub_toc_nodes WHERE media_id = :mid ORDER BY order_key, node_id
        """),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    section_by_source = {
        row["source_node_id"]: row["location_id"]
        for row in section_rows
        if row["source_node_id"] is not None
    }
    nodes = {
        row["node_id"]: ReaderNavigationTocNodeOut(
            id=row["node_id"],
            label=row["label"],
            section_id=presence_from_nullable(section_by_source.get(row["node_id"])),
            children=[],
        )
        for row in toc_rows
        if row["nav_type"] == "toc"
    }
    roots: list[ReaderNavigationTocNodeOut] = []
    for row in toc_rows:
        if row["nav_type"] != "toc":
            continue
        node = nodes[row["node_id"]]
        parent_id = row["parent_node_id"]
        if parent_id is None:
            roots.append(node)
        else:
            nodes[parent_id].children.append(node)

    node_by_section = {
        node.section_id.value: node for node in nodes.values() if node.section_id.kind == "Present"
    }
    missing = [section for section in sections if section.section_id not in node_by_section]
    # Source-only headings augment the outline without changing publisher sibling order.
    for section in missing:
        node_by_section[section.section_id] = ReaderNavigationTocNodeOut(
            id=section.section_id,
            label=section.label,
            section_id=present(section.section_id),
            children=[],
        )
    for section in missing:
        node = node_by_section[section.section_id]
        if section.parent_section_id.kind == "Present":
            parent = node_by_section[section.parent_section_id.value]
            parent.children.append(node)
        else:
            roots.append(node)

    locations: dict[str, list[ReaderNavigationLocationOut]] = {"landmarks": [], "page_list": []}
    for row in toc_rows:
        if row["nav_type"] == "toc":
            continue
        target = absent()
        if row["fragment_idx"] is not None and row["target_offset"] is not None:
            target = present(
                NavigationTextPointOut(
                    fragment_id=fragment_ids[row["fragment_idx"]],
                    offset=row["target_offset"],
                )
            )
        locations[row["nav_type"]].append(
            ReaderNavigationLocationOut(
                id=row["node_id"],
                label=row["label"],
                target=target,
            )
        )
    return MediaNavigationOut(
        media_id=media_id,
        kind="epub",
        generation=generation,
        fragments=[
            ReaderNavigationFragmentOut(
                fragment_id=row["id"],
                fragment_idx=row["idx"],
                char_count=row["char_count"],
            )
            for row in fragment_rows
        ],
        sections=sections,
        toc_nodes=roots,
        landmarks=locations["landmarks"],
        page_list=locations["page_list"],
    )


def rewrite_epub_fragment_links(
    html_sanitized: str,
    *,
    href_path: str,
    fragment_ids_by_path: Mapping[str, UUID],
) -> str:
    """Bind stored package links to render units for hosted and offline readers."""
    root = fragment_fromstring(html_sanitized, create_parent=True)
    for link in root.iter("a"):
        href = link.get("href")
        if not href:
            continue
        parsed = urlsplit(href)
        if parsed.scheme or parsed.netloc:
            continue
        # Ingestion already canonicalizes package-relative links to package paths.
        path = parsed.path if parsed.path else href_path
        fragment_id = fragment_ids_by_path.get(path)
        if fragment_id is None:
            continue
        link.set("data-nexus-fragment-id", str(fragment_id))
        if parsed.fragment:
            link.set("data-nexus-anchor-id", unquote(parsed.fragment))
        link.set("href", "#")
    return inner_html(root)


def get_epub_fragment_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    fragment_id: UUID,
) -> EpubFragmentOut:
    """Read one owned EPUB fragment without requiring a navigation section."""
    require_readable_epub(db, viewer_id, media_id)
    generation = read_publication_generation(db, media_id=media_id)
    if generation is None:
        # justify-defect: readable EPUB content is installed by the publication owner.
        raise AssertionError("Readable EPUB has no reader publication")
    row = (
        db.execute(
            text("""
            SELECT f.id, f.idx, source.package_href, f.html_sanitized, f.canonical_text,
                   f.canonical_text_word_count, f.created_at,
                   COALESCE((SELECT SUM(prior.canonical_text_word_count)
                     FROM fragments prior WHERE prior.media_id = f.media_id AND prior.idx < f.idx),
                     0) AS document_word_start
            FROM fragments f
            JOIN epub_fragment_sources source
              ON source.media_id = f.media_id AND source.fragment_id = f.id
            WHERE f.media_id = :mid AND f.id = :fragment_id
        """),
            {"mid": media_id, "fragment_id": fragment_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "EPUB fragment not found")
    source_paths = db.execute(
        text("SELECT package_href, fragment_id FROM epub_fragment_sources WHERE media_id = :mid"),
        {"mid": media_id},
    )
    return EpubFragmentOut(
        fragment_id=row["id"],
        fragment_idx=row["idx"],
        href_path=row["package_href"],
        generation=generation,
        html_sanitized=rewrite_epub_fragment_links(
            row["html_sanitized"],
            href_path=row["package_href"],
            fragment_ids_by_path={
                source.package_href: source.fragment_id for source in source_paths
            },
        ),
        canonical_text=row["canonical_text"],
        char_count=len(row["canonical_text"]),
        word_count=row["canonical_text_word_count"],
        document_word_start=int(row["document_word_start"]),
        created_at=row["created_at"],
    )
