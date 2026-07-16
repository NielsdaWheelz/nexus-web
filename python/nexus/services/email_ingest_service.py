"""Post Room: email ingest service — HMAC verify, MIME parse, accept."""

from __future__ import annotations

import email
import email.headerregistry
import email.message
import email.policy
import hashlib
import hmac
from datetime import UTC, datetime
from email.utils import parseaddr, parsedate_to_datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services import library_entries
from nexus.services import media_source_types as source_types
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
    display_contributor_name,
)
from nexus.services.contributors import MediaTarget, replace_observed_role_slices
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path

# MIME walk safety caps — no newsletter legitimately exceeds these.
_MAX_MIME_PARTS = 50
_MAX_MIME_DEPTH = 10

# Minimal HTML wrapper for plain-text-only messages (D-5).
_PLAIN_TEXT_WRAP = "<pre>{body}</pre>"


def verify_email_signature(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    """Constant-time HMAC-SHA256 verification of the Cloudflare worker signature.

    Returns True on success. A blank secret is a config error, not a valid key.
    Never raises — caller checks the return value and returns 401.
    """
    if not secret or not signature_header:
        return False
    try:
        expected = hmac.new(
            secret.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature_header.strip().lower())
    except Exception:
        return False


def normalize_message_id(raw: str | None) -> str | None:
    """Strip angle brackets, lowercase host, strip whitespace. Returns None if blank."""
    if not raw:
        return None
    mid = raw.strip()
    if mid.startswith("<") and mid.endswith(">"):
        mid = mid[1:-1]
    if "@" in mid:
        local, host = mid.split("@", 1)
        mid = f"{local}@{host.lower()}"
    return mid.strip() or None


def _synthesize_message_id(raw_body: bytes) -> str:
    """Synthesize a deterministic Message-ID from body hash when absent (R-5)."""
    digest = hashlib.sha256(raw_body[:4096]).hexdigest()
    return f"synthesized-{digest}"


def _walk_mime(
    msg: email.message.Message,
    *,
    depth: int,
    count: list[int],
    html_out: list[str | None],
    text_out: list[str | None],
) -> None:
    """Recursive MIME walk with depth/count caps. Populates html_out and text_out."""
    if depth > _MAX_MIME_DEPTH:
        return
    count[0] += 1
    if count[0] > _MAX_MIME_PARTS:
        return

    content_type = msg.get_content_type()
    if msg.is_multipart():
        for part in msg.get_payload(decode=False):  # type: ignore[call-overload]
            if not isinstance(part, email.message.Message):
                continue
            _walk_mime(part, depth=depth + 1, count=count, html_out=html_out, text_out=text_out)
            if html_out[0] is not None:
                return  # prefer first html part found
    elif content_type == "text/html" and html_out[0] is None:
        payload = msg.get_payload(decode=True)
        if isinstance(payload, bytes):
            charset = msg.get_content_charset() or "utf-8"
            try:
                html_out[0] = payload.decode(charset, errors="replace")
            except Exception:
                html_out[0] = payload.decode("utf-8", errors="replace")
    elif content_type == "text/plain" and text_out[0] is None:
        payload = msg.get_payload(decode=True)
        if isinstance(payload, bytes):
            charset = msg.get_content_charset() or "utf-8"
            try:
                text_out[0] = payload.decode(charset, errors="replace")
            except Exception:
                text_out[0] = payload.decode("utf-8", errors="replace")


def _decode_header_str(value: object) -> str | None:
    """Decode a potentially RFC2047-encoded header value to a plain str."""
    if value is None:
        return None
    from email.header import decode_header

    raw_str = str(value)
    try:
        parts = decode_header(raw_str)
        decoded_parts: list[str] = []
        for part_bytes, charset in parts:
            if isinstance(part_bytes, bytes):
                decoded_parts.append(part_bytes.decode(charset or "utf-8", errors="replace"))
            else:
                decoded_parts.append(str(part_bytes))
        return "".join(decoded_parts) or None
    except Exception:
        return raw_str or None


def extract_email_html(raw_body: bytes) -> tuple[str, str | None, str | None]:
    """Parse MIME, prefer text/html, fall back to wrapped text/plain.

    Returns (html, subject, published_date_iso). Raises InvalidRequestError when
    the message cannot be parsed or has no readable text content.
    """
    try:
        msg = email.message_from_bytes(raw_body, policy=email.policy.default)
    except Exception as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "MIME message could not be parsed.",
        ) from exc

    subject = _decode_header_str(msg.get("Subject"))
    date_str = msg.get("Date")
    published_date: str | None = None
    if date_str:
        try:
            dt = parsedate_to_datetime(str(date_str))
            published_date = dt.astimezone(UTC).date().isoformat()
        except Exception:
            pass

    html_acc: list[str | None] = [None]
    text_acc: list[str | None] = [None]
    _walk_mime(msg, depth=0, count=[0], html_out=html_acc, text_out=text_acc)

    if html_acc[0] is not None:
        return html_acc[0], subject, published_date
    if text_acc[0] is not None:
        import html as html_module

        return (
            _PLAIN_TEXT_WRAP.format(body=html_module.escape(text_acc[0])),
            subject,
            published_date,
        )

    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST,
        "Email has no readable text content.",
    )


