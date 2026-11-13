"""One private email receipt admits one body into its owner's All library.

Receipt identity outlives content: removal nulls its media pointer and redelivery
stays suppressed. Storage is written once before the serializable publication of
receipt, media, attempt, holding and job; the ordinary sweep owns unused objects.
"""

from __future__ import annotations

import email
import email.errors
import email.message
import email.policy
import hashlib
import hmac
import html as html_lib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parseaddr, parsedate_to_datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from nexus.config import Settings
from nexus.db.models import EmailIngestReceipt, Media, MediaKind, ProcessingStatus
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.ids import new_uuid7
from nexus.schemas.media_sources import (
    EmailAcceptance,
    EmailAccepted,
    EmailProvenance,
    EmailSourcePayload,
    EmailSuppressed,
)
from nexus.services import library_entries, users
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.storage.client import get_storage_client
from nexus.storage.errors import StorageError
from nexus.storage.paths import build_source_artifact_storage_path

EMAIL_INGEST_MAX_BYTES = 2 * 1024 * 1024
_MAX_MIME_PARTS = 50
_MAX_MIME_DEPTH = 10


@dataclass(frozen=True, slots=True)
class EmailIngestConfig:
    secret: str
    owner_user_id: UUID
    address: str


def canonical_email_recipient(raw: str) -> str | None:
    """The narrow receiving mailbox grammar, separate from MIME sender addresses."""
    address = raw.strip().lower()
    if len(address) > 254 or address.count("@") != 1:
        return None
    slug, domain = address.split("@")
    labels = domain.split(".")
    if (
        re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug) is None
        or len(domain) > 253
        or len(labels) < 2
        or any(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) is None for label in labels
        )
    ):
        return None
    return address


def resolve_email_ingest_config(settings: Settings) -> EmailIngestConfig | None:
    """Partial/invalid optional configuration disables email without disabling nexus."""
    secret = settings.email_ingest_hmac_secret
    slug, domain = settings.email_ingest_address_slug, settings.email_ingest_domain
    owner = settings.email_ingest_owner_user_id
    if not (secret and secret.strip() and slug and domain and owner):
        return None
    address = canonical_email_recipient(f"{slug.strip()}@{domain.strip()}")
    if address is None:
        return None
    try:
        owner_user_id = UUID(owner.strip())
    except ValueError:
        return None
    return EmailIngestConfig(secret=secret, owner_user_id=owner_user_id, address=address)


def verify_email_signature(
    raw_body: bytes,
    signature_header: str | None,
    secret: str,
    *,
    recipient: str,
    wire_revision: str,
) -> bool:
    """Authenticate the wire revision, canonical full recipient and exact MIME bytes."""
    if not secret.strip() or not signature_header:
        return False
    signature = signature_header.strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", signature) is None:
        return False
    signed = f"nexus-email\n{wire_revision}\n{recipient}\n".encode() + raw_body
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def normalize_message_id(raw: str | None) -> str | None:
    """Without angle brackets, its host lowercased; ``None`` when blank."""
    value = (raw or "").strip()
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1]
    if "@" in value:
        local, host = value.split("@", 1)
        value = f"{local}@{host.lower()}"
    return value.strip() or None


