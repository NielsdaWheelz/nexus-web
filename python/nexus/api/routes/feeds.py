"""Shared source catalogue, exact acquisition commands and durable OPML admission."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import feed as wire
from nexus.schemas.collection_index import CollectionIndex
from nexus.schemas.consumption import ConsumptionData
from nexus.services import media_deletion
from nexus.services.consumption import observation
from nexus.services.feeds import catalog, entries, opml, queries, subscriptions, sync

router = APIRouter(tags=["feeds"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/feeds/resolve")
def resolve_feed(
    body: wire.FeedResolveRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.FeedResolveOut]:
    return Data(data=catalog.resolve_feed(db, viewer.user_id, body))


@router.get("/feeds")
def list_feeds(
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    sort: Literal["recent_entry", "unfinished_count", "alpha"] = "recent_entry",
    filter: Literal["all", "has_new", "not_in_library"] = "all",
    library_id: UUID | None = None,
    kind: wire.FeedKind | None = None,
) -> ConsumptionData[CollectionIndex[wire.FeedIndexItemOut]]:
    data = queries.list_feeds(
        db, viewer.user_id, sort=sort, filter=filter, library_id=library_id, kind=kind
    )
    return observation.stamp(db, viewer.user_id, data, [])


@router.post("/feeds/action-facts/resolve")
def feed_action_facts(
    body: wire.FeedActionFactsResolveRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[wire.FeedActionFactsOut]:
    return Data(data=queries.action_facts(db, viewer_id=viewer.user_id, targets=body.targets))


@router.post("/feeds/opml/preview")
def preview_opml(body: wire.OpmlPreviewRequest, viewer: ViewerDep) -> Data[wire.OpmlPreviewOut]:
    return Data(data=opml.preview(body.xml))


@router.get("/feeds/opml")
def export_opml(
    viewer: ViewerDep, db: RepeatableReadDbSession, library_id: UUID | None = None
) -> Response:
    return Response(
        opml.export(db, viewer.user_id, library_id),
        media_type="application/xml",
        headers={
            "Content-Disposition": 'attachment; filename="subscriptions.opml"',
            "Cache-Control": "private, no-store",
        },
    )


class OpmlImportsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[wire.OpmlImportSummaryOut]


@router.get("/feed-opml-imports")
def list_opml_imports(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[OpmlImportsOut]:
    return Data(data=OpmlImportsOut(items=opml.list_imports(db, viewer.user_id)))


@router.post("/feed-opml-imports", status_code=202)
def create_opml_import(
    body: wire.OpmlImportCreateRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.OpmlImportOut]:
    return Data(data=opml.create(db, viewer.user_id, body))


@router.get("/feed-opml-imports/{import_id}")
def get_opml_import(
    import_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[wire.OpmlImportOut]:
    return Data(data=opml.get_import(db, viewer.user_id, import_id))


@router.post("/feed-opml-imports/{import_id}/cancel")
def cancel_opml_import(
    import_id: UUID, body: wire.OpmlImportMutationRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.OpmlImportOut]:
    return Data(data=opml.cancel(db, viewer.user_id, import_id, body))


@router.post("/feed-opml-imports/{import_id}/retry", status_code=202)
def retry_opml_import(
    import_id: UUID, body: wire.OpmlImportMutationRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.OpmlImportOut]:
    return Data(data=opml.retry(db, viewer.user_id, import_id, body))


@router.post("/feeds/refresh", status_code=202)
def refresh_feeds(
    body: wire.FeedRefreshManualScope, viewer: ViewerDep, db: DbSession
) -> Data[wire.FeedRefreshAcceptedOut]:
    return Data(
        data=wire.FeedRefreshAcceptedOut(requested_count=sync.refresh(db, viewer.user_id, body))
    )


@router.get("/feeds/{feed_id}/removal-preview")
def feed_removal_preview(
    feed_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    scope: Literal["all", "library"] = Query(...),
    items: Literal["keep", "remove"] = Query(...),
    library_id: UUID | None = None,
) -> Data[wire.FeedRemovalPreviewOut]:
    return Data(
        data=subscriptions.removal_preview(
            db, viewer.user_id, feed_id, scope=scope, items=items, library_id=library_id
        )
    )


@router.post("/feeds/{feed_id}/stop")
def stop_feed(
    feed_id: UUID, body: wire.FeedStopRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.FeedStopOut]:
    return Data(data=subscriptions.stop(db, viewer.user_id, feed_id, body))


@router.get("/feeds/{feed_id}")
def get_feed(
    feed_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> ConsumptionData[wire.FeedDetailOut]:
    return observation.stamp(
        db, viewer.user_id, queries.get_feed_detail(db, viewer.user_id, feed_id), []
    )


@router.get("/feeds/{feed_id}/entries")
def list_entries(
    feed_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    state: wire.EntryState = "all",
    sort: wire.EntrySort = "newest",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> ConsumptionData[wire.FeedEntryIndexOut]:
    data = entries.list_entries(
        db, viewer.user_id, feed_id, state=state, sort=sort, cursor=cursor, limit=limit
    )
    return observation.stamp(
        db, viewer.user_id, data, [item.media_summary.media_id for item in data.items]
    )


@router.get("/feed-entries/{media_id}/removal-preview")
def entry_removal_preview(
    media_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[wire.FeedEntryRemovalPreviewOut]:
    return Data(data=media_deletion.feed_entry_removal_preview(db, viewer.user_id, media_id))


@router.post("/feed-entries/{media_id}/remove")
def remove_entry(
    media_id: UUID, body: wire.FeedEntryRemovalRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.FeedEntryRemovalOut]:
    return Data(data=media_deletion.remove_feed_entry(db, viewer.user_id, media_id, body))