def _parse_from_header(msg: email.message.Message) -> tuple[str, str] | None:
    """Return (display_name, normalized_address) from From:, or None if absent/unparseable.

    The full address never becomes the display name (spec 5 privacy rule): when the
    header carries no display name — or a display name that is itself an address —
    the sanitized local part is used instead.
    """
    from_header = msg.get("From", "")
    display_name_raw, addr = parseaddr(str(from_header))
    addr = addr.strip().lower()
    if not addr or "@" not in addr:
        return None
    local_part = addr.split("@")[0]
    candidate = (display_name_raw or "").strip()
    if not candidate or "@" in candidate:
        candidate = local_part
    name = display_contributor_name(candidate) or local_part
    return name, addr


def _build_email_sender_observation(
    sender_name: str, sender_address: str
) -> ContributorObservationBatch:
    """Sender display (never the full address) + ``email_address`` key -> ``{author}``.

    The normalized address is the exact identity key so two issues from the same
    sender resolve to one contributor; it is a key only, never display/alias text.
    """
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


def _apply_email_sender_credit(media_id: UUID, observation: ContributorObservationBatch) -> None:
    """Run the fresh-session author mutation for a resolved email media id.

    ``NOT_OBSERVED`` is a no-op. Safe to re-run on the duplicate path: the resolver
    performs no DML when the persisted author facts already match (D-27).
    """
    replace_observed_role_slices(
        target=MediaTarget(media_id),
        observation=observation,
        source="email",
    )


class EmailAcceptance:
    """Result of a successful accept_email_message call."""

    def __init__(self, *, media_id: UUID, outcome: str) -> None:
        self.media_id = media_id
        self.outcome = outcome


