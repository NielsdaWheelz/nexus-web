"""One native incarnation per container; only its successor proves retirement.

The container owner guarantees exclusive account-state custody and complete PID
namespace teardown before restart. This supervisor never restarts a native child.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import signal
import stat
from collections.abc import Iterator, Mapping
from pathlib import Path
from urllib.parse import unquote, urlsplit

import uvicorn
from apps.codex_agent.binary import codex_command
from apps.codex_agent.state import advance
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from provider_runtime.agent_runtime import (
    AgentRuntimeDefect,
    AgentRuntimeError,
    CodexUnixEndpoint,
    CodexWebSocketEndpoint,
    CredentialRejected,
    CredentialUnavailable,
    InvalidAgentRequest,
    UnsupportedCapability,
    materialize_codex_containment_catalog,
    qualify_codex_containment_host,
)
from provider_runtime.agent_runtime.codex_host import (
    CodexHostActive,
    CodexHostResolveRequest,
    CodexHostRetired,
    CodexHostRetireRequest,
    CodexHostTarget,
    CodexHostUnavailable,
    CodexHostUnavailableReason,
    CodexHostUnixTransport,
    CodexHostWebSocketTransport,
)
from pydantic import SecretStr, ValidationError

logger = logging.getLogger(__name__)


class _ControlServer(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        # Native shutdown, not HTTP shutdown, owns the container's exit status.
        yield


def main() -> None:
    asyncio.run(serve(native_settings=(), native_environment={}))


async def serve(*, native_settings: tuple[str, ...], native_environment: Mapping[str, str]) -> None:
    """Shared production/synthetic-upstream lifecycle; both launch the pinned binary."""
    credential = Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"])
    account = credential.parent
    scope = os.environ["NEXUS_CODEX_HOST_SCOPE"]
    if scope not in {"dedicated", "shared"}:
        raise ValueError("NEXUS_CODEX_HOST_SCOPE must be dedicated or shared")
    control = urlsplit(os.environ["NEXUS_CODEX_CONTROL_ENDPOINT"])
    native_url = os.environ.get("NEXUS_CODEX_NATIVE_ENDPOINT")
    verifier = os.environ.get("NEXUS_CODEX_CONTROL_TOKEN_SHA256")
    cwd_root = Path(os.environ["NEXUS_CODEX_CWD_ROOT"])
    if not cwd_root.is_absolute():
        raise ValueError("NEXUS_CODEX_CWD_ROOT must be absolute")
    for directory in (account / "home", account / "tmp", cwd_root):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    cwd = cwd_root / "host"
    cwd.mkdir(mode=0o500, exist_ok=True)

    socket: Path | None = None
    token: SecretStr | None = None
    if control.scheme == "unix":
        socket = Path(unquote(control.path))
        if (
            not socket.is_absolute()
            or control.netloc
            or control.query
            or control.fragment
            or native_url is not None
            or verifier is not None
        ):
            raise ValueError("unix host requires only an absolute control socket")
        socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        socket.unlink(missing_ok=True)
    elif control.scheme == "http":
        if (
            not control.hostname
            or control.port is None
            or control.path
            or control.query
            or control.fragment
            or control.username
            or control.password
            or verifier is None
            or re.fullmatch(r"[0-9a-f]{64}", verifier) is None
            or native_url is None
        ):
            raise ValueError(
                "network host requires control/native listeners and a bootstrap verifier"
            )
        native = urlsplit(native_url)
        if (
            native.scheme != "ws"
            or not native.hostname
            or native.port is None
            or native.path
            or native.query
            or native.fragment
            or native.username
            or native.password
        ):
            raise ValueError("native listener must be ws://host:port on the private network")
        token = SecretStr(secrets.token_urlsafe(32))
    else:
        raise ValueError("host control must listen on unix or private http")

    state = advance(account)
    target = CodexHostTarget(host_id=state.host_id, incarnation=state.incarnation)
    if socket is not None:
        native_socket = socket.with_name(f"native-{target.host_id}-{target.incarnation}.sock")
        endpoint = CodexUnixEndpoint(native_socket)
        transport = CodexHostUnixTransport(socket_name=native_socket.name)
        listener = native_socket.as_uri().replace("file:", "unix:", 1)
        auth: tuple[str, ...] = ()
    else:
        assert token is not None and native_url is not None
        endpoint = CodexWebSocketEndpoint(native_url, token)
        transport = CodexHostWebSocketTransport(token=token)
        listener = native_url
        auth = (
            "--ws-auth",
            "capability-token",
            "--ws-token-sha256",
            hashlib.sha256(token.get_secret_value().encode()).hexdigest(),
        )
    active = CodexHostActive(
        target=target, transport=transport, retirement_allowed=scope == "dedicated"
    )
    stopped = asyncio.Event()
    start_or_retire = asyncio.Lock()
    retiring = False
    qualified = False
    qualification_error: CodexHostUnavailableReason | None = None
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.post("/{operation}")
    async def control_request(operation: str, request: Request) -> JSONResponse:
        nonlocal retiring, qualification
        if verifier is not None:
            supplied = request.headers.get("authorization", "")
            if not supplied.startswith("Bearer ") or not hmac.compare_digest(
                hashlib.sha256(supplied[7:].encode()).hexdigest(), verifier
            ):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            data = await request.body()
            if operation == "resolve":
                requested = CodexHostResolveRequest.model_validate_json(data).target
            elif operation == "retire":
                requested = CodexHostRetireRequest.model_validate_json(data).target
            else:
                return JSONResponse({"detail": "unknown operation"}, status_code=404)
        except ValidationError:
            return JSONResponse(
                CodexHostUnavailable(reason="protocol_mismatch").model_dump(mode="json"),
                status_code=400,
            )
        if operation == "retire" and scope != "dedicated":
            result = CodexHostUnavailable(reason="retirement_disabled")
        elif requested is not None and requested.host_id != target.host_id:
            result = CodexHostUnavailable(reason="unknown_host")
        elif requested is not None and requested.incarnation > target.incarnation:
            result = CodexHostUnavailable(reason="unknown_incarnation")
        elif requested is not None and requested.incarnation < target.incarnation:
            result = CodexHostRetired(target=requested)
        elif operation == "retire":
            async with start_or_retire:
                retiring = True
                stopped.set()
            result = CodexHostUnavailable(reason="retiring")
        elif retiring or stopped.is_set():
            result = CodexHostUnavailable(reason="retiring")
        elif qualification_error is not None:
            result = CodexHostUnavailable(reason=qualification_error)
        elif not qualified:
            if qualification is not None and qualification.done():
                qualification = asyncio.create_task(qualify())
            result = CodexHostUnavailable(reason="starting")
        else:
            result = active
        return JSONResponse(result.model_dump(mode="json"))

    server = _ControlServer(
        uvicorn.Config(
            app,
            uds=str(socket) if socket is not None else None,
            host=control.hostname or "127.0.0.1",
            port=control.port or 0,
            access_log=False,
            log_level="warning",
            timeout_graceful_shutdown=2,
        )
    )
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stopped.set)
    control_task = asyncio.create_task(server.serve())
    process: asyncio.subprocess.Process | None = None
    waiter: asyncio.Task[int] | None = None
    qualification: asyncio.Task[None] | None = None
    stop_waiter = asyncio.create_task(stopped.wait())
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if control_task.done():
                    await control_task
                    raise RuntimeError("native control listener failed to start")
                await asyncio.sleep(0.01)
        if socket is not None:
            socket.chmod(0o600)
        if stopped.is_set():
            raise SystemExit(1 if retiring else 0)
        try:
            if stat.S_IMODE(credential.stat().st_mode) != 0o600:
                raise ValueError("native account credential must be mode 0600")
        except (OSError, ValueError) as error:
            qualification_error = "invalid_state"
            logger.error("native credential unavailable: %s", type(error).__name__)
            await asyncio.wait({stop_waiter, control_task}, return_when=asyncio.FIRST_COMPLETED)
            raise SystemExit(1 if retiring or not stopped.is_set() else 0) from None
        catalog = materialize_codex_containment_catalog(account)
        with os.fdopen(
            os.open(
                account / "native-stderr.log",
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o600,
            ),
            "wb",
        ) as diagnostic:
            async with start_or_retire:
                if stopped.is_set():
                    raise SystemExit(1 if retiring else 0)
                process = await asyncio.create_subprocess_exec(
                    *codex_command(),
                    "-c",
                    f"model_catalog_json={json.dumps(str(catalog))}",
                    *native_settings,
                    "app-server",
                    "--listen",
                    listener,
                    *auth,
                    "--strict-config",
                    cwd=cwd,
                    start_new_session=True,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=diagnostic,
                    env={
                        "CODEX_HOME": str(account),
                        "CODEX_EXEC_SERVER_URL": "none",
                        "HOME": str(account / "home"),
                        "TMPDIR": str(account / "tmp"),
                        "LANG": "C.UTF-8",
                        "LC_ALL": "C.UTF-8",
                        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                        **native_environment,
                    },
                )
        waiter = asyncio.create_task(process.wait())

        async def qualify() -> None:
            nonlocal qualified, qualification_error
            last_error = "unavailable"
            try:
                async with asyncio.timeout(15):
                    while not stopped.is_set():
                        try:
                            await qualify_codex_containment_host(endpoint)
                            qualified = not stopped.is_set()
                            return
                        except (
                            CredentialRejected,
                            CredentialUnavailable,
                            InvalidAgentRequest,
                            UnsupportedCapability,
                        ):
                            raise
                        except AgentRuntimeError as error:
                            last_error = type(error).__name__
                            await asyncio.sleep(0.2)
            except (AgentRuntimeDefect, UnsupportedCapability) as error:
                qualification_error = "protocol_mismatch"
                logger.error("native qualification rejected: %s", type(error).__name__)
            except (CredentialRejected, CredentialUnavailable, InvalidAgentRequest) as error:
                qualification_error = "invalid_state"
                logger.error("native qualification unavailable: %s", type(error).__name__)
            except TimeoutError:
                logger.warning(
                    "native qualification timed out: %s; resolution may retry", last_error
                )

        qualification = asyncio.create_task(qualify())
        await asyncio.wait({waiter, stop_waiter, control_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        retiring = retiring or not stopped.is_set()
        if qualification is not None:
            qualification.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await qualification
        if process is not None and waiter is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(asyncio.shield(waiter), 30)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                await waiter
        stop_waiter.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stop_waiter
        server.should_exit = True
        await control_task
    if retiring or not stopped.is_set():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
