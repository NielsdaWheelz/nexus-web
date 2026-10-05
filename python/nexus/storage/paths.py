"""Canonical storage object keys. Path shapes are the DB-owner contract."""

import re
from uuid import UUID

_BARE_EXTENSION_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")


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


def build_source_artifact_storage_path(
    media_id: UUID | str, attempt_id: UUID | str, ext: str
) -> str:
    """media/{media_id}/source/{attempt_id}.{ext} — the durable capture artifact."""
    return f"media/{media_id}/source/{attempt_id}.{_require_bare_storage_extension(ext)}"


def build_upload_verification_candidate_storage_path(
    media_id: UUID | str, candidate_id: UUID | str, ext: str
) -> str:
    """The immutable published source of one upload confirmation.

    Fenced by a fresh candidate id, so a stolen or superseded lease never
    overwrites a published source.
    """
    ext = _require_bare_storage_extension(ext)
    return f"media/{media_id}/candidates/{candidate_id}/original.{ext}"


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
