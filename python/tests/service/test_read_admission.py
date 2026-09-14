"""Expensive route work retains its permit across client cancellation and send."""

import asyncio
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from threading import Event
from typing import Annotated

import httpx
import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.routing import APIRoute
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.types import Message, Receive, Scope, Send

import nexus
from nexus.api.read_admission import (
    AdmittedPackageTransferRoute,
    AdmittedReadRoute,
    ReadAdmission,
)
from nexus.api.routes import offline_reading
from nexus.db.session import get_db
from nexus.logging import request_id_var
from tests.testkit.auth import UserRecord
from tests.testkit.read_admission import production_read_app


def test_cancelled_sync_read_retains_admission_until_its_response_finishes(
    db_session: Session, test_user: UserRecord
) -> None:
    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        response_finished = asyncio.Event()
        release = Event()
        calls = 0
        transactions = []
        app, headers = production_read_app(db_session, test_user)
        router = APIRouter(route_class=AdmittedReadRoute)

        def materialize(db: Annotated[Session, Depends(get_db)]) -> dict:
            nonlocal calls
            calls += 1
            assert request_id_var.get() == "read-admission"
            transaction = db.scalar(text("SELECT txid_current()"))
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(timeout=5), "the test did not release its materializing thread"
            assert request_id_var.get() == "read-admission"
            transactions.append((transaction, db.scalar(text("SELECT txid_current()"))))
            return {"value": "read"}

        router.add_api_route("/read", materialize, methods=["GET"])
        app.include_router(router)

        @app.get("/progress")
        def progress() -> dict:
            return {"saved": True}

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def sent(message: Message) -> None:
                await send(message)
                if scope["path"] == "/read" and message["type"] == "http.response.body":
                    if message.get("body") == b'{"value":"read"}':
                        response_finished.set()

            await app(scope, receive, sent)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            opening = asyncio.create_task(client.get("/read"))
            try:
                await asyncio.wait_for(entered.wait(), timeout=5)
                for _ in range(2):
                    opening.cancel()
                    assert (await client.get("/progress")).json() == {"saved": True}
                    assert not opening.done(), (
                        "cancellation unwound request session ownership early"
                    )
                busy = await client.get("/read")
                assert busy.status_code == 503, "cancelled sync work released foreground admission"
                assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
                assert busy.headers["retry-after"] == "1"
                assert busy.headers["x-request-id"] == "read-admission"
                assert "nexus_auth" in busy.headers["server-timing"]
                assert calls == 1, "overload ran another materializing dependency"
                assert (await client.get("/progress")).json() == {"saved": True}
            finally:
                release.set()
                await asyncio.wait_for(response_finished.wait(), timeout=5)
                with pytest.raises(asyncio.CancelledError):
                    await opening
            assert (await client.get("/read")).status_code == 200
            assert all(before == after for before, after in transactions), (
                "request cleanup closed the synchronous worker's transaction after cancellation"
            )

    asyncio.run(scenario())


