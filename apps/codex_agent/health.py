"""Fail-closed health command for the private Codex agent host."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import httpx

from nexus.services.native_agent_contract import NativeAgentHealth


async def check() -> None:
    raw = os.environ.get("NEXUS_CODEX_AGENT_SOCKET")
    if raw is None:
        raise RuntimeError("NEXUS_CODEX_AGENT_SOCKET is required")
    socket_path = Path(raw)
    if not socket_path.is_absolute() or os.path.normpath(raw) != raw:
        raise RuntimeError(
            "NEXUS_CODEX_AGENT_SOCKET must be a normalized absolute path"
        )
    transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
    async with httpx.AsyncClient(transport=transport, timeout=5.0) as client:
        response = await client.get("http://nexus-codex/health")
    response.raise_for_status()
    observed = NativeAgentHealth.model_validate_json(response.content)
    if observed != NativeAgentHealth():
        raise RuntimeError("Codex agent health identity drifted")


def main() -> None:
    asyncio.run(check())


if __name__ == "__main__":
    main()
