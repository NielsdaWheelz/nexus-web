"""Route-neutral inspect-resource tool: the model's document map.

Navigation, not evidence. Given an admitted ``media:`` URI it returns the
existing ordered document map; the tool handler owns admission and the bounded
model-facing JSON projection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.media_read_map import MediaReadMap, get_media_read_map_for_viewer
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_inspect_policy

type InspectRefusalCode = Literal["unknown_scheme", "invalid_uri", "not_inspectable", "missing"]


@dataclass(frozen=True, slots=True)
class InspectRefusal:
    code: InspectRefusalCode


def execute_inspect_resource(
    db: Session,
    *,
    viewer_id: UUID,
    uri: str,
) -> MediaReadMap | InspectRefusal:
    """Return the document map for one admitted media URI."""

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            return InspectRefusal("unknown_scheme")
        return InspectRefusal("invalid_uri")
    if resource_inspect_policy(parsed) != "media_document_map":
        return InspectRefusal("not_inspectable")
    document_map = get_media_read_map_for_viewer(db, viewer_id, parsed.id)
    if document_map is None:
        return InspectRefusal("missing")
    return document_map
