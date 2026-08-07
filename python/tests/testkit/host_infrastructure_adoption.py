"""Real-filesystem infrastructure-adoption harness with Docker at its boundary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from tests.testkit.release_bundle import ReleaseBundleHarness

SOURCE_SHA = "1" * 40
_BACKUP = b"fake-custom-postgres-backup\n"
_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_OLD_IDS = {
    "postgres": "3" * 64,
    "caddy": "4" * 64,
    "api": "5" * 64,
    "worker-interactive": "6" * 64,
    "worker-background": "7" * 64,
}
_REPLACEMENT_IDS = {"postgres": "a" * 64, "caddy": "b" * 64}
_IMAGE_IDS = {
    "postgres": "sha256:" + "d" * 64,
    "caddy": "sha256:" + "e" * 64,
    "api": "sha256:" + "8" * 64,
    "worker-interactive": "sha256:" + "9" * 64,
    "worker-background": "sha256:" + "9" * 64,
}
_IMAGE_REFS = {
    "postgres": "docker.io/pgvector/pgvector@sha256:" + "d" * 64,
    "caddy": "docker.io/library/caddy@sha256:" + "e" * 64,
}
_VERCEL_DEPLOYMENT_ID = "dpl_AdoptionCandidate"
_VERCEL_DEPLOYMENT_URL = "nexus-adoption.vercel.app"


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("fake Docker state must be an object")
    return value


def _save(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(".partial")
    temporary.write_bytes(_canonical_bytes(value))
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


def _load_controller(path: Path, name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError("infrastructure adoption controller cannot be imported")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _container(service: str, *, caddy_path: Path) -> dict[str, object]:
    mounts: list[dict[str, object]] = []
    if service == "postgres":
        mounts.append(
            {
                "Destination": "/var/lib/postgresql/data",
                "Name": "nexus_postgres_data",
                "RW": True,
                "Source": "nexus_postgres_data",
                "Type": "volume",
            }
        )
    if service == "caddy":
        mounts.extend(
            [
                {
                    "Destination": "/data",
                    "Name": "nexus_caddy_data",
                    "RW": True,
                    "Source": "nexus_caddy_data",
                    "Type": "volume",
                },
                {
                    "Destination": "/config",
                    "Name": "nexus_caddy_config",
                    "RW": True,
                    "Source": "nexus_caddy_config",
                    "Type": "volume",
                },
            ]
        )
    image = _IMAGE_REFS.get(service, _IMAGE_IDS[service])
    return {
        "config": {
            "Image": image,
            "Labels": {
                "com.docker.compose.project": "nexus",
                "com.docker.compose.service": service,
            },
        },
        "health": "healthy" if service != "caddy" else None,
        "id": _OLD_IDS[service],
        "image_id": _IMAGE_IDS[service],
        "mounts": mounts,
        "running": True,
        "service": service,
    }


@dataclass(frozen=True, slots=True)
class InfrastructureAdoptionHarness:
    root: Path
    repo_root: Path
    state_path: Path
    fake_bin: Path
    compose_source: Path
    caddy_source: Path
    controller_path: Path

    @classmethod
    def create(cls, root: Path, *, repo_root: Path) -> InfrastructureAdoptionHarness:
        config = (
            f"POSTGRES_IMAGE={_IMAGE_REFS['postgres']}\n"
            f"CADDY_IMAGE={_IMAGE_REFS['caddy']}\n"
            "POSTGRES_USER=nexus\n"
            "POSTGRES_DB=nexus\n"
        ).encode()
        config_digest = hashlib.sha256(config).hexdigest()
        config_root = root / "etc/nexus/config"
        config_root.mkdir(parents=True)
        config_path = config_root / f"{config_digest}.env"
        config_path.write_bytes(config)
        config_path.chmod(0o440)
        current_config = root / "etc/nexus/current.env"
        current_config.symlink_to(config_path)
        caddy_target = root / "etc/nexus/Caddyfile"
        caddy_target.write_bytes((repo_root / "deploy/hetzner/Caddyfile").read_bytes())
        caddy_target.chmod(0o444)
        (root / "var/backups/nexus").mkdir(parents=True)
        (root / "run/lock").mkdir(parents=True)
        _root_own((config_path, caddy_target))

        containers = {
            service: _container(service, caddy_path=caddy_target) for service in _SERVICES
        }
        state_path = root / "fake-docker-state.json"
        _save(
            state_path,
            {
                "active": dict(_OLD_IDS),
                "commands": [],
                "containers": {value["id"]: value for value in containers.values()},
                "databases": {
                    "nexus": {
                        "revision": "0211",
                        "system_identifier": "fake-system-id",
                        "tables": {"alembic_version": 1, "notes": 13, "users": 2},
                    }
                },
                "fail_once": None,
                "image_refs": {
                    _IMAGE_REFS["postgres"]: _IMAGE_IDS["postgres"],
                    _IMAGE_REFS["caddy"]: _IMAGE_IDS["caddy"],
                },
                "semantic_order": [],
            },
        )
        fake_bin = root / "fake-bin"
        fake_bin.mkdir()
        fake_docker = fake_bin / "docker"
        helper = Path(__file__).resolve()
        fake_docker.write_text(
            f"#!{sys.executable}\n"
            "import runpy, sys\n"
            "sys.argv.insert(1, 'docker')\n"
            f"runpy.run_path({str(helper)!r}, run_name='__main__')\n",
            encoding="utf-8",
        )
        fake_docker.chmod(0o755)
        return cls(
            root=root,
            repo_root=repo_root,
            state_path=state_path,
            fake_bin=fake_bin,
            compose_source=repo_root / "deploy/hetzner/docker-compose.yml",
            caddy_source=repo_root / "deploy/hetzner/Caddyfile",
            controller_path=repo_root / "deploy/hetzner/adopt-infrastructure.py",
        )

    def __enter__(self) -> InfrastructureAdoptionHarness:
        return self

    def __exit__(self, *_error: object) -> None:
        owner = f"{os.getuid()}:{os.getgid()}"
        command = ("chown", "--recursive", owner, "--", str(self.root))
        if os.geteuid() != 0:
            command = ("sudo", "--non-interactive", *command)
        subprocess.run(command, check=True, capture_output=True)

    def state(self) -> dict[str, Any]:
        return _load(self.state_path)

    def attempt(self) -> dict[str, Any]:
        path = self.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "attempt.json"
        return _load(path)

    def set_failure(self, operation: str | None) -> None:
        state = self.state()
        state["fail_once"] = operation
        _save(self.state_path, state)

    def restart_writer_out_of_band(self, service: str) -> None:
        state = self.state()
        state["containers"][state["active"][service]]["running"] = True
        state["semantic_order"].append(f"out-of-band-start:{service}")
        _save(self.state_path, state)

    def environment(self) -> dict[str, str]:
        return {
            "NEXUS_FAKE_ADOPTION_ATTEMPT": str(
                self.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "attempt.json"
            ),
            "NEXUS_FAKE_ADOPTION_CADDY": str(self.root / "etc/nexus/Caddyfile"),
            "NEXUS_FAKE_ADOPTION_STATE": str(self.state_path),
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}",
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def run(
        self,
        *,
        interrupt_phase: str | None = None,
        fail_after_completion_publication: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        environment = self.environment()
        if interrupt_phase is not None:
            environment["NEXUS_FAKE_ADOPTION_INTERRUPT_PHASE"] = interrupt_phase
        if fail_after_completion_publication:
            environment["NEXUS_FAKE_ADOPTION_FAIL_AFTER_COMPLETION"] = "1"
        driver = (
            sys.executable,
            "-B",
            str(Path(__file__).resolve()),
            "run",
            str(self.controller_path),
            str(self.root),
            SOURCE_SHA,
            str(self.compose_source),
            str(self.caddy_source),
        )
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
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            env=environment if os.geteuid() == 0 else None,
            text=True,
            timeout=30,
        )
        state_root = self.root / "var/lib/nexus/infra-adoption"
        backup_root = self.root / "var/backups/nexus/infra-adoption"
        if os.geteuid() != 0 and state_root.exists():
            subprocess.run(
                (
                    "sudo",
                    "--non-interactive",
                    "setfacl",
                    "--recursive",
                    "--modify",
                    f"u:{os.getuid()}:rX",
                    "--",
                    str(state_root),
                ),
                check=True,
                capture_output=True,
            )
        if os.geteuid() != 0 and backup_root.exists():
            subprocess.run(
                (
                    "sudo",
                    "--non-interactive",
                    "setfacl",
                    "--modify",
                    f"u:{os.getuid()}:rX",
                    "--",
                    str(backup_root),
                ),
                check=True,
                capture_output=True,
            )
        return completed


@dataclass(frozen=True, slots=True)
class LocalInfrastructureAdoptionHarness:
    root: Path
    repo_root: Path
    log_path: Path
    fake_bin: Path
    bundle_state_path: Path
    bundle_fake_bin: Path
    controller_path: Path

    @classmethod
    def create(cls, root: Path, *, repo_root: Path) -> LocalInfrastructureAdoptionHarness:
        log_path = root / "local-boundary-log.json"
        _save(
            log_path,
            {
                "calls": [],
                "image_fetch_failure": False,
                "vercel_aliases": [],
                "vercel_cache_control": "no-store",
                "vercel_duplicate_project_id": False,
                "vercel_match_count": 1,
                "vercel_system_envs": True,
            },
        )
        bundle_root = root / "release-bundle-harness"
        bundle_root.mkdir()
        bundle = ReleaseBundleHarness.create(
            bundle_root,
            repo_root=repo_root,
            source_sha=SOURCE_SHA,
        )
        fake_bin = root / "local-fake-bin"
        fake_bin.mkdir()
        helper = Path(__file__).resolve()
        for command in ("curl", "docker", "git", "scp", "ssh"):
            executable = fake_bin / command
            executable.write_text(
                f"#!{sys.executable}\n"
                "import runpy, sys\n"
                f"sys.argv[1:1] = ['local-boundary', {command!r}]\n"
                f"runpy.run_path({str(helper)!r}, run_name='__main__')\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)
        return cls(
            root=root,
            repo_root=repo_root,
            log_path=log_path,
            fake_bin=fake_bin,
            bundle_state_path=bundle.state_path,
            bundle_fake_bin=bundle.fake_bin,
            controller_path=repo_root / "deploy/hetzner/adopt-infrastructure.py",
        )

    def run(self) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "NEXUS_FAKE_ADOPTION_LOCAL_LOG": str(self.log_path),
            "NEXUS_FAKE_ADOPTION_LOCAL_REPO": str(self.repo_root),
            "NEXUS_FAKE_ADOPTION_LOCAL_SHA": SOURCE_SHA,
            "NEXUS_RELEASE_BUNDLE_REPO": str(self.repo_root),
            "NEXUS_RELEASE_BUNDLE_STATE": str(self.bundle_state_path),
            "GH_TOKEN": "test-gh-token",
            "VERCEL_TOKEN": "test-vercel-token",
            "PATH": (
                f"{self.fake_bin}{os.pathsep}{self.bundle_fake_bin}{os.pathsep}{os.environ['PATH']}"
            ),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        return subprocess.run(
            (sys.executable, "-B", str(self.controller_path), "adopt", SOURCE_SHA),
            check=False,
            capture_output=True,
            env=environment,
            text=True,
            timeout=60,
        )

    def calls(self) -> list[dict[str, Any]]:
        calls = _load(self.log_path)["calls"]
        if not isinstance(calls, list) or not all(isinstance(call, dict) for call in calls):
            raise AssertionError("local boundary log must contain calls")
        return calls

    def update_local_state(self, **changes: object) -> None:
        state = _load(self.log_path)
        state.update(changes)
        _save(self.log_path, state)

    def update_bundle_state(self, **changes: object) -> None:
        state = _load(self.bundle_state_path)
        state.update(changes)
        _save(self.bundle_state_path, state)


def _consume_failure(state: dict[str, Any], operation: str) -> bool:
    if state.get("fail_once") != operation:
        return False
    state["fail_once"] = None
    return True


def _record_local_call(command: str, arguments: list[str], **evidence: object) -> None:
    path = Path(os.environ["NEXUS_FAKE_ADOPTION_LOCAL_LOG"])
    state = _load(path)
    calls = state.get("calls")
    if not isinstance(calls, list):
        raise AssertionError("local boundary calls must be a list")
    calls.append({"command": command, "arguments": arguments, **evidence})
    _save(path, state)


def fake_local_boundary_main() -> int:
    command = sys.argv[2]
    arguments = sys.argv[3:]
    source_sha = os.environ["NEXUS_FAKE_ADOPTION_LOCAL_SHA"]
    repo_root = Path(os.environ["NEXUS_FAKE_ADOPTION_LOCAL_REPO"])
    if command == "curl":
        _record_local_call(command, arguments)
        state = _load(Path(os.environ["NEXUS_FAKE_ADOPTION_LOCAL_LOG"]))
        output = Path(arguments[arguments.index("--output") + 1])
        url = arguments[-1]
        raw_response: bytes | None = None
        if "/v9/projects/" in url:
            response: object = {
                "accountId": "team_fKVvTyTsMBQ7qFjccFO17BJL",
                "autoAssignCustomDomains": False,
                "autoExposeSystemEnvs": state["vercel_system_envs"],
                "id": "prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",
                "name": "nexus-web",
            }
            if state["vercel_duplicate_project_id"]:
                raw_response = (
                    b'{"accountId":"team_fKVvTyTsMBQ7qFjccFO17BJL",'
                    b'"autoAssignCustomDomains":false,'
                    b'"id":"prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",'
                    b'"id":"prj_shadow","name":"nexus-web"}\n'
                )
        elif "/v6/deployments?" in url:
            deployments = []
            for index in range(state["vercel_match_count"]):
                suffix = "" if index == 0 else str(index + 1)
                deployments.append(
                    {
                        "meta": {"githubCommitSha": source_sha},
                        "name": "nexus-web",
                        "projectId": "prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",
                        "readyState": "READY",
                        "target": "production",
                        "uid": f"{_VERCEL_DEPLOYMENT_ID}{suffix}",
                        "url": f"nexus-adoption{f'-{suffix}' if suffix else ''}.vercel.app",
                    }
                )
            response = {"deployments": deployments, "pagination": {"next": None}}
        elif f"/v13/deployments/{_VERCEL_DEPLOYMENT_ID}?" in url:
            response = {
                "alias": state["vercel_aliases"],
                "id": _VERCEL_DEPLOYMENT_ID,
                "meta": {"githubCommitSha": source_sha},
                "name": "nexus-web",
                "ownerId": "team_fKVvTyTsMBQ7qFjccFO17BJL",
                "projectId": "prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",
                "readyState": "READY",
                "target": "production",
                "url": _VERCEL_DEPLOYMENT_URL,
            }
        elif url == f"https://{_VERCEL_DEPLOYMENT_URL}/version":
            response = {"source_sha": source_sha}
            headers = Path(arguments[arguments.index("--dump-header") + 1])
            headers.write_text(
                f"HTTP/2 200\r\nCache-Control: {state['vercel_cache_control']}\r\n\r\n",
                encoding="utf-8",
            )
        else:
            raise AssertionError(f"unsupported fake curl URL: {url}")
        output.write_bytes(raw_response or _canonical_bytes(response))
        sys.stdout.write("200")
        return 0
    if command == "docker":
        config = Path(os.environ["DOCKER_CONFIG"])
        _record_local_call(
            command,
            arguments,
            docker_config=str(config),
            docker_config_entries=sorted(path.name for path in config.iterdir()),
            docker_auth_config=os.environ.get("DOCKER_AUTH_CONFIG"),
            registry_auth_file=os.environ.get("REGISTRY_AUTH_FILE"),
        )
        state = _load(Path(os.environ["NEXUS_FAKE_ADOPTION_LOCAL_LOG"]))
        if arguments[:3] != ["buildx", "imagetools", "inspect"]:
            raise AssertionError(f"unsupported fake local Docker command: {arguments!r}")
        return 78 if state["image_fetch_failure"] else 0
    if command == "git":
        _record_local_call(command, arguments)
        if "fetch" in arguments or "status" in arguments:
            return 0
        if "rev-parse" in arguments:
            sys.stdout.write(f"{source_sha}\n")
            return 0
        if "show" in arguments:
            revision, relative = arguments[-1].split(":", 1)
            if revision != source_sha:
                raise AssertionError("git show requested a different source revision")
            sys.stdout.buffer.write((repo_root / relative).read_bytes())
            return 0
        raise AssertionError(f"unsupported fake git command: {arguments!r}")
    if command == "scp":
        source = Path(arguments[-2])
        _record_local_call(
            command,
            arguments,
            sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        )
        return 0
    if command == "ssh":
        target_index = arguments.index("nexus@5.78.194.235")
        remote_arguments = arguments[target_index + 1 :]
        _record_local_call(command, arguments, remote_arguments=remote_arguments)
        if remote_arguments == [
            "mktemp",
            "-d",
            "/tmp/nexus-infra-adoption.XXXXXXXX",
        ]:
            sys.stdout.write("/tmp/nexus-infra-adoption.ABCDEFGH\n")
            return 0
        if remote_arguments[:2] == ["sudo", "env"]:
            return 0
        if remote_arguments[:3] == ["rm", "-r", "--"]:
            return 0
        raise AssertionError(f"unsupported fake ssh command: {remote_arguments!r}")
    raise AssertionError(f"unsupported local boundary: {command}")


def _inspect(state: dict[str, Any], container_id: str) -> dict[str, object]:
    container = state["containers"].get(container_id)
    if not isinstance(container, dict):
        raise AssertionError(f"unknown fake container: {container_id}")
    health = container["health"]
    docker_state: dict[str, object] = {"Running": container["running"]}
    if health is not None:
        docker_state["Health"] = {"Status": health}
    return {
        "Config": container["config"],
        "Id": container_id,
        "Image": container["image_id"],
        "Mounts": container["mounts"],
        "State": docker_state,
    }


def _compose_operation(arguments: list[str]) -> list[str]:
    return arguments[arguments.index("--file") + 2 :]


def _rendered_compose(state: dict[str, Any]) -> dict[str, object]:
    return {
        "services": {
            "postgres": {
                "image": _IMAGE_REFS["postgres"],
                "volumes": [
                    {
                        "source": "postgres_data",
                        "target": "/var/lib/postgresql/data",
                        "type": "volume",
                    }
                ],
            },
            "caddy": {
                "image": _IMAGE_REFS["caddy"],
                "volumes": [
                    {
                        "read_only": True,
                        "source": "/etc/nexus/Caddyfile",
                        "target": "/etc/caddy/Caddyfile",
                        "type": "bind",
                    },
                    {"source": "caddy_data", "target": "/data", "type": "volume"},
                    {"source": "caddy_config", "target": "/config", "type": "volume"},
                ],
            },
            "api": {"image": _IMAGE_IDS["api"]},
            "worker-interactive": {"image": _IMAGE_IDS["worker-interactive"]},
            "worker-background": {"image": _IMAGE_IDS["worker-background"]},
        },
        "volumes": {
            "postgres_data": {"name": "nexus_postgres_data"},
            "caddy_data": {"name": "nexus_caddy_data"},
            "caddy_config": {"name": "nexus_caddy_config"},
        },
    }


def _replace_service(state: dict[str, Any], service: str) -> None:
    old_id = state["active"][service]
    old = state["containers"].pop(old_id)
    replacement_id = _REPLACEMENT_IDS[service]
    replacement = {**old, "id": replacement_id, "running": True}
    if service == "caddy":
        replacement["mounts"] = [
            *old["mounts"],
            {
                "Destination": "/etc/caddy/Caddyfile",
                "RW": False,
                "Source": os.environ["NEXUS_FAKE_ADOPTION_CADDY"],
                "Type": "bind",
            },
        ]
    state["containers"][replacement_id] = replacement
    state["active"][service] = replacement_id


def _psql(state: dict[str, Any], arguments: list[str]) -> None:
    database = arguments[arguments.index("--dbname") + 1]
    sql = arguments[arguments.index("--command") + 1]
    if sql.startswith("SELECT EXISTS (SELECT 1 FROM pg_database"):
        rehearsal = sql.split("'")[1]
        state["semantic_order"].append("check-rehearsal-absent")
        sys.stdout.write("t\n" if rehearsal in state["databases"] else "f\n")
        return
    if sql.startswith("DROP DATABASE IF EXISTS"):
        rehearsal = sql.split('"')[1]
        state["databases"].pop(rehearsal, None)
        state["semantic_order"].append("drop-owned-rehearsal")
        return
    if sql.startswith("CREATE DATABASE"):
        rehearsal = sql.split('"')[1]
        state["databases"][rehearsal] = {
            "revision": "",
            "system_identifier": "fake-system-id",
            "tables": {},
        }
        state["semantic_order"].append("create-rehearsal")
        return
    if sql.startswith("DROP DATABASE"):
        rehearsal = sql.split('"')[1]
        state["databases"].pop(rehearsal)
        state["semantic_order"].append("drop-rehearsal")
        return
    evidence = state["databases"][database]
    if "pg_control_system" in sql:
        state["semantic_order"].append("database-identity")
        sys.stdout.write(f"{database}:{evidence['system_identifier']}\n")
    elif "version_num" in sql:
        sys.stdout.write(f"{evidence['revision']}\n")
    elif "pg_tables" in sql:
        sys.stdout.write("\n".join(sorted(evidence["tables"])) + "\n")
    elif "count(*)" in sql:
        table = sql.split('"')[1]
        sys.stdout.write(f"{evidence['tables'][table]}\n")
    else:
        raise AssertionError(f"unsupported psql operation: {sql}")


def fake_docker_main() -> int:
    path = Path(os.environ["NEXUS_FAKE_ADOPTION_STATE"])
    state = _load(path)
    arguments = sys.argv[2:]
    state["commands"].append(arguments)
    try:
        if arguments[0] == "ps":
            service_filter = next(
                item for item in arguments if item.startswith("label=com.docker.compose.service=")
            )
            service = service_filter.rsplit("=", 1)[1]
            container_id = state["active"].get(service)
            if container_id is not None:
                sys.stdout.write(f"{container_id}\n")
            return 0
        if arguments[0] == "inspect":
            sys.stdout.buffer.write(_canonical_bytes([_inspect(state, arguments[1])]))
            return 0
        if arguments[:2] == ["pull", arguments[1]]:
            state["semantic_order"].append("pull")
            return 0
        if arguments[:2] == ["image", "inspect"]:
            sys.stdout.write(f"{state['image_refs'][arguments[-1]]}\n")
            return 0
        if arguments[0] == "stop":
            ids = arguments[3:]
            if not Path(os.environ["NEXUS_FAKE_ADOPTION_ATTEMPT"]).is_file():
                raise AssertionError("writers stopped before durable adoption state existed")
            state["semantic_order"].append("stop-writers")
            for index, container_id in enumerate(ids):
                state["containers"][container_id]["running"] = False
                if index == 0 and _consume_failure(state, "stop-after-one"):
                    return 72
            return 0
        if arguments[0] == "start":
            state["semantic_order"].append("start-writers")
            for index, container_id in enumerate(arguments[1:]):
                state["containers"][container_id]["running"] = True
                if index == 0 and _consume_failure(state, "start-after-one"):
                    _save(path, state)
                    os.kill(os.getppid(), signal.SIGKILL)
                    return 73
            return 0
        if arguments[0] == "compose":
            operation = _compose_operation(arguments)
            if operation == ["config", "--format", "json"]:
                state["semantic_order"].append("compose-config")
                sys.stdout.buffer.write(_canonical_bytes(_rendered_compose(state)))
                return 0
            expected = [
                "up",
                "--detach",
                "--no-deps",
                "--force-recreate",
                "--wait",
                "--wait-timeout",
                "90",
            ]
            if operation[:7] != expected:
                raise AssertionError(f"unscoped fake Compose mutation: {operation!r}")
            state["semantic_order"].append("compose-up:" + ",".join(operation[7:]))
            for service in operation[7:]:
                _replace_service(state, service)
                if service == "postgres" and _consume_failure(state, "compose-after-postgres"):
                    return 74
            if _consume_failure(state, "compose-after-all"):
                return 75
            return 0
        if arguments[0] == "exec":
            offset = 2 if arguments[1] == "--interactive" else 1
            container_id = arguments[offset]
            command = arguments[offset + 1]
            command_arguments = arguments[offset + 2 :]
            if command == "psql":
                _psql(state, command_arguments)
                return 0
            if command == "pg_dump":
                state["semantic_order"].append("pg-dump")
                sys.stdout.buffer.write(_BACKUP)
                return 0
            if command == "pg_restore" and command_arguments == ["--list"]:
                state["semantic_order"].append("pg-restore-list")
                if sys.stdin.buffer.read() != _BACKUP:
                    raise AssertionError("backup validator received different bytes")
                if _consume_failure(state, "backup-list"):
                    return 76
                sys.stdout.write("; fake archive\n")
                return 0
            if command == "pg_restore":
                state["semantic_order"].append("pg-restore")
                if sys.stdin.buffer.read() != _BACKUP:
                    raise AssertionError("backup restore received different bytes")
                if _consume_failure(state, "backup-restore"):
                    return 77
                database = command_arguments[command_arguments.index("--dbname") + 1]
                state["databases"][database] = json.loads(json.dumps(state["databases"]["nexus"]))
                return 0
            raise AssertionError(f"unsupported fake exec: {arguments!r}")
        raise AssertionError(f"unsupported fake Docker operation: {arguments!r}")
    finally:
        _save(path, state)


def _run_controller(arguments: list[str]) -> int:
    controller_path, root, source_sha, compose, caddy = map(Path, arguments[:5])
    module = _load_controller(controller_path, "nexus_infrastructure_adoption_test_driver")
    paths = module.AdoptionPaths.under(root)
    if os.environ.get("NEXUS_FAKE_ADOPTION_FAIL_AFTER_COMPLETION") == "1":
        create_bytes = module._create_bytes

        def fail_after_completion(
            path: Path,
            value: bytes,
            *,
            mode: int = 0o440,
        ) -> None:
            create_bytes(path, value, mode=mode)
            if path == paths.completion:
                raise OSError("injected post-publication completion failure")

        module._create_bytes = fail_after_completion
    controller_type = module.InfrastructureAdoption
    interrupt_phase = os.environ.get("NEXUS_FAKE_ADOPTION_INTERRUPT_PHASE")
    if interrupt_phase is not None:

        class InterruptingInfrastructureAdoption(controller_type):
            def _write_state(
                self,
                state: Mapping[str, object],
                *,
                create: bool = False,
            ) -> None:
                super()._write_state(state, create=create)
                if state["phase"] != interrupt_phase:
                    return
                marker = paths.state_root / f".interrupted-{interrupt_phase}"
                try:
                    descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
                except FileExistsError:
                    return
                os.close(descriptor)
                os.kill(os.getpid(), signal.SIGKILL)

        controller_type = InterruptingInfrastructureAdoption
    with module.adoption_lock(paths.lock_path):
        result = controller_type(paths).adopt(
            source_sha=str(source_sha),
            compose_source=compose,
            compose_sha256=hashlib.sha256(compose.read_bytes()).hexdigest(),
            caddy_source=caddy,
            caddy_sha256=hashlib.sha256(caddy.read_bytes()).hexdigest(),
            owner_source=controller_path,
            owner_sha256=hashlib.sha256(controller_path.read_bytes()).hexdigest(),
        )
    sys.stdout.buffer.write(_canonical_bytes(result))
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "docker":
        raise SystemExit(fake_docker_main())
    if len(sys.argv) > 1 and sys.argv[1] == "local-boundary":
        raise SystemExit(fake_local_boundary_main())
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        raise SystemExit(_run_controller(sys.argv[2:]))
    raise SystemExit("unsupported host infrastructure adoption testkit command")
