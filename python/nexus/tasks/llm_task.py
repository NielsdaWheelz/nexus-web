"""The one synchronous worker envelope for route-neutral generation jobs."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.queue import RescheduleRequested
from nexus.logging import get_logger

if TYPE_CHECKING:
    from nexus.services.llm_execution import ExecutionRuntime

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class LlmTaskSpec:
    """Identity of one worker-owned generation envelope."""

    label: str


def run_llm_task[R](
    spec: LlmTaskSpec,
    handler: Callable[[Session, ExecutionRuntime], Awaitable[R]],
) -> R | RescheduleRequested:
    """Run one async generation task with one session and one owned event loop."""

    from nexus.services.llm_execution import GenerationCapacityPaused

    db = get_session_factory()()

    async def _call() -> R:
        import httpx

        from nexus.services.generation_catalog import build_generation_catalog_service
        from nexus.services.generation_runtime import compose_generation_execution_runtime
        from nexus.services.tool_runtime.catalog import (
            compose_configured_web_search_provider,
            compose_tool_runtime,
        )

        settings = get_settings()
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            trust_env=False,
        ) as http_client:
            tools = compose_tool_runtime(
                compose_configured_web_search_provider(http_client, settings=settings)
            )
            runtime = compose_generation_execution_runtime(
                settings,
                http_client=http_client,
                catalog=build_generation_catalog_service(settings),
                tools=tools,
            )
            return await handler(db, runtime)

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_call())
    # justify-ignore-error: unexpected defects remain owned by the durable
    # queue retry and dead-letter policy after this boundary records them.
    except GenerationCapacityPaused as error:
        db.rollback()
        return RescheduleRequested(schedule=error.schedule)
    except Exception:
        logger.exception(f"{spec.label}_failed_unexpected")
        raise
    finally:
        loop.close()
        db.close()


__all__ = ["LlmTaskSpec", "run_llm_task"]
