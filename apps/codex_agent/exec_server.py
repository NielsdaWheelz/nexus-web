"""One disposable remote Codex executor with no account credential mount."""

from __future__ import annotations

import asyncio
import importlib.metadata
import os
import shutil
import signal
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import codex_cli_bin
from apps.codex_agent.credential_state import EphemeralRuntimePaths

from nexus.services.codex_generation_health_contract import PINNED_CODEX_VERSION

_START_SECONDS = 15.0
_STOP_SECONDS = 5.0
_EXEC_CWD = "/workspace"
_READ_ONLY_PATHS = (
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/app/.venv",
    "/etc/ssl",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/ld.so.cache",
    "/etc/codex/requirements.toml",
)


@dataclass(slots=True)
class ExecServer:
    process: asyncio.subprocess.Process
    url: str
    cwd: str = _EXEC_CWD
    _drain: asyncio.Task[None] | None = field(default=None, repr=False)
    _stop_task: asyncio.Task[None] | None = field(default=None, repr=False)

    async def stop(self) -> None:
        if self._stop_task is None:
            self._stop_task = asyncio.create_task(self._stop_process())
        interrupted = False
        while not self._stop_task.done():
            try:
                await asyncio.shield(self._stop_task)
            except asyncio.CancelledError:
                interrupted = True
        self._stop_task.result()
        if interrupted:
            raise asyncio.CancelledError()

    async def _stop_process(self) -> None:
        group = self.process.pid
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(self.process.wait(), _STOP_SECONDS)
        except TimeoutError:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await asyncio.wait_for(self.process.wait(), _STOP_SECONDS)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _STOP_SECONDS
        while True:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                if self._drain is not None:
                    await asyncio.wait_for(self._drain, _STOP_SECONDS)
                return
            if loop.time() >= deadline:
                raise RuntimeError("Codex exec-server process group survived teardown")
            await asyncio.sleep(0.05)


async def _drain_stdout(stream: asyncio.StreamReader) -> None:
    while await stream.read(4096):
        pass


def _readonly_mount(path: str) -> tuple[str, ...]:
    source = Path(path)
    if source.is_symlink():
        return ("--symlink", os.readlink(source), path)
    if source.exists():
        return ("--ro-bind", path, path)
    return ()


def sandbox_command(
    paths: EphemeralRuntimePaths,
    environment: dict[str, str],
    command: tuple[str, ...],
) -> list[str]:
    executable = codex_cli_bin.bundled_codex_path()
    if not executable.is_absolute() or not executable.is_file():
        raise RuntimeError("Codex pinned exec-server executable is unavailable")
    if not executable.is_relative_to("/app/.venv"):
        raise RuntimeError("Codex pinned executable escaped its read-only package mount")
    args = [
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--clearenv",
    ]
    for path in _READ_ONLY_PATHS:
        args.extend(_readonly_mount(path))
    args.extend(
        (
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/run",
            "--bind",
            str(paths.working_directory),
            _EXEC_CWD,
            "--bind",
            str(paths.temporary_directory),
            "/tmp",
            "--bind",
            str(paths.root / "exec-home"),
            "/home/agent",
            "--chdir",
            _EXEC_CWD,
        )
    )
    for name, value in environment.items():
        args.extend(("--setenv", name, value))
    args.extend(command)
    return args


async def start_exec_server(
    paths: EphemeralRuntimePaths, *, api_environment: dict[str, str]
) -> ExecServer:
    if importlib.metadata.version("openai-codex-cli-bin") != PINNED_CODEX_VERSION:
        raise RuntimeError("Codex exec-server binary differs from the pinned version")
    executable = codex_cli_bin.bundled_codex_path()
    version_process = await asyncio.create_subprocess_exec(
        str(executable),
        "--version",
        env={"PATH": "/usr/bin:/bin"},
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        version_output, _ = await asyncio.wait_for(version_process.communicate(), 3.0)
    except BaseException:
        version_process.kill()
        await version_process.wait()
        raise
    if version_process.returncode != 0 or version_output != (
        f"codex-cli {PINNED_CODEX_VERSION}\n".encode()
    ):
        raise RuntimeError("Codex exec-server executable reported a different version")
    expected = {
        "NEXUS_AGENT_API_URL",
        "NEXUS_AGENT_API_SPEC_URL",
        "NEXUS_AGENT_API_TOKEN",
        "NEXUS_GENERATION_ID",
    }
    if set(api_environment) != expected or any(not value for value in api_environment.values()):
        raise ValueError("Codex generation API environment is incomplete")
    home = paths.root / "exec-home"
    home.mkdir(mode=0o700)
    (home / ".codex").mkdir(mode=0o700)
    skill_source = Path(__file__).parent / "skills" / "nexus-api" / "SKILL.md"
    skill_target = paths.working_directory / ".agents" / "skills" / "nexus-api" / "SKILL.md"
    skill_target.parent.mkdir(parents=True, mode=0o700)
    shutil.copyfile(skill_source, skill_target)
    skill_target.chmod(0o600)
    environment = {
        "HOME": "/home/agent",
        "CODEX_HOME": "/home/agent/.codex",
        "TMPDIR": "/tmp",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        **api_environment,
    }
    # Bubblewrap reads its arguments from an inherited pipe. The bearer must
    # never appear in the outer process command line or diagnostics.
    read_fd, write_fd = os.pipe()
    try:
        arguments = sandbox_command(
            paths,
            environment,
            (),
        )[1:]
        payload = b"\0".join(part.encode() for part in arguments) + b"\0"
        if len(payload) > 4096 or os.write(write_fd, payload) != len(payload):
            raise RuntimeError("Codex sandbox argument pipe exceeds its bound")
        os.close(write_fd)
        write_fd = -1
        process = await asyncio.create_subprocess_exec(
            "/usr/bin/bwrap",
            "--args",
            str(read_fd),
            "--",
            str(executable),
            "exec-server",
            "--listen",
            "ws://127.0.0.1:0",
            cwd=paths.root,
            env={"PATH": "/usr/bin:/bin"},
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            pass_fds=(read_fd,),
            start_new_session=True,
        )
    finally:
        os.close(read_fd)
        if write_fd != -1:
            os.close(write_fd)
    try:
        if process.stdout is None:
            raise RuntimeError("Codex exec-server stdout is unavailable")
        line = await asyncio.wait_for(process.stdout.readline(), _START_SECONDS)
        if len(line) > 4096:
            raise RuntimeError("Codex exec-server listen URL exceeds its bound")
        url = line.decode("ascii").strip()
        parsed = urlsplit(url)
        if (
            parsed.scheme != "ws"
            or parsed.hostname != "127.0.0.1"
            or parsed.port is None
            or parsed.port == 0
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
            or process.returncode is not None
        ):
            raise RuntimeError("Codex exec-server reported a non-loopback listen URL")
        return ExecServer(
            process=process,
            url=url,
            _drain=asyncio.create_task(_drain_stdout(process.stdout)),
        )
    except BaseException:
        await ExecServer(process=process, url="").stop()
        raise
