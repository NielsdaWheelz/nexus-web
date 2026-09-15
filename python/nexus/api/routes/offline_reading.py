"""Authenticated mint/binding endpoints and the scoped direct package lane."""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass
from threading import BoundedSemaphore, Event
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from nexus.auth.bearer import parse_bearer_token
from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.permissions import can_read_media
from nexus.db.session import get_db, get_session_factory
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.responses import success_response
from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
    OFFLINE_READING_READER_BUNDLE_VERSION,
    OFFLINE_READING_READER_CONTRACT_VERSION,
)
from nexus.services import reader_publication, stream_tokens
from nexus.services.offline_reading_delivery import (
    OfflineReadingArchive,
    OfflineReadingAssemblyTimeout,
    build_offline_reading_archive_file,
)
from nexus.services.stream_tokens import VerifiedOfflineReadingPackageToken

router = APIRouter(tags=["offline-reading"])
_PACKAGE_ASSEMBLY_TIMEOUT_SECONDS = 600
# Storage reads are configuration-bounded at at most 60 seconds. Stop admitting
# new work one read quantum before the response deadline so a running worker
# converges before the route returns its timeout.
_PACKAGE_ASSEMBLY_WORK_DEADLINE_SECONDS = 540
# One admitted assembly owns a worker thread, one staging directory, and one
# response file, each bounded by the V1 512 MiB package envelope. Tokens are
# cheap to mint, so admission — not the token — is what keeps this route's
# thread and temp-disk cost proportional to a constant instead of to the number
# of requests one account can open.
PACKAGE_ASSEMBLY_MAX_CONCURRENCY = 2
PACKAGE_ASSEMBLY_BUSY_RETRY_AFTER_SECONDS = 30
_assembly_slots = BoundedSemaphore(PACKAGE_ASSEMBLY_MAX_CONCURRENCY)


@dataclass(frozen=True, slots=True)
class _AssembledPackage:
    artifact: OfflineReadingArchive
    path: str


