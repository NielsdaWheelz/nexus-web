"""EPUB source reads: navigation and link rewriting."""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import unquote, urlsplit
from uuid import UUID

from lxml.html import fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.media import (
    MediaNavigationOut,
    NavigationTextPointOut,
    NavigationTextRangeOut,
    ReaderNavigationFragmentOut,
    ReaderNavigationLocationOut,
    ReaderNavigationSectionOut,
    ReaderNavigationTocNodeOut,
)
from nexus.services.html_tree import inner_html
from nexus.services.reader_publication import (
    read_publication_source_issues,
)


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
                   end_fragment_idx, end_offset, source, href_fragment
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
        extent = None
        if row["end_fragment_idx"] is not None:
            extent = NavigationTextRangeOut(
                start=target,
                end=NavigationTextPointOut(
                    fragment_id=fragment_ids[row["end_fragment_idx"]],
                    offset=row["end_offset"],
                ),
            )
        elif row["end_offset"] is not None:
            # The structure write owner stores both extent coordinates together.
            raise NotFoundError(
                ApiErrorCode.E_NOT_FOUND, "EPUB semantic extent has an unpaired end offset"
            )
        sections.append(
            ReaderNavigationSectionOut(
                section_id=row["location_id"],
                label=row["label"],
                parent_section_id=row["parent_section_id"],
                target=target,
                anchor_id=row["href_fragment"],
                extent=extent,
                source=row["source"],
            )
        )

    toc_rows = (
        db.execute(
            text("""
            SELECT node_id, nav_type, parent_node_id, label, fragment_idx, target_offset,
                   section_id, resolution
            FROM epub_toc_nodes WHERE media_id = :mid ORDER BY order_key, node_id
        """),
            {"mid": media_id},
        )
        .mappings()
        .all()
    )
    section_targets = {section.section_id: section.target for section in sections}
    for row in toc_rows:
        if row["resolution"] not in {
            "Unresolved",
            "SourceTarget",
            "BoundaryMatch",
            "ExactHeadingRepair",
        }:
            raise ValueError("EPUB TOC node has an unknown resolution")
        if row["resolution"] == "Unresolved":
            if (
                row["fragment_idx"] is not None
                or row["target_offset"] is not None
                or row["section_id"] is not None
            ):
                raise ValueError("Unresolved EPUB TOC node has an effective destination")
        elif row["fragment_idx"] not in fragment_ids or row["target_offset"] is None:
            raise ValueError("Resolved EPUB TOC node names no published fragment point")
        if row["section_id"] is not None:
            point = section_targets.get(row["section_id"])
            if (
                point is None
                or point.fragment_id != fragment_ids.get(row["fragment_idx"])
                or (point.offset != row["target_offset"])
            ):
                raise ValueError("EPUB TOC section linkage disagrees with its target")
    nodes = {
        row["node_id"]: ReaderNavigationTocNodeOut(
            id=row["node_id"],
            label=row["label"],
            target=NavigationTextPointOut(
                fragment_id=fragment_ids[row["fragment_idx"]], offset=row["target_offset"]
            )
            if row["target_offset"] is not None
            else None,
            section_id=row["section_id"],
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

    node_by_section: dict[str, ReaderNavigationTocNodeOut] = {}
    for node in nodes.values():
        if node.section_id is not None:
            node_by_section.setdefault(node.section_id, node)
    # Source-only headings augment the outline without changing publisher sibling order.
    missing = [section for section in sections if section.section_id not in node_by_section]
    for section in missing:
        node_by_section[section.section_id] = ReaderNavigationTocNodeOut(
            id=section.section_id,
            label=section.label,
            target=section.target,
            section_id=section.section_id,
            children=[],
        )
    for section in missing:
        node = node_by_section[section.section_id]
        if section.parent_section_id is not None:
            node_by_section[section.parent_section_id].children.append(node)
        else:
            roots.append(node)

    locations: dict[str, list[ReaderNavigationLocationOut]] = {"landmarks": [], "page_list": []}
    for row in toc_rows:
        if row["nav_type"] == "toc":
            continue
        target = None
        if row["fragment_idx"] is not None and row["target_offset"] is not None:
            target = NavigationTextPointOut(
                fragment_id=fragment_ids[row["fragment_idx"]],
                offset=row["target_offset"],
            )
        locations[row["nav_type"]].append(
            ReaderNavigationLocationOut(id=row["node_id"], label=row["label"], target=target)
        )
    return MediaNavigationOut(
        media_id=media_id,
        kind="epub",
        generation=generation,
        source_issues=read_publication_source_issues(db, media_id=media_id, generation=generation),
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
        fragment_id = fragment_ids_by_path.get(parsed.path if parsed.path else href_path)
        if fragment_id is None:
            continue
        link.set("data-nexus-fragment-id", str(fragment_id))
        if parsed.fragment:
            link.set("data-nexus-anchor-id", unquote(parsed.fragment))
        link.set("href", "#")
    return inner_html(root)