def test_sync_read_deadline_retains_its_transaction_and_permit_until_worker_returns(
    db_session: Session, test_user: UserRecord
) -> None:
    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        worker_finished = asyncio.Event()
        release = Event()
        transactions = []
        calls = 0
        app, headers = production_read_app(db_session, test_user)
        app.state.read_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=262144
        )
        router = APIRouter(route_class=AdmittedReadRoute)

        @router.get("/read")
        def materialize(db: Annotated[Session, Depends(get_db)]) -> dict:
            nonlocal calls
            calls += 1
            transaction = db.scalar(text("SELECT txid_current()"))
            loop.call_soon_threadsafe(entered.set)
            try:
                assert release.wait(timeout=5), "the test did not release its materializing thread"
                transactions.append((transaction, db.scalar(text("SELECT txid_current()"))))
                return {"value": "read"}
            finally:
                loop.call_soon_threadsafe(worker_finished.set)

        app.include_router(router)

        @app.get("/progress")
        def progress() -> dict:
            return {"saved": True}

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
        ) as client:
            opening = asyncio.create_task(client.get("/read"))
            retired = None
            finished_while_held = None
            busy = None
            progress = None
            observed_calls = None
            observation_error = None
            worker_error = None
            request_error = None
            try:
                await asyncio.wait_for(entered.wait(), timeout=5)
                # The actual one-second deadline must expire while the physical
                # worker is held. wait() observes completion without cancelling it.
                done, _ = await asyncio.wait({opening}, timeout=1.1)
                retired = bool(done)
                finished_while_held = worker_finished.is_set()
                if not retired:
                    busy = await client.get("/read")
                    observed_calls = calls
                    progress = await client.get("/progress")
            except Exception as error:
                observation_error = error
            finally:
                release.set()
                try:
                    await asyncio.wait_for(worker_finished.wait(), timeout=5)
                except Exception as error:
                    worker_error = error
                try:
                    await asyncio.wait_for(opening, timeout=5)
                except (Exception, asyncio.CancelledError) as error:
                    request_error = error
            # Cleanup failures must not replace the ownership observation made
            # while the worker was still held. Keep both exact causes available.
            if observation_error is not None:
                raise observation_error
            assert retired is not None
            assert not retired, "the deadline retired a live synchronous worker"
            assert finished_while_held is False
            assert worker_error is None, worker_error
            assert busy is not None and busy.status_code == 503, (
                "the expired live worker released its permit"
            )
            assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
            assert busy.headers["retry-after"] == "1"
            assert observed_calls == 1, "overload entered a second materializing worker"
            assert progress is not None and progress.json() == {"saved": True}
            assert isinstance(request_error, RuntimeError), request_error
            assert str(request_error) == "admitted read exceeded its qualified permit deadline"
            assert len(transactions) == 1
            assert transactions[0][0] == transactions[0][1], (
                "deadline cleanup closed the live worker's transaction"
            )
            assert (await client.get("/read")).status_code == 200, (
                "the completed worker never returned its permit"
            )

    asyncio.run(scenario())


def test_route_owned_timeout_settles_admission_instead_of_spinning() -> None:
    # A timeout in this event loop is the fault itself. The parent bounds its
    # direct child so the old implementation cannot wedge the test runner.
    script = """
import asyncio

import httpx
from fastapi import APIRouter, FastAPI

from nexus.api.read_admission import AdmittedReadRoute, ReadAdmission


async def scenario():
    app = FastAPI()
    app.state.read_admission = ReadAdmission(
        max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=1024
    )
    router = APIRouter(route_class=AdmittedReadRoute)
    original = TimeoutError("timeout owned by the route")

    @router.get("/timeout")
    async def route_timeout():
        print("route-timeout-entered", flush=True)
        raise original

    @router.get("/available")
    async def available():
        return {"available": True}

    app.include_router(router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        caught = None
        try:
            await client.get("/timeout")
        except TimeoutError as error:
            caught = error
        assert caught is original, "admission replaced the route's original timeout"
        assert str(caught) == "timeout owned by the route"
        response = await client.get("/available")
        assert response.status_code == 200
        assert response.json() == {"available": True}
    print("route-timeout-settled", flush=True)


asyncio.run(scenario())
"""
    try:
        completed = subprocess.run(
            (sys.executable, "-c", script), capture_output=True, timeout=10, check=False
        )
    except subprocess.TimeoutExpired as error:
        if b"route-timeout-entered" not in (error.stdout or b""):
            raise RuntimeError("timeout probe did not reach its admitted route") from error
        pytest.fail("route-owned timeout failed to settle admission")
    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    assert b"route-timeout-settled" in completed.stdout


