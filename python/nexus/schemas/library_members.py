"""Library membership and invitation wire (moved unchanged; rewritten in the
membership slice)."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.library import LibraryRole
from nexus.services.sealed_handles import LibraryInvitationHandle, UserHandle

LibraryInvitationStatusValue = Literal["pending", "accepted", "declined", "revoked"]
LibraryGovernanceCursor = Annotated[str, Field(min_length=1)]


class _Out(BaseModel):
    """Output model with every serialized field declared."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_serialization_defaults_required=True,
    )


class _Row(_Out):
    """Output model built straight from a DB row or context object."""

    model_config = ConfigDict(from_attributes=True, extra="forbid")


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UpdateLibraryMemberRequest(BaseModel):
    role: LibraryRole = Field(..., description="New role for the member ('admin' or 'member')")


class TransferLibraryOwnershipRequest(_In):
    new_owner_user_handle: UserHandle


class UserLibraryInvitee(_In):
    kind: Literal["User"]
    user_handle: UserHandle


class CreateLibraryInviteRequest(BaseModel):
    invitee: UserLibraryInvitee
    role: LibraryRole = Field(
        ..., description="Role to assign to the invitee ('admin' or 'member')"
    )

    model_config = ConfigDict(extra="forbid")


class LibraryGovernancePageInfo(_Out):
    next_cursor: LibraryGovernanceCursor | None


class LibraryMemberOut(_Row):
    user_handle: UserHandle
    role: LibraryRole
    is_owner: bool
    email: str | None
    display_name: str | None
    created_at: datetime


class LibraryInvitationOut(_Row):
    invitation_handle: LibraryInvitationHandle
    library_id: UUID
    inviter_user_handle: UserHandle
    invitee_user_handle: UserHandle
    role: LibraryRole
    status: LibraryInvitationStatusValue
    invitee_email: str | None
    invitee_display_name: str | None
    created_at: datetime
    responded_at: datetime | None


class ViewerLibraryInvitationOut(LibraryInvitationOut):
    library_name: str


class InviteAcceptMembershipOut(_Row):
    library_id: UUID
    user_handle: UserHandle
    role: LibraryRole


class AcceptLibraryInviteResponse(_Row):
    invite: LibraryInvitationOut
    membership: InviteAcceptMembershipOut
    idempotent: bool


class DeclineLibraryInviteResponse(_Row):
    invite: LibraryInvitationOut
    idempotent: bool
