"""The one worker envelope for LLM-calling jobs.

``run_llm_task`` owns the mechanics every LLM task body used to hand-copy: one
DB session, one fresh event loop, one ``httpx.AsyncClient`` (per-kind timeout
and pool limits), one router construction including the real-media fixture swap
for every kind, the worker exception boundary, and teardown. The handler owns
everything domain-specific: payload semantics, the service call, finalization.
It receives the shared client so chat can build its web-search provider without
a second ``httpx.AsyncClient`` (this module is the only constructor of loops,
clients, and routers under ``nexus/tasks/``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast

import httpx
from llm_calling.router import LLMRouter
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.real_media_fixture_llm import RealMediaFixtureLLMRouter

logger = get_logger(__name__)


@dataclass(frozen=True)
class LlmTaskSpec:
    """Per-kind envelope policy for one LLM task."""

    label: str  # log-event prefix: "chat_run", "oracle_reading", ...
    http_timeout_s: float = 60.0  # LI uses 120.0
    http_limits: tuple[int, int] = (10, 5)  # (max_connections, max_keepalive); chat (100, 20)


def run_llm_task[R](
    spec: LlmTaskSpec,
    handler: Callable[[Session, LLMRouter, httpx.AsyncClient], Awaitable[R]],
    *,
    on_worker_exception: Callable[[Session, Exception], R] | None = None,
) -> R:
    """Run one LLM task body inside the shared worker envelope.

    On an unexpected exception the boundary logs ``{label}_failed_unexpected``
    and delegates to ``on_worker_exception`` (which stores a safe terminal
    failure and returns the task result); without one the exception propagates
    to the queue's retry policy.
    """
    settings = get_settings()
    db = get_session_factory()()

    async def _call() -> R:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(spec.http_timeout_s, connect=10.0),
            limits=httpx.Limits(
                max_connections=spec.http_limits[0],
                max_keepalive_connections=spec.http_limits[1],
            ),
        ) as client:
            if settings.real_media_provider_fixtures:
                # Fixture runs must never reach real providers, whatever the kind.
                # The fixture router mirrors LLMRouter's call surface (pinned by
                # test_real_media_fixture_llm.py); the cast keeps handlers typed
                # against the real router.
                router = cast(
                    LLMRouter,
                    RealMediaFixtureLLMRouter(
                        enable_openai=settings.enable_openai,
                        enable_anthropic=settings.enable_anthropic,
                        enable_gemini=settings.enable_gemini,
                        enable_deepseek=settings.enable_deepseek,
                    ),
                )
            else:
                router = LLMRouter(
                    client,
                    enable_openai=settings.enable_openai,
                    enable_anthropic=settings.enable_anthropic,
                    enable_gemini=settings.enable_gemini,
                    enable_deepseek=settings.enable_deepseek,
                )
            return await handler(db, router, client)

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_call())
    # justify-ignore-error: worker boundary — on_worker_exception stores a safe
    # terminal failure; without one the queue's retry policy applies.
    except Exception as exc:
        logger.exception(f"{spec.label}_failed_unexpected")
        if on_worker_exception is None:
            raise
        return on_worker_exception(db, exc)
    finally:
        loop.close()
        db.close()