def test_read_admission_precedes_dependencies_and_covers_body_transfer(
    db_session: Session, test_user: UserRecord
) -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        dependency_calls = 0
        body_receives = 0
        app, headers = production_read_app(db_session, test_user)
        router = APIRouter(route_class=AdmittedReadRoute)

        def dependency() -> None:
            nonlocal dependency_calls
            dependency_calls += 1

        @router.get("/read", dependencies=[Depends(dependency)])
        def read() -> dict:
            return {"value": "read"}

        @router.post("/contributors/capacity-proof", dependencies=[Depends(dependency)])
        def read_body(body: dict) -> dict:
            return body

        app.include_router(router)

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def counted_receive() -> Message:
                nonlocal body_receives
                if scope["path"] == "/contributors/capacity-proof":
                    body_receives += 1
                return await receive()

            async def blocked_send(message: Message) -> None:
                if (
                    message["type"] == "http.response.body"
                    and message.get("body") == b'{"value":"read"}'
                ):
                    started.set()
                    await release.wait()
                await send(message)

            await app(scope, counted_receive, blocked_send)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            opening = asyncio.create_task(client.get("/read"))
            try:
                await asyncio.wait_for(started.wait(), timeout=5)
                busy = await client.get("/read")
                assert busy.status_code == 503, "body transfer escaped read admission"
                assert dependency_calls == 1, "rejected read entered dependency materialization"
                rejected_body = await client.post(
                    "/contributors/capacity-proof",
                    content=b"{malformed",
                    headers={"Content-Type": "application/json"},
                )
                assert rejected_body.status_code == 503, "JSON parsed before route admission"
                assert body_receives == 0, "overloaded route read its request body"
            finally:
                release.set()
                assert (await opening).status_code == 200
            assert (await client.get("/read")).status_code == 200
            malformed = await client.post(
                "/contributors/capacity-proof",
                content=b"{malformed",
                headers={"Content-Type": "application/json"},
            )
            assert malformed.status_code == 400
            assert malformed.json()["error"]["code"] == "E_INVALID_REQUEST"

    asyncio.run(scenario())


def test_permit_deadline_returns_capacity_and_reports_a_defect(
    db_session: Session, test_user: UserRecord
) -> None:
    """A transfer no client ever finishes must not hold foreground capacity."""

    async def scenario() -> None:
        started = asyncio.Event()
        never = asyncio.Event()
        app, headers = production_read_app(db_session, test_user)
        app.state.read_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=262144
        )
        router = APIRouter(route_class=AdmittedReadRoute)

        @router.get("/read")
        def read() -> dict:
            return {"value": "read"}

        app.include_router(router)

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def stalled_send(message: Message) -> None:
                if (
                    message["type"] == "http.response.body"
                    and message.get("body") == b'{"value":"read"}'
                ):
                    started.set()
                    await never.wait()
                await send(message)

            await app(scope, receive, stalled_send)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            opening = asyncio.create_task(client.get("/read"))
            await asyncio.wait_for(started.wait(), timeout=5)
            assert (await client.get("/read")).status_code == 503, (
                "the stalled transfer released its permit before its deadline"
            )
            with pytest.raises(RuntimeError):
                await asyncio.wait_for(opening, timeout=5)
            assert (await client.get("/read")).status_code == 200, (
                "the expired permit never returned to the foreground pool"
            )

    asyncio.run(scenario())


def test_an_oversized_request_body_is_refused_before_the_route_reads_it(
    db_session: Session, test_user: UserRecord
) -> None:
    """No admitted route may make the process hold an unbounded request body.

    A dependency cannot do this: FastAPI has already read and parsed the body by
    the time one runs. The bound therefore belongs to the same transport owner
    that admits the read, which is the only place that sees the declaration
    before the first byte and can stop consuming the stream at the limit.
    """

    async def scenario() -> None:
        body_receives = 0
        endpoint_calls = 0
        app, headers = production_read_app(db_session, test_user)
        app.state.read_admission = ReadAdmission(
            max_concurrency=2, deadline_seconds=30, retry_after_seconds=1, request_bytes=1024
        )
        router = APIRouter(route_class=AdmittedReadRoute)

        @router.post("/read-body")
        async def read_body(request: Request) -> dict:
            nonlocal endpoint_calls
            endpoint_calls += 1
            return {"bytes": len(await request.body())}

        app.include_router(router)

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def counted_receive() -> Message:
                nonlocal body_receives
                body_receives += 1
                return await receive()

            await app(scope, counted_receive, send)

        async def streamed() -> AsyncIterator[bytes]:
            yield b"x" * 512
            yield b"x" * 513

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            declared = await client.post("/read-body", content=b"x" * 1025)
            assert declared.status_code == 413
            assert declared.json()["error"]["code"] == "E_REQUEST_TOO_LARGE"
            assert body_receives == 0, "a declared oversize body was read before it was refused"
            # A chunked body declares no length, so only the stream itself bounds
            # it: two chunks are consumed and the third that would cross the
            # profile is never asked for.
            chunked = await client.post("/read-body", content=streamed())
            assert chunked.status_code == 413
            assert chunked.json()["error"]["code"] == "E_REQUEST_TOO_LARGE"
            assert body_receives == 2, "the oversized stream kept being consumed past its bound"
            assert endpoint_calls == 1, "the refusal did not come from this route's own read"
            accepted = await client.post("/read-body", content=b"x" * 1024)
            assert accepted.status_code == 200 and accepted.json() == {"bytes": 1024}

    asyncio.run(scenario())


