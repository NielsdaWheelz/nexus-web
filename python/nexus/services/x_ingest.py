"""X URL ingest ownership."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services import library_entries
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.fragment_blocks import FragmentBlockSpec, insert_fragment_blocks
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.provider_events import record_external_provider_event
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_indexing import index_web_article_evidence
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.services.x_client import fetch_author_thread_snapshot
from nexus.services.x_identity import canonical_x_post_url
from nexus.services.x_rendering import (
    post_description,
    post_title,
    render_author_thread_fragment_html,
    render_single_post_html,
    thread_description,
    thread_title,
)
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XPostSnapshot,
    XProviderError,
    XProviderErrorCode,
    x_author_thread_provider_id,
    x_post_provider_id,
)

logger = get_logger(__name__)


@dataclass(frozen=True)
class _PreparedXFragment:
    fragment: Fragment
    fragment_blocks: list[FragmentBlockSpec]


@dataclass(frozen=True)
class _WebArticleIndexTarget:
    media_id: UUID
    fragment_id: UUID
    fragments: list[Fragment]
    reason: str
    language: str | None


def materialize_x_author_thread_media(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    post_id: str,
    source_attempt_id: UUID | None,
    request_id: str | None,
) -> dict[str, object]:
    """Materialize a previously accepted provisional X media row."""
    return _refresh_x_author_thread_media_for_viewer(
        db,
        viewer_id,
        media=media,
        post_id=post_id,
        source_attempt_id=source_attempt_id,
        request_id=request_id,
    )


def _refresh_x_author_thread_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media: Media,
    post_id: str,
    source_attempt_id: UUID | None = None,
    request_id: str | None,
) -> dict[str, object]:
    started_at = perf_counter()
    try:
        snapshot = fetch_author_thread_snapshot(post_id)
    except XProviderError as exc:
        db.rollback()
        _record_x_provider_failure(
            db,
            error=exc,
            request_id=request_id,
            source_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            target_ref=post_id,
            duration_ms=_duration_ms(started_at),
        )
        db.commit()
        raise _api_error_from_x_provider_error(exc) from exc
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    provider_id = x_author_thread_provider_id(snapshot.author.id, snapshot.conversation_id)
    _lock_x_provider_id(db, provider_id)
    existing_thread_media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == provider_id, Media.id != media.id)
        .limit(1)
        .one_or_none()
    )
    source_library_ids = library_entries.admin_non_default_library_ids_for_media(
        db,
        viewer_id=viewer_id,
        media_id=media.id,
    )
    if existing_thread_media is not None:
        library_entries.assign_libraries_for_media_in_current_transaction(
            db,
            viewer_id,
            existing_thread_media.id,
            source_library_ids,
        )
        _record_x_provider_success(
            db,
            request_id=request_id,
            source_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            media_id=existing_thread_media.id,
            target_ref=provider_id,
            duration_ms=_duration_ms(started_at),
            snapshot=snapshot,
        )
        db.commit()
        return {
            "media_id": str(existing_thread_media.id),
            "processing_status": _status_to_str(existing_thread_media.processing_status),
            "ingest_enqueued": False,
            "idempotency_outcome": "reused",
        }

    now = datetime.now(UTC)
    created_index_targets: list[_WebArticleIndexTarget] = []
    quoted_media_ids: dict[str, UUID] = {}
    for quoted_id, quoted_post in snapshot.quoted_posts.items():
        quote_media, quote_fragment, quote_created = _create_or_reuse_x_snapshot_post_media(
            db,
            viewer_id,
            post=quoted_post,
            snapshot=snapshot,
            library_ids=source_library_ids,
            now=now,
        )
        quoted_media_ids[quoted_id] = quote_media.id
        if quote_created and quote_fragment is not None:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=quote_media.id,
                    fragment_id=quote_fragment.fragment.id,
                    fragments=[quote_fragment.fragment],
                    reason="x_api_quoted_post",
                    language=quote_media.language,
                )
            )

    prepared_fragments: list[_PreparedXFragment] = []
    for idx, (post, fragment_html) in enumerate(
        render_author_thread_fragment_html(
            snapshot,
            quoted_media_ids=quoted_media_ids,
            app_public_url=get_settings().app_public_url,
        )
    ):
        prepared_fragments.append(
            _build_x_fragment(
                media_id=media.id,
                idx=idx,
                html=fragment_html,
                base_url=post.permalink,
                created_at=now,
            )
        )

    fragments = [prepared.fragment for prepared in prepared_fragments]
    if not "\n\n".join(fragment.canonical_text for fragment in fragments).strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")

    delete_web_article_artifacts(
        db,
        media_id=media.id,
        include_content_index=True,
    )
    media.title = thread_title(snapshot)[:255]
    media.canonical_url = None
    media.canonical_source_url = snapshot.canonical_url
    media.provider = "x"
    media.provider_id = provider_id
    media.publisher = "X"
    media.description = thread_description(snapshot)

    for prepared_fragment in prepared_fragments:
        db.add(prepared_fragment.fragment)
    db.flush()
    for prepared_fragment in prepared_fragments:
        insert_fragment_blocks(
            db,
            prepared_fragment.fragment.id,
            prepared_fragment.fragment_blocks,
        )
    replace_media_contributor_credits(
        db,
        media_id=media.id,
        credits=[
            {
                "name": snapshot.author.name[:255],
                "handle": snapshot.author.username[:255],
                "role": "author",
                "source": "x_api_author_thread",
                "source_ref": {"media_id": str(media.id), "x_user_id": snapshot.author.id},
            }
        ],
    )
    db.commit()

    created_index_targets.append(
        _WebArticleIndexTarget(
            media_id=media.id,
            fragment_id=fragments[0].id,
            fragments=fragments,
            reason="x_api_author_thread_refresh",
            language=media.language,
        )
    )
    for target in created_index_targets:
        index_web_article_evidence(
            db,
            media_id=target.media_id,
            fragment_id=target.fragment_id,
            fragments=target.fragments,
            reason=target.reason,
            language=target.language,
            request_id=request_id,
            log_event=f"{target.reason}_content_index_failed",
        )
        try_enqueue_metadata_enrichment(db, media_id=target.media_id, request_id=request_id)
    _record_x_provider_success(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        media_id=media.id,
        target_ref=provider_id,
        duration_ms=_duration_ms(started_at),
        snapshot=snapshot,
    )
    db.commit()

    return {
        "media_id": str(media.id),
        "processing_status": ProcessingStatus.ready_for_reading.value,
        "ingest_enqueued": False,
        "idempotency_outcome": "refreshed",
    }


def _create_or_reuse_x_snapshot_post_media(
    db: Session,
    viewer_id: UUID,
    *,
    post: XPostSnapshot,
    snapshot: XAuthorThreadSnapshot,
    library_ids: list[UUID],
    now: datetime,
) -> tuple[Media, _PreparedXFragment | None, bool]:
    provider_id = x_post_provider_id(post.id)
    media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == provider_id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, library_ids
        )
        return media, None, False

    prepared_fragment = _build_x_fragment(
        media_id=None,
        idx=0,
        html=render_single_post_html(post, users=snapshot.users, media=snapshot.media),
        base_url=canonical_x_post_url(post.id),
        created_at=now,
    )
    media = Media(
        kind=MediaKind.web_article.value,
        title=post_title(post, snapshot.users)[:255],
        requested_url=canonical_x_post_url(post.id),
        canonical_url=canonical_x_post_url(post.id),
        canonical_source_url=canonical_x_post_url(post.id),
        provider="x",
        provider_id=provider_id,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher="X",
        description=post_description(post),
    )
    try:
        with db.begin_nested():
            db.add(media)
            db.flush()
            mark_ready_for_reading(db, media)
    except IntegrityError as exc:
        if not (_is_media_provider_conflict(exc) or _is_media_canonical_url_conflict(exc)):
            raise
        media = (
            db.query(Media)
            .filter(Media.provider == "x", Media.provider_id == provider_id)
            .limit(1)
            .one_or_none()
        )
        if media is None:
            media = (
                db.query(Media)
                .filter(
                    Media.kind == MediaKind.web_article.value,
                    Media.canonical_url == canonical_x_post_url(post.id),
                )
                .limit(1)
                .one_or_none()
            )
        if media is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to resolve canonical X post") from exc
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, library_ids
        )
        return media, None, False

    prepared_fragment.fragment.media_id = media.id
    db.add(prepared_fragment.fragment)
    db.flush()
    insert_fragment_blocks(
        db,
        prepared_fragment.fragment.id,
        prepared_fragment.fragment_blocks,
    )
    author = snapshot.users.get(post.author_id)
    if author is not None:
        replace_media_contributor_credits(
            db,
            media_id=media.id,
            credits=[
                {
                    "name": author.name[:255],
                    "handle": author.username[:255],
                    "role": "author",
                    "source": "x_api_quoted_post",
                    "source_ref": {"media_id": str(media.id), "x_user_id": author.id},
                }
            ],
        )
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    return media, prepared_fragment, True


def _build_x_fragment(
    *,
    media_id: UUID | None,
    idx: int,
    html: str,
    base_url: str,
    created_at: datetime,
) -> _PreparedXFragment:
    if len(html.encode("utf-8")) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "X thread HTML is too large")
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            fragment_idx=idx,
            media_title=None,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "X thread could not be sanitized"
        ) from exc
    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")
    fragment = Fragment(
        media_id=media_id,
        idx=idx,
        html_sanitized=prepared.html_sanitized,
        canonical_text=canonical_text,
        created_at=created_at,
    )
    return _PreparedXFragment(fragment=fragment, fragment_blocks=prepared.fragment_blocks)


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)


def _lock_x_provider_id(db: Session, provider_id: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:provider_id, 0))"),
        {"provider_id": provider_id},
    )


def _api_error_from_x_provider_error(error: XProviderError) -> ApiError:
    if error.code == XProviderErrorCode.CREDITS_DEPLETED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED,
            "X imports are temporarily unavailable.",
        )
    elif error.code == XProviderErrorCode.AUTH_REJECTED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED,
            "X imports are temporarily unavailable.",
        )
    elif error.code == XProviderErrorCode.RATE_LIMITED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_RATE_LIMITED,
            "X is rate limiting imports.",
        )
    elif error.code == XProviderErrorCode.TIMEOUT:
        api_error = ApiError(ApiErrorCode.E_X_PROVIDER_TIMEOUT, "X import timed out.")
    elif error.code == XProviderErrorCode.POST_UNAVAILABLE:
        api_error = ApiError(ApiErrorCode.E_X_POST_UNAVAILABLE, "That X post is not available.")
    else:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            "X imports are temporarily unavailable.",
        )
    api_error.retry_after_seconds = error.retry_after_seconds
    return api_error


def _record_x_provider_failure(
    db: Session,
    *,
    error: XProviderError,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID,
    target_ref: str,
    duration_ms: int,
) -> None:
    api_error = _api_error_from_x_provider_error(error)
    record_external_provider_event(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        provider="x",
        capability="author-thread",
        operation=error.operation,
        target_ref=target_ref,
        status="failure",
        api_error_code=api_error.code.value,
        provider_status_code=error.provider_status_code,
        provider_error_type=error.provider_error_type,
        provider_error_title=error.provider_error_title,
        duration_ms=duration_ms,
        retry_after_seconds=error.retry_after_seconds,
    )
    logger.warning(
        "x_provider_failure",
        request_id=request_id,
        user_id=str(viewer_id),
        operation=error.operation,
        provider_status_code=error.provider_status_code,
        provider_error_title=error.provider_error_title,
        api_error_code=api_error.code.value,
    )


def _record_x_provider_success(
    db: Session,
    *,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID,
    media_id: UUID,
    target_ref: str,
    duration_ms: int,
    snapshot: XAuthorThreadSnapshot,
) -> None:
    record_external_provider_event(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        media_id=media_id,
        provider="x",
        capability="author-thread",
        operation="ingest_author_thread",
        target_ref=target_ref,
        status="success",
        duration_ms=duration_ms,
        metadata={
            "requested_post_id": snapshot.requested_post_id,
            "conversation_id": snapshot.conversation_id,
            "canonical_anchor_post_id": snapshot.canonical_anchor_post_id,
            "post_count": len(snapshot.posts),
            "quote_post_count": len(snapshot.quoted_posts),
        },
    )


def _duration_ms(started_at: float) -> int:
    return max(0, int((perf_counter() - started_at) * 1000))


def _is_media_provider_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_x_provider_id"
    return "uix_media_x_provider_id" in str(exc)


def _is_media_canonical_url_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_canonical_url"
    return "uix_media_canonical_url" in str(exc)
