"""Provider-neutral inspect-resource tool: the agent's document map.

Navigation, not evidence. Given a ``media:`` URI already in the conversation's
references, it returns an ordered section list — each section a label, a short
deterministic preview, and a ``read_uri`` the model can pass to ``read_resource``
for that section's exact text. It is a thin adapter over the
``media_document_map`` core: parse the URI, call the core, render. It owns no
per-kind SQL, persists no retrievals, and is never cited (no ``n``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy.orm import Session

from nexus.services.media_document_map import MediaDocumentMap, get_media_document_map_for_viewer
from nexus.services.resource_graph.context import admits_resource_for_conversation_read
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

INSPECT_RESOURCE_TOOL_NAME = "inspect_resource"

INSPECT_RESOURCE_TOOL_DEFINITION: dict[str, Any] = {
    "name": INSPECT_RESOURCE_TOOL_NAME,
    "description": (
        "Map a pinned document into its sections before reading it. Accepts a "
        "'media:UUID' URI that appears in <resources>. Returns an ordered list of "
        "sections, each with a label, a short preview, and a read_uri you pass to "
        "read_resource to get that section's exact text. Use this to navigate a long "
        "article, PDF, or transcript, then read the sections you need."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "uri": {"type": "string", "description": "Media URI to map, e.g. 'media:UUID'."},
        },
        "required": ["uri"],
        "additionalProperties": False,
    },
}


def _xml_attr(value: object) -> str:
    return xml_escape(str(value), {'"': "&quot;"})


@dataclass(slots=True)
class InspectResourceResult:
    uri: str
    status: Literal["complete", "error"]
    body: str  # error description on failure; unused on success (the map renders)
    document_map: MediaDocumentMap | None = None
    error_code: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"

    def tool_output(self) -> str:
        if self.status == "error" or self.document_map is None:
            return (
                f'<resource_error uri="{_xml_attr(self.uri)}" '
                f'code="{_xml_attr(self.error_code or "")}">'
                f"{xml_escape(self.body)}</resource_error>"
            )
        document_map = self.document_map
        lines = [
            f'<document_map uri="{_xml_attr(self.uri)}" title="{_xml_attr(document_map.title)}" '
            f'kind="document_map" media_kind="{_xml_attr(document_map.kind)}" '
            f'sections="{document_map.total_sections}">'
        ]
        for section in document_map.sections:
            attrs = [
                f'ordinal="{section.ordinal}"',
                f'section_kind="{_xml_attr(section.section_kind)}"',
                f'read_uri="{_xml_attr(section.read_uri)}"',
                f'label="{_xml_attr(section.label)}"',
            ]
            if section.parent_label:
                attrs.append(f'chapter="{_xml_attr(section.parent_label)}"')
            if section.page_start is not None:
                attrs.append(f'page_start="{section.page_start}"')
            if section.page_end is not None:
                attrs.append(f'page_end="{section.page_end}"')
            if section.t_start_ms is not None:
                attrs.append(f't_start_ms="{section.t_start_ms}"')
            if section.t_end_ms is not None:
                attrs.append(f't_end_ms="{section.t_end_ms}"')
            lines.append(f"<section {' '.join(attrs)}>{xml_escape(section.preview)}</section>")
        if len(document_map.sections) < document_map.total_sections:
            lines.append(
                f"<note>Showing the first {len(document_map.sections)} of "
                f"{document_map.total_sections} sections; use app_search to find a specific part."
                f"</note>"
            )
        lines.append("</document_map>")
        return "\n".join(lines)


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

    if parsed.scheme != "media":
        return _error(
            uri,
            f"inspect_resource only maps media documents, not '{parsed.scheme}'. "
            "Pass a 'media:UUID' URI; use read_resource to read other resources.",
            "not_inspectable",
        )

    if not admits_resource_for_conversation_read(
        db, conversation_id=conversation_id, target=parsed
    ):
        return _error(
            uri,
            f"Resource {uri} is not in this conversation's context refs. "
            "Use app_search to find new sources first.",
            "not_in_context_refs",
        )

    document_map = get_media_document_map_for_viewer(db, viewer_id, parsed.id)
    if document_map is None:
        return _error(
            uri, f"Resource {uri} is unavailable or you do not have access to it.", "missing"
        )
    return InspectResourceResult(uri=uri, status="complete", body="", document_map=document_map)


def _error(uri: str, body: str, error_code: str) -> InspectResourceResult:
    return InspectResourceResult(uri=uri, status="error", body=body, error_code=error_code)
