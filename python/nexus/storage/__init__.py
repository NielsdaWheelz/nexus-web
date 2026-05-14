"""Storage module for Cloudflare R2 operations.

Provides:
- StorageClient for interacting with R2 through the S3-compatible API
- Path building utilities for consistent storage paths
- Test isolation support via configurable prefixes
"""

from nexus.storage.client import (
    ObjectMetadata,
    SignedUpload,
    StorageClient,
    get_storage_client,
)
from nexus.storage.paths import (
    build_epub_asset_storage_path,
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)

__all__ = [
    "StorageClient",
    "SignedUpload",
    "ObjectMetadata",
    "get_storage_client",
    "build_epub_asset_storage_path",
    "build_storage_path",
    "build_upload_staging_storage_path",
    "get_file_extension",
]
