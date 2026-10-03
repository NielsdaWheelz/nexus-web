"""Readonly public AgentRuntime catalog access to the host-owned stock socket."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from provider_runtime.agent_runtime import (
    AgentRuntime,
    AgentRuntimeConfig,
    AgentRuntimeDefect,
    AgentRuntimeError,
    CredentialRef,
    qualify_codex_containment_host,
)

from nexus.services.native_catalog_contract import CodexModelCatalog, codex_model_catalog_to_wire

_CATALOG_DEADLINE_SECONDS = 120.0


class NativeCatalogUnavailable(RuntimeError):
    """The authenticated stock server is not currently reachable."""


class NativeCatalogProtocolDefect(AssertionError):
    """The native catalog violated its declared provider contract."""


class NativeCatalogClient:
    def __init__(self, socket_path: Path) -> None:
        self._socket_path = socket_path

    async def model_catalog(self) -> CodexModelCatalog:
        try:
            async with asyncio.timeout(_CATALOG_DEADLINE_SECONDS):
                await qualify_codex_containment_host(self._socket_path)
                with tempfile.TemporaryDirectory(prefix="nexus-native-catalog-") as directory:
                    async with AgentRuntime(
                        AgentRuntimeConfig(
                            state_root_base=Path(directory),
                            codex_endpoints={"codex-personal": self._socket_path},
                        )
                    ) as runtime:
                        catalog = await runtime.model_catalog(
                            backend="codex",
                            transport="sdk",
                            auth=CredentialRef("local_account", "codex-personal"),
                        )
                        return codex_model_catalog_to_wire(catalog)
        except AgentRuntimeDefect as error:
            raise NativeCatalogProtocolDefect("Codex catalog contract is invalid") from error
        except (AgentRuntimeError, TimeoutError) as error:
            raise NativeCatalogUnavailable("authenticated Codex server is unavailable") from error

    async def health(self) -> None:
        await self.model_catalog()
