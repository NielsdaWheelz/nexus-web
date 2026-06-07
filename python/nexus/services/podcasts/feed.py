"""Podcast RSS feed fetch, pagination, and XML parsing."""

from __future__ import annotations

import json
import math
import re
from datetime import UTC
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import lxml.etree as etree

from nexus.coerce import coerce_positive_int
from nexus.config import get_settings, real_media_provider_fixtures_requested
from nexus.errors import (
    ApiError,
    InvalidRequestError,
)
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import safe_get
from nexus.services.sanitize_html import sanitize_html
from nexus.services.url_normalize import validate_requested_url

from ._normalize import (
    normalize_language_tag,
    normalize_optional_text,
    normalize_provider_published_at,
    parse_iso_datetime,
)
from .provider import (
    PODCAST_INDEX_EPISODE_PAGE_SIZE,
)

logger = get_logger(__name__)

PODCAST_FEED_PAGINATION_MAX_PAGES = 10
_ATOM_NAMESPACE = {"atom": "http://www.w3.org/2005/Atom"}
_ITUNES_DURATION_XPATH = (
    "*[local-name()='duration' and namespace-uri()='http://www.itunes.com/dtds/podcast-1.0.dtd']"
)
PODCAST_EPISODE_SHOW_NOTES_HTML_MAX_BYTES = 100_000
PODCAST_EPISODE_SHOW_NOTES_TEXT_MAX_BYTES = 50_000
_MAX_FEED_PAGE_BYTES = 10 * 1024 * 1024
_MAX_CHAPTER_JSON_BYTES = 2 * 1024 * 1024
PODCAST_CHAPTER_SOURCE_PODCASTING20 = "rss_podcasting20"
PODCAST_CHAPTER_SOURCE_PODLOVE = "rss_podlove"
_PODCAST_CHAPTERS_20_CONTENT_TYPES = {
    "application/json+chapters",
    "application/json",
    "text/json",
}
_CHAPTER_TIMESTAMP_PATTERN = re.compile(
    r"^(?:(?P<hours>\d+):)?(?P<minutes>[0-5]?\d):(?P<seconds>[0-5]?\d(?:\.\d+)?)$"
)
_PODCAST_CONTENT_ENCODED_XPATH = "*[local-name()='encoded']"
_ENRICHMENT_NONE_GUARD_FIELDS = ("rss_chapters", "rss_transcript_refs", "authors")
_ENRICHMENT_FALSY_GUARD_FIELDS = (
    "description_html",
    "description_text",
    "language",
    "feed_language",
)


def _fill_episode_enrichment_from(target: dict[str, Any], source: dict[str, Any]) -> None:
    for field in _ENRICHMENT_NONE_GUARD_FIELDS:
        if target.get(field) is None:
            target[field] = source.get(field)
    for field in _ENRICHMENT_FALSY_GUARD_FIELDS:
        if not target.get(field):
            target[field] = source.get(field)


def augment_provider_episodes_with_feed_pagination(
    *,
    provider_episode_candidates: list[dict[str, Any]],
    feed_url: str,
    prefetch_limit: int,
) -> list[dict[str, Any]]:
    if len(provider_episode_candidates) >= prefetch_limit:
        return provider_episode_candidates
    if len(provider_episode_candidates) < PODCAST_INDEX_EPISODE_PAGE_SIZE:
        return provider_episode_candidates

    normalized_feed_url = str(feed_url or "").strip()
    if not normalized_feed_url:
        return provider_episode_candidates

    supplemental = _fetch_feed_episodes_paginated(normalized_feed_url, prefetch_limit)
    if not supplemental:
        return provider_episode_candidates

    combined = list(provider_episode_candidates)
    episode_by_dedupe_key = {_episode_dedupe_key(episode): episode for episode in combined}
    seen = set(episode_by_dedupe_key.keys())
    for episode in supplemental:
        dedupe_key = _episode_dedupe_key(episode)
        if dedupe_key in seen:
            existing = episode_by_dedupe_key.get(dedupe_key)
            if existing is not None:
                _fill_episode_enrichment_from(existing, episode)
            continue
        seen.add(dedupe_key)
        combined.append(episode)
        episode_by_dedupe_key[dedupe_key] = episode
        if len(combined) >= prefetch_limit:
            break

    logger.info(
        "podcast_feed_pagination_augmentation",
        feed_url=normalized_feed_url,
        provider_candidate_count=len(provider_episode_candidates),
        supplemental_count=len(supplemental),
        combined_count=len(combined),
        prefetch_limit=prefetch_limit,
    )
    return combined


