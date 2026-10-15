"""Library routes: libraries, their entries and placements. Transport only.

The static `/libraries/destinations` and `/libraries/placements/{ref}` register before
`/libraries/{library_id}…`, whose uuid parameter would refuse them. `{ref}` is a
canonical resource ref, `media:<uuid>` or `podcast:<uuid>`.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.library import (
    CreateLibraryRequest,
    LibraryDestinationOut,
    LibraryEntryOut,
    LibraryOut,
    LibraryPlacementOut,
    MoveEntryRequest,
    PlaceItemRequest,
    RenameLibraryRequest,
)
from nexus.schemas.suggestions import SuggestionsOut
from nexus.services import libraries, library_entries, library_listing
from nexus.services import suggestions as suggestions_service
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["libraries"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


def _target(ref: str) -> library_entries.EntryTarget:
    parsed = parse_resource_ref(ref)
    if isinstance(parsed, ResourceRefParseFailure) or parsed.scheme not in ("media", "podcast"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Expected media:<id> or podcast:<id>"
        )
    return library_entries.EntryTarget(parsed.scheme, parsed.id)


@router.get("/libraries")
def list_libraries(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[LibraryOut]]:
    """`sort` = created_desc | name_asc | name_desc; absent is oldest created."""
    return Data(
        data=libraries.list_libraries(db, viewer.user_id, request.query_params.multi_items())
    )


@router.get("/libraries/destinations")
def list_destinations(
    viewer: ViewerDep,
    db: DbSession,
    q: Annotated[str, Query(max_length=100)] = "",
    cursor: Annotated[str | None, Query(min_length=1)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 25,
) -> Data[CollectionPage[LibraryDestinationOut]]:
    """The named libraries the viewer may file into, best match first."""
    return Data(
        data=libraries.list_writable_library_destinations(
            db, viewer.user_id, q=q, cursor=cursor, limit=limit
        )
    )


@router.get("/libraries/placements/{ref}")
def list_placements(ref: str, viewer: ViewerDep, db: DbSession) -> Data[list[LibraryPlacementOut]]:
    """Where one media or show sits among the viewer's libraries."""
    return Data(
        data=library_entries.list_item_libraries(db, viewer_id=viewer.user_id, target=_target(ref))
    )


@router.post("/libraries", status_code=201)
def create_library(
    body: CreateLibraryRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryOut]:
    return Data(data=libraries.create_library(db, viewer.user_id, body))


@router.get("/libraries/{library_id}")
def get_library(library_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[LibraryOut]:
    """Members only; anyone else gets 404."""
    library = libraries.access(db, viewer.user_id, library_id, lock=False)
    return Data(data=library.out(viewer.user_id))


@router.patch("/libraries/{library_id}")
def rename_library(
    library_id: UUID, body: RenameLibraryRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryOut]:
    return Data(data=libraries.rename_library(db, viewer.user_id, library_id, body))


@router.delete("/libraries/{library_id}", status_code=204)
def delete_library(library_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    libraries.delete_library(db, viewer.user_id, library_id)
    return Response(status_code=204)


@router.get("/libraries/{library_id}/entries")
def list_entries(
    request: Request, library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[LibraryEntryOut]]:
    """`sort`, `entry_type`, `projection`, `completion`: see `library_listing`."""
    view, query = library_listing.parse_entries_query(request.query_params.multi_items())
    return Data(
        data=library_listing.list_library_entries(
            db, viewer.user_id, library_id, view=view, cursor=query.cursor, limit=query.limit
        )
    )


@router.put("/libraries/{library_id}/entries/{entry_id}/position", status_code=204)
def move_entry(
    library_id: UUID, entry_id: UUID, body: MoveEntryRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    library_entries.move_entry(db, viewer.user_id, library_id, entry_id, body.before_entry_id)
    return Response(status_code=204)


@router.get("/libraries/{library_id}/suggestions")
def get_suggestions(
    request: Request, library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[SuggestionsOut]:
    """The library's Reading Slate."""
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Reading Slate does not accept query parameters"
        )
    return Data(
        data=suggestions_service.build_library_suggestions(
            db, viewer_id=viewer.user_id, library_id=library_id
        )
    )


@router.put("/libraries/{library_id}/items/{ref}", status_code=204)
def place_item(
    library_id: UUID, ref: str, body: PlaceItemRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    library_entries.place_item(
        db, viewer.user_id, library_id, _target(ref), replace_episodes=body.replace_episodes
    )
    return Response(status_code=204)


@router.delete("/libraries/{library_id}/items/{ref}", status_code=204)
def unplace_item(library_id: UUID, ref: str, viewer: ViewerDep, db: DbSession) -> Response:
    library_entries.unplace_item(db, viewer.user_id, library_id, _target(ref))
    return Response(status_code=204)
