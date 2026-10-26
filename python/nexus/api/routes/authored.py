"""Authenticated authored replication; snapshot owns its session through cancellation."""

from collections.abc import Callable, Coroutine, Generator
from typing import Annotated, Any
from uuid import UUID

from anyio import CancelScope, to_thread
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from starlette.types import Receive, Scope, Send

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import (
    DbSession,
    RepeatableReadDbSession,
    get_repeatable_read_db,
    get_session_factory,
)
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.authored import (
    AcceptedChanges,
    DownloadChanges,
    ProvisionReplica,
    ScopeInputsPage,
    ScopeInputsRequest,
    ScopeTextPage,
    ScopeTextRequest,
    UploadChanges,
)
from nexus.services import authored
from nexus.services.authored import scope as search_scope


class AuthoredRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def validated(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                if any(
                    error["type"] == "missing"
                    and str(error["loc"][-1]).lower() == "x-nexus-account"
                    for error in exc.errors()
                ):
                    raise ForbiddenError(
                        ApiErrorCode.E_FORBIDDEN, "Account binding is required"
                    ) from exc
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Invalid authored request"
                ) from exc

        return validated


router = APIRouter(prefix="/authored", tags=["authored"], route_class=AuthoredRoute)


def authored_viewer(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    account_id: Annotated[UUID, Header(alias="X-Nexus-Account")],
) -> Viewer:
    """An asserted local binding is a fence, never another account authority."""
    if account_id != viewer.user_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Sign in to the account saved on this device"
        )
    return viewer


ViewerDep = Annotated[Viewer, Depends(authored_viewer)]


class SnapshotResponse(StreamingResponse):
    """Close a suspended database iterator even when response sending is cancelled."""

    def __init__(self, frames: Generator[str, None, None]) -> None:
        self.frames = frames
        super().__init__(
            frames,
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with CancelScope(shield=True):
                await to_thread.run_sync(self.frames.close)


@router.post("/replicas")
def provision(request: ProvisionReplica, viewer: ViewerDep, db: DbSession) -> Data[AcceptedChanges]:
    return Data(data=authored.provision(db, viewer.user_id, request))


@router.post("/changes")
def upload(request: UploadChanges, viewer: ViewerDep, db: DbSession) -> Data[AcceptedChanges]:
    return Data(data=authored.upload(db, viewer.user_id, request))


@router.get("/changes")
def download(
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    after: Annotated[int, Query(ge=0, le=9223372036854775807)] = 0,
) -> Data[DownloadChanges]:
    return Data(data=authored.download(db, viewer.user_id, after))


@router.post("/scope-inputs")
def scope_inputs(
    request: ScopeInputsRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ScopeInputsPage]:
    return Data(data=search_scope.inputs(db, viewer.user_id, request))


@router.post("/scope-text")
def scope_text(
    request: ScopeTextRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ScopeTextPage]:
    return Data(data=search_scope.source_text(db, viewer.user_id, request))


@router.get("/snapshot")
def snapshot(viewer: ViewerDep) -> StreamingResponse:
    def frames() -> Generator[str, None, None]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            try:
                yield from authored.snapshot(db, viewer.user_id)
            finally:
                db.rollback()

    return SnapshotResponse(frames())
