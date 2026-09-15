"""Production entrypoint for the private Unix-socket Codex agent host."""

from __future__ import annotations

import asyncio
import errno
import os
import socket
import stat
import sys
from pathlib import Path
from typing import Never

from apps.codex_agent import sandbox_health
from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.confined_runtime import create_confined_runtime
from apps.codex_agent.credential_state import (
    create_ephemeral_runtime_paths,
    enrolled_auth_identity,
    link_runtime_auth,
    remove_ephemeral_runtime_paths,
    require_private_executable_runtime_mount,
    require_writable_credential_mount,
    sync_enrolled_auth_file,
    validate_runtime_auth_link,
)
from apps.codex_agent.path_environment import required_absolute_path
from provider_runtime.agent_runtime import (
    AgentRuntime,
    AgentRuntimeConfig,
    CredentialRef,
)

_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"
_CREDENTIAL_FILE_ENV = "NEXUS_CODEX_CREDENTIAL_FILE"
_WORKING_DIRECTORY_ROOT_ENV = "NEXUS_CODEX_WORKING_DIRECTORY_ROOT"
_MCP_ORIGIN_ENV = "NEXUS_CODEX_MCP_ORIGIN"
_MODEL_TOOL_NETWORK_ATTESTED_ENV = "NEXUS_CODEX_MODEL_TOOL_NETWORK_ATTESTED"
_SERVE_AFTER_AUTH_ARGUMENT = "_serve-after-authenticated-bootstrap"


async def _authenticated_bootstrap() -> None:
    """Authenticate once, sync the durable credential, and release probe state."""

    socket_path, credential_file, working_directory_root, _mcp_origin, _attested = (
        _runtime_configuration()
    )
    _prepare_runtime_boundary(socket_path, credential_file, working_directory_root)
    probe_paths = create_ephemeral_runtime_paths(working_directory_root, "startup-auth")
    credential_identity = enrolled_auth_identity(credential_file)
    probe_auth_link: Path | None = None
    try:
        probe_auth_link = link_runtime_auth(credential_file, probe_paths)
        await _probe_chatgpt_auth(probe_paths.state_root_base)
    finally:
        try:
            if probe_auth_link is not None:
                validate_runtime_auth_link(probe_auth_link, credential_file)
                sync_enrolled_auth_file(
                    credential_file,
                    expected_identity=credential_identity,
                )
        finally:
            remove_ephemeral_runtime_paths(probe_paths, root=working_directory_root)
    _validate_directories(socket_path, working_directory_root)
    require_writable_credential_mount(credential_file)


async def _serve_after_authenticated_bootstrap() -> None:
    """Build the long-lived server only in the fresh post-bootstrap process."""

    import uvicorn
    from apps.codex_agent.host import (
        CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS,
        CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS,
        create_codex_agent_app,
        resolve_runtime_versions,
        turn_lifecycle,
    )

    from nexus.services.codex_generation_operations import (
        compose_codex_model_tool_plan_registry,
    )

    socket_path, credential_file, working_directory_root, mcp_origin, attested = (
        _runtime_configuration()
    )
    _prepare_runtime_boundary(socket_path, credential_file, working_directory_root)
    versions = resolve_runtime_versions()

    app = create_codex_agent_app(
        runtime_factory=runtime_factory,
        working_directory_root=working_directory_root,
        credential_file=credential_file,
        versions=versions,
        model_tool_registry=compose_codex_model_tool_plan_registry(),
        mcp_origin=mcp_origin,
        model_tool_network_attested=attested,
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
                timeout_graceful_shutdown=int(CODEX_AGENT_HOST_REQUEST_DRAIN_SECONDS),
            )
        )
        await server.serve(sockets=[listener])
    finally:
        listener.close()
        _unlink_owned_socket(socket_path, owned_identity)
        # The server has stopped listening and cancelled any in-flight request; the
        # admitted turn it interrupted is still closing its runtime. Reap it here so the
        # native process tree never outlives this container's graceful stop.
        await turn_lifecycle(app).drain(CODEX_AGENT_HOST_TEARDOWN_DEADLINE_SECONDS)


def _runtime_configuration() -> tuple[Path, Path, Path, str, bool]:
    socket_path = required_absolute_path(_SOCKET_ENV)
    credential_file = required_absolute_path(_CREDENTIAL_FILE_ENV)
    working_directory_root = required_absolute_path(_WORKING_DIRECTORY_ROOT_ENV)
    mcp_origin = _required_environment(_MCP_ORIGIN_ENV)
    model_tool_network_attested = _required_model_tool_network_attestation()
    return (
        socket_path,
        credential_file,
        working_directory_root,
        mcp_origin,
        model_tool_network_attested,
    )


def _prepare_runtime_boundary(
    socket_path: Path,
    credential_file: Path,
    working_directory_root: Path,
) -> None:
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    _prepare_working_directory_root(working_directory_root)
    _validate_directories(socket_path, working_directory_root)
    require_private_executable_runtime_mount(working_directory_root)
    require_writable_credential_mount(credential_file)
    _remove_proven_stale_socket(socket_path)
    sandbox_health.check(working_directory_root)


def runtime_factory(config: AgentRuntimeConfig) -> AgentRuntime:
    return create_confined_runtime(config)


async def _probe_chatgpt_auth(state_root: Path) -> None:
    runtime = create_confined_runtime(AgentRuntimeConfig(state_root_base=state_root))
    try:
        await runtime.model_catalog(
            "codex",
            CredentialRef(kind="local_account", profile_key="codex-personal"),
            transport="sdk",
        )
    finally:
        await runtime.close()


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if value is None or not value:
        raise RuntimeError(f"{name} is required")
    return value


def _required_model_tool_network_attestation() -> bool:
    value = _required_environment(_MODEL_TOOL_NETWORK_ATTESTED_ENV)
    if value != "true":
        raise RuntimeError(f"{_MODEL_TOOL_NETWORK_ATTESTED_ENV} must be exactly 'true'")
    return True


def _validate_directories(
    socket_path: Path,
    working_directory_root: Path,
) -> None:
    _validate_owned_directory(socket_path.parent, expected_mode=0o770, label="socket directory")
    _validate_owned_directory(
        working_directory_root,
        expected_mode=0o700,
        label="working-directory root",
    )
    if any(entry != socket_path for entry in socket_path.parent.iterdir()):
        raise RuntimeError("Codex agent socket directory may contain only its socket")
    if any(working_directory_root.iterdir()):
        raise RuntimeError("Codex agent working-directory root must be empty at startup")


def _prepare_working_directory_root(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass


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


def _exec_server_after_auth() -> Never:
    os.execv(
        sys.executable,
        (
            sys.executable,
            "-m",
            "apps.codex_agent.main",
            _SERVE_AFTER_AUTH_ARGUMENT,
        ),
    )


def main() -> None:
    arguments = tuple(sys.argv[1:])
    if not arguments:
        asyncio.run(_authenticated_bootstrap())
        _exec_server_after_auth()
    if arguments == (_SERVE_AFTER_AUTH_ARGUMENT,):
        asyncio.run(_serve_after_authenticated_bootstrap())
        return
    raise SystemExit("usage: python -m apps.codex_agent.main")


if __name__ == "__main__":
    main()
