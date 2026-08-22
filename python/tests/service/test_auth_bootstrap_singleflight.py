"""Priority proof: authenticated cold bootstrap has one per-user in-flight owner."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
from typing import Annotated, Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from nexus.auth.middleware import AuthMiddleware, Viewer, get_viewer
from nexus.auth.verifier import TokenVerifier
from tests.testkit.auth import MultiUserTokenVerifier, StaticTokenVerifier


class _ConcurrentVerifierFake:
    def __init__(self, user_id: UUID, email: str, expected_requests: int) -> None:
        self._verifier = StaticTokenVerifier(user_id, email)
        self._expected_requests = expected_requests
        self._verified_requests = 0
        self._lock = Lock()
        self.all_requests_verified = Event()

    @property
    def token(self) -> str:
        return self._verifier.token

    def verify(self, token: str) -> dict[str, Any]:
        payload = self._verifier.verify(token)
        with self._lock:
            self._verified_requests += 1
            if self._verified_requests == self._expected_requests:
                self.all_requests_verified.set()
        return payload


def _bootstrap_probe_app(
    verifier: TokenVerifier,
    bootstrap: Callable[[UUID, str | None], UUID],
) -> FastAPI:
    app = FastAPI()

    @app.get("/bootstrap-probe")
    def bootstrap_probe(viewer: Annotated[Viewer, Depends(get_viewer)]) -> dict[str, str]:
        return {"default_library_id": str(viewer.default_library_id)}

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap,
    )
    return app


def test_auth_bootstrap_cache_fans_concurrent_cold_requests_into_one_bootstrap() -> None:
    request_count = 6
    user_id = uuid4()
    email = f"auth-cache-concurrent-{user_id}@example.invalid"
    default_library_id = uuid4()
    verifier = _ConcurrentVerifierFake(user_id, email, request_count)
    first_bootstrap_started = Event()
    release_bootstrap = Event()
    calls_lock = Lock()
    bootstrap_calls = 0

    def bootstrap(called_user_id: UUID, email: str | None = None) -> UUID:
        nonlocal bootstrap_calls
        assert called_user_id == user_id
        with calls_lock:
            bootstrap_calls += 1
            if bootstrap_calls == 1:
                first_bootstrap_started.set()
        assert release_bootstrap.wait(timeout=5), "concurrency proof did not release bootstrap"
        return default_library_id

    app = _bootstrap_probe_app(verifier, bootstrap)

    async def scenario() -> tuple[httpx.Response, ...]:
        transport = httpx.ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {verifier.token}"}
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers=headers,
        ) as client:
            requests = tuple(
                asyncio.create_task(client.get("/bootstrap-probe")) for _ in range(request_count)
            )
            try:
                assert await asyncio.to_thread(first_bootstrap_started.wait, 5), (
                    "cold bootstrap never started"
                )
                assert await asyncio.to_thread(verifier.all_requests_verified.wait, 5), (
                    "concurrent requests did not all reach authenticated bootstrap"
                )
                release_bootstrap.set()
                return tuple(await asyncio.gather(*requests))
            finally:
                release_bootstrap.set()
                for request in requests:
                    if not request.done():
                        request.cancel()

    responses = asyncio.run(scenario())

    assert bootstrap_calls == 1, "concurrent cold requests ran duplicate bootstrap operations"
    assert all(response.status_code == 200 for response in responses)
    assert {response.json()["default_library_id"] for response in responses} == {
        str(default_library_id)
    }


def test_auth_bootstrap_cache_keeps_concurrent_users_isolated() -> None:
    first_user_id = uuid4()
    second_user_id = uuid4()
    first_email = f"auth-cache-isolated-first-{first_user_id}@example.invalid"
    second_email = f"auth-cache-isolated-second-{second_user_id}@example.invalid"
    first_library_id = uuid4()
    second_library_id = uuid4()
    verifier = MultiUserTokenVerifier(
        ((first_user_id, first_email), (second_user_id, second_email))
    )
    library_by_user = {
        first_user_id: first_library_id,
        second_user_id: second_library_id,
    }
    rendezvous = Barrier(2, timeout=5)
    calls_lock = Lock()
    bootstrap_calls: dict[UUID, int] = {}

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        with calls_lock:
            bootstrap_calls[user_id] = bootstrap_calls.get(user_id, 0) + 1
        rendezvous.wait()
        return library_by_user[user_id]

    app = _bootstrap_probe_app(verifier, bootstrap)
    with TestClient(app) as client:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(
                client.get,
                "/bootstrap-probe",
                headers={
                    "Authorization": f"Bearer {verifier.token_for(first_user_id)}",
                },
            )
            second = executor.submit(
                client.get,
                "/bootstrap-probe",
                headers={
                    "Authorization": f"Bearer {verifier.token_for(second_user_id)}",
                },
            )
            first_response = first.result(timeout=10)
            second_response = second.result(timeout=10)

    assert first_response.status_code == second_response.status_code == 200
    assert first_response.json()["default_library_id"] == str(first_library_id)
    assert second_response.json()["default_library_id"] == str(second_library_id)
    assert bootstrap_calls == {first_user_id: 1, second_user_id: 1}


def test_auth_bootstrap_cache_discards_a_failure_before_retry() -> None:
    user_id = uuid4()
    email = f"auth-cache-failure-{user_id}@example.invalid"
    default_library_id = uuid4()
    verifier = StaticTokenVerifier(user_id, email)
    bootstrap_calls = 0

    def bootstrap(called_user_id: UUID, email: str | None = None) -> UUID:
        nonlocal bootstrap_calls
        assert called_user_id == user_id
        bootstrap_calls += 1
        if bootstrap_calls == 1:
            raise RuntimeError("owned bootstrap failure")
        return default_library_id

    app = _bootstrap_probe_app(verifier, bootstrap)
    with TestClient(
        app,
        headers={"Authorization": f"Bearer {verifier.token}"},
    ) as client:
        failed_response = client.get("/bootstrap-probe")
        retry_response = client.get("/bootstrap-probe")
        warm_response = client.get("/bootstrap-probe")

    assert failed_response.status_code == 500
    assert retry_response.status_code == warm_response.status_code == 200
    assert retry_response.json()["default_library_id"] == str(default_library_id)
    assert warm_response.json() == retry_response.json()
    assert bootstrap_calls == 2, "a failed shared task was cached or successful reuse was missed"


def test_auth_bootstrap_cache_shields_shared_work_from_a_cancelled_waiter() -> None:
    user_id = uuid4()
    email = f"auth-cache-cancel-{user_id}@example.invalid"
    default_library_id = uuid4()
    verifier = _ConcurrentVerifierFake(user_id, email, expected_requests=2)
    bootstrap_started = Event()
    release_bootstrap = Event()
    calls_lock = Lock()
    bootstrap_calls = 0

    def bootstrap(called_user_id: UUID, email: str | None = None) -> UUID:
        nonlocal bootstrap_calls
        assert called_user_id == user_id
        with calls_lock:
            bootstrap_calls += 1
        bootstrap_started.set()
        assert release_bootstrap.wait(timeout=5), "cancellation proof did not release bootstrap"
        return default_library_id

    app = _bootstrap_probe_app(verifier, bootstrap)

    async def scenario() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        headers = {"Authorization": f"Bearer {verifier.token}"}
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers=headers,
        ) as client:
            cancelled = asyncio.create_task(client.get("/bootstrap-probe"))
            survivor: asyncio.Task[httpx.Response] | None = None
            try:
                assert await asyncio.to_thread(bootstrap_started.wait, 5), (
                    "cold bootstrap never started"
                )
                survivor = asyncio.create_task(client.get("/bootstrap-probe"))
                assert await asyncio.to_thread(verifier.all_requests_verified.wait, 5), (
                    "surviving request did not reach authenticated bootstrap"
                )
                cancelled.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await cancelled
                release_bootstrap.set()
                return await asyncio.wait_for(survivor, timeout=5)
            finally:
                release_bootstrap.set()
                if not cancelled.done():
                    cancelled.cancel()
                if survivor is not None and not survivor.done():
                    survivor.cancel()

    response = asyncio.run(scenario())

    assert response.status_code == 200
    assert response.json()["default_library_id"] == str(default_library_id)
    assert bootstrap_calls == 1
