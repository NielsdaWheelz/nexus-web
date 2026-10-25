"""One foreground disposable application, with exact resource ownership.

The driver runs only after real browser bootstrap. Clean web source reuses one
completed production package per checkout when SHA, host slot and persisted
publishable key match. Dirty web source always builds without publishing a cache
marker. Each run copies the writable standalone tree and shares only immutable
dependencies and assets; Next caches never survive into another runtime.
Build constants match the server's public key, origin and source SHA; each
server receives a fresh closed runtime environment.
Only explicit live credentials reach api/workers. Creates are not retried: a
failed attempt owns its unique namespaces through finally cleanup. Recovery
metadata never authorizes killing a saved pid. Caller files are never removed.
Host admission reads capacity.json once from the existing host state directory;
its sole max_parallel_labs integer defaults to six when the file is absent.
Ordinary runs hold one persistent flock slot through teardown; client throttling
takes all configured slots in ascending order. Waiters release partial locks and
report observed diagnostic run ids for at most 1800 seconds; only the kernel owns
slot release, never a saved pid. Capacity changes require drained labs and waiters.

Use a dedicated checkout with no root/web dotenv files, concurrent next/static
checks or application edits. Context is published only after /me bootstrap. Its
absolute paths name private browser state, admin key and artifacts; its closed
snake_case fields are run_id, worktree, web_origin, api_origin, auth_origin,
auth_anon_key, auth_admin_key_file, database_url, storage (origin, bucket, region,
access_key_id, secret_access_key), wire_revision, seed (user_id,
default_library_id, email, password), browser_state_file, artifacts_dir,
web_tls (ca_file and leaf_spki_sha256) and
fake_providers (null, or origin and ca_file for the explicit fake transport).
client_cpu_throttle is null normally, or the requested integer slowdown rate.
NEXUS_LAB_CONTEXT is the driver's only extra environment variable. Live JSON
accepts only LIVE_KEYS, string values or null, including supported provider
HTTPS origins and additional PEM trust roots; core service topology stays owned.
Explicit live Codex attachment holds shared access to one enrolled compatible host
through teardown. The API reads its host websocket; both Linux workers use its
private client network and separate per-run cwd root. No account state enters a lab.
Fake mode owns verified HTTPS Responses SSE/WebSocket and embedding wires plus
separate real pinned Codex hosts for the host API and Linux workers. Replies
prove transport, never model quality, tools or structured generation. The short
private host socket directory is recovery-recorded and removed after host drain.

Driver exit passes through; usage is 2, setup/runtime failure 125, interruption
130/143. Cleanup failure turns success into 125. Private logs remain; secrets
and session files are deleted only after verified owned namespace cleanup.
An incomplete cleanup retains recovery inputs. The checkout lock is released last;
a stale lock after hard kill requires manual recovery, never a saved-pid killer.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import tomllib
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import Any, BinaryIO, TextIO
from urllib.error import URLError
from urllib.request import Request, urlopen

from worker_checkout_image import image_tag

ROOT = Path(__file__).resolve().parents[2]
HOST_SLOT_WAIT_SECONDS = 1800
LIVE_KEYS = frozenset(
    "openai_api_key generation_api_providers openai_generation_api_key "
    "anthropic_generation_api_key gemini_generation_api_key deepseek_generation_api_key "
    "xai_generation_api_key brave_search_api_key youtube_data_api_key x_api_bearer_token "
    "deepgram_api_key podcast_index_api_key podcast_index_api_secret".split()
) | {"provider_endpoint_overrides", "provider_ca_pem"}


def message(value: str) -> None:
    print(f"lab: {value}", file=sys.stderr, flush=True)


def private_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def _complete_web_build(web: Path) -> str | None:
    """Return the packaged build identity, never typegen's partial .next tree."""
    standalone = web / ".next/standalone"
    try:
        build_id = (web / ".next/BUILD_ID").read_text().strip()
        packaged_id = (standalone / ".next/BUILD_ID").read_text().strip()
        files = json.loads((standalone / ".next/required-server-files.json").read_text())["files"]
        if (
            build_id
            and build_id == packaged_id
            and all((standalone / name).is_file() for name in files)
            and all(
                (standalone / name).is_file()
                for name in (
                    "serve.mjs",
                    "probe-web.mjs",
                    "package.json",
                    "node_modules/next/package.json",
                )
            )
            and (standalone / "public").is_dir()
            and (standalone / ".next/static").is_dir()
        ):
            return build_id
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def _stage_web_runtime(standalone: Path, destination: Path) -> None:
    """Copy writable Next output; link only immutable dependencies/public/chunks."""
    destination.mkdir()
    entries: list[tuple[Path, Path]] = []
    for source in standalone.iterdir():
        target = destination / source.name
        if source.name == ".next":
            target.mkdir()
            entries.extend(
                (child, target / child.name) for child in source.iterdir() if child.name != "cache"
            )
        else:
            entries.append((source, target))
    immutable = {standalone / name for name in ("node_modules", "public", ".next/static")}
    for source, target in entries:
        if source in immutable:
            target.symlink_to(source, target_is_directory=True)
        elif source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)


def clean_environment() -> dict[str, str]:
    return {
        key: value
        for key, value in os.environ.items()
        if key
        in {"PATH", "HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM"}
        or key.startswith("LC_")
    }


