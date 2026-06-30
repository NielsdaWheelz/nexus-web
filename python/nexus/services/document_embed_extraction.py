"""Typed inline embed extraction for web article source HTML."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

from lxml.html import Element, HtmlElement, document_fromstring, tostring

from nexus.errors import InvalidRequestError
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
    provider: str
    embed_kind: str
    source_shape: str
    resolution_status: str
    source_url: str | None
    canonical_source_url: str | None
    provider_target_ref: str | None
    title: str | None
    authored_text: str | None
    placeholder_text: str
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True, slots=True)
class ExtractedDocumentEmbeds:
    html: str
    embeds: list[DetectedDocumentEmbed]
    diagnostics: dict[str, object]


def extract_document_embeds(html: str, base_url: str) -> ExtractedDocumentEmbeds:
    if not html.strip():
        return ExtractedDocumentEmbeds(html="", embeds=[], diagnostics={"detected_count": 0})

    doc = document_fromstring(html)
    body = doc.body
    if body is None:
        return ExtractedDocumentEmbeds(html=html, embeds=[], diagnostics={"detected_count": 0})

    embeds: list[DetectedDocumentEmbed] = []
    ordinal = 0
    for element in list(body.iter()):
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag == "iframe":
            detected = _detect_iframe(element, base_url, ordinal)
        elif tag == "blockquote" and _is_x_blockquote(element):
            detected = _detect_x_blockquote(element, base_url, ordinal)
        else:
            continue
        if detected is None:
            continue
        _replace_with_placeholder(element, detected)
        embeds.append(detected)
        ordinal += 1

    return ExtractedDocumentEmbeds(
        html=_body_inner_html(body),
        embeds=embeds,
        diagnostics={"detected_count": len(embeds)},
    )


def _detect_iframe(
    element: HtmlElement, base_url: str, ordinal: int
) -> DetectedDocumentEmbed | None:
    src = (element.get("src") or "").strip()
    if not src:
        return _embed(
            ordinal,
            provider="unknown",
            embed_kind="unknown",
            source_shape="iframe",
            resolution_status="failed",
            source_url=None,
            canonical_source_url=None,
            provider_target_ref=None,
            title=None,
            authored_text=None,
            placeholder_text="Embedded content unavailable",
            error_code="missing_src",
            error_message="Iframe embed did not include a source URL.",
        )
    absolute_url = urljoin(base_url, src)
    try:
        validate_requested_url(absolute_url)
    except InvalidRequestError:
        return _embed(
            ordinal,
            provider="unknown",
            embed_kind="unknown",
            source_shape="iframe",
            resolution_status="failed",
            source_url=None,
            canonical_source_url=None,
            provider_target_ref=None,
            title=None,
            authored_text=None,
            placeholder_text="Embedded content unavailable",
            error_code="unsafe_url",
            error_message="Iframe embed source URL is unsafe.",
        )
    parsed = urlparse(absolute_url)
    youtube = classify_youtube_url(absolute_url)
    if youtube is not None:
        title = _clip(normalize_whitespace(element.get("title") or ""), _MAX_TITLE_LENGTH) or None
        return _embed(
            ordinal,
            provider="youtube",
            embed_kind="video",
            source_shape="iframe",
            resolution_status="pending",
            source_url=youtube.watch_url,
            canonical_source_url=youtube.watch_url,
            provider_target_ref=youtube.provider_video_id,
            title=title,
            authored_text=None,
            placeholder_text=_clip(
                f"Embedded video: {title or 'YouTube video'}", _MAX_PLACEHOLDER_TEXT_LENGTH
            ),
        )
    return _embed(
        ordinal,
        provider="generic",
        embed_kind="unknown",
        source_shape="iframe",
        resolution_status="unsupported",
        source_url=None,
        canonical_source_url=None,
        provider_target_ref=None,
        title=None,
        authored_text=None,
        placeholder_text=f"Unsupported embedded content: {parsed.hostname or 'unknown provider'}",
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
        text = normalize_whitespace(" ".join(element.itertext()))[:500] or None
        return _embed(
            ordinal,
            provider="x",
            embed_kind="post",
            source_shape="blockquote",
            resolution_status="pending",
            source_url=identity.canonical_url,
            canonical_source_url=identity.canonical_url,
            provider_target_ref=identity.provider_id,
            title="Embedded X post",
            authored_text=text,
            placeholder_text=f"Embedded X post: {text[:120] if text else 'X post'}",
        )
    return None


def _is_x_blockquote(element: HtmlElement) -> bool:
    class_name = element.get("class") or ""
    return "twitter-tweet" in class_name.split()


def _embed(
    ordinal: int,
    *,
    provider: str,
    embed_kind: str,
    source_shape: str,
    resolution_status: str,
    source_url: str | None,
    canonical_source_url: str | None,
    provider_target_ref: str | None,
    title: str | None,
    authored_text: str | None,
    placeholder_text: str,
    error_code: str | None = None,
    error_message: str | None = None,
) -> DetectedDocumentEmbed:
    return DetectedDocumentEmbed(
        ordinal=ordinal,
        occurrence_key=f"embed:{ordinal:06d}:{provider}:{provider_target_ref or 'none'}",
        provider=provider,
        embed_kind=embed_kind,
        source_shape=source_shape,
        resolution_status=resolution_status,
        source_url=source_url,
        canonical_source_url=canonical_source_url,
        provider_target_ref=provider_target_ref,
        title=title,
        authored_text=authored_text,
        placeholder_text=placeholder_text,
        error_code=error_code,
        error_message=error_message,
    )


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


def _body_inner_html(body: HtmlElement) -> str:
    parts = [body.text or ""]
    parts.extend(
        str(child) if not isinstance(child, HtmlElement) else _element_html(child) for child in body
    )
    return "".join(parts)


def _element_html(element: HtmlElement) -> str:
    value = tostring(element, encoding="unicode", method="html")
    return value if isinstance(value, str) else value.decode()


def _clip(value: str, max_length: int) -> str:
    return value[:max_length].rstrip()
