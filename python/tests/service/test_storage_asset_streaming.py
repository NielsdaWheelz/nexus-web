"""Stored assets preserve their real row authority and bounded transfer ordering."""

import asyncio
import io
from threading import Event
from uuid import UUID, uuid4

import httpx
import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from botocore.response import StreamingBody
from sqlalchemy import Engine
from sqlalchemy.orm import Session
from starlette.types import Message, Receive, Scope, Send

from nexus.api.read_admission import ReadAdmission
from nexus.db.models import EpubResource, Media, MediaKind, OraclePlate, ProcessingStatus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import UserRecord
from tests.testkit.read_admission import production_read_app


def _seed_asset(
    engine: Engine, *, asset_kind: str, expected: bytes
) -> tuple[UserRecord, UUID, str, str]:
    viewer_id, resource_id = uuid4(), uuid4()
    email = f"asset-stream-{viewer_id}@example.invalid"
    storage_path = (
        f"media/{resource_id}/selected/figure.svg"
        if asset_kind == "epub"
        else f"oracle/plates/{resource_id}.png"
    )
    with Session(engine) as db:
        default_library_id = ensure_user_and_default_library(db, viewer_id, email)
        if asset_kind == "epub":
            db.add(
                Media(
                    id=resource_id,
                    kind=MediaKind.epub.value,
                    title="Actual stored asset",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=viewer_id,
                )
            )
            db.flush()
            ensure_media_in_default_library(db, viewer_id, resource_id)
            db.add(
                EpubResource(
                    media_id=resource_id,
                    package_href="Images/figure.svg",
                    asset_key="figures/selected.svg",
                    storage_path=storage_path,
                    content_type="image/svg+xml",
                    size_bytes=len(expected),
                )
            )
        else:
            db.add(
                OraclePlate(
                    id=resource_id,
                    source_repository="stream-proof",
                    source_url=f"https://example.invalid/{resource_id}.png",
                    artist="Independent source",
                    work_title="Exact plate",
                    attribution_text="Fixture",
                    width=2,
                    height=3,
                    storage_key=storage_path,
                    content_type="image/png",
                    byte_size=len(expected),
                    tags=[],
                )
            )
        db.commit()
    path = (
        f"/media/{resource_id}/assets/figures/selected.svg"
        if asset_kind == "epub"
        else f"/oracle/plates/{resource_id}"
    )
    return UserRecord(viewer_id, email, default_library_id), resource_id, path, storage_path


@pytest.mark.parametrize("asset_kind", ("epub", "oracle"))
def test_stored_asset_sends_bounded_bytes_before_reading_the_complete_object(
    engine: Engine,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    asset_kind: str,
) -> None:
    # Body bytes are transport input, not a newly decoded image qualification.
    expected = b"a" * 65536 + b"b" * 65536 + b"c" * 65536 + b"last exact bytes"
    viewer, resource_id, path, storage_path = _seed_asset(
        engine, asset_kind=asset_kind, expected=expected
    )
    requests: list[dict] = []
    reads: list[int] = []
    returned_bytes = 0
    close_count = 0
    source = io.BytesIO(expected)

    class ObjectBody:
        def read(self, amount: int) -> bytes:
            nonlocal returned_bytes
            reads.append(amount)
            chunk = source.read(amount)
            returned_bytes += len(chunk)
            return chunk

        def close(self) -> None:
            nonlocal close_count
            close_count += 1
            source.close()

    original_call = BaseClient._make_api_call

    def storage_api(client, operation_name, api_params):
        if operation_name != "GetObject":
            return original_call(client, operation_name, api_params)
        requests.append(dict(api_params))
        assert api_params["Key"] == storage_path
        assert "Range" not in api_params
        return {"Body": StreamingBody(ObjectBody(), len(expected))}

    monkeypatch.setattr(BaseClient, "_make_api_call", storage_api)

    async def scenario() -> None:
        # Auth bootstrap uses a real committed viewer; the public plate still
        # bypasses viewer authorization through its actual production route.
        app, headers = production_read_app(db_session, viewer)
        sent = 0
        body_observations: list[tuple[int, int]] = []

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def observe(message: Message) -> None:
                nonlocal sent
                if message["type"] == "http.response.body" and message.get("body"):
                    body_observations.append((len(message["body"]), returned_bytes))
                    sent += len(message["body"])
                await send(message)

            await app(scope, receive, observe)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            if asset_kind == "oracle":
                unchanged = await client.get(
                    path, headers={"If-None-Match": f'"oracle-plate-{resource_id}"'}
                )
                assert unchanged.status_code == 304
                assert requests == [], "unchanged Oracle plate opened storage"
            response = await client.get(path)
        assert response.status_code == 200
        assert response.content == expected
        assert body_observations[0][1] < len(expected), (
            "stored asset was fully materialized before the first body transfer"
        )
        assert body_observations[0][1] == 2 * 65536
        assert all(length <= 65536 for length, _read_bytes in body_observations)
        assert response.headers["content-length"] == str(len(expected))
        assert response.headers["x-content-type-options"] == "nosniff"
        if asset_kind == "epub":
            assert response.headers["content-type"].startswith("image/svg+xml")
            assert response.headers["cache-control"] == "private, max-age=86400"
            assert response.headers["content-security-policy"] == (
                "default-src 'none'; img-src 'self' data:; script-src 'none'; "
                "object-src 'none'; base-uri 'none'"
            )
        else:
            assert response.headers["content-type"] == "image/png"
            assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
            assert response.headers["etag"] == f'"oracle-plate-{resource_id}"'
        assert sent == len(expected)

    asyncio.run(scenario())
    assert len(requests) == 1
    assert reads and set(reads) == {65536}
    assert close_count == 1


