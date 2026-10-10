"""Resource identity: ``<scheme>:<uuid>`` over a closed scheme set, canonical lowercase
uuid. Parsing returns a typed failure; no code splits a ref anywhere else."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast, get_args
from uuid import UUID

from nexus.errors import ApiErrorCode, InvalidRequestError

ResourceScheme = Literal[
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "oracle_reading",
    "oracle_passage_anchor",
    "artifact",
    "artifact_revision",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
    "passage_anchor",
]
RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = get_args(ResourceScheme)


@dataclass(frozen=True, slots=True)
class ResourceRef:
    scheme: ResourceScheme
    id: UUID

    @property
    def uri(self) -> str:
        return f"{self.scheme}:{self.id}"


@dataclass(frozen=True, slots=True)
class ResourceRefParseFailure:
    raw: str
    reason: Literal["invalid_format", "unsupported_scheme"]


def parse_resource_ref(raw: str) -> ResourceRef | ResourceRefParseFailure:
    scheme, separator, ident = raw.partition(":")
    if separator and scheme not in RESOURCE_SCHEMES:
        return ResourceRefParseFailure(raw, "unsupported_scheme")
    try:
        if separator and str(UUID(ident)) == ident:
            return ResourceRef(cast(ResourceScheme, scheme), UUID(ident))
    except ValueError:
        pass
    return ResourceRefParseFailure(raw, "invalid_format")


def assert_resource_ref(raw: str) -> ResourceRef:
    """Parse a ref built from typed columns or already-validated input."""
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise AssertionError(f"invalid resource ref {raw!r}: {parsed.reason}")
    return parsed


def require_ref(raw: str) -> ResourceRef:
    """Parse a ref from request input; 400 unless it is canonical."""
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed
