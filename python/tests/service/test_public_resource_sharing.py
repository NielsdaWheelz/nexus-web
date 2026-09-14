"""Priority proof: anonymous bearer links stay bound to one durable subject."""

from __future__ import annotations

import asyncio
import hashlib
from threading import Event
from uuid import UUID, uuid4

import httpx
import pytest
from botocore.client import BaseClient
from botocore.response import StreamingBody
from fastapi import FastAPI
from fastapi.testclient import TestClient
from lxml.html import fragment_fromstring
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session
from starlette.types import Message, Receive, Scope, Send

from nexus.api.read_admission import ReadAdmission
from nexus.db.models import (
    BillingEntitlementOverride,
    EpubNavLocation,
    EpubResource,
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    ProcessingStatus,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.public_resource_security import PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.locator_resolver import resolve_highlight_reader_target_disposition
from nexus.services.public_resource_sharing import highlight_target_available
from nexus.services.resource_grants import (
    LinkGrantAudience,
    UserGrantAudience,
    create_grant,
    delete_grant,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import build_storage_path
from tests.testkit.auth import UserRecord
from tests.testkit.reader_pdf import published_pdf_sources


def _seed_pdf(
    db: Session,
    *,
    owner_id: UUID,
    title: str,
    payload: bytes,
) -> tuple[ResourceRef, str]:
    media_id = uuid4()
    attempt_id = uuid4()
    storage_path = build_storage_path(media_id, "pdf")
    db.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title=title,
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=owner_id,
                page_count=1,
            ),
            MediaSourceAttempt(
                id=attempt_id,
                media_id=media_id,
                created_by_user_id=owner_id,
                source_type="uploaded_pdf_file",
                attempt_no=1,
                status="succeeded",
                intent_key=f"public-share-proof:{media_id}",
            ),
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type="application/pdf",
                size_bytes=len(payload),
                source_sha256=hashlib.sha256(payload).hexdigest(),
            ),
        ]
    )
    db.flush()
    ensure_media_in_default_library(db, owner_id, media_id)
    get_storage_client().put_object(storage_path, payload, "application/pdf")
    return ResourceRef("media", media_id), storage_path


