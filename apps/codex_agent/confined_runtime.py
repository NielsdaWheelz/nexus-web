"""Nexus-owned confinement for the pinned Codex AgentRuntime adapter."""

from __future__ import annotations

import stat
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType

from provider_runtime.agent_runtime import (
    AgentRuntime,
    AgentRuntimeConfig,
    AgentSession,
    AgentSessionRef,
    AgentSessionRequest,
    ProtocolDefect,
    SessionPage,
    SessionQuery,
    SessionReadOptions,
    SessionSnapshot,
)
from provider_runtime.agent_runtime.codex_sdk import CodexSdkAdapter

CODEX_TMP_SANDBOX_CONFIG: Mapping[str, bool] = MappingProxyType(
    {
        "exclude_slash_tmp": True,
        "exclude_tmpdir_env_var": False,
    }
)
CODEX_TMP_SANDBOX_OVERRIDES = tuple(
    f"sandbox_workspace_write.{key}={str(value).lower()}"
    for key, value in CODEX_TMP_SANDBOX_CONFIG.items()
)
CODEX_SANDBOX_HEALTH_OVERRIDES = (
    'sandbox_mode="workspace-write"',
    *CODEX_TMP_SANDBOX_OVERRIDES,
)


class ConfinedCodexSdkAdapter(CodexSdkAdapter):
    """Keep the pinned Codex process and workspace sandbox inside one turn root."""

    def __init__(self, temporary_directory: Path) -> None:
        super().__init__()
        self._temporary_directory = _validate_temporary_directory(temporary_directory)

    async def list_sessions(
        self,
        query: SessionQuery,
        *,
        environment: Mapping[str, str],
    ) -> SessionPage:
        return await super().list_sessions(
            query,
            environment=self._confined_environment(environment),
        )

    async def read_session(
        self,
        ref: AgentSessionRef,
        options: SessionReadOptions,
        *,
        environment: Mapping[str, str],
    ) -> SessionSnapshot:
        return await super().read_session(
            ref,
            options,
            environment=self._confined_environment(environment),
        )

    async def open_session(
        self,
        request: AgentSessionRequest,
        *,
        environment: Mapping[str, str],
    ) -> AgentSession:
        return await super().open_session(
            request,
            environment=self._confined_environment(environment),
        )

    def _confined_environment(self, environment: Mapping[str, str]) -> dict[str, str]:
        child_environment = dict(environment)
        child_environment["TMPDIR"] = str(self._temporary_directory)
        return child_environment

    def _codex_config(self, request: AgentSessionRequest) -> dict[str, object]:
        # provider-runtime@a5d9c8e owns this lowering hook but does not expose the
        # Codex 0.144.4 /tmp exclusions publicly. The exact dependency pin plus
        # the bundled-sandbox readiness proof below make this narrow override an
        # upgrade gate rather than an open-ended compatibility layer.
        config = super()._codex_config(request)
        workspace_write = config.get("sandbox_workspace_write")
        if request.policy.filesystem != "workspace_write":
            return config
        if not isinstance(workspace_write, dict):
            raise ProtocolDefect(
                "pinned Codex workspace-write config changed shape",
                code="codex_sandbox_config_defect",
            )
        config["sandbox_workspace_write"] = {
            **workspace_write,
            **CODEX_TMP_SANDBOX_CONFIG,
        }
        return config


def create_confined_runtime(config: AgentRuntimeConfig) -> AgentRuntime:
    if config.state_root_base.name != "state":
        raise ProtocolDefect(
            "Codex state root does not match the turn layout",
            code="codex_temporary_directory_defect",
        )
    temporary_directory = config.state_root_base.parent / "tmp"
    return AgentRuntime(
        config,
        adapters=(ConfinedCodexSdkAdapter(temporary_directory),),
    )


def _validate_temporary_directory(path: Path) -> Path:
    if path.name != "tmp":
        raise ProtocolDefect(
            "Codex temporary directory is outside the turn layout",
            code="codex_temporary_directory_defect",
        )
    try:
        metadata = path.lstat()
        resolved = path.resolve()
    except OSError:
        raise ProtocolDefect(
            "Codex temporary directory is unavailable",
            code="codex_temporary_directory_defect",
        ) from None
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o700
        or resolved != path
    ):
        raise ProtocolDefect(
            "Codex temporary directory is not private",
            code="codex_temporary_directory_defect",
        )
    return path
