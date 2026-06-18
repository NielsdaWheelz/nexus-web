"""ResourceRef grammar: the one persisted resource-identity vocabulary (spec §7).

A ref is ``<scheme>:<uuid>`` with a closed scheme set. This module is pure —
no database, no permissions. Hard cutover: the old ``span:``/``chunk:``
aliases are gone (``evidence_span:``/``content_chunk:`` only, D2); parsing is
strict (canonical lowercase UUID) and returns a typed failure, never ``None``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast
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
    "library_intelligence_artifact",
    "library_intelligence_revision",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
]

RESOURCE_SCHEMES: tuple[ResourceScheme, ...] = (
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
    "library_intelligence_artifact",
    "library_intelligence_revision",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
)


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
    scheme, sep, ident = raw.partition(":")
    if not sep:
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
    """Parse a ref the caller asserts is valid; a failure is a defect."""
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        # justify-defect: callers use this only for refs built from typed
        # columns or already-validated input; a parse failure here means code
        # or stored data no longer matches the ref grammar.
        raise AssertionError(f"invalid resource ref {raw!r}: {parsed.reason}")
    return parsed
