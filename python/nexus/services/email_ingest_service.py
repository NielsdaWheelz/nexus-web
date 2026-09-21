"""Post Room: accept an emailed message as web-article media."""

from __future__ import annotations

import email
import email.message
import email.policy
import hashlib
import hmac
import html as html_lib
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parseaddr, parsedate_to_datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import Presence, absent, nullable_from_presence
from nexus.schemas.publication_dates import PublicationDate, normalize_source_publication_date
from nexus.services import library_entries
from nexus.services import media_source_types as source_types
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
    clean_contributor_display,
)
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import replace_observed_role_slices_batch
from nexus.services.media_processing_state import mark_media_failed_by_id
from nexus.services.media_source_ingest import (
    build_intent_key,
    create_attempt,
    enqueue_accepted_source_attempt,
)
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)

# MIME walk safety caps — no newsletter legitimately exceeds these.
_MAX_MIME_PARTS = 50
_MAX_MIME_DEPTH = 10


@dataclass(frozen=True, slots=True)
class EmailAcceptance:
    media_id: UUID
    outcome: str


def verify_email_signature(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    """Constant-time HMAC-SHA256 check of the worker signature; a blank secret fails."""
    if not secret or not signature_header:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip().lower())


def normalize_message_id(raw: str | None) -> str | None:
    """Strip angle brackets, lowercase the host, trim; ``None`` when blank."""
    if not raw:
        return None
    message_id = raw.strip()
    if message_id.startswith("<") and message_id.endswith(">"):
        message_id = message_id[1:-1]
    if "@" in message_id:
        local, host = message_id.split("@", 1)
        message_id = f"{local}@{host.lower()}"
    return message_id.strip() or None


def accept_email_message(
    *, db: Session, raw_body: bytes, owner_user_id: UUID, request_id: str | None
) -> EmailAcceptance:
    """Parse one MIME message and accept it into the ingest pipeline.

    Dedupe happens at the media layer on ``Message-ID`` before any attempt
    exists; a repeat delivery re-applies the sender credit and creates nothing.
    """
    try:
        message = email.message_from_bytes(raw_body, policy=email.policy.default)
    except Exception as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "MIME message could not be parsed."
        ) from exc

    message_id = normalize_message_id(_header(message, "Message-ID")) or (
        f"synthesized-{hashlib.sha256(raw_body[:4096]).hexdigest()}"
    )
    sender = _sender(message)
    observation = _sender_observation(*sender) if sender is not None else NOT_OBSERVED

    existing = _media_for_message_id(db, message_id)
    if existing is not None:
        # A first delivery may have crashed after the media commit but before
        # the author op; re-running it is a no-op when the credit already holds.
        replace_observed_role_slices_batch(((MediaTarget(existing), observation, "email"),))
        return EmailAcceptance(media_id=existing, outcome="duplicate")

    if sender is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Email has no valid From: header."
        )
    sender_name, sender_address = sender
    html_content = _readable_html(message)
    subject = (_header(message, "Subject") or "Untitled").strip()[:255] or "Untitled"
    edition_date = _publication_date(_header(message, "Date"))

    now = datetime.now(UTC)
    media = Media(
        kind=MediaKind.web_article.value,
        title=subject,
        provider="email",
        provider_id=message_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=owner_user_id,
        created_at=now,
        updated_at=now,
        edition_published_date=nullable_from_presence(edition_date),
    )
    db.add(media)
    try:
        db.flush()
    except IntegrityError:
        # A concurrent delivery of the same Message-ID committed between the
        # dedupe SELECT and this INSERT: the index, not python, resolves it.
        db.rollback()
        raced = _media_for_message_id(db, message_id)
        if raced is None:
            raise
        replace_observed_role_slices_batch(((MediaTarget(raced), observation, "email"),))
        return EmailAcceptance(media_id=raced, outcome="duplicate")

    attempt = create_attempt(
        db,
        media=media,
        viewer_id=owner_user_id,
        source_type=source_types.EMAIL_MESSAGE,
        intent_key=build_intent_key(source_types.EMAIL_MESSAGE, message_id, None),
        requested_url=None,
        canonical_source_url=None,
        provider="email",
        provider_target_ref=message_id,
        source_payload={
            "message_id": message_id,
            "sender_name": sender_name,
            "sender_address": sender_address,
            "subject": subject,
            "edition_published_date": edition_date.model_dump(),
        },
        request_id=request_id,
        idempotency_key=None,
        status="accepted",
    )
    html_bytes = html_content.encode("utf-8")
    storage_path = build_source_artifact_storage_path(media.id, attempt.id, "html")
    attempt.source_payload = {
        **dict(attempt.source_payload or {}),
        "storage_path": storage_path,
        "content_type": "text/html; charset=utf-8",
        "size_bytes": len(html_bytes),
        "has_content": bool(html_content),
    }
    library_entries.ensure_media_in_default_library(db, owner_user_id, media.id)
    db.commit()

    # The sender credit is applied right after the media transaction commits so
    # it survives a later storage failure and the duplicate path converges.
    replace_observed_role_slices_batch(((MediaTarget(media.id), observation, "email"),))

    reserve_storage_object_write(db, media_id=media.id, storage_path=storage_path)
    storage_client = get_storage_client()
    try:
        storage_client.put_object(storage_path, html_bytes, "text/html; charset=utf-8")
        finalize_storage_object_write(
            db, media_id=media.id, storage_path=storage_path, storage_client=storage_client
        )
    except StorageError as exc:
        db.rollback()
        mark_media_failed_by_id(
            db,
            media_id=media.id,
            stage="upload",
            error_code=ApiErrorCode.E_STORAGE_ERROR.value,
            error_message=str(exc),
            now=datetime.now(UTC),
        )
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        db.commit()
        return EmailAcceptance(media_id=media.id, outcome="accepted")

    enqueue_accepted_source_attempt(
        db,
        media_id=media.id,
        attempt_id=attempt.id,
        actor_user_id=owner_user_id,
        request_id=request_id,
    )
    return EmailAcceptance(media_id=media.id, outcome="accepted")


