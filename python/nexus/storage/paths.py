"""Storage path building utilities.

This module provides the single point of logic for building storage paths.
All path construction must go through these functions to ensure
canonical object key construction.

Path Invariants:
    - Media original: media/{media_id}/original.{ext}
    - Upload staging: uploads/media/{media_id}/original.{ext}
    - EPUB asset: media/{media_id}/assets/{asset_key}
    - Oracle plate: oracle/plates/{sha256}.{ext}

Rules:
    - No leading slash
    - No user identifiers in paths
    - Storage paths are independent of test environment state
"""

import re
from uuid import UUID


def get_file_extension(kind: str) -> str:
    """Get the file extension for a media kind.

    Args:
        kind: Media kind (pdf, epub).

    Returns:
        File extension without leading dot.

    Raises:
        ValueError: If kind is not a file-backed media type.
    """
    extensions = {
        "pdf": "pdf",
        "epub": "epub",
    }
    if kind not in extensions:
        raise ValueError(f"Kind '{kind}' is not a file-backed media type")
    return extensions[kind]


def build_storage_path(media_id: UUID | str, ext: str) -> str:
    """Build the full storage path for a media file.

    Called by upload/init and test fixtures.

    Args:
        media_id: The media UUID.
        ext: File extension (without leading dot).

    Returns:
        Full storage path: "media/{media_id}/original.{ext}"

    Example:
        >>> build_storage_path(uuid4(), "pdf")
        'media/abc123.../original.pdf'
    """
    return f"media/{media_id}/original.{ext}"


def build_upload_staging_storage_path(media_id: UUID | str, ext: str) -> str:
    """Build the private staging path used only by direct browser uploads."""
    return f"uploads/media/{media_id}/original.{ext}"


def build_epub_asset_storage_path(media_id: UUID | str, asset_key: str) -> str:
    """Build the full storage path for a persisted EPUB resource asset."""
    if not asset_key:
        raise ValueError("EPUB asset key must be non-empty.")
    if asset_key.startswith("/"):
        raise ValueError("EPUB asset key must not start with a slash.")
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise ValueError("EPUB asset key must not contain empty, dot, or dot-dot path parts.")
    return f"media/{media_id}/assets/{asset_key}"


PLATE_CONTENT_TYPE_TO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def ext_for_content_type(content_type: str) -> str:
    """Map a plate content-type to its storage extension; raise on unsupported types."""
    ext = PLATE_CONTENT_TYPE_TO_EXT.get(content_type)
    if ext is None:
        raise ValueError(f"unsupported oracle plate content-type: {content_type}")
    return ext


def build_oracle_plate_storage_path(sha256: str, ext: str) -> str:
    """Build the content-addressed storage path for an oracle corpus plate."""
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("oracle plate sha256 must be 64 lowercase hex chars")
    if ext not in set(PLATE_CONTENT_TYPE_TO_EXT.values()):
        raise ValueError("oracle plate ext must be jpg|png|webp")
    return f"oracle/plates/{sha256}.{ext}"
