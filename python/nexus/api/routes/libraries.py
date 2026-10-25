"""Library routes: libraries, their entries and placements. Transport only.

The static `/libraries/destinations` and `/libraries/placements/{ref}` register before
`/libraries/{library_id}…`, whose uuid parameter would refuse them. `{ref}` is a
canonical media resource ref, `media:<uuid>`.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas import podcast as podcast_wire
from nexus.schemas.collection_index import CollectionIndex
from nexus.schemas.consumption import ConsumptionData
from nexus.schemas.library import (
    CreateLibraryRequest,
    LibraryDestinationsOut,
    LibraryEntriesIndexOut,
    LibraryMetadataOut,
    LibraryOrderOut,
    LibraryOut,
    LibraryPlacementOut,
    LibraryPlacementsOut,
    MoveEntryRequest,
    PlaceItemRequest,
    RenameLibraryRequest,
)
from nexus.schemas.suggestions import (
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import libraries, library_entries, library_listing, suggestion_shortlists
from nexus.services.consumption import observation
from nexus.services.podcasts import (
    imports as podcast_imports,
)
from nexus.services.podcasts import (
    subscriptions as podcast_subscriptions,
)
from nexus.services.podcasts import subscriptions_query as podcast_queries

router = APIRouter(tags=["libraries"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/libraries")
def list_libraries(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionIndex[LibraryOut]]:
    """`sort` = created_desc | name_asc | name_desc; absent is oldest created."""
    return Data(
        data=libraries.list_libraries(db, viewer.user_id, request.query_params.multi_items())
    )


@router.get("/libraries/destinations")
def list_destinations(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[LibraryDestinationsOut]:
    """The complete named libraries the viewer may file into."""
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Library destinations do not accept query parameters"
        )
    return Data(data=libraries.list_writable_library_destinations(db, viewer.user_id))


@router.get("/libraries/placements/{ref}")
def list_placements(
    ref: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[LibraryPlacementsOut]:
    """Where one media sits among the viewer's libraries."""
    return Data(
        data=library_entries.list_item_libraries(
            db, viewer_id=viewer.user_id, target=library_entries.parse_entry_target(ref)
        )
    )


@router.post("/libraries", status_code=201)
def create_library(
    body: CreateLibraryRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryOut]:
    return Data(data=libraries.create_library(db, viewer.user_id, body))


@router.get("/libraries/{library_id}")
def get_library(
    library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> ConsumptionData[LibraryOut]:
    """Members only; anyone else gets 404."""
    response.headers["Cache-Control"] = "private, no-store"
    library = libraries.access(db, viewer.user_id, library_id, lock=False)
    return observation.stamp(db, viewer.user_id, library.out(viewer.user_id), [])


@router.get("/libraries/{library_id}/metadata")
def get_library_metadata(
    library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> ConsumptionData[LibraryMetadataOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return observation.stamp(
        db, viewer.user_id, library_listing.metadata(db, viewer.user_id, library_id), []
    )


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
    request: Request,
    library_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    response: Response,
) -> ConsumptionData[LibraryEntriesIndexOut]:
    """`sort`, `entry_type`, `projection`, `completion`: see `library_listing`."""
    response.headers["Cache-Control"] = "private, no-store"
    view = library_listing.parse_entries_query(request.query_params.multi_items())
    data = library_listing.list_library_entries(db, viewer.user_id, library_id, view=view)
    return observation.stamp(
        db, viewer.user_id, data, [row.media_summary.media_id for row in data.items]
    )


@router.get("/libraries/{library_id}/order")
def get_library_order(
    library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[LibraryOrderOut]:
    return Data(data=library_listing.get_library_order(db, viewer.user_id, library_id))


@router.put("/libraries/{library_id}/entries/{entry_id}/position")
def move_entry(
    library_id: UUID, entry_id: UUID, body: MoveEntryRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryOrderOut]:
    return Data(
        data=library_entries.move_entry(
            db,
            viewer.user_id,
            library_id,
            entry_id,
            body.before_entry_id,
            int(body.expected_order_revision),
        )
    )


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
        data=suggestion_shortlists.read_suggestions(
            db, viewer_id=viewer.user_id, library_id=library_id
        )
    )


@router.post("/libraries/{library_id}/suggestions/view")
def reconcile_library_suggestions(
    library_id: UUID,
    request: SuggestionViewIn,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
) -> Data[SuggestionViewOut]:
    return Data(
        data=suggestion_shortlists.reconcile_suggestions_view(
            db, viewer_id=viewer.user_id, library_id=library_id, request=request
        )
    )


@router.post("/libraries/{library_id}/suggestions/refresh", status_code=202)
def refresh_library_suggestions(
    library_id: UUID,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[SuggestionStateOut]:
    return Data(
        data=suggestion_shortlists.request_suggestions_refresh(
            db, viewer_id=viewer.user_id, library_id=library_id
        )
    )


@router.put("/libraries/{library_id}/items/{ref}")
def place_item(
    library_id: UUID, ref: str, body: PlaceItemRequest, viewer: ViewerDep, db: DbSession
) -> Data[LibraryPlacementOut]:
    return Data(
        data=library_entries.set_item(
            db,
            viewer.user_id,
            library_id,
            library_entries.parse_entry_target(ref),
            included=body.included,
            expected_order_revision=int(body.expected_order_revision),
            expected_removal_revision=(
                int(body.expected_removal_revision)
                if body.expected_removal_revision is not None
                else None
            ),
        )
    )


@router.get("/libraries/{library_id}/podcasts")
def library_podcasts(
    library_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> ConsumptionData[podcast_wire.LibraryPodcastsOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return observation.stamp(
        db,
        viewer.user_id,
        podcast_queries.read_library_podcasts(db, viewer.user_id, library_id),
        [],
    )


@router.get("/libraries/{library_id}/podcasts/{podcast_id}")
def library_podcast(
    library_id: UUID,
    podcast_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    response: Response,
) -> ConsumptionData[podcast_wire.LibraryPodcastOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return observation.stamp(
        db,
        viewer.user_id,
        podcast_queries.read_library_podcast(db, viewer.user_id, library_id, podcast_id),
        [],
    )


@router.post("/libraries/{library_id}/podcast-subscriptions", status_code=202)
def create_podcast_subscription(
    library_id: UUID,
    body: podcast_wire.PodcastSubscriptionCreateRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[podcast_wire.PodcastAdmissionOut]:
    return Data(data=podcast_subscriptions.admit(db, viewer.user_id, library_id, body))


@router.post("/libraries/{library_id}/podcast-imports", status_code=202)
def create_podcast_import(
    library_id: UUID,
    body: podcast_wire.PodcastImportCreateRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[podcast_wire.PodcastAdmissionOut]:
    return Data(data=podcast_subscriptions.admit(db, viewer.user_id, library_id, body))


@router.get("/libraries/{library_id}/podcast-imports/{import_id}")
def get_podcast_import(
    library_id: UUID, import_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[podcast_wire.PodcastImportOut]:
    return Data(data=podcast_imports.get_import(db, viewer.user_id, library_id, import_id))


@router.post("/libraries/{library_id}/podcast-imports/{import_id}/cancel")
def cancel_podcast_import(
    library_id: UUID,
    import_id: UUID,
    body: podcast_wire.PodcastImportCancelRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[podcast_wire.PodcastImportOut]:
    return Data(data=podcast_imports.cancel(db, viewer.user_id, library_id, import_id, body))


@router.post("/libraries/{library_id}/podcast-imports/{import_id}/retry", status_code=202)
def retry_podcast_import(
    library_id: UUID,
    import_id: UUID,
    body: podcast_wire.PodcastImportRetryRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[podcast_wire.PodcastImportOut]:
    return Data(data=podcast_imports.retry(db, viewer.user_id, library_id, import_id, body))
