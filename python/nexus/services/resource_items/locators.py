from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.resource_items import (
    ResourceLocatorIn,
    ResourceLocatorResolutionOut,
)
from nexus.services import contributors
from nexus.services.contributor_taxonomy import try_parse_contributor_handle
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_items import surfaces


def resolve_resource_locators(
    db: Session,
    *,
    viewer_id: UUID,
    locators: Sequence[ResourceLocatorIn],
) -> list[ResourceLocatorResolutionOut]:
    return [
        resolve_resource_locator(db, viewer_id=viewer_id, locator=locator) for locator in locators
    ]


def resolve_resource_locator(
    db: Session,
    *,
    viewer_id: UUID,
    locator: ResourceLocatorIn,
) -> ResourceLocatorResolutionOut:
    if locator.kind == "resource_ref":
        ref = parse_resource_ref(locator.ref)
        if isinstance(ref, ResourceRefParseFailure):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Resource locator ref is invalid",
            )
    elif locator.kind == "contributor_handle":
        handle = try_parse_contributor_handle(locator.handle)
        if handle is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Resource locator handle is invalid",
            )
        ref = contributors.resolve_contributor_ref_by_handle(
            db,
            viewer_id=viewer_id,
            contributor_handle=handle,
        )
    else:
        raise AssertionError(f"unhandled resource locator kind: {locator.kind}")

    item = surfaces.resource_item_out(db, viewer_id=viewer_id, ref=ref)
    return ResourceLocatorResolutionOut(
        locator=locator,
        resource_item=item,
        canonical_href=item.route,
    )