def test_client_disconnect_on_a_self_read_body_is_not_an_internal_defect(
    db_session: Session, test_user: UserRecord
) -> None:
    """Routes that read their own body classify a hangup exactly as FastAPI's does."""

    async def scenario() -> None:
        app, headers = production_read_app(db_session, test_user)

        @app.post("/contributors/self-read-body")
        async def self_read_body(request: Request) -> dict:
            return {"bytes": len(await request.body())}

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def disconnecting_receive() -> Message:
                return {"type": "http.disconnect"}

            await app(scope, disconnecting_receive, send)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            response = await client.post("/contributors/self-read-body", content=b'{"a":1}')
            assert response.status_code == 499
            assert response.json()["error"]["code"] == "E_CLIENT_DISCONNECT"

    asyncio.run(scenario())


def test_package_transfer_holds_its_own_budget_and_leaves_reads_admitted(
    db_session: Session, test_user: UserRecord
) -> None:
    """Offline package bytes may fill their own pool without closing the reader."""
    transfer, status = (
        next(
            route
            for route in offline_reading.router.routes
            if isinstance(route, APIRoute) and route.path == path
        )
        for path in (
            "/offline-reading/packages/{media_id}",
            "/media/{media_id}/reader-publications/{generation}/offline-package",
        )
    )
    assert isinstance(transfer, AdmittedPackageTransferRoute)
    assert type(status) is APIRoute, "mint/status lost the lightweight headroom they reserve"

    async def scenario() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        app, headers = production_read_app(db_session, test_user)
        reads = APIRouter(route_class=AdmittedReadRoute)
        transfers = APIRouter(route_class=AdmittedPackageTransferRoute)

        @reads.get("/read")
        def read() -> dict:
            return {"value": "read"}

        @transfers.get("/transfer")
        def package() -> dict:
            return {"value": "package"}

        app.include_router(reads)
        app.include_router(transfers)

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def held_send(message: Message) -> None:
                if (
                    message["type"] == "http.response.body"
                    and message.get("body") == b'{"value":"package"}'
                ):
                    started.set()
                    await release.wait()
                await send(message)

            await app(scope, receive, held_send)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            opening = asyncio.create_task(client.get("/transfer"))
            try:
                await asyncio.wait_for(started.wait(), timeout=5)
                busy = await client.get("/transfer")
                assert busy.status_code == 503, "package transfers escaped their budget"
                assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
                assert (await client.get("/read")).status_code == 200, (
                    "a package transfer consumed the reserved foreground read budget"
                )
            finally:
                release.set()
                assert (await opening).status_code == 200

    asyncio.run(scenario())


def test_this_owner_is_the_only_producer_of_the_capacity_code() -> None:
    """`E_READ_CAPACITY` carries exactly one meaning: this pool is momentarily
    full, retry after the advertised seconds, and `retryPolicy.ts` replays it
    three times on that promise. A second producer — a deterministic oversize
    that fails identically on every attempt — would silently restore that replay
    and make a permanently unservable document indistinguishable in telemetry
    from a busy server. Deterministic oversize is `E_READER_CONTENT_TOO_LARGE`
    (422) instead; see tests/service/test_reader_content_too_large.py."""
    package = Path(nexus.__file__).parent
    producers = sorted(
        module.relative_to(package).as_posix()
        for module in package.rglob("*.py")
        if module.name != "errors.py" and "E_READ_CAPACITY" in module.read_text()
    )

    assert producers == ["api/read_admission.py"], (
        f"only the read admission owner may raise the retryable capacity code: {producers}"
    )
