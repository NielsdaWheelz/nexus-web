"""SSRF-safe RSS feed fetch, parse, pagination and provider merge."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import UTC
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin

import lxml.etree as etree

from nexus.coerce import coerce_positive_int
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.sanitize_html import sanitize_html
from nexus.services.url_normalize import validate_requested_url

from ._normalize import normalize_language_tag, normalize_optional_text, parse_iso_datetime
from .provider import PODCAST_INDEX_EPISODE_PAGE_SIZE

logger = get_logger(__name__)

PODCAST_FEED_PAGINATION_MAX_PAGES = 10
PODCAST_CHAPTER_SOURCE_PODCASTING20 = "rss_podcasting20"
PODCAST_CHAPTER_SOURCE_PODLOVE = "rss_podlove"
_SHOW_NOTES_HTML_MAX_BYTES = 100_000
_SHOW_NOTES_TEXT_MAX_BYTES = 50_000
_MAX_FEED_PAGE_BYTES = 10 * 1024 * 1024
_MAX_CHAPTER_JSON_BYTES = 2 * 1024 * 1024
_ATOM = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_PERSON_NAMESPACES = (
    "namespace-uri()='https://podcastindex.org/namespace/1.0'"
    " or namespace-uri()='https://podcastnamespace.org/podcast/1.0'"
)
_CHAPTERS_20_CONTENT_TYPES = {"application/json+chapters", "application/json", "text/json"}
_CHAPTER_TIMESTAMP = re.compile(
    r"^(?:(?P<hours>\d+):)?(?P<minutes>[0-5]?\d):(?P<seconds>[0-5]?\d(?:\.\d+)?)$"
)
_ENRICHMENT_FIELDS = "rss_chapters rss_transcript_url authors description_html \
description_text language feed_language".split()


@dataclass(frozen=True, slots=True)
class FeedBackfillPage:
    """One bounded RSS traversal step and its closed continuation."""

    episodes: tuple[dict[str, Any], ...]
    next_cursor: dict[str, object] | None
    source_limited: bool


@dataclass(frozen=True, slots=True)
class LiveFeedSnapshot:
    episodes: tuple[dict[str, Any], ...]
    source_limited: bool


def fetch_live_feed_snapshot(
    *,
    provider_episode_candidates: list[dict[str, Any]],
    feed_url: str,
) -> LiveFeedSnapshot:
    """Fetch the live RSS page once and merge it into the provider window."""
    normalized_feed_url = normalize_optional_text(feed_url)
    if normalized_feed_url is None or not _is_safe_url(normalized_feed_url):
        raise ApiError(ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE, "Podcast feed URL is unavailable")
    supplemental, next_page_url = _fetch_feed_page(normalized_feed_url, strict=True)

    combined = list(provider_episode_candidates)
    by_match_key: dict[str, dict[str, Any]] = {}
    for episode in combined:
        for field in _ENRICHMENT_FIELDS:
            episode.setdefault(field, None)
        for match_key in _match_keys(episode):
            by_match_key.setdefault(match_key, episode)

    for episode in supplemental:
        existing = next(
            (by_match_key[key] for key in _match_keys(episode) if key in by_match_key), None
        )
        if existing is None:
            combined.append(episode)
            for match_key in _match_keys(episode):
                by_match_key.setdefault(match_key, episode)
            continue
        for field in _ENRICHMENT_FIELDS:
            if not existing.get(field):
                existing[field] = episode.get(field)

    return LiveFeedSnapshot(
        episodes=tuple(combined),
        source_limited=(
            len(provider_episode_candidates) >= PODCAST_INDEX_EPISODE_PAGE_SIZE
            or next_page_url is not None
        ),
    )


def fetch_feed_backfill_page(*, page_url: str, visited: tuple[str, ...]) -> FeedBackfillPage:
    """Fetch one RSS page without reading an absent continuation as history."""
    if _traversal_exhausted(page_url, visited):
        return FeedBackfillPage((), None, True)
    episodes, next_page_url = _fetch_feed_page(page_url, strict=False)
    next_visited = (*visited, page_url)
    if next_page_url is None:
        return FeedBackfillPage(tuple(episodes), None, False)
    if _traversal_exhausted(next_page_url, next_visited):
        return FeedBackfillPage(tuple(episodes), None, True)
    return FeedBackfillPage(
        tuple(episodes),
        {"kind": "RssPage", "url": next_page_url, "visited": list(next_visited)},
        False,
    )


def _traversal_exhausted(page_url: str, visited: tuple[str, ...]) -> bool:
    return (
        not page_url
        or not _is_safe_url(page_url)
        or page_url in visited
        or len(visited) >= PODCAST_FEED_PAGINATION_MAX_PAGES
    )


def _is_safe_url(page_url: str) -> bool:
    try:
        validate_requested_url(page_url)
    except InvalidRequestError as exc:
        logger.warning("podcast_feed_url_rejected", page_url=page_url, reason=exc.message)
        return False
    return True


def _fetch_feed_page(page_url: str, *, strict: bool) -> tuple[list[dict[str, Any]], str | None]:
    """Fetch and parse one feed page; a strict caller surfaces the failure."""
    try:
        result = safe_get(page_url, max_bytes=_MAX_FEED_PAGE_BYTES, timeout_s=15.0)
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=not strict)
        root = etree.fromstring(result.content, parser=parser)
    except (ApiError, etree.XMLSyntaxError) as exc:
        if strict:
            raise ApiError(
                ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE, "Podcast feed is unavailable"
            ) from exc
        logger.warning("podcast_feed_page_failed", page_url=page_url, error=str(exc))
        return [], None

    base_url = result.final_url
    item_nodes = root.xpath("./channel/item") or root.xpath(".//atom:entry", namespaces=_ATOM)
    feed_language = normalize_language_tag(root.xpath("string(./channel/language)"))
    return (
        [_episode_from_item(item, base_url, feed_language) for item in item_nodes],
        _next_page_url(root, base_url),
    )


def _episode_from_item(item: Any, base_url: str, feed_language: str | None) -> dict[str, Any]:
    description_html, description_text = _show_notes(item, base_url)
    return {
        "podcast_index_episode_ref": None,
        "guid": normalize_optional_text(item.xpath("string(./guid)") or item.xpath("string(./id)")),
        "title": str(item.xpath("string(./title)")).strip() or "Untitled Episode",
        "authors": _authors(item) or None,
        "audio_url": (
            str(item.xpath("string(./enclosure/@url)")).strip()
            or str(item.xpath("string(./link[@rel='enclosure']/@href)")).strip()
            or str(item.xpath("string(./link)")).strip()
            or str(item.xpath("string(./link/@href)")).strip()
        ),
        "published_at": _published_at(
            item.xpath("string(./pubDate)")
            or item.xpath("string(./published)")
            or item.xpath("string(./updated)")
        ),
        "duration_seconds": _duration_seconds(
            item.xpath(f"string(*[local-name()='duration' and namespace-uri()='{_ITUNES}'])")
            or item.xpath("string(./duration)")
        ),
        "description_html": description_html,
        "description_text": description_text,
        "rss_chapters": _chapters(item, base_url),
        "rss_transcript_url": _transcript_url(item, base_url),
        "language": normalize_language_tag(item.xpath("string(./language)")) or feed_language,
        "feed_language": feed_language,
    }


def _authors(item: Any) -> list[str]:
    candidates = [
        str(getattr(node, "text", "") or "")
        for node in item.xpath(f"./*[local-name()='person' and ({_PERSON_NAMESPACES})]")
    ]
    if not any(candidate.strip() for candidate in candidates):
        raw_author = (
            item.xpath("string(./author)")
            or item.xpath(f"string(./*[local-name()='author' and namespace-uri()='{_ITUNES}'])")
            or item.xpath("string(./*[local-name()='creator'])")
        )
        candidates = re.split(r"\s*[,;]\s*|\s+and\s+", str(raw_author or "").strip())
    names: list[str] = []
    for candidate in candidates:
        name = candidate.strip()
        if name and name not in names:
            names.append(name)
    return names


def _show_notes(item: Any, base_url: str) -> tuple[str | None, str | None]:
    raw_show_notes = (
        str(item.xpath("string(./*[local-name()='encoded'])") or "").strip()
        or str(item.xpath("string(./description)") or "").strip()
    )
    if not raw_show_notes:
        return None, None
    try:
        sanitized_html = sanitize_html(raw_show_notes, base_url)
    except ValueError:
        sanitized_html = ""
    html = _truncate_utf8(normalize_optional_text(sanitized_html), _SHOW_NOTES_HTML_MAX_BYTES)
    text = _truncate_utf8(
        normalize_optional_text(_plain_text(html or raw_show_notes)), _SHOW_NOTES_TEXT_MAX_BYTES
    )
    return html, text


def _plain_text(raw_value: str) -> str:
    try:
        parser = etree.HTMLParser(no_network=True, recover=True)
        root = etree.fromstring(f"<div>{raw_value}</div>".encode(), parser=parser)
        tokens = [str(token).strip() for token in root.xpath("//text()")]
        return re.sub(r"\s+", " ", " ".join(token for token in tokens if token)).strip()
    except etree.XMLSyntaxError:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw_value)).strip()


def _truncate_utf8(value: str | None, max_bytes: int) -> str | None:
    if value is None:
        return None
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _chapters(item: Any, base_url: str) -> list[dict[str, Any]] | None:
    chapter_tags = item.xpath("./*[local-name()='chapters' and @url]")
    if not chapter_tags:
        return _chapter_rows(
            [
                dict(node.attrib)
                for node in item.xpath(".//*[local-name()='chapters']/*[local-name()='chapter']")
            ],
            source=PODCAST_CHAPTER_SOURCE_PODLOVE,
            base_url=base_url,
        )
    chapter_type = str(chapter_tags[0].attrib.get("type") or "").strip().lower()
    chapters_url = _resolve_link(chapter_tags[0].attrib.get("url"), base_url)
    if chapters_url is None or (chapter_type and chapter_type not in _CHAPTERS_20_CONTENT_TYPES):
        return None
    try:
        payload = json.loads(
            safe_get(chapters_url, max_bytes=_MAX_CHAPTER_JSON_BYTES, timeout_s=15.0).text
        )
    except (ApiError, ValueError) as exc:
        logger.warning("podcast_chapters_json_failed", chapters_url=chapters_url, error=str(exc))
        return None
    entries = payload.get("chapters") if isinstance(payload, dict) else payload
    return _chapter_rows(
        [entry for entry in entries or [] if isinstance(entry, dict)],
        source=PODCAST_CHAPTER_SOURCE_PODCASTING20,
        base_url=chapters_url,
    )


def _chapter_rows(
    entries: list[dict[str, Any]], *, source: str, base_url: str
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for entry in entries:
        title = str(entry.get("title") or "").strip()
        t_start_ms = _chapter_timestamp_ms(_first(entry, "startTime", "start_time", "start"))
        if not title or t_start_ms is None:
            continue
        t_end_ms = _chapter_timestamp_ms(_first(entry, "endTime", "end_time", "end"))
        rows.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": None if t_end_ms is None or t_end_ms < t_start_ms else t_end_ms,
                "url": _resolve_link(_first(entry, "url", "href"), base_url),
                "image_url": _resolve_link(_first(entry, "img", "image", "image_url"), base_url),
                "source": source,
            }
        )
    rows.sort(key=lambda row: row["t_start_ms"])
    return rows


def _first(entry: dict[str, Any], *names: str) -> Any:
    return next((entry[name] for name in names if entry.get(name) is not None), None)


def _resolve_link(raw_url: Any, base_url: str) -> str | None:
    normalized = normalize_optional_text(raw_url)
    if normalized is None:
        return None
    resolved = urljoin(base_url, normalized)
    try:
        validate_requested_url(resolved)
    except InvalidRequestError:
        return None
    return resolved


def _chapter_timestamp_ms(raw_value: Any) -> int | None:
    if isinstance(raw_value, (int, float)):
        return None if raw_value < 0 else int(math.floor(float(raw_value) * 1000.0))
    raw_text = normalize_optional_text(raw_value)
    if raw_text is None:
        return None
    try:
        return max(0, int(math.floor(float(raw_text) * 1000.0)))
    except ValueError:
        pass
    match = _CHAPTER_TIMESTAMP.match(raw_text)
    if match is None:
        return None
    hours, minutes, seconds = (
        match.group("hours") or "0",
        match.group("minutes"),
        match.group("seconds"),
    )
    return int(math.floor((int(hours) * 3600.0 + int(minutes) * 60.0 + float(seconds)) * 1000.0))


def _transcript_url(item: Any, base_url: str) -> str | None:
    for node in item.xpath("./*[local-name()='transcript' and @url]"):
        resolved = _resolve_link(node.attrib.get("url"), base_url)
        if resolved is not None:
            return resolved
    return None


def _next_page_url(root: Any, base_url: str) -> str | None:
    for expression in (
        "string(./channel/atom:link[@rel='next'][1]/@href)",
        "string(./atom:link[@rel='next'][1]/@href)",
        "string(.//*[local-name()='link' and @rel='next'][1]/@href)",
    ):
        href = str(root.xpath(expression, namespaces=_ATOM)).strip()
        if href:
            return urljoin(base_url, href)
    return None


def _published_at(raw_value: Any) -> str | None:
    raw_text = normalize_optional_text(raw_value)
    if raw_text is None:
        return None
    try:
        parsed = parsedate_to_datetime(raw_text)
    except (TypeError, ValueError):
        parsed = parse_iso_datetime(raw_text)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _duration_seconds(raw_value: Any) -> int | None:
    raw_text = normalize_optional_text(raw_value)
    if raw_text is None:
        return None
    if ":" not in raw_text:
        return coerce_positive_int(raw_text)
    try:
        values = [int(part) for part in raw_text.split(":")]
    except ValueError:
        return None
    if len(values) not in (2, 3) or any(value < 0 for value in values):
        return None
    hours, minutes, seconds = [0, *values] if len(values) == 2 else values
    return hours * 3600 + minutes * 60 + seconds


def _match_keys(episode: dict[str, Any]) -> list[str]:
    guid = normalize_optional_text(episode.get("guid"))
    audio_url = normalize_optional_text(episode.get("audio_url"))
    provider_ref = normalize_optional_text(episode.get("podcast_index_episode_ref"))
    return [
        key
        for key in (
            f"guid:{guid.lower()}" if guid else None,
            f"audio:{audio_url.lower()}" if audio_url else None,
            f"podcast_index:{provider_ref}" if provider_ref else None,
        )
        if key is not None
    ]
