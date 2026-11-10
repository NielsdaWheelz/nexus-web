"""RSS/Atom episode observations and safe page fetching.

Feed-controlled urls are fetched only through ``safe_get``. One fetch returns RSS or
namespace-aware Atom observations and all feed-level next/archive edges. Chapter
sidecars, enclosures and transcripts are never fetched here.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from html import escape
from typing import Any, Literal
from urllib.parse import urljoin

import lxml.etree as etree

from nexus.coerce import coerce_int
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.podcasts.chapters import parse_rows
from nexus.services.sanitize_html import sanitize_html
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_MAX_PAGE_BYTES = 10 * 1024 * 1024
_NOTES_HTML_BYTES = 100_000
_NOTES_TEXT_BYTES = 50_000
_ATOM = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_PERSON = (
    "namespace-uri()='https://podcastindex.org/namespace/1.0'"
    " or namespace-uri()='https://podcastnamespace.org/podcast/1.0'"
)
_CHAPTER_TYPES = {"application/json+chapters", "application/json", "text/json"}


@dataclass(slots=True)
class EpisodeFacts:
    """One observed episode. None (and an empty author list) mean "not observed"."""

    title: str
    audio_url: str | None
    entry_url: str | None = None
    provider_ref: str | None = None
    guid: str | None = None
    published_at: datetime | None = None  # aware, UTC
    published_on: date | None = None
    publisher_updated_at: datetime | None = None
    duration_seconds: int | None = None
    authors: list[str] = field(default_factory=list)
    description_html: str | None = None
    description_text: str | None = None
    transcript_url: str | None = None
    chapters: list[dict[str, Any]] | None = None  # None: no inline observation
    chapters_source_url: str | None = None
    language: str | None = None  # the item's language, else the feed's


@dataclass(slots=True)
class ArticleFacts:
    title: str
    entry_url: str | None
    guid: str | None
    published_at: datetime | None
    published_on: date | None
    publisher_updated_at: datetime | None
    body_html: str | None
    body_kind: Literal["content", "summary", "none"]
    base_url: str
    authors: list[str] = field(default_factory=list)
    language: str | None = None


type EntryFacts = EpisodeFacts | ArticleFacts


@dataclass(frozen=True, slots=True)
class FeedPage:
    entries: Sequence[EntryFacts]
    requested_url: str
    final_url: str
    linked_urls: list[str]
    title: str
    website_url: str | None
    image_url: str | None
    description: str | None
    kind: Literal["podcast", "article"] | None


@dataclass(frozen=True, slots=True)
class FeedLinks:
    requested_url: str
    choices: list[tuple[str, str]]


@dataclass(frozen=True, slots=True)
class BlockedFeedPage:
    """The requested page or one of its redirects violates the URL policy."""

    requested_url: str


class FeedPageRejected(ApiError):
    """The publisher returned a source this feed reader cannot use."""

    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_FEED_UNAVAILABLE, "Feed cannot be read")


def fetch_page(
    url: str, *, kind: Literal["podcast", "article"] | None = None
) -> FeedPage | BlockedFeedPage | FeedLinks:
    """Fetch one page. Policy rejection is a coverage gap; other fetch/parse failures retry."""
    try:
        validate_requested_url(url)
        result = safe_get(url, max_bytes=_MAX_PAGE_BYTES, timeout_s=60.0)
    except InvalidRequestError:
        return BlockedFeedPage(url)
    except ApiError as exc:
        if exc.code == ApiErrorCode.E_SSRF_BLOCKED:
            return BlockedFeedPage(url)
        if exc.code in (
            ApiErrorCode.E_SOURCE_GONE,
            ApiErrorCode.E_SOURCE_ACCESS_DENIED,
            ApiErrorCode.E_SOURCE_TOO_LARGE,
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            ApiErrorCode.E_SOURCE_NOT_READABLE,
        ):
            raise FeedPageRejected() from exc
        if exc.code not in (ApiErrorCode.E_INGEST_TIMEOUT, ApiErrorCode.E_SOURCE_FETCH_FAILED):
            raise
        logger.warning("feed_page_failed", error_code=exc.code.value)
        raise ApiError(
            ApiErrorCode.E_FEED_UNAVAILABLE,
            "Feed is unavailable",
            retry_at=exc.retry_at,
        ) from exc
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        root = etree.fromstring(result.content, parser=parser, base_url=result.final_url)
    except etree.XMLSyntaxError:
        root = etree.HTML(result.content, base_url=result.final_url)
        if root is None:
            raise FeedPageRejected() from None
    base = result.final_url
    if root.tag == "rss" and root.find("channel") is not None:
        items = root.xpath("./channel/item")
        language = _language(root.xpath("string(./channel/language)"))
    elif root.tag == "{http://www.w3.org/2005/Atom}feed":
        items = root.xpath("./atom:entry", namespaces=_ATOM)
        language = _language(root.get("{http://www.w3.org/XML/1998/namespace}lang"))
    else:
        document = etree.HTML(result.content, base_url=base)
        if document is None:
            raise FeedPageRejected()
        choices = list(
            dict.fromkeys(
                (str(node.get("title") or "feed"), urljoin(node.base or base, node.get("href")))
                for node in document.xpath("//link[@href]")
                if "alternate" in str(node.get("rel") or "").lower().split()
                and str(node.get("type") or "").lower()
                in ("application/rss+xml", "application/atom+xml")
            )
        )
        if not choices:
            raise FeedPageRejected()
        return FeedLinks(url, choices)
    links = [
        urljoin(node.base or base, node.get("href"))
        for node in root.xpath(
            "./channel/atom:link[@rel='next' or @rel='prev-archive']"
            " | ./atom:link[@rel='next' or @rel='prev-archive']",
            namespaces=_ATOM,
        )
        if node.get("href")
    ]
    article_entries = None
    if kind is None:
        enclosure_types = [
            [
                str(node.get("type") or "").split(";", 1)[0].strip().lower()
                for node in item.xpath(
                    "./enclosure | ./atom:link[@rel='enclosure']", namespaces=_ATOM
                )
            ]
            for item in items
        ]
        audio = [any(value.startswith("audio/") for value in types) for types in enclosure_types]
        opaque = any(
            not value.startswith(("audio/", "image/", "video/", "text/"))
            for types in enclosure_types
            for value in types
        )
        declared = bool(root.xpath(".//*[namespace-uri()=$namespace]", namespace=_ITUNES))
        if declared or audio and all(audio):
            kind = "podcast"
        elif items and not any(audio) and not opaque:
            article_entries = [_article(item, item.base or base, language) for item in items]
            if all(
                (entry.entry_url and is_safe_url(entry.entry_url))
                or (entry.body_html and entry.body_html.strip())
                for entry in article_entries
            ):
                kind = "article"
    title = str(
        root.xpath("string(./channel/title)")
        or root.xpath("string(./atom:title)", namespaces=_ATOM)
    ).strip()
    website = str(
        root.xpath("string(./channel/link)")
        or root.xpath("string(./atom:link[@rel='alternate']/@href)", namespaces=_ATOM)
    ).strip()
    image_url = str(
        root.xpath("string(./channel/image/url)")
        or root.xpath("string(./atom:logo)", namespaces=_ATOM)
    ).strip()
    description = str(
        root.xpath("string(./channel/description)")
        or root.xpath("string(./atom:subtitle)", namespaces=_ATOM)
    ).strip()
    return FeedPage(
        article_entries
        if article_entries is not None
        else [
            _episode(item, item.base or base, language)
            if kind == "podcast"
            else _article(item, item.base or base, language)
            for item in items
        ],
        url,
        base,
        links,
        title or "untitled source",
        urljoin(base, website) if website and is_safe_url(urljoin(base, website)) else None,
        urljoin(base, image_url) if image_url and is_safe_url(urljoin(base, image_url)) else None,
        description or None,
        kind,
    )


def is_safe_url(url: str | None) -> bool:
    try:
        validate_requested_url(url or "")
    except InvalidRequestError:
        return False
    return True


def text_or_none(value: Any) -> str | None:
    return (str(value).strip() if value is not None else "") or None


def parse_datetime(raw: Any) -> datetime | None:
    """An epoch number, an RFC 2822 date or an ISO 8601 instant, in UTC."""
    if isinstance(raw, int | float) and not isinstance(raw, bool):
        try:
            return datetime.fromtimestamp(raw, UTC) if raw > 0 else None
        except (ValueError, OverflowError, OSError):
            return None
    value = text_or_none(raw)
    if value is None:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return parsed.astimezone(UTC) if parsed.tzinfo is not None else None


def _language(value: Any) -> str | None:
    tag = text_or_none(value)
    return tag.lower().replace("_", "-") if tag else None


def _episode(item: Any, base: str, feed_language: str | None) -> EpisodeFacts:
    html, plain = _show_notes(item, base)
    inline, sidecar = _chapters(item, base)
    atom = item.tag == "{http://www.w3.org/2005/Atom}entry"
    enclosures = item.xpath(
        "./atom:link[@rel='enclosure']" if atom else "./enclosure", namespaces=_ATOM
    )
    enclosure = next(
        (
            node
            for node in enclosures
            if str(node.get("type") or "").split(";", 1)[0].strip().lower().startswith("audio/")
        ),
        None,
    )
    if enclosure is None:
        enclosure = next(
            (
                node
                for node in enclosures
                if str(node.get("type") or "").split(";", 1)[0].strip().lower()
                in ("", "application/octet-stream", "binary/octet-stream")
            ),
            None,
        )
    audio = (
        text_or_none(enclosure.get("href" if atom else "url")) if enclosure is not None else None
    )
    links = item.xpath(
        "./atom:link[not(@rel) or @rel='alternate']" if atom else "./link", namespaces=_ATOM
    )
    link = links[0] if links else None
    return EpisodeFacts(
        title=str(
            item.xpath("string(./atom:title)" if atom else "string(./title)", namespaces=_ATOM)
        ).strip()
        or "Untitled Episode",
        audio_url=urljoin(enclosure.base or base, audio)
        if audio and enclosure is not None
        else None,
        entry_url=_link(link.get("href") if atom else link.text, link.base or base)
        if link is not None
        else None,
        guid=text_or_none(
            item.xpath("string(./atom:id)" if atom else "string(./guid)", namespaces=_ATOM)
        ),
        published_at=_publication(item, atom)[0],
        published_on=_publication(item, atom)[1],
        publisher_updated_at=parse_datetime(item.xpath("string(./atom:updated)", namespaces=_ATOM)),
        duration_seconds=_duration(
            item.xpath(f"string(*[local-name()='duration' and namespace-uri()='{_ITUNES}'])")
            or item.xpath("string(./duration)")
        ),
        authors=_authors(item),
        description_html=html,
        description_text=plain,
        transcript_url=next(
            (
                url
                for node in item.xpath("./*[local-name()='transcript' and @url]")
                if (url := _link(node.attrib.get("url"), node.base or base))
            ),
            None,
        ),
        chapters=inline,
        chapters_source_url=sidecar,
        language=_language(item.get("{http://www.w3.org/XML/1998/namespace}lang"))
        or _language(item.xpath("string(./language)"))
        or feed_language,
    )


def _authors(item: Any) -> list[str]:
    names = [
        str(node.text or "") for node in item.xpath(f"./*[local-name()='person' and ({_PERSON})]")
    ]
    if not any(name.strip() for name in names):
        raw = (
            item.xpath("string(./atom:author/atom:name)", namespaces=_ATOM)
            or item.xpath("string(./author)")
            or item.xpath(f"string(./*[local-name()='author' and namespace-uri()='{_ITUNES}'])")
            or item.xpath("string(./*[local-name()='creator'])")
        )
        names = re.split(r"\s*[,;]\s*|\s+and\s+", str(raw or "").strip())
    return list(dict.fromkeys(name.strip() for name in names if name.strip()))


def _show_notes(item: Any, base: str) -> tuple[str | None, str | None]:
    """Sanitized html and plain text, each capped; the text falls back to the raw markup."""
    raw = (
        str(item.xpath("string(./*[local-name()='encoded'])") or "").strip()
        or str(item.xpath("string(./description)") or "").strip()
        or str(item.xpath("string(./atom:content)", namespaces=_ATOM) or "").strip()
        or str(item.xpath("string(./atom:summary)", namespaces=_ATOM) or "").strip()
    )
    if not raw:
        return None, None
    try:
        html = _clip(text_or_none(sanitize_html(raw, base, document_url=None)), _NOTES_HTML_BYTES)
    except ValueError:
        html = None
    return html, _clip(text_or_none(_plain_text(html or raw)), _NOTES_TEXT_BYTES)


def _plain_text(markup: str) -> str:
    try:
        parser = etree.HTMLParser(no_network=True, recover=True)
        root = etree.fromstring(f"<div>{markup}</div>".encode(), parser=parser)
        return re.sub(r"\s+", " ", " ".join(str(token) for token in root.xpath("//text()")))
    except etree.XMLSyntaxError:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", markup))


def _clip(value: str | None, max_bytes: int) -> str | None:
    if value is None or len(value.encode()) <= max_bytes:
        return value
    return value.encode()[:max_bytes].decode(errors="ignore")


def _chapters(item: Any, base: str) -> tuple[list[dict[str, Any]] | None, str | None]:
    """An inline observation or desired sidecar url; parsing never fetches sidecars."""
    inline = item.xpath(
        "./*[local-name()='chapters' and namespace-uri()='http://podlove.org/simple-chapters']"
    )
    if inline:
        rows = [
            dict(node.attrib)
            for node in inline[0].xpath(
                "./*[local-name()='chapter' and namespace-uri()='http://podlove.org/simple-chapters']"
            )
        ]
        return parse_rows(rows, source="rss_podlove", base=base), None
    tags = item.xpath(f"./*[local-name()='chapters' and ({_PERSON}) and @url]")
    if tags:
        kind = str(tags[0].get("type") or "").strip().lower()
        if not kind or kind in _CHAPTER_TYPES:
            return None, _link(tags[0].get("url"), tags[0].base or base)
    return None, None


def _link(raw: Any, base: str) -> str | None:
    value = text_or_none(raw)
    url = urljoin(base, value) if value else None
    return url if url and is_safe_url(url) else None


def _duration(raw: Any) -> int | None:
    value = text_or_none(raw)
    if value is None or ":" not in value:
        seconds = coerce_int(value, minimum=1)
        return seconds if seconds is not None and seconds <= 2_147_483_647 else None
    try:
        parts = [int(part) for part in value.split(":")]
    except ValueError:
        return None
    if len(parts) not in (2, 3) or min(parts) < 0:
        return None
    hours, minutes, seconds = [0, *parts] if len(parts) == 2 else parts
    total = hours * 3600 + minutes * 60 + seconds
    return total if 0 < total <= 2_147_483_647 else None


def _publication(item: Any, atom: bool) -> tuple[datetime | None, date | None]:
    raw = str(
        item.xpath("string(./atom:published)" if atom else "string(./pubDate)", namespaces=_ATOM)
    ).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        try:
            return None, date.fromisoformat(raw)
        except ValueError:
            return None, None
    return parse_datetime(raw), None


def _article(item: Any, base: str, language: str | None) -> ArticleFacts:
    atom = item.tag == "{http://www.w3.org/2005/Atom}entry"
    title = str(
        item.xpath("string(./atom:title)" if atom else "string(./title)", namespaces=_ATOM)
    ).strip()
    url = str(
        item.xpath(
            "string(./atom:link[not(@rel) or @rel='alternate']/@href)"
            if atom
            else "string(./link)",
            namespaces=_ATOM,
        )
    ).strip()
    content = item.xpath(
        "./atom:content" if atom else "./*[local-name()='encoded']", namespaces=_ATOM
    )
    summary = item.xpath("./atom:summary" if atom else "./description", namespaces=_ATOM)
    nodes = content or summary
    body_kind: Literal["content", "summary", "none"] = (
        "content" if content else "summary" if summary else "none"
    )
    body = None
    if nodes:
        node = nodes[0]
        if atom and node.get("type", "text") == "xhtml":
            body = "".join(etree.tostring(child, encoding="unicode") for child in node)
        else:
            body = str(node.text or "")
            if atom and node.get("type", "text") == "text":
                body = f"<p>{escape(body)}</p>"
    published_at, published_on = _publication(item, atom)
    return ArticleFacts(
        title=title or (urljoin(base, url) if url else "untitled article"),
        entry_url=urljoin(base, url) if url else None,
        guid=text_or_none(
            item.xpath("string(./atom:id)" if atom else "string(./guid)", namespaces=_ATOM)
        ),
        published_at=published_at,
        published_on=published_on,
        publisher_updated_at=parse_datetime(item.xpath("string(./atom:updated)", namespaces=_ATOM)),
        body_html=body or None,
        body_kind=body_kind if body else "none",
        base_url=base,
        authors=_authors(item),
        language=language,
    )
