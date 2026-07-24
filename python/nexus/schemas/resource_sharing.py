"""Strict authenticated resource-sharing wire contracts."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.services.resource_items.capabilities import ShareMode
from nexus.services.sealed_handles import ResourceGrantHandle, UserHandle


class SharingSchema(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class SharingRequestSchema(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
    )


class ShareUserOut(SharingSchema):
    user_handle: UserHandle
    email: str | None
    display_name: str | None


class UserAudienceIn(SharingRequestSchema):
    kind: Literal["User"]
    user_handle: UserHandle


class LinkAudienceIn(SharingRequestSchema):
    kind: Literal["Link"]


ShareAudienceIn = Annotated[
    UserAudienceIn | LinkAudienceIn,
    Field(discriminator="kind"),
]


class CreateResourceShareRequest(SharingRequestSchema):
    audience: ShareAudienceIn


AudienceUnavailableReason = Literal[
    "UnsupportedSubject",
    "Deleting",
    "InsufficientAuthority",
    "HighlightUnresolved",
    "EntitlementRequired",
    "ProjectionNotReady",
    "ProjectionUnsupported",
]


class AudienceAvailableOut(SharingSchema):
    kind: Literal["Available"] = "Available"


class AudienceUnavailableOut(SharingSchema):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: AudienceUnavailableReason


AudienceAvailabilityOut = Annotated[
    AudienceAvailableOut | AudienceUnavailableOut,
    Field(discriminator="kind"),
]


class GrantCreationAvailabilityOut(SharingSchema):
    user: AudienceAvailabilityOut
    link: AudienceAvailabilityOut


class UserShareOut(SharingSchema):
    kind: Literal["User"] = "User"
    handle: ResourceGrantHandle
    user: ShareUserOut


class LinkShareOut(SharingSchema):
    kind: Literal["Link"] = "Link"
    handle: ResourceGrantHandle
    public_href: str


OwnedShareOut = Annotated[
    UserShareOut | LinkShareOut,
    Field(discriminator="kind"),
]


class ReceivedUserShareOut(SharingSchema):
    kind: Literal["ReceivedUser"] = "ReceivedUser"
    handle: ResourceGrantHandle
    shared_by: ShareUserOut
    subject: str


class ResourceShareSnapshotOut(SharingSchema):
    subject: str
    sharing: ShareMode
    authenticated_href: str
    creation_availability: GrantCreationAvailabilityOut
    shares: list[OwnedShareOut]
    received_access: list[ReceivedUserShareOut]


class CreateResourceShareOut(SharingSchema):
    share: OwnedShareOut
    created: bool
