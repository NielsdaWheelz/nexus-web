"""Authenticate a readonly public catalog request through the stock socket."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from apps.codex_agent.path_environment import required_absolute_path

from nexus.services.generation.catalog import fetch_codex_catalog
from nexus.services.native_health_contract import expected_health_identity


async def check(socket_path: Path | None = None) -> dict[str, str]:
    path = (
        socket_path
        if socket_path is not None
        else required_absolute_path("NEXUS_CODEX_NATIVE_SOCKET")
    )
    async with asyncio.timeout(3):
        await fetch_codex_catalog(path)
    return expected_health_identity()


def main() -> None:
    print(json.dumps(asyncio.run(check()), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
