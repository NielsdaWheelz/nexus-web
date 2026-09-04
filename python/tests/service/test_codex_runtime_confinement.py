"""Behavioral proofs for Nexus-owned Codex temporary-directory confinement."""

from __future__ import annotations

import asyncio
import os
from importlib.util import find_spec
from pathlib import Path
from typing import TYPE_CHECKING

import codex_cli_bin
import pytest

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from apps.codex_agent import sandbox_health
    from apps.codex_agent.auth_environment import reject_subscription_api_key_auth
    from apps.codex_agent.confined_runtime import create_confined_runtime
    from provider_runtime.agent_runtime import (
        AgentRuntimeConfig,
        CodexSandboxControls,
        ProtocolDefect,
    )


def test_subscription_process_rejects_every_api_key_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Risk: a future provider credential leaks into the subscription host."""

    monkeypatch.setenv("ANTHROPIC_GENERATION_API_KEY", "must-not-reach-codex")
    with pytest.raises(RuntimeError, match="ANTHROPIC_GENERATION_API_KEY"):
        reject_subscription_api_key_auth()


def test_sandbox_readiness_failure_removes_its_complete_turn_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in tuple(os.environ):
        if name.endswith("_API_KEY"):
            monkeypatch.delenv(name)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    turn_root = tmp_path / "turns"
    turn_root.mkdir(mode=0o700, parents=True)
    # The bundled executable is the third-party boundary; Nexus cleanup remains real.
    monkeypatch.setattr(
        codex_cli_bin,
        "bundled_codex_path",
        lambda: tmp_path / "unavailable-codex",
    )

    with pytest.raises(RuntimeError, match="sandbox readiness probe failed"):
        sandbox_health.check(turn_root)

    assert not any(turn_root.iterdir())


def _turn_layout(root: Path) -> tuple[Path, Path]:
    turn_root = root / "turn"
    state_root = turn_root / "state"
    temporary_directory = turn_root / "tmp"
    for directory in (turn_root, state_root, temporary_directory):
        directory.mkdir(mode=0o700, parents=True)
    return state_root, temporary_directory


def test_confined_runtime_owns_startup_and_workspace_write_tmp_policy_at_sdk_boundary(
    tmp_path: Path,
) -> None:
    """Risk: catalog or generation launches escape the ephemeral turn root."""

    assert _CUTOVER_PRESENT, "the confined Codex generation runtime cutover is absent"
    state_root, temporary_directory = _turn_layout(tmp_path)
    runtime = create_confined_runtime(AgentRuntimeConfig(state_root_base=state_root))
    try:
        assert runtime.config.codex_sandbox == CodexSandboxControls(
            child_tmpdir=str(temporary_directory),
            exclude_slash_tmp=True,
            exclude_tmpdir_env_var=False,
        )
    finally:
        asyncio.run(runtime.close())

    drifted = AgentRuntimeConfig(
        state_root_base=state_root,
        codex_sandbox=CodexSandboxControls(
            child_tmpdir=str(temporary_directory),
            exclude_slash_tmp=False,
            exclude_tmpdir_env_var=False,
        ),
    )
    with pytest.raises(ProtocolDefect, match="differ from the confined turn layout"):
        create_confined_runtime(drifted)


def test_confined_runtime_rejects_symlink_and_non_private_layouts(tmp_path: Path) -> None:
    """Risk: a caller redirects Codex state or TMPDIR outside its cleanup owner."""

    outside = tmp_path / "outside"
    state_root, _temporary_directory = _turn_layout(outside)
    linked_turn = tmp_path / "linked-turn"
    linked_turn.symlink_to(state_root.parent, target_is_directory=True)
    with pytest.raises(ProtocolDefect, match="private owned directory"):
        create_confined_runtime(AgentRuntimeConfig(state_root_base=linked_turn / "state"))

    private = tmp_path / "private"
    private_state, private_tmp = _turn_layout(private)
    private_tmp.chmod(0o755)
    with pytest.raises(ProtocolDefect, match="private owned directory"):
        create_confined_runtime(AgentRuntimeConfig(state_root_base=private_state))
