"""Podcast subscription and OPML import/export services."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from lxml import etree
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.podcast import (
    PodcastOpmlImportErrorOut,
    PodcastOpmlImportOut,
    PodcastSubscribeOut,
    PodcastSubscribeRequest,
    PodcastSubscriptionSettingsPatchRequest,
    PodcastSubscriptionStatusOut,
    PodcastUnsubscribeOut,
)
from nexus.services.contributor_credits import replace_podcast_contributor_credits
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

from .catalog import (
    _is_podcast_identity_conflict,
    _select_podcast_id_by_feed_url,
    _select_podcast_id_by_provider_id,
    _upsert_podcast,
    _validate_and_normalize_feed_url,
)
from .provider import PODCAST_PROVIDER, get_podcast_index_client
from .sync import _enqueue_podcast_subscription_sync, _get_subscription_sync_snapshot

logger = get_logger(__name__)

PODCAST_OPML_MAX_BYTES = 1_000_000
PODCAST_OPML_MAX_OUTLINES = 200
PODCAST_OPML_MAX_TITLE_LENGTH = 512
PODCAST_OPML_MAX_URL_LENGTH = 2048
PODCAST_OPML_MAX_ERROR_LENGTH = 300


def import_subscriptions_from_opml(
    db: Session,
    viewer_id: UUID,
    *,
    file_name: str | None,
    content_type: str | None,
    payload: bytes,
) -> PodcastOpmlImportOut:
    _validate_opml_upload(content_type=content_type, payload=payload)
    outline_rows = _parse_opml_rss_outlines(payload)
    if len(outline_rows) > PODCAST_OPML_MAX_OUTLINES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"OPML import supports at most {PODCAST_OPML_MAX_OUTLINES} RSS outlines per file.",
        )

    summary = PodcastOpmlImportOut(
        total=len(outline_rows),
        imported=0,
        skipped_already_subscribed=0,
        skipped_invalid=0,
        errors=[],
    )
    client = get_podcast_index_client()

    for outline in outline_rows:
        raw_feed_url = _sanitize_opml_string(
            outline.get("xmlUrl") or outline.get("xmlurl"),
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
        if not raw_feed_url:
            summary.skipped_invalid += 1
            continue

        try:
            normalized_feed_url = _validate_and_normalize_feed_url(raw_feed_url)
        except InvalidRequestError as exc:
            summary.skipped_invalid += 1
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=raw_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
            continue

        opml_title = _sanitize_opml_string(
            outline.get("text") or outline.get("title"),
            max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
        )
        opml_website_url = _normalize_optional_opml_url(
            _sanitize_opml_string(
                outline.get("htmlUrl") or outline.get("htmlurl"),
                max_length=PODCAST_OPML_MAX_URL_LENGTH,
            )
        )

        try:
            with transaction(db):
                now = datetime.now(UTC)
                podcast_id = _select_podcast_id_by_feed_url(db, normalized_feed_url)
                if podcast_id is None:
                    provider_row: dict[str, Any] | None = None
                    try:
                        provider_row = client.lookup_podcast_by_feed_url(normalized_feed_url)
                    except ApiError as provider_exc:
                        logger.warning(
                            "podcast_opml_provider_lookup_failed",
                            feed_url=normalized_feed_url,
                            error=provider_exc.message,
                        )
                    except Exception as provider_exc:  # pragma: no cover - defensive
                        logger.warning(
                            "podcast_opml_provider_lookup_unexpected_error",
                            feed_url=normalized_feed_url,
                            error=str(provider_exc),
                        )

                    subscribe_body = _build_opml_subscribe_request(
                        normalized_feed_url=normalized_feed_url,
                        opml_title=opml_title,
                        opml_website_url=opml_website_url,
                        provider_row=provider_row,
                    )
                    podcast_id = _upsert_podcast_from_opml(
                        db,
                        subscribe_body,
                        now=now,
                    )

                existing_status = _get_subscription_status_value(db, viewer_id, podcast_id)
                if existing_status == "active":
                    summary.skipped_already_subscribed += 1
                    continue

                subscription_created = _upsert_subscription(
                    db,
                    viewer_id,
                    podcast_id,
                    now=now,
                    auto_queue=False,
                )
                if not subscription_created and existing_status != "unsubscribed":
                    summary.skipped_already_subscribed += 1
                    continue
                _enqueue_podcast_subscription_sync(
                    db,
                    user_id=viewer_id,
                    podcast_id=podcast_id,
                )
                summary.imported += 1
        except ApiError as exc:
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error(exc.message),
                )
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception(
                "podcast_opml_import_unexpected_error",
                feed_url=normalized_feed_url,
                file_name=file_name,
                error=str(exc),
            )
            summary.errors.append(
                PodcastOpmlImportErrorOut(
                    feed_url=normalized_feed_url,
                    error=_truncate_opml_error("Unexpected OPML import error"),
                )
            )

    return summary


def export_subscriptions_as_opml(db: Session, viewer_id: UUID) -> bytes:
    rows = db.execute(
        text(
            """
            SELECT p.title, p.feed_url, p.website_url
            FROM podcast_subscriptions ps
            JOIN podcasts p ON p.id = ps.podcast_id
            WHERE ps.user_id = :user_id
              AND ps.status = 'active'
            ORDER BY LOWER(p.title) ASC, p.id ASC
            """
        ),
        {"user_id": viewer_id},
    ).fetchall()

    root = etree.Element("opml", version="2.0")
    head = etree.SubElement(root, "head")
    etree.SubElement(head, "title").text = "Nexus Podcasts"
    etree.SubElement(head, "dateCreated").text = datetime.now(UTC).strftime(
        "%a, %d %b %Y %H:%M:%S GMT"
    )
    body = etree.SubElement(root, "body")
    group = etree.SubElement(body, "outline", text="Podcasts")

    for row in rows:
        title = _sanitize_opml_string(str(row[0] or ""), max_length=PODCAST_OPML_MAX_TITLE_LENGTH)
        feed_url = str(row[1] or "").strip()
        website_url = _normalize_optional_opml_url(str(row[2] or "").strip())
        if not feed_url:
            continue
        outline_attrs = {
            "type": "rss",
            "text": title or feed_url,
            "xmlUrl": feed_url,
        }
        if website_url:
            outline_attrs["htmlUrl"] = website_url
        etree.SubElement(group, "outline", **outline_attrs)

    return etree.tostring(
        root,
        encoding="UTF-8",
        xml_declaration=True,
        pretty_print=True,
    )


def subscribe_to_podcast(
    db: Session,
    viewer_id: UUID,
    body: PodcastSubscribeRequest,
) -> PodcastSubscribeOut:
    normalized_feed_url = _validate_and_normalize_feed_url(body.feed_url)
    normalized_body = body.model_copy(update={"feed_url": normalized_feed_url})
    now = datetime.now(UTC)

    with transaction(db):
        if body.library_id is not None:
            target_library = db.execute(
                text("""
                    SELECT m.role, l.is_default
                    FROM memberships m
                    JOIN libraries l ON l.id = m.library_id
                    WHERE m.library_id = :library_id
                      AND m.user_id = :viewer_id
                    FOR UPDATE OF l
                """),
                {"library_id": body.library_id, "viewer_id": viewer_id},
            ).fetchone()
            if target_library is None:
                raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")
            if target_library[0] != "admin":
                raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Admin access required")
            if bool(target_library[1]):
                raise ForbiddenError(
                    ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
                    "Podcasts cannot be added to the default library",
                )

        podcast_id = _upsert_podcast(db, normalized_body, now=now)
        subscription_created = _upsert_subscription(
            db,
            viewer_id,
            podcast_id,
            now=now,
            auto_queue=body.auto_queue,
        )
        sync_enqueued = _enqueue_podcast_subscription_sync(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )
        snapshot = _get_subscription_sync_snapshot(db, viewer_id, podcast_id)
        if snapshot is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to read podcast subscription state.")
        if body.library_id is not None:
            _add_podcast_to_library_if_missing(
                db,
                library_id=body.library_id,
                podcast_id=podcast_id,
            )

    return PodcastSubscribeOut(
        podcast_id=podcast_id,
        subscription_created=subscription_created,
        auto_queue=bool(snapshot["auto_queue"]),
        sync_status=snapshot["sync_status"],
        sync_enqueued=sync_enqueued,
        sync_error_code=snapshot["sync_error_code"],
        sync_error_message=snapshot["sync_error_message"],
        sync_attempts=snapshot["sync_attempts"],
        last_synced_at=snapshot["last_synced_at"],
        window_size=get_settings().podcast_initial_episode_window,
    )


def get_subscription_status(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastSubscriptionStatusOut:
    row = db.execute(
        text(
            """
            SELECT
                ps.user_id,
                ps.podcast_id,
                ps.status,
                ps.default_playback_speed,
                ps.auto_queue,
                ps.sync_status,
                ps.sync_error_code,
                ps.sync_error_message,
                ps.sync_attempts,
                ps.sync_started_at,
                ps.sync_completed_at,
                ps.last_synced_at,
                ps.updated_at
            FROM podcast_subscriptions ps
            WHERE ps.user_id = :user_id AND ps.podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return PodcastSubscriptionStatusOut(
        user_id=row[0],
        podcast_id=row[1],
        status=row[2],
        default_playback_speed=float(row[3]) if row[3] is not None else None,
        auto_queue=bool(row[4]),
        sync_status=row[5],
        sync_error_code=row[6],
        sync_error_message=row[7],
        sync_attempts=row[8],
        sync_started_at=row[9],
        sync_completed_at=row[10],
        last_synced_at=row[11],
        updated_at=row[12],
    )