def test_anonymous_link_matrix_binds_each_token_to_one_postgres_and_minio_subject(
    db_session: Session,
    test_user: UserRecord,
    anonymous_client: TestClient,
) -> None:
    """Link, user, invalid, cross-resource, and revoked paths stay distinct."""
    recipient_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        recipient_id,
        f"public-share-recipient-{recipient_id}@example.invalid",
    )
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id,
            plan_tier="plus",
            reason="public resource sharing priority proof",
        )
    )
    first_payload = b"%PDF-1.4 exact first public subject"
    second_payload = b"%PDF-1.4 exact second public subject"
    first, first_path = _seed_pdf(
        db_session,
        owner_id=test_user.id,
        title="First sealed subject",
        payload=first_payload,
    )
    second, second_path = _seed_pdf(
        db_session,
        owner_id=test_user.id,
        title="Second sealed subject",
        payload=second_payload,
    )
    storage = get_storage_client()

    try:
        first_link = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=first,
            audience=LinkGrantAudience(),
        ).grant
        second_link = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=second,
            audience=LinkGrantAudience(),
        ).grant
        user_grant = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=first,
            audience=UserGrantAudience(user_id=recipient_id),
        ).grant
        assert first_link.share_token is not None, (
            f"first link grant {first_link.grant_id} did not expose its bearer token"
        )
        assert second_link.share_token is not None, (
            f"second link grant {second_link.grant_id} did not expose its bearer token"
        )
        assert user_grant.share_token is None, (
            f"user grant {user_grant.grant_id} incorrectly became anonymously bearer-readable"
        )

        first_headers = {"X-Nexus-Share-Token": str(first_link.share_token)}
        second_headers = {"X-Nexus-Share-Token": str(second_link.share_token)}
        first_bootstrap = anonymous_client.get(
            "/public/resource-share",
            headers=first_headers,
        )
        second_bootstrap = anonymous_client.get(
            "/public/resource-share",
            headers=second_headers,
        )
        assert first_bootstrap.status_code == 200, (
            f"first bearer grant failed bootstrap: {first_bootstrap.text}"
        )
        assert second_bootstrap.status_code == 200, (
            f"second bearer grant failed bootstrap: {second_bootstrap.text}"
        )
        assert first_bootstrap.json()["data"]["media"]["title"] == "First sealed subject", (
            f"first token resolved the wrong durable subject: {first_bootstrap.json()!r}"
        )
        assert second_bootstrap.json()["data"]["media"]["title"] == "Second sealed subject", (
            f"second token resolved the wrong durable subject: {second_bootstrap.json()!r}"
        )

        first_file = anonymous_client.get(
            "/public/resource-share/file",
            headers=first_headers,
        )
        second_file = anonymous_client.get(
            "/public/resource-share/file",
            headers=second_headers,
        )
        assert first_file.status_code == 200 and first_file.content == first_payload, (
            "first token did not stream exactly its PostgreSQL-owned MinIO object: "
            f"status={first_file.status_code}, body={first_file.content!r}"
        )
        assert second_file.status_code == 200 and second_file.content == second_payload, (
            "second token escaped its grant or streamed the wrong MinIO object: "
            f"status={second_file.status_code}, body={second_file.content!r}"
        )

        invalid = anonymous_client.get(
            "/public/resource-share",
            headers={"X-Nexus-Share-Token": "not-a-share-token"},
        )
        missing = anonymous_client.get("/public/resource-share")
        assert (invalid.status_code, invalid.json()["error"]["code"]) == (
            404,
            "E_NOT_FOUND",
        ), f"invalid bearer token was not masked: {invalid.text}"
        assert (missing.status_code, missing.json()["error"]["code"]) == (
            404,
            "E_NOT_FOUND",
        ), f"missing bearer token was not masked: {missing.text}"

        delete_grant(
            db_session,
            viewer_user_id=test_user.id,
            handle=first_link.handle,
        )
        revoked = anonymous_client.get(
            "/public/resource-share",
            headers=first_headers,
        )
        assert (
            revoked.status_code,
            revoked.json()["error"]["code"],
            revoked.json()["error"]["message"],
        ) == (
            invalid.status_code,
            invalid.json()["error"]["code"],
            invalid.json()["error"]["message"],
        ), f"revoked bearer leaked a distinguishable authorization state: {revoked.text}"
    finally:
        storage.delete_object(first_path)
        storage.delete_object(second_path)


def test_unattributable_pdf_provenance_is_never_publicly_projectable(engine: Engine) -> None:
    """Only the ``resolved`` disposition reaches a public audience.

    A highlight whose geometry belongs to a superseded binary is readable and
    reattachable to its owner, but painting it for an anonymous reader would put
    old geometry over different bytes. Public projection therefore selects the
    disposition explicitly instead of inferring it from an absent target.
    """
    with published_pdf_sources(engine) as fixture:
        with fixture.factory() as db:
            superseded, current = fixture.highlights[0], fixture.highlights[1]
            assert (
                resolve_highlight_reader_target_disposition(db, highlight_id=superseded).status
                == "source_unverified"
            ), "fixture no longer produces an unattributable PDF highlight"
            assert not highlight_target_available(db, highlight_id=superseded), (
                "unattributable PDF provenance became publicly projectable"
            )
            assert highlight_target_available(db, highlight_id=current), (
                "public projection refused a highlight the published binary still owns"
            )