def hydrate_selected_episode_chapters_from_feed(
    *,
    selected_episodes: list[dict[str, Any]],
    feed_url: str,
) -> list[dict[str, Any]]:
    if not selected_episodes:
        return selected_episodes

    for episode in selected_episodes:
        for field in (*_ENRICHMENT_NONE_GUARD_FIELDS, *_ENRICHMENT_FALSY_GUARD_FIELDS):
            episode.setdefault(field, None)

    normalized_feed_url = str(feed_url or "").strip()
    if not normalized_feed_url:
        return selected_episodes

    feed_lookup_limit = max(PODCAST_INDEX_EPISODE_PAGE_SIZE, len(selected_episodes) * 4)
    feed_episodes = _fetch_feed_episodes_paginated(normalized_feed_url, feed_lookup_limit)
    if not feed_episodes:
        return selected_episodes

    feed_episode_by_match_key: dict[str, dict[str, Any]] = {}
    for feed_episode in feed_episodes:
        for match_key in _episode_match_keys(feed_episode):
            feed_episode_by_match_key.setdefault(match_key, feed_episode)

    for episode in selected_episodes:
        if (
            episode.get("rss_chapters") is not None
            and episode.get("rss_transcript_refs") is not None
            and episode.get("description_html")
            and episode.get("description_text")
        ):
            continue
        for match_key in _episode_match_keys(episode):
            feed_episode = feed_episode_by_match_key.get(match_key)
            if feed_episode is None:
                continue
            _fill_episode_enrichment_from(episode, feed_episode)
            break

    return selected_episodes


def _is_safe_feed_page_url(page_url: str) -> bool:
    try:
        validate_requested_url(page_url)
        return True
    except InvalidRequestError as exc:
        logger.warning(
            "podcast_feed_page_url_rejected",
            page_url=page_url,
            reason=exc.message,
        )
        return False


def _fetch_feed_episodes_paginated(feed_url: str, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []

    episodes: list[dict[str, Any]] = []
    seen_episode_keys: set[tuple[str, str, str, str]] = set()
    seen_page_urls: set[str] = set()

    next_page_url: str | None = feed_url
    pages_fetched = 0
    while (
        next_page_url
        and len(episodes) < limit
        and pages_fetched < PODCAST_FEED_PAGINATION_MAX_PAGES
    ):
        if not _is_safe_feed_page_url(next_page_url):
            break
        if next_page_url in seen_page_urls:
            break
        seen_page_urls.add(next_page_url)
        page_episodes, upcoming_page_url = _fetch_feed_episode_page(next_page_url)
        pages_fetched += 1

        for episode in page_episodes:
            dedupe_key = _episode_dedupe_key(episode)
            if dedupe_key in seen_episode_keys:
                continue
            seen_episode_keys.add(dedupe_key)
            episodes.append(episode)
            if len(episodes) >= limit:
                break

        if upcoming_page_url and not _is_safe_feed_page_url(upcoming_page_url):
            break
        next_page_url = upcoming_page_url

    if next_page_url and pages_fetched >= PODCAST_FEED_PAGINATION_MAX_PAGES:
        logger.warning(
            "podcast_feed_pagination_page_limit_reached",
            feed_url=feed_url,
            pages_fetched=pages_fetched,
            prefetch_limit=limit,
        )

    return episodes


def _fetch_feed_episode_page(page_url: str) -> tuple[list[dict[str, Any]], str | None]:
    if real_media_provider_fixtures_requested():
        settings = get_settings()
        if not settings.real_media_provider_fixtures:
            return [], None
        if page_url != "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/feed/":
            return [], None
        if settings.real_media_fixture_dir is None:
            logger.warning("podcast_feed_fixture_dir_missing", page_url=page_url)
            return [], None
        path = f"{settings.real_media_fixture_dir}/nasa-hwhap-feed.xml"
        try:
            content = Path(path).read_bytes()
        except OSError as exc:
            logger.warning("podcast_feed_fixture_unavailable", page_url=page_url, error=str(exc))
            return [], None
        if len(content) != 1_397:
            logger.warning("podcast_feed_fixture_size_mismatch", page_url=page_url)
            return [], None
        return _parse_feed_episode_page(content, page_url)

    try:
        result = safe_get(page_url, max_bytes=_MAX_FEED_PAGE_BYTES, timeout_s=15.0)
    except ApiError as exc:
        logger.warning("podcast_feed_page_fetch_failed", page_url=page_url, error=exc.message)
        return [], None

    return _parse_feed_episode_page(result.content, result.final_url)


def _parse_feed_episode_page(
    content: bytes, page_url: str
) -> tuple[list[dict[str, Any]], str | None]:
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=True)
        root = etree.fromstring(content, parser=parser)
    except etree.XMLSyntaxError as exc:
        logger.warning("podcast_feed_page_parse_failed", page_url=page_url, error=str(exc))
        return [], None

    item_nodes = root.xpath("./channel/item")
    if not item_nodes:
        item_nodes = root.xpath(".//atom:entry", namespaces=_ATOM_NAMESPACE)

    feed_language = normalize_language_tag(root.xpath("string(./channel/language)"))

    episodes: list[dict[str, Any]] = []
    for item in item_nodes:
        episode = _episode_from_feed_item(
            item,
            base_url=page_url,
            feed_language=feed_language,
        )
        if episode is not None:
            episodes.append(episode)

    next_page_url = _extract_feed_next_page_url(root, page_url)
    return episodes, next_page_url