def update_subscription_settings_for_viewer(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
) -> PodcastSubscriptionStatusOut:
    assignments: list[str] = []
    params: dict[str, Any] = {
        "user_id": viewer_id,
        "podcast_id": podcast_id,
        "updated_at": datetime.now(UTC),
    }
    if "default_playback_speed" in body.model_fields_set:
        assignments.append("default_playback_speed = :default_playback_speed")
        params["default_playback_speed"] = body.default_playback_speed
    if "auto_queue" in body.model_fields_set:
        assignments.append("auto_queue = :auto_queue")
        params["auto_queue"] = bool(body.auto_queue)
    if not assignments:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one subscription settings field must be provided",
        )

    assignment_sql = ", ".join([*assignments, "updated_at = :updated_at"])
    with transaction(db):
        updated = db.execute(
            text(
                f"""
                UPDATE podcast_subscriptions
                SET {assignment_sql}
                WHERE user_id = :user_id
                  AND podcast_id = :podcast_id
                  AND status = 'active'
                RETURNING 1
                """
            ),
            params,
        ).fetchone()
        if updated is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return get_subscription_status(db, viewer_id, podcast_id)


def unsubscribe_from_podcast(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastUnsubscribeOut:
    now = datetime.now(UTC)
    removed_from_library_count = 0
    retained_shared_library_count = 0

    with transaction(db):
        subscription_exists = db.execute(
            text(
                """
                SELECT 1
                FROM podcast_subscriptions
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                FOR UPDATE
                """
            ),
            {"user_id": viewer_id, "podcast_id": podcast_id},
        ).fetchone()
        if subscription_exists is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

        library_rows = db.execute(
            text(
                """
                SELECT
                    le.id,
                    le.library_id,
                    l.owner_user_id,
                    l.is_default,
                    m.role
                FROM library_entries le
                JOIN libraries l
                  ON l.id = le.library_id
                JOIN memberships m
                  ON m.library_id = le.library_id
                 AND m.user_id = :user_id
                WHERE le.podcast_id = :podcast_id
                FOR UPDATE OF le
                """
            ),
            {"user_id": viewer_id, "podcast_id": podcast_id},
        ).fetchall()

        removable_entry_ids: list[UUID] = []
        removable_library_ids: list[UUID] = []
        for row in library_rows:
            entry_id = UUID(str(row[0]))
            library_id = UUID(str(row[1]))
            owner_user_id = row[2]
            is_default = bool(row[3])
            role = str(row[4])

            if is_default:
                continue
            if role == "admin":
                removable_entry_ids.append(entry_id)
                removable_library_ids.append(library_id)
                continue
            if owner_user_id != viewer_id:
                retained_shared_library_count += 1

        for entry_id in removable_entry_ids:
            db.execute(
                text(
                    """
                    DELETE FROM library_entries
                    WHERE id = :entry_id
                    """
                ),
                {"entry_id": entry_id},
            )
        removed_from_library_count = len(removable_entry_ids)
        for library_id in sorted(set(removable_library_ids)):
            db.execute(
                text(
                    """
                    WITH ordered AS (
                        SELECT
                            id,
                            ROW_NUMBER() OVER (
                                ORDER BY position ASC, created_at ASC, id ASC
                            ) - 1 AS next_position
                        FROM library_entries
                        WHERE library_id = :library_id
                    )
                    UPDATE library_entries le
                    SET position = ordered.next_position
                    FROM ordered
                    WHERE le.id = ordered.id
                      AND le.position IS DISTINCT FROM ordered.next_position
                    """
                ),
                {"library_id": library_id},
            )

        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    status = 'unsubscribed',
                    updated_at = :updated_at
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                """
            ),
            {
                "user_id": viewer_id,
                "podcast_id": podcast_id,
                "updated_at": now,
            },
        )

    return PodcastUnsubscribeOut(
        podcast_id=podcast_id,
        status="unsubscribed",
        removed_from_library_count=removed_from_library_count,
        retained_shared_library_count=retained_shared_library_count,
    )


def _validate_opml_upload(*, content_type: str | None, payload: bytes) -> None:
    normalized_content_type = str(content_type or "").split(";")[0].strip().lower()
    if (
        normalized_content_type
        and normalized_content_type not in {"application/octet-stream", "binary/octet-stream"}
        and "xml" not in normalized_content_type
        and "opml" not in normalized_content_type
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML import requires an XML file upload.",
        )
    if not payload:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "OPML file is empty.")
    if len(payload) > PODCAST_OPML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "OPML file exceeds the 1MB size limit.",
        )


def _parse_opml_rss_outlines(payload: bytes) -> list[dict[str, str]]:
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
        root = etree.fromstring(payload, parser=parser)
    except Exception as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid XML file. Please upload a valid OPML document.",
        ) from exc

    root_tag = str(root.tag or "")
    if "}" in root_tag:
        root_tag = root_tag.split("}", 1)[1]
    if root_tag.lower() != "opml":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid OPML document. Root element must be <opml>.",
        )

    outline_nodes = root.xpath(
        ".//*[local-name()='outline' and "
        "translate(@type, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')='rss']"
    )
    rows: list[dict[str, str]] = []
    for node in outline_nodes:
        attrib_items = getattr(node, "attrib", {})
        rows.append({str(key): str(value) for key, value in attrib_items.items()})
    return rows


def _sanitize_opml_string(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = "".join(ch for ch in str(value) if ch in {"\n", "\r", "\t"} or ord(ch) >= 32).strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _truncate_opml_error(message: str) -> str:
    return str(message or "Unknown error")[:PODCAST_OPML_MAX_ERROR_LENGTH]


def _normalize_optional_opml_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return None
    return normalize_url_for_display(url)


def _stable_opml_provider_podcast_id(normalized_feed_url: str) -> str:
    digest = hashlib.sha1(normalized_feed_url.encode("utf-8")).hexdigest()
    return f"opml-{digest}"


def _build_opml_subscribe_request(
    *,
    normalized_feed_url: str,
    opml_title: str | None,
    opml_website_url: str | None,
    provider_row: dict[str, Any] | None,
) -> PodcastSubscribeRequest:
    provider_podcast_id = _sanitize_opml_string(
        provider_row.get("provider_podcast_id") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_title = _sanitize_opml_string(
        provider_row.get("title") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_author = _sanitize_opml_string(
        provider_row.get("author") if provider_row else None,
        max_length=PODCAST_OPML_MAX_TITLE_LENGTH,
    )
    provider_website = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("website_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_image = _normalize_optional_opml_url(
        _sanitize_opml_string(
            provider_row.get("image_url") if provider_row else None,
            max_length=PODCAST_OPML_MAX_URL_LENGTH,
        )
    )
    provider_description = _sanitize_opml_string(
        provider_row.get("description") if provider_row else None,
        max_length=4000,
    )

    return PodcastSubscribeRequest(
        provider_podcast_id=provider_podcast_id
        or _stable_opml_provider_podcast_id(normalized_feed_url),
        title=provider_title or opml_title or normalized_feed_url,
        contributors=[
            {
                "credited_name": provider_author,
                "role": "author",
                "source": "podcast_index",
                "source_ref": {"provider": PODCAST_PROVIDER},
            }
        ]
        if provider_author
        else [],
        feed_url=normalized_feed_url,
        website_url=provider_website or opml_website_url,
        image_url=provider_image,
        description=provider_description,
        auto_queue=False,
    )


def _upsert_podcast_from_opml(
    db: Session,
    body: PodcastSubscribeRequest,
    *,
    now: datetime,
) -> UUID:
    feed_owner_id = _select_podcast_id_by_feed_url(db, body.feed_url)
    if feed_owner_id is not None:
        provider_owner_id = _select_podcast_id_by_provider_id(db, body.provider_podcast_id)
        if provider_owner_id is not None and provider_owner_id != feed_owner_id:
            row = db.execute(
                text(
                    """
                    UPDATE podcasts
                    SET
                        title = :title,
                        website_url = COALESCE(:website_url, website_url),
                        image_url = COALESCE(:image_url, image_url),
                        description = COALESCE(:description, description),
                        updated_at = :updated_at
                    WHERE id = :podcast_id
                    RETURNING id
                    """
                ),
                {
                    "podcast_id": feed_owner_id,
                    "title": body.title,
                    "website_url": body.website_url,
                    "image_url": body.image_url,
                    "description": body.description,
                    "updated_at": now,
                },
            ).fetchone()
            podcast_id = row[0]
            _replace_opml_podcast_contributors(db, podcast_id, body)
            return podcast_id

        row = db.execute(
            text(
                """
                UPDATE podcasts
                SET
                    provider_podcast_id = :provider_podcast_id,
                    title = :title,
                    website_url = COALESCE(:website_url, website_url),
                    image_url = COALESCE(:image_url, image_url),
                    description = COALESCE(:description, description),
                    updated_at = :updated_at
                WHERE id = :podcast_id
                RETURNING id
                """
            ),
            {
                "podcast_id": feed_owner_id,
                "provider_podcast_id": body.provider_podcast_id,
                "title": body.title,
                "website_url": body.website_url,
                "image_url": body.image_url,
                "description": body.description,
                "updated_at": now,
            },
        ).fetchone()
        podcast_id = row[0]
        _replace_opml_podcast_contributors(db, podcast_id, body)
        return podcast_id

    provider_owner_id = _select_podcast_id_by_provider_id(db, body.provider_podcast_id)
    if provider_owner_id is not None:
        row = db.execute(
            text(
                """
                UPDATE podcasts
                SET
                    title = :title,
                    feed_url = :feed_url,
                    website_url = COALESCE(:website_url, website_url),
                    image_url = COALESCE(:image_url, image_url),
                    description = COALESCE(:description, description),
                    updated_at = :updated_at
                WHERE id = :podcast_id
                RETURNING id
                """
            ),
            {
                "podcast_id": provider_owner_id,
                "title": body.title,
                "feed_url": body.feed_url,
                "website_url": body.website_url,
                "image_url": body.image_url,
                "description": body.description,
                "updated_at": now,
            },
        ).fetchone()
        podcast_id = row[0]
        _replace_opml_podcast_contributors(db, podcast_id, body)
        return podcast_id

    try:
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        provider,
                        provider_podcast_id,
                        title,
                        feed_url,
                        website_url,
                        image_url,
                        description,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :provider,
                        :provider_podcast_id,
                        :title,
                        :feed_url,
                        :website_url,
                        :image_url,
                        :description,
                        :created_at,
                        :updated_at
                    )
                    RETURNING id
                    """
                ),
                {
                    "provider": PODCAST_PROVIDER,
                    "provider_podcast_id": body.provider_podcast_id,
                    "title": body.title,
                    "feed_url": body.feed_url,
                    "website_url": body.website_url,
                    "image_url": body.image_url,
                    "description": body.description,
                    "created_at": now,
                    "updated_at": now,
                },
            ).fetchone()
    except IntegrityError as exc:
        if not _is_podcast_identity_conflict(exc):
            raise
        feed_owner_id = _select_podcast_id_by_feed_url(db, body.feed_url)
        if feed_owner_id is not None:
            provider_owner_id = _select_podcast_id_by_provider_id(db, body.provider_podcast_id)
            if provider_owner_id is not None and provider_owner_id != feed_owner_id:
                row = db.execute(
                    text(
                        """
                        UPDATE podcasts
                        SET
                            title = :title,
                            website_url = COALESCE(:website_url, website_url),
                            image_url = COALESCE(:image_url, image_url),
                            description = COALESCE(:description, description),
                            updated_at = :updated_at
                        WHERE id = :podcast_id
                        RETURNING id
                        """
                    ),
                    {
                        "podcast_id": feed_owner_id,
                        "title": body.title,
                        "website_url": body.website_url,
                        "image_url": body.image_url,
                        "description": body.description,
                        "updated_at": now,
                    },
                ).fetchone()
            else:
                row = db.execute(
                    text(
                        """
                        UPDATE podcasts
                        SET
                            provider_podcast_id = :provider_podcast_id,
                            title = :title,
                            website_url = COALESCE(:website_url, website_url),
                            image_url = COALESCE(:image_url, image_url),
                            description = COALESCE(:description, description),
                            updated_at = :updated_at
                        WHERE id = :podcast_id
                        RETURNING id
                        """
                    ),
                    {
                        "podcast_id": feed_owner_id,
                        "provider_podcast_id": body.provider_podcast_id,
                        "title": body.title,
                        "website_url": body.website_url,
                        "image_url": body.image_url,
                        "description": body.description,
                        "updated_at": now,
                    },
                ).fetchone()
            podcast_id = row[0]
            _replace_opml_podcast_contributors(db, podcast_id, body)
            return podcast_id

        provider_owner_id = _select_podcast_id_by_provider_id(db, body.provider_podcast_id)
        if provider_owner_id is None:
            raise
        row = db.execute(
            text(
                """
                UPDATE podcasts
                SET
                    title = :title,
                    feed_url = :feed_url,
                    website_url = COALESCE(:website_url, website_url),
                    image_url = COALESCE(:image_url, image_url),
                    description = COALESCE(:description, description),
                    updated_at = :updated_at
                WHERE id = :podcast_id
                RETURNING id
                """
            ),
            {
                "podcast_id": provider_owner_id,
                "title": body.title,
                "feed_url": body.feed_url,
                "website_url": body.website_url,
                "image_url": body.image_url,
                "description": body.description,
                "updated_at": now,
            },
        ).fetchone()
        podcast_id = row[0]
        _replace_opml_podcast_contributors(db, podcast_id, body)
        return podcast_id

    podcast_id = row[0]
    _replace_opml_podcast_contributors(db, podcast_id, body)
    return podcast_id


