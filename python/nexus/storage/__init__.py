"""Storage module for Supabase Storage operations.

Provides:
- StorageClient for interacting with Supabase Storage
- Path building utilities for consistent storage paths
- Test isolation support via configurable prefixes
"""

from nexus.storage.client import (
    FakeStorageClient,
    ObjectMetadata,
    SignedUpload,
    StorageClient,
    get_storage_client,
)
from nexus.storage.paths import build_storage_path, get_file_extension

__all__ = [
    "StorageClient",
    "FakeStorageClient",
    "SignedUpload",
    "ObjectMetadata",
    "get_storage_client",
    "build_storage_path",
    "get_file_extension",
]
