"""Nexus-owned turn layout for the public AgentRuntime Codex sandbox controls."""

from __future__ import annotations

import os
import stat
from dataclasses import replace
from pathlib import Path

from provider_runtime.agent_runtime import (
    AgentRuntime,
    AgentRuntimeConfig,
    CodexSandboxControls,
    ProtocolDefect,
)

_STATE_DIRECTORY_NAME = "state"
_TEMPORARY_DIRECTORY_NAME = "tmp"
_PRIVATE_DIRECTORY_MODE = 0o700
_EXCLUDE_SLASH_TMP = True
_EXCLUDE_TMPDIR_ENV_VAR = False

# The startup health probe invokes the pinned Codex executable directly. Keep
# its arguments derived from the same typed values passed to AgentRuntime.
CODEX_SANDBOX_HEALTH_OVERRIDES = (
    'sandbox_mode="workspace-write"',
    f"sandbox_workspace_write.exclude_slash_tmp={str(_EXCLUDE_SLASH_TMP).lower()}",
    f"sandbox_workspace_write.exclude_tmpdir_env_var={str(_EXCLUDE_TMPDIR_ENV_VAR).lower()}",
)


def create_confined_runtime(config: AgentRuntimeConfig) -> AgentRuntime:
    """Apply the one validated TMPDIR/sandbox policy on every runtime path."""

    controls = _controls_for_state_root(config.state_root_base)
    if config.codex_sandbox is not None and config.codex_sandbox != controls:
        raise ProtocolDefect(
            "Codex sandbox controls differ from the confined turn layout",
            code="codex_temporary_directory_defect",
        )
    return AgentRuntime(replace(config, codex_sandbox=controls))


def _controls_for_state_root(state_root_base: Path) -> CodexSandboxControls:
    if state_root_base.name != _STATE_DIRECTORY_NAME:
        raise ProtocolDefect(
            "Codex state root does not match the turn layout",
            code="codex_temporary_directory_defect",
        )
    runtime_root = state_root_base.parent
    temporary_directory = runtime_root / _TEMPORARY_DIRECTORY_NAME
    _require_private_directory(runtime_root, label="turn root")
    _require_private_directory(state_root_base, label="state root")
    _require_private_directory(temporary_directory, label="temporary directory")
    return CodexSandboxControls(
        child_tmpdir=str(temporary_directory),
        exclude_slash_tmp=_EXCLUDE_SLASH_TMP,
        exclude_tmpdir_env_var=_EXCLUDE_TMPDIR_ENV_VAR,
    )


def _require_private_directory(path: Path, *, label: str) -> None:
    if not path.is_absolute() or Path(os.path.normpath(str(path))) != path:
        raise ProtocolDefect(
            f"Codex {label} must be normalized and absolute",
            code="codex_temporary_directory_defect",
        )
    try:
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError:
        raise ProtocolDefect(
            f"Codex {label} is unavailable",
            code="codex_temporary_directory_defect",
        ) from None
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != _PRIVATE_DIRECTORY_MODE
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or resolved != path
    ):
        raise ProtocolDefect(
            f"Codex {label} is not a private owned directory",
            code="codex_temporary_directory_defect",
        )


__all__ = ["CODEX_SANDBOX_HEALTH_OVERRIDES", "create_confined_runtime"]
