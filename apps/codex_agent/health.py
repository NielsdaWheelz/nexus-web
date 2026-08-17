"""Fail-closed health command for the private Codex agent host."""

from __future__ import annotations

import asyncio

from apps.codex_agent.path_environment import required_absolute_path

from nexus.services.native_agent_client import CodexAgentClient
from nexus.services.native_agent_contract import NativeAgentHealth

_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"


async def check() -> NativeAgentHealth:
    observed = await CodexAgentClient(required_absolute_path(_SOCKET_ENV)).health()
    if observed != NativeAgentHealth():
        raise RuntimeError("Codex agent health identity drifted")
    return observed


def main() -> None:
    print(asyncio.run(check()).model_dump_json())


if __name__ == "__main__":
    main()