def test_public_file_keeps_transfer_capacity_until_its_cancelled_sdk_read_finishes(
    db_session: Session,
    test_user: UserRecord,
    nexus_app: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id,
            plan_tier="plus",
            reason="public file transfer admission proof",
        )
    )
    payload = b"%PDF-1.4 exact public transfer subject"
    subject, storage_path = _seed_pdf(
        db_session,
        owner_id=test_user.id,
        title="Held public transfer",
        payload=payload,
    )
    storage = get_storage_client()
    try:
        grant = create_grant(
            db_session,
            viewer_user_id=test_user.id,
            subject=subject,
            audience=LinkGrantAudience(),
        ).grant
        assert grant.share_token is not None
        headers = {"X-Nexus-Share-Token": str(grant.share_token)}
        nexus_app.state.package_transfer_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=30, retry_after_seconds=1, request_bytes=262144
        )

        async def scenario() -> None:
            loop = asyncio.get_running_loop()
            entered = asyncio.Event()
            read_finished = asyncio.Event()
            release = Event()
            held_body: StreamingBody | None = None
            closed: list[StreamingBody] = []
            original_read = StreamingBody.read
            original_close = StreamingBody.close

            def held_read(body: StreamingBody, amt: int | None = None) -> bytes:
                nonlocal held_body
                if held_body is not None:
                    return original_read(body, amt)
                held_body = body
                loop.call_soon_threadsafe(entered.set)
                try:
                    assert release.wait(timeout=5), "the proof did not release the SDK read"
                    return original_read(body, amt)
                finally:
                    loop.call_soon_threadsafe(read_finished.set)

            def observed_close(body: StreamingBody) -> None:
                closed.append(body)
                original_close(body)

            async def production_protocol(scope: Scope, receive: Receive, send: Send) -> None:
                # The installed Uvicorn uses this Starlette task-group branch.
                scope = {**scope, "asgi": {"version": "3.0", "spec_version": "2.3"}}
                await nexus_app(scope, receive, send)

            with monkeypatch.context() as sdk:
                # Only the external SDK body is controlled; storage, service,
                # response, admission, grant lookup and Minio remain real.
                sdk.setattr(StreamingBody, "read", held_read)
                sdk.setattr(StreamingBody, "close", observed_close)
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=production_protocol), base_url="http://test"
                ) as client:
                    opening = asyncio.create_task(
                        client.get("/public/resource-share/file", headers=headers)
                    )
                    retired = None
                    read_finished_while_held = None
                    close_count_while_held = None
                    busy = None
                    bootstrap = None
                    observation_error = None
                    cleanup_error = None
                    request_error = None
                    try:
                        await asyncio.wait_for(entered.wait(), timeout=5)
                        assert held_body is not None
                        opening.cancel()
                        busy = await client.get("/public/resource-share/file", headers=headers)
                        bootstrap = await client.get("/public/resource-share", headers=headers)
                        retired = opening.done()
                        read_finished_while_held = read_finished.is_set()
                        close_count_while_held = closed.count(held_body)
                    except Exception as error:
                        observation_error = error
                    finally:
                        release.set()
                        try:
                            await asyncio.wait_for(read_finished.wait(), timeout=5)
                        except Exception as error:
                            cleanup_error = error
                        try:
                            await asyncio.wait_for(opening, timeout=5)
                        except (Exception, asyncio.CancelledError) as error:
                            request_error = error
                    if observation_error is not None:
                        raise observation_error
                    assert retired is False, "public cancellation retired a live SDK read"
                    assert read_finished_while_held is False
                    assert close_count_while_held == 0, "SDK close raced its live read"
                    assert busy is not None and busy.status_code == 503, (
                        "public file bypassed occupied transfer capacity"
                    )
                    assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
                    assert busy.headers["retry-after"] == "1"
                    for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                        assert busy.headers[name] == value
                    assert "set-cookie" not in busy.headers
                    assert bootstrap is not None and bootstrap.status_code == 200
                    assert bootstrap.json()["data"]["media"]["title"] == "Held public transfer"
                    assert cleanup_error is None, cleanup_error
                    assert isinstance(request_error, asyncio.CancelledError), request_error
                    assert held_body is not None and closed.count(held_body) == 1, (
                        "cancelled public file did not close its exact SDK body once"
                    )
                    complete = await client.get("/public/resource-share/file", headers=headers)
                    assert complete.status_code == 200 and complete.content == payload
                    assert complete.headers["content-length"] == str(len(payload))
                    partial = await client.get(
                        "/public/resource-share/file", headers={**headers, "Range": "bytes=5-12"}
                    )
                    assert partial.status_code == 206 and partial.content == payload[5:13]
                    assert partial.headers["content-range"] == f"bytes 5-12/{len(payload)}"
                    for response in (complete, partial):
                        for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                            assert response.headers[name] == value
                        assert "set-cookie" not in response.headers

        asyncio.run(scenario())
    finally:
        storage.delete_object(storage_path)


