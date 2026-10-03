"""One pinned native Codex process and its private app-server socket."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import signal
import stat
from dataclasses import dataclass, field
from pathlib import Path

import codex_cli_bin
from apps.codex_agent.credential_state import validate_enrolled_auth_file
from provider_runtime.agent_runtime import (
    CODEX_CONTAINMENT_VERSION,
    materialize_codex_containment_catalog,
)

from nexus.services.native_catalog_client import (
    NativeCatalogClient,
    NativeCatalogUnavailable,
)
from nexus.services.native_health_contract import PINNED_CODEX_VERSION

_START_SECONDS = 15.0
_STOP_SECONDS = 5.0


@dataclass(slots=True)
class NativeCodexServer:
    process: asyncio.subprocess.Process
    socket_path: Path
    socket_target: Path
    socket_identity: tuple[int, int] | None
    _stop_task: asyncio.Task[None] | None = field(default=None, init=False, repr=False)

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
            or target.parent != socket_path.parent
            or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.geteuid()
            or parent.st_gid != os.getegid()
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
        if (
            not stat.S_ISSOCK(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
        ):
            raise RuntimeError("Codex native socket is not owned by the host")
        identity = (metadata.st_dev, metadata.st_ino)
    return NativeCodexServer(process, socket_path, target, identity)


async def start_native_codex_server(
    *, socket_path: Path, credential_file: Path
) -> NativeCodexServer:
    if (
        PINNED_CODEX_VERSION != CODEX_CONTAINMENT_VERSION
        or importlib.metadata.version("openai-codex-cli-bin") != PINNED_CODEX_VERSION
    ):
        raise RuntimeError("Codex binary distribution differs from the pinned version")
    executable = codex_cli_bin.bundled_codex_path()
    if not executable.is_absolute() or not executable.is_file():
        raise RuntimeError("Codex pinned executable is unavailable")
    validate_enrolled_auth_file(credential_file)
    if credential_file.name != "auth.json":
        raise RuntimeError("Codex native account file must be auth.json")
    codex_home = credential_file.parent
    daemon_dir = Path("/tmp").resolve() / f"codex-daemon-{os.geteuid()}"
    if not socket_path.is_absolute() or socket_path.parent != daemon_dir:
        raise RuntimeError("Codex native socket must occupy its private shared daemon directory")
    daemon_dir.mkdir(mode=0o700, exist_ok=True)
    metadata = daemon_dir.stat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_gid != os.getegid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise RuntimeError("Codex shared socket directory must be private and process-owned")
    cwd_root = daemon_dir / "cwds"
    cwd_root.mkdir(mode=0o700, exist_ok=True)
    cwd = cwd_root / "host"
    cwd.mkdir(mode=0o500, exist_ok=True)
    home = codex_home / "home"
    temporary = codex_home / "tmp"
    home.mkdir(mode=0o700, exist_ok=True)
    temporary.mkdir(mode=0o700, exist_ok=True)
    try:
        socket_path.lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("Codex native socket path already exists")
    catalog = materialize_codex_containment_catalog(codex_home)
    environment = {
        "CODEX_HOME": str(codex_home),
        "CODEX_EXEC_SERVER_URL": "none",
        "HOME": str(home),
        "TMPDIR": str(temporary),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    }
    process = await asyncio.create_subprocess_exec(
        str(executable),
        "-c",
        f"model_catalog_json={json.dumps(str(catalog))}",
        "app-server",
        "--listen",
        f"unix://{socket_path}",
        "--strict-config",
        cwd=cwd,
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
                async with asyncio.timeout(max(0.001, deadline - loop.time())):
                    await NativeCatalogClient(server.socket_target).health()
            except NativeCatalogUnavailable:
                await asyncio.sleep(0.05)
                continue
            os.chmod(server.socket_target, 0o660)
            return server
        raise RuntimeError("Codex native socket did not pass its authenticated startup probe")
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
