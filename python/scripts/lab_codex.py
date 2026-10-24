"""One immutable Linux Codex installation, shared by trusted disposable labs.

Docker's retained daemon container is the installation record; its immutable
image, contract labels, volumes, networks and listener are checked at attachment.
No ordinary attachment reconciles Compose or changes the installed image. The
native bearer capability is private host state, separate from subscription auth.
The existing egress peer passes host-loopback TCP unchanged to the internal
daemon; workers connect directly. The daemon gains no outbound route.

`attach()` holds shared lifecycle access through the caller's worker/session
teardown. Its host owns only the explicit run roots created through prepare_run;
remove_run must follow confirmed session closure and worker shutdown. Management
uses nonblocking exclusive access and also refuses running cwd-volume consumers.
Stopped-host startup upgrades the lock with a bounded recheck, never waits for
active labs to drain and never restarts a running unhealthy daemon. Retries only
reobserve/start the same installation; enrollment never overwrites credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "nexus-lab-codex"
DAEMON = "nexus-lab-codex-agent-host"
PROXY = "nexus-lab-codex-egress-policy"
PROXY_IMAGE = (
    "nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94"
)
CLIENT_NETWORK = "nexus-lab-codex-clients"
ACCOUNT_VOLUME = "nexus-lab-codex-account"
CWD_VOLUME = "nexus-lab-codex-cwds"
CWD_ROOT = "/tmp/codex-daemon-10001/cwds"
WORKER_ENDPOINT = "ws://nexus-codex-agent-host:4500"
LABEL_PREFIX = "com.nexus.lab.codex."
HOST_POLICY_REVISION = 1
SETUP_SECONDS = 125


def _state() -> Path:
    state = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
    if not state.is_absolute():
        raise ValueError("XDG_STATE_HOME must be absolute")
    return state / "nexus-lab/codex"


def _environment() -> dict[str, str]:
    return {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "LANG", "TERM"}
    } | {"COMPOSE_ENV_FILES": os.devnull}


def _remaining(deadline: float | None, limit: float) -> float:
    if deadline is None:
        return limit
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("shared codex setup exceeded 125 seconds")
    return min(limit, remaining)


def _run(
    argv: list[str],
    *,
    timeout: float = 30,
    env: dict[str, str] | None = None,
    deadline: float | None = None,
) -> str:
    result = subprocess.run(
        argv,
        cwd=ROOT,
        env=env or _environment(),
        capture_output=True,
        text=True,
        timeout=_remaining(deadline, timeout),
    )
    if result.returncode:
        # Command arguments may contain a capability: report only the dependency
        # and status. Docker/provider diagnostics are captured privately below.
        raise RuntimeError(f"{argv[0]} failed (exit {result.returncode})")
    return result.stdout


def _inspect(
    name: str, kind: str = "container", *, deadline: float | None = None
) -> dict[str, Any] | None:
    result = subprocess.run(
        ["docker", kind, "inspect", name],
        env=_environment(),
        capture_output=True,
        text=True,
        timeout=_remaining(deadline, 15),
    )
    if result.returncode:
        missing = "No such" in result.stderr or (
            kind == "network" and f"network {name} not found" in result.stderr
        )
        if result.stdout.strip() == "[]" and missing:
            return None
        raise RuntimeError(f"docker {kind} observation unavailable")
    return json.loads(result.stdout)[0]


def _expected() -> dict[str, str]:
    from provider_runtime.agent_runtime import (
        AGENT_BACKEND_CONTRACT_REVISION,
        CODEX_CONTAINMENT_CATALOG_REVISION,
        CODEX_CONTAINMENT_VERSION,
    )

    return {
        "codex_version": CODEX_CONTAINMENT_VERSION,
        "catalog_revision": CODEX_CONTAINMENT_CATALOG_REVISION,
        "backend_contract_revision": AGENT_BACKEND_CONTRACT_REVISION,
        "host_policy_revision": str(HOST_POLICY_REVISION),
    }


def _token() -> str:
    path = _state() / "transport-token"
    try:
        token = path.read_text().strip()
    except FileNotFoundError:
        raise RuntimeError(
            "shared codex transport capability missing; run ./scripts/lab-codex enroll"
        ) from None
    if path.stat().st_mode & 0o077 or not token:
        raise RuntimeError("shared codex transport capability must be private and nonempty")
    return token


def _consumers(*, deadline: float | None = None) -> list[str]:
    ids = _run(
        ["docker", "ps", "-q", "--filter", f"volume={CWD_VOLUME}"], deadline=deadline
    ).split()
    if not ids:
        return []
    containers = json.loads(_run(["docker", "inspect", *ids], deadline=deadline))
    return [item["Name"].lstrip("/") for item in containers if item["Name"] != f"/{DAEMON}"]


def _drained(*, deadline: float | None = None) -> None:
    consumers = _consumers(deadline=deadline)
    if consumers:
        raise RuntimeError(
            f"shared codex has running cwd-volume consumers: {', '.join(consumers)}; finish/recover those labs"
        )


@contextlib.contextmanager
def _lock(*, exclusive: bool, deadline: float | None = None) -> Iterator[TextIO]:
    state = _state()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(state / "lifecycle.lock", os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+") as lock:
        deadline = deadline or time.monotonic() + SETUP_SECONDS
        while True:
            try:
                fcntl.flock(lock, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if exclusive:
                    raise RuntimeError(
                        "shared codex is in use; finish/recover those labs"
                    ) from None
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "shared codex management lock unavailable after 125 seconds"
                    ) from None
                time.sleep(0.1)
        yield lock


def _installation(token: str, *, deadline: float | None = None) -> dict[str, Any]:
    container = _inspect(DAEMON, deadline=deadline)
    if container is None:
        raise RuntimeError("shared codex is not installed; run ./scripts/lab-codex enroll")
    labels = container["Config"]["Labels"] or {}
    observed = {key: labels.get(LABEL_PREFIX + key) for key in _expected()}
    # Docker labels are strings, but the policy revision has integer semantics.
    try:
        policy = int(observed["host_policy_revision"] or "")
    except ValueError:
        policy = None
    if observed != _expected() or policy != HOST_POLICY_REVISION:
        raise RuntimeError(
            f"shared codex contract incompatible: expected {_expected()}, observed {observed}; "
            "finish/recover labs, then ./scripts/lab-codex down and ./scripts/lab-codex up"
        )
    config, host = container["Config"], container["HostConfig"]
    environment = dict(item.split("=", 1) for item in config["Env"])
    mounts = {item["Destination"]: item for item in container["Mounts"]}
    networks = container["NetworkSettings"]["Networks"]
    binding = host["PortBindings"] or {}
    correct_mounts = all(
        mounts.get(path, {}).get("Type") == "volume"
        and mounts[path].get("Name") == name
        and mounts[path].get("RW")
        for path, name in (
            ("/var/lib/nexus-codex", ACCOUNT_VOLUME),
            ("/tmp/codex-daemon-10001", CWD_VOLUME),
        )
    )
    valid = (
        config["Image"] == container["Image"]
        and config["Image"].startswith("sha256:")
        and _inspect(container["Image"], "image", deadline=deadline) is not None
        and config["User"] == "10001:10001"
        and config["Cmd"] == ["python", "-m", "apps.codex_agent.main"]
        and host["ReadonlyRootfs"]
        and host["CapDrop"] == ["ALL"]
        and "no-new-privileges:true" in host["SecurityOpt"]
        and not binding
        and environment.get("NEXUS_CODEX_ENDPOINT") == "ws://0.0.0.0:4500"
        and environment.get("NEXUS_CODEX_CREDENTIAL_FILE") == "/var/lib/nexus-codex/auth.json"
        and environment.get("NEXUS_CODEX_CWD_ROOT") == CWD_ROOT
        and environment.get("NEXUS_CODEX_TRANSPORT_TOKEN_SHA256")
        == hashlib.sha256(token.encode()).hexdigest()
        and "NEXUS_CODEX_TRANSPORT_TOKEN" not in environment
        and correct_mounts
        and set(networks) == {CLIENT_NETWORK, f"{PROJECT}_codex_private"}
    )
    client_network = _inspect(CLIENT_NETWORK, "network", deadline=deadline)
    private_network = _inspect(f"{PROJECT}_codex_private", "network", deadline=deadline)
    proxy = _inspect(PROXY, deadline=deadline)
    if proxy:
        proxy_config, proxy_host = proxy["Config"], proxy["HostConfig"]
        proxy_binding = (proxy_host["PortBindings"] or {}).get("4500/tcp", [])
        proxy_environment = dict(item.split("=", 1) for item in proxy_config["Env"])
        policy = proxy_environment.get("NGINX_CONF", "")
        valid = valid and (
            proxy_config["Image"] == PROXY_IMAGE
            and proxy_config["User"] == "101:101"
            and proxy_host["ReadonlyRootfs"]
            and proxy_host["CapDrop"] == ["ALL"]
            and "no-new-privileges:true" in proxy_host["SecurityOpt"]
            and len(proxy_binding) == 1
            and proxy_binding[0]["HostIp"] == "127.0.0.1"
            and set(proxy["NetworkSettings"]["Networks"])
            == {f"{PROJECT}_codex_private", f"{PROJECT}_codex_proxy_egress"}
            and re.search(
                r"map\s+\$ssl_preread_server_name\s+\$upstream\s*\{\s*chatgpt\.com\s+chatgpt\.com:443;\s*auth\.openai\.com\s+auth\.openai\.com:443;\s*default\s+127\.0\.0\.1:1;\s*\}",
                policy,
            )
            is not None
            and re.search(
                r"server\s*\{\s*listen 4500;\s*proxy_pass 172\.30\.252\.3:4500;\s*proxy_connect_timeout 10s;\s*proxy_timeout 20m;\s*\}",
                policy,
            )
            is not None
        )
    if (
        not proxy
        or not valid
        or not all(item and item["Internal"] for item in (client_network, private_network))
    ):
        raise RuntimeError(
            "shared codex installed confinement/listener differs from contract; drain, then ./scripts/lab-codex down and ./scripts/lab-codex up"
        )
    return container


def _host_environment(token: str, *, deadline: float | None = None) -> dict[str, str]:
    proxy = _inspect(PROXY, deadline=deadline)
    if proxy is None:
        raise RuntimeError("shared codex loopback ingress unavailable; run ./scripts/lab-codex up")
    bindings = proxy["NetworkSettings"]["Ports"].get("4500/tcp") or []
    if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
        raise RuntimeError("shared codex loopback endpoint unavailable")
    return {
        "NEXUS_CODEX_ENDPOINT": f"ws://127.0.0.1:{int(bindings[0]['HostPort'])}",
        "NEXUS_CODEX_TRANSPORT_TOKEN": token,
    }


def _catalog(environment: dict[str, str], *, timeout: float, diagnostics: bool = True) -> str:
    # The ordinary product read checks native version/catalog/backend contract.
    try:
        result = subprocess.run(
            [sys.executable, "-m", "apps.codex_agent.health"],
            cwd=ROOT,
            env=_environment()
            | {"PYTHONPATH": str(ROOT / "python") + os.pathsep + str(ROOT)}
            | environment,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        detail = "native authenticated catalog probe timed out\n"
    else:
        if result.returncode == 0:
            return result.stdout.strip()
        detail = result.stdout + result.stderr
    if diagnostics:
        path = _state() / "catalog.log"
        token = environment.get("NEXUS_CODEX_TRANSPORT_TOKEN")
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
            stream.write(detail.replace(token, "[redacted]") if token else detail)
        raise RuntimeError(
            f"shared codex authenticated catalog unavailable; inspect private diagnostics: {path}; "
            "if sign-in was rejected, recover the dedicated account using docs/runbooks/codex-personal-agent-host.md"
        )
    raise RuntimeError("shared codex authenticated catalog unavailable")


def _start(container: dict[str, Any], token: str, deadline: float) -> dict[str, Any]:
    _drained(deadline=deadline)
    proxy = _inspect(PROXY, deadline=deadline)
    if proxy is None:
        raise RuntimeError("shared codex retained egress peer missing; run ./scripts/lab-codex up")
    # Never Compose-up here: the current checkout cannot reconcile an install.
    _run(["docker", "start", PROXY, container["Id"]], deadline=deadline, timeout=SETUP_SECONDS)
    while time.monotonic() < deadline:
        container = _installation(token, deadline=deadline)
        if not container["State"]["Running"]:
            raise RuntimeError(
                "shared codex stopped during startup; inspect private diagnostics and run ./scripts/lab-codex enroll if account recovery is needed"
            )
        try:
            _catalog(
                _host_environment(token, deadline=deadline),
                timeout=_remaining(deadline, 8),
            )
            return container
        except (RuntimeError, subprocess.TimeoutExpired):
            time.sleep(0.2)
    raise TimeoutError(
        "shared codex authenticated catalog unavailable after 125 seconds; inspect private diagnostics and account sign-in"
    )


@dataclass(frozen=True, repr=False)
class SharedHost:
    image_id: str
    host_environment: dict[str, str] = field(repr=False)

    def worker_environment(self, run_id: str) -> dict[str, str]:
        return self.host_environment | {
            "NEXUS_CODEX_ENDPOINT": WORKER_ENDPOINT,
            "NEXUS_CODEX_CWD_ROOT": _run_root(run_id),
        }

    def prepare_run(self, run_id: str) -> None:
        _run_helper(self.image_id, run_id, remove=False)

    def remove_run(self, run_id: str) -> None:
        # Kernel cwd disposal does not prove remote cancellation. Observe loaded
        # native threads after workers stop; uncertainty retains the run root.
        asyncio.run(_confirm_quiet(self.host_environment, _run_root(run_id)))
        _run_helper(self.image_id, run_id, remove=True)


async def _confirm_quiet(environment: dict[str, str], root: str) -> None:
    from provider_runtime.agent_runtime import CodexWebSocketEndpoint
    from provider_runtime.agent_runtime.codex_app_server import (
        CodexAppServerClient,
        CodexAppServerConfig,
        CodexAppServerResponseError,
    )
    from pydantic import SecretStr

    async def loaded(client: CodexAppServerClient) -> set[str]:
        cursor = None
        ids: set[str] = set()
        while True:
            page = await client.request("thread/loaded/list", {"cursor": cursor, "limit": 100})
            if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                raise RuntimeError(
                    "shared codex loaded-thread observation malformed; run cwd retained"
                )
            for thread_id in page["data"]:
                if not isinstance(thread_id, str):
                    raise RuntimeError(
                        "shared codex loaded-thread identity unavailable; run cwd retained"
                    )
                ids.add(thread_id)
            cursor = page.get("nextCursor")
            if cursor is None:
                return ids
            if not isinstance(cursor, str) or not cursor:
                raise RuntimeError("shared codex loaded-thread cursor malformed; run cwd retained")

    endpoint = CodexWebSocketEndpoint(
        url=environment["NEXUS_CODEX_ENDPOINT"],
        bearer_token=SecretStr(environment["NEXUS_CODEX_TRANSPORT_TOKEN"]),
    )
    config = CodexAppServerConfig(endpoint, request_policy="observe_only", experimental_api=True)
    async with asyncio.timeout(20), CodexAppServerClient(config) as client:
        for thread_id in await loaded(client):
            try:
                result = await client.request(
                    "thread/read", {"threadId": thread_id, "includeTurns": False}
                )
            except CodexAppServerResponseError:
                # A sibling ephemeral thread can unload after the list snapshot.
                # Its observed absence proves it cannot still own an active turn.
                if thread_id not in await loaded(client):
                    continue
                raise RuntimeError(
                    "shared codex loaded-thread closure unavailable; run cwd retained"
                ) from None
            thread = result.get("thread") if isinstance(result, dict) else None
            if not isinstance(thread, dict) or not isinstance(thread.get("cwd"), str):
                raise RuntimeError("shared codex loaded-thread cwd unavailable; run cwd retained")
            cwd = thread["cwd"]
            if cwd == root or cwd.startswith(root + "/"):
                status = thread.get("status")
                if not isinstance(status, dict) or status.get("type") not in ("idle", "notLoaded"):
                    raise RuntimeError(
                        "shared codex owned thread is active or closure is unknown; run cwd retained"
                    )


def _run_root(run_id: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}", run_id):
        raise ValueError("shared codex run id must be one nonempty path component")
    return f"{CWD_ROOT}/{run_id}"


def _run_helper(image_id: str, run_id: str, *, remove: bool) -> None:
    root = _run_root(run_id)
    program = "import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); " + (
        "shutil.rmtree(p) if p.exists() else None"
        if remove
        else "p.parent.mkdir(mode=0o700,exist_ok=True); p.mkdir(mode=0o700)"
    )
    _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--user",
            "10001:10001",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--mount",
            f"type=volume,source={CWD_VOLUME},target=/tmp/codex-daemon-10001",
            "--entrypoint",
            "python",
            image_id,
            "-c",
            program,
            root,
        ]
    )


@contextlib.contextmanager
def attach() -> Iterator[SharedHost]:
    """Attach a compatible enrolled installation; retain shared access until exit."""
    deadline = time.monotonic() + SETUP_SECONDS
    with _lock(exclusive=False, deadline=deadline) as lock:
        token = _token()
        while True:
            container = _installation(token, deadline=deadline)
            if container["State"]["Running"]:
                _catalog(
                    _host_environment(token, deadline=deadline),
                    timeout=_remaining(deadline, SETUP_SECONDS),
                )
                break
            fcntl.flock(lock, fcntl.LOCK_UN)
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    container = _installation(token, deadline=deadline)
                    if container["State"]["Running"]:
                        try:
                            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        except BlockingIOError:
                            pass  # The starter still owns exclusive readiness.
                        else:
                            break  # Revalidate the healthy installation under shared access.
                    elif _consumers(deadline=deadline):
                        raise RuntimeError(
                            "shared codex unavailable with surviving consumers; finish/recover those labs"
                        ) from None
                    # Other cold attachers also released their shared lock. One
                    # wins exclusive startup; contenders hold no lock while waiting.
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            "shared codex startup lock unavailable after 125 seconds"
                        ) from None
                    time.sleep(0.1)
                else:
                    container = _installation(token, deadline=deadline)
                    if not container["State"]["Running"]:
                        _start(container, token, deadline)
                    fcntl.flock(lock, fcntl.LOCK_SH)
                    break
        yield SharedHost(container["Image"], _host_environment(token, deadline=deadline))


def _compose(environment: dict[str, str], *arguments: str, interactive: bool = False) -> None:
    argv = [
        "docker",
        "compose",
        "--project-name",
        PROJECT,
        "--file",
        str(ROOT / "docker/docker-compose.lab-codex.yml"),
        *arguments,
    ]
    if interactive:
        subprocess.run(argv, cwd=ROOT, env=environment, check=True)
    else:
        _run(argv, env=environment, timeout=180)


def _install(token: str) -> dict[str, Any]:
    existing = _inspect(DAEMON)
    if existing and existing["State"]["Running"]:
        raise RuntimeError(
            "shared codex is running; ./scripts/lab-codex down before explicit installation changes"
        )
    _drained()
    expected = _expected()
    if existing:
        observed_version = (existing["Config"]["Labels"] or {}).get(
            LABEL_PREFIX + "codex_version", ""
        )
        if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", observed_version) and tuple(
            map(int, expected["codex_version"].split("."))
        ) < tuple(map(int, observed_version.split("."))):
            raise RuntimeError(
                f"shared codex downgrade refused: installed {observed_version}, requested {expected['codex_version']}; use the qualified newer checkout"
            )
    state = _state()
    source_sha = _run(["git", "rev-parse", "HEAD"]).strip()
    with tempfile.TemporaryDirectory(dir=state) as directory:
        iid = Path(directory) / "image-id"
        with (state / "install.log").open("w") as log:
            os.chmod(state / "install.log", 0o600)
            result = subprocess.run(
                [
                    "docker",
                    "build",
                    "--file",
                    "docker/Dockerfile.backend",
                    "--target",
                    "worker",
                    "--build-arg",
                    f"SOURCE_SHA={source_sha}",
                    "--iidfile",
                    str(iid),
                    ".",
                ],
                cwd=ROOT,
                env=_environment(),
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=1200,
            )
        if result.returncode:
            raise RuntimeError(
                f"shared codex immutable image build failed; private diagnostics: {state / 'install.log'}"
            )
        image_id = iid.read_text().strip()
    observed = json.loads(
        _run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--user",
                "10001:10001",
                "--entrypoint",
                "python",
                image_id,
                "-c",
                "import json,subprocess,codex_cli_bin; from provider_runtime.agent_runtime import "
                "CODEX_CONTAINMENT_VERSION as v,CODEX_CONTAINMENT_CATALOG_REVISION as c,AGENT_BACKEND_CONTRACT_REVISION as b; "
                "print(json.dumps(dict(codex_version=v,catalog_revision=c,backend_contract_revision=b,"
                "native_version=subprocess.check_output([codex_cli_bin.bundled_codex_path(),'--version'],text=True).strip())))",
            ]
        )
    )
    if (
        any(
            observed.get(key) != value
            for key, value in expected.items()
            if key != "host_policy_revision"
        )
        or observed.get("native_version") != f"codex-cli {expected['codex_version']}"
    ):
        raise RuntimeError(
            f"shared codex built image contract differs: expected {expected}, observed {observed}"
        )
    # Native image directories initialize uid-10001 account/cwd volume ownership.
    for volume in (ACCOUNT_VOLUME, CWD_VOLUME):
        _run(
            [
                "docker",
                "volume",
                "create",
                "--label",
                f"com.docker.compose.project={PROJECT}",
                volume,
            ]
        )
    if _inspect(CLIENT_NETWORK, "network") is None:
        _run(
            [
                "docker",
                "network",
                "create",
                "--internal",
                "--driver",
                "bridge",
                "--opt",
                "com.docker.network.bridge.gateway_mode_ipv4=isolated",
                "--label",
                f"com.docker.compose.project={PROJECT}",
                CLIENT_NETWORK,
            ]
        )
    environment = _environment() | {
        "NEXUS_LAB_CODEX_IMAGE": image_id,
        "NEXUS_LAB_CODEX_TOKEN_SHA256": hashlib.sha256(token.encode()).hexdigest(),
        "NEXUS_LAB_CODEX_VERSION": expected["codex_version"],
        "NEXUS_LAB_CODEX_CATALOG_REVISION": expected["catalog_revision"],
        "NEXUS_LAB_CODEX_BACKEND_REVISION": expected["backend_contract_revision"],
    }
    _compose(environment, "create", "--no-build")
    return _installation(token)


def _compose_environment(container: dict[str, Any], token: str) -> dict[str, str]:
    expected = _expected()
    return _environment() | {
        "NEXUS_LAB_CODEX_IMAGE": container["Image"],
        "NEXUS_LAB_CODEX_TOKEN_SHA256": hashlib.sha256(token.encode()).hexdigest(),
        "NEXUS_LAB_CODEX_VERSION": expected["codex_version"],
        "NEXUS_LAB_CODEX_CATALOG_REVISION": expected["catalog_revision"],
        "NEXUS_LAB_CODEX_BACKEND_REVISION": expected["backend_contract_revision"],
    }


def _status() -> None:
    container = _inspect(DAEMON)
    if container is None:
        print("shared codex: not installed; run ./scripts/lab-codex enroll")
        return
    print(f"shared codex process: {container['State']['Status']}; image: {container['Image']}")
    try:
        token = _token()
        _installation(token)
        print("shared codex installed contract: compatible")
    except (ValueError, RuntimeError) as exc:
        print(str(exc))
        return
    if not container["State"]["Running"]:
        print("shared codex account/catalog: unavailable while stopped; run ./scripts/lab-codex up")
        return
    try:
        facts = _run(
            [
                "docker",
                "exec",
                DAEMON,
                "python",
                "-c",
                "import pathlib,stat; p=pathlib.Path('/var/lib/nexus-codex/auth.json'); print('present, mode '+oct(stat.S_IMODE(p.stat().st_mode)) if p.exists() else 'missing')",
            ]
        )
        print("shared codex account file: " + facts.strip())
        print(_catalog(_host_environment(token), timeout=15, diagnostics=False))
    except (RuntimeError, subprocess.TimeoutExpired):
        print(
            "shared codex authenticated catalog: unavailable; inspect docker logs nexus-lab-codex-agent-host privately and recover sign-in"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="manage the dedicated shared live codex host; account enrollment never reads personal credentials"
    )
    parser.add_argument("command", choices=("enroll", "up", "status", "down"))
    args = parser.parse_args()
    try:
        if args.command == "status":
            _status()
            return 0
        if args.command == "up":
            deadline = time.monotonic() + SETUP_SECONDS
            with _lock(exclusive=False, deadline=deadline):
                observed = _inspect(DAEMON, deadline=deadline)
                if observed and observed["State"]["Running"]:
                    token = _token()
                    _installation(token, deadline=deadline)
                    print(
                        _catalog(
                            _host_environment(token, deadline=deadline),
                            timeout=_remaining(deadline, SETUP_SECONDS),
                        )
                    )
                    return 0
        with _lock(exclusive=True):
            _drained()
            existing = _inspect(DAEMON)
            if args.command == "down":
                if existing:
                    _run(["docker", "stop", "--time", "45", existing["Id"]], timeout=55)
                if _inspect(PROXY):
                    _run(["docker", "stop", "--time", "10", PROXY], timeout=20)
                print(
                    "shared codex stopped; installation, account, capability and cwd volumes retained"
                )
                return 0
            if args.command == "enroll" and existing and existing["State"]["Running"]:
                raise RuntimeError(
                    "shared codex is running; ./scripts/lab-codex down before enrollment"
                )
            token_path = _state() / "transport-token"
            if not token_path.exists():
                if existing and existing["State"]["Running"]:
                    raise RuntimeError(
                        "shared codex transport capability is missing while running; drain and ./scripts/lab-codex down before repair"
                    )
                with os.fdopen(
                    os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
                ) as stream:
                    stream.write(secrets.token_urlsafe(32) + "\n")
            token = _token()
            try:
                container = _installation(token)
            except RuntimeError:
                if existing and existing["State"]["Running"]:
                    raise
                container = _install(token)
            if args.command == "enroll":
                _run(["docker", "start", PROXY])
                print(
                    "shared codex enrollment: native device login into the dedicated account volume; existing credentials are refused",
                    flush=True,
                )
                try:
                    _compose(
                        _compose_environment(container, token),
                        "run",
                        "--rm",
                        "--no-deps",
                        *([] if sys.stdin.isatty() else ["-T"]),
                        "nexus-codex-agent-host",
                        "python",
                        "-m",
                        "apps.codex_agent.enroll",
                        interactive=True,
                    )
                finally:
                    _run(["docker", "stop", "--time", "10", PROXY], timeout=20)
                print(
                    "shared codex account enrolled; daemon remains stopped; run ./scripts/lab-codex up"
                )
            elif container["State"]["Running"]:
                print(_catalog(_host_environment(token), timeout=15))
            else:
                container = _start(container, token, time.monotonic() + SETUP_SECONDS)
                print(_catalog(_host_environment(token), timeout=15))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"lab-codex: {exc}", file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
