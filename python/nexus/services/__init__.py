"""Business logic services.

This module contains service-layer functions that implement business logic.
Services are called by route handlers and orchestrate database operations.
"""

from nexus.services.bootstrap import ensure_user_and_default_library

__all__ = ["ensure_user_and_default_library"]
