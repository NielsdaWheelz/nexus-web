"""Local authenticated Android WebView visual check (opt-in physical-device lane).

Thin orchestration adapter over the existing test-control primitives plus the
auth-session broker. The broker gives the device the same one-time
``/auth/handoff`` the production flow uses; it never weakens a browser security
boundary and never persists a secret.

Fail-closed classification:

- a missing device, Android SDK, local stack, or local secret is ``NOT_RUN``;
- a guardrail violation (``main``, a SHA other than ``HEAD``, an invalid path,
  an unsupported worktree state) is ``FAIL``;
- a proven account-identity mismatch or an unconsumed/mis-origin handoff is
  ``FAIL``;
- a captured authenticated screen at the requested path is ``PASS``.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import subprocess
import time
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx
import psycopg

from nexus_test_control.build import ensure_standalone_build
from nexus_test_control.evidence import redact_json, redact_text, write_evidence_json
from nexus_test_control.memory import available_memory_mib
from nexus_test_control.model import RunStatus
from nexus_test_control.process import run_command
from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    canonical_repo_root,
    read_runtime,
    runtime_endpoint,
    runtime_state_dir,
    workspace_heavy_lock,
)
from nexus_test_control.services import (
    SupabaseCredentials,
    TestRun,
    android_tool_environment,
    authorized_device_serials,
    clean_run,
    ensure_services,
    prepare_run,
    resolve_adb,
    run_environment,
    start_python_process,
    start_web_process,
    wait_process_ready,
)

MANIFEST_VERSION = 1
DEVICE_ALIASES = frozenset({"primary"})
DEBUG_PACKAGE = "app.nexus.android.debug"
MAIN_ACTIVITY = "app.nexus.android.MainActivity"
OWNED_HOST = "127.0.0.1"
DEVICE_WEB_ORIGIN = f"http://{OWNED_HOST}:3000"
DEVICE_STREAM_ORIGIN = f"http://{OWNED_HOST}:8000"
DEVICE_TCP_WEB = 3000
DEVICE_TCP_STREAM = 8000
# The handoff flow establishes the WebView session; the debug build only needs a
# well-formed client id to compile. This is the same synthetic value the other
# local Android lanes use, never a real Google credential.
GOOGLE_WEB_CLIENT_ID = "nexus-test.apps.googleusercontent.com"
APK_RELATIVE = "apps/android/app/build/outputs/apk/debug/app-debug.apk"
_ACCOUNT_NAMESPACE = uuid5(NAMESPACE_URL, "https://nexus.test/android-visual")
_HANDOFF_CONSUME_TIMEOUT_SECONDS = 60.0
_HANDOFF_POLL_SECONDS = 0.5
_SESSION_TIMEOUT_SECONDS = 30.0
_SESSION_POLL_SECONDS = 1.0
_SETTLE_SECONDS = 2.0
_MIN_AVAILABLE_MIB = 2048
_LOGCAT_TAIL_LINES = 2000
_OWNED_PATH = re.compile(r"/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*\Z")
_ANDROID_FINGERPRINT_SKIP = frozenset({"build", ".gradle", ".idea", ".cxx"})
_GIT_OPERATION_MARKERS = ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")


class _NotRun(Exception):
    """A required local prerequisite is absent; the lane cannot run."""


class _Fail(Exception):
    """A guardrail or proven invariant was violated; the lane fails closed."""


@dataclass(frozen=True, slots=True)
class AndroidVisualOutcome:
    status: RunStatus
    detail: str
    artifacts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DeviceSession:
    """The device account's live session, held only in controller memory."""

    alias: str
    user_id: UUID
    email: str
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    code: str = field(repr=False)
    verifier: str = field(repr=False)

    @property
    def code_hash(self) -> str:
        return hashlib.sha256(self.code.encode("utf-8")).hexdigest()

    def secrets(self) -> tuple[str, ...]:
        return (self.access_token, self.refresh_token, self.code, self.verifier)


# --- Pure helpers (independently testable) ----------------------------------


