"""Conversation Share service layer.

Implements sharing invariants for Slice 3 (PR-02) and route-facing
owner-scoped entry points for S4 PR-06.

Sharing rules:
- sharing='private' forbids any conversation_share rows
- sharing='library' requires ≥1 conversation_share row
- Owner must be a member of the library to add a share
- Deleting the last share auto-transitions sharing to 'private'
- Default libraries cannot be share targets (S4)
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ConversationShare, Library, Membership
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    ConversationSharesOut,
    ConversationShareTargetOut,
)

logger = get_logger(__name__)


# =============================================================================
# Helper Functions
# =============================================================================


def get_conversation_or_404(db: Session, conversation_id: UUID) -> Conversation:
    """Load conversation or raise NotFoundError."""
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def is_member_of_library(db: Session, user_id: UUID, library_id: UUID) -> bool:
    """Check if user is a member of the library (any role)."""
    result = db.scalar(
        select(Membership.user_id).where(
            Membership.library_id == library_id, Membership.user_id == user_id
        )
    )
    return result is not None


def get_share_count(db: Session, conversation_id: UUID) -> int:
    """Get the count of shares for a conversation."""
    result = db.execute(
        text("SELECT COUNT(*) FROM conversation_shares WHERE conversation_id = :conv_id"),
        {"conv_id": conversation_id},
    )
    return result.scalar() or 0


# =============================================================================
# Service Functions
# =============================================================================


def set_sharing_mode(
    db: Session, conversation_id: UUID, sharing: str, library_ids: list[UUID] | None = None
) -> Conversation:
    """Set the sharing mode for a conversation.

    This function handles the full transition logic:
    - If sharing='private': removes all shares, sets sharing to 'private'
    - If sharing='library': requires library_ids, validates owner membership,
      sets shares, updates sharing to 'library'

    Args:
        db: Database session.
        conversation_id: The conversation to update.
        sharing: The new sharing mode ('private' or 'library').
        library_ids: Required if sharing='library'. Libraries to share with.

    Returns:
        The updated conversation.

    Raises:
        NotFoundError: If conversation doesn't exist.
        ApiError(E_SHARE_REQUIRED): If sharing='library' but no library_ids provided.
        ApiError(E_SHARES_NOT_ALLOWED): If sharing='private' but library_ids provided.
        ApiError(E_FORBIDDEN): If owner is not a member of a library.
    """
    conversation = get_conversation_or_404(db, conversation_id)

    if sharing == "private":
        # Remove all shares
        db.execute(
            delete(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
        )

        # Update sharing mode
        db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(sharing="private", updated_at=datetime.now(UTC))
        )

        db.flush()
        db.refresh(conversation)
        return conversation

    elif sharing == "library":
        if not library_ids:
            raise ApiError(
                ApiErrorCode.E_SHARE_REQUIRED, "At least one library is required for sharing"
            )

        # Validate owner is member of all libraries
        owner_id = conversation.owner_user_id
        for lib_id in library_ids:
            if not is_member_of_library(db, owner_id, lib_id):
                raise ApiError(
                    ApiErrorCode.E_FORBIDDEN, f"Owner must be a member of library {lib_id}"
                )

        # Clear existing shares
        db.execute(
            delete(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
        )

        # Add new shares
        for lib_id in library_ids:
            share = ConversationShare(conversation_id=conversation_id, library_id=lib_id)
            db.add(share)

        # Update sharing mode
        db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(sharing="library", updated_at=datetime.now(UTC))
        )

        db.flush()
        db.refresh(conversation)
        return conversation

    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid sharing mode: {sharing}")


def add_share(db: Session, conversation_id: UUID, library_id: UUID) -> ConversationShare:
    """Add a library share to a conversation.

    Args:
        db: Database session.
        conversation_id: The conversation to share.
        library_id: The library to share with.

    Returns:
        The created share.

    Raises:
        NotFoundError: If conversation doesn't exist.
        ApiError(E_SHARES_NOT_ALLOWED): If conversation.sharing='private'.
        ApiError(E_FORBIDDEN): If owner is not a member of the library.
    """
    conversation = get_conversation_or_404(db, conversation_id)

    # Cannot add share to private conversation
    if conversation.sharing == "private":
        raise ApiError(
            ApiErrorCode.E_SHARES_NOT_ALLOWED, "Cannot add shares to a private conversation"
        )

    # Validate owner is member of library
    if not is_member_of_library(db, conversation.owner_user_id, library_id):
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Owner must be a member of the library")

    # Check if share already exists
    existing = db.scalar(
        select(ConversationShare).where(
            ConversationShare.conversation_id == conversation_id,
            ConversationShare.library_id == library_id,
        )
    )
    if existing:
        return existing

    # Create share
    share = ConversationShare(conversation_id=conversation_id, library_id=library_id)
    db.add(share)
    db.flush()

    # Update conversation updated_at
    db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=datetime.now(UTC))
    )

    db.commit()
    return share


def delete_share(db: Session, conversation_id: UUID, library_id: UUID) -> Conversation:
    """Delete a library share from a conversation.

    If this is the last share and sharing='library', auto-transitions to 'private'.

    Args:
        db: Database session.
        conversation_id: The conversation.
        library_id: The library to remove.

    Returns:
        The updated conversation (may have sharing='private' if last share deleted).

    Raises:
        NotFoundError: If conversation doesn't exist.
    """
    conversation = get_conversation_or_404(db, conversation_id)

    # Delete the share if it exists
    db.execute(
        delete(ConversationShare).where(
            ConversationShare.conversation_id == conversation_id,
            ConversationShare.library_id == library_id,
        )
    )
    db.flush()

    # Check remaining shares
    remaining_shares = get_share_count(db, conversation_id)

    # If no shares remain and sharing='library', auto-transition to 'private'
    if remaining_shares == 0 and conversation.sharing == "library":
        db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(sharing="private", updated_at=datetime.now(UTC))
        )
        db.flush()

    # Update conversation updated_at
    db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=datetime.now(UTC))
    )

    db.commit()
    db.refresh(conversation)
    return conversation


def set_shares(db: Session, conversation_id: UUID, library_ids: list[UUID]) -> Conversation:
    """Bulk set shares for a conversation.

    Replaces all existing shares with the provided list.
    If library_ids is empty and sharing='library', auto-transitions to 'private'.

    Args:
        db: Database session.
        conversation_id: The conversation.
        library_ids: The libraries to share with.

    Returns:
        The updated conversation.

    Raises:
        NotFoundError: If conversation doesn't exist.
        ApiError(E_FORBIDDEN): If owner is not a member of a library.
    """
    conversation = get_conversation_or_404(db, conversation_id)

    # Validate owner is member of all new libraries
    owner_id = conversation.owner_user_id
    for lib_id in library_ids:
        if not is_member_of_library(db, owner_id, lib_id):
            raise ApiError(ApiErrorCode.E_FORBIDDEN, f"Owner must be a member of library {lib_id}")

    # Clear existing shares
    db.execute(
        delete(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
    )

    # Add new shares
    for lib_id in library_ids:
        share = ConversationShare(conversation_id=conversation_id, library_id=lib_id)
        db.add(share)

    # Handle sharing mode transition
    if library_ids:
        # If we're adding shares, set to 'library'
        if conversation.sharing == "private":
            db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_id)
                .values(sharing="library", updated_at=datetime.now(UTC))
            )
    else:
        # No shares - auto-transition to 'private' if currently 'library'
        if conversation.sharing == "library":
            db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_id)
                .values(sharing="private", updated_at=datetime.now(UTC))
            )

    db.flush()
    db.commit()
    db.refresh(conversation)
    return conversation


def get_shares(db: Session, conversation_id: UUID) -> list[ConversationShare]:
    """Get all shares for a conversation.

    Args:
        db: Database session.
        conversation_id: The conversation.

    Returns:
        List of conversation shares.

    Raises:
        NotFoundError: If conversation doesn't exist.
    """
    get_conversation_or_404(db, conversation_id)

    result = db.scalars(
        select(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
    )
    return list(result)


# =============================================================================
# S4 PR-06: Owner-Scoped Route Entry Points
# =============================================================================


def _verify_conversation_owner_for_shares(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Verify viewer can manage shares for a conversation.

    Masking: not-visible -> 404; visible but not owner -> 403.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    if not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Only the owner can manage shares")

    return conversation


def _build_shares_snapshot(db: Session, conversation: Conversation) -> ConversationSharesOut:
    """Build a deterministic shares snapshot ordered by library_id ASC."""
    shares = db.scalars(
        select(ConversationShare)
        .where(ConversationShare.conversation_id == conversation.id)
        .order_by(ConversationShare.library_id.asc())
    ).all()

    return ConversationSharesOut(
        conversation_id=conversation.id,
        sharing=conversation.sharing,
        shares=[
            ConversationShareTargetOut(
                library_id=s.library_id,
                created_at=s.created_at,
            )
            for s in shares
        ],
    )


def get_conversation_shares_for_owner(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> ConversationSharesOut:
    """Owner-only: get current share targets for a conversation.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): Not visible.
        ForbiddenError(E_OWNER_REQUIRED): Visible but not owner.
    """
    conversation = _verify_conversation_owner_for_shares(db, viewer_id, conversation_id)
    return _build_shares_snapshot(db, conversation)


def set_conversation_shares_for_owner(
    db: Session, viewer_id: UUID, conversation_id: UUID, library_ids: list[UUID]
) -> ConversationSharesOut:
    """Owner-only: atomically replace share targets.

    Rules:
    - Dedupe input library_ids.
    - Validate all targets before any writes.
    - Default-library targets are forbidden.
    - Owner must be member of every target library.
    - Atomic: any validation failure leaves prior shares unchanged.
    - Empty library_ids with sharing='library' transitions to 'private'.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): Not visible.
        ForbiddenError(E_OWNER_REQUIRED): Visible but not owner.
        ForbiddenError(E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN): Default lib target.
        ApiError(E_SHARE_REQUIRED): sharing='library' but no valid targets.
        ApiError(E_FORBIDDEN): Owner not member of target library.
    """
    conversation = _verify_conversation_owner_for_shares(db, viewer_id, conversation_id)

    # Dedupe
    unique_ids = list(dict.fromkeys(library_ids))

    # Validate all targets up-front before any writes
    for lib_id in unique_ids:
        lib = db.get(Library, lib_id)
        if lib is None:
            raise ApiError(
                ApiErrorCode.E_FORBIDDEN,
                f"Owner must be a member of library {lib_id}",
            )
        if lib.is_default:
            raise ForbiddenError(
                ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN,
                "Cannot share conversations to a default library",
            )
        if not is_member_of_library(db, viewer_id, lib_id):
            raise ApiError(
                ApiErrorCode.E_FORBIDDEN,
                f"Owner must be a member of library {lib_id}",
            )

    if not unique_ids:
        # Transition to private, remove all shares
        db.execute(
            delete(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
        )
        if conversation.sharing == "library":
            db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_id)
                .values(sharing="private", updated_at=datetime.now(UTC))
            )
    else:
        # Replace shares atomically
        db.execute(
            delete(ConversationShare).where(ConversationShare.conversation_id == conversation_id)
        )
        for lib_id in unique_ids:
            db.add(ConversationShare(conversation_id=conversation_id, library_id=lib_id))

        db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(sharing="library", updated_at=datetime.now(UTC))
        )

    db.flush()
    db.commit()
    db.refresh(conversation)

    return _build_shares_snapshot(db, conversation)
