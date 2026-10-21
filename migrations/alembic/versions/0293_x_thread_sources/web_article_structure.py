# Frozen for migration 0293 from d6f04890c:python/nexus/services/web_article_structure.py (its preparation).
"""Web article structure: embeds, sanitized HTML, canonical text, index blocks."""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from dataclasses import replace as dataclass_replace
from typing import cast
from urllib.parse import unquote, urldefrag

from lxml.html import HtmlElement, fragment_fromstring

from .canonicalize import (
    HEADING_TAGS,
    CanonicalStructure,
    canonicalize_structure,
    generate_canonical_text,
)
from .document_embed_extraction import (
    DetectedDocumentEmbed,
    extract_document_embeds,
    occurrence_key,
)
from .html_apparatus import (
    collect_html_apparatus_targets,
    extract_html_apparatus,
    prepare_apparatus_bodies,
)
from .html_tree import inner_html, parse_html_document, serialize_html
from .sanitize_html import sanitize_html
from .support import FragmentBlockSpec, normalize_whitespace

logger = logging.getLogger(__name__)

WEB_ARTICLE_HTML_MAX_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class WebArticleDocumentEmbed:
    detected: DetectedDocumentEmbed
    canonical_start_offset: int | None
    canonical_end_offset: int | None


@dataclass(frozen=True)
class WebArticlePreparedFragment:
    html_sanitized: str
    structure: CanonicalStructure
    fragment_blocks: list[FragmentBlockSpec]
    apparatus_items: list[dict[str, object]]
    apparatus_edges: list[dict[str, object]]
    document_embeds: list[WebArticleDocumentEmbed]
    document_embed_extraction_failed: bool = False

    @property
    def canonical_text(self) -> str:
        return self.structure.text


def prepare_web_article_fragment(
    *,
    html: str,
    base_url: str,
    document_url: str,
    fragment_idx: int,
    extract_embeds: bool = False,
    embed_source_html: str | None = None,
) -> WebArticlePreparedFragment:
    """Embeds, then apparatus, then sanitize, anchor, canonicalize and index."""
    document_url = urldefrag(document_url).url
    if urldefrag(base_url).url != document_url:
        source = parse_html_document(embed_source_html or html)
        documents = [parse_html_document(html)]
        if embed_source_html is not None:
            documents.append(source)
        source_ids = {
            element.get("id")
            for document in documents
            for element in document.iter()
            if element.get("id")
        }
        for document in documents:
            for anchor in document.xpath('.//a[starts-with(@href, "#")]'):
                href = anchor.get("href")
                if unquote(href[1:]) in source_ids:
                    anchor.set("href", document_url + href)
        html = serialize_html(documents[0])
        if embed_source_html is not None:
            embed_source_html = serialize_html(source)
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
    targets, _, _, _ = collect_html_apparatus_targets(
        embed_source_html or html,
        document_href=document_url,
        source_kind=f"web:{fragment_idx}",
        source_ref={"format": "html", "fragment_idx": fragment_idx, "document_href": document_url},
        max_targets=10000,
        max_backlinks=100000,
        max_retained_utf8_bytes=WEB_ARTICLE_HTML_MAX_BYTES,
        entry_openers={},
    )
    html, apparatus_items, apparatus_edges = extract_html_apparatus(
        html,
        source_kind=f"web:{fragment_idx}",
        source_ref={"format": "html", "fragment_idx": fragment_idx, "document_href": document_url},
        document_href=document_url,
        external_targets=targets,
    )
    existing_keys = {str(item["stable_key"]) for item in apparatus_items}
    referenced_keys = {str(edge["to_stable_key"]) for edge in apparatus_edges}
    for target in targets.values():
        if str(target["stable_key"]) in referenced_keys - existing_keys:
            apparatus_items.append(
                {
                    key: value
                    for key, value in target.items()
                    if key
                    in {
                        "stable_key",
                        "kind",
                        "label",
                        "body_text",
                        "_body_html",
                        "confidence",
                        "extraction_method",
                        "source_ref",
                        "sort_key",
                    }
                }
            )
    prepare_apparatus_bodies(
        apparatus_items,
        sanitize=lambda body: sanitize_html(body, base_url, document_url=document_url),
        media_kind="web_article",
    )
    html_sanitized = add_heading_anchors(
        sanitize_html(
            html,
            base_url,
            document_url=document_url,
            allow_reader_apparatus_attrs=True,
            allow_document_embed_attrs=extract_embeds,
        ),
        fragment_idx=fragment_idx,
    )
    structure = canonicalize_structure(html_sanitized)
    canonical_text = structure.text
    document_embeds = _bind_document_embeds(structure, detected_embeds)
    if not canonical_text.strip():
        return WebArticlePreparedFragment(
            html_sanitized=html_sanitized,
            structure=structure,
            fragment_blocks=[FragmentBlockSpec(0, 0, 0)],
            apparatus_items=[],
            apparatus_edges=[],
            document_embeds=document_embeds,
            document_embed_extraction_failed=extraction_failed,
        )
    return WebArticlePreparedFragment(
        html_sanitized=html_sanitized,
        structure=structure,
        fragment_blocks=[
            FragmentBlockSpec(block_idx=index, start_offset=start, end_offset=end)
            for index, (start, end, _text) in enumerate(
                _line_ranges(canonical_text, all_lines=True)
            )
        ]
        or [FragmentBlockSpec(0, 0, 0)],
        apparatus_items=apparatus_items,
        apparatus_edges=apparatus_edges,
        document_embeds=document_embeds,
        document_embed_extraction_failed=extraction_failed,
    )


def _bind_document_embeds(
    structure: CanonicalStructure, detected_embeds: list[DetectedDocumentEmbed]
) -> list[WebArticleDocumentEmbed]:
    """Bind X metadata to its exact DOM slot; other providers retain text placeholders."""
    bound: list[WebArticleDocumentEmbed] = []
    cursor = 0
    for detected in detected_embeds:
        if detected.provider == "x":
            slot = structure.x_embed_slots.get(detected.occurrence_key)
            bound.append(WebArticleDocumentEmbed(detected, slot, slot))
            if slot is not None:
                cursor = slot
            continue
        start = structure.text.find(detected.placeholder_text, cursor)
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
    """Keep authored heading ids; mint stable ids only for unanchored headings."""
    if not html_sanitized.strip():
        return ""
    root = cast(HtmlElement, fragment_fromstring(html_sanitized, create_parent=True))
    used = {
        value.strip()
        for value in root.xpath(".//*[@id or @name]/@id | .//*[@name]/@name")
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
        # Even a duplicate authored id remains source evidence. The canonical
        # structure excludes ambiguous tokens from its navigation index.
        if existing_id:
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
