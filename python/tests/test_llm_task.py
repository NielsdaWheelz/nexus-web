"""run_llm_task: the one worker envelope (session, loop, client, router, boundary)."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from llm_calling.router import LLMRouter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.services.real_media_fixture_llm import RealMediaFixtureLLMRouter
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _clean_settings():
    clear_settings_cache()
    yield
    clear_settings_cache()


@pytest.fixture(autouse=True)
def _task_db(monkeypatch, db_session):
    monkeypatch.setattr(
        "nexus.tasks.llm_task.get_session_factory",
        lambda: task_session_factory(db_session),
    )


def test_run_llm_task_provides_session_router_client_and_closes_loop():
    seen: dict = {}

    async def handler(db: Session, router: LLMRouter, client: httpx.AsyncClient) -> dict:
        seen["loop"] = asyncio.get_running_loop()
        seen["router"] = router
        seen["client_timeout"] = client.timeout
        seen["one"] = db.execute(text("SELECT 1")).scalar_one()
        return {"status": "ok"}

    result = run_llm_task(LlmTaskSpec(label="llm_task_test", http_timeout_s=120.0), handler)

    assert result == {"status": "ok"}
    assert seen["one"] == 1, "handler must receive a working DB session"
    assert isinstance(seen["router"], LLMRouter)
    assert seen["client_timeout"] == httpx.Timeout(120.0, connect=10.0), (
        f"spec timeout must reach the client, got {seen['client_timeout']}"
    )
    assert seen["loop"].is_closed(), "the per-task event loop must be closed after the run"


def test_run_llm_task_swaps_in_fixture_router_for_every_kind(monkeypatch, tmp_path):
    monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "true")
    monkeypatch.setenv("REAL_MEDIA_FIXTURE_DIR", str(tmp_path))
    clear_settings_cache()

    async def handler(db: Session, router: LLMRouter, client: httpx.AsyncClient) -> str:
        return type(router).__name__

    result = run_llm_task(LlmTaskSpec(label="llm_task_test"), handler)

    assert result == RealMediaFixtureLLMRouter.__name__, (
        "fixture mode must never hand a real provider router to any task kind"
    )


def test_run_llm_task_routes_exception_to_on_worker_exception():
    boom = RuntimeError("boom")
    seen: dict = {}

    async def handler(db: Session, router: LLMRouter, client: httpx.AsyncClient) -> dict:
        raise boom

    def on_worker_exception(db: Session, exc: Exception) -> dict:
        db.rollback()
        seen["exc"] = exc
        seen["one"] = db.execute(text("SELECT 1")).scalar_one()
        return {"status": "failed"}

    result = run_llm_task(
        LlmTaskSpec(label="llm_task_test"), handler, on_worker_exception=on_worker_exception
    )

    assert result == {"status": "failed"}
    assert seen["exc"] is boom, "the boundary must receive the original exception"
    assert seen["one"] == 1, "the boundary must get a session it can keep using"


def test_run_llm_task_reraises_without_on_worker_exception():
    async def handler(db: Session, router: LLMRouter, client: httpx.AsyncClient) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        run_llm_task(LlmTaskSpec(label="llm_task_test"), handler)
