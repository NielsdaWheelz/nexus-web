"""Route-neutral inspect-resource tool: the model's document map.

Navigation, not evidence. Given a ``media:`` URI already admitted to the
generation, it returns the existing ordered document map. The canonical
tool-runtime binding owns the bounded model-facing JSON projection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.media_read_map import MediaReadMap, get_media_read_map_for_viewer
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_inspect_policy


@dataclass(slots=True)
class InspectResourceResult:
    uri: str
    status: Literal["complete", "error"]
    document_map: MediaReadMap | None = None
    error_code: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"


def execute_inspect_resource(
    db: Session,
    *,
    viewer_id: UUID,
    admitted_resource_uris: frozenset[str],
    uri: str,
) -> InspectResourceResult:
    """Return a document map under one operation-frozen admission set."""

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            return _error(uri, "unknown_scheme")
        return _error(uri, "invalid_uri")

    inspect_policy = resource_inspect_policy(parsed)
    if inspect_policy != "media_document_map":
        return _error(uri, "not_inspectable")

    if uri not in admitted_resource_uris:
        return _error(uri, "not_in_context_refs")

    document_map = get_media_read_map_for_viewer(db, viewer_id, parsed.id)
    if document_map is None:
        return _error(uri, "missing")
    return InspectResourceResult(uri=uri, status="complete", document_map=document_map)


def _error(uri: str, error_code: str) -> InspectResourceResult:
    return InspectResourceResult(uri=uri, status="error", error_code=error_code)