def device_account_email(alias: str) -> str:
    """Deterministic, stable, test-namespace account email for a device alias."""
    if alias not in DEVICE_ALIASES:
        raise ValueError(f"unknown device alias: {alias}")
    return f"nexus+android-visual+{alias}@example.invalid"


def device_account_id(alias: str) -> UUID:
    """Deterministic, stable Supabase user id for a device alias."""
    if alias not in DEVICE_ALIASES:
        raise ValueError(f"unknown device alias: {alias}")
    return uuid5(_ACCOUNT_NAMESPACE, alias)


def validate_owned_path(path: str) -> str:
    """Accept only an owned same-origin absolute path (no scheme/host/query/..)."""
    if (
        not path
        or not path.startswith("/")
        or path.startswith("//")
        or "?" in path
        or "#" in path
        or "\\" in path
        or "'" in path
        or _OWNED_PATH.fullmatch(path) is None
        or ".." in PurePosixPath(path).parts
    ):
        raise ValueError(f"path must be an owned same-origin path: {path!r}")
    return path


def handoff_challenge(verifier: str) -> str:
    """The mint challenge is the lowercase sha256 hex of the raw verifier."""
    return hashlib.sha256(verifier.encode("utf-8")).hexdigest()


def handoff_launch_uri(device_origin: str, code: str, verifier: str) -> str:
    """Build the exact ``/auth/handoff`` URI the device opens (secret until used)."""
    return f"{device_origin}/auth/handoff?code={quote(code, safe='')}&hv={quote(verifier, safe='')}"


def mint_handoff_request(
    api_base_url: str,
    internal_secret: str,
    access_token: str,
    refresh_token: str,
    verifier: str,
) -> tuple[str, dict[str, str], dict[str, str]]:
    """Compose the POST ``/auth/handoff-codes`` call the existing API expects."""
    url = f"{api_base_url}/auth/handoff-codes"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "X-Nexus-Internal": internal_secret,
        "X-Request-ID": uuid5(_ACCOUNT_NAMESPACE, f"request:{verifier}").hex,
        "Content-Type": "application/json",
    }
    body = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "challenge": handoff_challenge(verifier),
    }
    return url, headers, body


def device_session_established(pages: object, device_origin: str) -> bool:
    """Whether a WebView DevTools ``/json`` listing shows the device's page on the
    owned origin and NOT bounced to the login surface — positive evidence the
    device holds the authenticated session (a signed-out device lands on
    ``/login``; a wrong build lands on a foreign origin)."""
    if not isinstance(pages, Sequence) or isinstance(pages, str):
        return False
    for page in pages:
        if not isinstance(page, Mapping) or page.get("type") != "page":
            continue
        url = page.get("url")
        if not isinstance(url, str):
            continue
        parts = urlsplit(url)
        if f"{parts.scheme}://{parts.netloc}" != device_origin:
            continue
        if not parts.path.startswith("/login") and not parts.path.startswith("/auth/"):
            return True
    return False


def native_input_fingerprint(repo_root: Path, flags: Mapping[str, str]) -> str:
    """Fingerprint the debug APK's native inputs plus its compiled-in flags."""
    android_root = repo_root / "apps/android"
    digest = hashlib.sha256(b"nexus-android-debug-apk-v1\0")
    for relative, contents in _android_sources(android_root, repo_root):
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(contents)
        digest.update(b"\0")
    for key, value in sorted(flags.items()):
        digest.update(key.encode())
        digest.update(b"\0")
        digest.update(value.encode())
        digest.update(b"\0")
    return digest.hexdigest()


def _android_sources(android_root: Path, repo_root: Path) -> tuple[tuple[str, bytes], ...]:
    found: list[tuple[str, bytes]] = []
    for path in sorted(android_root.rglob("*")):
        if any(part in _ANDROID_FINGERPRINT_SKIP for part in path.relative_to(android_root).parts):
            continue
        if not path.is_file() or path.is_symlink() or path.suffix == ".apk":
            continue
        found.append((path.relative_to(repo_root).as_posix(), path.read_bytes()))
    return tuple(found)