def _feed_fallback_episode_id(title: str, published_at: str | None) -> str:
    title_part = _feed_identity_slug(title)
    published_part = _feed_identity_slug(published_at)
    return f"feed-title-{title_part}-published-{published_part}"


def _feed_identity_slug(value: object) -> str:
    normalized = " ".join(str(value or "").strip().casefold().split())
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return slug or "missing"


def _episode_from_feed_item(
    item: Any,
    *,
    base_url: str | None = None,
    feed_language: str | None = None,
) -> dict[str, Any] | None:
    title = str(item.xpath("string(./title)")).strip() or "Untitled Episode"
    guid = normalize_optional_text(item.xpath("string(./guid)") or item.xpath("string(./id)"))

    audio_url = str(item.xpath("string(./enclosure/@url)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link[@rel='enclosure']/@href)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link)")).strip()
    if not audio_url:
        audio_url = str(item.xpath("string(./link/@href)")).strip()

    published_raw = (
        item.xpath("string(./pubDate)")
        or item.xpath("string(./published)")
        or item.xpath("string(./updated)")
    )
    published_at = _normalize_feed_published_at(published_raw)

    duration_raw = item.xpath(f"string({_ITUNES_DURATION_XPATH})") or item.xpath(
        "string(./duration)"
    )
    duration_seconds = _parse_feed_duration_seconds(duration_raw)
    description_html, description_text = _extract_episode_show_notes_from_feed_item(
        item,
        base_url=base_url,
    )
    authors: list[str] = []
    person_nodes = item.xpath(
        "./*[local-name()='person' and namespace-uri()='https://podcastindex.org/namespace/1.0']"
    )
    if not person_nodes:
        person_nodes = item.xpath(
            "./*[local-name()='person' and namespace-uri()='https://podcastnamespace.org/podcast/1.0']"
        )
    for person_node in person_nodes:
        name = str(getattr(person_node, "text", "") or "").strip()
        if name and name not in authors:
            authors.append(name)
    if not authors:
        raw_author = (
            item.xpath("string(./author)")
            or item.xpath(
                "string(./*[local-name()='author' and namespace-uri()='http://www.itunes.com/dtds/podcast-1.0.dtd'])"
            )
            or item.xpath("string(./*[local-name()='creator'])")
        )
        for name in re.split(r"\s*[,;]\s*|\s+and\s+", str(raw_author or "").strip()):
            normalized_name = name.strip()
            if normalized_name and normalized_name not in authors:
                authors.append(normalized_name)

    provider_episode_id = guid or audio_url
    if not provider_episode_id:
        provider_episode_id = _feed_fallback_episode_id(title, published_at)

    chapter_rows = _extract_rss_chapters_from_feed_item(item, base_url=base_url)
    transcript_refs = _extract_rss_transcript_refs_from_feed_item(item, base_url=base_url)
    episode_language = normalize_language_tag(item.xpath("string(./language)")) or feed_language

    return {
        "provider_episode_id": provider_episode_id,
        "guid": guid,
        "title": title,
        "authors": authors or None,
        "audio_url": audio_url,
        "published_at": published_at,
        "duration_seconds": duration_seconds,
        "description_html": description_html,
        "description_text": description_text,
        "transcript_segments": None,
        "rss_chapters": chapter_rows,
        "rss_transcript_refs": transcript_refs,
        "language": episode_language,
        "feed_language": feed_language,
    }


