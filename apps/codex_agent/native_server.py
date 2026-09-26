"""One pinned native Codex process and its private app-server socket."""

from __future__ import annotations

import asyncio
import importlib.metadata
import os
import signal
import stat
from dataclasses import dataclass, field
from pathlib import Path

import codex_cli_bin
from apps.codex_agent.credential_state import EphemeralRuntimePaths
from provider_runtime.agent_runtime.codex_app_server import (
    CodexAppServerClient,
    CodexAppServerConfig,
    CodexConnectionUnavailable,
)

from nexus.services.codex_generation_health_contract import PINNED_CODEX_VERSION

_START_SECONDS = 15.0
_STOP_SECONDS = 5.0
_PROFILE = "codex-personal"


@dataclass(slots=True)
class NativeCodexServer:
    process: asyncio.subprocess.Process
    socket_path: Path
    socket_target: Path
    socket_identity: tuple[int, int] | None
    _stop_task: asyncio.Task[None] | None = field(default=None, init=False, repr=False)

    @property
    def stopped(self) -> bool:
        task = self._stop_task
        return (
            task is not None and task.done() and not task.cancelled() and task.exception() is None
        )

    async def stop(self) -> None:
        if self._stop_task is None:
            self._stop_task = asyncio.create_task(self._stop_native())
        interrupted = False
        while not self._stop_task.done():
            try:
                await asyncio.shield(self._stop_task)
            except asyncio.CancelledError:
                interrupted = True
        self._stop_task.result()
        if interrupted:
            raise asyncio.CancelledError()

    async def _stop_native(self) -> None:
        await _stop_process(self.process)
        observed = _observe_socket(self.process, self.socket_path)
        if observed is not None:
            observed._remove_socket()
        elif self.socket_identity is not None:
            self._remove_socket()

    def _remove_socket(self) -> None:
        try:
            current = self.socket_target.lstat()
        except FileNotFoundError:
            current = None
        if current is not None:
            if (
                self.socket_identity is None
                or current.st_uid != os.geteuid()
                or not stat.S_ISSOCK(current.st_mode)
                or (
                    current.st_dev,
                    current.st_ino,
                )
                != self.socket_identity
            ):
                raise RuntimeError("Codex native socket changed identity")
            self.socket_target.unlink()
        if self.socket_path != self.socket_target:
            try:
                link = self.socket_path.lstat()
            except FileNotFoundError:
                return
            if not stat.S_ISLNK(link.st_mode) or self.socket_path.resolve() != self.socket_target:
                raise RuntimeError("Codex native socket link changed identity")
            self.socket_path.unlink()


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    group = process.pid
    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), _STOP_SECONDS)
    except TimeoutError:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(process.wait(), _STOP_SECONDS)
    try:
        os.killpg(group, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError("Codex native process group did not exit")


def _observe_socket(
    process: asyncio.subprocess.Process, socket_path: Path
) -> NativeCodexServer | None:
    try:
        link = socket_path.lstat()
    except FileNotFoundError:
        return None
    target = socket_path.resolve()
    if stat.S_ISLNK(link.st_mode):
        daemon_dir = Path("/tmp").resolve() / f"codex-daemon-{os.geteuid()}"
        parent = target.parent.lstat()
        if (
            target.parent != daemon_dir
            or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.geteuid()
            or stat.S_IMODE(parent.st_mode) != 0o700
        ):
            raise RuntimeError("Codex native socket escaped its private daemon directory")
    elif not stat.S_ISSOCK(link.st_mode) or target != socket_path:
        raise RuntimeError("Codex native socket path is invalid")
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        identity = None
    else:
        if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != os.geteuid():
            raise RuntimeError("Codex native socket is not owned by the host")
        identity = (metadata.st_dev, metadata.st_ino)
    return NativeCodexServer(process, socket_path, target, identity)


async def start_native_codex_server(paths: EphemeralRuntimePaths) -> NativeCodexServer:
    if importlib.metadata.version("openai-codex-cli-bin") != PINNED_CODEX_VERSION:
        raise RuntimeError("Codex binary distribution differs from the pinned version")
    executable = codex_cli_bin.bundled_codex_path()
    if not executable.is_absolute() or not executable.is_file():
        raise RuntimeError("Codex pinned executable is unavailable")
    codex_home = paths.state_root_base / "codex" / _PROFILE
    if not (codex_home / "auth.json").is_symlink():
        raise RuntimeError("Codex native process has no enrolled auth link")
    home = paths.state_root_base / "home"
    home.mkdir(mode=0o700)
    socket_path = paths.root / "codex.sock"
    try:
        socket_path.lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("Codex native socket path already exists")
    environment = {
        "CODEX_HOME": str(codex_home),
        "HOME": str(home),
        "TMPDIR": str(paths.temporary_directory),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    }
    process = await asyncio.create_subprocess_exec(
        str(executable),
        "app-server",
        "--listen",
        f"unix://{socket_path}",
        "--strict-config",
        cwd=paths.working_directory,
        env=environment,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    server: NativeCodexServer | None = None
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _START_SECONDS
        while loop.time() < deadline:
            if process.returncode is not None:
                raise RuntimeError("Codex native process exited before its socket was ready")
            server = _observe_socket(process, socket_path)
            if server is None or server.socket_identity is None:
                await asyncio.sleep(0.05)
                continue
            try:
                async with CodexAppServerClient(
                    CodexAppServerConfig(server.socket_target, client_name="nexus-codex-host")
                ) as client:
                    agent = client.metadata["userAgent"]
                    if not isinstance(agent, str) or not agent.startswith(
                        f"nexus-codex-host/{PINNED_CODEX_VERSION} ("
                    ):
                        raise RuntimeError("Codex native process reported a different version")
            except CodexConnectionUnavailable:
                await asyncio.sleep(0.05)
                continue
            return server
        raise RuntimeError("Codex native socket did not pass its startup handshake")
    except BaseException:
        if server is not None:
            await server.stop()
        else:
            await _stop_process(process)
            server = _observe_socket(process, socket_path)
            if server is not None:
                server._remove_socket()
        raise


__all__ = ["NativeCodexServer", "start_native_codex_server"]