def _media_for_message_id(db: Session, message_id: str) -> UUID | None:
    return db.scalar(
        select(Media.id).where(Media.provider == "email", Media.provider_id == message_id)
    )


def _header(message: email.message.Message, name: str) -> str | None:
    """One decoded header value; ``email.policy.default`` already un-encodes RFC 2047."""
    value = message.get(name)
    return str(value) if value is not None else None


def _sender(message: email.message.Message) -> tuple[str, str] | None:
    """``(display name, normalized address)`` from ``From:``, or ``None``.

    The full address never becomes the display name: with no usable display
    name the sanitized local part is used instead.
    """
    display_name, address = parseaddr(_header(message, "From") or "")
    address = address.strip().lower()
    if not address or "@" not in address:
        return None
    local_part = address.split("@")[0]
    candidate = (display_name or "").strip()
    if not candidate or "@" in candidate:
        candidate = local_part
    return clean_contributor_display(candidate) or local_part, address


def _sender_observation(sender_name: str, sender_address: str) -> ContributorObservationBatch:
    """The sender display keyed on the normalized address, never on display text."""
    batch, _truncated = build_observation(
        {
            "author": [
                RawCreditEntry(
                    credited_name=sender_name,
                    identity_claims=(RawIdentityClaim("email_address", sender_address),),
                )
            ]
        }
    )
    return batch


def _publication_date(value: str | None) -> Presence[PublicationDate]:
    if value is None:
        return absent()
    try:
        parsed = parsedate_to_datetime(value)
    # justify-ignore-error: a malformed external MIME date is an absent observation.
    except (TypeError, ValueError, IndexError):
        return absent()
    if parsed.tzinfo is None:
        if not value.rstrip().endswith("-0000"):
            return absent()
        parsed = parsed.replace(tzinfo=UTC)
    return normalize_source_publication_date(parsed.isoformat())


def _readable_html(message: email.message.Message) -> str:
    """The first ``text/html`` part, else the ``text/plain`` part wrapped in ``<pre>``."""
    html_part, text_part = _walk_mime(message, depth=0, budget=[_MAX_MIME_PARTS])
    if html_part is not None:
        return html_part
    if text_part is not None:
        return f"<pre>{html_lib.escape(text_part)}</pre>"
    return ""


def _walk_mime(
    message: email.message.Message, *, depth: int, budget: list[int]
) -> tuple[str | None, str | None]:
    """Depth- and count-capped walk returning the best HTML and plain-text parts."""
    if depth > _MAX_MIME_DEPTH or budget[0] <= 0:
        return None, None
    budget[0] -= 1
    if message.is_multipart():
        html_part: str | None = None
        text_part: str | None = None
        for part in message.get_payload():
            if not isinstance(part, email.message.Message):
                continue
            nested_html, nested_text = _walk_mime(part, depth=depth + 1, budget=budget)
            html_part = html_part or nested_html
            text_part = text_part or nested_text
            if html_part is not None:
                return html_part, text_part
        return html_part, text_part
    content_type = message.get_content_type()
    if content_type == "text/html":
        return _decoded_part(message), None
    if content_type == "text/plain":
        return None, _decoded_part(message)
    return None, None


def _decoded_part(message: email.message.Message) -> str | None:
    payload = message.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return None
    try:
        return payload.decode(message.get_content_charset() or "utf-8", errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")