def accept_email_message(
    *, db: Session, raw_body: bytes, owner_user_id: UUID, request_id: str | None
) -> EmailAcceptance:
    """Admit once per owner/message identity; a receipt never re-files its content."""
    try:
        message = email.message_from_bytes(raw_body, policy=email.policy.default)
    except (email.errors.MessageError, ValueError, RecursionError) as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "MIME message could not be parsed."
        ) from exc
    assert isinstance(message, email.message.EmailMessage)  # policy.default's message factory
    message_id = normalize_message_id(_header(message, "Message-ID"))
    identity = (
        b"message-id\0" + message_id.encode("utf-8")
        if message_id is not None
        else b"raw-mime\0" + raw_body
    )
    message_key = hashlib.sha256(identity).hexdigest()
    if (existing := _receipt_for(db, owner_user_id, message_key)) is not None:
        return existing
    sender_name, sender_address = _sender(message)
    body = _readable_html(message).encode("utf-8")
    provenance = EmailProvenance(
        sender_name=sender_name,
        sender_address=sender_address,
        sent_at=_sent_at(_header(message, "Date")),
    )
    db.rollback()  # no database transaction spans storage
    media_id, attempt_id, receipt_id = new_uuid7(), new_uuid7(), new_uuid7()
    path = build_source_artifact_storage_path(media_id, attempt_id, "html")
    try:
        get_storage_client().put_object(path, body, "text/html; charset=utf-8")
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Email storage is unavailable.") from exc

    def publish() -> EmailAcceptance:
        users.lock_viewer(db, owner_user_id)
        if (existing := _receipt_for(db, owner_user_id, message_key)) is not None:
            return existing
        media = Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title=(_header(message, "Subject") or "").strip()[:255] or "Untitled",
            provider="email",
            provider_id=None,
            processing_status=ProcessingStatus.pending,
            created_by_user_id=owner_user_id,
        )
        db.add(media)
        db.flush()
        db.add(
            EmailIngestReceipt(
                id=receipt_id,
                owner_user_id=owner_user_id,
                message_key=message_key,
                media_id=media_id,
            )
        )
        projection.refresh(db, "media", [media_id])
        attempt = sa.create_attempt(
            db,
            id=attempt_id,
            media=media,
            actor_id=owner_user_id,
            source_type=st.EMAIL_MESSAGE,
            requested_url=None,
            canonical_source_url=None,
            provider="email",
            provider_target_ref=None,
            payload=EmailSourcePayload(storage_path=path, provenance=provenance).model_dump(
                mode="json"
            ),
        )
        library_entries.ensure_media_in_default_library(db, owner_user_id, media_id)
        sa.enqueue_attempt(db, attempt, actor_id=owner_user_id, request_id=request_id)
        db.flush()
        record_input_change(db, owners=(f"media:{media_id}",))
        return EmailAccepted(media_id=media_id, outcome="accepted")

    return retry_serializable(db, "email.accept", publish)


def suppress_email_receipt(db: Session, *, owner_user_id: UUID, media_id: UUID) -> None:
    """Personal removal participant; caller has passed guards and holds viewer/media locks."""
    db.execute(
        update(EmailIngestReceipt)
        .where(
            EmailIngestReceipt.owner_user_id == owner_user_id,
            EmailIngestReceipt.media_id == media_id,
        )
        .values(media_id=None)
    )


def detach_email_receipts(db: Session, media_id: UUID) -> None:
    """Content teardown participant; caller holds the media lock and owns commit."""
    db.execute(
        update(EmailIngestReceipt)
        .where(EmailIngestReceipt.media_id == media_id)
        .values(media_id=None)
    )


def _receipt_for(db: Session, owner_user_id: UUID, message_key: str) -> EmailAcceptance | None:
    receipt = db.scalars(
        select(EmailIngestReceipt).where(
            EmailIngestReceipt.owner_user_id == owner_user_id,
            EmailIngestReceipt.message_key == message_key,
        )
    ).one_or_none()
    if receipt is None:
        return None
    if receipt.media_id is None:
        return EmailSuppressed(outcome="suppressed", media_id=None)
    return EmailAccepted(outcome="duplicate", media_id=receipt.media_id)


def _header(message: email.message.Message, name: str) -> str | None:
    """One decoded header; ``email.policy.default`` already un-encodes RFC 2047."""
    value = message.get(name)
    return str(value) if value is not None else None


def _sender(message: email.message.Message) -> tuple[str | None, str]:
    display_name, address = parseaddr(_header(message, "From") or "")
    local, separator, domain = address.strip().rpartition("@")
    if not (local and separator and domain):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Email has no valid From header.")
    return display_name.strip() or None, f"{local}@{domain.lower()}"


def _sent_at(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            if not value.rstrip().endswith("-0000"):
                return None
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    # justify-ignore-error: malformed or unrepresentable external dates are absent observations.
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def _readable_html(message: email.message.EmailMessage) -> str:
    """Bound the entire tree before selecting an inline MIME body, never an attachment."""
    parts: list[tuple[email.message.MIMEPart, int]] = [(message, 0)]
    count = 0
    while parts:
        part, depth = parts.pop()
        count += 1
        if count > _MAX_MIME_PARTS or depth > _MAX_MIME_DEPTH:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Email MIME structure is too large."
            )
        parts.extend((child, depth + 1) for child in part.iter_parts())
    for kind in ("html", "plain"):
        part = message.get_body((kind,))
        if part is None:
            continue
        body = _decoded(part)
        if body is not None and body.strip():
            return body if kind == "html" else f"<pre>{html_lib.escape(body)}</pre>"
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Email has no supported inline body.")


def _decoded(message: email.message.Message) -> str | None:
    payload = message.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return None
    try:
        return payload.decode(message.get_content_charset() or "utf-8", errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")
