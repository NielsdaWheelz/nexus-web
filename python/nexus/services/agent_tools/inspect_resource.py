"""Provider-neutral inspect-resource tool: the agent's document map.

Navigation, not evidence. Given a ``media:`` URI already admitted to the
conversation, it returns the existing ordered document map. The canonical
tool-runtime binding owns the bounded model-facing JSON projection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.media_read_map import MediaReadMap, get_media_read_map_for_viewer
from nexus.services.resource_graph.context import admits_resource_for_conversation_read
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_items.capabilities import resource_inspect_policy


@dataclass(slots=True)
class InspectResourceResult:
    uri: str
    status: Literal["complete", "error"]
    body: str  # error description on failure; unused on success (the map renders)
    document_map: MediaReadMap | None = None
    error_code: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"


def execute_inspect_resource(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    uri: str,
) -> InspectResourceResult:
    """Return the document map for a referenced ``media:`` resource."""

    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        if parsed.reason == "unsupported_scheme":
            scheme = uri.partition(":")[0]
            return _error(
                uri, f"Resource URI scheme '{scheme}' is not supported.", "unknown_scheme"
            )
        return _error(uri, f"Resource URI {uri} is malformed.", "invalid_uri")

    inspect_policy = resource_inspect_policy(parsed)
    if inspect_policy != "media_document_map":
        return _error(
            uri,
            f"Resource {uri} has inspect policy '{inspect_policy}', so nexus__resource__inspect "
            "cannot map it. Pass a media document URI; use nexus__resource__read to read other "
            "resources.",
            "not_inspectable",
        )

    if not admits_resource_for_conversation_read(
        db, conversation_id=conversation_id, target=parsed
    ):
        return _error(
            uri,
            f"Resource {uri} is not in this conversation's context refs. "
            "Use nexus__search to find new sources first.",
            "not_in_context_refs",
        )

    document_map = get_media_read_map_for_viewer(db, viewer_id, parsed.id)
    if document_map is None:
        return _error(
            uri, f"Resource {uri} is unavailable or you do not have access to it.", "missing"
        )
    return InspectResourceResult(uri=uri, status="complete", body="", document_map=document_map)


def _error(uri: str, body: str, error_code: str) -> InspectResourceResult:
    return InspectResourceResult(uri=uri, status="error", body=body, error_code=error_code)
