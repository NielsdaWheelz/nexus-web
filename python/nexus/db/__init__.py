"""Database module for Nexus.

Provides engine creation, session management, transaction helpers, and ORM models.
"""

from nexus.db.engine import create_db_engine, get_engine
from nexus.db.models import (
    Base,
    FailureStage,
    Fragment,
    Library,
    LibraryMedia,
    Media,
    MediaFile,
    MediaKind,
    Membership,
    MembershipRole,
    ProcessingStatus,
    User,
)
from nexus.db.session import get_db, transaction

__all__ = [
    # Engine and session
    "create_db_engine",
    "get_engine",
    "get_db",
    "transaction",
    # Base
    "Base",
    # Enums
    "ProcessingStatus",
    "FailureStage",
    "MediaKind",
    "MembershipRole",
    # Models
    "User",
    "Library",
    "Membership",
    "Media",
    "MediaFile",
    "Fragment",
    "LibraryMedia",
]
