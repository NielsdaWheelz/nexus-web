"""The Share overlay's wire: plain ids for users and grants; requests take no extra
keys."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.services.resource_items.capabilities import ShareMode

AudienceUnavailableReason = Literal[
    "UnsupportedSubject",
    "Deleting",
    "InsufficientAuthority",
    "HighlightUnresolved",
    "ProjectionNotReady",
    "ProjectionUnsupported",
]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserAudienceIn(_In):
    """`email` is the email the sharer typed to find the user (theirs, in any case), or
    null when found by name."""

    kind: Literal["User"]
    user_id: UUID
    email: str | None


class LinkAudienceIn(_In):
    kind: Literal["Link"]


class CreateResourceShareRequest(_In):
    """Retry: resend the same client-minted id."""

    id: UUID
    audience: Annotated[UserAudienceIn | LinkAudienceIn, Field(discriminator="kind")]


class ShareUserOut(BaseModel):
    user_id: UUID
    # a grantee's email only as the sharer typed it; a sharer's own email
    email: str | None
    display_name: str | None


class AudienceAvailableOut(BaseModel):
    kind: Literal["Available"] = "Available"


class AudienceUnavailableOut(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: AudienceUnavailableReason


Availability = Annotated[AudienceAvailableOut | AudienceUnavailableOut, Field(discriminator="kind")]


class CreationAvailabilityOut(BaseModel):
    user: Availability
    link: Availability


class UserShareOut(BaseModel):
    kind: Literal["User"] = "User"
    id: UUID
    user: ShareUserOut


class LinkShareOut(BaseModel):
    kind: Literal["Link"] = "Link"
    id: UUID
    public_href: str


OwnedShareOut = Annotated[UserShareOut | LinkShareOut, Field(discriminator="kind")]


class ReceivedUserShareOut(BaseModel):
    kind: Literal["ReceivedUser"] = "ReceivedUser"
    id: UUID
    shared_by: ShareUserOut
    subject: str


class ShareMembersOut(BaseModel):
    can_manage: bool


class ResourceShareSnapshotOut(BaseModel):
    sharing: ShareMode
    authenticated_href: str
    creation_availability: CreationAvailabilityOut
    shares: list[OwnedShareOut]
    received_access: list[ReceivedUserShareOut]
    members: ShareMembersOut | None


class CreateResourceShareOut(BaseModel):
    share: OwnedShareOut
    created: bool
