"""The one resource-admission algebra shared by every model tool."""

from __future__ import annotations

from sqlalchemy.orm import Session


def resource_uri_is_admitted(
    db: Session,
    *,
    uri: str,
    admitted_resource_uris: frozenset[str],
    allow_derived_read: bool = False,
) -> bool:
    """Return whether a URI is admitted, directly or as a derived read pointer."""

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


__all__ = ["resource_uri_is_admitted"]
