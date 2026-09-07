"""Fail-closed health command for the private Codex agent host."""

from __future__ import annotations

import asyncio

from apps.codex_agent.path_environment import required_absolute_path

from nexus.services.codex_generation_client import CodexGenerationClient
from nexus.services.codex_generation_contract import GenerationHealth

_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"


async def check() -> GenerationHealth:
    return await CodexGenerationClient(required_absolute_path(_SOCKET_ENV)).health()


def main() -> None:
    print(asyncio.run(check()).model_dump_json())


if __name__ == "__main__":
    main()
