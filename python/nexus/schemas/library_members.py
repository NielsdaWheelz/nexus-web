"""Library membership and invitation wire: snake keys, plain nullable values, plain
ids; requests forbid unknown keys."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.library import LibraryRole


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetMemberRoleRequest(_In):
    """`expected_role` is the role the client last read (the expected version)."""

    role: LibraryRole
    expected_role: LibraryRole


class TransferOwnershipRequest(_In):
    user_id: UUID


class CreateInvitationRequest(_In):
    """Retry: resend the same client-minted id. `invitee_email` is the email the inviter
    typed to find the invitee (theirs, in any case), or null when found by name."""

    id: UUID
    invitee_user_id: UUID
    invitee_email: str | None
    role: LibraryRole


class LibraryMemberOut(BaseModel):
    user_id: UUID
    role: LibraryRole
    is_owner: bool
    email: str | None
    display_name: str | None
    created_at: datetime


class LibraryInvitationOut(BaseModel):
    id: UUID
    library_id: UUID
    role: LibraryRole
    status: Literal["pending", "accepted", "declined", "revoked"]
    invitee_user_id: UUID
    # the email the inviter typed, else the invitee's own once they are a member, else null
    invitee_email: str | None
    invitee_display_name: str | None
    created_at: datetime


class ViewerInvitationOut(BaseModel):
    """A pending invitation addressed to the viewer, with who sent it."""

    id: UUID
    library_id: UUID
    library_name: str
    role: LibraryRole
    inviter_email: str | None
    inviter_display_name: str | None
    created_at: datetime
