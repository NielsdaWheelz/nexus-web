"""Compose healthcheck: healthy iff the product could list codex models through the socket now.

`fetch_codex_catalog` is the product's own read; it checks the pinned version, the startup
catalog flag and the contract revision, so the line printed on success is observed, not assumed.
Docker's healthcheck timeout bounds it.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from provider_runtime.agent_runtime import CODEX_CONTAINMENT_VERSION

from nexus.services.generation.catalog import fetch_codex_catalog


def main() -> None:
    socket = Path(os.environ["NEXUS_CODEX_NATIVE_SOCKET"])
    catalog = asyncio.run(fetch_codex_catalog(socket))
    print(
        f"codex {CODEX_CONTAINMENT_VERSION} ready: {len(catalog.models)} models,"
        f" contract {catalog.backend_contract_revision}"
    )


if __name__ == "__main__":
    main()