def _extract_episode_show_notes_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> tuple[str | None, str | None]:
    raw_content_encoded = str(
        item.xpath(f"string(./{_PODCAST_CONTENT_ENCODED_XPATH})") or ""
    ).strip()
    raw_description = str(item.xpath("string(./description)") or "").strip()
    raw_show_notes = raw_content_encoded or raw_description
    if not raw_show_notes:
        return None, None

    sanitize_base_url = str(base_url or "https://example.invalid/")
    try:
        sanitized_html = sanitize_html(raw_show_notes, sanitize_base_url)
    except ValueError:
        sanitized_html = ""

    normalized_html = normalize_optional_text(sanitized_html)
    if normalized_html is not None:
        normalized_html = _truncate_utf8_bytes(
            normalized_html,
            PODCAST_EPISODE_SHOW_NOTES_HTML_MAX_BYTES,
        )

    description_text_source = normalized_html or raw_show_notes
    normalized_text = normalize_optional_text(
        _extract_plain_text_from_html_fragment(description_text_source)
    )
    if normalized_text is not None:
        normalized_text = _truncate_utf8_bytes(
            normalized_text,
            PODCAST_EPISODE_SHOW_NOTES_TEXT_MAX_BYTES,
        )

    return normalized_html, normalized_text


def _extract_plain_text_from_html_fragment(raw_value: str) -> str:
    if not raw_value:
        return ""
    try:
        parser = etree.HTMLParser(no_network=True, recover=True)
        root = etree.fromstring(f"<div>{raw_value}</div>".encode(), parser=parser)
        if root is None:
            return ""
        text_tokens = [str(token).strip() for token in root.xpath("//text()")]
        return re.sub(r"\s+", " ", " ".join(token for token in text_tokens if token)).strip()
    except etree.XMLSyntaxError:
        stripped = re.sub(r"<[^>]+>", " ", raw_value)
        return re.sub(r"\s+", " ", stripped).strip()


