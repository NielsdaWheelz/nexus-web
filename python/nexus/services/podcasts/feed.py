"""RSS: the observed-episode value, one strict page fetch and parse, the provider merge.

Feed-controlled urls are fetched only through ``safe_get``; this module never fetches an
enclosure or a transcript. Chapter end absence is observed explicitly. Supplied invalid
ends reject the feed observation before persistence, rather than becoming derived scope.
"""

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin

import lxml.etree as etree

from nexus.coerce import coerce_int
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.sanitize_html import sanitize_html
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

logger = get_logger(__name__)

_MAX_PAGE_BYTES = 10 * 1024 * 1024
_MAX_CHAPTERS_BYTES = 2 * 1024 * 1024
_NOTES_HTML_BYTES = 100_000
_NOTES_TEXT_BYTES = 50_000
_ATOM = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_PERSON = (
    "namespace-uri()='https://podcastindex.org/namespace/1.0'"
    " or namespace-uri()='https://podcastnamespace.org/podcast/1.0'"
)
_CHAPTER_TYPES = {"application/json+chapters", "application/json", "text/json"}
_CLOCK = re.compile(r"^(?:(?P<h>\d+):)?(?P<m>[0-5]?\d):(?P<s>[0-5]?\d(?:\.\d+)?)$")
# What an rss item adds to a provider item that lacks it.
_ENRICHED = (
    "guid",
    "provider_ref",
    "authors",
    "description_html",
    "description_text",
    "transcript_url",
    "chapters",
)


@dataclass(slots=True)
class EpisodeFacts:
    """One observed episode. None (and an empty author list) mean "not observed"."""

    title: str
    audio_url: str | None
    provider_ref: str | None = None
    guid: str | None = None
    published_at: datetime | None = None  # aware, UTC
    duration_seconds: int | None = None
    authors: list[str] = field(default_factory=list)
    description_html: str | None = None
    description_text: str | None = None
    transcript_url: str | None = None
    chapters: list[dict[str, Any]] | None = None  # None: the feed said nothing
    language: str | None = None  # the item's language, else the feed's


@dataclass(frozen=True, slots=True)
class FeedPage:
    episodes: list[EpisodeFacts]
    next_url: str | None


def fetch_page(url: str) -> FeedPage:
    """Fetch and parse one feed page; an unsafe url, a failed fetch or xml that does not
    parse is E_PODCAST_FEED_UNAVAILABLE."""
    try:
        validate_requested_url(url)
        result = safe_get(url, max_bytes=_MAX_PAGE_BYTES, timeout_s=60.0)
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        root = etree.fromstring(result.content, parser=parser)
    except (ApiError, etree.XMLSyntaxError) as exc:
        logger.warning("podcast_feed_page_failed", url=url, error=str(exc))
        raise ApiError(
            ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE, "Podcast feed is unavailable"
        ) from exc
    base = result.final_url
    items = root.xpath("./channel/item") or root.xpath(".//atom:entry", namespaces=_ATOM)
    language = _language(root.xpath("string(./channel/language)"))
    return FeedPage([_episode(item, base, language) for item in items], _next_url(root, base))


def is_safe_url(url: str | None) -> bool:
    try:
        validate_requested_url(url or "")
    except InvalidRequestError:
        return False
    return True


def merge(window: list[EpisodeFacts], page: list[EpisodeFacts]) -> list[EpisodeFacts]:
    """Enrich a unique compatible identity match; preserve ambiguous observations for
    ingest to reject instead of silently discarding their source aliases."""
    merged = list(window)
    owners: dict[str, EpisodeFacts] = {}
    for episode in window:
        for key in _match_keys(episode):
            owners.setdefault(key, episode)
    for episode in page:
        matches = {id(owners[key]): owners[key] for key in _match_keys(episode) if key in owners}
        owner = next(iter(matches.values())) if len(matches) == 1 else None
        if owner is not None and not _compatible_identity(owner, episode):
            owner = None
        if owner is None:
            merged.append(episode)
            for key in _match_keys(episode):
                owners.setdefault(key, episode)
            continue
        for name in _ENRICHED:
            if not getattr(owner, name):
                setattr(owner, name, getattr(episode, name))
        if not is_safe_url(owner.audio_url):
            owner.audio_url = episode.audio_url if is_safe_url(episode.audio_url) else None
        owner.language = owner.language or episode.language
        for key in _match_keys(owner):
            owners.setdefault(key, owner)
    return merged


def _compatible_identity(left: EpisodeFacts, right: EpisodeFacts) -> bool:
    if any(
        getattr(left, name) and getattr(right, name) and getattr(left, name) != getattr(right, name)
        for name in ("guid", "provider_ref")
    ):
        return False
    return not (
        left.audio_url
        and right.audio_url
        and is_safe_url(left.audio_url)
        and is_safe_url(right.audio_url)
        and normalize_url_for_display(left.audio_url) != normalize_url_for_display(right.audio_url)
    )


def _match_keys(episode: EpisodeFacts) -> list[str]:
    keys = [
        f"guid:{episode.guid.lower()}" if episode.guid else None,
        f"audio:{episode.audio_url.lower()}"
        if episode.audio_url and is_safe_url(episode.audio_url)
        else None,
        f"podcast_index:{episode.provider_ref}" if episode.provider_ref else None,
    ]
    return [key for key in keys if key is not None]


def text_or_none(value: Any) -> str | None:
    return (str(value).strip() if value is not None else "") or None