@pytest.mark.parametrize("asset_kind", ("epub", "oracle"))
@pytest.mark.parametrize("failure", ("missing", "initial-short"))
def test_stored_asset_initial_storage_failure_keeps_its_preheader_error(
    engine: Engine,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    asset_kind: str,
    failure: str,
) -> None:
    viewer, _resource_id, path, storage_path = _seed_asset(
        engine, asset_kind=asset_kind, expected=b"abcdef"
    )
    requests: list[dict] = []
    closes = 0
    source = io.BytesIO(b"abcde")

    class ShortBody:
        def read(self, amount: int) -> bytes:
            return source.read(amount)

        def close(self) -> None:
            nonlocal closes
            closes += 1
            source.close()

    original_call = BaseClient._make_api_call

    def storage_api(client, operation_name, api_params):
        if operation_name != "GetObject":
            return original_call(client, operation_name, api_params)
        requests.append(dict(api_params))
        if failure == "missing":
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "absent"}}, "GetObject")
        return {"Body": StreamingBody(ShortBody(), 5)}

    monkeypatch.setattr(BaseClient, "_make_api_call", storage_api)

    async def scenario() -> None:
        app, headers = production_read_app(db_session, viewer)
        starts: list[int] = []

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def observe(message: Message) -> None:
                if message["type"] == "http.response.start":
                    starts.append(message["status"])
                await send(message)

            # This is the installed Uvicorn/Starlette task-group protocol.
            await app(
                {**scope, "asgi": {"version": "3.0", "spec_version": "2.3"}}, receive, observe
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            response = await client.get(path)
        assert starts == [500], "initial storage failure committed successful asset headers"
        assert response.status_code == 500
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["error"]["code"] == "E_STORAGE_ERROR"
        assert response.json()["error"]["message"] == (
            "Stored EPUB asset object is missing or unreadable"
            if asset_kind == "epub"
            else "Oracle plate object is missing or unreadable"
        )

    asyncio.run(scenario())
    assert len(requests) == 1 and requests[0]["Key"] == storage_path
    assert closes == (0 if failure == "missing" else 1)


@pytest.mark.parametrize("termination", ("deadline", "disconnect"))
def test_stored_asset_retains_admission_through_held_sdk_read_and_close(
    engine: Engine,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    termination: str,
) -> None:
    expected = b"a" * 65536 + b"b" * 65536 + b"c" * 65536 + b"end"
    viewer, _resource_id, path, storage_path = _seed_asset(
        engine, asset_kind="oracle", expected=expected
    )

    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        read_entered = asyncio.Event()
        read_finished = asyncio.Event()
        close_entered = asyncio.Event()
        close_finished = asyncio.Event()
        disconnect = asyncio.Event()
        disconnect_delivered = asyncio.Event()
        release_read = Event()
        release_close = Event()
        bodies = []
        requests = []
        sent: list[Message] = []
        close_raced_read: list[bool] = []

        class ObjectBody:
            def __init__(self) -> None:
                self.source = io.BytesIO(expected)
                self.reads = 0
                self.closes = 0

            def read(self, amount: int) -> bytes:
                self.reads += 1
                if bodies[0] is self and self.reads == 3:
                    loop.call_soon_threadsafe(read_entered.set)
                    try:
                        assert release_read.wait(timeout=10), "proof did not release the SDK read"
                        return self.source.read(amount)
                    finally:
                        loop.call_soon_threadsafe(read_finished.set)
                return self.source.read(amount)

            def close(self) -> None:
                self.closes += 1
                if bodies[0] is self:
                    close_raced_read.append(not read_finished.is_set())
                    loop.call_soon_threadsafe(close_entered.set)
                    try:
                        assert release_close.wait(timeout=10), "proof did not release SDK close"
                        self.source.close()
                    finally:
                        loop.call_soon_threadsafe(close_finished.set)
                else:
                    self.source.close()

        original_call = BaseClient._make_api_call

        def storage_api(client, operation_name, api_params):
            if operation_name != "GetObject":
                return original_call(client, operation_name, api_params)
            requests.append(dict(api_params))
            body = ObjectBody()
            bodies.append(body)
            return {"Body": StreamingBody(body, len(expected))}

        monkeypatch.setattr(BaseClient, "_make_api_call", storage_api)
        app, headers = production_read_app(db_session, viewer)
        app.state.image_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=262144
        )

        @app.get("/asset-progress")
        async def progress() -> dict:
            return {"saved": True}

        request_received = False

        async def receive() -> Message:
            nonlocal request_received
            if not request_received:
                request_received = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnect.wait()
            disconnect_delivered.set()
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            sent.append(message)

        scope: Scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
            "client": ("127.0.0.1", 12345),
            "server": ("test", 80),
        }
        opening = asyncio.create_task(app(scope, receive, send))
        observations = []
        observation_error = None
        request_error = None
        cleanup_error = None
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
        ) as client:
            try:
                await asyncio.wait_for(read_entered.wait(), timeout=5)
                if termination == "deadline":
                    # Observe the real one-second deadline without cancelling
                    # the request through the test's waiting primitive.
                    await asyncio.wait({opening}, timeout=1.1)
                else:
                    disconnect.set()
                    await asyncio.wait_for(disconnect_delivered.wait(), timeout=5)
                busy = await client.get(path)
                light = await client.get("/asset-progress")
                observations.append(
                    (opening.done(), read_finished.is_set(), close_finished.is_set(), busy, light)
                )
                release_read.set()
                await asyncio.wait_for(close_entered.wait(), timeout=5)
                busy = await client.get(path)
                light = await client.get("/asset-progress")
                observations.append(
                    (opening.done(), read_finished.is_set(), close_finished.is_set(), busy, light)
                )
            except Exception as error:
                observation_error = error
            finally:
                release_read.set()
                release_close.set()
                try:
                    await asyncio.wait_for(opening, timeout=5)
                except (Exception, asyncio.CancelledError) as error:
                    request_error = error
                try:
                    if read_entered.is_set():
                        await asyncio.wait_for(read_finished.wait(), timeout=5)
                    if close_entered.is_set():
                        await asyncio.wait_for(close_finished.wait(), timeout=5)
                except Exception as error:
                    cleanup_error = error
            # Evaluate the observations after releasing physical resources so
            # cleanup cannot bury the ownership oracle or wedge the event loop.
            for index, (retired, read_done, closed, busy, light) in enumerate(observations):
                assert not retired, "asset request retired its live SDK read or close"
                assert read_done is (index == 1)
                assert closed is False
                assert busy.status_code == 503, "asset released admission before SDK close settled"
                assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
                assert busy.headers["retry-after"] == "1"
                assert light.status_code == 200 and light.json() == {"saved": True}
            if observation_error is not None:
                raise observation_error
            assert len(observations) == 2
            assert cleanup_error is None, cleanup_error
            assert close_raced_read == [False], "SDK close raced its executing read"
            assert close_finished.is_set()
            assert len(bodies) == 1 and bodies[0].closes == 1
            assert requests[0]["Key"] == storage_path
            assert not any(
                message["type"] == "http.response.body" and not message["more_body"]
                for message in sent
            ), "cancelled asset stream completed its representation"
            if termination == "deadline":
                assert isinstance(request_error, RuntimeError), request_error
                assert str(request_error) == "admitted read exceeded its qualified permit deadline"
            else:
                assert request_error is None, request_error
            complete = await client.get(path)
            assert complete.status_code == 200 and complete.content == expected
            assert len(bodies) == 2 and bodies[1].closes == 1

    asyncio.run(scenario())
