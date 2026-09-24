"""One-shot conversion of pre-cutover browser article captures to packets.

Run once per environment after migration 0241 and before new captures are
enabled (``nexus convert-browser-article-captures``). A pre-cutover media's
attempts all describe one input: the first attempt's payload names the readable
html (``storage_path``) and the full source html (``source_storage_path``); later
attempts carry the same payload without the source reference. The packet is
therefore a property of the media: it is built once, written to
``media/{media_id}/source/{latest_attempt_id}.json`` (the attempt that readers,
retry and reuse reference), and every attempt is rewritten to it in one
transaction, each keeping its original blobs under ``retained_legacy_paths`` so
they stay db-owned through the rollback window
(``docs/tickets/remove-browser-capture-conversion-command.md`` closes it). A
named but unreadable input, or a payload that cannot become a packet, stops the
run naming the media so the operator repairs explicitly; a media none of whose
attempts names a source html converts with empty evidence. This module is
deleted after its verified production run.
"""

from __future__ import annotations

import hashlib
from itertools import groupby
from urllib.parse import urljoin

from lxml.html import Element, HtmlElement
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaSourceAttempt
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.extension_capture import (
    ARTICLE_SOURCE_HTML_MAX_BYTES,
    ArticlePacket,
    decode_article_packet,
)
from nexus.schemas.presence import presence_from_nullable
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.storage.client import StorageClient, StorageError
from nexus.storage.paths import build_source_artifact_storage_path
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)

_TWEET_TEXT_MAX_CHARS = 500


def convert_browser_article_captures(db: Session, *, storage_client: StorageClient) -> None:
    pending = [
        (attempt.media_id, attempt.id, dict(attempt.source_payload or {}))
        for attempt in db.scalars(
            select(MediaSourceAttempt)
            .where(
                MediaSourceAttempt.source_type == "browser_article_capture",
                text("NOT (source_payload ? 'sha256')"),
            )
            .order_by(
                MediaSourceAttempt.media_id,
                MediaSourceAttempt.attempt_no,
                MediaSourceAttempt.created_at,
                MediaSourceAttempt.id,
            )
        )
    ]
    db.rollback()
    for media_id, group in groupby(pending, key=lambda row: row[0]):
        attempts = [(attempt_id, payload) for _, attempt_id, payload in group]
        latest_id, latest = attempts[-1]
        where = f"media {media_id}"
        content_html = _read_input(storage_client, latest.get("storage_path"), where)
        source_path = next(
            (
                payload.get("source_storage_path")
                for _, payload in attempts
                if payload.get("source_storage_path")
            ),
            None,
        )
        evidence = (
            ""
            if source_path is None
            else _embed_evidence(
                _read_input(storage_client, source_path, where), str(latest.get("url") or "")
            )
        )
        try:
            packet = ArticlePacket(
                url=str(latest["url"]),
                base_url=str(latest["url"]),
                title=str(latest.get("title") or "")[:1024],
                content_html=content_html,
                source_html=evidence,
                byline=presence_from_nullable(_text_or_none(latest.get("byline"), 1024)),
                excerpt=presence_from_nullable(_text_or_none(latest.get("excerpt"), 4000)),
                site_name=presence_from_nullable(_text_or_none(latest.get("site_name"), 1024)),
                published_time=presence_from_nullable(
                    _text_or_none(latest.get("published_time"), 128)
                ),
            )
        except (KeyError, ValidationError) as exc:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST, f"Legacy payload is not convertible for {where}"
            ) from exc
        raw = packet.model_dump_json().encode("utf-8")
        packet_path = build_source_artifact_storage_path(media_id, latest_id, "json")
        reserve_storage_object_write(db, media_id=media_id, storage_path=packet_path)
        storage_client.put_object(packet_path, raw, "application/json")
        stored = b"".join(storage_client.stream_object(packet_path))
        if stored != raw or decode_article_packet(stored) != packet:
            raise ApiError(ApiErrorCode.E_STORAGE_ERROR, f"Packet read back differs for {where}")
        digest = hashlib.sha256(raw).hexdigest()
        with transaction(db):
            media = db.get(Media, media_id, with_for_update=True)
            locked = {
                attempt.id: attempt
                for attempt in db.scalars(
                    select(MediaSourceAttempt)
                    .where(MediaSourceAttempt.id.in_([attempt_id for attempt_id, _ in attempts]))
                    .with_for_update()
                )
            }
            if media is None or len(locked) != len(attempts):
                raise ApiError(
                    ApiErrorCode.E_MEDIA_NOT_FOUND, f"{where} vanished during conversion"
                )
            for attempt_id, payload in attempts:
                library_ids = payload.get("library_ids")
                locked[attempt_id].source_payload = {
                    "storage_path": packet_path,
                    "content_type": "application/json",
                    "size_bytes": len(raw),
                    "sha256": digest,
                    "source_url": packet.url,
                    "library_ids": (
                        [str(value) for value in library_ids]
                        if isinstance(library_ids, list)
                        else []
                    ),
                    "retained_legacy_paths": [
                        path
                        for path in (
                            payload.get("storage_path"),
                            payload.get("source_storage_path"),
                        )
                        if isinstance(path, str) and path.strip()
                    ],
                }
            media.browser_capture_sha256 = digest
        finalize_storage_object_write(
            db, media_id=media_id, storage_path=packet_path, storage_client=storage_client
        )
        print(
            f"converted {where} attempts {', '.join(str(attempt_id) for attempt_id, _ in attempts)}"
            f" -> {packet_path} sha256 {digest}"
        )


