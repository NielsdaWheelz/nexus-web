"""Strict camelCase wire contracts for the deterministic Resonance slates.

Every variant is key-exact against ``apps/web/src/lib/resonance/contract.ts``.
"""

from collections.abc import Callable
from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from nexus.db.models import MediaKind
from nexus.schemas.presence import Presence
from nexus.services.resource_graph.refs import (
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)

ResonanceEdgeOrigin = Literal[
    "user", "citation", "note_body", "highlight_note", "document_embed", "synapse"
]


def _ref_uri_validator(expected: ResourceScheme | None) -> Callable[[str], str]:
    def validate(value: str) -> str:
        parsed = parse_resource_ref(value)
        if isinstance(parsed, ResourceRefParseFailure):
            raise ValueError("ref must be a canonical ResourceRef")
        if expected is not None and parsed.scheme != expected:
            raise ValueError(f"ref must use the {expected} scheme")
        return value

    return validate


def _internal_href(value: str) -> str:
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("href must be a canonical internal route")
    return value


ResourceRefUri = Annotated[str, AfterValidator(_ref_uri_validator(None))]
MediaResourceRefUri = Annotated[str, AfterValidator(_ref_uri_validator("media"))]
PodcastResourceRefUri = Annotated[str, AfterValidator(_ref_uri_validator("podcast"))]
InternalHref = Annotated[str, AfterValidator(_internal_href)]
FiniteProgress = Annotated[float, Field(strict=True, ge=0.0, le=1.0, allow_inf_nan=False)]


class ResonanceModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class MediaSlateTargetOut(ResonanceModel):
    kind: Literal["Media"] = "Media"
    ref: MediaResourceRefUri
    media_kind: MediaKind
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: InternalHref


class PodcastSlateTargetOut(ResonanceModel):
    kind: Literal["Podcast"] = "Podcast"
    ref: PodcastResourceRefUri
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: InternalHref


SlateTargetOut = Annotated[
    MediaSlateTargetOut | PodcastSlateTargetOut,
    Field(discriminator="kind"),
]


class SlateAnchorOut(ResonanceModel):
    ref: ResourceRefUri
    label: str


class ContinueSlateReasonOut(ResonanceModel):
    kind: Literal["Continue"] = "Continue"
    progress: Presence[FiniteProgress]
    last_engaged_at: AwareDatetime


class AddedToNexusSlateReasonOut(ResonanceModel):
    kind: Literal["AddedToNexus"] = "AddedToNexus"
    added_at: AwareDatetime


class PublishedSlateReasonOut(ResonanceModel):
    kind: Literal["Published"] = "Published"
    published_on: date


class NewEpisodeSlateReasonOut(ResonanceModel):
    kind: Literal["NewEpisode"] = "NewEpisode"
    published_at: AwareDatetime


class ConnectedSlateReasonOut(ResonanceModel):
    kind: Literal["Connected"] = "Connected"
    anchor: SlateAnchorOut
    edge_origin: ResonanceEdgeOrigin


class SharedAuthorSlateReasonOut(ResonanceModel):
    kind: Literal["SharedAuthor"] = "SharedAuthor"
    anchor: SlateAnchorOut
    author_name: str


class SimilarSlateReasonOut(ResonanceModel):
    kind: Literal["Similar"] = "Similar"
    anchor: SlateAnchorOut


SlateReasonOut = Annotated[
    ContinueSlateReasonOut
    | AddedToNexusSlateReasonOut
    | PublishedSlateReasonOut
    | NewEpisodeSlateReasonOut
    | ConnectedSlateReasonOut
    | SharedAuthorSlateReasonOut
    | SimilarSlateReasonOut,
    Field(discriminator="kind"),
]


class SlateItemOut(ResonanceModel):
    target: SlateTargetOut
    reason: SlateReasonOut


class SlateOut(ResonanceModel):
    items: list[SlateItemOut] = Field(max_length=10)
