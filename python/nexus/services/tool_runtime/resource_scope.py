"""Canonical operation-aware resource admission for all model tools."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from sqlalchemy.orm import Session


@dataclass(frozen=True, slots=True)
class _ResourceArgument:
    name: str
    many: bool = False
    allow_derived_read: bool = False


_RESOURCE_ARGUMENTS: Mapping[str, tuple[_ResourceArgument, ...]] = MappingProxyType(
    {
        "nexus.search": (_ResourceArgument("scopes", many=True),),
        "nexus.resource.read": (_ResourceArgument("uri", allow_derived_read=True),),
        "nexus.document.search": (_ResourceArgument("uri"),),
        "nexus.resource.inspect": (_ResourceArgument("uri"),),
        "nexus.relations.list": (_ResourceArgument("uri"),),
        "nexus.library.add": (_ResourceArgument("resource_uri"),),
        "nexus.note.create": (_ResourceArgument("page_uri"),),
        "nexus.highlight.create": (_ResourceArgument("media_uri"),),
        "nexus.edge.create": (
            _ResourceArgument("source_uri"),
            _ResourceArgument("target_uri"),
        ),
        "nexus.queue.add": (_ResourceArgument("media_uri"),),
    }
)


def tool_arguments_within_admitted_scope(
    db: Session,
    *,
    tool_id: str,
    arguments: Mapping[str, Any],
    admitted_resource_uris: frozenset[str],
) -> bool:
    """Return whether every declared resource argument stays inside admission.

    Structurally invalid values are left to the portable schema decoder. This
    boundary answers only the capability question for actual URI strings.
    """

    for contract in _RESOURCE_ARGUMENTS.get(tool_id, ()):
        value = arguments.get(contract.name)
        if value is None:
            continue
        values = value if contract.many and isinstance(value, (list, tuple)) else (value,)
        for uri in values:
            if not isinstance(uri, str):
                continue
            if not resource_uri_is_admitted(
                db,
                uri=uri,
                admitted_resource_uris=admitted_resource_uris,
                allow_derived_read=contract.allow_derived_read,
            ):
                return False
    return True


def resource_uri_is_admitted(
    db: Session,
    *,
    uri: str,
    admitted_resource_uris: frozenset[str],
    allow_derived_read: bool = False,
) -> bool:
    """Apply the one resource/parent admission algebra used by MCP and handlers."""

    if uri in admitted_resource_uris:
        return True
    if not allow_derived_read:
        return False
    from nexus.services.agent_tools.read_resource import parse_page_range
    from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
    from nexus.services.resource_graph.resolve import parent_media_id_for_read_pointer

    page_range = parse_page_range(uri)
    if page_range is not None:
        return f"media:{page_range[0]}" in admitted_resource_uris
    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        return False
    parent_id = parent_media_id_for_read_pointer(db, scheme=parsed.scheme, resource_id=parsed.id)
    return parent_id is not None and f"media:{parent_id}" in admitted_resource_uris


__all__ = ["resource_uri_is_admitted", "tool_arguments_within_admitted_scope"]