def _replace_opml_podcast_contributors(
    db: Session,
    podcast_id: UUID,
    body: PodcastSubscribeRequest,
) -> None:
    replace_podcast_contributor_credits(
        db,
        podcast_id=podcast_id,
        credits=[credit.model_dump(mode="json") for credit in body.contributors],
        source=PODCAST_PROVIDER,
    )


def _get_subscription_status_value(db: Session, viewer_id: UUID, podcast_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT status
            FROM podcast_subscriptions
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
            """
        ),
        {"user_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None
    return str(row[0] or "")


def _upsert_subscription(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
    *,
    now: datetime,
    auto_queue: bool,
) -> bool:
    existing = db.execute(
        text(
            """
            SELECT 1 FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": user_id, "podcast_id": podcast_id},
    ).fetchone()

    if existing is not None:
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    status = 'active',
                    auto_queue = :auto_queue,
                    sync_status = 'pending',
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_started_at = NULL,
                    sync_completed_at = NULL,
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND podcast_id = :podcast_id
                """
            ),
            {
                "user_id": user_id,
                "podcast_id": podcast_id,
                "auto_queue": auto_queue,
                "updated_at": now,
            },
        )
        return False

    try:
        with db.begin_nested():
            db.execute(
                text(
                    """
                    INSERT INTO podcast_subscriptions (
                        user_id,
                        podcast_id,
                        status,
                        auto_queue,
                        sync_status,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :user_id,
                        :podcast_id,
                        'active',
                        :auto_queue,
                        'pending',
                        :created_at,
                        :updated_at
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "podcast_id": podcast_id,
                    "auto_queue": auto_queue,
                    "created_at": now,
                    "updated_at": now,
                },
            )
    except IntegrityError as exc:
        if not _is_subscription_identity_conflict(exc):
            raise
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    status = 'active',
                    auto_queue = :auto_queue,
                    sync_status = 'pending',
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_started_at = NULL,
                    sync_completed_at = NULL,
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND podcast_id = :podcast_id
                """
            ),
            {
                "user_id": user_id,
                "podcast_id": podcast_id,
                "auto_queue": auto_queue,
                "updated_at": now,
            },
        )
        return False
    return True


def _add_podcast_to_library_if_missing(
    db: Session,
    *,
    library_id: UUID,
    podcast_id: UUID,
) -> None:
    existing_entry = db.execute(
        text("""
            SELECT 1
            FROM library_entries
            WHERE library_id = :library_id
              AND podcast_id = :podcast_id
        """),
        {"library_id": library_id, "podcast_id": podcast_id},
    ).fetchone()
    if existing_entry is not None:
        return

    try:
        with db.begin_nested():
            db.execute(
                text("""
                    INSERT INTO library_entries (library_id, media_id, podcast_id, position)
                    VALUES (
                        :library_id,
                        NULL,
                        :podcast_id,
                        (
                            SELECT COALESCE(MAX(position), -1) + 1
                            FROM library_entries
                            WHERE library_id = :library_id
                        )
                    )
                """),
                {
                    "library_id": library_id,
                    "podcast_id": podcast_id,
                },
            )
    except IntegrityError as exc:
        if not _is_library_podcast_entry_conflict(exc):
            raise


def _is_subscription_identity_conflict(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return constraint_name == "podcast_subscriptions_pkey"
    return "podcast_subscriptions_pkey" in str(orig or exc)


def _is_library_podcast_entry_conflict(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return constraint_name == "uq_library_entries_library_podcast"
    return "uq_library_entries_library_podcast" in str(orig or exc)
