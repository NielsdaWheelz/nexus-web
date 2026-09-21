"""Web article structure: embeds, sanitized HTML, canonical text, index blocks."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from dataclasses import replace as dataclass_replace
from typing import assert_never, cast
from uuid import UUID

from lxml.html import HtmlElement, fragment_fromstring

from nexus.logging import get_logger
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.canonicalize import (
    HEADING_TAGS,
    canonicalize_structure,
    generate_canonical_text,
)
from nexus.services.document_embed_extraction import (
    DetectedDocumentEmbed,
    extract_document_embeds,
    occurrence_key,
)
from nexus.services.document_embeds import (
    DocumentEmbedArtifactOccurrence,
    DocumentEmbedTargetAcceptSource,
    DocumentEmbedTargetOutcome,
    DocumentEmbedTargetTerminal,
)
from nexus.services.fragment_blocks import FragmentBlockSpec
from nexus.services.html_apparatus import extract_html_apparatus
from nexus.services.html_tree import inner_html, serialize_html
from nexus.services.sanitize_html import sanitize_html
from nexus.text import normalize_whitespace

logger = get_logger(__name__)

WEB_ARTICLE_HTML_MAX_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class WebArticleIndexBlockSpec:
    block_idx: int
    block_kind: str
    start_offset: int
    end_offset: int
    heading_path: tuple[str, ...]
    owns_container: bool
    parent_section_id: Presence[str]
    heading_level: int | None = None
    section_id: str | None = None
    anchor_id: str | None = None
    depth: int | None = None
    ordinal: int | None = None
    container_end_offset: Presence[int] = field(default_factory=absent)


@dataclass(frozen=True)
class WebArticleDocumentEmbed:
    detected: DetectedDocumentEmbed
    canonical_start_offset: int | None
    canonical_end_offset: int | None


@dataclass(frozen=True)
class WebArticlePreparedFragment:
    html_sanitized: str
    canonical_text: str
    fragment_blocks: list[FragmentBlockSpec]
    index_blocks: list[WebArticleIndexBlockSpec]
    apparatus_items: list[dict[str, object]]
    apparatus_edges: list[dict[str, object]]
    document_embeds: list[WebArticleDocumentEmbed]
    document_embed_extraction_failed: bool = False


@dataclass(frozen=True)
class _Heading:
    label: str
    level: int
    section_id: str
    anchor_id: str | None
    ordinal: int
    container_end_offset: Presence[int]
    owns_container: bool
    parent_section_id: Presence[str]


def prepare_web_article_fragment(
    *,
    html: str,
    base_url: str,
    fragment_idx: int,
    extract_embeds: bool = False,
    embed_source_html: str | None = None,
) -> WebArticlePreparedFragment:
    """Embeds, then apparatus, then sanitize, anchor, canonicalize and index."""
    detected_embeds: list[DetectedDocumentEmbed] = []
    extraction_failed = False
    if extract_embeds:
        try:
            extracted = extract_document_embeds(html, base_url)
            detected_embeds = extracted.embeds
            if embed_source_html is not None and embed_source_html != html:
                detected_embeds = _merge_source_only_embeds(
                    detected_embeds, extract_document_embeds(embed_source_html, base_url).embeds
                )
            html = extracted.html
        except Exception:
            logger.warning("document_embed_extraction_failed", exc_info=True)
            extraction_failed = True
    html, apparatus_items, apparatus_edges = extract_html_apparatus(
        html,
        source_kind=f"web:{fragment_idx}",
        source_ref={"format": "html", "fragment_idx": fragment_idx},
    )
    html_sanitized = add_heading_anchors(
        sanitize_html(
            html,
            base_url,
            allow_reader_apparatus_attrs=True,
            allow_document_embed_attrs=extract_embeds,
        ),
        fragment_idx=fragment_idx,
    )
    canonical_text = generate_canonical_text(html_sanitized)
    document_embeds = _bind_document_embeds(canonical_text, detected_embeds)
    if not canonical_text.strip():
        return WebArticlePreparedFragment(
            html_sanitized=html_sanitized,
            canonical_text=canonical_text,
            fragment_blocks=[FragmentBlockSpec(0, 0, 0)],
            index_blocks=[],
            apparatus_items=[],
            apparatus_edges=[],
            document_embeds=document_embeds,
            document_embed_extraction_failed=extraction_failed,
        )
    return WebArticlePreparedFragment(
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
        fragment_blocks=[
            FragmentBlockSpec(block_idx=index, start_offset=start, end_offset=end)
            for index, (start, end, _text) in enumerate(
                _line_ranges(canonical_text, all_lines=True)
            )
        ]
        or [FragmentBlockSpec(0, 0, 0)],
        index_blocks=build_web_article_index_blocks(
            html_sanitized=html_sanitized,
            canonical_text=canonical_text,
            fragment_idx=fragment_idx,
        ),
        apparatus_items=apparatus_items,
        apparatus_edges=apparatus_edges,
        document_embeds=document_embeds,
        document_embed_extraction_failed=extraction_failed,
    )


def document_embed_artifact_occurrences(
    *,
    fragment_id: UUID,
    document_embeds: list[WebArticleDocumentEmbed],
) -> list[DocumentEmbedArtifactOccurrence]:
    return [
        DocumentEmbedArtifactOccurrence(
            fragment_id=fragment_id,
            ordinal=item.detected.ordinal,
            occurrence_key=item.detected.occurrence_key,
            provider=item.detected.provider,
            embed_kind=item.detected.embed_kind,
            source_shape=item.detected.source_shape,
            source_url=item.detected.source_url,
            canonical_source_url=item.detected.canonical_source_url,
            provider_target_ref=item.detected.provider_target_ref,
            title=item.detected.title,
            authored_text=item.detected.authored_text,
            placeholder_text=item.detected.placeholder_text,
            canonical_start_offset=item.canonical_start_offset,
            canonical_end_offset=item.canonical_end_offset,
            target=_document_embed_target(item.detected),
        )
        for item in document_embeds
    ]


def _document_embed_target(detected: DetectedDocumentEmbed) -> DocumentEmbedTargetOutcome:
    match detected.resolution_status:
        case "pending":
            # Pending extraction is the accepted-source branch; the extraction
            # boundary always supplies its canonical URL.
            return DocumentEmbedTargetAcceptSource(detected.canonical_source_url or "")
        case "unsupported" | "failed" as status:
            return DocumentEmbedTargetTerminal(
                status=status,
                error_code=detected.error_code,
                error_message=detected.error_message,
            )
        case unreachable:
            assert_never(unreachable)


def _bind_document_embeds(
    canonical_text: str, detected_embeds: list[DetectedDocumentEmbed]
) -> list[WebArticleDocumentEmbed]:
    """Locate each placeholder's text in canonical order, once."""
    bound: list[WebArticleDocumentEmbed] = []
    cursor = 0
    for detected in detected_embeds:
        start = canonical_text.find(detected.placeholder_text, cursor)
        if start < 0:
            bound.append(WebArticleDocumentEmbed(detected, None, None))
            continue
        cursor = start + len(detected.placeholder_text)
        bound.append(WebArticleDocumentEmbed(detected, start, cursor))
    return bound


