"""Storage path building utilities.

This module provides the single point of logic for building storage paths.
All path construction must go through these functions to ensure
consistent prefix handling between production and test environments.

Path Invariants:
    - Production: media/{media_id}/original.{ext}
    - Production upload staging: uploads/media/{media_id}/original.{ext}
    - Production EPUB asset: media/{media_id}/assets/{asset_key}
    - Test: test_runs/{run_id}/media/{media_id}/original.{ext}
    - Test upload staging: test_runs/{run_id}/uploads/media/{media_id}/original.{ext}
    - Test EPUB asset: test_runs/{run_id}/media/{media_id}/assets/{asset_key}

Rules:
    - No leading slash
    - No user identifiers in paths
    - Prefix applied exactly once by the path builder
"""

import os
import re
from uuid import UUID

# Environment variable for test run prefix
TEST_PREFIX_ENV_VAR = "STORAGE_TEST_PREFIX"
TEST_PREFIX_PATTERN = re.compile(r"^test_runs/[A-Za-z0-9._-]+/?$")


def _get_test_prefix() -> str:
    """Get the test prefix from environment.

    Returns:
        Empty string in production, "test_runs/{run_id}/" in test.

    Note:
        This function should only be called by storage path builders.
        The prefix must be test_runs/{run_id} with an optional trailing slash.
    """
    prefix = os.environ.get(TEST_PREFIX_ENV_VAR, "")
    if not prefix:
        return ""

    if not TEST_PREFIX_PATTERN.fullmatch(prefix):
        raise ValueError(
            "STORAGE_TEST_PREFIX must be test_runs/<run-id> using only letters, "
            "numbers, '.', '_' or '-', with no leading slash."
        )

    run_id = prefix.removeprefix("test_runs/").rstrip("/")
    if not run_id or run_id in {".", ".."} or ".." in run_id:
        raise ValueError(
            "STORAGE_TEST_PREFIX must include a non-empty run id without path traversal."
        )

    return prefix if prefix.endswith("/") else f"{prefix}/"


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
        Full storage path:
        - Production: "media/{media_id}/original.{ext}"
        - Test: "test_runs/{run_id}/media/{media_id}/original.{ext}"

    Example:
        >>> build_storage_path(uuid4(), "pdf")
        'media/abc123.../original.pdf'
    """
    prefix = _get_test_prefix()
    return f"{prefix}media/{media_id}/original.{ext}"


def build_upload_staging_storage_path(media_id: UUID | str, ext: str) -> str:
    """Build the private staging path used only by direct browser uploads."""
    prefix = _get_test_prefix()
    return f"{prefix}uploads/media/{media_id}/original.{ext}"


def build_epub_asset_storage_path(media_id: UUID | str, asset_key: str) -> str:
    """Build the full storage path for a persisted EPUB resource asset."""
    if not asset_key:
        raise ValueError("EPUB asset key must be non-empty.")
    if asset_key.startswith("/"):
        raise ValueError("EPUB asset key must not start with a slash.")
    if any(part in {"", ".", ".."} for part in asset_key.split("/")):
        raise ValueError("EPUB asset key must not contain empty, dot, or dot-dot path parts.")
    prefix = _get_test_prefix()
    return f"{prefix}media/{media_id}/assets/{asset_key}"


def parse_storage_path(path: str) -> tuple[str | None, str]:
    """Parse a storage path to extract media_id and extension.

    Args:
        path: Full storage path.

    Returns:
        Tuple of (media_id_str, extension).
        media_id_str may be None if path doesn't match expected pattern.
    """
    # Remove any test prefix
    path = path.lstrip("/")
    if path.startswith("test_runs/"):
        # Skip test_runs/{run_id}/ prefix
        parts = path.split("/", 2)
        if len(parts) > 2:
            path = parts[2]

    # Now path should be "media/{media_id}/original.{ext}"
    if path.startswith("media/"):
        path = path[6:]  # Remove "media/"

    # Extract media_id and filename
    parts = path.split("/")
    if len(parts) >= 2:
        media_id_str = parts[0]
        filename = parts[1]
        if filename.startswith("original."):
            ext = filename[9:]  # Remove "original."
            return media_id_str, ext

    return None, ""
