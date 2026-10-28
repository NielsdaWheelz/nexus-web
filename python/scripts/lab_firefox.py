"""stock firefox for disposable labs, quiet unless the caller has desktop approval.

the caller owns the state directory and removes it only after this context exits
successfully. reopening it preserves application data. browser processes remain
in the outer lab driver's process group; no personal profile or trust is changed.
"""

from __future__ import annotations

import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

_JSON = TypeAdapter(JsonValue)
_STARTUP_SECONDS = 20
_STOP_SECONDS = 10
_POLL_SECONDS = 0.1


class WebDriverError(RuntimeError):
    """protocol failure; messages and bodies may contain scenario credentials."""

    def __init__(self, code: str, message: JsonValue = None) -> None:
        super().__init__(f"native firefox webdriver error: {code}")
        self.code = code
        self.closed_session = code == "invalid session id" or (
            code == "unknown error" and message == "Failed to decode response from marionette"
        )


def _request(
    client: httpx.Client,
    method: str,
    path: str,
    body: JsonValue = None,
    *,
    timeout_seconds: float = 60,
) -> JsonValue:
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("webdriver transport timeout must be finite and positive")
    response = client.request(method, path, json=body, timeout=timeout_seconds)
    try:
        envelope = _JSON.validate_json(response.content)
    except ValidationError:
        raise RuntimeError("native firefox returned invalid webdriver json") from None
    if not isinstance(envelope, dict) or "value" not in envelope:
        raise RuntimeError("native firefox returned no webdriver value")
    value = envelope["value"]
    if response.is_error:
        if isinstance(value, dict):
            code = value.get("error")
            if isinstance(code, str):
                raise WebDriverError(code, value.get("message"))
        raise RuntimeError(f"native firefox webdriver http status {response.status_code}")
    return value


@dataclass
class NativeFirefox:
    _client: httpx.Client
    _session_id: str
    process_id: int

    def command(
        self,
        method: str,
        session_path: str,
        body: JsonValue = None,
        *,
        timeout_seconds: float = 60,
    ) -> JsonValue:
        """run a session-relative command; script deadlines are configured separately."""
        return _request(
            self._client,
            method,
            f"/session/{self._session_id}{session_path}",
            body,
            timeout_seconds=timeout_seconds,
        )


def _processes() -> dict[int, tuple[int, str]]:
    result = subprocess.run(
        ["ps", "-A", "-o", "pid=,ppid=,stat="],
        check=True,
        capture_output=True,
        text=True,
        timeout=_STOP_SECONDS,
    )
    return {
        int(pid): (int(parent), state)
        for pid, parent, state in (line.split() for line in result.stdout.splitlines())
    }


def _wait_exited(pids: set[int], seconds: float) -> set[int]:
    # justify-polling: non-child firefox pids have no portable wait handle. probe
    # exact owned pids every 100ms, bounded here; zombies have already exited.
    deadline = time.monotonic() + seconds
    while pids:
        processes = _processes()
        pids = {pid for pid in pids if pid in processes and not processes[pid][1].startswith("Z")}
        if not pids or time.monotonic() >= deadline:
            return pids
        time.sleep(_POLL_SECONDS)
    return pids


def _close(driver: subprocess.Popen[bytes], browser: NativeFirefox | None) -> None:
    try:
        # session startup may fail after spawning firefox but before returning its
        # pid. capture only descendants of this still-owned geckodriver, before DELETE.
        processes = _processes()
        owned = {driver.pid}
        while (
            children := {pid for pid, (parent, _) in processes.items() if parent in owned} - owned
        ):
            owned.update(children)
        owned.remove(driver.pid)
        if browser is not None:
            owned.add(browser.process_id)
        failure: Exception | None = None
        if browser is not None:
            try:
                browser.command("DELETE", "", timeout_seconds=_STOP_SECONDS)
            except WebDriverError as error:
                if not error.closed_session or _wait_exited({browser.process_id}, _STOP_SECONDS):
                    failure = error
                # justify-ignore-error: these exact closed-session errors are
                # expected after an intentional crash, and exit was observed.
            except Exception as error:
                failure = error
        remaining = _wait_exited(owned, _STOP_SECONDS)
        for signum in (signal.SIGTERM, signal.SIGKILL):
            for pid in remaining:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    # justify-ignore-error: the exact owned pid exited between observations.
                    pass
            remaining = _wait_exited(remaining, _STOP_SECONDS)
            if not remaining:
                break
        if remaining:
            raise RuntimeError(f"owned native firefox processes remain: {sorted(remaining)}")
        if failure is not None:
            raise failure
    finally:
        if driver.poll() is None:
            driver.terminate()
        try:
            driver.wait(timeout=_STOP_SECONDS)
        except subprocess.TimeoutExpired:
            driver.kill()
            driver.wait(timeout=_STOP_SECONDS)