def parse_datetime(raw: Any) -> datetime | None:
    """An epoch number, an RFC 2822 date or an ISO 8601 instant, in UTC."""
    if isinstance(raw, int | float) and not isinstance(raw, bool):
        return datetime.fromtimestamp(raw, UTC) if raw > 0 else None
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
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)


def _language(value: Any) -> str | None:
    tag = text_or_none(value)
    return tag.lower().replace("_", "-") if tag else None


def _episode(item: Any, base: str, feed_language: str | None) -> EpisodeFacts:
    html, plain = _show_notes(item, base)
    return EpisodeFacts(
        title=str(item.xpath("string(./title)")).strip() or "Untitled Episode",
        audio_url=text_or_none(
            item.xpath("string(./enclosure/@url)")
            or item.xpath("string(./link[@rel='enclosure']/@href)")
            or item.xpath("string(./link)")
            or item.xpath("string(./link/@href)")
        ),
        guid=text_or_none(item.xpath("string(./guid)") or item.xpath("string(./id)")),
        published_at=parse_datetime(
            item.xpath("string(./pubDate)")
            or item.xpath("string(./published)")
            or item.xpath("string(./updated)")
        ),
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
                if (url := _link(node.attrib.get("url"), base))
            ),
            None,
        ),
        chapters=_chapters(item, base),
        language=_language(item.xpath("string(./language)")) or feed_language,
    )


def _authors(item: Any) -> list[str]:
    names = [
        str(node.text or "") for node in item.xpath(f"./*[local-name()='person' and ({_PERSON})]")
    ]
    if not any(name.strip() for name in names):
        raw = (
            item.xpath("string(./author)")
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


def _chapters(item: Any, base: str) -> list[dict[str, Any]] | None:
    """Podcasting 2.0 chapters json (fetched), else inline Podlove chapters; None when the
    json could not be read."""
    tags = item.xpath("./*[local-name()='chapters' and @url]")
    if not tags:
        podlove = item.xpath(".//*[local-name()='chapters']/*[local-name()='chapter']")
        return _chapter_rows([dict(node.attrib) for node in podlove], "rss_podlove", base)
    kind = str(tags[0].attrib.get("type") or "").strip().lower()
    url = _link(tags[0].attrib.get("url"), base)
    if url is None or (kind and kind not in _CHAPTER_TYPES):
        return None
    try:
        payload = json.loads(safe_get(url, max_bytes=_MAX_CHAPTERS_BYTES, timeout_s=15.0).text)
    except (ApiError, ValueError) as exc:
        logger.warning("podcast_chapters_json_failed", url=url, error=str(exc))
        return None
    entries = payload.get("chapters") if isinstance(payload, dict) else payload
    rows = [entry for entry in entries or [] if isinstance(entry, dict)]
    return _chapter_rows(rows, "rss_podcasting20", url)


def _chapter_rows(entries: list[dict[str, Any]], source: str, base: str) -> list[dict[str, Any]]:
    rows = []
    for entry in entries:
        title = str(entry.get("title") or "").strip()
        start = _clock_ms(_first(entry, "startTime", "start_time", "start"))
        if not title or start is None:
            continue
        raw_end = _first(entry, "endTime", "end_time", "end")
        end = _clock_ms(raw_end)
        if raw_end is not None and (end is None or end < start):
            raise ApiError(
                ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE, "Publisher chapter end is invalid"
            )
        rows.append(
            {
                "title": title,
                "t_start_ms": start,
                "t_end_ms": end,
                "end_absence_confirmed": raw_end is None,
                "url": _link(_first(entry, "url", "href"), base),
                "image_url": _link(_first(entry, "img", "image", "image_url"), base),
                "source": source,
            }
        )
    return sorted(rows, key=lambda row: row["t_start_ms"])


def _first(entry: dict[str, Any], *names: str) -> Any:
    return next((entry[name] for name in names if entry.get(name) is not None), None)


def _link(raw: Any, base: str) -> str | None:
    value = text_or_none(raw)
    url = urljoin(base, value) if value else None
    return url if url and is_safe_url(url) else None


def _clock_ms(raw: Any) -> int | None:
    if isinstance(raw, bool):
        return None
    value = text_or_none(raw)
    if value is None:
        return None
    try:
        seconds = Decimal(value)
    except InvalidOperation:
        match = _CLOCK.match(value)
        if match is None:
            return None
        seconds = Decimal(match["h"] or 0) * 3600 + Decimal(match["m"]) * 60 + Decimal(match["s"])
    if not seconds.is_finite() or not 0 <= seconds <= Decimal(2**31 - 1) / 1000:
        return None
    return int(seconds * 1000)


def _duration(raw: Any) -> int | None:
    value = text_or_none(raw)
    if value is None or ":" not in value:
        return coerce_int(value, minimum=1)
    try:
        parts = [int(part) for part in value.split(":")]
    except ValueError:
        return None
    if len(parts) not in (2, 3) or min(parts) < 0:
        return None
    hours, minutes, seconds = [0, *parts] if len(parts) == 2 else parts
    return hours * 3600 + minutes * 60 + seconds


def _next_url(root: Any, base: str) -> str | None:
    for expression in (
        "string(./channel/atom:link[@rel='next'][1]/@href)",
        "string(./atom:link[@rel='next'][1]/@href)",
        "string(.//*[local-name()='link' and @rel='next'][1]/@href)",
    ):
        href = str(root.xpath(expression, namespaces=_ATOM)).strip()
        if href:
            return urljoin(base, href)
    return None
