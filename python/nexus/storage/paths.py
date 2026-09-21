"""Canonical storage object keys. Path shapes are the DB-owner contract."""

import re
from uuid import UUID

_BARE_EXTENSION_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")
_PLATE_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,191}")

PLATE_CONTENT_TYPE_TO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def _require_bare_storage_extension(ext: str) -> str:
    if not _BARE_EXTENSION_RE.fullmatch(ext):
        raise ValueError("Storage extension must be a bare file extension.")
    return ext


def get_file_extension(kind: str) -> str:
    """The storage extension of a file-backed media kind."""
    extensions = {"pdf": "pdf", "epub": "epub"}
    if kind not in extensions:
        raise ValueError(f"Kind '{kind}' is not a file-backed media type")
    return extensions[kind]


def build_storage_path(media_id: UUID | str, ext: str) -> str:
    """media/{media_id}/original.{ext}"""
    return f"media/{media_id}/original.{_require_bare_storage_extension(ext)}"


def build_source_artifact_storage_path(
    media_id: UUID | str, attempt_id: UUID | str, ext: str
) -> str:
    """media/{media_id}/source/{attempt_id}.{ext} — the durable capture artifact."""
    return f"media/{media_id}/source/{attempt_id}.{_require_bare_storage_extension(ext)}"


def build_upload_verification_candidate_storage_path(
    media_id: UUID | str, verification_token: UUID | str, ext: str
) -> str:
    """The verification-token-fenced immutable published source of one upload.

    Fencing by the token, not the media id alone, keeps a stolen or superseded
    lease from ever overwriting a published source.
    """
    ext = _require_bare_storage_extension(ext)
    return f"media/{media_id}/candidates/{verification_token}/original.{ext}"


def build_upload_session_staging_storage_path(
    session_id: UUID | str, generation: int, ext: str
) -> str:
    """The generation-fenced staging path of one direct-upload capability."""
    if generation < 1:
        raise ValueError("Upload generation must be positive.")
    ext = _require_bare_storage_extension(ext)
    return f"uploads/sessions/{session_id}/{generation}/original.{ext}"


def build_epub_attempt_asset_storage_path(
    media_id: UUID | str, attempt_id: UUID | str, asset_key: str
) -> str:
    """An immutable EPUB asset key owned by one source attempt."""
    if not asset_key:
        raise ValueError("EPUB asset key must be non-empty.")
    if asset_key.startswith("/"):
        raise ValueError("EPUB asset key must not start with a slash.")
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise ValueError("EPUB asset key must not contain empty, dot, or dot-dot path parts.")
    return f"media/{media_id}/source/{attempt_id}/assets/{asset_key}"


def ext_for_content_type(content_type: str) -> str:
    """Map a plate content-type to its storage extension."""
    ext = PLATE_CONTENT_TYPE_TO_EXT.get(content_type)
    if ext is None:
        raise ValueError(f"unsupported oracle plate content-type: {content_type}")
    return ext


def build_oracle_plate_storage_path(slug: str, ext: str) -> str:
    """oracle/plates/{slug}.{ext} — the stable current path of a corpus plate."""
    if not _PLATE_SLUG_RE.fullmatch(slug):
        raise ValueError(
            "oracle plate slug must be lowercase letters, numbers, dots, underscores, or hyphens"
        )
    ext = _require_bare_storage_extension(ext)
    if ext not in set(PLATE_CONTENT_TYPE_TO_EXT.values()):
        raise ValueError("oracle plate ext must be jpg|png|webp")
    return f"oracle/plates/{slug}.{ext}"