def _truncate_utf8_bytes(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _extract_rss_chapters_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> list[dict[str, Any]] | None:
    podcasting20_url = _extract_podcasting20_chapter_url(item, base_url=base_url)
    if podcasting20_url is not None:
        return _fetch_podcasting20_chapters(podcasting20_url)
    return _parse_podlove_chapters(item, base_url=base_url)


def _extract_rss_transcript_refs_from_feed_item(
    item: Any,
    *,
    base_url: str | None,
) -> list[dict[str, Any]] | None:
    transcript_nodes = item.xpath("./*[local-name()='transcript' and @url]")
    if not transcript_nodes:
        return None

    refs: list[dict[str, Any]] = []
    for transcript_node in transcript_nodes:
        resolved_url = normalize_podcast_chapter_link(
            transcript_node.attrib.get("url"),
            base_url=base_url,
        )
        if resolved_url is None:
            continue
        if not _is_safe_feed_page_url(resolved_url):
            continue
        transcript_type = str(transcript_node.attrib.get("type") or "").strip().lower() or None
        transcript_language = normalize_language_tag(transcript_node.attrib.get("language"))
        refs.append(
            {
                "url": resolved_url,
                "type": transcript_type,
                "language": transcript_language,
            }
        )

    if not refs:
        return None

    logger.info(
        "rss_transcript_extracted",
        transcript_ref_count=len(refs),
        base_url=base_url,
    )
    return refs


def _extract_podcasting20_chapter_url(item: Any, *, base_url: str | None) -> str | None:
    chapter_tag_nodes = item.xpath("./*[local-name()='chapters' and @url]")
    if not chapter_tag_nodes:
        return None
    chapter_tag = chapter_tag_nodes[0]
    chapter_type = str(chapter_tag.attrib.get("type") or "").strip().lower()
    if chapter_type and chapter_type not in _PODCAST_CHAPTERS_20_CONTENT_TYPES:
        return None
    raw_url = chapter_tag.attrib.get("url")
    resolved_url = normalize_podcast_chapter_link(raw_url, base_url=base_url)
    if resolved_url is None:
        return None
    if not _is_safe_feed_page_url(resolved_url):
        return None
    return resolved_url


def _fetch_podcasting20_chapters(chapters_url: str) -> list[dict[str, Any]] | None:
    try:
        result = safe_get(chapters_url, max_bytes=_MAX_CHAPTER_JSON_BYTES, timeout_s=15.0)
    except ApiError as exc:
        logger.warning(
            "podcast_chapters_json_fetch_failed",
            chapters_url=chapters_url,
            error=exc.message,
        )
        return None

    try:
        payload = json.loads(result.text)
    except ValueError as exc:
        logger.warning(
            "podcast_chapters_json_invalid",
            chapters_url=chapters_url,
            error=str(exc),
        )
        return None
    return _parse_podcasting20_chapter_payload(payload, base_url=chapters_url)


def _parse_podcasting20_chapter_payload(
    payload: Any, *, base_url: str | None
) -> list[dict[str, Any]]:
    chapter_entries: list[Any]
    if isinstance(payload, dict):
        raw_chapters = payload.get("chapters")
        chapter_entries = raw_chapters if isinstance(raw_chapters, list) else []
    elif isinstance(payload, list):
        chapter_entries = payload
    else:
        chapter_entries = []

    parsed_rows: list[dict[str, Any]] = []
    for entry in chapter_entries:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        t_start_ms = _parse_chapter_timestamp_ms(
            entry.get("startTime") or entry.get("start_time") or entry.get("start")
        )
        if t_start_ms is None:
            continue
        t_end_ms = _parse_chapter_timestamp_ms(
            entry.get("endTime") or entry.get("end_time") or entry.get("end")
        )
        if t_end_ms is not None and t_end_ms < t_start_ms:
            t_end_ms = None
        parsed_rows.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "url": normalize_podcast_chapter_link(
                    entry.get("url") or entry.get("href"),
                    base_url=base_url,
                ),
                "image_url": normalize_podcast_chapter_link(
                    entry.get("img") or entry.get("image") or entry.get("image_url"),
                    base_url=base_url,
                ),
                "source": PODCAST_CHAPTER_SOURCE_PODCASTING20,
            }
        )
    parsed_rows.sort(key=lambda row: row["t_start_ms"])
    return parsed_rows


def _parse_podlove_chapters(item: Any, *, base_url: str | None) -> list[dict[str, Any]]:
    chapter_nodes = item.xpath(".//*[local-name()='chapters']/*[local-name()='chapter']")
    if not chapter_nodes:
        return []

    parsed_rows: list[dict[str, Any]] = []
    for chapter_node in chapter_nodes:
        title = str(chapter_node.attrib.get("title") or "").strip()
        if not title:
            continue
        t_start_ms = _parse_chapter_timestamp_ms(chapter_node.attrib.get("start"))
        if t_start_ms is None:
            continue
        t_end_ms = _parse_chapter_timestamp_ms(chapter_node.attrib.get("end"))
        if t_end_ms is not None and t_end_ms < t_start_ms:
            t_end_ms = None
        parsed_rows.append(
            {
                "title": title,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "url": normalize_podcast_chapter_link(
                    chapter_node.attrib.get("href") or chapter_node.attrib.get("url"),
                    base_url=base_url,
                ),
                "image_url": normalize_podcast_chapter_link(
                    chapter_node.attrib.get("image") or chapter_node.attrib.get("img"),
                    base_url=base_url,
                ),
                "source": PODCAST_CHAPTER_SOURCE_PODLOVE,
            }
        )
    parsed_rows.sort(key=lambda row: row["t_start_ms"])
    return parsed_rows