def live_configuration(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.keys() - LIVE_KEYS:
        raise ValueError("live config must be an object containing only documented keys")
    if any(
        item is not None and (not isinstance(item, str) or not item.strip())
        for item in value.values()
    ):
        raise ValueError("live config values must be nonempty strings or null")
    return {key.upper(): item for key, item in value.items() if item is not None}


def set_config(text: str, section: str, key: str, value: object) -> str:
    """Replace a known canonical TOML field, preserving its policy and templates."""
    pattern = rf"(?ms)(^\[{re.escape(section)}\]\n)(.*?)(?=^\[|\Z)"
    match = re.search(pattern, text)
    if match is None:
        raise RuntimeError(f"canonical auth config missing section {section}")
    body = match[2]
    field = rf"(?m)^{re.escape(key)}\s*=\s*(?:\[[\s\S]*?\]|[^\n]*)"
    assignment = f"{key} = {json.dumps(value)}"
    body = (
        re.sub(field, lambda _: assignment, body)
        if re.search(field, body)
        else body + assignment + "\n"
    )
    return text[: match.start(2)] + body + text[match.end(2) :]


def _write_tls(directory: Path, name: str, dns_names: tuple[str, ...]) -> tuple[str, str]:
    """Fresh root and loopback leaf; return the root PEM and exact leaf SPKI pin."""
    import datetime
    import ipaddress

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    directory.mkdir(mode=0o755)
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name + " root")])
    now = datetime.datetime.now(datetime.UTC)
    root = (
        x509.CertificateBuilder()
        .subject_name(root_name)
        .issuer_name(root_name)
        .public_key(root_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(root_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
        .issuer_name(root.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
                + [x509.DNSName(host) for host in dns_names]
            ),
            critical=False,
        )
        .sign(root_key, hashes.SHA256())
    )
    pem = root.public_bytes(serialization.Encoding.PEM).decode()
    (directory / "ca.pem").write_text(pem)
    (directory / "cert.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    (directory / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    # The 0700 inputs parent protects the key; provider containers get a read-only bind.
    directory.chmod(0o755)
    for path in directory.iterdir():
        path.chmod(0o644)
    spki = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return pem, base64.b64encode(hashlib.sha256(spki).digest()).decode()


def http_json(
    url: str,
    *,
    body: object = None,
    headers: dict[str, str] | None = None,
    context: ssl.SSLContext | None = None,
) -> Any:
    data = None if body is None else json.dumps(body).encode()
    request = Request(
        url, data=data, headers={"Content-Type": "application/json"} | (headers or {})
    )
    with urlopen(request, timeout=5, context=context) as response:
        return json.load(response)


def signal_group(process: subprocess.Popen[bytes], signum: int) -> bool:
    """Reap the leader and keep probing when Darwin cannot yet prove group absence."""
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        return False
    except PermissionError:
        process.poll()
        if signum == 0:
            # An existence probe cannot prove absence while Darwin is retiring the group.
            return True
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            return False
    return True


def stop_group(
    process: subprocess.Popen[bytes], timeout: float, *, already_signalled: bool = False
) -> None:
    # The group may outlive its leader (next and a driver can launch children).
    if not already_signalled and not signal_group(process, signal.SIGTERM):
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        process.poll()
        if not signal_group(process, 0):
            return
        time.sleep(0.1)
    signal_group(process, signal.SIGKILL)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        process.poll()
        if not signal_group(process, 0):
            return
        time.sleep(0.05)
    raise RuntimeError("owned process group remains after kill")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="fresh real nexus application; owned resources removed after the driver exits",
        epilog="prerequisites: docker compose, supabase 2.117.0, node, bun, uv, locked python/web dependencies, "
        "playwright chromium. "
        "use a dedicated checkout without root/web dotenv files; do not edit app source or run next/static checks during a run. "
        "host capacity: ${XDG_STATE_HOME:-~/.local/state}/nexus-lab/capacity.json; "
        'optional {"max_parallel_labs": 6}; absent means six lab slots. '
        "example: ./scripts/lab -- node apps/web/node_modules/@playwright/test/cli.js test "
        "--config apps/web/scripts/lab/playwright.config.ts",
    )
    parser.add_argument(
        "--live-config",
        type=Path,
        help="explicit json provider credentials; allowed keys: "
        + ", ".join(sorted(LIVE_KEYS))
        + "; nonempty string or null; never inherits ambient credentials",
    )
    parser.add_argument(
        "--live-codex",
        action="store_true",
        help="use the shared live codex host. starts the enrolled compatible host if stopped. "
        "concurrent labs keep separate sessions. enroll with ./scripts/lab-codex enroll.",
    )
    parser.add_argument(
        "--fake-providers",
        action="store_true",
        help="fresh verified HTTPS provider wires and real owned Codex hosts; no live credentials",
    )
    parser.add_argument(
        "--client-throttle",
        type=int,
        help="integer client CPU slowdown >= 1; holds all configured lab slots exclusively",
    )
    parser.add_argument(
        "driver",
        nargs=argparse.REMAINDER,
        help="-- command [arg ...]; argv is executed directly from the checkout root",
    )
    args = parser.parse_args()
    if not args.driver or args.driver[0] != "--" or len(args.driver) < 2 or not args.driver[1]:
        parser.error("a nonempty driver command after -- is required")
    if args.client_throttle is not None and args.client_throttle < 1:
        parser.error("--client-throttle requires an integer >= 1")
    if args.fake_providers and (args.live_config is not None or args.live_codex):
        parser.error("--fake-providers cannot be combined with --live-config or --live-codex")
    worker_services = ["worker-interactive", "worker-background"]
    try:
        live = live_configuration(args.live_config)
    except (OSError, ValueError) as exc:
        message(
            f"input rejected: {type(exc).__name__}; check --live-config format and documented keys"
        )
        return 2

    os.umask(0o077)
    base_env = clean_environment()
    # Settings must not read ambient provider values during its own preflight.
    os.environ.clear()
    os.environ.update(base_env)
    sys.path[:0] = [str(ROOT / "python"), str(ROOT)]
    processes: dict[str, subprocess.Popen[bytes]] = {}
    launches: list[dict[str, object]] = []
    container_ids: list[str] = []
    phase = "preflight"
    interrupted = 0
    registering = False
    driver_signalled = False
    result = 125
    lock_owned = False
    slot_files: list[TextIO] = []
    resources_owned = False
    run_id = ""
    project = ""
    auth_project = ""
    run_dir: Path | None = None
    host_codex_dir: Path | None = None
    shared_access = ExitStack()
    shared_host = None
    shared_cwd_prepared = False
    compose: list[str] = []
    cli: list[str] = []
    auth_cleanup: list[str] = []
    compose_env = base_env.copy()
    auth_env = base_env.copy()
    lock = ROOT / ".nexus-local/lab.lock"

    def interrupt(signum: int, _frame: object) -> None:
        nonlocal interrupted, driver_signalled
        if interrupted:
            return
        interrupted = signum
        driver = processes.get("driver")
        if driver is not None:
            driver_signalled = signal_group(driver, interrupted)
        if not registering:
            raise KeyboardInterrupt

    def launch(
        name: str,
        argv: list[str],
        env: dict[str, str],
        cwd: Path,
        stdout: int | BinaryIO | None,
        stderr: int | None,
    ) -> subprocess.Popen[bytes]:
        # Defer raising until the new group is registered, without blocking child signals.
        nonlocal registering, driver_signalled
        registering = True
        try:
            process = subprocess.Popen(
                argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True
            )
            processes[name] = process
            if name != "command":
                assert run_dir is not None
                record: dict[str, object] = {"name": name, "pgid": process.pid, "cwd": str(cwd)}
                if name != "driver":
                    record["argv"] = argv
                launches.append(record)
                private_json(run_dir / "launches.json", launches)
        finally:
            registering = False
            if interrupted and phase != "cleanup":
                driver = processes.get("driver")
                if driver is not None and not driver_signalled:
                    driver_signalled = signal_group(driver, interrupted)
                raise KeyboardInterrupt
        return process

    def command(
        argv: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: Path = ROOT,
        timeout: float = 120,
        log: Path | None = None,
    ) -> str:
        try:
            process = launch(
                "command", argv, env or base_env, cwd, subprocess.PIPE, subprocess.PIPE
            )
            output, errors = process.communicate(timeout=timeout)
        except BaseException:
            process = processes.get("command")
            if process is not None:
                if phase == "cleanup":
                    signal_group(process, signal.SIGKILL)
                    process.wait(timeout=0.1)
                else:
                    stop_group(process, min(10, timeout))
            raise
        finally:
            processes.pop("command", None)
        if log is not None:
            log.write_bytes(output + errors)
        if process.returncode and argv[0] == "supabase" and run_dir is not None:
            diagnostic = errors.decode(errors="replace")
            for value in auth_env.values():
                if value not in base_env.values():
                    diagnostic = diagnostic.replace(value, "[redacted]")
            diagnostic = re.sub(
                r"(?m)^.*(?:sb_secret_|sb_publishable_|eyJ|(?i:password|jwt.secret|credential)).*$",
                "[credential-bearing diagnostic omitted]",
                diagnostic,
            )
            (run_dir / "auth-errors.log").open("a").write(diagnostic)
        if process.returncode:
            raise RuntimeError(
                f"{Path(argv[0]).name} failed ({process.returncode}); {log or 'private output discarded'}"
            )
        return output.decode()

    def start(
        name: str, argv: list[str], env: dict[str, str], cwd: Path
    ) -> subprocess.Popen[bytes]:
        assert run_dir is not None
        with (run_dir / f"{name}.log").open("wb") as stream:
            return launch(name, argv, env, cwd, stream, subprocess.STDOUT)

    def alive() -> None:
        for name, process in processes.items():
            if name != "driver" and process.poll() is not None:
                raise RuntimeError(f"owned {name} process exited ({process.returncode})")
        if container_ids:
            running = command(
                ["docker", "inspect", "--format", "{{.State.Running}}", *container_ids], timeout=10
            )
            if any(line != "true" for line in running.splitlines()):
                raise RuntimeError("owned service container exited")

    def ready(name: str, check: Callable[[], bool]) -> None:
        message(f"{name}: waiting for owned service identity and health")
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            alive()
            try:
                if check():
                    message(f"{name}: ready")
                    return
            except (URLError, TimeoutError, OSError, ValueError):
                pass
            time.sleep(0.5)
        raise RuntimeError(f"{name} readiness deadline exceeded")

    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        for directory in (ROOT, ROOT / "apps/web"):
            if any(
                (directory / name).is_file()
                for name in (
                    ".env",
                    ".env.local",
                    ".env.development",
                    ".env.development.local",
                    ".env.production",
                    ".env.production.local",
                )
            ):
                raise RuntimeError(f"dotenv files forbidden in {directory}")
        for executable in ("docker", "supabase", "node", "bun", "uv", "git"):
            if shutil.which(executable) is None:
                raise RuntimeError(f"{executable} is required")
        if command(["supabase", "--version"]).strip() != "2.117.0":
            raise RuntimeError("supabase cli must be exactly 2.117.0")
        command(["docker", "compose", "version"])
        command(["docker", "info"], timeout=20)
        phase = "preflight locked python dependencies"
        command(
            [
                "uv",
                "sync",
                "--check",
                "--frozen",
                "--offline",
                "--extra",
                "dev",
                "--extra",
                "codex-agent",
            ],
            cwd=ROOT / "python",
        )
        phase = "preflight installed web dependencies and chromium"
        command(
            [
                "node",
                "--input-type=module",
                "-e",
                "import fs from 'node:fs';import{chromium}from'@playwright/test';"
                "for(const p of ['next','@playwright/test']){const want=JSON.parse(fs.readFileSync('package.json'));"
                "const actual=JSON.parse(fs.readFileSync('node_modules/'+p+'/package.json'));"
                "if((want.dependencies[p]??want.devDependencies[p])!==actual.version)throw Error('installed package mismatch '+p)}"
                "if(!fs.existsSync(chromium.executablePath()))throw Error('install playwright chromium explicitly')",
            ],
            cwd=ROOT / "apps/web",
        )
        phase = "preflight live settings"
        from pydantic import ValidationError

        from nexus.api.edge import WIRE_REVISION
        from nexus.config import Settings
        from nexus.release_artifact import load_runtime_identity, write_runtime_identity

        try:
            Settings(
                _env_file=None,  # pyright: ignore[reportCallIssue] - BaseSettings supports disabling dotenv.
                database_url="postgresql+psycopg://postgres:postgres@127.0.0.1/postgres",
                supabase_jwks_url="http://127.0.0.1/auth/v1/.well-known/jwks.json",
                supabase_issuer="http://127.0.0.1/auth/v1",
                supabase_audiences="authenticated",
                **{key.lower(): value for key, value in live.items()},
            )
        except ValidationError as exc:
            raise RuntimeError(
                "live settings rejected; check generation providers and matching keys"
            ) from exc
        phase = "ownership"
        run_id = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(6)
        project = f"nexus-lab-{run_id}"
        # The pinned cli truncates project ids at 37 characters; preserve this id exactly.
        auth_project = f"lab-auth-{run_id.rsplit('-', 1)[1]}"
        run_dir = ROOT / ".nexus-local/lab" / run_id
        lock.parent.mkdir(exist_ok=True, mode=0o700)
        registering = True
        try:
            try:
                descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError as exc:
                raise RuntimeError(
                    f"checkout locked; inspect {lock} and recover before manually removing it"
                ) from exc
            lock_owned = True
            with os.fdopen(descriptor, "w") as stream:
                json.dump(
                    {
                        "run_id": run_id,
                        "owner_pid": os.getpid(),
                        "run_dir": str(run_dir),
                        "recovery": str(run_dir / "recovery.txt"),
                    },
                    stream,
                )
        finally:
            registering = False
            if interrupted:
                raise KeyboardInterrupt
        run_dir.mkdir(parents=True, mode=0o700)
        inputs = run_dir / "inputs"
        inputs.mkdir(mode=0o700)
        artifacts = run_dir / "artifacts"
        artifacts.mkdir(mode=0o700)
        phase = "host admission"
        state_home = Path(base_env.get("XDG_STATE_HOME") or Path.home() / ".local/state")
        if not state_home.is_absolute():
            raise ValueError("XDG_STATE_HOME must be absolute")
        slot_dir = state_home / "nexus-lab/slots"
        capacity_path = slot_dir.parent / "capacity.json"
        capacity_error = (
            f'{capacity_path}: expected {{"max_parallel_labs": n}} with integer n >= 1 '
            "(excluding booleans) and 31000 + 10*n - 1 <= 65535"
        )
        try:
            capacity = json.loads(capacity_path.read_text())
        except FileNotFoundError:
            capacity = {"max_parallel_labs": 6}
        except (OSError, ValueError) as exc:
            raise ValueError(capacity_error) from exc
        if (
            not isinstance(capacity, dict)
            or capacity.keys() != {"max_parallel_labs"}
            or type(capacity["max_parallel_labs"]) is not int
            or capacity["max_parallel_labs"] < 1
            or 31000 + 10 * capacity["max_parallel_labs"] - 1 > 65535
        ):
            raise ValueError(capacity_error)
        max_parallel_labs = capacity["max_parallel_labs"]
        slot_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for number in range(1, max_parallel_labs + 1):
            slot_files.append((slot_dir / f"slot-{number}").open("a+"))
        deadline = time.monotonic() + HOST_SLOT_WAIT_SECONDS
        previous_holders = None
        exclusive = args.client_throttle is not None
        required_slots = max_parallel_labs if exclusive else 1
        requested_slots = (
            f"all {max_parallel_labs} lab slots"
            if exclusive
            else f"one of {max_parallel_labs} lab slots"
        )
        while True:
            holders: list[str] = []
            acquired: list[tuple[int, TextIO]] = []
            for number, slot_file in enumerate(slot_files, 1):
                try:
                    fcntl.flock(slot_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    slot_file.seek(0)
                    holders.append(
                        f"slot-{number}={slot_file.read().strip() or 'acquiring holder'}"
                    )
                    if exclusive:
                        break
                    continue
                acquired.append((number, slot_file))
                if len(acquired) == required_slots:
                    break
            if len(acquired) == required_slots:
                host_slot = acquired[0][0]
                for _, slot_file in acquired:
                    slot_file.seek(0)
                    slot_file.truncate()
                    slot_file.write(run_id + "\n")
                    slot_file.flush()
                message(
                    f"acquired all {max_parallel_labs} lab slots for run {run_id}"
                    if exclusive
                    else f"acquired lab slot {host_slot} of {max_parallel_labs} for run {run_id}"
                )
                break
            for _, slot_file in acquired:
                fcntl.flock(slot_file, fcntl.LOCK_UN)
            current_holders = ", ".join(holders)
            if current_holders != previous_holders:
                message(
                    f"waiting for {requested_slots}; observed holders: {current_holders}; "
                    f"limit {HOST_SLOT_WAIT_SECONDS}s"
                )
                previous_holders = current_holders
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"wait for {requested_slots} exceeded {HOST_SLOT_WAIT_SECONDS}s; "
                    f"observed holders: {current_holders}"
                )
            time.sleep(0.2)
        if args.live_codex:
            phase = "shared live codex host"
            from lab_codex import attach

            shared_host = shared_access.enter_context(attach())
        sockets: list[socket.socket] = []
        try:
            for offset in range(10):
                port = 31000 + (host_slot - 1) * 10 + offset
                try:
                    try:
                        probe = socket.create_connection(("127.0.0.1", port), timeout=0.2)
                    except ConnectionRefusedError:
                        pass
                    else:
                        probe.close()
                        raise OSError("port already has a listener")
                    listener = socket.create_server(("127.0.0.1", port))
                except OSError as exc:
                    raise RuntimeError(
                        f"lab slot {host_slot} port {port} unavailable; inspect the port owner"
                    ) from exc
                sockets.append(listener)
            (
                db_port,
                storage_port,
                api_port,
                web_port,
                auth_port,
                auth_db_port,
                shadow_port,
                mail_port,
                smtp_port,
                pop3_port,
            ) = [s.getsockname()[1] for s in sockets]
        finally:
            for listener in sockets:
                listener.close()
        web_origin = f"https://127.0.0.1:{web_port}"
        api_origin = f"http://127.0.0.1:{api_port}"
        auth_origin = f"http://127.0.0.1:{auth_port}"
        storage_origin = f"http://127.0.0.1:{storage_port}"
        web_tls_dir = inputs / "web-tls"
        _, web_leaf_pin = _write_tls(web_tls_dir, "nexus lab web", ("localhost",))
        web_tls = {
            "ca_file": str(web_tls_dir / "ca.pem"),
            "leaf_spki_sha256": web_leaf_pin,
        }
        db_password = secrets.token_hex(24)
        database_url = f"postgresql+psycopg://postgres:{db_password}@127.0.0.1:{db_port}/postgres"
        source_sha = command(["git", "rev-parse", "HEAD"]).strip()
        identity_path = inputs / "runtime-identity.json"
        write_runtime_identity(ROOT, source_sha, identity_path)
        identity_path.chmod(0o644)  # nonsecret; the linux worker reads this bind as uid 10001.
        identity = load_runtime_identity(identity_path).as_json()
        publishable_path = ROOT / ".nexus-local/publishable-key"
        if not publishable_path.exists():
            temporary = publishable_path.with_suffix(".partial")
            temporary.write_text("sb_publishable_" + secrets.token_hex(24) + "\n")
            temporary.chmod(0o600)
            temporary.replace(publishable_path)
        publishable_key = publishable_path.read_text().strip()
        app_env = base_env | {
            "PYTHONPATH": f"{ROOT / 'python'}:{ROOT}",
            "NEXUS_ENV": "local",
            "DATABASE_URL": database_url,
            "SUPABASE_JWKS_URL": f"{auth_origin}/auth/v1/.well-known/jwks.json",
            "SUPABASE_ISSUER": f"{auth_origin}/auth/v1",
            "SUPABASE_AUDIENCES": "authenticated",
            "APP_PUBLIC_URL": web_origin,
            "R2_S3_API_ORIGIN": storage_origin,
            "R2_ACCESS_KEY_ID": secrets.token_hex(16),
            "R2_SECRET_ACCESS_KEY": secrets.token_hex(32),
            "R2_BUCKET": "media",
            "R2_REGION": "us-east-1",
            "NEXUS_HANDLE_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
            "NEXUS_INTERNAL_SECRET": secrets.token_hex(32),
            "NEXUS_RUNTIME_IDENTITY_FILE": str(identity_path),
            "NEXUS_CODEX_ENDPOINT": (inputs / "no-native-socket")
            .as_uri()
            .replace("file:", "unix:", 1),
        }
        if shared_host is not None:
            app_env |= shared_host.host_environment
        fake_providers: dict[str, str] | None = None
        fake_tls = inputs / "fake-tls"
        fake_ca_pem: str | None = None
        if args.fake_providers:
            fake_ca_pem, _ = _write_tls(fake_tls, "nexus lab fake providers", ("fake-providers",))
            # Darwin's Unix socket limit cannot fit the checkout's private-input path.
            host_codex_dir = Path(tempfile.mkdtemp(prefix="nexus-lab-codex-", dir="/tmp"))
            app_env |= {
                "OPENAI_API_KEY": "lab-fake-" + secrets.token_hex(24),
                "OPENAI_GENERATION_API_KEY": "lab-fake-" + secrets.token_hex(24),
                "GENERATION_API_PROVIDERS": "openai",
                "PROVIDER_CA_PEM": fake_ca_pem,
                "NEXUS_CODEX_ENDPOINT": (host_codex_dir / "app-server.sock")
                .as_uri()
                .replace("file:", "unix:", 1),
                "NEXUS_CODEX_CWD_ROOT": str(host_codex_dir / "cwds"),
            }
        compose_env = (
            app_env
            | live
            | {
                "COMPOSE_PROJECT_NAME": project,
                "POSTGRES_PASSWORD": db_password,
                "POSTGRES_PORT": str(db_port),
                "LOCAL_S3_PORT": str(storage_port),
                "WORKER_DATABASE_URL": f"postgresql+psycopg://postgres:{db_password}@postgres:5432/postgres",
                "WORKER_R2_S3_API_ORIGIN": "http://storage:8333",
                "NEXUS_LOCAL_RUNTIME_IDENTITY_FILE": str(identity_path),
                "NEXUS_LOCAL_WORKER_IMAGE": image_tag(),
                "COMPOSE_FILE": os.pathsep.join(
                    str(ROOT / "docker" / name)
                    for name in (
                        "docker-compose.yml",
                        "docker-compose.worker.yml",
                        "docker-compose.lab.yml",
                    )
                ),
                "COMPOSE_ENV_FILES": os.devnull,
            }
        )
        compose = [
            "docker",
            "compose",
            "--project-name",
            project,
            "--env-file",
            os.devnull,
        ]
        if args.fake_providers:
            compose_env |= {
                "NEXUS_LAB_FAKE_TLS_DIR": str(fake_tls),
                "COMPOSE_FILE": compose_env["COMPOSE_FILE"]
                + os.pathsep
                + str(ROOT / "docker/docker-compose.lab-fakes.yml"),
            }
        if shared_host is not None:
            worker_environment = shared_host.worker_environment(run_id)
            compose_env |= {
                "NEXUS_LAB_CODEX_ENDPOINT": worker_environment["NEXUS_CODEX_ENDPOINT"],
                "NEXUS_LAB_CODEX_TRANSPORT_TOKEN": worker_environment[
                    "NEXUS_CODEX_TRANSPORT_TOKEN"
                ],
                "NEXUS_LAB_CODEX_CWD_ROOT": worker_environment["NEXUS_CODEX_CWD_ROOT"],
                "COMPOSE_FILE": compose_env["COMPOSE_FILE"]
                + os.pathsep
                + str(ROOT / "docker/docker-compose.lab-live.yml"),
            }
        auth_env = base_env | {
            "SUPABASE_AUTH_JWT_SECRET": secrets.token_hex(32),
            "SUPABASE_AUTH_PUBLISHABLE_KEY": publishable_key,
            "SUPABASE_AUTH_SECRET_KEY": "sb_secret_" + secrets.token_hex(24),
        }
        auth_root = inputs / "auth"
        (auth_root / "supabase").mkdir(parents=True)
        shutil.copytree(ROOT / "supabase/templates", auth_root / "supabase/templates")
        cli = ["supabase", "--workdir", str(auth_root)]
        auth_cleanup = [
            sys.executable,
            str(ROOT / "python/scripts/lab_auth_cleanup.py"),
            auth_project,
        ]
        recovery = {
            "compose_env": compose_env,
            "auth_env": base_env,
            "host_codex_dir": str(host_codex_dir) if host_codex_dir is not None else None,
            "shared_codex_cwd": compose_env.get("NEXUS_LAB_CODEX_CWD_ROOT"),
            "shared_codex_image": None if shared_host is None else shared_host.image_id,
            "shared_codex_run_id": run_id if shared_host is not None else None,
            "commands": [
                auth_cleanup,
                compose
                + ["down", "--volumes", "--remove-orphans", "--rmi", "local", "--timeout", "30"],
            ],
        }
        private_json(inputs / "recovery.json", recovery)
        recover_code = "import json,subprocess,sys;r=json.load(open(sys.argv[1]));codes=[subprocess.run(c,env=r[e]).returncode for c,e in zip(r['commands'],['auth_env','compose_env'])];sys.exit(any(codes))"
        recovery_command = shlex.join(
            ["python3", "-c", recover_code, str(inputs / "recovery.json")]
        )
        (run_dir / "recovery.txt").write_text(
            f"owned compose project: {project}\nowned auth project: {auth_project}\n"
            f"manual store cleanup: {recovery_command}\n"
            f"inspect host process groups against {run_dir / 'launches.json'}; never blindly kill saved pids.\n"
            + (f"after verified host shutdown remove {host_codex_dir}.\n" if host_codex_dir else "")
            + (
                f"shared codex cwd: {compose_env['NEXUS_LAB_CODEX_CWD_ROOT']}; retain until owned workers and remote sessions are closed; never stop the shared host to clean a lab.\n"
                if shared_host is not None
                else ""
            )
            + f"after verified recovery delete {inputs} and manually remove {lock}.\n"
        )
        message(f"ownership: {project}; private logs and recovery: {run_dir}")
        config = (ROOT / "supabase/config.toml").read_text()
        for section, key, value in [
            ("api", "port", auth_port),
            ("db", "port", auth_db_port),
            ("db", "shadow_port", shadow_port),
            ("local_smtp", "port", mail_port),
            ("local_smtp", "smtp_port", smtp_port),
            ("local_smtp", "pop3_port", pop3_port),
            ("auth", "site_url", web_origin),
            ("auth", "additional_redirect_urls", [web_origin + "/auth/callback"]),
            ("auth", "jwt_issuer", auth_origin + "/auth/v1"),
            ("db.seed", "enabled", False),
            ("db.seed", "sql_paths", []),
            ("realtime", "enabled", False),
            ("studio", "enabled", False),
            ("edge_runtime", "enabled", False),
            ("analytics", "enabled", False),
            ("auth.external.github", "enabled", False),
            ("auth.external.google", "enabled", False),
        ]:
            config = set_config(config, section, key, value)
        config = re.sub(r"^project_id = .*$", f'project_id = "{auth_project}"', config, flags=re.M)
        (auth_root / "supabase/config.toml").write_text(config)
        tomllib.loads(config)
        phase = "auth key generation"
        jwk = json.loads(
            command(cli + ["gen", "signing-key", "--algorithm", "ES256"], env=auth_env)
        )
        private_json(auth_root / "supabase/signing_keys.json", [jwk])
        config = set_config(config, "auth", "signing_keys_path", "./signing_keys.json")
        (auth_root / "supabase/config.toml").write_text(config)
        phase = "dependency acquisition"
        message(f"{phase}: bounded image pull/build; logs: {run_dir}")
        command(
            compose + ["pull", "storage"],
            env=compose_env,
            timeout=600,
            log=run_dir / "images.log",
        )
        command(
            compose + ["build", "postgres"],
            env=compose_env,
            timeout=1200,
            log=run_dir / "postgres-image.log",
        )
        resources_owned = True
        command(
            [
                sys.executable,
                str(ROOT / "python/scripts/worker_checkout_image.py"),
                *worker_services,
            ],
            env=compose_env,
            timeout=2760,
            log=run_dir / "worker-image.log",
        )
        if args.fake_providers:
            assert host_codex_dir is not None  # created by this mode before dependency acquisition
            phase = "fake providers"
            command(
                compose + ["up", "-d", "--no-build", "fake-providers", "fake-codex"],
                env=compose_env,
                log=run_dir / "fake-providers-start.log",
            )
            port = (
                command(compose + ["port", "fake-providers", "8443"], env=compose_env)
                .strip()
                .rsplit(":", 1)[1]
            )
            fake_origin = f"https://127.0.0.1:{int(port)}"
            app_env["PROVIDER_ENDPOINT_OVERRIDES"] = json.dumps({"openai": fake_origin})
            from nexus.provider_http import provider_ssl_context

            fake_trust = provider_ssl_context(fake_ca_pem)
            ready(
                "fake providers",
                lambda: http_json(fake_origin + "/health", context=fake_trust)["kind"]
                == "lab_fake_providers",
            )
            start(
                "fake-codex-host",
                [
                    sys.executable,
                    str(ROOT / "python/scripts/lab_fake_codex.py"),
                    "--origin",
                    fake_origin,
                    "--ca-file",
                    str(fake_tls / "ca.pem"),
                    "--state",
                    str(inputs / "codex-state"),
                    "--socket",
                    str(host_codex_dir / "app-server.sock"),
                ],
                base_env,
                inputs,
            )
            ready(
                "native codex host socket",
                lambda: host_codex_dir is not None
                and (host_codex_dir / "app-server.sock").is_socket(),
            )
            command(
                [sys.executable, "-m", "apps.codex_agent.health"],
                env=app_env,
                cwd=inputs,
                timeout=125,
                log=run_dir / "native-codex-health.log",
            )
            fake_providers = {"origin": fake_origin, "ca_file": str(fake_tls / "ca.pem")}
        phase = "stores"
        message("stores: starting fresh owned database, storage and auth")
        command(
            compose + ["up", "-d", "--wait", "--wait-timeout", "120", "postgres", "storage"],
            env=compose_env,
            log=run_dir / "stores.log",
        )
        command(
            cli
            + [
                "start",
                "--network-id",
                project + "_default",
                "--exclude",
                "realtime,storage-api,imgproxy,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor",
            ],
            env=auth_env,
            timeout=600,
        )
        status = json.loads(command(cli + ["status", "--output", "json"], env=auth_env))
        if (
            status["API_URL"] != auth_origin
            or status["PUBLISHABLE_KEY"] != auth_env["SUPABASE_AUTH_PUBLISHABLE_KEY"]
            or status["SECRET_KEY"] != auth_env["SUPABASE_AUTH_SECRET_KEY"]
        ):
            raise RuntimeError("auth status origin or key mismatch")
        admin_key_file = inputs / "auth-admin-key"
        admin_key_file.write_text(status["SECRET_KEY"])
        observed_auth_project = command(
            [
                "docker",
                "inspect",
                "--format",
                '{{index .Config.Labels "com.supabase.cli.project"}}',
                f"supabase_kong_{auth_project}",
            ]
        ).strip()
        if observed_auth_project != auth_project:
            raise RuntimeError("auth gateway project identity mismatch")
        store_services = ["postgres", "storage"]
        if args.fake_providers:
            store_services += ["fake-providers", "fake-codex"]
        container_ids = command(compose + ["ps", "-q", *store_services], env=compose_env).split()
        if len(container_ids) != len(store_services):
            raise RuntimeError("owned store containers missing")
        container_ids += command(
            ["docker", "ps", "-q", "--filter", f"label=com.supabase.cli.project={auth_project}"]
        ).split()
        if len(container_ids) < len(store_services) + 4:
            raise RuntimeError("owned stores and isolated auth containers missing")
        app_env |= {"SUPABASE_URL": auth_origin, "SUPABASE_ANON_KEY": status["PUBLISHABLE_KEY"]}
        phase = "bucket and migration"
        command(
            [sys.executable, str(ROOT / "python/scripts/local_storage.py"), "--origin", web_origin],
            env=app_env,
            cwd=inputs,
            log=run_dir / "storage.log",
        )
        command(
            [
                sys.executable,
                "-m",
                "alembic",
                "-c",
                str(ROOT / "migrations/alembic.ini"),
                "upgrade",
                "head",
            ],
            env=app_env,
            cwd=ROOT / "migrations",
            log=run_dir / "migration.log",
        )
        phase = "api"
        start(
            "api",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "apps.api.main:app",
                "--loop",
                "asyncio",
                "--host",
                "127.0.0.1",
                "--port",
                str(api_port),
            ],
            app_env | live,
            inputs,
        )
        ready(
            "api",
            lambda: http_json(api_origin + "/readyz")["data"] == {"status": "ready"}
            and http_json(api_origin + "/version")["data"] == identity,
        )
        phase = "workers"
        if shared_host is not None:
            shared_cwd_prepared = True
            shared_host.prepare_run(run_id)
        command(
            compose + ["up", "-d", "--no-deps", "--no-build", *worker_services],
            env=compose_env,
            log=run_dir / "workers-start.log",
        )
        worker_ids = command(compose + ["ps", "-q", *worker_services], env=compose_env).split()
        container_ids += worker_ids
        if len(worker_ids) != len(worker_services):
            raise RuntimeError("owned worker containers missing")
        for lane in ("interactive", "background"):

            def worker_ready(lane: str = lane) -> bool:
                try:
                    argv = compose + [
                        "exec",
                        "-T",
                        f"worker-{lane}",
                        "python",
                        "-S",
                        "-m",
                        "apps.worker.health",
                        "--lane",
                        lane,
                    ]
                    env = compose_env
                    health = json.loads(command(argv, env=env, cwd=inputs, timeout=10))
                except RuntimeError:
                    return False
                return health == {"status": "ready", "lane": lane, **identity}

            ready(f"worker-{lane}", worker_ready)
        if args.fake_providers or shared_host is not None:
            phase = "native codex linux catalog"
            for lane in ("interactive", "background"):
                command(
                    compose
                    + ["exec", "-T", f"worker-{lane}", "python", "-m", "apps.codex_agent.health"],
                    env=compose_env,
                    timeout=125,
                    log=run_dir / f"native-codex-{lane}-health.log",
                )
        phase = "web"
        extension_id = json.loads((ROOT / "apps/extension/manifest.json").read_text())[
            "browser_specific_settings"
        ]["gecko"]["id"]
        extension_redirect = hashlib.sha1(extension_id.encode(), usedforsecurity=False).hexdigest()
        web_env = base_env | {
            key: app_env[key]
            for key in ("NEXUS_ENV", "APP_PUBLIC_URL", "NEXUS_INTERNAL_SECRET", "R2_S3_API_ORIGIN")
        }
        web_env |= {
            "NEXT_PUBLIC_SUPABASE_URL": auth_origin,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": status["PUBLISHABLE_KEY"],
            "FASTAPI_BASE_URL": api_origin,
            "NEXUS_EXTENSION_REDIRECT_ORIGINS": f"https://{extension_redirect}.extensions.allizom.org",
            "VERCEL_GIT_COMMIT_SHA": source_sha,
            "NEXT_TELEMETRY_DISABLED": "1",
            "NODE_ENV": "production",
            "HOSTNAME": "127.0.0.1",
            "PORT": str(web_port),
            "NEXUS_WEB_TLS_CERT_FILE": str(web_tls_dir / "cert.pem"),
            "NEXUS_WEB_TLS_KEY_FILE": str(web_tls_dir / "key.pem"),
        }
        phase = "web build"
        web = ROOT / "apps/web"
        marker_path = ROOT / ".nexus-local/web-build.json"
        build_key = {
            "source_sha": source_sha,
            "slot": host_slot,
            "publishable_key": publishable_key,
        }
        web_status = command(
            ["git", "status", "--porcelain", "--untracked-files=normal", "--", "apps/web"]
        )
        try:
            marker = json.loads(marker_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            marker = None
        build_id = _complete_web_build(web)
        if (
            not web_status
            and build_id is not None
            and marker == {**build_key, "build_id": build_id}
        ):
            message("web: reusing the completed production package")
        else:
            marker_path.unlink(missing_ok=True)
            message("web: building the canonical production package for this run's origin")
            command(
                ["bun", "--no-env-file", "--no-install", "run", "build"],
                env=web_env,
                cwd=web,
                timeout=600,
                log=run_dir / "web-build.log",
            )
            build_id = _complete_web_build(web)
            if build_id is None:
                raise RuntimeError("web production package incomplete")
            after_status = command(
                ["git", "status", "--porcelain", "--untracked-files=normal", "--", "apps/web"]
            )
            if (
                command(["git", "rev-parse", "HEAD"]).strip() != source_sha
                or after_status != web_status
            ):
                raise RuntimeError("web source changed during production build")
            if not web_status:
                private_json(marker_path, {**build_key, "build_id": build_id})
        web_runtime = inputs / "web"
        _stage_web_runtime(web / ".next/standalone", web_runtime)
        phase = "web"
        start(
            "web",
            ["node", str(web_runtime / "serve.mjs")],
            web_env,
            web_runtime,
        )

        def web_ready() -> bool:
            try:
                observed = json.loads(
                    command(
                        [
                            "node",
                            str(web_runtime / "probe-web.mjs"),
                            web_origin,
                            web_tls["ca_file"],
                        ],
                        timeout=6,
                    )
                )
            except RuntimeError:
                return False
            return observed == {"source_sha": source_sha}

        ready("web", web_ready)
        phase = "reader bootstrap"
        message("reader bootstrap: creating one confirmed lab reader and performing browser login")
        email = f"lab-reader-{run_id}@example.test"
        password = "Lab9!" + secrets.token_urlsafe(32)
        user = http_json(
            auth_origin + "/auth/v1/admin/users",
            body={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": "lab reader"},
            },
            headers={"apikey": status["SECRET_KEY"]},
        )
        browser_state = inputs / "browser-state.json"
        bootstrap = inputs / "bootstrap.json"
        private_json(
            bootstrap,
            {
                "web_origin": web_origin,
                "web_tls": web_tls,
                "wire_revision": WIRE_REVISION,
                "seed": {"user_id": user["id"], "email": email, "password": password},
                "browser_state_file": str(browser_state),
                "artifacts_dir": str(artifacts),
            },
        )
        reader = json.loads(
            command(
                [
                    "bun",
                    "--no-env-file",
                    "--no-install",
                    str(ROOT / "apps/web/scripts/lab/auth.ts"),
                    str(bootstrap),
                ],
                cwd=ROOT,
                timeout=120,
                log=run_dir / "browser-bootstrap.log",
            )
        )
        if (
            reader["user_id"] != user["id"]
            or not reader["default_library_id"]
            or not browser_state.is_file()
        ):
            raise RuntimeError("browser bootstrap identity or default library mismatch")
        context = inputs / "context.json"
        private_json(
            context,
            {
                "run_id": run_id,
                "worktree": str(ROOT),
                "web_origin": web_origin,
                "web_tls": web_tls,
                "api_origin": api_origin,
                "auth_origin": auth_origin,
                "auth_anon_key": status["PUBLISHABLE_KEY"],
                "auth_admin_key_file": str(admin_key_file),
                "database_url": database_url,
                "storage": {
                    "origin": storage_origin,
                    "bucket": "media",
                    "region": "us-east-1",
                    "access_key_id": app_env["R2_ACCESS_KEY_ID"],
                    "secret_access_key": app_env["R2_SECRET_ACCESS_KEY"],
                },
                "wire_revision": WIRE_REVISION,
                "seed": {
                    "user_id": user["id"],
                    "default_library_id": reader["default_library_id"],
                    "email": email,
                    "password": password,
                },
                "browser_state_file": str(browser_state),
                "artifacts_dir": str(artifacts),
                "fake_providers": fake_providers,
                "client_cpu_throttle": args.client_throttle,
            },
        )
        phase = "driver"
        alive()
        message(f"driver: authenticated runtime ready; artifacts: {artifacts}")
        driver = launch(
            "driver",
            args.driver[1:],
            base_env | {"NEXUS_LAB_CONTEXT": str(context)},
            ROOT,
            None,
            None,
        )
        while driver.poll() is None:
            alive()
            time.sleep(0.5)
        alive()
        result = driver.returncode if driver.returncode >= 0 else 128 - driver.returncode
        message(f"driver: exited {result}")
    except KeyboardInterrupt:
        result = 128 + interrupted
        message(f"{phase}: interrupted; owned teardown follows")
    except Exception as exc:
        if interrupted:
            result = 128 + interrupted
        message(
            f"{phase}: failed: {exc}; driver {'stopped' if phase == 'driver' else 'not started'}"
        )
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        phase = "cleanup"
        cleanup_errors: list[str] = []
        deadline = time.monotonic() + 120
        if resources_owned and run_dir is not None:
            try:
                command(
                    compose + ["logs", "--no-color"],
                    env=compose_env,
                    timeout=10,
                    log=run_dir / "containers.log",
                )
            except Exception:
                message("diagnostics: container logs unavailable")
        for name, process in reversed(list(processes.items())):
            try:
                stop_group(
                    process,
                    min(10, max(0.1, deadline - time.monotonic())),
                    already_signalled=name == "driver" and driver_signalled,
                )
            except Exception as exc:
                cleanup_errors.append(
                    f"host group {name} termination failed ({type(exc).__name__})"
                )
        if resources_owned and run_dir is not None:
            for name, argv, env in [
                (
                    "workers",
                    compose + ["stop", "--timeout", "30", *worker_services],
                    compose_env,
                ),
                ("auth", auth_cleanup, base_env),
                (
                    "compose",
                    compose
                    + [
                        "down",
                        "--volumes",
                        "--remove-orphans",
                        "--rmi",
                        "local",
                        "--timeout",
                        "30",
                    ],
                    compose_env,
                ),
            ]:
                try:
                    command(
                        argv,
                        env=env,
                        timeout=max(0.1, deadline - time.monotonic()),
                        log=run_dir / f"cleanup-{name}.log",
                    )
                except Exception:
                    cleanup_errors.append(f"{name} cleanup failed")
            try:
                for namespace in (
                    f"com.docker.compose.project={project}",
                    f"com.supabase.cli.project={auth_project}",
                ):
                    for kind in ("container", "volume", "network"):
                        remaining = command(
                            [
                                "docker",
                                kind,
                                "ls",
                                "-q",
                                *(["-a"] if kind == "container" else []),
                                "--filter",
                                f"label={namespace}",
                            ],
                            timeout=max(0.1, deadline - time.monotonic()),
                        )
                        if remaining.strip():
                            cleanup_errors.append(f"owned {kind} resources remain ({namespace})")
            except Exception:
                cleanup_errors.append("cleanup verification unavailable")
        if shared_host is not None and shared_cwd_prepared:
            try:
                if cleanup_errors:
                    raise RuntimeError("owned worker shutdown and cleanup are unverified")
                shared_host.remove_run(run_id)
            except Exception as exc:
                cleanup_errors.append(f"shared codex cwd retained ({exc})")
        try:
            shared_access.close()
        except Exception as exc:
            cleanup_errors.append(f"shared codex access release failed ({exc})")
        if lock_owned and run_dir is not None:
            if not cleanup_errors:
                try:
                    if host_codex_dir is not None:
                        shutil.rmtree(host_codex_dir)
                    if (run_dir / "inputs").exists():
                        shutil.rmtree(run_dir / "inputs")
                except OSError as exc:
                    cleanup_errors.append(f"private inputs removal failed ({type(exc).__name__})")
            if cleanup_errors:
                message(
                    f"cleanup incomplete: {', '.join(cleanup_errors)}; recovery: {run_dir / 'recovery.txt' if resources_owned else run_dir}"
                )
                if result == 0:
                    result = 125
            elif resources_owned:
                (run_dir / "recovery.txt").write_text(
                    "verified this run's owned runtime removed; "
                    "generated credentials and browser session deleted.\n"
                )
                message(
                    f"this run's owned runtime removed; private diagnostics retained: {run_dir}"
                )
        for slot_file in slot_files:
            slot_file.close()
        if lock_owned:
            lock.unlink()
    return result


if __name__ == "__main__":
    sys.exit(main())