def worktree_source(repo_root: Path) -> dict[str, object]:
    """Record the exact branch/HEAD/dirty/diff identity of the current worktree."""
    for marker in _GIT_OPERATION_MARKERS:
        candidate = Path(_git(repo_root, "rev-parse", "--git-path", marker))
        if not candidate.is_absolute():
            candidate = repo_root / candidate
        if candidate.exists():
            raise _Fail("android-visual refuses a worktree with a git operation in progress")
    branch = _git(repo_root, "rev-parse", "--abbrev-ref", "HEAD")
    head_sha = _git(repo_root, "rev-parse", "HEAD")
    status = _git(repo_root, "status", "--porcelain=v1", "--untracked-files=all")
    dirty = bool(status.strip())
    diff_sha256: str | None = None
    if dirty:
        diff = _git(repo_root, "diff", "HEAD")
        diff_sha256 = hashlib.sha256(f"{status}\0{diff}".encode()).hexdigest()
    return {"branch": branch, "head_sha": head_sha, "dirty": dirty, "diff_sha256": diff_sha256}


# --- Auth-session broker ----------------------------------------------------


def ensure_device_account(supabase: SupabaseCredentials, alias: str) -> tuple[UUID, str, str, str]:
    """Create-or-reset the stable device account and sign it in.

    Returns ``(user_id, email, access_token, refresh_token)``; the reset password
    and the tokens are held only in controller memory.
    """
    user_id = device_account_id(alias)
    email = device_account_email(alias)
    password = f"{secrets.token_urlsafe(24)}Aa1!"
    admin_headers = {
        "Authorization": f"Bearer {supabase.admin_key}",
        "apikey": supabase.admin_key,
    }
    try:
        with httpx.Client(trust_env=False, timeout=15) as client:
            existing = client.get(
                f"{supabase.url}/auth/v1/admin/users/{user_id}", headers=admin_headers
            )
            if existing.status_code == 404:
                created = client.post(
                    f"{supabase.url}/auth/v1/admin/users",
                    headers=admin_headers,
                    json={
                        "id": str(user_id),
                        "email": email,
                        "password": password,
                        "email_confirm": True,
                    },
                )
                created.raise_for_status()
            else:
                existing.raise_for_status()
                if existing.json().get("email") != email:
                    raise _Fail("device account identity does not match its stable alias")
                client.put(
                    f"{supabase.url}/auth/v1/admin/users/{user_id}",
                    headers=admin_headers,
                    json={"password": password},
                ).raise_for_status()
            token = client.post(
                f"{supabase.url}/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": supabase.anon_key, "Content-Type": "application/json"},
                json={"email": email, "password": password},
            )
            token.raise_for_status()
            session = token.json()
    except httpx.HTTPError as error:
        raise _NotRun(f"local Supabase auth is unavailable: {error}") from error
    access_token = session.get("access_token")
    refresh_token = session.get("refresh_token")
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        raise _NotRun("local Supabase auth returned no device session")
    return user_id, email, access_token, refresh_token


