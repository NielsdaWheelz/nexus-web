"""Real-filesystem HostRelease harness with Docker replaced at its process boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import socketserver
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

_BACKUP = b"fake-postgres-custom-backup\n"
_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_RESOURCE_LIMITS = {
    "postgres": (256 * 1024 * 1024, 512 * 1024 * 1024, 256),
    "caddy": (32 * 1024 * 1024, 48 * 1024 * 1024, 128),
    "api": (192 * 1024 * 1024, 320 * 1024 * 1024, 256),
    "worker-interactive": (128 * 1024 * 1024, 256 * 1024 * 1024, 256),
    "worker-background": (128 * 1024 * 1024, 448 * 1024 * 1024, 256),
    "codex-egress-policy": (32 * 1024 * 1024, 64 * 1024 * 1024, 32),
    "nexus-codex-agent-host": (128 * 1024 * 1024, 384 * 1024 * 1024, 64),
    "migration": (256 * 1024 * 1024, 512 * 1024 * 1024, 256),
}
_MIGRATION_COMMAND = [
    "sh",
    "-c",
    "cd /app/migrations && /app/.venv/bin/alembic upgrade head",
]
CURRENT_SHA = "a" * 40
CURRENT_DEPLOYMENT_ID = "dpl_Current123"
_PUBLIC_HOSTS = frozenset({"api.example.test:443", "web.example.test:443"})
_CODEX_HOST_PID = 4242
_CODEX_CAPACITY_CANARY_EXIT_CODES = {
    "not_run": 20,
    "subscription_blocked": 21,
    "failed": 22,
    "transport_retriable": 23,
}
_CODEX_HOST_CGROUP_RELATIVE = f"system.slice/docker-{'a' * 64}.scope"
_CODEX_CAPACITY_CANARY_LABEL = "nexus.release.codex-capacity-canary"
_CODEX_STATE_BOOT_GUARD = b"""#!/bin/sh
set -eu
state=/srv/nexus/codex-state
if /usr/bin/mountpoint --quiet -- "$state"; then
    exit 0
fi
if [ -L "$state" ] || { [ -e "$state" ] && [ ! -d "$state" ]; }; then
    echo "refusing unsafe Codex state underlay: $state" >&2
    exit 1