def _seed_public_epub_asset(
    db: Session, *, owner_id: UUID, title: str, payload: bytes
) -> tuple[ResourceRef, str]:
    media_id = uuid4()
    storage_path = f"epub/{media_id}/private-image.png"
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.epub.value,
            title=title,
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
    )
    db.flush()
    db.add_all(
        [
            MediaSourceAttempt(
                id=uuid4(),
                media_id=media_id,
                created_by_user_id=owner_id,
                source_type="uploaded_epub_file",
                attempt_no=1,
                status="succeeded",
                intent_key=f"public-asset-proof:{media_id}",
            ),
            Fragment(
                id=uuid4(),
                media_id=media_id,
                idx=0,
                canonical_text="Shared image",
                html_sanitized=(
                    "<p>Shared image</p>"
                    f'<img src="/api/media/{media_id}/assets/figures/image.png" alt="Source image">'
                ),
            ),
            EpubNavLocation(
                media_id=media_id,
                location_id="chapter",
                ordinal=0,
                label="Shared chapter",
                fragment_idx=0,
                href_path="chapter.xhtml",
                start_offset=0,
                end_offset=12,
                source="spine",
            ),
            EpubResource(
                id=uuid4(),
                media_id=media_id,
                manifest_item_id="image",
                package_href="figures/image.png",
                asset_key="figures/image.png",
                storage_path=storage_path,
                content_type="image/png",
                size_bytes=len(payload),
            ),
        ]
    )
    db.flush()
    ensure_media_in_default_library(db, owner_id, media_id)
    get_storage_client().put_object(storage_path, payload, "image/png")
    return ResourceRef("media", media_id), storage_path


def _public_asset_path(client: TestClient, headers: dict[str, str]) -> str:
    navigation = client.get("/public/resource-share/navigation", headers=headers)
    assert navigation.status_code == 200, navigation.text
    section_handle = navigation.json()["data"]["items"][0]["section_handle"]
    section = client.get(f"/public/resource-share/sections/{section_handle}", headers=headers)
    assert section.status_code == 200, section.text
    document = fragment_fromstring(section.json()["data"]["html_sanitized"], create_parent="div")
    images = document.xpath(".//img")
    assert len(images) == 1
    asset_handle = images[0].get("data-nexus-public-asset-handle")
    assert isinstance(asset_handle, str)
    return f"/public/resource-share/assets/{asset_handle}"


