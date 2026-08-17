"""Production entrypoint for the private Unix-socket Codex agent host."""

from __future__ import annotations

import asyncio
import errno
import os
import socket
import stat
from pathlib import Path

import uvicorn
from apps.codex_agent import sandbox_health
from apps.codex_agent.auth_environment import reject_api_key_auth
from apps.codex_agent.host import create_codex_agent_app, resolve_runtime_versions
from apps.codex_agent.path_environment import required_absolute_path
from provider_runtime.agent_runtime import (
    AgentRuntime,
    AgentRuntimeConfig,
    CredentialRef,
    SessionQuery,
)

_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"
_STATE_ROOT_ENV = "NEXUS_CODEX_STATE_ROOT_BASE"
_WORKING_DIRECTORY_ENV = "NEXUS_CODEX_WORKING_DIRECTORY"


async def run() -> None:
    socket_path = required_absolute_path(_SOCKET_ENV)
    state_root = required_absolute_path(_STATE_ROOT_ENV)
    working_directory = required_absolute_path(_WORKING_DIRECTORY_ENV)
    reject_api_key_auth()
    _validate_directories(socket_path, state_root, working_directory)
    _remove_proven_stale_socket(socket_path)
    sandbox_health.check()
    versions = resolve_runtime_versions()
    await _probe_chatgpt_auth(state_root)

    def runtime_factory() -> AgentRuntime:
        return AgentRuntime(AgentRuntimeConfig(state_root_base=state_root))

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory=working_directory,
        versions=versions,
    )
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    owned_identity: tuple[int, int] | None = None
    try:
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o660)
        identity = socket_path.stat()
        owned_identity = (identity.st_dev, identity.st_ino)
        listener.listen(16)
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                log_level="info",
                lifespan="off",
                timeout_graceful_shutdown=10,
            )
        )
        await server.serve(sockets=[listener])
    finally:
        listener.close()
        _unlink_owned_socket(socket_path, owned_identity)


async def _probe_chatgpt_auth(state_root: Path) -> None:
    runtime = AgentRuntime(AgentRuntimeConfig(state_root_base=state_root))
    try:
        await runtime.list_sessions(
            SessionQuery(
                backend="codex",
                transport="sdk",
                auth=CredentialRef(kind="local_account", profile_key="codex-personal"),
                limit=1,
            )
        )
    finally:
        await runtime.close()


def _validate_directories(socket_path: Path, state_root: Path, working_directory: Path) -> None:
    _validate_owned_directory(socket_path.parent, expected_mode=0o770, label="socket directory")
    _validate_owned_directory(state_root, expected_mode=0o700, label="state root")
    _validate_owned_directory(working_directory, expected_mode=0o700, label="working directory")
    if any(entry != socket_path for entry in socket_path.parent.iterdir()):
        raise RuntimeError("Codex agent socket directory may contain only its socket")
    if any(working_directory.iterdir()):
        raise RuntimeError("Codex agent working directory must be an existing empty directory")


def _validate_owned_directory(path: Path, *, expected_mode: int, label: str) -> None:
    _reject_symlink_components(path, label=label)
    try:
        metadata = path.stat()
    except FileNotFoundError as error:
        raise RuntimeError(f"Codex agent {label} does not exist") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Codex agent {label} must be a directory")
    if metadata.st_uid != os.geteuid():
        raise RuntimeError(f"Codex agent {label} must be owned by the current uid")
    if stat.S_IMODE(metadata.st_mode) != expected_mode:
        raise RuntimeError(f"Codex agent {label} must have mode {expected_mode:04o}")


def _reject_symlink_components(path: Path, *, label: str) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError as error:
            raise RuntimeError(f"Codex agent {label} does not exist") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"Codex agent {label} must not traverse symlinks")


def _remove_proven_stale_socket(path: Path) -> None:
    try:
        initial = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(initial.st_mode):
        raise RuntimeError("Codex agent socket path must be absent or a Unix socket")

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.25)
    try:
        probe.connect(str(path))
    except OSError as error:
        if error.errno == errno.ENOENT:
            return
        if error.errno != errno.ECONNREFUSED:
            raise RuntimeError(
                "could not prove the existing Codex agent socket is stale"
            ) from error
    else:
        raise RuntimeError("a Codex agent host is already listening on the socket")
    finally:
        probe.close()

    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if (
        current.st_dev != initial.st_dev
        or current.st_ino != initial.st_ino
        or not stat.S_ISSOCK(current.st_mode)
    ):
        raise RuntimeError("Codex agent socket identity changed during stale-socket recovery")
    path.unlink()


def _unlink_owned_socket(path: Path, identity: tuple[int, int] | None) -> None:
    if identity is None:
        return
    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) != identity or not stat.S_ISSOCK(current.st_mode):
        return
    path.unlink()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
