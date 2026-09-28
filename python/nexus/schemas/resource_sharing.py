"""The Share overlay's wire: camelCase, requests by alias only with no extra keys."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Presence
from nexus.services.resource_items.capabilities import ShareMode
from nexus.services.sealed_handles import ResourceGrantHandle, UserHandle

AudienceUnavailableReason = Literal[
    "UnsupportedSubject",
    "Deleting",
    "InsufficientAuthority",
    "HighlightUnresolved",
    "EntitlementRequired",
    "ProjectionNotReady",
    "ProjectionUnsupported",
]


class _In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid")


class _Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)


class UserAudienceIn(_In):
    kind: Literal["User"]
    user_handle: UserHandle


class LinkAudienceIn(_In):
    kind: Literal["Link"]


class CreateResourceShareRequest(_In):
    audience: Annotated[UserAudienceIn | LinkAudienceIn, Field(discriminator="kind")]


class ShareUserOut(_Out):
    user_handle: UserHandle
    email: Presence[str]
    display_name: Presence[str]


class AudienceAvailableOut(_Out):
    kind: Literal["Available"] = "Available"


class AudienceUnavailableOut(_Out):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: AudienceUnavailableReason


class CreationAvailabilityOut(_Out):
    user: Annotated[AudienceAvailableOut | AudienceUnavailableOut, Field(discriminator="kind")]
    link: Annotated[AudienceAvailableOut | AudienceUnavailableOut, Field(discriminator="kind")]


class UserShareOut(_Out):
    kind: Literal["User"] = "User"
    handle: ResourceGrantHandle
    user: ShareUserOut


class LinkShareOut(_Out):
    kind: Literal["Link"] = "Link"
    handle: ResourceGrantHandle
    public_href: str


OwnedShareOut = Annotated[UserShareOut | LinkShareOut, Field(discriminator="kind")]


class ReceivedUserShareOut(_Out):
    kind: Literal["ReceivedUser"] = "ReceivedUser"
    handle: ResourceGrantHandle
    shared_by: ShareUserOut
    subject: str


class ShareMembersOut(_Out):
    can_manage: bool


class ResourceShareSnapshotOut(_Out):
    sharing: ShareMode
    authenticated_href: str
    creation_availability: CreationAvailabilityOut
    shares: list[OwnedShareOut]
    received_access: list[ReceivedUserShareOut]
    members: Presence[ShareMembersOut]


class CreateResourceShareOut(_Out):
    share: OwnedShareOut
    created: bool