async def _public_sdk_lifetime(
    app: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    *,
    path: str,
    headers: dict[str, str],
    storage_path: str,
    bootstrap_title: str,
    termination: str,
) -> httpx.Response:
    """Hold the actual peer's later read and close; retain observed ownership."""
    loop = asyncio.get_running_loop()
    read_entered, read_finished = asyncio.Event(), asyncio.Event()
    close_entered, close_finished = asyncio.Event(), asyncio.Event()
    disconnect, disconnect_delivered = asyncio.Event(), asyncio.Event()
    release_read, release_close = Event(), Event()
    held_body: StreamingBody | None = None
    read_calls = 0
    closes: list[StreamingBody] = []
    close_raced_read: list[bool] = []
    requests: list[dict] = []
    sent: list[Message] = []
    original_read, original_close = StreamingBody.read, StreamingBody.close
    original_call = BaseClient._make_api_call

    def observed_call(client, operation_name, api_params):
        if operation_name == "GetObject":
            requests.append(dict(api_params))
        return original_call(client, operation_name, api_params)

    def held_read(body: StreamingBody, amt: int | None = None) -> bytes:
        nonlocal held_body, read_calls
        if held_body is None:
            held_body = body
        if body is not held_body:
            return original_read(body, amt)
        read_calls += 1
        if read_calls != 3:
            return original_read(body, amt)
        loop.call_soon_threadsafe(read_entered.set)
        try:
            assert release_read.wait(timeout=5), "the proof did not release its SDK read"
            return original_read(body, amt)
        finally:
            loop.call_soon_threadsafe(read_finished.set)

    def held_close(body: StreamingBody) -> None:
        closes.append(body)
        if body is not held_body:
            original_close(body)
            return
        close_raced_read.append(not read_finished.is_set())
        loop.call_soon_threadsafe(close_entered.set)
        try:
            assert release_close.wait(timeout=5), "the proof did not release its SDK close"
            original_close(body)
        finally:
            loop.call_soon_threadsafe(close_finished.set)

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
    with monkeypatch.context() as sdk:
        sdk.setattr(BaseClient, "_make_api_call", observed_call)
        sdk.setattr(StreamingBody, "read", held_read)
        sdk.setattr(StreamingBody, "close", held_close)
        opening = asyncio.create_task(app(scope, receive, send))
        observations = []
        observation_error = request_error = cleanup_error = None
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            try:
                await asyncio.wait_for(read_entered.wait(), timeout=5)
                if termination == "deadline":
                    await asyncio.wait({opening}, timeout=1.1)
                else:
                    disconnect.set()
                    await asyncio.wait_for(disconnect_delivered.wait(), timeout=5)
                busy = await client.get(path, headers=headers)
                bootstrap = await client.get("/public/resource-share", headers=headers)
                observations.append(
                    (
                        opening.done(),
                        read_finished.is_set(),
                        close_finished.is_set(),
                        busy,
                        bootstrap,
                    )
                )
                release_read.set()
                await asyncio.wait_for(close_entered.wait(), timeout=5)
                busy = await client.get(path, headers=headers)
                bootstrap = await client.get("/public/resource-share", headers=headers)
                observations.append(
                    (
                        opening.done(),
                        read_finished.is_set(),
                        close_finished.is_set(),
                        busy,
                        bootstrap,
                    )
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
            for index, (retired, read_done, closed, busy, bootstrap) in enumerate(observations):
                assert not retired, "public request retired its live SDK read or close"
                assert read_done is (index == 1)
                assert not closed
                assert busy.status_code == 503, "public transfer released its live SDK permit"
                assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
                assert busy.headers["retry-after"] == "1"
                for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                    assert busy.headers[name] == value
                assert "set-cookie" not in busy.headers
                assert bootstrap.status_code == 200
                assert bootstrap.json()["data"]["media"]["title"] == bootstrap_title
            if observation_error is not None:
                raise observation_error
            assert len(observations) == 2
            assert cleanup_error is None, cleanup_error
            assert close_raced_read == [False], "public SDK close raced its executing read"
            assert held_body is not None and closes.count(held_body) == 1
            assert close_finished.is_set()
            assert len(requests) == 1 and requests[0]["Key"] == storage_path
            assert any(
                message["type"] == "http.response.body" and message["body"] for message in sent
            )
            assert not any(
                message["type"] == "http.response.body" and not message["more_body"]
                for message in sent
            ), "cancelled public stream completed its representation"
            if termination == "deadline":
                assert isinstance(request_error, RuntimeError), request_error
                assert str(request_error) == "admitted read exceeded its qualified permit deadline"
            else:
                assert request_error is None, request_error
            complete = await client.get(path, headers=headers)
            assert len(requests) == 2 and requests[1]["Key"] == storage_path
            assert len(closes) == 2 and closes[1] is not held_body
            for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                assert complete.headers[name] == value
            assert "set-cookie" not in complete.headers
            return complete


@pytest.mark.parametrize("termination", ["deadline", "disconnect"])
@pytest.mark.parametrize("range_request", [False, True])
def test_public_file_retains_transfer_capacity_through_sdk_read_and_close(
    db_session: Session,
    test_user: UserRecord,
    nexus_app: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    termination: str,
    range_request: bool,
) -> None:
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id, plan_tier="plus", reason="public file physical close proof"
        )
    )
    payload = b"%PDF-1.4\n" + b"a" * 65536 + b"b" * 65536 + b"c" * 65536 + b"d" * 65536
    subject, storage_path = _seed_pdf(
        db_session, owner_id=test_user.id, title="Public file close", payload=payload
    )
    storage = get_storage_client()
    try:
        grant = create_grant(
            db_session, viewer_user_id=test_user.id, subject=subject, audience=LinkGrantAudience()
        ).grant
        assert grant.share_token is not None
        headers = {"X-Nexus-Share-Token": str(grant.share_token)}
        if range_request:
            headers["Range"] = f"bytes=5-{len(payload) - 2}"
        nexus_app.state.package_transfer_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=262144
        )
        response = asyncio.run(
            _public_sdk_lifetime(
                nexus_app,
                monkeypatch,
                path="/public/resource-share/file",
                headers=headers,
                storage_path=storage_path,
                bootstrap_title="Public file close",
                termination=termination,
            )
        )
        expected = payload[5:-1] if range_request else payload
        assert response.status_code == (206 if range_request else 200)
        assert response.content == expected and response.headers["content-length"] == str(
            len(expected)
        )
        assert response.headers["content-type"] == "application/pdf"
        assert response.headers["accept-ranges"] == "bytes"
        if range_request:
            assert response.headers["content-range"] == f"bytes 5-{len(payload) - 2}/{len(payload)}"
        else:
            assert "content-range" not in response.headers
    finally:
        storage.delete_object(storage_path)