def _merge_source_only_embeds(
    detected: list[DetectedDocumentEmbed],
    source_detected: list[DetectedDocumentEmbed],
) -> list[DetectedDocumentEmbed]:
    """Keep embeds the readable HTML dropped, renumbered after the kept ones."""
    seen = {_embed_identity(embed) for embed in detected}
    missing: list[DetectedDocumentEmbed] = []
    for embed in source_detected:
        identity = _embed_identity(embed)
        if identity in seen:
            continue
        seen.add(identity)
        ordinal = len(detected) + len(missing)
        missing.append(
            dataclass_replace(
                embed,
                ordinal=ordinal,
                occurrence_key=occurrence_key(ordinal, embed.provider, embed.provider_target_ref),
            )
        )
    return [*detected, *missing] if missing else detected


def _embed_identity(embed: DetectedDocumentEmbed) -> tuple[str, str, str]:
    target = embed.provider_target_ref or embed.canonical_source_url or embed.source_url
    return (embed.provider, embed.embed_kind, target or embed.occurrence_key)


def add_heading_anchors(html_sanitized: str, *, fragment_idx: int) -> str:
    """Give every heading a stable, unique id derived from its own text."""
    if not html_sanitized.strip():
        return ""
    root = cast(HtmlElement, fragment_fromstring(html_sanitized, create_parent=True))
    used = {
        value.strip()
        for value in root.xpath(".//*[@id]/@id")
        if isinstance(value, str) and value.strip()
    }
    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement) or str(element.tag).lower() not in HEADING_TAGS:
            continue
        label = normalize_whitespace(generate_canonical_text(serialize_html(element)))
        if not label:
            continue
        prefix = f"nexus-web-heading-{fragment_idx}-{ordinal}-"
        existing_id = element.get("id")
        if existing_id and existing_id.startswith(prefix):
            ordinal += 1
            continue
        slug = _slug(label)
        anchor_id = f"{prefix}{slug}"
        suffix = 2
        while anchor_id in used:
            anchor_id = f"{prefix}{slug}-{suffix}"
            suffix += 1
        used.add(anchor_id)
        element.set("id", anchor_id)
        ordinal += 1
    return inner_html(root)