def normalize_podcast_chapter_link(raw_url: Any, *, base_url: str | None) -> str | None:
    if raw_url is None:
        return None
    normalized_raw = str(raw_url).strip()
    if not normalized_raw:
        return None
    resolved_url = urljoin(base_url, normalized_raw) if base_url else normalized_raw
    try:
        validate_requested_url(resolved_url)
    except InvalidRequestError:
        return None
    return resolved_url


def _parse_chapter_timestamp_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value < 0:
            return None
        return int(math.floor(float(raw_value) * 1000.0))

    raw_text = str(raw_value).strip()
    if not raw_text:
        return None

    try:
        numeric_seconds = float(raw_text)
    except ValueError:
        numeric_seconds = None
    if numeric_seconds is not None:
        if numeric_seconds < 0:
            return None
        return int(math.floor(numeric_seconds * 1000.0))

    match = _CHAPTER_TIMESTAMP_PATTERN.match(raw_text)
    if match is None:
        return None
    hours = int(match.group("hours") or "0")
    minutes = int(match.group("minutes"))
    seconds = float(match.group("seconds"))
    total_seconds = (hours * 3600.0) + (minutes * 60.0) + seconds
    return int(math.floor(total_seconds * 1000.0))


def _extract_feed_next_page_url(root: Any, base_url: str) -> str | None:
    href = str(
        root.xpath("string(./channel/atom:link[@rel='next'][1]/@href)", namespaces=_ATOM_NAMESPACE)
    ).strip()
    if not href:
        href = str(
            root.xpath("string(./atom:link[@rel='next'][1]/@href)", namespaces=_ATOM_NAMESPACE)
        ).strip()
    if not href:
        href = str(root.xpath("string(.//*[local-name()='link' and @rel='next'][1]/@href)")).strip()
    if not href:
        return None
    return urljoin(base_url, href)


def _normalize_feed_published_at(raw_value: Any) -> str | None:
    if raw_value is None:
        return None

    raw_text = str(raw_value).strip()
    if not raw_text:
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


def _parse_feed_duration_seconds(raw_value: Any) -> int | None:
    if raw_value is None:
        return None

    raw_text = str(raw_value).strip()
    if not raw_text:
        return None

    if ":" not in raw_text:
        return coerce_positive_int(raw_text)

    parts = raw_text.split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        values = [int(part) for part in parts]
    except ValueError:
        return None
    if any(value < 0 for value in values):
        return None

    if len(values) == 2:
        minutes, seconds = values
        return (minutes * 60) + seconds

    hours, minutes, seconds = values
    return (hours * 3600) + (minutes * 60) + seconds


def _episode_dedupe_key(episode: dict[str, Any]) -> tuple[str, str, str, str]:
    guid = normalize_optional_text(episode.get("guid")) or ""
    audio_url = str(episode.get("audio_url") or "").strip().lower()
    title = str(episode.get("title") or "").strip().lower()
    published_at = str(episode.get("published_at") or "").strip().lower()
    return (guid, audio_url, title, published_at)


def _episode_match_keys(episode: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    guid = normalize_optional_text(episode.get("guid"))
    if guid:
        keys.append(f"guid:{guid.lower()}")

    audio_url = str(episode.get("audio_url") or "").strip().lower()
    if audio_url:
        keys.append(f"audio:{audio_url}")

    provider_episode_id = str(episode.get("provider_episode_id") or "").strip().lower()
    if provider_episode_id:
        keys.append(f"provider:{provider_episode_id}")

    title = str(episode.get("title") or "").strip().lower()
    normalized_published_at = normalize_provider_published_at(episode.get("published_at")) or ""
    if title and normalized_published_at:
        keys.append(f"title_published:{title}|{normalized_published_at.lower()}")

    return keys
