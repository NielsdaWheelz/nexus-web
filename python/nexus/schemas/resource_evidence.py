"""Captured evidence: immutable words, attribution and the extent they described."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator


class CapturedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CapturedQuote(CapturedModel):
    exact: str
    prefix: str | None
    suffix: str | None
    color: HighlightColor | None


class CapturedSource(CapturedModel):
    ref: str | None
    title: str | None
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None
    location_label: str | None


class CapturedResourceTarget(CapturedModel):
    kind: Literal["resource"] = "resource"
    owner_ref: str


class CapturedPassageTarget(CapturedModel):
    kind: Literal["passage"] = "passage"
    owner_ref: str
    locator: RetrievalLocator
    precision: LocationPrecision
    source_identity: str | None


class CapturedUnavailableTarget(CapturedModel):
    kind: Literal["unavailable"] = "unavailable"
    owner_ref: str | None


CapturedTarget = Annotated[
    CapturedResourceTarget | CapturedPassageTarget | CapturedUnavailableTarget,
    Field(discriminator="kind"),
]


class CapturedEvidence(CapturedModel):
    quote: CapturedQuote | None
    source: CapturedSource
    target: CapturedTarget
