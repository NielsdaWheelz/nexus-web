"""Business logic services.

This module contains service-layer functions that implement business logic.
Services are called by route handlers and orchestrate database operations.
"""

from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media import (
    can_read_media,
    get_media_for_viewer,
    list_fragments_for_viewer,
)

__all__ = [
    "ensure_user_and_default_library",
    "get_media_for_viewer",
    "list_fragments_for_viewer",
    "can_read_media",
]
