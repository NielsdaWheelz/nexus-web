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
CURRENT_SHA = "a" * 40
CURRENT_DEPLOYMENT_ID = "dpl_Current123"
_PUBLIC_HOSTS = frozenset({"api.example.test:443", "web.example.test:443"})


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
        "release.py": b"# immutable release controller\n",
        "python/nexus/__init__.py": b"",
        "python/nexus/release_artifact.py": b"# immutable artifact decoder\n",
    }
    paths: list[Path] = []
    for relative, data in files.items():
        path = bundle / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o444)
        paths.append(path)
    return tuple(paths)


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
        host: str,
        path: str,
    ) -> tuple[int, dict[str, object], dict[str, str]]:
        state = _load_state(self.state_path)
        state["public_requests"].append({"host": host, "path": path})
        _save_state(self.state_path, state)
        headers = {"Cache-Control": "no-store"}
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
            return 200, {"source_sha": served_source_sha}, headers
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
            if len(request_parts) != 3 or request_parts[0] != "GET":
                status, payload, response_headers = (
                    405,
                    {"error": "method-not-allowed"},
                    {"Cache-Control": "no-store"},
                )
            else:
                status, payload, response_headers = self.server.response(
                    headers.get("host", "").split(":", 1)[0],
                    request_parts[1],
                )
            body = _canonical_json(payload)
            reason = {200: "OK", 302: "Found"}.get(status, "Not Found")
            rendered_headers = "".join(
                f"{key}: {value}\r\n" for key, value in response_headers.items()
            ).encode()
            secure.sendall(
                f"HTTP/1.1 {status} {reason}\r\n".encode()
                + rendered_headers
                + b"Connection: close\r\n"
                + b"Content-Type: application/json\r\n"
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
        current_candidate["expected_database_revision"] = "0210"
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
        immutable_inputs = (*candidate_bundle, *current_bundle, config_path, caddy_path)

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
        ):
            containers[service] = {
                "id": character * 64,
                "image_id": (
                    current_worker_image_id
                    if service.startswith("worker-")
                    else "sha256:" + character * 64
                ),
                "config": {"Env": [], "Image": image},
                "running": True,
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
                "ancestry_proofs": [],
                "backup_dump_count": 0,
                "backup_verify_count": 0,
                "candidate_health_failures_remaining": 0,
                "candidate_health_failure_delay_seconds": 0.0,
                "candidate_health_probe_count": 0,
                "candidate_health_wait_seconds": 0.0,
                "candidate_revision": str(candidate["expected_database_revision"]),
                "current_revision": "0210",
                "commands": [],
                "containers": containers,
                "database_identity": "nexus:fake-system-id",
                "database_revision": "0210",
                "failure_count": 0,
                "forward_fix_stop_interrupt_fired": False,
                "interrupt_fired": False,
                "jobs": {},
                "migration_count": 0,
                "migration_interrupt_fired": False,
                "missing_services": [],
                "operation_failure_count": {},
                "operation_failures_remaining": {},
                "oracle_digest": str(candidate["expected_oracle_manifest_digest"]),
                "current_oracle_digest": str(current_candidate["expected_oracle_manifest_digest"]),
                "candidate_active": False,
                "public_api_mode": "valid",
                "public_requests": [],
                "return_interrupt_fired": False,
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
            database_revision="0210",
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
        executable = fake_bin / "docker"
        helper = Path(__file__).resolve()
        executable.write_text(
            f"#!{sys.executable}\n"
            "import runpy, sys\n"
            "sys.argv.insert(1, 'docker')\n"
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
        driver: tuple[str, ...],
        *,
        environment: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
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
            timeout=30,
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
        driver = (
            sys.executable,
            str(Path(__file__).resolve()),
            "apply",
            str(self.repo_root / "deploy/hetzner/release.py"),
            str(self.root),
            attempted_source,
            "dpl_Test123",
            "web.example.test",
        )
        return self._run_controller(driver, environment=environment)

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
        return source_sha

    def run_finalize(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                sys.executable,
                str(Path(__file__).resolve()),
                "finalize",
                str(self.repo_root / "deploy/hetzner/release.py"),
                str(self.root),
                self.source_sha,
                "dpl_Test123",
            ),
            environment=self._environment(),
        )

    def run_fail_bound_frontend(self) -> subprocess.CompletedProcess[str]:
        return self._run_controller(
            (
                sys.executable,
                str(Path(__file__).resolve()),
                "fail-bound-frontend",
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
    for container in containers.values():
        if isinstance(container, dict) and container.get("id") == container_id:
            return container
    raise AssertionError(f"unknown fake container {container_id}")


def _container_inspect(state: dict[str, Any], container_id: str) -> dict[str, object]:
    container = _container(state, container_id)
    inspected: dict[str, object] = {
        "Config": container["config"],
        "Image": container["image_id"],
        "State": {
            "Health": {"Status": "healthy"},
            "Running": container["running"],
        },
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
    return inspected


def _compose_operation(arguments: list[str]) -> list[str]:
    try:
        file_index = arguments.index("--file")
    except ValueError as exc:
        raise AssertionError("fake Compose command has no --file boundary") from exc
    return arguments[file_index + 2 :]


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
    if operation[:3] == ["stop", "--timeout", "30"]:
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
        state["candidate_active"] = True
        for service in services:
            container = state["containers"][service]
            container["running"] = True
            if service == "api":
                container["image_id"] = state["activation_api_image_id"]
                container["config"]["Image"] = state["candidate_api_image"]
            else:
                container["image_id"] = state["activation_worker_image_id"]
                container["config"]["Image"] = state["candidate_worker_image"]
        state["service_mutations"].append({"operation": "up", "services": services})
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
    if operation[:3] == ["exec", "-T", "worker-interactive"]:
        active = bool(state["candidate_active"])
        _write_json(
            {
                "expected_database_revision": (
                    state["candidate_revision"] if active else state["current_revision"]
                ),
                "expected_oracle_manifest_digest": (
                    state["oracle_digest"] if active else state["current_oracle_digest"]
                ),
                "lane": "interactive",
                "source_sha": state["candidate_source_sha"] if active else state["source_sha"],
                "status": "ready",
                "task_contract_digest": state["task_contract_digest"],
            }
        )
        return
    if operation[:3] == ["exec", "-T", "worker-background"]:
        active = bool(state["candidate_active"])
        _write_json(
            {
                "expected_database_revision": (
                    state["candidate_revision"] if active else state["current_revision"]
                ),
                "expected_oracle_manifest_digest": (
                    state["oracle_digest"] if active else state["current_oracle_digest"]
                ),
                "lane": "background",
                "source_sha": state["candidate_source_sha"] if active else state["source_sha"],
                "status": "ready",
                "task_contract_digest": state["task_contract_digest"],
            }
        )
        return
    if operation[:2] == ["run", "--name"]:
        name = operation[2]
        state["migration_count"] += 1
        state["database_revision"] = state["candidate_revision"]
        state["jobs"][name] = {
            "exit_code": 0,
            "id": "8" * 64,
            "logs": "migration complete\n",
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
    phase = _attempt_phase()
    interrupt_phase = os.environ.get("NEXUS_FAKE_INTERRUPT_PHASE")
    if interrupt_phase is not None and phase == interrupt_phase and not state["interrupt_fired"]:
        state["interrupt_fired"] = True
        _save_state(state_path, state)
        os.kill(os.getppid(), signal.SIGKILL)
        return 0
    failure_phase = os.environ.get("NEXUS_FAKE_FAILURE_PHASE")
    if failure_phase is not None and phase == failure_phase and state["failure_count"] < 2:
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

    if arguments[0] == "compose":
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
                    "Config": {"Labels": {"org.opencontainers.image.revision": source_sha}},
                    "Id": image_id,
                }
            ]
        )
    elif arguments[0] == "pull":
        pass
    elif arguments[0] == "run":
        if "cat" in arguments and "/app/runtime-identity.json" in arguments:
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
            try:
                _write_json([_container_inspect(state, target)])
            except AssertionError:
                job = next(
                    (item for item in state["jobs"].values() if item["id"] == target),
                    None,
                )
                if job is None:
                    raise
                _write_json([{"State": {"ExitCode": job["exit_code"], "Running": job["running"]}}])
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
        target = arguments[1]
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
    else:
        raise AssertionError(f"unsupported fake Docker command: {arguments!r}")
    _save_state(state_path, state)
    return 0


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
        if not state["return_interrupt_fired"]:
            state["return_interrupt_fired"] = True
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


def main() -> int:
    if len(sys.argv) < 2:
        raise AssertionError("host release test helper requires a command")
    if sys.argv[1] == "docker":
        return fake_docker_main()
    if sys.argv[1] == "apply":
        return apply_main(sys.argv[2:])
    if sys.argv[1] == "finalize":
        return finalize_main(sys.argv[2:])
    if sys.argv[1] == "fail-bound-frontend":
        return fail_bound_frontend_main(sys.argv[2:])
    raise AssertionError(f"unknown host release test helper command: {sys.argv[1]}")


if __name__ == "__main__":
    raise SystemExit(main())
