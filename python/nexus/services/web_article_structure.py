"""Web article structure extraction owned by the ingestion boundary."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import cast

from lxml.html import HtmlElement, fragment_fromstring, tostring

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.fragment_blocks import FragmentBlockSpec
from nexus.services.sanitize_html import sanitize_html

HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


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
class WebArticlePreparedFragment:
    html_sanitized: str
    canonical_text: str
    fragment_blocks: list[FragmentBlockSpec]
    index_blocks: list[WebArticleIndexBlockSpec]
    source_fingerprint_material: str


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
) -> WebArticlePreparedFragment:
    html_sanitized = add_heading_anchors(
        sanitize_html(html, base_url),
        fragment_idx=fragment_idx,
    )
    canonical_text = generate_canonical_text(html_sanitized)
    if not canonical_text.strip():
        return WebArticlePreparedFragment(
            html_sanitized=html_sanitized,
            canonical_text=canonical_text,
            fragment_blocks=[FragmentBlockSpec(0, 0, 0, True)],
            index_blocks=[],
            source_fingerprint_material="[]",
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
        source_fingerprint_material=_fingerprint_material(index_blocks),
    )


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


def source_version_for_web_article(
    canonical_texts: list[str],
    blocks: list[WebArticleIndexBlockSpec],
) -> str:
    material = "\n\n".join(canonical_texts) + "\n" + _fingerprint_material(blocks)
    return f"web_article:fragments:{hashlib.sha256(material.encode()).hexdigest()}"


def _headings(
    html_sanitized: str,
    canonical_text: str,
    fragment_idx: int,
    media_title: str | None,
) -> list[tuple[int, _Heading]]:
    root = cast(HtmlElement, fragment_fromstring(html_sanitized, create_parent=True))
    title = _plain(media_title or "")
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
        visible = not (not seen_first and title and _plain(label) == title)
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
    return _plain(generate_canonical_text(html))


def _element_html(element: HtmlElement) -> str:
    html = tostring(element, encoding="unicode", method="html")
    return html if isinstance(html, str) else html.decode()


def _plain(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    return slug or "section"


def _inner_html(root: HtmlElement) -> str:
    parts = [root.text or ""]
    parts.extend(tostring(child, encoding="unicode", method="html") for child in root)
    return "".join(parts)


def _fingerprint_material(blocks: list[WebArticleIndexBlockSpec]) -> str:
    return json.dumps(
        [
            {
                "kind": block.block_kind,
                "start": block.start_offset,
                "end": block.end_offset,
                "level": block.heading_level,
                "section": block.section_id,
                "path": list(block.heading_path),
            }
            for block in blocks
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
