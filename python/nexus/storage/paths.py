"""Object keys, built from owner ids and our own constant extensions; a key is never a
content hash or a user identity. The row named beside each builder owns the object; the
orphan sweep reclaims anything under ``media/`` that no row names."""

from uuid import UUID


def get_file_extension(kind: str) -> str:
    """The extension of a file-backed media kind."""
    if kind not in ("pdf", "epub"):
        raise ValueError(f"Kind '{kind}' is not a file-backed media type")
    return kind


def build_source_artifact_storage_path(
    media_id: UUID | str, attempt_id: UUID | str, ext: str
) -> str:
    """An attempt's stored source: ``source_payload.storage_path`` or a ``media_file``."""
    return f"media/{media_id}/source/{attempt_id}.{ext}"


def build_upload_verification_candidate_storage_path(
    media_id: UUID | str, candidate_id: UUID | str, ext: str
) -> str:
    """One confirmation's published source (``media_file`` or a packet attempt); a fresh
    candidate id per confirmation, so nothing published is ever overwritten."""
    return f"media/{media_id}/candidates/{candidate_id}/original.{ext}"


def build_upload_session_staging_storage_path(
    session_id: UUID | str, generation: int, ext: str
) -> str:
    """A session generation's staged bytes; only the R2 one-day ``uploads/`` rule deletes them."""
    return f"uploads/sessions/{session_id}/{generation}/original.{ext}"


def build_epub_attempt_asset_storage_path(
    media_id: UUID | str, attempt_id: UUID | str, asset_key: str
) -> str:
    """An ``epub_resources`` row's object. The key comes from the archive, so it is checked."""
    if asset_key.startswith("/") or any(p in ("", ".", "..") for p in asset_key.split("/")):
        raise ValueError(f"unsafe EPUB asset key: {asset_key!r}")
    return f"media/{media_id}/source/{attempt_id}/assets/{asset_key}"


def build_reading_copy_storage_path(media_id: UUID, copy_id: UUID) -> str:
    """An offline reading copy. No row owns it: the sweep reclaims it after its min age."""
    return f"media/{media_id}/reading-copies/{copy_id}.zip"
