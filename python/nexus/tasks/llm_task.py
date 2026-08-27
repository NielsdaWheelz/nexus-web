"""The one synchronous worker envelope for private Codex generation jobs."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.codex_generation_client import CodexGenerationClient
from nexus.services.llm_execution import ExecutionRuntime

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class LlmTaskSpec:
    """Identity of one worker-owned generation envelope."""

    label: str


def run_llm_task[R](
    spec: LlmTaskSpec,
    handler: Callable[[Session, ExecutionRuntime], Awaitable[R]],
) -> R:
    """Run one async Codex task with one session and one owned event loop."""

    db = get_session_factory()()

    async def _call() -> R:
        runtime = CodexGenerationClient(get_settings().codex_agent_socket)
        return await handler(db, runtime)

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_call())
    # justify-ignore-error: unexpected defects remain owned by the durable
    # queue retry and dead-letter policy after this boundary records them.
    except Exception:
        logger.exception(f"{spec.label}_failed_unexpected")
        raise
    finally:
        loop.close()
        db.close()


__all__ = ["LlmTaskSpec", "run_llm_task"]
