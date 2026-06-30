"""Web article structure extraction owned by the ingestion boundary."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from dataclasses import replace as dataclass_replace
from typing import cast

from lxml.html import HtmlElement, fragment_fromstring, tostring

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.document_embed_extraction import DetectedDocumentEmbed, extract_document_embeds
from nexus.services.fragment_blocks import FragmentBlockSpec
from nexus.services.reader_apparatus import extract_html_apparatus
from nexus.services.sanitize_html import sanitize_html
from nexus.text import normalize_whitespace

HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
WEB_ARTICLE_HTML_MAX_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class WebArticleIndexBlockSpec:
    block_idx: int
    block_kind: str
    start_offset: int
    end_offset: int
    heading_path: tuple[str, ...]
    heading_level: int | None = None
    section_id: str | None = None
    anchor_id: str | None = None
    depth: int | None = None
    ordinal: int | None = None


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
    document_embed_extraction_error_code: str | None = None
    document_embed_extraction_error_message: str | None = None


@dataclass(frozen=True)
class _Heading:
    label: str
    level: int
    section_id: str
    anchor_id: str
    ordinal: int
    visible: bool


def prepare_web_article_fragment(
    *,
    html: str,
    base_url: str,
    fragment_idx: int,
    media_title: str | None = None,
    extract_embeds: bool = False,
    embed_source_html: str | None = None,
) -> WebArticlePreparedFragment:
    detected_embeds: list[DetectedDocumentEmbed] = []
    document_embed_extraction_error_code: str | None = None
    document_embed_extraction_error_message: str | None = None
    if extract_embeds:
        try:
            extracted = extract_document_embeds(html, base_url)
            next_html = extracted.html
            next_detected_embeds = extracted.embeds
            if embed_source_html is not None and embed_source_html != html:
                source_extracted = extract_document_embeds(embed_source_html, base_url)
                next_html, next_detected_embeds = _merge_source_only_embeds(
                    next_html, next_detected_embeds, source_extracted.embeds
                )
            html = next_html
            detected_embeds = next_detected_embeds
        except Exception as exc:
            document_embed_extraction_error_code = "E_EMBED_EXTRACTION_FAILED"
            document_embed_extraction_error_message = str(exc)[:1000]
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
            fragment_blocks=[FragmentBlockSpec(0, 0, 0, True)],
            index_blocks=[],
            apparatus_items=[],
            apparatus_edges=[],
            document_embeds=document_embeds,
            document_embed_extraction_error_code=document_embed_extraction_error_code,
            document_embed_extraction_error_message=document_embed_extraction_error_message,
        )
    index_blocks = build_web_article_index_blocks(
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
        fragment_idx=fragment_idx,
        media_title=media_title,
    )
    return WebArticlePreparedFragment(
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
        fragment_blocks=_fragment_blocks(canonical_text, index_blocks),
        index_blocks=index_blocks,
        apparatus_items=apparatus_items,
        apparatus_edges=apparatus_edges,
        document_embeds=document_embeds,
        document_embed_extraction_error_code=document_embed_extraction_error_code,
        document_embed_extraction_error_message=document_embed_extraction_error_message,
    )


def _bind_document_embeds(
    canonical_text: str, detected_embeds: list[DetectedDocumentEmbed]
) -> list[WebArticleDocumentEmbed]:
    bound: list[WebArticleDocumentEmbed] = []
    cursor = 0
    for detected in detected_embeds:
        start = canonical_text.find(detected.placeholder_text, cursor)
        if start < 0:
            bound.append(WebArticleDocumentEmbed(detected, None, None))
            continue
        end = start + len(detected.placeholder_text)
        bound.append(WebArticleDocumentEmbed(detected, start, end))
        cursor = end
    return bound


def _merge_source_only_embeds(
    html: str,
    detected: list[DetectedDocumentEmbed],
    source_detected: list[DetectedDocumentEmbed],
) -> tuple[str, list[DetectedDocumentEmbed]]:
    seen = {_embed_identity(embed) for embed in detected}
    missing: list[DetectedDocumentEmbed] = []
    for embed in source_detected:
        identity = _embed_identity(embed)
        if identity in seen:
            continue
        seen.add(identity)
        missing.append(
            dataclass_replace(
                embed,
                ordinal=len(detected) + len(missing),
                occurrence_key=f"embed:{len(detected) + len(missing):06d}:"
                f"{embed.provider}:{embed.provider_target_ref or 'none'}",
            )
        )
    return html, [*detected, *missing] if missing else detected


def _embed_identity(embed: DetectedDocumentEmbed) -> tuple[str, str, str]:
    target = embed.provider_target_ref or embed.canonical_source_url or embed.source_url
    return (embed.provider, embed.embed_kind, target or embed.occurrence_key)


def add_heading_anchors(html_sanitized: str, *, fragment_idx: int) -> str:
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
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag not in HEADING_TAGS:
            continue
        label = _label(_element_html(element))
        if not label:
            continue
        existing_id = element.get("id")
        prefix = f"nexus-web-heading-{fragment_idx}-{ordinal}-"
        if existing_id and existing_id.startswith(prefix):
            ordinal += 1
            continue
        slug = _slug(label)
        anchor_id = f"nexus-web-heading-{fragment_idx}-{ordinal}-{slug}"
        suffix = 2
        while anchor_id in used:
            anchor_id = f"nexus-web-heading-{fragment_idx}-{ordinal}-{slug}-{suffix}"
            suffix += 1
        used.add(anchor_id)
        element.set("id", anchor_id)
        ordinal += 1
    return _inner_html(root)


def build_web_article_index_blocks(
    *,
    html_sanitized: str,
    canonical_text: str,
    fragment_idx: int,
    media_title: str | None = None,
) -> list[WebArticleIndexBlockSpec]:
    headings = _headings(html_sanitized, canonical_text, fragment_idx, media_title)
    heading_by_start = {start: heading for start, heading in headings}
    stack: list[tuple[int, str]] = []
    blocks: list[WebArticleIndexBlockSpec] = []
    for start, end, _text_value in _line_ranges(canonical_text):
        heading = heading_by_start.get(start)
        if heading is not None:
            if heading.visible:
                while stack and stack[-1][0] >= heading.level:
                    stack.pop()
                stack.append((heading.level, heading.label))
            blocks.append(
                WebArticleIndexBlockSpec(
                    block_idx=len(blocks),
                    block_kind="heading",
                    start_offset=start,
                    end_offset=end,
                    heading_path=tuple(label for _, label in stack),
                    heading_level=heading.level,
                    section_id=heading.section_id if heading.visible else None,
                    anchor_id=heading.anchor_id if heading.visible else None,
                    depth=len(stack) if heading.visible else None,
                    ordinal=heading.ordinal if heading.visible else None,
                )
            )
            continue
        blocks.append(
            WebArticleIndexBlockSpec(
                block_idx=len(blocks),
                block_kind="paragraph",
                start_offset=start,
                end_offset=end,
                heading_path=tuple(label for _, label in stack),
            )
        )
    return blocks


def _headings(
    html_sanitized: str,
    canonical_text: str,
    fragment_idx: int,
    media_title: str | None,
) -> list[tuple[int, _Heading]]:
    root = cast(HtmlElement, fragment_fromstring(html_sanitized, create_parent=True))
    title = normalize_whitespace(media_title or "")
    seen_first = False
    cursor = 0
    headings: list[tuple[int, _Heading]] = []
    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag not in HEADING_TAGS:
            continue
        label = _label(_element_html(element))
        if not label:
            continue
        match = _find_line(canonical_text, label, cursor)
        if match is None:
            continue
        start, end = match
        slug = _slug(label)
        visible = not (not seen_first and title and normalize_whitespace(label) == title)
        headings.append(
            (
                start,
                _Heading(
                    label=label,
                    level=int(tag[1]),
                    section_id=f"web-heading:{fragment_idx}:{ordinal}:{slug}",
                    anchor_id=element.get("id")
                    or f"nexus-web-heading-{fragment_idx}-{ordinal}-{slug}",
                    ordinal=ordinal,
                    visible=visible,
                ),
            )
        )
        seen_first = True
        ordinal += 1
        cursor = end
    return headings


def _fragment_blocks(
    canonical_text: str,
    index_blocks: list[WebArticleIndexBlockSpec],
) -> list[FragmentBlockSpec]:
    type_by_start = {block.start_offset: block.block_kind for block in index_blocks}
    blocks: list[FragmentBlockSpec] = []
    cursor = 0
    for idx, part in enumerate(canonical_text.splitlines(keepends=True)):
        start = cursor
        end = start + len(part)
        cursor = end
        blocks.append(
            FragmentBlockSpec(
                block_idx=idx,
                start_offset=start,
                end_offset=end,
                is_empty=part.strip() == "",
                block_type=type_by_start.get(start),
            )
        )
    return blocks or [FragmentBlockSpec(0, 0, 0, True)]


def _line_ranges(canonical_text: str) -> list[tuple[int, int, str]]:
    ranges: list[tuple[int, int, str]] = []
    cursor = 0
    for part in canonical_text.splitlines(keepends=True):
        start = cursor
        cursor += len(part)
        text_value = part[:-1] if part.endswith("\n") else part
        if text_value.strip():
            ranges.append((start, cursor, text_value))
    return ranges


def _find_line(canonical_text: str, label: str, cursor: int) -> tuple[int, int] | None:
    for start, end, text_value in _line_ranges(canonical_text):
        if start >= cursor and text_value == label:
            return start, end
    return None


def _label(html: str) -> str:
    return normalize_whitespace(generate_canonical_text(html))


def _element_html(element: HtmlElement) -> str:
    html = tostring(element, encoding="unicode", method="html")
    return html if isinstance(html, str) else html.decode()


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    return slug or "section"


def _inner_html(root: HtmlElement) -> str:
    parts = [root.text or ""]
    parts.extend(tostring(child, encoding="unicode", method="html") for child in root)
    return "".join(parts)
