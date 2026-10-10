"""What one generation needs from its process, and the one envelope a job runs it in."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.generation.contract import RouteUnavailable
from nexus.services.generation.ledger import interrupt_job_generations

if TYPE_CHECKING:
    from provider_runtime import ProviderRuntime

    from nexus.jobs.queue import JobExecutionContext
    from nexus.services.generation.catalog import Catalog
    from nexus.services.tool_runtime.catalog import ComposedToolRuntime

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Runtime:
    session_factory: sessionmaker[Session]
    catalog: Catalog
    tools: ComposedToolRuntime
    providers: ProviderRuntime | None
    codex_socket: Path


def run_generation_job[R](
    label: str, context: JobExecutionContext, work: Callable[[Session, Runtime], Awaitable[R]]
) -> R:
    """Run one job attempt's async work on its own event loop with a fresh runtime.

    The attempt first closes its job's open rows: only an earlier, dead attempt
    can have left one. ``httpx`` clients and the provider runtime are bound to this
    loop, so each attempt composes its own; the Codex catalog is cached per process.
    """

    async def call() -> R:
        import httpx

        from nexus.services.generation.catalog import Catalog
        from nexus.services.generation.provider import build_provider_runtime
        from nexus.services.memory_client import load_memory_client_config
        from nexus.services.tool_runtime.catalog import (
            compose_configured_web_search_provider,
            compose_tool_runtime,
        )

        settings = get_settings()
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            trust_env=False,
        ) as client:
            tools = compose_tool_runtime(
                compose_configured_web_search_provider(client, settings=settings),
                embedding_available=bool(settings.openai_api_key),
                memory_config=load_memory_client_config(settings.memory_client_config_path),
            )
            runtime = Runtime(
                session_factory=get_session_factory(),
                catalog=Catalog(settings, tools),
                tools=tools,
                providers=build_provider_runtime(settings, client),
                codex_socket=settings.codex_native_socket,
            )
            return await work(db, runtime)

    db = get_session_factory()()
    loop = asyncio.new_event_loop()
    try:
        interrupt_job_generations(
            db, job_id=context.job_id, detail="a later attempt of its job started"
        )
        db.commit()
        return loop.run_until_complete(call())
    except RouteUnavailable as error:
        logger.warning(f"{label}_route_unavailable", detail=error.message)
        raise
    # justify-ignore-error: the queue's retry and dead-letter policy owns every
    # unexpected defect once this boundary has logged it.
    except Exception:
        logger.exception(f"{label}_failed_unexpected")
        raise
    finally:
        loop.close()
        db.close()
