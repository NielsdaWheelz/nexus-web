"""Contributor DTOs.

Wire-case seam (D-1). The five author-surface endpoints — ``GET /contributors``,
``GET /contributors/{handle}``, ``GET /contributors/{handle}/works``,
``PATCH /contributors/{handle}`` and ``PUT /media/{id}/authors`` — speak STRICT
camelCase both directions:

- request models accept camel keys only (``alias`` + ``populate_by_name=False`` +
  ``extra="forbid"``), so a snake payload is rejected;
- response models serialise camel via ``ok(model, by_alias=True)`` and re-validate
  their own camel dump on replay. They keep ``populate_by_name=True`` so the facade
  can construct them with ordinary snake field names while replay's
  ``Model.model_validate(stored_camel_dump)`` still round-trips (D-42).

EMBEDDED credits inside the existing media/search/podcast/library GET DTOs stay
snake_case: the narrowed :class:`ContributorCreditOut` (D-33) carries no aliases
and rides the snake ``ok(by_alias=False)`` wire. The podcast subscribe payload
rides the same snake surface via the snake-strict :class:`ContributorCreditIn`
(v2, D-4).

Several rich legacy DTOs (``ContributorOut`` and its alias/external-id parts, the
role/kind/status literals) survive here as ``# CUTOVER-SCAFFOLD`` purely so the
search-package and podcast consumers keep importing them until they migrate to
the canonical relation in S4/S5; they are deleted then.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from nexus.services.contributor_taxonomy import clean_contributor_display

# Bounds are inlined literals (matching migration D-32 / observation value types):
# credited/display names 200 code points, raw role 80, one author slice 20 rows,
# clientMutationId 1..120 (the existing resource_mutations key length).
_MAX_NAME_CODE_POINTS = 200
_MAX_RAW_ROLE_LENGTH = 80
_MAX_AUTHORS_PER_SLICE = 20
_MAX_CLIENT_MUTATION_ID = 120


def _require_nonblank_name(value: str) -> str:
    # Whitespace-only names pass min_length but clean to empty downstream (a
    # ValueError-turned-500 or an empty-display contributor); reject at the
    # boundary. The literal is preserved — cleaning stays a service concern.
    if not clean_contributor_display(value):
        raise ValueError("must not be blank")
    return value


_NonblankName = Annotated[str, AfterValidator(_require_nonblank_name)]

ContributorRole = Literal[
    "author",
    "editor",
    "translator",
    "host",
    "guest",
    "narrator",
    "creator",
    "producer",
    "publisher",
    "channel",
    "organization",
    "unknown",
]


# ---------------------------------------------------------------------------
# Snake-strict adapter input (podcast subscribe payload rides the snake surface)
# ---------------------------------------------------------------------------


class ContributorCreditIn(BaseModel):
    """Typed provider credit (v2, D-4): snake-only, strict, server facts dropped.

    ``ordinal`` (list order is the order), ``source``/``source_ref`` and
    ``confidence`` are server-owned and no longer client inputs. An unknown role
    is rejected by the closed vocabulary (422-shaped validation).
    """

    credited_name: str = Field(min_length=1, max_length=_MAX_NAME_CODE_POINTS)
    role: ContributorRole
    raw_role: str | None = Field(default=None, max_length=_MAX_RAW_ROLE_LENGTH)

    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=False, extra="forbid")


# ---------------------------------------------------------------------------
# Embedded snake credit (narrowed, D-33) — media/search/podcast/library GET DTOs
# ---------------------------------------------------------------------------


class ContributorCreditOut(BaseModel):
    """One effective credit fact, embedded snake-case in existing GET DTOs.

    Handle-bearing credits link to author detail; handle-less text-fact credits
    (podcast browse/discovery previews, D-9) leave the handle/href absent.
    Removed vs. the legacy shape: ``id``, ``source``, ``source_ref``,
    ``resolution_status``, ``confidence`` and the nested full contributor.
    """

    contributor_handle: str | None = None
    contributor_display_name: str | None = None
    href: str | None = None
    credited_name: str
    role: ContributorRole
    raw_role: str | None = None
    ordinal: int | None = None

    model_config = ConfigDict(from_attributes=True, extra="forbid")


# ---------------------------------------------------------------------------
# Author-surface request models — STRICT camelCase, snake rejected
# ---------------------------------------------------------------------------


class ExistingAuthorBinding(BaseModel):
    """Bind a manual author row to an already-visible contributor."""

    kind: Literal["existing"]
    contributor_handle: str = Field(alias="contributorHandle", min_length=1)

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


class NewAuthorBinding(BaseModel):
    """Bind a manual author row to an explicit, deliberately-distinct new person."""

    kind: Literal["new"]
    display_name: _NonblankName = Field(
        alias="displayName", min_length=1, max_length=_MAX_NAME_CODE_POINTS
    )

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


AuthorBindingIn = Annotated[ExistingAuthorBinding | NewAuthorBinding, Field(discriminator="kind")]


class ManualAuthorRowIn(BaseModel):
    """One ordered manual author row. Every row is role ``author``."""

    credited_name: _NonblankName = Field(
        alias="creditedName", min_length=1, max_length=_MAX_NAME_CODE_POINTS
    )
    binding: AuthorBindingIn

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


class ManualMediaAuthorsRequest(BaseModel):
    """PUT /media/{id}/authors — manual branch: the complete ordered author slice."""

    client_mutation_id: str = Field(
        alias="clientMutationId", min_length=1, max_length=_MAX_CLIENT_MUTATION_ID
    )
    mode: Literal["manual"]
    authors: list[ManualAuthorRowIn] = Field(max_length=_MAX_AUTHORS_PER_SLICE)

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


class AutomaticMediaAuthorsRequest(BaseModel):
    """PUT /media/{id}/authors — reset branch: clears the pin, rejects ``authors``."""

    client_mutation_id: str = Field(
        alias="clientMutationId", min_length=1, max_length=_MAX_CLIENT_MUTATION_ID
    )
    mode: Literal["automatic"]

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


MediaAuthorsPutRequest = Annotated[
    ManualMediaAuthorsRequest | AutomaticMediaAuthorsRequest,
    Field(discriminator="mode"),
]


class ContributorRenameRequest(BaseModel):
    """PATCH /contributors/{handle} — replayable display-name rename."""

    client_mutation_id: str = Field(
        alias="clientMutationId", min_length=1, max_length=_MAX_CLIENT_MUTATION_ID
    )
    display_name: _NonblankName = Field(
        alias="displayName", min_length=1, max_length=_MAX_NAME_CODE_POINTS
    )

    model_config = ConfigDict(populate_by_name=False, extra="forbid")


# ---------------------------------------------------------------------------
# Author-surface response models — camelCase, replay-round-trippable
# ---------------------------------------------------------------------------


class MediaAuthorCreditOut(BaseModel):
    contributor_handle: str = Field(alias="contributorHandle")
    href: str
    display_name: str = Field(alias="displayName")
    credited_name: str = Field(alias="creditedName")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MediaAuthorsOut(BaseModel):
    author_mode: Literal["automatic", "manual"] = Field(alias="authorMode")
    authors: list[MediaAuthorCreditOut]
    can_edit_authors: bool = Field(alias="canEditAuthors")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorWorkExampleOut(BaseModel):
    title: str
    href: str

    model_config = ConfigDict(extra="forbid")


class ContributorSearchItemOut(BaseModel):
    handle: str
    href: str
    display_name: str = Field(alias="displayName")
    work_count: int = Field(alias="workCount")
    work_examples: list[ContributorWorkExampleOut] = Field(alias="workExamples", max_length=2)
    matched_alias: str | None = Field(default=None, alias="matchedAlias")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorSearchPageOut(BaseModel):
    contributors: list[ContributorSearchItemOut]
    next_cursor: str | None = Field(default=None, alias="nextCursor")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorDetailOut(BaseModel):
    handle: str
    href: str
    display_name: str = Field(alias="displayName")
    other_names: list[str] = Field(alias="otherNames")
    can_rename: bool = Field(alias="canRename")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorRoleFactOut(BaseModel):
    credited_name: str = Field(alias="creditedName")
    role: ContributorRole
    raw_role: str | None = Field(default=None, alias="rawRole")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorWorkItemOut(BaseModel):
    title: str
    href: str
    content_kind: str = Field(alias="contentKind")
    date: str | None = None
    role_facts: list[ContributorRoleFactOut] = Field(alias="roleFacts")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ContributorWorkPageOut(BaseModel):
    works: list[ContributorWorkItemOut]
    next_cursor: str | None = Field(default=None, alias="nextCursor")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


# ---------------------------------------------------------------------------
# CUTOVER-SCAFFOLD (deleted in S4/S5)
#
# The rich legacy contributor DTOs plus the podcast credit-payload stripper below
# are kept importable only so the still-legacy search-package (schemas/search.py,
# services/search/*), contributor_credits.py read owner, and podcast subscribe
# schema keep collecting until they migrate to the canonical relation. No new
# code should read these.
# ---------------------------------------------------------------------------

ContributorKind = Literal["person", "organization", "group", "unknown"]
ContributorStatus = Literal["unverified", "verified", "tombstoned", "merged"]
ContributorAliasKind = Literal[
    "display",
    "credited",
    "legal",
    "pseudonym",
    "transliteration",
    "search",
]


class ContributorAliasOut(BaseModel):
    id: UUID
    alias: str
    normalized_alias: str = Field(serialization_alias="normalizedAlias")
    sort_name: str | None = Field(None, serialization_alias="sortName")
    alias_kind: ContributorAliasKind = Field(serialization_alias="aliasKind")
    locale: str | None = None
    script: str | None = None
    source: str
    confidence: Decimal | None = None
    is_primary: bool = Field(serialization_alias="isPrimary")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


class ContributorExternalIdOut(BaseModel):
    id: UUID
    authority: str
    external_key: str = Field(serialization_alias="externalKey")
    external_url: str | None = Field(None, serialization_alias="externalUrl")
    source: str

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


class ContributorOut(BaseModel):
    handle: str
    href: str = ""
    display_name: str = Field(serialization_alias="displayName")
    sort_name: str = Field(serialization_alias="sortName")
    kind: ContributorKind
    status: ContributorStatus
    disambiguation: str | None = None
    aliases: list[ContributorAliasOut] = Field(default_factory=list)
    external_ids: list[ContributorExternalIdOut] = Field(
        default_factory=list,
        serialization_alias="externalIds",
    )
    created_at: datetime | None = Field(None, serialization_alias="createdAt")
    updated_at: datetime | None = Field(None, serialization_alias="updatedAt")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True, extra="forbid")


def contributor_credit_write_payload(value: object) -> object:
    if not isinstance(value, dict):
        return value

    return {
        key: item
        for key, item in value.items()
        if key
        not in {
            "id",
            "contributor",
            "contributor_handle",
            "contributorHandle",
            "contributor_display_name",
            "contributorDisplayName",
            "href",
            "resolution_status",
            "resolutionStatus",
        }
    }