def build_web_article_index_blocks(
    *,
    html_sanitized: str,
    canonical_text: str,
    fragment_idx: int,
) -> list[WebArticleIndexBlockSpec]:
    """One block per non-blank canonical line: headings carry the outline."""
    heading_by_start = dict(_headings(html_sanitized, canonical_text, fragment_idx))
    stack: list[tuple[int, str]] = []
    blocks: list[WebArticleIndexBlockSpec] = []
    for start, end, _text_value in _line_ranges(canonical_text):
        heading = heading_by_start.get(start)
        if heading is None:
            blocks.append(
                WebArticleIndexBlockSpec(
                    block_idx=len(blocks),
                    block_kind="paragraph",
                    start_offset=start,
                    end_offset=end,
                    heading_path=tuple(label for _level, label in stack),
                    owns_container=False,
                    parent_section_id=absent(),
                )
            )
            continue
        while stack and stack[-1][0] >= heading.level:
            stack.pop()
        stack.append((heading.level, heading.label))
        blocks.append(
            WebArticleIndexBlockSpec(
                block_idx=len(blocks),
                block_kind="heading",
                start_offset=start,
                end_offset=end,
                heading_path=tuple(label for _level, label in stack),
                heading_level=heading.level,
                section_id=heading.section_id,
                anchor_id=heading.anchor_id,
                depth=len(stack),
                ordinal=heading.ordinal,
                container_end_offset=heading.container_end_offset,
                owns_container=heading.owns_container,
                parent_section_id=heading.parent_section_id,
            )
        )
    return blocks


def _headings(
    html_sanitized: str,
    canonical_text: str,
    fragment_idx: int,
) -> list[tuple[int, _Heading]]:
    """Headings with their section ids, source containers, and parents."""
    source = canonicalize_structure(html_sanitized)
    if source.text != canonical_text:
        raise ValueError("Web heading extraction disagrees with persisted canonical text")
    anchors_by_element = {index: anchor for anchor, index in source.anchors.items()}
    headings: list[tuple[int, _Heading]] = []
    source_indices: list[int] = []
    for index, element in enumerate(source.elements):
        if element.tag not in HEADING_TAGS:
            continue
        label = normalize_whitespace(source.text[element.start_offset : element.end_offset])
        if not label:
            continue
        ordinal = len(headings)
        headings.append(
            (
                element.start_offset,
                _Heading(
                    label=label,
                    level=int(element.tag[1]),
                    section_id=f"web-heading:{fragment_idx}:{ordinal}:{_slug(label)}",
                    anchor_id=anchors_by_element.get(index),
                    ordinal=ordinal,
                    container_end_offset=(
                        present(source.elements[element.parent_container.value].end_offset)
                        if isinstance(element.parent_container, Present)
                        else absent()
                    ),
                    owns_container=False,
                    parent_section_id=absent(),
                ),
            )
        )
        source_indices.append(index)

    container_owners: dict[int, str] = {}
    for index, container in enumerate(source.elements):
        if container.tag not in {"section", "article"}:
            continue
        labelled = {
            source.anchors[label] for label in container.labelled_by if label in source.anchors
        }
        owners = [
            heading.section_id
            for source_index, (_start, heading) in zip(source_indices, headings, strict=True)
            if source.elements[source_index].parent_container == present(index)
            and (
                source_index in labelled
                if labelled
                else source.elements[source_index].start_offset == container.start_offset
            )
        ]
        if len(owners) == 1:
            container_owners[index] = owners[0]

    stack: list[_Heading] = []
    resolved: list[tuple[int, _Heading]] = []
    resolved_by_id: dict[str, _Heading] = {}
    for source_index, (start, heading) in zip(source_indices, headings, strict=True):
        while stack and (
            stack[-1].level >= heading.level
            or (
                isinstance(stack[-1].container_end_offset, Present)
                and stack[-1].container_end_offset.value <= start
            )
        ):
            stack.pop()
        parent: Presence[str] = absent()
        owns_container = False
        container = source.elements[source_index].parent_container
        while isinstance(container, Present):
            owner = container_owners.get(container.value)
            if owner == heading.section_id:
                owns_container = True
            elif owner is not None:
                parent = present(
                    stack[-1].section_id
                    if stack and any(ancestor.section_id == owner for ancestor in stack)
                    else owner
                )
                break
            container = source.elements[container.value].parent_container
        if not isinstance(parent, Present) and stack:
            parent = present(stack[-1].section_id)
        heading = dataclass_replace(
            heading, owns_container=owns_container, parent_section_id=parent
        )
        resolved.append((start, heading))
        resolved_by_id[heading.section_id] = heading
        chain = [heading]
        while isinstance(parent, Present):
            ancestor = resolved_by_id[parent.value]
            chain.append(ancestor)
            parent = ancestor.parent_section_id
        stack = list(reversed(chain))
    return resolved


def _line_ranges(canonical_text: str, *, all_lines: bool = False) -> list[tuple[int, int, str]]:
    """Canonical lines as (start, end, text); blank lines only when `all_lines`."""
    ranges: list[tuple[int, int, str]] = []
    cursor = 0
    for part in canonical_text.splitlines(keepends=True):
        start = cursor
        cursor += len(part)
        text_value = part[:-1] if part.endswith("\n") else part
        if all_lines or text_value.strip():
            ranges.append((start, cursor, text_value))
    return ranges


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-") or "section"