@pytest.mark.parametrize("termination", ["deadline", "disconnect"])
def test_public_asset_retains_image_capacity_through_sdk_read_and_close(
    db_session: Session,
    test_user: UserRecord,
    nexus_app: FastAPI,
    anonymous_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    termination: str,
) -> None:
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id, plan_tier="plus", reason="public asset physical close proof"
        )
    )
    payload = b"\x89PNG\r\n\x1a\n" + b"a" * 65536 + b"b" * 65536 + b"c" * 65536 + b"d" * 65536
    subject, storage_path = _seed_public_epub_asset(
        db_session, owner_id=test_user.id, title="Public image close", payload=payload
    )
    storage = get_storage_client()
    try:
        grant = create_grant(
            db_session, viewer_user_id=test_user.id, subject=subject, audience=LinkGrantAudience()
        ).grant
        assert grant.share_token is not None
        headers = {"X-Nexus-Share-Token": str(grant.share_token)}
        path = _public_asset_path(anonymous_client, headers)
        nexus_app.state.image_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=1, retry_after_seconds=1, request_bytes=262144
        )
        response = asyncio.run(
            _public_sdk_lifetime(
                nexus_app,
                monkeypatch,
                path=path,
                headers=headers,
                storage_path=storage_path,
                bootstrap_title="Public image close",
                termination=termination,
            )
        )
        assert response.status_code == 200 and response.content == payload
        assert response.headers["content-length"] == str(len(payload))
        assert response.headers["content-type"] == "image/png"
        assert "content-range" not in response.headers
    finally:
        storage.delete_object(storage_path)


