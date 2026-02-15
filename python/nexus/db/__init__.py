"""Database module for Nexus.

Provides engine creation, session management, transaction helpers, and ORM models.
"""

from nexus.db.engine import create_db_engine, get_engine
from nexus.db.models import (
    Base,
    DefaultLibraryBackfillJob,
    DefaultLibraryBackfillJobStatus,
    DefaultLibraryClosureEdge,
    DefaultLibraryIntrinsic,
    FailureStage,
    Fragment,
    Library,
    LibraryInvitation,
    LibraryInvitationRole,
    LibraryInvitationStatus,
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
    # S4 Enums
    "LibraryInvitationRole",
    "LibraryInvitationStatus",
    "DefaultLibraryBackfillJobStatus",
    # Models
    "User",
    "Library",
    "Membership",
    "Media",
    "MediaFile",
    "Fragment",
    "LibraryMedia",
    # S4 Models
    "LibraryInvitation",
    "DefaultLibraryIntrinsic",
    "DefaultLibraryClosureEdge",
    "DefaultLibraryBackfillJob",
]