@contextmanager
def open_native_firefox(
    *,
    web_origin: str,
    ca_file: Path,
    state_dir: Path,
    log_file: Path,
    headless: bool = True,
    page_load_strategy: Literal["normal", "eager"] = "normal",
) -> Iterator[NativeFirefox]:
    """open before application navigation; headless=False requires caller approval."""
    firefox = shutil.which("firefox")
    if firefox is None and sys.platform == "darwin":
        candidate = Path("/Applications/Firefox.app/Contents/MacOS/firefox")
        if candidate.is_file():
            firefox = str(candidate)
    geckodriver, certutil = shutil.which("geckodriver"), shutil.which("certutil")
    if firefox is None or geckodriver is None or certutil is None:
        raise RuntimeError("native firefox requires installed firefox, geckodriver and certutil")
    state_dir = state_dir.resolve()
    profile = state_dir / "profile"
    profile.mkdir(parents=True, mode=0o700, exist_ok=True)
    app_data = state_dir / "app-data"
    app_data.mkdir(mode=0o700, exist_ok=True)
    environment = dict(os.environ)
    if sys.platform == "darwin":
        for directory in (
            "Library/Application Support",
            "Library/Caches",
            "Downloads",
            "Documents",
        ):
            (app_data / directory).mkdir(parents=True, exist_ok=True)
        environment["CFFIXED_USER_HOME"] = str(app_data)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "ab") as log:
        os.fchmod(log.fileno(), 0o600)
        database = f"sql:{profile}"

        def certificate(*arguments: str) -> str:
            return subprocess.run(
                [certutil, "-d", database, *arguments],
                check=True,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
                timeout=_STOP_SECONDS,
            ).stdout

        if not (profile / "cert9.db").exists():
            certificate("-N", "--empty-password")
        if any(line.startswith("nexus-lab-ca ") for line in certificate("-L").splitlines()):
            certificate("-D", "-n", "nexus-lab-ca")
        certificate("-A", "-n", "nexus-lab-ca", "-t", "C,,", "-i", str(ca_file))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
            driver = subprocess.Popen(
                [
                    geckodriver,
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--allow-system-access",
                    "--log",
                    "error",
                ],
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            browser = None
            try:
                # justify-polling: geckodriver exposes readiness only over HTTP.
                # retry connection refusal every 100ms for at most 20 seconds.
                deadline = time.monotonic() + _STARTUP_SECONDS
                while True:
                    if driver.poll() is not None:
                        raise RuntimeError("native firefox geckodriver exited before readiness")
                    try:
                        _request(client, "GET", "/status", timeout_seconds=1)
                        break
                    except httpx.ConnectError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError(
                                "native firefox geckodriver readiness timed out"
                            ) from None
                        time.sleep(_POLL_SECONDS)
                firefox_options: dict[str, JsonValue] = {
                    "binary": firefox,
                    "args": [*(["-headless"] if headless else []), "-profile", str(profile)],
                    "prefs": {"network.disable-localhost-when-offline": True},
                }
                requested: dict[str, JsonValue] = {
                    "browserName": "firefox",
                    "acceptInsecureCerts": False,
                    "pageLoadStrategy": page_load_strategy,
                    "moz:firefoxOptions": firefox_options,
                }
                requested_capabilities: dict[str, JsonValue] = {"alwaysMatch": requested}
                options: dict[str, JsonValue] = {"capabilities": requested_capabilities}
                result = _request(client, "POST", "/session", options)
                if not isinstance(result, dict):
                    raise RuntimeError("native firefox returned no session object")
                session_id = result.get("sessionId")
                if not isinstance(session_id, str):
                    raise RuntimeError("native firefox returned no session id")
                capabilities = result.get("capabilities")
                if not isinstance(capabilities, dict):
                    raise RuntimeError("native firefox returned no capabilities")
                process_id = capabilities.get("moz:processID")
                if not isinstance(process_id, int):
                    raise RuntimeError("native firefox returned no browser process id")
                browser = NativeFirefox(client, session_id, process_id)
                browser.command("POST", "/moz/context", {"context": "chrome"})
                granted = browser.command(
                    "POST",
                    "/execute/sync",
                    {
                        "script": 'const p=Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arguments[0]),{}); Services.perms.addFromPrincipal(p,"persistent-storage",Services.perms.ALLOW_ACTION); return Services.perms.testPermissionFromPrincipal(p,"persistent-storage")===Services.perms.ALLOW_ACTION;',
                        "args": [web_origin],
                    },
                )
                if granted is not True:
                    raise RuntimeError("native firefox persistence permission was not granted")
                browser.command("POST", "/moz/context", {"context": "content"})
                yield browser
            finally:
                original_error = sys.exception()
                try:
                    _close(driver, browser)
                except Exception as cleanup_error:
                    if original_error is not None:
                        raise BaseExceptionGroup(
                            "native firefox operation and cleanup failed",
                            [original_error, cleanup_error],
                        ) from None
                    raise
