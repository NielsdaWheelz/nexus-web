"""Compose healthcheck: healthy iff the product could list codex models through its configured endpoint now.

`fetch_codex_catalog` is the product's own read; it checks the pinned version, the startup
catalog flag and the contract revision, so the line printed on success is observed, not assumed.
Docker's healthcheck timeout bounds it.
"""

from __future__ import annotations

import asyncio
import os

from provider_runtime.agent_runtime import CODEX_CONTAINMENT_VERSION
from pydantic import SecretStr

from nexus.config import parse_codex_endpoint
from nexus.services.generation.catalog import fetch_codex_catalog


def main() -> None:
    token = os.environ.get("NEXUS_CODEX_TRANSPORT_TOKEN")
    endpoint = parse_codex_endpoint(
        os.environ["NEXUS_CODEX_ENDPOINT"], None if token is None else SecretStr(token)
    )
    catalog = asyncio.run(fetch_codex_catalog(endpoint))
    print(
        f"codex {CODEX_CONTAINMENT_VERSION} ready: {len(catalog.models)} models,"
        f" contract {catalog.backend_contract_revision}"
    )


if __name__ == "__main__":
    main()
