"""Conversation share service layer.

Sharing rules:
- Owner-only share management exposes a single atomic replacement API.
- Empty share targets transition the conversation to private.
- Owner must be a member of every target library.
- Default libraries cannot be share targets.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ConversationShare, Library, Membership
from nexus.errors import ApiError, ApiErrorCode, ForbiddenError, NotFoundError
from nexus.schemas.conversation import (
    ConversationSharesOut,
    ConversationShareTargetOut,
)
from nexus.services.billing import get_entitlements


def is_member_of_library(db: Session, user_id: UUID, library_id: UUID) -> bool:
    """Check if user is a member of the library (any role)."""
    result = db.scalar(
        select(Membership.user_id).where(
            Membership.library_id == library_id, Membership.user_id == user_id
        )
    )
    return result is not None


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
        ApiError(E_FORBIDDEN): Owner not member of target library.
    """
    conversation = _verify_conversation_owner_for_shares(db, viewer_id, conversation_id)
    if library_ids and not get_entitlements(db, viewer_id).can_share:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Sharing requires Plus.")

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