fi
/usr/bin/install -d -o root -g root -m 000 -- "$state"
/usr/bin/chown --no-dereference root:root -- "$state"
/usr/bin/chmod 000 -- "$state"
"""
_CODEX_STATE_BOOT_GUARD_UNIT = b"""[Unit]
Description=Protect the unmounted Nexus Codex credential-state underlay
DefaultDependencies=no
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nexus-codex-state-boot-guard
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
"""
_CODEX_STATE_DOCKER_DROP_IN = b"""[Unit]
Requires=nexus-codex-state-boot-guard.service
After=nexus-codex-state-boot-guard.service
"""
_CODEX_IMAGE_ENVIRONMENT = [
    "GPG_KEY=fake-gpg-key",
    "LANG=C.UTF-8",
    "NODE_ENV=production",
    "PATH=/app/.venv/bin:/usr/local/bin:/usr/bin:/bin",
    "PYTHONPATH=/app",
    "PYTHON_SHA256=" + "f" * 64,
    "PYTHON_VERSION=3.12.13",
]
_PLAYER_PROTOCOL_CORPUS = b'{"fixture":"android-player-protocol"}\n'


def _codex_host_privilege_config() -> dict[str, object]:
    return {
        "CapAdd": None,
        "CapDrop": ["ALL"],
        "DeviceRequests": None,
        "Devices": [],
        "Init": True,
        "IpcMode": "private",
        "MaskedPaths": [],
        "NanoCpus": 1_000_000_000,
        "NetworkMode": "nexus_codex_private",
        "PidMode": "",
        "Privileged": False,
        "ReadonlyRootfs": True,
        "ReadonlyPaths": [],
        "RestartPolicy": {"MaximumRetryCount": 0, "Name": "no"},
        "Dns": ["172.30.0.2"],
        "SecurityOpt": [
            "no-new-privileges:true",
            "seccomp=unconfined",
            "apparmor=nexus-codex-agent-host",
            "systempaths=unconfined",
        ],
        "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=16m"},
        "Ulimits": [
            {"Name": "core", "Soft": 0, "Hard": 0},
            {"Name": "fsize", "Soft": 1_048_576, "Hard": 1_048_576},
            {"Name": "nofile", "Soft": 64, "Hard": 64},
        ],
    }


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _load_state(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("fake Docker state must be an object")
    return value


def _save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".partial")
    temporary.write_bytes(_canonical_json(state))
    os.replace(temporary, path)


def _root_own(paths: tuple[Path, ...]) -> None:
    if os.geteuid() == 0:
        for path in paths:
            os.chown(path, 0, 0)
        return
    subprocess.run(
        ("sudo", "--non-interactive", "chown", "0:0", "--", *(str(path) for path in paths)),
        check=True,
        capture_output=True,
    )


def _nexus_worker_own(path: Path, *, mode: int = 0o700) -> None:
    if os.geteuid() == 0:
        os.chown(path, 10001, 10001)
        path.chmod(mode)
    else:
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "sh",
                "-c",
                'chown 10001:10001 "$1" && chmod "$2" "$1"',
                "nexus-test-parser-temp",
                str(path),
                f"{mode:04o}",
            ),
            check=True,
            capture_output=True,
        )


def _load_release(path: Path, module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError("release controller cannot be imported")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_bundle(root: Path, source_sha: str, manifest: dict[str, object]) -> tuple[Path, ...]:
    bundle = root / "opt/nexus/releases" / source_sha
    files = {
        "Caddyfile": b"test-caddy\n",
        "candidate-manifest.json": _canonical_json(manifest),
        "docker-compose.yml": b"name: nexus\n",
        "nexus-codex-agent-host.apparmor": (
            b"abi <abi/4.0>,\n"
            b"include <tunables/global>\n"
            b"profile nexus-codex-agent-host flags=(unconfined) {\n"
            b"  userns,\n"
            b"}\n"
        ),
        "prove-codex-capacity.sh": b"#!/usr/bin/env bash\n# immutable capacity wrapper\n",
        "release.py": b"# immutable release controller\n",
        "python/nexus/__init__.py": b"",
        "python/nexus/release_artifact.py": b"# immutable artifact decoder\n",
        "testdata/android/player-protocol.json": _PLAYER_PROTOCOL_CORPUS,
    }
    paths: list[Path] = []
    for relative, data in files.items():
        path = bundle / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o444)
        paths.append(path)
    return tuple(paths)


def write_codex_capacity_qualification(
    root: Path,
    *,
    source_sha: str,
    worker_image_id: str,
    measured_at: str | None = None,
    status: str = "passed",
) -> Path:
    if status not in {"failed", "passed"}:
        raise AssertionError("fake Codex capacity status must be failed or passed")
    path = root / "var/lib/nexus/releases/codex-capacity" / f"{source_sha}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    path.write_bytes(
        _canonical_json(
            {
                "schema_version": "nexus-codex-capacity.v2",
                "source_sha": source_sha,
                "worker_image_id": worker_image_id,
                "status": status,
                "measured_at": (
                    measured_at
                    if measured_at is not None
                    else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                ),
                "turns": (
                    [
                        {
                            "phase": phase,
                            "operation": "dossier_library",
                            "plan_id": "thorough",
                            "plan_revision": "codex-generation.2026-08-24.2",
                            "capability": "Synthesis",
                            "terminal_status": "succeeded",
                            "failure_kind": None,
                            "usage_present": True,
                            "sdk_version": "0.1.0",
                            "runtime_version": "0.1.0",
                            "tool_event_count": 0,
                            "permission_event_count": 0,
                        }
                        for phase in ("cold", "warm_1", "warm_2")
                    ]
                    if status == "passed"
                    else []
                ),
                "cgroup_memory_max": 384 * 1024 * 1024,
                "cgroup_memory_current": 32 * 1024 * 1024 if status == "passed" else 0,
                "cgroup_memory_peak": 64 * 1024 * 1024 if status == "passed" else 0,
                "minimum_mem_available": 256 * 1024 * 1024 if status == "passed" else 0,
                "maximum_memory_psi_some": 0.0,
                "maximum_memory_psi_full": 0.0,
                "oom_kill_delta": 0,
                "services": (
                    [
                        "postgres",
                        "caddy",
                        "api",
                        "worker-interactive",
                        "worker-background",
                    ]
                    if status == "passed"
                    else []
                ),
            }
        )
    )
    path.chmod(0o444)
    _root_own((path,))
    return path


def _read_http_headers(stream: Any) -> bytes:
    value = bytearray()
    while b"\r\n\r\n" not in value:
        chunk = stream.recv(4096)
        if not chunk:
            break
        value.extend(chunk)
        if len(value) > 65_536:
            raise AssertionError("test public request headers exceed their bound")
    return bytes(value)


class _PublicTLSProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, *, certificate: Path, key: Path, state_path: Path):
        self.state_path = state_path
        self.tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls_context.load_cert_chain(certificate, key)
        super().__init__(("127.0.0.1", 0), _PublicTLSProxyHandler)

    def response(
        self,
        method: str,
        host: str,
        path: str,
    ) -> tuple[int, dict[str, object] | None, dict[str, str]]:
        state = _load_state(self.state_path)
        state["public_requests"].append({"host": host, "path": path})
        _save_state(self.state_path, state)
        headers = {"Cache-Control": "no-store"}
        if method == "POST" and host == "api.example.test" and path == "/internal/agent-tools/mcp":
            mode = state["public_mcp_mode"]
            if mode == "valid":
                return 401, None, headers
            if mode == "nonempty-unauthorized":
                return 401, {"error": "unauthorized"}, headers
            if mode == "redirect":
                return 302, {}, {**headers, "Location": "https://api.example.test/version"}
            if mode == "throttled":
                return 429, None, headers
            if mode == "unavailable":
                return 503, None, headers
            return 404, {"error": "unknown-test-public-target"}, headers
        candidate_active = bool(state["candidate_active"])
        served_source_sha = (
            str(state["candidate_source_sha"]) if candidate_active else str(state["source_sha"])
        )
        served_revision = (
            str(state["candidate_revision"]) if candidate_active else str(state["current_revision"])
        )
        served_oracle_digest = (
            str(state["oracle_digest"]) if candidate_active else str(state["current_oracle_digest"])
        )
        if host == "web.example.test" and path == "/version":
            player_protocol = {
                "version": 2,
                "contract_sha256": (
                    str(state["candidate_player_protocol_sha256"])
                    if candidate_active
                    else str(state["current_player_protocol_sha256"])
                ),
            }
            if state["public_web_mode"] == "different-player-protocol":
                player_protocol["contract_sha256"] = "a" * 64
            return (
                200,
                {"source_sha": served_source_sha, "player_protocol": player_protocol},
                headers,
            )
        if host == "api.example.test" and path == "/readyz":
            return 200, {"data": {"status": "ready"}}, headers
        if host != "api.example.test" or path != "/version":
            return 404, {"error": "unknown-test-public-target"}, headers

        data: dict[str, object] = {
            "expected_database_revision": served_revision,
            "expected_oracle_manifest_digest": served_oracle_digest,
            "source_sha": served_source_sha,
            "task_contract_digest": state["task_contract_digest"],
        }
        mode = state["public_api_mode"]
        if mode == "redirect":
            return (
                302,
                {},
                {
                    **headers,
                    "Location": "https://api.example.test/redirected",
                },
            )
        if mode == "cacheable":
            headers = {"Cache-Control": "public, max-age=60"}
        elif mode == "different-task-digest":
            data["task_contract_digest"] = "e" * 64
        elif mode == "extra-inner-key":
            data["unsupported"] = True
        response: dict[str, object] = {"data": data}
        if mode == "extra-outer-key":
            response["unsupported"] = True
        return 200, response, headers


class _PublicTLSProxyHandler(socketserver.BaseRequestHandler):
    server: _PublicTLSProxy

    def handle(self) -> None:
        self.request.settimeout(10)
        connect = _read_http_headers(self.request).decode("ascii")
        request_line = connect.split("\r\n", 1)[0]
        parts = request_line.split()
        if len(parts) != 3 or parts[0] != "CONNECT" or parts[1] not in _PUBLIC_HOSTS:
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        with self.server.tls_context.wrap_socket(self.request, server_side=True) as secure:
            request = _read_http_headers(secure).decode("ascii")
            lines = request.split("\r\n")
            request_parts = lines[0].split()
            headers = {
                key.strip().lower(): value.strip()
                for line in lines[1:]
                if ":" in line
                for key, value in (line.split(":", 1),)
            }
            if len(request_parts) != 3 or request_parts[0] not in {"GET", "POST"}:
                status, payload, response_headers = (
                    405,
                    {"error": "method-not-allowed"},
                    {"Cache-Control": "no-store"},
                )
            else:
                status, payload, response_headers = self.server.response(
                    request_parts[0],
                    headers.get("host", "").split(":", 1)[0],
                    request_parts[1],
                )
            body = b"" if payload is None else _canonical_json(payload)
            reason = {
                200: "OK",
                302: "Found",
                401: "Unauthorized",
                404: "Not Found",
                405: "Method Not Allowed",
                429: "Too Many Requests",
                503: "Service Unavailable",
            }[status]
            rendered_headers = "".join(
                f"{key}: {value}\r\n" for key, value in response_headers.items()
            ).encode()
            secure.sendall(
                f"HTTP/1.1 {status} {reason}\r\n".encode()
                + rendered_headers
                + b"Connection: close\r\n"
                + (b"" if payload is None else b"Content-Type: application/json\r\n")
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
                + body
            )


@dataclass(frozen=True, slots=True)
class HostReleaseHarness:
    root: Path
    repo_root: Path
    source_sha: str
    state_path: Path
    attempt_path: Path
    fake_bin: Path
    public_proxy: _PublicTLSProxy
    public_proxy_thread: threading.Thread
    tls_certificate: Path

    def __enter__(self) -> HostReleaseHarness:
        return self

    def __exit__(self, *_error: object) -> None:
        self.public_proxy.shutdown()
        self.public_proxy.server_close()
        self.public_proxy_thread.join(timeout=5)
        owner = f"{os.getuid()}:{os.getgid()}"
        if os.geteuid() == 0:
            subprocess.run(("chown", "--recursive", owner, "--", str(self.root)), check=True)
        else:
            subprocess.run(
                (
                    "sudo",
                    "--non-interactive",
                    "chown",
                    "--recursive",
                    owner,
                    "--",
                    str(self.root),
                ),
                check=True,
                capture_output=True,
            )

    @classmethod
    def create(
        cls,
        root: Path,
        *,
        repo_root: Path,
        candidate: dict[str, object],
        current_revision: str = "0210",
    ) -> HostReleaseHarness:
        source_sha = str(candidate["source_sha"])
        images = candidate["images"]
        if not isinstance(images, dict):
            raise AssertionError("candidate images must be an object")
        api_image = str(images["api"])
        worker_image = str(images["worker"])

        current_api_image = "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "1" * 64
        current_worker_image = "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "2" * 64
        current_candidate = dict(candidate)
        current_candidate["source_sha"] = CURRENT_SHA
        current_candidate["images"] = {
            "api": current_api_image,
            "worker": current_worker_image,
        }
        current_candidate["expected_database_revision"] = current_revision
        current_candidate["expected_oracle_manifest_digest"] = "sha256:" + "d" * 64

        config = (
            "CADDY_ACME_EMAIL=operator@example.test\n"
            "CADDY_IMAGE=docker.io/library/caddy@sha256:" + "e" * 64 + "\n"
            "CADDY_SITE=api.example.test\n"
            "POSTGRES_DB=nexus\n"
            "POSTGRES_IMAGE=docker.io/library/postgres@sha256:" + "d" * 64 + "\n"
            "POSTGRES_PASSWORD=test-only\n"
            "POSTGRES_USER=nexus\n"
        ).encode()
        config_digest = hashlib.sha256(config).hexdigest()
        config_root = root / "etc/nexus/config"
        config_root.mkdir(parents=True)
        config_path = config_root / f"{config_digest}.env"
        config_path.write_bytes(config)
        config_path.chmod(0o440)
        current_config = root / "etc/nexus/current.env"
        current_config.symlink_to(config_path)

        caddy_path = root / "etc/nexus/Caddyfile"
        caddy_path.write_text("test-caddy\n", encoding="utf-8")
        caddy_path.chmod(0o444)

        candidate_bundle = _write_bundle(root, source_sha, candidate)
        current_bundle = _write_bundle(root, CURRENT_SHA, current_candidate)

        (root / "var/backups").mkdir(parents=True)
        parser_temp_root = root / "var/lib/nexus/parser-tmp"
        parser_temp_root.mkdir(parents=True)
        _nexus_worker_own(parser_temp_root)
        codex_state_container = root / "var/lib/nexus/codex-state.luks"
        codex_state_container.parent.mkdir(parents=True, exist_ok=True)
        codex_state_container.touch()
        codex_state_container.chmod(0o600)
        os.truncate(codex_state_container, 1024 * 1024 * 1024)
        codex_state_mount = root / "srv/nexus/codex-state"
        codex_state_mount.mkdir(parents=True)
        codex_profile_root = codex_state_mount / "codex" / "codex-personal"
        codex_profile_root.mkdir(parents=True)
        codex_auth = codex_profile_root / "auth.json"
        codex_auth.write_bytes(b"test-private-chatgpt-auth")
        _nexus_worker_own(codex_auth, mode=0o600)
        _nexus_worker_own(codex_profile_root)
        _nexus_worker_own(codex_profile_root.parent)
        _nexus_worker_own(codex_state_mount)
        crypttab = root / "etc/crypttab"
        crypttab.write_text("# no automatic Codex credential unlock\n", encoding="utf-8")
        crypttab.chmod(0o644)
        boot_guard = root / "usr/local/sbin/nexus-codex-state-boot-guard"
        boot_guard.parent.mkdir(parents=True)
        boot_guard.write_bytes(_CODEX_STATE_BOOT_GUARD)
        boot_guard.chmod(0o755)
        boot_guard_unit = root / "etc/systemd/system/nexus-codex-state-boot-guard.service"
        boot_guard_unit.parent.mkdir(parents=True)
        boot_guard_unit.write_bytes(_CODEX_STATE_BOOT_GUARD_UNIT)
        boot_guard_unit.chmod(0o644)
        docker_drop_in = (
            root / "etc/systemd/system/docker.service.d/20-nexus-codex-state-guard.conf"
        )
        docker_drop_in.parent.mkdir(parents=True)
        docker_drop_in.write_bytes(_CODEX_STATE_DOCKER_DROP_IN)
        docker_drop_in.chmod(0o644)
        meminfo = root / "proc/meminfo"
        meminfo.parent.mkdir(parents=True)
        meminfo.write_text(
            "MemTotal: 4194304 kB\nMemAvailable: 524288 kB\nSwapTotal: 1048576 kB\n",
            encoding="ascii",
        )
        pressure = root / "proc/pressure/memory"
        pressure.parent.mkdir(parents=True)
        pressure.write_text(
            "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
            "full avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
            encoding="ascii",
        )
        controllers = root / "sys/fs/cgroup/cgroup.controllers"
        controllers.parent.mkdir(parents=True)
        controllers.write_text("cpu io memory pids\n", encoding="ascii")
        userns_restriction = root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns"
        userns_restriction.parent.mkdir(parents=True, exist_ok=True)
        userns_restriction.write_text("1\n", encoding="ascii")
        # The capacity sampler reads the measured container's cgroup from the
        # host side (never `docker exec` into the measured cgroup): resolve the
        # fake host process's cgroup exactly the way the controller does.
        host_proc = root / "proc" / str(_CODEX_HOST_PID)
        host_proc.mkdir(parents=True)
        (host_proc / "cgroup").write_text(f"0::/{_CODEX_HOST_CGROUP_RELATIVE}\n", encoding="ascii")
        host_cgroup = root / "sys/fs/cgroup" / _CODEX_HOST_CGROUP_RELATIVE
        host_cgroup.mkdir(parents=True)
        (host_cgroup / "memory.max").write_text("402653184\n", encoding="ascii")
        (host_cgroup / "memory.current").write_text("33554432\n", encoding="ascii")
        (host_cgroup / "memory.peak").write_text("67108864\n", encoding="ascii")
        (host_cgroup / "memory.events").write_text(
            "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
            encoding="ascii",
        )
        immutable_inputs = (
            *candidate_bundle,
            *current_bundle,
            config_path,
            caddy_path,
            codex_state_container,
            crypttab,
            boot_guard,
            boot_guard_unit,
            docker_drop_in,
        )

        current_api_image_id = "sha256:" + "5" * 64
        current_worker_image_id = "sha256:" + "6" * 64
        api_image_id = "sha256:" + "8" * 64
        worker_image_id = "sha256:" + "9" * 64
        containers: dict[str, dict[str, object]] = {}
        for service, character, image in (
            (
                "postgres",
                "3",
                "docker.io/library/postgres@sha256:" + "d" * 64,
            ),
            ("caddy", "4", "docker.io/library/caddy@sha256:" + "e" * 64),
            ("api", "5", current_api_image),
            (
                "worker-interactive",
                "6",
                current_worker_image,
            ),
            (
                "worker-background",
                "7",
                current_worker_image,
            ),
            (
                "nexus-codex-agent-host",
                "a",
                current_worker_image,
            ),
            (
                "codex-egress-policy",
                "b",
                current_worker_image,
            ),
        ):
            containers[service] = {
                "id": character * 64,
                "image_id": (
                    current_worker_image_id
                    if service.startswith("worker-") or service == "nexus-codex-agent-host"
                    else "sha256:" + character * 64
                ),
                "config": {
                    "Env": (
                        [
                            "NEXUS_CODEX_CREDENTIAL_FILE=/run/nexus-codex-credential/auth.json",
                            "NEXUS_CODEX_WORKING_DIRECTORY_ROOT=/tmp/nexus-codex-turns",
                            "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                            "NEXUS_CODEX_CHAT_NETWORK_ATTESTED=true",
                            "NEXUS_CODEX_MCP_ORIGIN=https://api.example.test/internal/agent-tools/mcp",
                            *_CODEX_IMAGE_ENVIRONMENT,
                        ]
                        if service == "nexus-codex-agent-host"
                        else [
                            *_CODEX_IMAGE_ENVIRONMENT,
                            "NEXUS_CODEX_EGRESS_PROXY_IP=172.30.0.2",
                            "NEXUS_CODEX_EGRESS_MCP_HOST=api.example.test",
                        ]
                        if service == "codex-egress-policy"
                        else [
                            "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                        ]
                        if service == "api"
                        else [
                            "WORKER_LANE=interactive",
                            "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                            "NEXUS_AGENT_TOOLS_MCP_LISTEN=0.0.0.0:8001",
                            "NEXUS_AGENT_TOOLS_MCP_ORIGIN=https://api.example.test/internal/agent-tools/mcp",
                        ]
                        if service == "worker-interactive"
                        else []
                    ),
                    "Image": image,
                    **(
                        {"ExposedPorts": {"8001/tcp": {}}}
                        if service == "worker-interactive"
                        else {}
                    ),
                    "Cmd": (
                        ["python", "-m", "apps.codex_agent.main"]
                        if service == "nexus-codex-agent-host"
                        else ["python", "-m", "apps.codex_agent.egress_policy"]
                        if service == "codex-egress-policy"
                        else None
                    ),
                    "Entrypoint": None,
                    "Labels": {
                        "com.docker.compose.project": "nexus",
                        "com.docker.compose.service": service,
                    },
                    **(
                        {
                            "User": "10001:10001",
                            "WorkingDir": "/tmp",
                            "StopTimeout": 45,
                        }
                        if service == "nexus-codex-agent-host"
                        else {"User": "10002:10002", "StopTimeout": 10, "WorkingDir": "/"}
                        if service == "codex-egress-policy"
                        else {}
                    ),
                },
                "host_config": {
                    "MemoryReservation": _RESOURCE_LIMITS[service][0],
                    "Memory": _RESOURCE_LIMITS[service][1],
                    "MemorySwap": _RESOURCE_LIMITS[service][1],
                    "PidsLimit": _RESOURCE_LIMITS[service][2],
                    **(
                        _codex_host_privilege_config()
                        if service == "nexus-codex-agent-host"
                        else {
                            "CapDrop": ["ALL"],
                            "CapAdd": ["NET_BIND_SERVICE"],
                            "DeviceRequests": None,
                            "Devices": [],
                            "IpcMode": "private",
                            "NetworkMode": "nexus_codex_private",
                            "PidMode": "",
                            "Privileged": False,
                            "ReadonlyRootfs": True,
                            "RestartPolicy": {"MaximumRetryCount": 0, "Name": "unless-stopped"},
                            "SecurityOpt": ["no-new-privileges:true"],
                            "Tmpfs": {"/tmp": "rw,noexec,nosuid,nodev,size=8m"},
                        }
                        if service == "codex-egress-policy"
                        else {}
                    ),
                },
                "memory_usage": 16 * 1024 * 1024,
                "oom_killed": False,
                "pids": 8,
                "restart_count": 0,
                "running": service != "nexus-codex-agent-host",
            }

        state_path = root / "fake-docker-state.json"
        _save_state(
            state_path,
            {
                "api_image": current_api_image,
                "api_image_id": current_api_image_id,
                "candidate_api_image": api_image,
                "candidate_api_image_id": api_image_id,
                "candidate_worker_image": worker_image,
                "candidate_worker_image_id": worker_image_id,
                "current_api_image": current_api_image,
                "current_api_image_id": current_api_image_id,
                "current_worker_image": current_worker_image,
                "current_worker_image_id": current_worker_image_id,
                "activation_api_image_id": api_image_id,
                "activation_worker_image_id": worker_image_id,
                "alembic_table_exists": True,
                "apparmor_profile_load_count": 0,
                "apparmor_profile_preflight_count": 0,
                "ancestry_proofs": [],
                "backup_dump_count": 0,
                "backup_verify_count": 0,
                "candidate_health_failures_remaining": 0,
                "candidate_health_failure_delay_seconds": 0.0,
                "candidate_health_probe_count": 0,
                "codex_agent_host_health_output_override": None,
                "codex_host_contract_mutation": None,
                "codex_host_isolation_drift": None,
                "codex_capacity_canary_isolation_drift": None,
                "codex_capacity_canary_removal_failure": False,
                "codex_capacity_canary_run_name_race": False,
                "codex_capacity_canary_status": "passed",
                "codex_capacity_canary_delay_seconds": 0.0,
                "codex_capacity_during_canary_host_writes": {},
                # None, "oom_killed", or "exited": the measured host container
                # leaves during the canary turns and its cgroup vanishes with it.
                "codex_capacity_host_exit_during_canary": None,
                "codex_state_storage_kind": "encrypted",
                "codex_state_free_bytes": 512 * 1024 * 1024,
                "codex_state_live_bind_kind": "exact",
                "codex_state_boot_guard_enabled": True,
                "codex_host_startup_failure": False,
                "codex_host_mcp_probe_failure": False,
                "codex_host_network_probe_failure": False,
                # The deployed predecessor Caddy predates a Docker-native
                # healthcheck.  Keep the fake boundary honest: qualification
                # must execute the candidate's canonical in-container probe,
                # not depend on a Health object that production does not have.
                "caddy_docker_health_present": False,
                "caddy_health_probe_failure": False,
                "caddy_loaded_config_matches": True,
                "caddy_loaded_config_sha256": hashlib.sha256(b"test-caddy\n").hexdigest(),
                "caddy_reload_failures_remaining": 0,
                "caddy_validate_failures_remaining": 0,
                "candidate_health_wait_seconds": 0.0,
                "candidate_revision": str(candidate["expected_database_revision"]),
                "current_revision": current_revision,
                "commands": [],
                "containers": containers,
                "database_identity": "nexus:fake-system-id",
                "database_revision": current_revision,
                "docker_server_version": "29.5.3",
                "failure_count": 0,
                "failure_command": None,
                "forward_fix_stop_interrupt_fired": False,
                "interrupt_fired": False,
                "jobs": {},
                "migration_count": 0,
                "migration_config_hash": "0" * 64,
                "migration_interrupt_fired": False,
                "missing_services": [],
                "operation_failure_count": {},
                "operation_failures_remaining": {},
                "oracle_digest": str(candidate["expected_oracle_manifest_digest"]),
                "current_oracle_digest": str(current_candidate["expected_oracle_manifest_digest"]),
                "candidate_active": False,
                "candidate_player_protocol_sha256": hashlib.sha256(
                    _PLAYER_PROTOCOL_CORPUS
                ).hexdigest(),
                "current_player_protocol_sha256": hashlib.sha256(
                    _PLAYER_PROTOCOL_CORPUS
                ).hexdigest(),
                "public_api_mode": "valid",
                "public_mcp_mode": "valid",
                "public_web_mode": "valid",
                "public_requests": [],
                "resource_mutations": [],
                "service_mutations": [],
                "source_sha": CURRENT_SHA,
                "candidate_source_sha": source_sha,
                "task_contract_digest": "f" * 64,
                "worker_image": current_worker_image,
                "worker_image_id": current_worker_image_id,
            },
        )

        release = _load_release(
            repo_root / "deploy/hetzner/release.py",
            "nexus_host_release_behavior_setup",
        )
        write_codex_capacity_qualification(
            root,
            source_sha=source_sha,
            worker_image_id=worker_image_id,
        )
        current_manifest_path = (
            root / "opt/nexus/releases" / CURRENT_SHA / "candidate-manifest.json"
        )
        current_container_evidence = {
            service: release.ContainerEvidence(
                container_id=str(containers[service]["id"]),
                image=str(containers[service]["image_id"]),
                config_sha256=hashlib.sha256(
                    _canonical_json(containers[service]["config"])
                ).hexdigest(),
            )
            for service in _SERVICES
        }
        current_attempt = release.ReleaseAttempt(
            schema_version=1,
            source_sha=CURRENT_SHA,
            manifest_sha256=hashlib.sha256(current_manifest_path.read_bytes()).hexdigest(),
            candidate_api_image_id=current_api_image_id,
            candidate_worker_image_id=current_worker_image_id,
            predecessor_sha=None,
            forward_fix_of=None,
            containers=current_container_evidence,
            config_path=str(config_path),
            config_sha256=config_digest,
            vercel_deployment_id=CURRENT_DEPLOYMENT_ID,
            production_host="web.example.test",
            phase=release.ReleasePhase.Succeeded,
            backup=None,
            failure_code=None,
            created_at="2026-08-06T10:00:00Z",
            updated_at="2026-08-06T10:00:00Z",
        )
        current_record = release.ReleaseRecord(
            schema_version=1,
            source_sha=CURRENT_SHA,
            manifest_sha256=current_attempt.manifest_sha256,
            api_image=current_api_image,
            worker_image=current_worker_image,
            api_image_id=current_api_image_id,
            worker_image_id=current_worker_image_id,
            predecessor_sha=None,
            config_path=str(config_path),
            config_sha256=config_digest,
            database_revision=current_revision,
            expected_oracle_manifest_digest="sha256:" + "d" * 64,
            vercel_deployment_id=CURRENT_DEPLOYMENT_ID,
            production_host="web.example.test",
            verified_at="2026-08-06T10:00:00Z",
        )
        state_root = root / "var/lib/nexus/releases"
        attempt_path = state_root / "attempts" / f"{CURRENT_SHA}.json"
        record_path = state_root / "records" / f"{CURRENT_SHA}.json"
        current_pointer = state_root / "current"
        for path, value in (
            (attempt_path, current_attempt.as_json()),
            (record_path, current_record.as_json()),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(_canonical_json(value))
            path.chmod(0o440)
        current_pointer.write_text(f"{CURRENT_SHA}\n", encoding="utf-8")
        current_pointer.chmod(0o440)
        _root_own((*candidate_bundle, *current_bundle, *immutable_inputs))

        fake_bin = root / "fake-bin"
        fake_bin.mkdir()
        helper = Path(__file__).resolve()
        for command in (
            "apparmor_parser",
            "cryptsetup",
            "df",
            "docker",
            "findmnt",
            "losetup",
            "systemctl",
        ):
            executable = fake_bin / command
            executable.write_text(
                f"#!{sys.executable}\n"
                "import runpy, sys\n"
                f"sys.argv.insert(1, {command!r})\n"
                f"runpy.run_path({str(helper)!r}, run_name='__main__')\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)

        tls_root = root / "tls"
        tls_root.mkdir()
        tls_certificate = tls_root / "public.crt"
        tls_key = tls_root / "public.key"
        subprocess.run(
            (
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-sha256",
                "-nodes",
                "-days",
                "1",
                "-keyout",
                str(tls_key),
                "-out",
                str(tls_certificate),
                "-subj",
                "/CN=web.example.test",
                "-addext",
                "subjectAltName=DNS:web.example.test,DNS:api.example.test",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
                "-addext",
                "extendedKeyUsage=serverAuth",
            ),
            check=True,
            capture_output=True,
        )
        public_proxy = _PublicTLSProxy(
            certificate=tls_certificate,
            key=tls_key,
            state_path=state_path,
        )
        public_proxy_thread = threading.Thread(
            target=public_proxy.serve_forever,
            name="host-release-public-tls",
            daemon=True,
        )
        public_proxy_thread.start()
        return cls(
            root=root,
            repo_root=repo_root,
            source_sha=source_sha,
            state_path=state_path,
            attempt_path=root / "var/lib/nexus/releases/attempts" / f"{source_sha}.json",
            fake_bin=fake_bin,
            public_proxy=public_proxy,
            public_proxy_thread=public_proxy_thread,
            tls_certificate=tls_certificate,
        )

    def _environment(self, *, source_sha: str | None = None) -> dict[str, str]:
        attempted_source = self.source_sha if source_sha is None else source_sha
        proxy = f"http://127.0.0.1:{self.public_proxy.server_address[1]}"
        return {
            "HTTPS_PROXY": proxy,
            "NO_PROXY": "",
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}",
            "PYTHONPATH": f"{self.repo_root / 'python'}{os.pathsep}"
            f"{os.environ.get('PYTHONPATH', '')}",
            "PYTHONDONTWRITEBYTECODE": "1",
            "SSL_CERT_FILE": str(self.tls_certificate),
            "https_proxy": proxy,
            "no_proxy": "",
            "NEXUS_FAKE_DOCKER_STATE": str(self.state_path),
            "NEXUS_FAKE_RELEASE_ATTEMPT": str(
                self.root / "var/lib/nexus/releases/attempts" / f"{attempted_source}.json"
            ),
            "NEXUS_FAKE_REPO_ROOT": str(self.repo_root),
            "NEXUS_FAKE_TEST_GID": str(os.getgid()),
        }

    def _run_controller(
        self,
        arguments: tuple[str, ...],
        *,
        environment: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        driver = (sys.executable, "-B", *arguments)
        command = (
            driver
            if os.geteuid() == 0
            else (
                "sudo",
                "--non-interactive",
                "env",
                *(f"{key}={value}" for key, value in environment.items()),
                *driver,
            )
        )
        return subprocess.run(
            command,
            env=environment if os.geteuid() == 0 else None,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def run_apply(
        self,
        *,
        source_sha: str | None = None,
        interrupt_phase: str | None = None,
        failure_phase: str | None = None,
        interrupt_after_migration: bool = False,
        interrupt_during_forward_fix_stop: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        attempted_source = self.source_sha if source_sha is None else source_sha
        environment = self._environment(source_sha=attempted_source)
        if interrupt_phase is not None:
            environment["NEXUS_FAKE_INTERRUPT_PHASE"] = interrupt_phase
        if failure_phase is not None:
            environment["NEXUS_FAKE_FAILURE_PHASE"] = failure_phase
        if interrupt_after_migration:
            environment["NEXUS_FAKE_INTERRUPT_AFTER_MIGRATION"] = "1"
        if interrupt_during_forward_fix_stop:
            environment["NEXUS_FAKE_INTERRUPT_DURING_FORWARD_FIX_STOP"] = "1"
        arguments = (
            str(Path(__file__).resolve()),
            "apply",
            str(self.repo_root / "deploy/hetzner/release.py"),
            str(self.root),
            attempted_source,
            "dpl_Test123",
            "web.example.test",
        )
        return self._run_controller(arguments, environment=environment)

    def run_qualify_codex_capacity(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "qualify-codex-capacity",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                self.source_sha,
            ),
            environment=self._environment(),
        )

    def run_install_codex_state_boot_guard(
        self,
        *,
        source_sha: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        attempted_source = self.source_sha if source_sha is None else source_sha
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "install-codex-state-boot-guard",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                attempted_source,
            ),
            environment=self._environment(source_sha=attempted_source),
        )

    def run_activate_caddy_config(
        self,
        *,
        source_sha: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        attempted_source = self.source_sha if source_sha is None else source_sha
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "activate-caddy-config",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                attempted_source,
            ),
            environment=self._environment(source_sha=attempted_source),
        )

    def run_resume_codex_agent_host(
        self,
        *,
        source_sha: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        attempted_source = self.source_sha if source_sha is None else source_sha
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "resume-codex-agent-host",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                attempted_source,
            ),
            environment=self._environment(source_sha=attempted_source),
        )

    def install_candidate(self, candidate: dict[str, object]) -> str:
        source_sha = str(candidate["source_sha"])
        source = self.root / "opt/nexus/releases" / self.source_sha
        destination = self.root / "opt/nexus/releases" / source_sha
        installed: list[Path] = []
        for item in source.rglob("*"):
            if not item.is_file():
                continue
            relative = item.relative_to(source)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(
                _canonical_json(candidate)
                if relative == Path("candidate-manifest.json")
                else item.read_bytes()
            )
            target.chmod(0o444)
            installed.append(target)
        _root_own(tuple(installed))
        images = candidate["images"]
        if not isinstance(images, dict):
            raise AssertionError("candidate images must be an object")
        self.update_state(
            api_image=str(images["api"]),
            candidate_api_image=str(images["api"]),
            candidate_revision=str(candidate["expected_database_revision"]),
            oracle_digest=str(candidate["expected_oracle_manifest_digest"]),
            candidate_source_sha=source_sha,
            worker_image=str(images["worker"]),
            candidate_worker_image=str(images["worker"]),
            candidate_active=False,
        )
        write_codex_capacity_qualification(
            self.root,
            source_sha=source_sha,
            worker_image_id=str(self.state()["candidate_worker_image_id"]),
        )
        return source_sha

    def run_finalize(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "finalize",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                self.source_sha,
                "dpl_Test123",
            ),
            environment=self._environment(),
        )

    def run_verify_current(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "verify-current",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                CURRENT_SHA,
            ),
            environment=self._environment(source_sha=CURRENT_SHA),
        )

    def run_fail_bound_frontend(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "fail-bound-frontend",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                self.source_sha,
                "dpl_Test123",
            ),
            environment=self._environment(),
        )

    def run_fail_auth_smoke(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                str(Path(__file__).resolve()),
                "fail-auth-smoke",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                self.source_sha,
                "dpl_Test123",
            ),
            environment=self._environment(),
        )

    def state(self) -> dict[str, Any]:
        return _load_state(self.state_path)

    def update_state(self, **changes: object) -> None:
        state = self.state()
        state.update(changes)
        _save_state(self.state_path, state)


def _attempt_phase() -> str | None:
    raw = os.environ.get("NEXUS_FAKE_RELEASE_ATTEMPT")
    if raw is None or not Path(raw).exists():
        return None
    value = json.loads(Path(raw).read_text(encoding="utf-8"))
    return str(value["phase"])


def _container(state: dict[str, Any], container_id: str) -> dict[str, Any]:
    containers = state["containers"]
    if not isinstance(containers, dict):
        raise AssertionError("fake container state is malformed")
    # Real `docker inspect` resolves a unique id prefix, which is what callers
    # get back from a truncated `docker ps --quiet`.
    matched = [
        container
        for container in containers.values()
        if isinstance(container, dict) and str(container.get("id", "")).startswith(container_id)
    ]
    if len(matched) == 1:
        return matched[0]
    raise AssertionError(f"unknown fake container {container_id}")


def _container_inspect(state: dict[str, Any], container_id: str) -> dict[str, object]:
    container = _container(state, container_id)
    config = container["config"]
    labels = config.get("Labels") if isinstance(config, dict) else None
    service = labels.get("com.docker.compose.service") if isinstance(labels, dict) else None
    health: dict[str, object] = {"Status": "healthy"}
    if service in {"worker-interactive", "worker-background"}:
        active = bool(state["candidate_active"])
        payload = {
            "expected_database_revision": (
                state["candidate_revision"] if active else state["current_revision"]
            ),
            "expected_oracle_manifest_digest": (
                state["oracle_digest"] if active else state["current_oracle_digest"]
            ),
            "lane": service.removeprefix("worker-"),
            "source_sha": state["candidate_source_sha"] if active else state["source_sha"],
            "status": "ready",
            "task_contract_digest": state["task_contract_digest"],
        }
        output = container.get("health_output_override")
        ended_at = container.get("health_end_override")
        if not isinstance(ended_at, str):
            ended_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        health = {
            "FailingStreak": 0,
            "Log": [
                {
                    "End": ended_at,
                    "ExitCode": 0,
                    "Output": (
                        output
                        if isinstance(output, str)
                        else _canonical_json(payload).decode("utf-8")
                    ),
                    "Start": ended_at,
                }
            ],
            "Status": "healthy",
        }
    health_status = container.get("health_status_override")
    if isinstance(health_status, str):
        health["Status"] = health_status
    state_value: dict[str, object] = {
        "Health": health,
        "OOMKilled": container["oom_killed"],
        "Paused": False,
        "Restarting": False,
        "Running": container["running"],
        "Pid": _CODEX_HOST_PID if service == "nexus-codex-agent-host" else 1,
    }
    if service == "caddy" and state["caddy_docker_health_present"] is False:
        state_value.pop("Health")
    inspected: dict[str, object] = {
        "Config": container["config"],
        "HostConfig": container["host_config"],
        "Image": container["image_id"],
        "RestartCount": container["restart_count"],
        "State": state_value,
    }
    default_addresses = {
        "postgres": "172.28.0.2",
        "caddy": "172.28.0.3",
        "api": "172.28.0.4",
        "worker-interactive": "172.28.0.5",
        "worker-background": "172.28.0.6",
    }
    if isinstance(service, str) and service in default_addresses:
        inspected["NetworkSettings"] = {
            "Networks": {"nexus_default": {"IPAddress": default_addresses[service]}},
            "Ports": {},
        }
    if container_id == state["containers"]["postgres"]["id"]:
        inspected["Mounts"] = [
            {
                "Destination": "/var/lib/postgresql/data",
                "Name": "nexus_postgres_data",
                "RW": True,
                "Type": "volume",
            }
        ]
    if container_id == state["containers"]["caddy"]["id"]:
        root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
        inspected["Mounts"] = [
            {
                "Destination": "/etc/caddy/Caddyfile",
                "RW": False,
                "Source": str((root / "etc/nexus/Caddyfile").resolve()),
                "Type": "bind",
            },
            {
                "Destination": "/config",
                "Name": "nexus_caddy_config",
                "RW": True,
                "Type": "volume",
            },
            {
                "Destination": "/data",
                "Name": "nexus_caddy_data",
                "RW": True,
                "Type": "volume",
            },
        ]
    if container_id == state["containers"]["api"]["id"]:
        api_mounts: list[dict[str, object]] = [
            {
                "Destination": "/run/nexus-codex",
                "Name": "nexus_nexus_codex_run",
                "RW": False,
                "Source": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
                "Type": "volume",
            }
        ]
        mutation = state["codex_host_contract_mutation"]
        if mutation == "api_socket_missing":
            container["config"]["Env"] = []
        elif mutation == "api_mount_missing":
            api_mounts = []
        elif mutation == "api_mount_writable":
            api_mounts[0]["RW"] = True
        elif mutation == "api_mount_extra":
            api_mounts.append(
                {
                    "Destination": "/host-home",
                    "RW": False,
                    "Source": "/home/nexus",
                    "Type": "bind",
                }
            )
        inspected["Mounts"] = api_mounts
    if container_id == state["containers"]["codex-egress-policy"]["id"]:
        mutation = state["codex_host_contract_mutation"]
        if mutation == "policy_privileged":
            container["host_config"]["Privileged"] = True
        inspected["Mounts"] = []
        inspected["NetworkSettings"] = {
            "Networks": {
                "nexus_codex_private": {"IPAddress": "172.30.0.2"},
                "nexus_codex_proxy_egress": {},
            },
            "Ports": {},
        }
    if container_id == state["containers"]["worker-interactive"]["id"]:
        inspected["Mounts"] = [
            {
                "Destination": "/run/nexus-codex",
                "Name": "nexus_nexus_codex_run",
                "RW": False,
                "Source": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
                "Type": "volume",
            }
        ]
    if container_id == state["containers"]["nexus-codex-agent-host"]["id"]:
        root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
        mounts: list[dict[str, object]] = [
            {
                "Destination": "/run/nexus-codex-credential/auth.json",
                "Mode": "rw",
                "RW": True,
                "Source": str(root / "srv/nexus/codex-state/codex/codex-personal/auth.json"),
                "Type": "bind",
                "Propagation": "rprivate",
            },
            {
                "Destination": "/run/nexus-codex",
                "Name": "nexus_nexus_codex_run",
                "RW": True,
                "Source": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
                "Type": "volume",
            },
        ]
        mutation = state["codex_host_contract_mutation"]
        live_bind = state["codex_state_live_bind_kind"]
        if live_bind == "wrong_source":
            mounts[0]["Source"] = "/srv/nexus/foreign-codex-state/auth.json"
        elif live_bind == "wrong_type":
            mounts[0]["Type"] = "volume"
            mounts[0]["Name"] = "nexus_unapproved_state"
        elif live_bind == "readonly":
            mounts[0]["Mode"] = "ro"
            mounts[0]["RW"] = False
        elif live_bind == "shared_propagation":
            mounts[0]["Propagation"] = "rshared"
        if mutation == "environment_credential_residue":
            container["config"]["Env"].append("AWS_SESSION_TOKEN=credential-residue")
        elif mutation == "host_cmd":
            container["config"]["Cmd"] = ["sh"]
        elif mutation == "host_privileged":
            container["host_config"]["Privileged"] = True
        elif mutation == "mount_wrong_named_volume":
            mounts[0]["Type"] = "volume"
            mounts[0]["Name"] = "nexus_unapproved_state"
        elif mutation == "mount_wrong_source":
            mounts[1]["Source"] = "/var/lib/docker/volumes/nexus_unapproved_run/_data"
        elif mutation == "mount_readonly_docker_socket":
            mounts.append(
                {
                    "Destination": "/var/run/docker.sock",
                    "RW": False,
                    "Source": "/var/run/docker.sock",
                    "Type": "bind",
                }
            )
        elif mutation == "mount_readonly_host_home":
            mounts.append(
                {
                    "Destination": "/host-home",
                    "RW": False,
                    "Source": "/home/nexus",
                    "Type": "bind",
                }
            )
        inspected["Mounts"] = mounts
        inspected["NetworkSettings"] = {
            "Networks": (
                {"nexus_default": {}}
                if state["codex_host_isolation_drift"] == "network"
                else {"nexus_codex_private": {"IPAddress": "172.30.0.3"}}
            ),
            "Ports": {},
        }
    return inspected


def _compose_operation(arguments: list[str]) -> list[str]:
    try:
        file_index = arguments.index("--file")
    except ValueError as exc:
        raise AssertionError("fake Compose command has no --file boundary") from exc
    operation = arguments[file_index + 2 :]
    # Global flags may follow --file before the subcommand, as with `--profile`
    # for the release-gated migration one-off.
    while operation[:1] == ["--profile"]:
        operation = operation[2:]
    return operation


def _semantic_operation(arguments: list[str], *, candidate_active: bool) -> str | None:
    if not arguments or arguments[0] != "compose":
        return None
    operation = _compose_operation(arguments)
    if operation[:3] == ["up", "--detach", "--no-deps"]:
        return "backend-compose-up"
    if operation[:3] == ["exec", "-T", "api"] and "/version" in " ".join(operation[3:]):
        return "backend-api-version" if candidate_active else "current-api-version"
    return None


def _write_json(value: object) -> None:
    sys.stdout.buffer.write(_canonical_json(value))


def _stop_timeout_matches(operation: list[str]) -> bool:
    """Accept only the exact stop budget each service contract publishes.

    Application writers stop within 30 seconds; the Codex host alone is granted its
    45-second graceful-stop budget (request drain, runtime close, exit margin), and a
    stop that mixes the host into a writer stop or grants it any other budget is not
    the release contract.
    """
    timeout, services = operation[2], operation[3:]
    if "nexus-codex-agent-host" in services:
        return timeout == "45"
    return timeout == "30"


def _handle_compose(state: dict[str, Any], operation: list[str]) -> None:
    if operation == ["config", "--quiet"]:
        return
    if operation[:3] == ["ps", "--all", "--quiet"]:
        service = operation[3]
        if service not in state["missing_services"]:
            sys.stdout.write(str(state["containers"][service]["id"]) + "\n")
        return
    if operation[:2] == ["ps", "--quiet"]:
        service = operation[2]
        sys.stdout.write(str(state["containers"][service]["id"]) + "\n")
        return
    if operation[:2] == ["stop", "--timeout"] and _stop_timeout_matches(operation):
        services = operation[3:]
        for service in services:
            if service not in state["missing_services"]:
                state["containers"][service]["running"] = False
        state["service_mutations"].append({"operation": "stop", "services": services})
        if (
            os.environ.get("NEXUS_FAKE_INTERRUPT_DURING_FORWARD_FIX_STOP") == "1"
            and state["failure_count"] == 2
            and not state["forward_fix_stop_interrupt_fired"]
        ):
            state["forward_fix_stop_interrupt_fired"] = True
            _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
            os.kill(os.getppid(), signal.SIGKILL)
        return
    if operation[:6] == [
        "up",
        "--detach",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        "90",
    ]:
        services = operation[6:]
        if any(service in _WRITERS for service in services):
            state["candidate_active"] = True
        for service in services:
            container = state["containers"][service]
            container["running"] = True
            reservation, memory, pids = _RESOURCE_LIMITS[service]
            container["host_config"].update(
                {
                    "MemoryReservation": reservation,
                    "Memory": memory,
                    "MemorySwap": memory,
                    "PidsLimit": pids,
                }
            )
            if service == "nexus-codex-agent-host":
                container["host_config"].update(_codex_host_privilege_config())
                if state["codex_host_isolation_drift"] == "security":
                    container["host_config"]["SecurityOpt"] = [
                        "no-new-privileges:true",
                        "seccomp=unconfined",
                    ]
                if state["codex_host_isolation_drift"] == "systempaths_missing":
                    container["host_config"]["SecurityOpt"] = [
                        "no-new-privileges:true",
                        "seccomp=unconfined",
                        "apparmor=nexus-codex-agent-host",
                    ]
                if state["codex_host_isolation_drift"] == "systempaths_mutated":
                    container["host_config"]["SecurityOpt"] = [
                        "no-new-privileges:true",
                        "seccomp=unconfined",
                        "apparmor=nexus-codex-agent-host",
                        "systempaths=confined",
                    ]
                if state["codex_host_isolation_drift"] == "nanocpus":
                    container["host_config"]["NanoCpus"] = 2_000_000_000
                if state["codex_host_isolation_drift"] == "masked_paths":
                    container["host_config"]["MaskedPaths"] = ["/proc/kcore"]
                if state["codex_host_isolation_drift"] == "readonly_paths":
                    container["host_config"]["ReadonlyPaths"] = ["/proc/sys"]
                if state["codex_host_isolation_drift"] == "tmpfs":
                    container["host_config"]["Tmpfs"] = {"/tmp": "rw,nosuid,nodev,size=64m"}
                if state["codex_host_isolation_drift"] == "ulimits":
                    container["host_config"]["Ulimits"] = [
                        {"Name": "core", "Soft": 0, "Hard": 0},
                        {"Name": "fsize", "Soft": 1_048_576, "Hard": 1_048_576},
                    ]
            if service == "api":
                container["image_id"] = state["activation_api_image_id"]
                container["config"]["Image"] = state["candidate_api_image"]
            else:
                container["image_id"] = state["activation_worker_image_id"]
                container["config"]["Image"] = state["candidate_worker_image"]
        state["service_mutations"].append({"operation": "up", "services": services})
        if services == ["nexus-codex-agent-host"] and state["codex_host_startup_failure"] is True:
            _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
            raise SystemExit(72)
        remaining = state["candidate_health_failures_remaining"]
        if remaining < 0:
            state["candidate_health_probe_count"] += 1
            state["candidate_health_wait_seconds"] += float(
                state["candidate_health_failure_delay_seconds"]
            )
            _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
            raise SystemExit(72)
        if remaining > 0:
            state["candidate_health_probe_count"] += remaining
            state["candidate_health_failures_remaining"] = 0
            state["candidate_health_wait_seconds"] += (
                float(state["candidate_health_failure_delay_seconds"]) * remaining
            )
        return
    if operation[:3] == ["exec", "-T", "postgres"]:
        command = " ".join(operation[3:])
        if "pg_dump -Fc" in command:
            state["backup_dump_count"] += 1
            sys.stdout.buffer.write(_BACKUP)
        elif "pg_restore --list" in command:
            if sys.stdin.buffer.read() != _BACKUP:
                raise AssertionError("backup verifier did not receive the exact dump")
            state["backup_verify_count"] += 1
            sys.stdout.write("; fake PostgreSQL archive\n")
        elif "to_regclass" in command:
            if state["alembic_table_exists"]:
                sys.stdout.write("alembic_version\n")
        elif "SELECT version_num" in command:
            if state["database_revision"] is not None:
                sys.stdout.write(str(state["database_revision"]) + "\n")
        elif "pg_control_system" in command:
            sys.stdout.write(str(state["database_identity"]) + "\n")
        elif "pg_database_size" in command:
            sys.stdout.write("1\n")
        else:
            raise AssertionError(f"unsupported fake PostgreSQL command: {command}")
        return
    if operation[:3] == ["exec", "-T", "api"]:
        command = " ".join(operation[3:])
        if "127.0.0.1:8000/version" in command:
            active = bool(state["candidate_active"])
            _write_json(
                {
                    "data": {
                        "expected_database_revision": (
                            state["candidate_revision"] if active else state["current_revision"]
                        ),
                        "expected_oracle_manifest_digest": (
                            state["oracle_digest"] if active else state["current_oracle_digest"]
                        ),
                        "source_sha": (
                            state["candidate_source_sha"] if active else state["source_sha"]
                        ),
                        "task_contract_digest": state["task_contract_digest"],
                    }
                }
            )
        elif "127.0.0.1:8000/readyz" in command:
            if not state["candidate_active"]:
                return
            state["candidate_health_probe_count"] += 1
            remaining = state["candidate_health_failures_remaining"]
            if remaining != 0:
                if remaining > 0:
                    state["candidate_health_failures_remaining"] -= 1
                state["candidate_health_wait_seconds"] += float(
                    state["candidate_health_failure_delay_seconds"]
                )
                _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
                raise SystemExit(72)
        else:
            raise AssertionError(f"unsupported fake API command: {command}")
        return
    if operation[:3] == ["exec", "-T", "caddy"]:
        command = operation[3:]
        if command == [
            "wget",
            "-q",
            "-O",
            "/dev/null",
            "http://127.0.0.1:2019/config/",
        ]:
            if state["caddy_health_probe_failure"] is True:
                raise SystemExit(72)
            return
        if command == [
            "caddy",
            "adapt",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        ]:
            root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
            digest = hashlib.sha256((root / "etc/nexus/Caddyfile").read_bytes()).hexdigest()
            _write_json({"caddyfile_sha256": digest})
            return
        if command == [
            "caddy",
            "adapt",
            "--config",
            "/dev/stdin",
            "--adapter",
            "caddyfile",
        ]:
            value = sys.stdin.buffer.read()
            if not value:
                raise AssertionError("fake Caddy stdin adaptation requires bytes")
            _write_json({"caddyfile_sha256": hashlib.sha256(value).hexdigest()})
            return
        if command == [
            "caddy",
            "validate",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        ]:
            if state["caddy_validate_failures_remaining"] > 0:
                state["caddy_validate_failures_remaining"] -= 1
                _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
                raise SystemExit(72)
            return
        if command == [
            "caddy",
            "reload",
            "--config",
            "/etc/caddy/Caddyfile",
            "--adapter",
            "caddyfile",
        ]:
            if state["caddy_reload_failures_remaining"] > 0:
                state["caddy_reload_failures_remaining"] -= 1
                _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
                raise SystemExit(72)
            root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
            state["caddy_loaded_config_sha256"] = hashlib.sha256(
                (root / "etc/nexus/Caddyfile").read_bytes()
            ).hexdigest()
            state["caddy_loaded_config_matches"] = True
            _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
            return
        if command == [
            "wget",
            "-q",
            "-O",
            "-",
            "http://127.0.0.1:2019/config/",
        ]:
            loaded = (
                {"caddyfile_sha256": state["caddy_loaded_config_sha256"]}
                if state["caddy_loaded_config_matches"] is True
                else {"apps": {}}
            )
            _write_json(loaded)
            return
        raise AssertionError(f"unsupported fake Caddy command: {command!r}")
    if operation[:3] == ["exec", "-T", "nexus-codex-agent-host"]:
        command = operation[3:]
        if command == ["python", "-m", "apps.codex_agent.sandbox_health"]:
            return
        if command[:3] == ["python", "-m", "apps.codex_agent.network_health"]:
            if state["codex_host_network_probe_failure"] is True:
                raise SystemExit(72)
            if command[3:4] == ["--mcp-origin"] and state["codex_host_mcp_probe_failure"] is True:
                raise SystemExit(72)
            if command[3:] not in [
                [
                    "--denied-targets",
                    "172.30.0.1:80",
                    "172.30.0.1:443",
                    "172.28.0.2:5432",
                    "172.28.0.3:443",
                ],
                [
                    "--mcp-origin",
                    "https://api.example.test/internal/agent-tools/mcp",
                ],
            ]:
                raise AssertionError(f"unexpected fake Codex network proof: {command!r}")
            return
        if command == ["python", "-m", "apps.codex_agent.health"]:
            override = state["codex_agent_host_health_output_override"]
            if override is not None:
                sys.stdout.write(str(override))
                return
            _write_json(
                {
                    "auth_profile": "codex-personal",
                    "backend": "codex",
                    "schema_version": "nexus-generation-health.v2",
                    "status": "ready",
                    "transport": "sdk",
                    "command_schema_version": "nexus-generation-command.v2",
                    "policy_revision": "codex-generation.2026-08-24.2",
                    "sdk_version": "0.144.4",
                    "runtime_version": "0.144.4",
                }
            )
            return
        raise AssertionError(f"unsupported fake Codex agent host command: {command!r}")
    if operation[:2] == ["run", "--name"]:
        name = operation[2]
        service = operation[5]
        state["migration_count"] += 1
        state["database_revision"] = state["candidate_revision"]
        reservation, memory, pids = _RESOURCE_LIMITS[service]
        state["jobs"][name] = {
            "config": {
                "Cmd": _MIGRATION_COMMAND,
                "Image": state["candidate_api_image"],
                "Labels": {
                    "com.docker.compose.config-hash": state["migration_config_hash"],
                    "com.docker.compose.oneoff": "True",
                    "com.docker.compose.project": "nexus",
                    "com.docker.compose.service": "migration",
                },
            },
            "exit_code": 0,
            "host_config": {
                "MemoryReservation": reservation,
                "Memory": memory,
                "MemorySwap": memory,
                "PidsLimit": pids,
            },
            "id": "8" * 64,
            "image_id": state["candidate_api_image_id"],
            "logs": "migration complete\n",
            "name": f"/{name}",
            "running": False,
        }
        if (
            os.environ.get("NEXUS_FAKE_INTERRUPT_AFTER_MIGRATION") == "1"
            and not state["migration_interrupt_fired"]
        ):
            state["migration_interrupt_fired"] = True
            _save_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]), state)
            os.kill(os.getppid(), signal.SIGKILL)
        return
    raise AssertionError(f"unsupported fake Compose operation: {operation!r}")


def fake_docker_main() -> int:
    state_path = Path(os.environ["NEXUS_FAKE_DOCKER_STATE"])
    state = _load_state(state_path)
    arguments = sys.argv[2:]
    state["commands"].append(arguments)
    # A failed fake command is still an attempted external effect and must remain auditable.
    _save_state(state_path, state)
    phase = _attempt_phase()
    interrupt_phase = os.environ.get("NEXUS_FAKE_INTERRUPT_PHASE")
    if interrupt_phase is not None and phase == interrupt_phase and not state["interrupt_fired"]:
        state["interrupt_fired"] = True
        _save_state(state_path, state)
        os.kill(os.getppid(), signal.SIGKILL)
        return 0
    failure_phase = os.environ.get("NEXUS_FAKE_FAILURE_PHASE")
    if failure_phase is not None and phase == failure_phase and state["failure_count"] < 2:
        # Phase failure proves exhaustion of one retry budget. Pin the first
        # command so phase-entry preflights cannot spend the attempts on two
        # independent operations and accidentally let the release succeed.
        failure_command = state["failure_command"]
        if failure_command is None:
            state["failure_command"] = arguments
            failure_command = arguments
        if arguments == failure_command:
            state["failure_count"] += 1
            _save_state(state_path, state)
            return 72
    semantic_operation = _semantic_operation(
        arguments,
        candidate_active=bool(state["candidate_active"]),
    )
    remaining = state["operation_failures_remaining"].get(semantic_operation, 0)
    if remaining > 0:
        state["operation_failures_remaining"][semantic_operation] = remaining - 1
        failures = state["operation_failure_count"]
        failures[semantic_operation] = failures.get(semantic_operation, 0) + 1
        _save_state(state_path, state)
        return 72

    if arguments[:3] == ["version", "--format", "{{.Server.Version}}"]:
        sys.stdout.write(str(state["docker_server_version"]) + "\n")
    elif arguments[0] == "compose":
        _handle_compose(state, _compose_operation(arguments))
    elif arguments[:2] == ["image", "inspect"]:
        image = arguments[2]
        image_map = {
            state["current_api_image"]: state["current_api_image_id"],
            state["current_worker_image"]: state["current_worker_image_id"],
            state["candidate_api_image"]: state["candidate_api_image_id"],
            state["candidate_worker_image"]: state["candidate_worker_image_id"],
        }
        image_id = image_map.get(image)
        if image_id is None:
            raise AssertionError(f"unknown fake image {image!r}")
        source_sha = (
            state["candidate_source_sha"]
            if image
            in {
                state["candidate_api_image"],
                state["candidate_worker_image"],
            }
            else state["source_sha"]
        )
        _write_json(
            [
                {
                    "Config": {
                        "Env": _CODEX_IMAGE_ENVIRONMENT,
                        "Labels": {"org.opencontainers.image.revision": source_sha},
                    },
                    "Id": image_id,
                }
            ]
        )
    elif arguments[:2] == ["volume", "inspect"]:
        volume = arguments[2]
        mountpoints = {
            "nexus_nexus_codex_run": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
        }
        mountpoint = mountpoints.get(volume)
        if mountpoint is None:
            raise AssertionError(f"unknown fake volume {volume!r}")
        _write_json(
            [
                {
                    "Driver": "local",
                    "Mountpoint": mountpoint,
                    "Name": volume,
                    "Options": {},
                    "Scope": "local",
                }
            ]
        )
    elif arguments[0] == "pull":
        pass
    elif arguments[0] == "run":
        if arguments[:3] == ["run", "--detach", "--name"]:
            name = arguments[3]
            reservation, memory, pids = _RESOURCE_LIMITS["nexus-codex-agent-host"]
            source_sha = name.removeprefix("nexus-codex-capacity-")
            expected = [
                "run",
                "--detach",
                "--name",
                name,
                "--label",
                f"{_CODEX_CAPACITY_CANARY_LABEL}={source_sha}",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--cpus",
                "1.0",
                "--memory-reservation",
                str(reservation),
                "--memory",
                str(memory),
                "--memory-swap",
                str(memory),
                "--pids-limit",
                str(pids),
                "--user",
                "10001:10001",
                "--env",
                "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                "--mount",
                "type=volume,src=nexus_nexus_codex_run,dst=/run/nexus-codex,readonly",
                "--entrypoint",
                "sh",
                state["candidate_worker_image"],
                "-c",
                "while :; do sleep 3600; done",
            ]
            if not name.startswith("nexus-codex-capacity-") or arguments != expected:
                raise AssertionError("Codex capacity canary differs from fixed contract")
            if state["codex_capacity_canary_run_name_race"] is True:
                state["capacity_canary"] = {
                    "id": "d" * 64,
                    "name": name,
                    "label": "f" * 40,
                    "running": True,
                }
                sys.stderr.write(
                    "docker: Error response from daemon: Conflict. The container name "
                    f"/{name} is already in use.\n"
                )
                _save_state(state_path, state)
                return 125
            state["capacity_canary"] = {
                "id": "c" * 64,
                "name": name,
                "label": source_sha,
                "running": True,
            }
            sys.stdout.write("c" * 64 + "\n")
        elif "cat" in arguments and "/app/runtime-identity.json" in arguments:
            image = arguments[-2]
            active = image in {
                state["candidate_api_image"],
                state["candidate_worker_image"],
            }
            _write_json(
                {
                    "expected_database_revision": (
                        state["candidate_revision"] if active else state["current_revision"]
                    ),
                    "expected_oracle_manifest_digest": (
                        state["oracle_digest"] if active else state["current_oracle_digest"]
                    ),
                    "source_sha": (
                        state["candidate_source_sha"] if active else state["source_sha"]
                    ),
                }
            )
        elif "-c" in arguments:
            script_index = arguments.index("-c")
            script = arguments[script_index + 1]
            if "ScriptDirectory" not in script:
                raise AssertionError(f"unsupported fake Docker run script: {script!r}")
            repo_root = Path(os.environ["NEXUS_FAKE_REPO_ROOT"])
            adapted = script.replace(
                "/app/migrations/alembic.ini",
                str(repo_root / "migrations/alembic.ini"),
            ).replace(
                "/app/migrations/alembic",
                str(repo_root / "migrations/alembic"),
            )
            completed = subprocess.run(
                (
                    sys.executable,
                    "-c",
                    adapted,
                    *arguments[script_index + 2 :],
                ),
                check=False,
                capture_output=True,
            )
            sys.stdout.buffer.write(completed.stdout)
            sys.stderr.buffer.write(completed.stderr)
            if completed.returncode == 0:
                state["ancestry_proofs"].append(json.loads(completed.stdout))
            _save_state(state_path, state)
            return completed.returncode
    elif arguments[:4] == ["ps", "--all", "--quiet", "--filter"]:
        name = arguments[4].removeprefix("name=^/").removesuffix("$")
        job = state["jobs"].get(name)
        if job is not None:
            sys.stdout.write(str(job["id"]) + "\n")
        canary = state.get("capacity_canary")
        if isinstance(canary, dict) and canary.get("name") == name:
            sys.stdout.write(str(canary["id"]) + "\n")
    elif arguments[:2] == ["ps", "--quiet"] and set(arguments[2:]) <= {"--no-trunc"}:
        # Real `docker ps --quiet` truncates to 12 characters unless --no-trunc
        # is given; callers that compare against full Compose ids must ask for
        # the untruncated form.
        untruncated = "--no-trunc" in arguments[2:]
        for container in state["containers"].values():
            if container["running"]:
                container_id = str(container["id"])
                sys.stdout.write((container_id if untruncated else container_id[:12]) + "\n")
    elif arguments[:4] == ["stats", "--no-stream", "--format", "{{json .}}"]:
        for container_id in arguments[4:]:
            container = _container(state, container_id)
            if not container["running"]:
                continue
            usage = int(container["memory_usage"])
            _write_json(
                {
                    "ID": container_id[:12],
                    "MemUsage": f"{usage / 1024 / 1024:g}MiB / 2GiB",
                    "PIDs": str(container["pids"]),
                }
            )
    elif arguments[0] == "update":
        container_id = arguments[-1]
        container = _container(state, container_id)
        reservation = int(arguments[arguments.index("--memory-reservation") + 1])
        memory = int(arguments[arguments.index("--memory") + 1])
        pids = int(arguments[arguments.index("--pids-limit") + 1])
        if "--memory-swap" not in arguments:
            # Real dockerd refuses this: "Memory limit should be smaller than
            # already set memoryswap limit, update the memoryswap at the same
            # time". Accepting it here would let a controller that can never
            # converge a real host pass every proof.
            sys.stderr.write(
                f"Error response from daemon: Cannot update container {container_id}: "
                "Memory limit should be smaller than already set memoryswap limit, "
                "update the memoryswap at the same time\n"
            )
            return 1
        memory_swap = int(arguments[arguments.index("--memory-swap") + 1])
        container["host_config"].update(
            {
                "MemoryReservation": reservation,
                "Memory": memory,
                "MemorySwap": memory_swap,
                "PidsLimit": pids,
            }
        )
        service = next(name for name, item in state["containers"].items() if item is container)
        state["resource_mutations"].append(
            {
                "memory": memory,
                "pids": pids,
                "reservation": reservation,
                "service": service,
            }
        )
        sys.stdout.write(container_id + "\n")
    elif arguments[:2] == ["exec", "c" * 64]:
        command = arguments[2:]
        if command == ["python", "-m", "apps.codex_agent.capacity_canary"]:
            # A real host's counters move while the canary turns run: apply the
            # scripted mid-turn host mutations before responding so the
            # controller's own sampling observes them.
            root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
            host_writes = state["codex_capacity_during_canary_host_writes"]
            for relative, contents in host_writes.items():
                # Atomic replace: the controller's sampler thread reads these
                # files concurrently, and a torn in-place write would let a
                # breach proof flake on a half-written counter instead of the
                # scripted mutation. The staged file keeps the target's exact
                # owner and mode -- this fake runs under sudo, so a plain
                # replace would leave a root-owned file the test process could
                # no longer restore in its healthy-host teardown.
                target = root / str(relative)
                original = target.stat()
                staged = target.with_name(target.name + ".canary-write")
                staged.write_text(str(contents), encoding="ascii")
                os.chmod(staged, original.st_mode & 0o7777)
                os.chown(staged, original.st_uid, original.st_gid)
                os.replace(staged, target)
            host_exit = state["codex_capacity_host_exit_during_canary"]
            if host_exit is not None:
                # The kernel removes a dead container's cgroup; the controller's
                # counters disappear and only `docker inspect` can say why.
                host = state["containers"]["nexus-codex-agent-host"]
                host["running"] = False
                host["oom_killed"] = host_exit == "oom_killed"
                _save_state(state_path, state)
                cgroup = root / "sys/fs/cgroup" / _CODEX_HOST_CGROUP_RELATIVE
                for counter in ("memory.max", "memory.current", "memory.peak", "memory.events"):
                    (cgroup / counter).unlink()
            delay_seconds = float(state["codex_capacity_canary_delay_seconds"])
            if delay_seconds:
                # justify-polling: the canary is the timed subject under
                # measurement here; holding its exec open past one sampler
                # interval is the condition the sampler-breach proof observes.
                threading.Event().wait(delay_seconds)
            status = str(state["codex_capacity_canary_status"])
            if status == "crashed":
                # The canary died before reaching any of its documented
                # contract exits: no JSON, a signal-style return code.
                _save_state(state_path, state)
                return 137
            authored_status = (
                "transport_retriable"
                if status in {"transport_ambiguous", "transport_unavailable"}
                else "passed"
                if status == "killed_after_printing"
                else status
            )
            terminal_status = "succeeded" if authored_status == "passed" else "failed"
            _write_json(
                {
                    "schema_version": "nexus-codex-capacity-canary.v3",
                    "status": authored_status,
                    "turns": [
                        {
                            "phase": phase,
                            "operation": "dossier_library",
                            "plan_id": "thorough",
                            "plan_revision": "codex-generation.2026-08-24.2",
                            "capability": "Synthesis",
                            "terminal_status": terminal_status,
                            "failure_kind": None
                            if authored_status == "passed"
                            else "backend_failed",
                            "usage_present": authored_status == "passed",
                            "sdk_version": "0.1.0",
                            "runtime_version": "0.1.0",
                            "tool_event_count": 0,
                            "permission_event_count": 0,
                        }
                        for phase in (
                            ("cold", "warm_1", "warm_2")
                            if authored_status == "passed"
                            else ()
                            if authored_status in {"transport_retriable", "not_run"}
                            else ("cold",)
                        )
                    ],
                }
            )
            if status == "killed_after_printing":
                # A complete contract statement followed by a signal-style
                # return code: the killed-after-printing case the controller
                # must classify as retriable, never as evidence.
                _save_state(state_path, state)
                return 137
            if authored_status != "passed":
                # The canary's public contract terminals
                # (apps.codex_agent.capacity_canary.EXIT_CODES), deliberately
                # outside 1 and 128..255 so a crash can never impersonate one.
                _save_state(state_path, state)
                return _CODEX_CAPACITY_CANARY_EXIT_CODES[authored_status]
        else:
            raise AssertionError(f"unsupported fake capacity canary command: {command!r}")
    elif arguments[0] == "inspect":
        if arguments[1:3] == ["--format", "{{.State.Running}}"]:
            container = _container(state, arguments[3])
            sys.stdout.write("true\n" if container["running"] else "false\n")
        elif arguments[1:3] == ["--format", "{{.Image}}"]:
            sys.stdout.write(str(_container(state, arguments[3])["image_id"]) + "\n")
        elif arguments[1] == "--format":
            _container(state, arguments[3])
            sys.stdout.write("healthy\n")
        else:
            target = arguments[1]
            canary = state.get("capacity_canary")
            if isinstance(canary, dict) and target == canary.get("id"):
                reservation, memory, pids = _RESOURCE_LIMITS["nexus-codex-agent-host"]
                isolation_drift = state["codex_capacity_canary_isolation_drift"]
                _write_json(
                    [
                        {
                            "Config": {
                                "Cmd": ["-c", "while :; do sleep 3600; done"],
                                "Entrypoint": ["sh"],
                                "Env": [
                                    *_CODEX_IMAGE_ENVIRONMENT,
                                    "NEXUS_CODEX_AGENT_SOCKET=/run/nexus-codex/agent.sock",
                                ],
                                "Image": state["candidate_worker_image"],
                                "Labels": {
                                    _CODEX_CAPACITY_CANARY_LABEL: str(canary.get("label", "")),
                                },
                                "User": "10001:10001",
                            },
                            "HostConfig": {
                                "CapDrop": ["ALL"],
                                "MemoryReservation": reservation,
                                "Memory": memory,
                                "MemorySwap": memory,
                                "NanoCpus": 1_000_000_000,
                                "NetworkMode": "none",
                                "PidsLimit": pids,
                                "ReadonlyRootfs": True,
                                "SecurityOpt": ["no-new-privileges:true"],
                            },
                            "Image": state["candidate_worker_image_id"],
                            "Mounts": (
                                [
                                    {
                                        "Destination": "/run/nexus-codex-credential/auth.json",
                                        "RW": True,
                                        "Source": "/srv/nexus/codex-state/codex/codex-personal/auth.json",
                                        "Type": "bind",
                                    },
                                    {
                                        "Destination": "/run/nexus-codex",
                                        "Name": "nexus_nexus_codex_run",
                                        "RW": True,
                                        "Source": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
                                        "Type": "volume",
                                    },
                                ]
                                if isolation_drift == "credential_mount_and_network_peer"
                                else [
                                    {
                                        "Destination": "/run/nexus-codex",
                                        "Name": "nexus_nexus_codex_run",
                                        "RW": False,
                                        "Source": "/var/lib/docker/volumes/nexus_nexus_codex_run/_data",
                                        "Type": "volume",
                                    }
                                ]
                            ),
                            "Name": f"/{canary['name']}",
                            "NetworkSettings": {
                                "Networks": (
                                    {"nexus_codex_egress": {}}
                                    if isolation_drift == "credential_mount_and_network_peer"
                                    else {"none": {}}
                                ),
                                "Ports": {},
                            },
                            "State": {"Health": {"Status": "healthy"}, "Running": True},
                        }
                    ]
                )
                _save_state(state_path, state)
                return 0
            try:
                _write_json([_container_inspect(state, target)])
            except AssertionError:
                job = next(
                    (item for item in state["jobs"].values() if item["id"] == target),
                    None,
                )
                if job is None:
                    raise
                _write_json(
                    [
                        {
                            "Config": job["config"],
                            "HostConfig": job["host_config"],
                            "Image": job["image_id"],
                            "Name": job["name"],
                            "State": {
                                "ExitCode": job["exit_code"],
                                "Running": job["running"],
                            },
                        }
                    ]
                )
    elif arguments[:2] == ["network", "inspect"]:
        if arguments[2:] == ["nexus_codex_private"]:
            host = state["containers"]["nexus-codex-agent-host"]
            policy = state["containers"]["codex-egress-policy"]
            containers = {
                str(host["id"]): {"IPv4Address": "172.30.0.3/24"},
                str(policy["id"]): {"IPv4Address": "172.30.0.2/24"},
            }
            if state["codex_host_isolation_drift"] == "network_peer":
                postgres = state["containers"]["postgres"]
                containers[str(postgres["id"])] = {"IPv4Address": "172.30.0.4/24"}
            network: dict[str, object] = {
                "Containers": containers,
                "Driver": "bridge",
                "EnableIPv4": True,
                "EnableIPv6": False,
                "IPAM": {
                    "Config": [{"Subnet": "172.30.0.0/24"}],
                    "Driver": "default",
                    "Options": None,
                },
                "Internal": True,
                "Name": "nexus_codex_private",
                "Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"},
                "Scope": "local",
            }
            mutation = state["codex_host_contract_mutation"]
            if mutation == "network_driver":
                network["Driver"] = "overlay"
            elif mutation == "network_scope":
                network["Scope"] = "swarm"
            elif mutation == "network_internal":
                network["Internal"] = False
            elif mutation == "network_options":
                network["Options"] = {}
            elif mutation == "network_ipam":
                network["IPAM"] = {
                    "Config": [{"Gateway": "172.30.0.1", "Subnet": "172.30.0.0/24"}],
                    "Driver": "default",
                    "Options": None,
                }
            _write_json([network])
            return
        if arguments[2:] == ["nexus_codex_proxy_egress"]:
            policy = state["containers"]["codex-egress-policy"]
            _write_json(
                [
                    {
                        "Containers": {str(policy["id"]): {"Name": "nexus-codex-egress-policy-1"}},
                        "Driver": "bridge",
                        "IPAM": {
                            "Config": [{"Gateway": "172.31.0.1", "Subnet": "172.31.0.0/16"}],
                            "Driver": "default",
                            "Options": None,
                        },
                        "Internal": False,
                        "Name": "nexus_codex_proxy_egress",
                        "Options": {},
                        "Scope": "local",
                    }
                ]
            )
            return
        raise AssertionError("unexpected fake Codex host network inspect")
    elif arguments[:4] == ["ps", "--all", "--quiet", "--filter"]:
        if len(arguments) != 5:
            raise AssertionError("unexpected fake Docker container listing")
        name_filter = arguments[4]
        prefix = "name=^/"
        if not name_filter.startswith(prefix) or not name_filter.endswith("$"):
            raise AssertionError("unexpected fake Docker container name filter")
        name = name_filter[len(prefix) : -1]
        canary = state.get("capacity_canary")
        if isinstance(canary, dict) and name == canary.get("name"):
            sys.stdout.write(str(canary["id"]) + "\n")
    elif arguments[0] == "start":
        container = _container(state, arguments[1])
        container["running"] = True
        service = next(name for name, item in state["containers"].items() if item is container)
        state["service_mutations"].append({"operation": "start", "services": [service]})
    elif arguments[0] == "logs":
        target = arguments[-1]
        job = next(item for item in state["jobs"].values() if item["id"] == target)
        sys.stdout.write(str(job["logs"]))
    elif arguments[0] == "rm":
        target = arguments[-1]
        name = next(
            (
                name
                for name, item in state["jobs"].items()
                if name == target or item["id"] == target
            ),
            None,
        )
        if name is not None:
            del state["jobs"][name]
        canary = state.get("capacity_canary")
        if isinstance(canary, dict) and target in {canary.get("id"), canary.get("name")}:
            if state["codex_capacity_canary_removal_failure"] is True:
                _save_state(state_path, state)
                return 72
            del state["capacity_canary"]
    else:
        raise AssertionError(f"unsupported fake Docker command: {arguments!r}")
    _save_state(state_path, state)
    return 0


def fake_apparmor_parser_main() -> int:
    state_path = Path(os.environ["NEXUS_FAKE_DOCKER_STATE"])
    state = _load_state(state_path)
    root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
    profile = root / "etc/apparmor.d/nexus-codex-agent-host"
    expected = (
        root
        / "opt/nexus/releases"
        / str(state["candidate_source_sha"])
        / "nexus-codex-agent-host.apparmor"
    )
    if sys.argv[2:] == ["-Q", str(expected)]:
        state["apparmor_profile_preflight_count"] += 1
        _save_state(state_path, state)
        return 0
    if sys.argv[2:] != ["-r", str(profile)]:
        raise AssertionError("AppArmor profile command differs from fixed release contract")
    if profile.read_bytes() != expected.read_bytes():
        raise AssertionError("loaded AppArmor profile differs from immutable bundle")
    state["apparmor_profile_load_count"] += 1
    _save_state(state_path, state)
    return 0


def fake_cryptsetup_main() -> int:
    state = _load_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]))
    root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
    container = root / "var/lib/nexus/codex-state.luks"
    arguments = sys.argv[2:]
    storage_kind = state["codex_state_storage_kind"]
    if arguments == ["isLuks", "--type", "luks2", str(container)]:
        return 1 if storage_kind in {"plain_unmounted", "luks1"} else 0
    if arguments == ["status", "nexus-codex-state"]:
        mapper = (
            "/dev/mapper/foreign-codex-state"
            if storage_kind == "wrong_mapper"
            else "/dev/mapper/nexus-codex-state"
        )
        luks_type = "LUKS1" if storage_kind == "luks1" else "LUKS2"
        sys.stdout.write(
            f"{mapper} is active and is in use.\n  type:    {luks_type}\n  device:  /dev/loop7\n"
        )
        return 0
    raise AssertionError(f"unsupported fake cryptsetup command: {arguments!r}")


def fake_losetup_main() -> int:
    state = _load_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]))
    arguments = sys.argv[2:]
    if arguments != ["--noheadings", "--output", "BACK-FILE", "/dev/loop7"]:
        raise AssertionError(f"unsupported fake losetup command: {arguments!r}")
    root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
    backing = (
        root / "var/lib/nexus/wrong-codex-state.luks"
        if state["codex_state_storage_kind"] == "wrong_mount_source"
        else root / "var/lib/nexus/codex-state.luks"
    )
    sys.stdout.write(f"{backing}\n")
    return 0


def fake_findmnt_main() -> int:
    state = _load_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]))
    root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
    arguments = sys.argv[2:]
    if (
        len(arguments) != 5
        or arguments[:2] != ["--json", "--mountpoint"]
        or arguments[3] != "--output"
        or arguments[4] != "SOURCE,TARGET,FSTYPE,OPTIONS"
    ):
        raise AssertionError(f"unsupported fake findmnt command: {arguments!r}")
    target = arguments[2]
    state_mount = str(root / "srv/nexus/codex-state")
    if target != state_mount:
        raise AssertionError(f"unsupported fake findmnt target: {target!r}")
    options = (
        "rw,nosuid,nodev"
        if state["codex_state_storage_kind"] == "wrong_mount_flags"
        else "rw,nosuid,nodev,noexec,relatime"
    )
    source = "/dev/mapper/nexus-codex-state"
    filesystem = {
        "fstype": "ext4",
        "options": options,
        "source": source,
        "target": target,
    }
    _write_json({"filesystems": [filesystem]})
    return 0


def fake_df_main() -> int:
    state = _load_state(Path(os.environ["NEXUS_FAKE_DOCKER_STATE"]))
    root = Path(os.environ["NEXUS_FAKE_RELEASE_ATTEMPT"]).parents[5]
    arguments = sys.argv[2:]
    expected = [
        "--output=avail",
        "--block-size=1",
        "--",
        str(root / "srv/nexus/codex-state"),
    ]
    if arguments != expected:
        raise AssertionError(f"unsupported fake df command: {arguments!r}")
    sys.stdout.write(f"Avail\n{state['codex_state_free_bytes']}\n")
    return 0


def fake_systemctl_main() -> int:
    state_path = Path(os.environ["NEXUS_FAKE_DOCKER_STATE"])
    state = _load_state(state_path)
    arguments = sys.argv[2:]
    if arguments == ["daemon-reload"]:
        return 0
    if arguments == ["enable", "nexus-codex-state-boot-guard.service"]:
        state["codex_state_boot_guard_enabled"] = True
        _save_state(state_path, state)
        return 0
    if arguments == [
        "is-enabled",
        "--quiet",
        "nexus-codex-state-boot-guard.service",
    ]:
        return 0 if state["codex_state_boot_guard_enabled"] is True else 1
    raise AssertionError(f"unsupported fake systemctl command: {arguments!r}")


def _drop_to_test_group() -> None:
    test_gid = os.environ.pop("NEXUS_FAKE_TEST_GID", None)
    if test_gid is not None:
        os.setgroups([int(test_gid)])
        os.setgid(int(test_gid))


def apply_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha, deployment_id, production_host = arguments
    release = _load_release(Path(release_path), "nexus_host_release_behavior_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    attempt = host.apply(
        source_sha=source_sha,
        deployment_id=deployment_id,
        production_host=production_host,
    )
    if (
        attempt.phase.value == os.environ.get("NEXUS_FAKE_INTERRUPT_PHASE")
        and attempt.phase.value == "AwaitingFrontendPromotion"
    ):
        state_path = Path(os.environ["NEXUS_FAKE_DOCKER_STATE"])
        state = _load_state(state_path)
        if not state["interrupt_fired"]:
            state["interrupt_fired"] = True
            _save_state(state_path, state)
            os.kill(os.getpid(), signal.SIGKILL)
    sys.stdout.buffer.write(_canonical_json(attempt.as_json()))
    return 0


def finalize_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha, deployment_id = arguments
    release = _load_release(Path(release_path), "nexus_host_release_finalize_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    attempt = host.finalize(
        source_sha=source_sha,
        deployment_id=deployment_id,
    )
    sys.stdout.buffer.write(_canonical_json(attempt.as_json()))
    return 0


def verify_current_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_release_verify_current_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    host.verify_current(source_sha)
    sys.stdout.buffer.write(_canonical_json({"source_sha": source_sha, "status": "current"}))
    return 0


def qualify_codex_capacity_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_release_capacity_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    host.qualify_codex_capacity(source_sha)
    sys.stdout.buffer.write(_canonical_json({"source_sha": source_sha, "status": "passed"}))
    return 0


def resume_codex_agent_host_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_release_resume_codex_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    receipt = host.resume_codex_agent_host(source_sha)
    sys.stdout.buffer.write(_canonical_json(receipt))
    return 0


def install_codex_state_boot_guard_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_release_install_codex_guard_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    receipt = host.install_codex_state_boot_guard(source_sha)
    sys.stdout.buffer.write(_canonical_json(receipt))
    return 0


def activate_caddy_config_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_release_activate_caddy_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    receipt = host.activate_caddy_config(source_sha)
    sys.stdout.buffer.write(_canonical_json(receipt))
    return 0


def fail_bound_frontend_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha, deployment_id = arguments
    release = _load_release(Path(release_path), "nexus_host_release_fail_frontend_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    attempt = host.fail_bound_frontend(
        source_sha=source_sha,
        deployment_id=deployment_id,
    )
    sys.stdout.buffer.write(_canonical_json(attempt.as_json()))
    return 0


def fail_auth_smoke_main(arguments: list[str]) -> int:
    _drop_to_test_group()
    release_path, root, source_sha, deployment_id = arguments
    release = _load_release(Path(release_path), "nexus_host_release_fail_auth_smoke_driver")
    host = release.HostRelease(release.ReleasePaths.under(Path(root)))
    attempt = host.fail_auth_smoke(
        source_sha=source_sha,
        deployment_id=deployment_id,
    )
    sys.stdout.buffer.write(_canonical_json(attempt.as_json()))
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        raise AssertionError("host release test helper requires a command")
    if sys.argv[1] == "docker":
        return fake_docker_main()
    if sys.argv[1] == "apparmor_parser":
        return fake_apparmor_parser_main()
    if sys.argv[1] == "cryptsetup":
        return fake_cryptsetup_main()
    if sys.argv[1] == "df":
        return fake_df_main()
    if sys.argv[1] == "findmnt":
        return fake_findmnt_main()
    if sys.argv[1] == "losetup":
        return fake_losetup_main()
    if sys.argv[1] == "systemctl":
        return fake_systemctl_main()
    if sys.argv[1] == "apply":
        return apply_main(sys.argv[2:])
    if sys.argv[1] == "finalize":
        return finalize_main(sys.argv[2:])
    if sys.argv[1] == "verify-current":
        return verify_current_main(sys.argv[2:])
    if sys.argv[1] == "qualify-codex-capacity":
        return qualify_codex_capacity_main(sys.argv[2:])
    if sys.argv[1] == "resume-codex-agent-host":
        return resume_codex_agent_host_main(sys.argv[2:])
    if sys.argv[1] == "install-codex-state-boot-guard":
        return install_codex_state_boot_guard_main(sys.argv[2:])
    if sys.argv[1] == "activate-caddy-config":
        return activate_caddy_config_main(sys.argv[2:])
    if sys.argv[1] == "fail-bound-frontend":
        return fail_bound_frontend_main(sys.argv[2:])
    if sys.argv[1] == "fail-auth-smoke":
        return fail_auth_smoke_main(sys.argv[2:])
    raise AssertionError(f"unknown host release test helper command: {sys.argv[1]}")


if __name__ == "__main__":
    raise SystemExit(main())