def issue_handoff(
    api_base_url: str, internal_secret: str, access_token: str, refresh_token: str
) -> tuple[str, str]:
    """Mint one short-lived handoff code; return ``(code, verifier)``.

    The verifier is never sent at mint; only its ``sha256`` challenge is. Callers
    must open the launch URI immediately: the code lives for 90 seconds and is
    single-use.
    """
    verifier = secrets.token_urlsafe(32)
    url, headers, body = mint_handoff_request(
        api_base_url, internal_secret, access_token, refresh_token, verifier
    )
    try:
        with httpx.Client(trust_env=False, timeout=15) as client:
            response = client.post(url, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as error:
        raise _NotRun(f"handoff-code mint failed: {error}") from error
    code = payload.get("data", {}).get("code") if isinstance(payload, Mapping) else None
    if not isinstance(code, str) or not code:
        raise _NotRun("handoff-code mint returned no code")
    return code, verifier


# --- ADB transport ----------------------------------------------------------


def _android_sdk_available(repo_root: Path, environment: Mapping[str, str]) -> bool:
    if (repo_root / "apps/android/local.properties").is_file():
        return True
    return any(
        environment.get(key) and Path(environment[key]).is_dir()
        for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT")
    )


def _adb(
    adb: Path,
    serial: str,
    *args: str,
    environment: Mapping[str, str],
    cwd: Path,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return run_command(
        (str(adb), "-s", serial, *args),
        cwd=cwd,
        env=android_tool_environment(environment),
        capture_output=True,
        check=check,
    )


def resolve_serial(adb: Path, alias: str, environment: Mapping[str, str], cwd: Path) -> str:
    """Resolve the device alias to one authorized serial, else fail closed."""
    authorized = authorized_device_serials(adb, environment, cwd)
    if authorized is None:
        raise _NotRun("Android device inventory could not be read")
    configured = environment.get("NEXUS_DEVICE_SERIAL")
    if configured:
        if configured not in authorized:
            raise _NotRun(f"configured device {alias!r} is not attached and authorized")
        return configured
    if len(authorized) != 1:
        raise _NotRun(
            f"device {alias!r} requires exactly one authorized device or NEXUS_DEVICE_SERIAL"
        )
    return authorized[0]


# --- Orchestration ----------------------------------------------------------


def run_android_visual(
    repo_root: Path, environment: Mapping[str, str], *, run_id: str
) -> AndroidVisualOutcome:
    try:
        root = canonical_repo_root(repo_root)
        if environment.get("NEXUS_ENV") not in (None, "", "test"):
            raise _NotRun("android-visual runs only against the local test environment")
        environment = {**environment, "NEXUS_ENV": "test"}
        requested_sha = environment.get("NEXUS_ANDROID_VISUAL_SHA", "")
        requested_path = environment.get("NEXUS_ANDROID_VISUAL_PATH", "")
        alias = environment.get("NEXUS_ANDROID_VISUAL_DEVICE", "")
        _validate_request(root, requested_sha, requested_path, alias)
        source = worktree_source(root)
        adb = resolve_adb(environment)
        if adb is None:
            raise _NotRun("the Android SDK platform-tools adb is absent")
        serial = resolve_serial(adb, alias, environment, root)
        try:
            with workspace_heavy_lock(root, blocking=False):
                return _run_locked(
                    root,
                    environment,
                    run_id=run_id,
                    requested_path=requested_path,
                    alias=alias,
                    source=source,
                    adb=adb,
                    serial=serial,
                )
        except BlockingIOError:
            return AndroidVisualOutcome(
                RunStatus.NOT_RUN, "another heavy or visual run holds the workspace lock"
            )
    except _NotRun as reason:
        return AndroidVisualOutcome(RunStatus.NOT_RUN, str(reason))
    except _Fail as reason:
        return AndroidVisualOutcome(RunStatus.FAIL, str(reason))
    except RuntimeContractError as error:
        return AndroidVisualOutcome(
            RunStatus.NOT_RUN, f"local test runtime is unavailable: {error}"
        )


def _validate_request(repo_root: Path, requested_sha: str, requested_path: str, alias: str) -> None:
    if alias not in DEVICE_ALIASES:
        raise _Fail(f"unknown device alias: {alias!r}")
    if not requested_sha or not requested_path:
        raise _Fail("android-visual requires --sha and --path")
    try:
        validate_owned_path(requested_path)
    except ValueError as error:
        raise _Fail(str(error)) from error
    if requested_sha != _git(repo_root, "rev-parse", "HEAD"):
        raise _Fail("--sha must equal the worktree HEAD")
    if _git(repo_root, "rev-parse", "--abbrev-ref", "HEAD") == "main":
        raise _Fail("android-visual refuses the main branch")


def _run_locked(
    root: Path,
    environment: Mapping[str, str],
    *,
    run_id: str,
    requested_path: str,
    alias: str,
    source: dict[str, object],
    adb: Path,
    serial: str,
) -> AndroidVisualOutcome:
    try:
        supabase = ensure_services(root, environment)
        run = prepare_run(root, environment, run_id=run_id)
    except (RuntimeContractError, OSError, subprocess.CalledProcessError) as error:
        return AndroidVisualOutcome(RunStatus.NOT_RUN, f"local test stack is unavailable: {error}")
    try:
        with ExitStack() as stack:
            stack.callback(lambda: clean_run(root, environment, run_id, supabase=supabase))
            return _visual_run(
                root,
                environment,
                run=run,
                supabase=supabase,
                requested_path=requested_path,
                alias=alias,
                source=source,
                adb=adb,
                serial=serial,
                stack=stack,
            )
    except _NotRun as reason:
        return AndroidVisualOutcome(RunStatus.NOT_RUN, str(reason))
    except _Fail as reason:
        return AndroidVisualOutcome(RunStatus.FAIL, str(reason))


def _visual_run(
    root: Path,
    environment: Mapping[str, str],
    *,
    run: TestRun,
    supabase: SupabaseCredentials,
    requested_path: str,
    alias: str,
    source: dict[str, object],
    adb: Path,
    serial: str,
    stack: ExitStack,
) -> AndroidVisualOutcome:
    available = available_memory_mib()
    if available is None or available < _MIN_AVAILABLE_MIB:
        raise _NotRun(
            f"heavy build admission requires {_MIN_AVAILABLE_MIB} MiB available; "
            f"observed {available if available is not None else 'unknown'}"
        )
    runtime = read_runtime(root)
    device_overrides = {
        "APP_PUBLIC_URL": DEVICE_WEB_ORIGIN,
        "STREAM_BASE_URL": DEVICE_STREAM_ORIGIN,
        "STREAM_CORS_ORIGINS": f"{DEVICE_WEB_ORIGIN},http://localhost:3000",
    }
    build = ensure_standalone_build(root, environment, supabase.anon_key)
    api = start_python_process(root, environment, run, "api", overrides=device_overrides)
    wait_process_ready(root, environment, api, EndpointKind.API, "/health")
    web = start_web_process(root, environment, run, build, overrides=device_overrides)
    wait_process_ready(root, environment, web, EndpointKind.WEB, "/")

    reverse = {DEVICE_TCP_WEB: runtime.ports.web, DEVICE_TCP_STREAM: runtime.ports.api}
    stack.callback(lambda: _remove_reverse(adb, serial, reverse, environment, root))
    for device_port, host_port in reverse.items():
        _adb(
            adb,
            serial,
            "reverse",
            f"tcp:{device_port}",
            f"tcp:{host_port}",
            environment=environment,
            cwd=root,
        )
    listed = _adb(adb, serial, "reverse", "--list", environment=environment, cwd=root).stdout
    if any(f"tcp:{port}" not in listed for port in reverse):
        raise _Fail("adb reverse mappings were not established")

    flags = {
        "nexusAndroidDebugBaseUrl": DEVICE_WEB_ORIGIN,
        "nexusAndroidDebugOwnedHost": OWNED_HOST,
        "nexusGoogleWebClientId": environment.get(
            "NEXUS_GOOGLE_WEB_CLIENT_ID", GOOGLE_WEB_CLIENT_ID
        ),
    }
    apk = _ensure_debug_apk(root, environment, adb, serial, flags)

    user_id, email, access_token, refresh_token = ensure_device_account(supabase, alias)
    api_base = runtime_endpoint(root, environment, EndpointKind.API)
    internal_secret = run_environment(root, environment, run)["NEXUS_INTERNAL_SECRET"]
    code, verifier = issue_handoff(api_base, internal_secret, access_token, refresh_token)
    session = DeviceSession(alias, user_id, email, access_token, refresh_token, code, verifier)
    _launch(adb, serial, handoff_launch_uri(DEVICE_WEB_ORIGIN, code, verifier), environment, root)
    _await_handoff_consumed(run, session.code_hash)

    _launch(adb, serial, f"{DEVICE_WEB_ORIGIN}{requested_path}", environment, root)
    _prove_device_session(adb, serial, environment, root)
    if _git(root, "rev-parse", "HEAD") != source["head_sha"]:
        raise _Fail("the worktree HEAD changed during the run")
    _foreground_for_capture(adb, serial, requested_path, environment, root)
    time.sleep(_SETTLE_SECONDS)
    screenshot, logcat = _capture(root, environment, run.run_id, adb, serial, session.secrets())

    manifest_path = _write_manifest(
        root,
        run.run_id,
        source=source,
        device=_device_facts(adb, serial, environment, root),
        serial=serial,
        reverse=reverse,
        runtime_ports={
            "web": runtime.ports.web,
            "api": runtime.ports.api,
            "supabase": runtime.ports.supabase_api,
        },
        api_log=api.log_path,
        web_log=web.log_path,
        apk=apk,
        session=session,
        requested_path=requested_path,
        screenshot=screenshot,
        logcat=logcat,
    )
    return AndroidVisualOutcome(
        RunStatus.PASS,
        f"authenticated {alias} device reached {requested_path}",
        (manifest_path, screenshot, logcat),
    )


def _ensure_debug_apk(
    root: Path,
    environment: Mapping[str, str],
    adb: Path,
    serial: str,
    flags: Mapping[str, str],
) -> dict[str, object]:
    apk = root / APK_RELATIVE
    fingerprint = native_input_fingerprint(root, flags)
    state_path = runtime_state_dir(root) / "android-visual" / "apk.json"
    state = _read_apk_state(state_path)
    built = False
    if not apk.is_file() or state.get("fingerprint") != fingerprint:
        if not _android_sdk_available(root, environment):
            raise _NotRun("the Android SDK is required to build the debug APK for the local origin")
        _assemble_debug_apk(root, environment, flags)
        built = True
    if not apk.is_file():
        raise _NotRun("debug APK was not produced")
    installed = _installed_fingerprints(state)
    if (
        built
        or installed.get(serial) != fingerprint
        or not _package_installed(adb, serial, environment, root)
    ):
        _adb(adb, serial, "install", "-r", str(apk), environment=environment, cwd=root)
        installed[serial] = fingerprint
    _write_apk_state(state_path, fingerprint, installed)
    return {
        "variant": "debug",
        "input_fingerprint": fingerprint,
        "installed_fingerprint": installed[serial],
    }


def _assemble_debug_apk(
    root: Path, environment: Mapping[str, str], flags: Mapping[str, str]
) -> None:
    android_root = root / "apps/android"
    if not (android_root / "gradlew").is_file():
        raise _NotRun("the Android Gradle wrapper is absent")
    command = (
        "./gradlew",
        "--no-daemon",
        ":app:assembleDebug",
        *(f"-P{key}={value}" for key, value in sorted(flags.items())),
    )
    result = run_command(
        command,
        cwd=android_root,
        env=android_tool_environment(environment),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise _Fail("debug APK assembly failed")


def _package_installed(adb: Path, serial: str, environment: Mapping[str, str], cwd: Path) -> bool:
    result = _adb(
        adb,
        serial,
        "shell",
        "pm",
        "path",
        DEBUG_PACKAGE,
        environment=environment,
        cwd=cwd,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip().startswith("package:")


def _launch(adb: Path, serial: str, uri: str, environment: Mapping[str, str], cwd: Path) -> None:
    # The handoff URI carries the one-use code and verifier. Run with check=False
    # and never surface the command or its output on failure, so a nonzero
    # `am start` cannot leak the secret through an exception argv or a summary.
    if "'" in uri:
        raise _Fail("the launch URI must not contain a single quote")
    result = _adb(
        adb,
        serial,
        "shell",
        f"am start -a android.intent.action.VIEW -n {DEBUG_PACKAGE}/{MAIN_ACTIVITY} -d '{uri}'",
        environment=environment,
        cwd=cwd,
        check=False,
    )
    if result.returncode != 0 or "Error:" in result.stdout or "Error:" in (result.stderr or ""):
        raise _Fail("the device could not open the launched URL")


def _foreground_for_capture(
    adb: Path, serial: str, requested_path: str, environment: Mapping[str, str], cwd: Path
) -> None:
    """Wake the screen, bring the app forward at the requested path, and dismiss
    the notification shade so the screenshot shows the app, not the device UI."""
    _adb(
        adb,
        serial,
        "shell",
        "input",
        "keyevent",
        "KEYCODE_WAKEUP",
        environment=environment,
        cwd=cwd,
        check=False,
    )
    _launch(adb, serial, f"{DEVICE_WEB_ORIGIN}{requested_path}", environment, cwd)
    _adb(
        adb,
        serial,
        "shell",
        "cmd",
        "statusbar",
        "collapse",
        environment=environment,
        cwd=cwd,
        check=False,
    )


def _await_handoff_consumed(run: TestRun, code_hash: str) -> None:
    dsn = run.database_url.replace("postgresql+psycopg://", "postgresql://")
    deadline = time.monotonic() + _HANDOFF_CONSUME_TIMEOUT_SECONDS
    with psycopg.connect(dsn, autocommit=True) as connection:
        while time.monotonic() < deadline:
            row = connection.execute(
                "SELECT 1 FROM auth_handoff_codes WHERE code_hash = %s LIMIT 1", (code_hash,)
            ).fetchone()
            if row is None:
                return
            time.sleep(_HANDOFF_POLL_SECONDS)
    raise _Fail("the device did not consume the one-time handoff before it expired")


def _webview_devtools_sockets(
    adb: Path, serial: str, environment: Mapping[str, str], cwd: Path
) -> tuple[str, ...]:
    result = _adb(
        adb, serial, "shell", "cat", "/proc/net/unix", environment=environment, cwd=cwd, check=False
    )
    if result.returncode != 0:
        return ()
    return tuple(sorted(set(re.findall(r"webview_devtools_remote_\d+", result.stdout))))


def _prove_device_session(
    adb: Path, serial: str, environment: Mapping[str, str], cwd: Path
) -> None:
    """Prove the device's own WebView holds the session, over the WebView DevTools
    transport — the controller's minted token cannot stand in for the device."""
    deadline = time.monotonic() + _SESSION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        for socket_name in _webview_devtools_sockets(adb, serial, environment, cwd):
            forwarded = _adb(
                adb,
                serial,
                "forward",
                "tcp:0",
                f"localabstract:{socket_name}",
                environment=environment,
                cwd=cwd,
                check=False,
            )
            if forwarded.returncode != 0 or not forwarded.stdout.strip().isdigit():
                continue
            port = forwarded.stdout.strip()
            try:
                with httpx.Client(trust_env=False, timeout=5) as client:
                    pages = client.get(f"http://127.0.0.1:{port}/json").json()
                if device_session_established(pages, DEVICE_WEB_ORIGIN):
                    return
            except (httpx.HTTPError, ValueError):
                pass
            finally:
                _adb(
                    adb,
                    serial,
                    "forward",
                    "--remove",
                    f"tcp:{port}",
                    environment=environment,
                    cwd=cwd,
                    check=False,
                )
        time.sleep(_SESSION_POLL_SECONDS)
    raise _Fail(
        "the device WebView is not authenticated on the owned origin (session not established)"
    )


def _capture(
    root: Path,
    environment: Mapping[str, str],
    run_id: str,
    adb: Path,
    serial: str,
    secret_values: Sequence[str],
) -> tuple[str, str]:
    results = root / "test-results/runs" / run_id
    results.mkdir(parents=True, exist_ok=True)
    device_png = f"/data/local/tmp/nexus-visual-{run_id}.png"
    screenshot = results / "android-visual-screen.png"
    _adb(adb, serial, "shell", "screencap", "-p", device_png, environment=environment, cwd=root)
    _adb(adb, serial, "pull", device_png, str(screenshot), environment=environment, cwd=root)
    _adb(
        adb, serial, "shell", "rm", "-f", device_png, environment=environment, cwd=root, check=False
    )
    if not screenshot.is_file() or screenshot.stat().st_size == 0:
        raise _Fail("the device screenshot could not be captured")
    log = _adb(
        adb,
        serial,
        "logcat",
        "-d",
        "-t",
        str(_LOGCAT_TAIL_LINES),
        environment=environment,
        cwd=root,
        check=False,
    )
    logcat = results / "android-visual-logcat.txt"
    logcat.write_text(redact_text(log.stdout, secret_values), encoding="utf-8")
    return screenshot.relative_to(root).as_posix(), logcat.relative_to(root).as_posix()


def _device_facts(
    adb: Path, serial: str, environment: Mapping[str, str], cwd: Path
) -> dict[str, str]:
    return {
        "api_level": _getprop(adb, serial, "ro.build.version.sdk", environment, cwd),
        "webview_version": _webview_version(adb, serial, environment, cwd),
        "package": DEBUG_PACKAGE,
    }


def _getprop(adb: Path, serial: str, prop: str, environment: Mapping[str, str], cwd: Path) -> str:
    result = _adb(
        adb, serial, "shell", "getprop", prop, environment=environment, cwd=cwd, check=False
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _webview_version(adb: Path, serial: str, environment: Mapping[str, str], cwd: Path) -> str:
    result = _adb(
        adb,
        serial,
        "shell",
        "dumpsys",
        "webviewupdate",
        environment=environment,
        cwd=cwd,
        check=False,
    )
    if result.returncode != 0:
        return "unknown"
    match = re.search(
        r"Current WebView package \(name, version\): \([^,]+, ([^)]+)\)", result.stdout
    )
    return match.group(1) if match else "unknown"


def _write_manifest(
    root: Path,
    run_id: str,
    *,
    source: Mapping[str, object],
    device: Mapping[str, str],
    serial: str,
    reverse: Mapping[int, int],
    runtime_ports: Mapping[str, int],
    api_log: str,
    web_log: str,
    apk: Mapping[str, object],
    session: DeviceSession,
    requested_path: str,
    screenshot: str,
    logcat: str,
) -> str:
    manifest = {
        "schema_version": MANIFEST_VERSION,
        "run_id": run_id,
        "source": dict(source),
        "device": {"alias": session.alias, "serial": serial, **device},
        "transport": {
            "device_web_origin": DEVICE_WEB_ORIGIN,
            "device_stream_origin": DEVICE_STREAM_ORIGIN,
            "reverse_mappings": {f"tcp:{d}": f"tcp:{h}" for d, h in reverse.items()},
            "host_ports": dict(runtime_ports),
        },
        "processes": {
            "web": {"ownership": "run", "host_port": runtime_ports["web"], "log_path": web_log},
            "api": {"ownership": "run", "host_port": runtime_ports["api"], "log_path": api_log},
            "supabase": {"ownership": "shared", "host_port": runtime_ports["supabase"]},
        },
        "apk": dict(apk),
        "auth": {
            "account_alias": session.alias,
            "user_id": str(session.user_id),
            "handoff_consumed": True,
            "session_origin": DEVICE_WEB_ORIGIN,
        },
        "visual": {
            "requested_path": requested_path,
            "screenshot_paths": [screenshot],
            "logcat_path": logcat,
        },
        "result": {"status": RunStatus.PASS.value, "reason": "authenticated screen captured"},
    }
    relative = Path("test-results/runs") / run_id / "android-visual.json"
    redacted = redact_json(manifest, session.secrets())
    assert isinstance(redacted, dict)
    write_evidence_json(root / relative, redacted)
    return relative.as_posix()


def _remove_reverse(
    adb: Path, serial: str, reverse: Mapping[int, int], environment: Mapping[str, str], cwd: Path
) -> None:
    for device_port in reverse:
        _adb(
            adb,
            serial,
            "reverse",
            "--remove",
            f"tcp:{device_port}",
            environment=environment,
            cwd=cwd,
            check=False,
        )


def _read_apk_state(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _installed_fingerprints(state: Mapping[str, object]) -> dict[str, str]:
    installed = state.get("installed")
    if not isinstance(installed, dict):
        return {}
    return {key: value for key, value in installed.items() if isinstance(value, str)}


def _write_apk_state(path: Path, fingerprint: str, installed: Mapping[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"fingerprint": fingerprint, "installed": dict(installed)}, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


def _git(repo_root: Path, *args: str) -> str:
    try:
        return subprocess.run(
            ("git", *args),
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise _Fail(f"git {args[0]} failed for the worktree") from error
