"""Typed inline embed detection for web article source HTML."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urljoin, urlparse

from lxml.html import Element, HtmlElement

from nexus.errors import InvalidRequestError
from nexus.schemas.media import DocumentEmbedKind, DocumentEmbedProvider, DocumentEmbedSourceShape
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.url_normalize import validate_requested_url
from nexus.services.x_identity import classify_x_url
from nexus.services.youtube_identity import classify_youtube_url
from nexus.text import normalize_whitespace

_MAX_PLACEHOLDER_TEXT_LENGTH = 512
_MAX_TITLE_LENGTH = 300


@dataclass(frozen=True, slots=True)
class DetectedDocumentEmbed:
    ordinal: int
    occurrence_key: str
    provider: DocumentEmbedProvider
    embed_kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: Literal["pending", "unsupported", "failed"]
    placeholder_text: str
    source_url: str | None = None
    canonical_source_url: str | None = None
    provider_target_ref: str | None = None
    title: str | None = None
    authored_text: str | None = None
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True, slots=True)
class ExtractedDocumentEmbeds:
    html: str
    embeds: list[DetectedDocumentEmbed]
    diagnostics: dict[str, object]


def occurrence_key(ordinal: int, provider: str, provider_target_ref: str | None) -> str:
    return f"embed:{ordinal:06d}:{provider}:{provider_target_ref or 'none'}"


def extract_document_embeds(html: str, base_url: str) -> ExtractedDocumentEmbeds:
    """Replace every detected embed with a placeholder figure, in document order."""
    if not html.strip():
        return ExtractedDocumentEmbeds(html="", embeds=[], diagnostics={"detected_count": 0})
    doc = parse_html_document(html)
    body = doc.body
    if body is None:
        return ExtractedDocumentEmbeds(html=html, embeds=[], diagnostics={"detected_count": 0})

    embeds: list[DetectedDocumentEmbed] = []
    for element in list(body.iter()):
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag == "iframe":
            detected = _detect_iframe(element, base_url, len(embeds))
        elif tag == "blockquote" and "twitter-tweet" in (element.get("class") or "").split():
            detected = _detect_x_blockquote(element, base_url, len(embeds))
        else:
            continue
        if detected is None:
            continue
        _replace_with_placeholder(element, detected)
        embeds.append(detected)

    return ExtractedDocumentEmbeds(
        html=inner_html(body),
        embeds=embeds,
        diagnostics={"detected_count": len(embeds)},
    )


def _detect_iframe(element: HtmlElement, base_url: str, ordinal: int) -> DetectedDocumentEmbed:
    src = (element.get("src") or "").strip()
    absolute_url = urljoin(base_url, src) if src else ""
    if src:
        try:
            validate_requested_url(absolute_url)
        except InvalidRequestError:
            src = ""
    if not src:
        return DetectedDocumentEmbed(
            ordinal=ordinal,
            occurrence_key=occurrence_key(ordinal, "unknown", None),
            provider="unknown",
            embed_kind="unknown",
            source_shape="iframe",
            resolution_status="failed",
            placeholder_text="Embedded content unavailable",
            error_code="missing_src" if not absolute_url else "unsafe_url",
            error_message=(
                "Iframe embed did not include a source URL."
                if not absolute_url
                else "Iframe embed source URL is unsafe."
            ),
        )

    youtube = classify_youtube_url(absolute_url)
    if youtube is None:
        hostname = urlparse(absolute_url).hostname or "unknown provider"
        return DetectedDocumentEmbed(
            ordinal=ordinal,
            occurrence_key=occurrence_key(ordinal, "generic", None),
            provider="generic",
            embed_kind="unknown",
            source_shape="iframe",
            resolution_status="unsupported",
            placeholder_text=f"Unsupported embedded content: {hostname}",
        )
    title = _clip(normalize_whitespace(element.get("title") or ""), _MAX_TITLE_LENGTH) or None
    return DetectedDocumentEmbed(
        ordinal=ordinal,
        occurrence_key=occurrence_key(ordinal, "youtube", youtube.provider_video_id),
        provider="youtube",
        embed_kind="video",
        source_shape="iframe",
        resolution_status="pending",
        placeholder_text=_clip(
            f"Embedded video: {title or 'YouTube video'}", _MAX_PLACEHOLDER_TEXT_LENGTH
        ),
        source_url=youtube.watch_url,
        canonical_source_url=youtube.watch_url,
        provider_target_ref=youtube.provider_video_id,
        title=title,
    )


def _detect_x_blockquote(
    element: HtmlElement, base_url: str, ordinal: int
) -> DetectedDocumentEmbed | None:
    for href in element.xpath(".//a/@href"):
        if not isinstance(href, str):
            continue
        absolute_url = urljoin(base_url, href)
        try:
            validate_requested_url(absolute_url)
        except InvalidRequestError:
            continue
        identity = classify_x_url(absolute_url)
        if identity is None:
            continue
        authored_text = normalize_whitespace(" ".join(element.itertext()))[:500] or None
        return DetectedDocumentEmbed(
            ordinal=ordinal,
            occurrence_key=occurrence_key(ordinal, "x", identity.provider_id),
            provider="x",
            embed_kind="post",
            source_shape="blockquote",
            resolution_status="pending",
            placeholder_text=(
                f"Embedded X post: {authored_text[:120] if authored_text else 'X post'}"
            ),
            source_url=identity.canonical_url,
            canonical_source_url=identity.canonical_url,
            provider_target_ref=identity.provider_id,
            title="Embedded X post",
            authored_text=authored_text,
        )
    return None


def _replace_with_placeholder(element: HtmlElement, embed: DetectedDocumentEmbed) -> None:
    parent = element.getparent()
    if parent is None:
        return
    figure = Element("figure")
    figure.set("data-nexus-document-embed-id", embed.occurrence_key)
    figure.set("data-nexus-document-embed-kind", f"{embed.provider}_{embed.embed_kind}")
    caption = Element("figcaption")
    caption.text = embed.placeholder_text
    figure.append(caption)
    figure.tail = element.tail
    parent.replace(element, figure)


def _clip(value: str, max_length: int) -> str:
    return value[:max_length].rstrip()
