"""A contributor credit embedded in media and discovery wires."""

from pydantic import BaseModel, ConfigDict

from nexus.services.contributor_taxonomy import ContributorRole


class ContributorCreditOut(BaseModel):
    """One ordered credit fact; discovery text facts have no handle or href."""

    contributor_handle: str | None
    contributor_display_name: str | None
    href: str | None
    credited_name: str
    role: ContributorRole
    raw_role: str | None
    ordinal: int | None

    model_config = ConfigDict(from_attributes=True, extra="forbid")
