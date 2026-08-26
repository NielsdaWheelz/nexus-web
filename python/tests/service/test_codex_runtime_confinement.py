"""Behavioral proof for Nexus-owned Codex temporary-directory confinement."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from uuid import UUID

import codex_cli_bin
import provider_runtime.agent_runtime.codex_sdk as codex_sdk
import pytest
from apps.codex_agent import sandbox_health
from apps.codex_agent.confined_runtime import create_confined_runtime
from provider_runtime.agent_runtime import (
    AgentRuntimeConfig,
    AgentSessionRequest,
    CredentialRef,
    ProtocolDefect,
    SessionQuery,
)
from provider_runtime.agent_runtime.auth import mcp_header_environment_name
from provider_runtime.agent_runtime.codex_sdk import CodexSdkAdapter
from pydantic import SecretStr

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import ChatOperation, GenerationCommand
from nexus.services.codex_generation_operations import resolve_codex_generation
from nexus.services.generation_intent import BearerToolGrant, GenerationIntent, TextOutput

_MCP_ORIGIN = "https://mcp.nexus.example.com/internal/agent-tools/mcp"
_GRANT = "run-scoped-grant-61-must-not-leak"


def test_sandbox_readiness_failure_removes_its_complete_turn_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CODEX_API_KEY", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    turn_root = tmp_path / "turns"
    turn_root.mkdir(mode=0o700)
    # The bundled executable is the third-party boundary; Nexus cleanup remains real.
    monkeypatch.setattr(
        codex_cli_bin,
        "bundled_codex_path",
        lambda: tmp_path / "unavailable-codex",
    )

    with pytest.raises(RuntimeError, match="sandbox readiness probe failed"):
        sandbox_health.check(turn_root)

    assert not any(turn_root.iterdir())


def test_confined_runtime_owns_startup_and_workspace_write_tmp_policy_at_sdk_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Risk: startup or ChatTools launches escape the ephemeral turn root."""

    turn_root = tmp_path / "turn"
    state_root = turn_root / "state"
    temporary_directory = turn_root / "tmp"
    working_directory = turn_root / "workspace"
    for directory in (turn_root, state_root, temporary_directory, working_directory):
        directory.mkdir(mode=0o700)

    launches: list[dict[str, object]] = []
    starts: list[dict[str, object]] = []
    sdk = SimpleNamespace(
        ApprovalMode=SimpleNamespace(deny_all="deny-all", auto_review="auto-review"),
        Sandbox=SimpleNamespace(
            read_only="read-only",
            workspace_write="workspace-write",
            full_access="full-access",
        ),
    )

    class BoundaryClient:
        async def account(self) -> dict[str, object]:
            return {"account": {"type": "chatgpt"}}

        async def thread_list(self, **_kwargs: object) -> dict[str, object]:
            return {"data": [], "nextCursor": None}

        async def thread_start(self, **kwargs: object) -> SimpleNamespace:
            starts.append(dict(kwargs))
            return SimpleNamespace(id=f"confined-thread-{len(starts)}")

        async def close(self) -> None:
            return None

    async def open_client(
        _adapter: CodexSdkAdapter,
        *,
        cwd: str | None,
        environment: Mapping[str, str],
        require_certified_builtin_policy: bool = False,
    ) -> tuple[object, BoundaryClient]:
        launches.append(
            {
                "cwd": cwd,
                "environment": dict(environment),
                "certified_policy": require_certified_builtin_policy,
            }
        )
        return sdk, BoundaryClient()

    async def namespace_available(**_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(CodexSdkAdapter, "_open_client", open_client)
    monkeypatch.setattr(
        codex_sdk,
        "bubblewrap_network_namespace_available",
        namespace_available,
    )

    local_account = CredentialRef(kind="local_account", profile_key="codex-personal")
    tool_credential = CredentialRef(
        kind="secret_reference",
        profile_key="codex-personal",
        name="run-grant-reference",
    )
    policy = generation_policy.chat_policy("balanced")
    operation = resolve_codex_generation(
        GenerationCommand(
            request_id=UUID(int=61),
            operation=ChatOperation(profile="balanced", revision=policy.revision),
            policy_revision=generation_policy.POLICY_REVISION,
            policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
            intent=GenerationIntent(
                instructions="exercise the confined ChatTools launch",
                input="bounded input",
                output=TextOutput(),
            ),
            tool_grant=BearerToolGrant(token=SecretStr(_GRANT)),
        ),
        working_directory=working_directory,
        mcp_origin=_MCP_ORIGIN,
        tool_credential=tool_credential,
    )

    async def resolve_secret(_name: str) -> str:
        return _GRANT

    def runtime_config() -> AgentRuntimeConfig:
        return AgentRuntimeConfig(
            state_root_base=state_root,
            secret_resolver=resolve_secret,
        )

    async def exercise_public_runtime() -> None:
        runtime = create_confined_runtime(runtime_config())
        try:
            page = await runtime.list_sessions(
                SessionQuery(
                    backend="codex",
                    transport="sdk",
                    auth=local_account,
                    limit=1,
                )
            )
            assert page.sessions == ()
            session = await runtime.open_session(operation.session)
            await runtime.close_session(session)
        finally:
            await runtime.close()

    asyncio.run(exercise_public_runtime())

    assert len(launches) == 2
    for launch in launches:
        environment = cast(dict[str, str], launch["environment"])
        assert environment["TMPDIR"] == str(temporary_directory), (
            "Codex child TMPDIR escaped its turn root"
        )
    assert launches[0]["cwd"] is None
    assert launches[1]["cwd"] == str(working_directory)
    assert launches[1]["certified_policy"] is True
    assert len(starts) == 1
    assert starts[0]["sandbox"] == "workspace-write"
    config = cast(dict[str, object], starts[0]["config"])
    assert config["shell_environment_policy"] == {
        "inherit": "core",
        "exclude": [mcp_header_environment_name("codex", tool_credential)],
    }
    assert config["sandbox_workspace_write"] == {
        "writable_roots": [str(working_directory)],
        "network_access": True,
        "exclude_slash_tmp": True,
        "exclude_tmpdir_env_var": False,
    }

    def drifted_upstream_config(
        _adapter: CodexSdkAdapter,
        _request: AgentSessionRequest,
    ) -> dict[str, object]:
        return {"mcp_servers": {}, "web_search": "disabled"}

    monkeypatch.setattr(CodexSdkAdapter, "_codex_config", drifted_upstream_config)

    async def reject_upstream_shape_drift() -> None:
        runtime = create_confined_runtime(runtime_config())
        try:
            with pytest.raises(ProtocolDefect) as raised:
                await runtime.open_session(operation.session)
            assert raised.value.code == "codex_sandbox_config_defect"
            assert str(raised.value) == "pinned Codex workspace-write config changed shape"
        finally:
            await runtime.close()

    asyncio.run(reject_upstream_shape_drift())
    assert len(starts) == 1, "config drift reached the billable thread-start boundary"
