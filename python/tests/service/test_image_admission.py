"""Image validation and body transfer own both image and shared read permits."""

import asyncio
import io
import os
import signal
import socket
import subprocess
from threading import Event

import httpx
import pytest
from fastapi import APIRouter
from PIL import Image
from sqlalchemy.orm import Session
from starlette.types import Message, Receive, Scope, Send

from nexus.api.read_admission import AdmittedReadRoute, ReadAdmission
from tests.testkit.auth import UserRecord
from tests.testkit.read_admission import production_read_app


def test_image_admission_releases_partial_acquisition_and_retains_both_permits(
    db_session: Session, test_user: UserRecord, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = io.BytesIO()
    with Image.new("RGB", (2, 2), "blue") as image:
        image.save(output, format="PNG")
    encoded = output.getvalue()
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.215.14", 443))],
    )
    monkeypatch.setattr(
        httpx.HTTPTransport,
        "handle_request",
        lambda self, request: httpx.Response(
            200, headers={"Content-Type": "image/png"}, stream=httpx.ByteStream(encoded)
        ),
    )
    original_popen = subprocess.Popen

    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        json_entered = asyncio.Queue()
        validation_entered = asyncio.Event()
        body_entered = asyncio.Event()
        json_release = Event()
        validation_release = Event()
        body_release = asyncio.Event()
        hold_validation = False
        app, headers = production_read_app(db_session, test_user)
        app.state.read_admission = ReadAdmission(
            max_concurrency=2, deadline_seconds=30, retry_after_seconds=1, request_bytes=262144
        )
        app.state.image_admission = ReadAdmission(
            max_concurrency=1, deadline_seconds=30, retry_after_seconds=1, request_bytes=262144
        )
        router = APIRouter(route_class=AdmittedReadRoute)

        @router.get("/read")
        def read() -> dict:
            loop.call_soon_threadsafe(json_entered.put_nowait, None)
            assert json_release.wait(timeout=5)
            return {"read": True}

        app.include_router(router)

        def observed_popen(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            if hold_validation and not validation_entered.is_set():
                os.kill(process.pid, signal.SIGSTOP)
                try:
                    loop.call_soon_threadsafe(validation_entered.set)
                    assert validation_release.wait(timeout=5)
                finally:
                    os.kill(process.pid, signal.SIGCONT)
            return process

        # Pause the actual owned decoder process; parser, protocol, admission
        # and request lifetime remain real, including repeated cancellation.
        monkeypatch.setattr(subprocess, "Popen", observed_popen)

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            async def blocked_send(message: Message) -> None:
                if (
                    message["type"] == "http.response.body"
                    and message.get("body") == encoded
                    and scope["query_string"].endswith(b"request=held")
                ):
                    body_entered.set()
                    await body_release.wait()
                await send(message)

            await app(scope, receive, blocked_send)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test", headers=headers
        ) as client:
            image_path = "/media/image?url=https://images.example/cover.png"
            readers = [asyncio.create_task(client.get("/read")) for _ in range(2)]
            try:
                for _ in readers:
                    await asyncio.wait_for(json_entered.get(), timeout=5)
                rejected = await client.get(image_path)
                assert rejected.status_code == 503, "image escaped shared foreground capacity"
            finally:
                json_release.set()
                await asyncio.gather(*readers)
            json_release.clear()
            hold_validation = True
            opening = asyncio.create_task(client.get(image_path + "&request=held"))
            reader = None
            try:
                await asyncio.wait_for(validation_entered.wait(), timeout=5)
                assert (await client.get(image_path)).status_code == 503, (
                    "two image validations escaped their image-only permit"
                )
                reader = asyncio.create_task(client.get("/read"))
                await asyncio.wait_for(json_entered.get(), timeout=5)
                for _ in range(2):
                    opening.cancel()
                    assert (await client.get("/read")).status_code == 503, (
                        "cancelled image validation released shared foreground capacity"
                    )
                    assert (await client.get(image_path)).status_code == 503
                    assert not opening.done(), "cancelled validation unwound its owning request"
                validation_release.set()
                await asyncio.wait_for(body_entered.wait(), timeout=5)
                assert (await client.get("/read")).status_code == 503
                assert (await client.get(image_path)).status_code == 503
            finally:
                validation_release.set()
                body_release.set()
                json_release.set()
                if reader is not None:
                    await reader
                with pytest.raises(asyncio.CancelledError):
                    await opening
            assert (await client.get(image_path)).status_code == 200, (
                "failed nested acquisition or completed image leaked a permit"
            )
            assert (await client.get("/read")).status_code == 200

    asyncio.run(scenario())
