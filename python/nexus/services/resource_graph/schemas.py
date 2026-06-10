"""Typed payloads shared across the graph package modules (spec §9).

The edge vocabularies (``kind``/``origin``) mirror the ``resource_edges``
CHECKs exactly; adding a value requires a migration and a sole writer (N9).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, get_args
from uuid import UUID

from nexus.services.resource_graph.refs import ResourceRef

# Single source for the edge vocabularies (LOW #20): the wire schema
# (``nexus.schemas.resource_graph``) and the citation read-model
# (``nexus.schemas.citation``) alias these, mirroring how ``ResourceScheme``
# is sourced in ``refs.py``. Boundary value-tuples derive via ``get_args`` so a
# new value lands in exactly one place; it still requires a migration and the
# sole writer to widen the ``resource_edges`` CHECK (N9).
EdgeKind = Literal["context", "supports", "contradicts"]
EdgeOrigin = Literal["user", "citation", "system", "note_body", "highlight_note"]

EDGE_KINDS: tuple[EdgeKind, ...] = get_args(EdgeKind)
EDGE_ORIGINS: tuple[EdgeOrigin, ...] = get_args(EdgeOrigin)


@dataclass(frozen=True, slots=True)
class CitationSnapshot:
    """The schema-validated edge ``snapshot`` (§8.1): display fields only (N6)."""

    title: str | None = None
    excerpt: str | None = None
    section_label: str | None = None
    result_type: str | None = None
    deep_link: str | None = None


def snapshot_to_jsonb(snapshot: CitationSnapshot) -> dict[str, object]:
    fields = {
        "title": snapshot.title,
        "excerpt": snapshot.excerpt,
        "section_label": snapshot.section_label,
        "result_type": snapshot.result_type,
        "deep_link": snapshot.deep_link,
    }
    return {key: value for key, value in fields.items() if value is not None}


def snapshot_from_jsonb(raw: dict[str, object]) -> CitationSnapshot:
    def _opt_str(value: object) -> str | None:
        return value if isinstance(value, str) else None

    return CitationSnapshot(
        title=_opt_str(raw.get("title")),
        excerpt=_opt_str(raw.get("excerpt")),
        section_label=_opt_str(raw.get("section_label")),
        result_type=_opt_str(raw.get("result_type")),
        deep_link=_opt_str(raw.get("deep_link")),
    )


@dataclass(frozen=True, slots=True)
class EdgeCreate:
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    ordinal: int | None = None
    snapshot: CitationSnapshot | None = None


@dataclass(frozen=True, slots=True)
class EdgeOut:
    id: UUID
    source: ResourceRef
    target: ResourceRef
    kind: EdgeKind
    origin: EdgeOrigin
    ordinal: int | None
    snapshot: CitationSnapshot | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class CitationInput:
    """One citation in a replace-set: ordinal and snapshot are mandatory (D5)."""

    target: ResourceRef
    ordinal: int
    kind: EdgeKind
    snapshot: CitationSnapshot


@dataclass(frozen=True, slots=True)
class ConcordantSource:
    """Another source output sharing cited targets with the queried source (§5.3)."""

    source: ResourceRef
    shared_target_count: int