def test_public_asset_stream_preserves_bytes_and_masks_private_sources(
    db_session: Session,
    test_user: UserRecord,
    nexus_app: FastAPI,
    anonymous_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_session.add(
        BillingEntitlementOverride(
            user_id=test_user.id, plan_tier="plus", reason="public asset source privacy proof"
        )
    )
    payload = b"\x89PNG\r\n\x1a\n" + b"a" * 65536 + b"b" * 65536 + b"c" * 65536 + b"d" * 65536
    first, first_path = _seed_public_epub_asset(
        db_session, owner_id=test_user.id, title="First public image", payload=payload
    )
    second, second_path = _seed_public_epub_asset(
        db_session, owner_id=test_user.id, title="Second public image", payload=b"other image"
    )
    storage = get_storage_client()
    try:
        first_grant = create_grant(
            db_session, viewer_user_id=test_user.id, subject=first, audience=LinkGrantAudience()
        ).grant
        second_grant = create_grant(
            db_session, viewer_user_id=test_user.id, subject=second, audience=LinkGrantAudience()
        ).grant
        assert first_grant.share_token is not None and second_grant.share_token is not None
        headers = {"X-Nexus-Share-Token": str(first_grant.share_token)}
        other_headers = {"X-Nexus-Share-Token": str(second_grant.share_token)}
        path = _public_asset_path(anonymous_client, headers)
        other_path = _public_asset_path(anonymous_client, other_headers)
        requests: list[dict] = []
        reads: list[int | None] = []
        closes: list[StreamingBody] = []
        bytes_read = 0
        body_observations: list[tuple[int, int]] = []
        response_starts: list[int] = []
        body_completions: list[bool] = []
        transferred = hashlib.sha256()
        original_call = BaseClient._make_api_call
        original_read, original_close = StreamingBody.read, StreamingBody.close

        def observed_call(client, operation_name, api_params):
            if operation_name == "GetObject":
                requests.append(dict(api_params))
            return original_call(client, operation_name, api_params)

        def observed_read(body: StreamingBody, amt: int | None = None) -> bytes:
            nonlocal bytes_read
            chunk = original_read(body, amt)
            bytes_read += len(chunk)
            reads.append(amt)
            return chunk

        def observed_close(body: StreamingBody) -> None:
            closes.append(body)
            original_close(body)

        async def protocol(scope: Scope, receive: Receive, send: Send) -> None:
            async def observe(message: Message) -> None:
                if message["type"] == "http.response.start":
                    response_starts.append(message["status"])
                elif message["type"] == "http.response.body":
                    if message["body"]:
                        body_observations.append((len(message["body"]), bytes_read))
                        transferred.update(message["body"])
                    if not message["more_body"]:
                        body_completions.append(True)
                await send(message)

            await nexus_app(
                {**scope, "asgi": {"version": "3.0", "spec_version": "2.3"}}, receive, observe
            )

        async def complete_read() -> httpx.Response:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=protocol), base_url="http://test"
            ) as client:
                return await client.get(path, headers=headers)

        with monkeypatch.context() as sdk:
            sdk.setattr(BaseClient, "_make_api_call", observed_call)
            sdk.setattr(StreamingBody, "read", observed_read)
            sdk.setattr(StreamingBody, "close", observed_close)
            for request_path, request_headers in (
                (path, {}),
                (path, {"X-Nexus-Share-Token": "not-a-share-token"}),
                (path, other_headers),
                (other_path, headers),
                ("/public/resource-share/assets/not-an-asset-handle", headers),
            ):
                hidden = anonymous_client.get(request_path, headers=request_headers)
                assert hidden.status_code == 404
                assert hidden.json()["error"]["code"] == "E_NOT_FOUND"
                assert hidden.json()["error"]["message"] == "Share unavailable"
                assert first_path not in hidden.text and str(first.id) not in hidden.text
                for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                    assert hidden.headers[name] == value
                assert "set-cookie" not in hidden.headers
            assert requests == [], "private public-asset handles opened storage before admission"

            complete = asyncio.run(complete_read())
            assert complete.status_code == 200 and complete.content == payload
            assert complete.headers["content-type"] == "image/png"
            assert complete.headers["content-length"] == str(len(payload))
            for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                assert complete.headers[name] == value
            assert "set-cookie" not in complete.headers
            assert body_observations and body_observations[0][1] < len(payload), (
                "public asset was fully materialized before its first body transfer"
            )
            assert body_observations[0][1] == 2 * 65536
            assert all(size <= 65536 for size, _ in body_observations)
            assert reads and all(size == 65536 for size in reads)
            assert len(requests) == 1 and requests[0]["Key"] == first_path
            assert len(closes) == 1

            resource = db_session.scalar(
                select(EpubResource).where(EpubResource.media_id == first.id)
            )
            assert resource is not None
            resource.content_type = "image/svg+xml"
            db_session.flush()
            unsupported_type = anonymous_client.get(path, headers=headers)
            assert unsupported_type.status_code == 404
            assert unsupported_type.json()["error"]["code"] == "E_NOT_FOUND"
            assert len(requests) == 1, "unsupported public asset opened an object"
            resource.content_type = "image/png"
            resource.size_bytes = 25 * 1024 * 1024 + 1
            db_session.flush()
            unsupported_size = anonymous_client.get(path, headers=headers)
            assert unsupported_size.status_code == 404
            assert unsupported_size.json()["error"]["code"] == "E_NOT_FOUND"
            assert len(requests) == 1, "oversize public asset opened an object"
            resource.size_bytes = len(payload)
            db_session.flush()

            # Keep the persisted metadata and sealed handle unchanged while the
            # actual external object disappears or has a short initial body.
            for failure in ("missing", "short"):
                if failure == "missing":
                    storage.delete_object(first_path)
                else:
                    storage.put_object(first_path, b"short", "image/png")
                before_closes = len(closes)
                hidden = anonymous_client.get(path, headers=headers)
                assert hidden.status_code == 404
                assert hidden.json()["error"]["code"] == "E_NOT_FOUND"
                assert hidden.json()["error"]["message"] == "Share unavailable"
                for name, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
                    assert hidden.headers[name] == value
                assert "set-cookie" not in hidden.headers
                assert first_path not in hidden.text and str(first.id) not in hidden.text
                assert len(closes) == before_closes + (failure == "short")

            # Actual excess bytes beyond the declared source are discovered
            # after earlier chunks were sent. No completed representation escapes.
            storage.put_object(first_path, payload + b"excess", "image/png")
            body_observations.clear()
            response_starts.clear()
            body_completions.clear()
            bytes_read = 0
            transferred = hashlib.sha256()
            before_closes = len(closes)
            late_error = None
            try:
                asyncio.run(complete_read())
            except Exception as error:
                late_error = error
            assert isinstance(late_error, RuntimeError), late_error
            assert str(late_error) == "Caught handled exception, but response already started."
            masked_error = late_error.__cause__
            assert isinstance(masked_error, NotFoundError), masked_error
            assert masked_error.code == ApiErrorCode.E_NOT_FOUND
            assert masked_error.message == "Share unavailable"
            # Starlette's ASGI 2.3 task-group collapse preserves the original
            # caught storage error as the explicit cause of its sole exception.
            storage_error = masked_error.__cause__
            assert isinstance(storage_error, StorageError), storage_error
            assert storage_error.code == "E_STORAGE_ERROR"
            assert str(storage_error) == "Stored object is larger than persisted metadata"
            assert response_starts == [200]
            sent_bytes = sum(size for size, _ in body_observations)
            assert 0 < sent_bytes < len(payload), "public asset released its corrupt declared tail"
            assert body_completions == [], "corrupt public asset completed its representation"
            assert transferred.hexdigest() == hashlib.sha256(payload[:sent_bytes]).hexdigest()
            assert len(closes) == before_closes + 1

            storage.put_object(first_path, payload, "image/png")
            delete_grant(db_session, viewer_user_id=test_user.id, handle=first_grant.handle)
            before_requests = len(requests)
            revoked = anonymous_client.get(path, headers=headers)
            assert revoked.status_code == 404 and revoked.json()["error"]["code"] == "E_NOT_FOUND"
            assert revoked.json()["error"]["message"] == "Share unavailable"
            assert len(requests) == before_requests
            other = anonymous_client.get(other_path, headers=other_headers)
            assert other.status_code == 200 and other.content == b"other image"
            assert requests[-1]["Key"] == second_path
    finally:
        storage.delete_object(first_path)
        storage.delete_object(second_path)
