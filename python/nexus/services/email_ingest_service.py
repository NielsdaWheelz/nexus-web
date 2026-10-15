"""Post Room: one emailed message becomes one web article in the owner's default library.

Identity is the normalized Message-ID (else a digest of the first 4 KiB); the media's
``(provider, provider_id) = ("email", id)`` is unique, so a redelivery is a no-op that
re-applies the sender credit. The readable html is written to storage first, at a
path named by ids minted here; then media, attempt, library entry and job commit in
one transaction (I11). A failed write answers 5xx and creates nothing; an object a
lost race or a failed commit leaves behind is the storage sweep's.
"""

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
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.ids import new_uuid7
from nexus.schemas.publication_dates import PublicationDate, normalize_source_publication_date
from nexus.services import library_entries
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
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
from nexus.services.suggestion_changes import record_input_change
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path

# MIME walk safety caps: no newsletter legitimately exceeds these.
_MAX_MIME_PARTS = 50
_MAX_MIME_DEPTH = 10


@dataclass(frozen=True, slots=True)
class EmailAcceptance:
    media_id: UUID
    outcome: Literal["accepted", "duplicate"]


def verify_email_signature(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    """Constant-time HMAC-SHA256 of the raw body; a blank secret never verifies."""
    if not secret or not signature_header:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip().lower())


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
    """Accept one MIME message. Retry rule: its Message-ID maps to one media."""
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
    if (existing := _media_for(db, message_id)) is not None:
        return _credit(existing, observation, "duplicate")
    if sender is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Email has no valid From header.")

    db.rollback()  # no transaction spans the object-store write
    media_id, attempt_id = new_uuid7(), new_uuid7()
    path = build_source_artifact_storage_path(media_id, attempt_id, "html")
    try:
        get_storage_client().put_object(
            path, _readable_html(message).encode("utf-8"), "text/html; charset=utf-8"
        )
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_STORAGE_ERROR, "Post Room storage is unavailable.") from exc
    now = datetime.now(UTC)
    try:
        with transaction(db):
            media = Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=(_header(message, "Subject") or "").strip()[:255] or "Untitled",
                provider="email",
                provider_id=message_id,
                processing_status=ProcessingStatus.pending,
                created_by_user_id=owner_user_id,
                created_at=now,
                updated_at=now,
                edition_published_date=_publication_date(_header(message, "Date")),
            )
            db.add(media)
            db.flush()
            attempt = sa.create_attempt(
                db,
                id=attempt_id,
                media=media,
                actor_id=owner_user_id,
                source_type=st.EMAIL_MESSAGE,
                requested_url=None,
                canonical_source_url=None,
                provider="email",
                provider_target_ref=message_id,
                payload={"storage_path": path},
            )
            library_entries.ensure_media_in_default_library(db, owner_user_id, media_id)
            sa.enqueue_attempt(db, attempt, actor_id=owner_user_id, request_id=request_id)
            record_input_change(db)
    except IntegrityError:
        # a concurrent delivery of this Message-ID committed first: the index decides
        if (raced := _media_for(db, message_id)) is None:
            raise
        return _credit(raced, observation, "duplicate")
    return _credit(media_id, observation, "accepted")


def _credit(
    media_id: UUID,
    observation: ContributorObservationBatch,
    outcome: Literal["accepted", "duplicate"],
) -> EmailAcceptance:
    """The sender credit, after commit; re-applying it is a no-op, so redeliveries converge."""
    replace_observed_role_slices_batch(((MediaTarget(media_id), observation, "email"),))
    return EmailAcceptance(media_id=media_id, outcome=outcome)


def _media_for(db: Session, message_id: str) -> UUID | None:
    return db.scalar(
        select(Media.id).where(Media.provider == "email", Media.provider_id == message_id)
    )


def _header(message: email.message.Message, name: str) -> str | None:
    """One decoded header; ``email.policy.default`` already un-encodes RFC 2047."""
    value = message.get(name)
    return str(value) if value is not None else None


def _sender(message: email.message.Message) -> tuple[str, str] | None:
    """``(display name, normalized address)`` from From:; never the address as a name."""
    display_name, address = parseaddr(_header(message, "From") or "")
    address = address.strip().lower()
    if "@" not in address:
        return None
    local_part = address.split("@")[0]
    candidate = display_name.strip()
    if not candidate or "@" in candidate:
        candidate = local_part
    return clean_contributor_display(candidate) or local_part, address


def _sender_observation(name: str, address: str) -> ContributorObservationBatch:
    """The sender keyed on the normalized address, never on display text."""
    batch, _truncated = build_observation(
        {
            "author": [
                RawCreditEntry(
                    credited_name=name,
                    identity_claims=(RawIdentityClaim("email_address", address),),
                )
            ]
        }
    )
    return batch


def _publication_date(value: str | None) -> PublicationDate | None:
    if value is None:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    # justify-ignore-error: a malformed external MIME date is an absent observation.
    except (TypeError, ValueError, IndexError):
        return None
    if parsed.tzinfo is None:
        if not value.rstrip().endswith("-0000"):
            return None
        parsed = parsed.replace(tzinfo=UTC)
    return normalize_source_publication_date(parsed.isoformat())


def _readable_html(message: email.message.Message) -> str:
    """The first ``text/html`` part, else the ``text/plain`` part in ``<pre>``, else ""."""
    html_part, text_part = _walk(message, depth=0, budget=[_MAX_MIME_PARTS])
    if html_part is not None:
        return html_part
    return f"<pre>{html_lib.escape(text_part)}</pre>" if text_part is not None else ""


def _walk(
    message: email.message.Message, *, depth: int, budget: list[int]
) -> tuple[str | None, str | None]:
    """A depth- and count-capped walk for the best html and plain-text parts."""
    if depth > _MAX_MIME_DEPTH or budget[0] <= 0:
        return None, None
    budget[0] -= 1
    if not message.is_multipart():
        kind = message.get_content_type()
        if kind == "text/html":
            return _decoded(message), None
        return None, _decoded(message) if kind == "text/plain" else None
    html_part: str | None = None
    text_part: str | None = None
    for part in message.get_payload():
        if not isinstance(part, email.message.Message):
            continue
        nested_html, nested_text = _walk(part, depth=depth + 1, budget=budget)
        html_part, text_part = html_part or nested_html, text_part or nested_text
        if html_part is not None:
            break
    return html_part, text_part


def _decoded(message: email.message.Message) -> str | None:
    payload = message.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return None
    try:
        return payload.decode(message.get_content_charset() or "utf-8", errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")