@router.get("/internal/offline-reading/account-binding")
def get_offline_reading_account_binding(
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Attest the authenticated viewer; renderer input never supplies identity."""
    return success_response(
        {
            "account_id": str(viewer.user_id),
            "protocol_version": 1,
            "package_schema_version": OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
            "reader_contract_version": OFFLINE_READING_READER_CONTRACT_VERSION,
            "minimum_reader_bundle_version": OFFLINE_READING_READER_BUNDLE_VERSION,
        }
    )


@router.post("/internal/media/{media_id}/offline-reading-token")
def create_offline_reading_token(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Authorize current visibility/generation before minting one narrow token."""
    if not can_read_media(db, viewer.user_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    generation = reader_publication.read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for offline reading")
    result = stream_tokens.mint_offline_reading_package_token(
        user_id=viewer.user_id,
        media_id=media_id,
        reader_generation=generation,
    )
    return success_response(
        {
            "token": result.token,
            "package_base_url": result.package_base_url,
            "account_id": str(result.account_id),
            "reader_generation": result.reader_generation,
            "package_schema_version": result.package_schema_version,
            "expires_at": result.expires_at,
        }
    )


@router.get("/offline-reading/packages/{media_id}")
async def get_offline_reading_package(
    request: Request,
    media_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    """Consume one package token and transfer one verified immutable ZIP.

    The handler is async so the request can observe its own client disconnect
    while assembly runs; every blocking database call stays on a worker thread.
    """
    encoded = parse_bearer_token(request.headers.get("authorization"))
    if encoded is None:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Missing or invalid Authorization header",
        )
    token = stream_tokens.verify_offline_reading_package_token(
        encoded,
        expected_media_id=media_id,
    )
    await run_in_threadpool(_authorize_current_publication, db, token=token, media_id=media_id)

    assembled = await _assemble_one_package(request, token=token, media_id=media_id)
    try:
        if assembled.artifact.reader_generation != token.reader_generation:
            raise ApiError(
                ApiErrorCode.E_READER_CONTENT_CHANGED,
                "Reader content changed during package assembly",
            )
        return FileResponse(
            assembled.path,
            media_type=assembled.artifact.media_type,
            headers={
                "Cache-Control": "private, no-store",
                "Content-Digest": assembled.artifact.content_digest,
                "Nexus-Account-Id": str(token.user_id),
                "Nexus-Reader-Generation": str(assembled.artifact.reader_generation),
                "Nexus-Expanded-Length": str(assembled.artifact.expanded_length),
                "X-Content-Type-Options": "nosniff",
            },
            background=BackgroundTask(_remove_temp_file, assembled.path),
        )
    except BaseException:
        _remove_temp_file(assembled.path)
        raise


def _authorize_current_publication(
    db: Session,
    *,
    token: VerifiedOfflineReadingPackageToken,
    media_id: UUID,
) -> None:
    """Authorize the token subject against current visibility and generation."""
    if not can_read_media(db, token.user_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    generation = reader_publication.read_ready_publication_generation(db, media_id=media_id)
    if generation is None:
        raise ApiError(
            ApiErrorCode.E_MEDIA_NOT_READY,
            "Media is not ready for offline reading",
        )
    if generation != token.reader_generation:
        raise ApiError(
            ApiErrorCode.E_READER_CONTENT_CHANGED,
            "Reader content changed before package transfer",
        )
    # Visibility/generation are now captured values. Release the request
    # transaction before the durable JTI write or any object-store I/O.
    db.rollback()
    db.close()


async def _assemble_one_package(
    request: Request,
    *,
    token: VerifiedOfflineReadingPackageToken,
    media_id: UUID,
) -> _AssembledPackage:
    """Claim the token and assemble one package inside its bounded envelope.

    Admission precedes the one-use claim: a request this process has no capacity
    to serve is retryable with the token its caller already holds.
    """
    if not _assembly_slots.acquire(blocking=False):
        raise ApiError(
            ApiErrorCode.E_OFFLINE_READING_PACKAGE_BUSY,
            "Offline reading package assembly is at capacity",
            retry_after_seconds=PACKAGE_ASSEMBLY_BUSY_RETRY_AFTER_SECONDS,
        )
    slot_held_here = True
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="offline-reading-package")
    try:
        await run_in_threadpool(stream_tokens.claim_offline_reading_package_token, token)
        descriptor, path = tempfile.mkstemp(prefix="nexus-offline-reading-", suffix=".zip")
        os.close(descriptor)
        cancelled = Event()
        future = executor.submit(
            build_offline_reading_archive_file,
            get_session_factory(),
            media_id=media_id,
            path=path,
            deadline_monotonic=time.monotonic() + _PACKAGE_ASSEMBLY_WORK_DEADLINE_SECONDS,
            cancelled=cancelled.is_set,
        )
        # The worker now owns the admission slot: an abandoned assembly keeps it
        # until it observes cancellation, so no new work starts in its place.
        future.add_done_callback(lambda _future: _release_one_assembly_slot())
        slot_held_here = False
        try:
            artifact = await _awaited_assembly(request, future)
        except BaseException:
            cancelled.set()
            future.cancel()
            future.add_done_callback(lambda _future: _remove_temp_file(path))
            raise
        return _AssembledPackage(artifact=artifact, path=path)
    except BaseException:
        if slot_held_here:
            _release_one_assembly_slot()
        raise
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


async def _awaited_assembly(
    request: Request,
    future: Future[OfflineReadingArchive],
) -> OfflineReadingArchive:
    """Await one assembly, converging on its deadline or the client's disconnect."""
    pending = asyncio.wrap_future(future)
    disconnected = asyncio.ensure_future(_awaited_client_disconnect(request))
    try:
        # asyncio.wait reports expiry without raising, so a worker failure is
        # never confused with the response deadline — the worker's own
        # cooperative deadline is itself a TimeoutError subclass.
        finished, _unfinished = await asyncio.wait(
            (pending, disconnected),
            timeout=_PACKAGE_ASSEMBLY_TIMEOUT_SECONDS,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if pending in finished:
            try:
                return pending.result()
            except OfflineReadingAssemblyTimeout as exc:
                raise ApiError(
                    ApiErrorCode.E_OFFLINE_READING_PACKAGE_TIMEOUT,
                    "Offline reading package assembly timed out",
                ) from exc
        if disconnected in finished:
            raise ApiError(
                ApiErrorCode.E_CLIENT_DISCONNECT,
                "Client disconnected during package assembly",
            )
        raise ApiError(
            ApiErrorCode.E_OFFLINE_READING_PACKAGE_TIMEOUT,
            "Offline reading package assembly timed out",
        )
    finally:
        disconnected.cancel()
        with suppress(asyncio.CancelledError):
            await disconnected


async def _awaited_client_disconnect(request: Request) -> None:
    """Resolve when this request's ASGI receive channel reports the client gone.

    Polling ``Request.is_disconnected()`` cannot see it here: every
    ``BaseHTTPMiddleware`` in the stack replaces the receive channel with an
    awaitable that the already-cancelled probe scope of ``is_disconnected``
    never resolves. Awaiting the channel does deliver ``http.disconnect``.
    """
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


def _release_one_assembly_slot() -> None:
    _assembly_slots.release()


def _remove_temp_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
