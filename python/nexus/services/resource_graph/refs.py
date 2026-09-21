"""The persisted resource-identity grammar: ``<scheme>:<uuid>`` over a closed scheme set.

Pure: no database, no permissions. Parsing is strict (canonical lowercase UUID) and
returns a typed failure, never ``None``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast, get_args
from uuid import UUID

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
    if not separator:
        return ResourceRefParseFailure(raw=raw, reason="invalid_format")
    if scheme not in RESOURCE_SCHEMES:
        return ResourceRefParseFailure(raw=raw, reason="unsupported_scheme")
    try:
        resource_id = UUID(ident)
    except ValueError:
        return ResourceRefParseFailure(raw=raw, reason="invalid_format")
    if str(resource_id) != ident:
        return ResourceRefParseFailure(raw=raw, reason="invalid_format")
    return ResourceRef(scheme=cast("ResourceScheme", scheme), id=resource_id)


def assert_resource_ref(raw: str) -> ResourceRef:
    """Parse a ref built from typed columns or already-validated input."""
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise AssertionError(f"invalid resource ref {raw!r}: {parsed.reason}")
    return parsed