def accept_email_message(
    *,
    db: Session,
    raw_body: bytes,
    owner_user_id: UUID,
    request_id: str | None,
) -> EmailAcceptance:
    """Parse a MIME message and accept it into the ingest pipeline.

    Dedupes by Message-ID at the Media layer before any attempt is created
    (AC-2). Stores extracted HTML to R2, creates Media + MediaSourceAttempt,
    lands the media in the owner's default library, resolves the sender as a
    contributor (authority='email'), and enqueues the ingest job.

    Returns EmailAcceptance with outcome='accepted' or 'duplicate'.
    """
    from nexus.services.media_source_ingest import (
        build_intent_key,
        create_attempt,
        enqueue_accepted_source_attempt,
    )

    # --- Parse (minimal: just headers needed for dedupe/metadata) ---
    try:
        msg = email.message_from_bytes(raw_body, policy=email.policy.default)
    except Exception as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "MIME message could not be parsed.",
        ) from exc

    raw_mid = msg.get("Message-ID")
    message_id = normalize_message_id(str(raw_mid) if raw_mid else None)
    if message_id is None:
        message_id = _synthesize_message_id(raw_body)

    # Build the sender author observation up front so the author op runs on every
    # path, including the duplicate short-circuit (D-27).
    from_pair = _parse_from_header(msg)
    author_observation: ContributorObservationBatch = (
        _build_email_sender_observation(*from_pair) if from_pair is not None else NOT_OBSERVED
    )

    # --- Dedupe at Media layer (AC-2: before any attempt is created) ---
    existing = db.execute(
        select(Media).where(
            Media.provider == "email",
            Media.provider_id == message_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        # A first attempt may have crashed after the media commit but before the
        # author op; the provider retry lands here. Re-run it (same Message-ID =>
        # same observation => no DML) so the credit is never lost (D-27).
        _apply_email_sender_credit(existing.id, author_observation)
        return EmailAcceptance(media_id=existing.id, outcome="duplicate")

    # --- Extract HTML and metadata ---
    html_acc: list[str | None] = [None]
    text_acc: list[str | None] = [None]
    _walk_mime(msg, depth=0, count=[0], html_out=html_acc, text_out=text_acc)

    if html_acc[0] is not None:
        html_content = html_acc[0]
    elif text_acc[0] is not None:
        import html as html_module

        html_content = _PLAIN_TEXT_WRAP.format(body=html_module.escape(text_acc[0]))
    else:
        # No text content — accepted but will fail at extract stage (AC-8 / §2).
        html_content = ""

    subject = _decode_header_str(msg.get("Subject")) or "Untitled"
    date_str = msg.get("Date")
    published_date: str | None = None
    if date_str:
        try:
            dt = parsedate_to_datetime(str(date_str))
            published_date = dt.astimezone(UTC).date().isoformat()
        except Exception:
            pass

    if from_pair is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Email has no valid From: header.",
        )
    sender_name, sender_address = from_pair

    # --- Create Media ---
    now = datetime.now(UTC)
    media = Media(
        kind=MediaKind.web_article.value,
        title=subject.strip()[:255] or "Untitled",
        requested_url=None,
        canonical_url=None,
        canonical_source_url=None,
        provider="email",
        provider_id=message_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=owner_user_id,
        created_at=now,
        updated_at=now,
        published_date=published_date,
    )
    db.add(media)
    try:
        db.flush()
    except IntegrityError:
        # Concurrent duplicate delivery (D-6): another request committed the same
        # Message-ID between our dedupe SELECT and this INSERT (uix_media_email_provider_id).
        # Idempotent no-op — surface it as a duplicate, never a 500 bounce.
        db.rollback()
        raced = db.execute(
            select(Media).where(
                Media.provider == "email",
                Media.provider_id == message_id,
            )
        ).scalar_one_or_none()
        if raced is not None:
            _apply_email_sender_credit(raced.id, author_observation)
            return EmailAcceptance(media_id=raced.id, outcome="duplicate")
        raise

    # --- Create MediaSourceAttempt ---
    intent_key = build_intent_key(source_types.EMAIL_MESSAGE, message_id, None)
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=owner_user_id,
        source_type=source_types.EMAIL_MESSAGE,
        intent_key=intent_key,
        requested_url=None,
        canonical_source_url=None,
        provider="email",
        provider_target_ref=message_id,
        source_payload={
            "message_id": message_id,
            "sender_name": sender_name,
            "sender_address": sender_address,
            "subject": subject,
            "published_date": published_date,
        },
        request_id=request_id,
        idempotency_key=None,
        status="accepted",
    )

    # Store derived HTML to R2.
    html_bytes = html_content.encode("utf-8")
    storage_path = build_source_artifact_storage_path(media.id, attempt.id, "html")
    attempt.source_payload = {
        **dict(attempt.source_payload or {}),
        "storage_path": storage_path,
        "content_type": "text/html; charset=utf-8",
        "size_bytes": len(html_bytes),
        "has_content": bool(html_content),
    }

    # Land in owner's default library.
    library_entries.ensure_media_in_default_library(db, owner_user_id, media.id)
    db.commit()

    # Fresh-session author op right after the media transaction commits, before
    # upload/enqueue, so the sender credit survives a later storage failure and
    # the duplicate-path retry converges (D-27).
    _apply_email_sender_credit(media.id, author_observation)

    # Upload HTML to R2.
    storage_client = get_storage_client()
    try:
        storage_client.put_object(storage_path, html_bytes, "text/html; charset=utf-8")
    except StorageError as exc:
        from nexus.services.media_processing_state import mark_failed

        db.rollback()
        media_obj = db.get(Media, media.id)
        if media_obj is not None:
            mark_failed(
                db,
                media_obj,
                stage="upload",
                error_code=ApiErrorCode.E_STORAGE_ERROR.value,
                error_message=str(exc),
            )
        return EmailAcceptance(media_id=media.id, outcome="accepted")

    # Enqueue ingest job (public spine wrapper; failure_stage='extract').
    enqueue_accepted_source_attempt(
        db,
        media_id=media.id,
        attempt_id=attempt.id,
        actor_user_id=owner_user_id,
        request_id=request_id,
    )

    return EmailAcceptance(media_id=media.id, outcome="accepted")