def _read_input(storage_client: StorageClient, path: object, where: str) -> str:
    if not isinstance(path, str) or not path.strip():
        raise ApiError(ApiErrorCode.E_STORAGE_MISSING, f"Input reference missing on {where}")
    try:
        return b"".join(storage_client.stream_object(path)).decode("utf-8")
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_MISSING, f"Input object {path} unreadable for {where}"
        ) from exc


def _text_or_none(value: object, max_length: int) -> str | None:
    clean = str(value).strip()[:max_length] if isinstance(value, str) else ""
    return clean or None


def _embed_evidence(source_html: str, base_url: str) -> str:
    """The bounded evidence ``document_embed_extraction`` consumes, by the rule
    ``content.ts sourceEvidence`` applies to a live document: iframes with an
    http(s) ``src`` (and their ``title``), twitter quotes with at least one
    http(s) link, their text collapsed and bounded; whole elements only, in
    document order, ≤ 64 KiB. A converted media carries exactly what a new
    capture of the same page would."""
    body = parse_html_document(source_html).body
    if body is None:
        return ""
    evidence = ""
    for element in body.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag == "iframe":
            src = _http_url(element.get("src"), base_url)
            if src is None:
                continue
            copy = Element("iframe", src=src)
            if element.get("title"):
                copy.set("title", str(element.get("title")))
        elif tag == "blockquote" and "twitter-tweet" in (element.get("class") or "").split():
            hrefs = [
                href
                for href in (_http_url(value, base_url) for value in element.xpath(".//a/@href"))
                if href is not None
            ]
            if not hrefs:
                continue
            copy = Element("blockquote", {"class": "twitter-tweet"})
            copy.text = " ".join(" ".join(element.itertext()).split())[:_TWEET_TEXT_MAX_CHARS]
            for href in hrefs:
                copy.append(Element("a", href=href))
        else:
            continue
        serialized = serialize_html(copy)
        if len((evidence + serialized).encode("utf-8")) > ARTICLE_SOURCE_HTML_MAX_BYTES:
            break
        evidence += serialized
    return evidence


def _http_url(value: object, base_url: str) -> str | None:
    """``value`` against ``base_url`` when it names an http(s) resource, else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    resolved = urljoin(base_url, value.strip())
    return resolved if resolved.startswith(("http://", "https://")) else None
