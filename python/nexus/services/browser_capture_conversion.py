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
attempts names a source html converts with empty evidence.

The wire sweep (plain nullable, migration 0279) adds a second pass,
``unwrap_article_packet_presence``: a packet stored before it holds its four
optional metadata fields as Presence objects, which the current decoder
refuses, so every refresh, retry or stale requeue of that media would fail.
Each such packet is rewritten in the current form to a fresh object; its
attempts move to it, keeping the old object under ``retained_legacy_paths``
for the same rollback window. The command runs both passes, in order; a
second run does no work. This module is deleted after the verified production
run of the release that carries the sweep.
"""

from __future__ import annotations

import hashlib
import json
from itertools import groupby
from urllib.parse import urljoin
from uuid import UUID

from lxml.html import Element, HtmlElement
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaSourceAttempt
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.ids import new_uuid7
from nexus.schemas.extension_capture import (
    ARTICLE_SOURCE_HTML_MAX_BYTES,
    ArticlePacket,
    decode_article_packet,
)
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.storage.client import StorageClient, StorageError
from nexus.storage.paths import (
    build_source_artifact_storage_path,
    build_upload_verification_candidate_storage_path,
)
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
                byline=_text_or_none(latest.get("byline"), 1024),
                excerpt=_text_or_none(latest.get("excerpt"), 4000),
                site_name=_text_or_none(latest.get("site_name"), 1024),
                published_time=_text_or_none(latest.get("published_time"), 128),
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


def unwrap_article_packet_presence(db: Session, *, storage_client: StorageClient) -> None:
    references: dict[tuple[UUID, str], list[UUID]] = {}
    for attempt in db.scalars(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.source_type == "browser_article_capture")
        .order_by(MediaSourceAttempt.media_id, MediaSourceAttempt.attempt_no)
    ):
        path = (attempt.source_payload or {}).get("storage_path")
        references.setdefault((attempt.media_id, str(path or "")), []).append(attempt.id)
    db.rollback()
    for (media_id, old_path), attempt_ids in references.items():
        where = f"media {media_id}"
        old_raw = _read_input(storage_client, old_path, where).encode("utf-8")
        try:
            decode_article_packet(old_raw)
            continue
        except InvalidRequestError:
            pass
        try:
            fields = json.loads(old_raw)
            for key in ("byline", "excerpt", "site_name", "published_time"):
                value = fields[key]
                if value == {"kind": "Absent"}:
                    fields[key] = None
                elif isinstance(value, dict) and value.keys() == {"kind", "value"}:
                    if value["kind"] != "Present":
                        raise ValueError(key)
                    fields[key] = value["value"]
            packet = ArticlePacket.model_validate(fields)
        except (ValueError, TypeError, KeyError) as exc:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"Stored packet {old_path} is not convertible for {where}",
            ) from exc
        raw = packet.model_dump_json().encode("utf-8")
        packet_path = build_upload_verification_candidate_storage_path(
            media_id, new_uuid7(), "json"
        )
        reserve_storage_object_write(db, media_id=media_id, storage_path=packet_path)
        storage_client.put_object(packet_path, raw, "application/json")
        stored = b"".join(storage_client.stream_object(packet_path))
        if stored != raw or decode_article_packet(stored) != packet:
            raise ApiError(ApiErrorCode.E_STORAGE_ERROR, f"Packet read back differs for {where}")
        digest = hashlib.sha256(raw).hexdigest()
        with transaction(db):
            media = db.get(Media, media_id, with_for_update=True)
            locked = list(
                db.scalars(
                    select(MediaSourceAttempt)
                    .where(MediaSourceAttempt.id.in_(attempt_ids))
                    .with_for_update()
                )
            )
            if (
                media is None
                or len(locked) != len(attempt_ids)
                or any((row.source_payload or {}).get("storage_path") != old_path for row in locked)
            ):
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, f"{where} changed during conversion")
            for row in locked:
                payload = dict(row.source_payload or {})
                retained = payload.get("retained_legacy_paths")
                row.source_payload = payload | {
                    "storage_path": packet_path,
                    "size_bytes": len(raw),
                    "sha256": digest,
                    "retained_legacy_paths": [
                        *(retained if isinstance(retained, list) else []),
                        old_path,
                    ],
                }
            media.browser_capture_sha256 = digest
        finalize_storage_object_write(
            db, media_id=media_id, storage_path=packet_path, storage_client=storage_client
        )
        print(
            f"unwrapped {where} attempts {', '.join(str(attempt_id) for attempt_id in attempt_ids)}"
            f": {old_path} -> {packet_path} sha256 {digest}"
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
