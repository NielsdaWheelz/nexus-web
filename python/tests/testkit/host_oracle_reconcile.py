"""Real-filesystem HostOracleReconcile harness with process-boundary fakes."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from tests.testkit.host_release import record_completed_infrastructure_adoption

_SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
)
_WRITERS = ("api", "worker-interactive", "worker-background")
_OWNER_USER_ID = "00000000-0000-4000-8000-000000000001"
_TASK_CONTRACT_DIGEST = "f" * 64
_PRIOR_ORACLE_DIGEST = "sha256:" + "d" * 64
_EMBEDDING_PROVIDER = "openai"
_EMBEDDING_MODEL = "text-embedding-3-small"


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _load_state(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("fake Oracle host state must be an object")
    return value


def _save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".partial")
    temporary.write_bytes(_canonical_json(state))
    os.replace(temporary, path)


def _load_release(path: Path, module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError("release controller cannot be imported")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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


def _container_config(image: str) -> dict[str, object]:
    return {"Env": [], "Image": image}


@dataclass(frozen=True, slots=True)
class HostOracleReconcileHarness:
    root: Path
    repo_root: Path
    source_sha: str
    repair_source_sha: str
    oracle_digest: str
    state_path: Path
    attempt_path: Path
    repair_path: Path
    repair_bundle: Path
    fake_bin: Path

    def __enter__(self) -> HostOracleReconcileHarness:
        return self

    def __exit__(self, *_error: object) -> None:
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
        source_sha: str,
        oracle_digest: str,
        repair_source_sha: str = "2" * 40,
    ) -> HostOracleReconcileHarness:
        api_image = "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "a" * 64
        worker_image = "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "b" * 64
        postgres_image = "docker.io/library/postgres@sha256:" + "c" * 64
        caddy_image = "docker.io/library/caddy@sha256:" + "e" * 64
        candidate = {
            "schema_version": 1,
            "source_sha": source_sha,
            "repository": "NielsdaWheelz/nexus-web",
            "source_ci_run_id": 17,
            "source_ci_run_attempt": 1,
            "source_ci_workflow_id": 16,
            "publisher_run_id": 18,
            "publisher_run_attempt": 1,
            "images": {"api": api_image, "worker": worker_image},
            "expected_database_revision": "0211",
            "expected_oracle_manifest_digest": oracle_digest,
        }
        repair_api_image = "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "1" * 64
        repair_worker_image = "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "2" * 64
        repair_candidate = {
            "schema_version": 1,
            "source_sha": repair_source_sha,
            "repository": "NielsdaWheelz/nexus-web",
            "source_ci_run_id": 27,
            "source_ci_run_attempt": 1,
            "source_ci_workflow_id": 26,
            "publisher_run_id": 28,
            "publisher_run_attempt": 1,
            "images": {"api": repair_api_image, "worker": repair_worker_image},
            "expected_database_revision": "0211",
            "expected_oracle_manifest_digest": oracle_digest,
        }
        config = (
            "CADDY_ACME_EMAIL=operator@example.test\n"
            f"CADDY_IMAGE={caddy_image}\n"
            "CADDY_SITE=api.example.test\n"
            f"NEXUS_ORACLE_CORPUS_OWNER_USER_ID={_OWNER_USER_ID}\n"
            "POSTGRES_DB=nexus\n"
            f"POSTGRES_IMAGE={postgres_image}\n"
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

        bundle = root / "opt/nexus/releases" / source_sha
        for relative, data in {
            "Caddyfile": b"test-caddy\n",
            "candidate-manifest.json": _canonical_json(candidate),
            "docker-compose.yml": b"name: nexus\n",
            "release.py": b"# immutable release controller\n",
            "python/nexus/__init__.py": b"",
            "python/nexus/release_artifact.py": b"# immutable artifact decoder\n",
        }.items():
            path = bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o444)

        repair_bundle = root / "incoming-oracle-repair"
        for relative, data in {
            "Caddyfile": b"test-repair-caddy\n",
            "candidate-manifest.json": _canonical_json(repair_candidate),
            "docker-compose.yml": b"name: nexus\n",
            "release.py": (repo_root / "deploy/hetzner/release.py").read_bytes(),
            "python/nexus/__init__.py": (repo_root / "python/nexus/__init__.py").read_bytes(),
            "python/nexus/release_artifact.py": (
                repo_root / "python/nexus/release_artifact.py"
            ).read_bytes(),
        }.items():
            path = repair_bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o555 if relative == "release.py" else 0o444)

        api_image_id = "sha256:" + "8" * 64
        worker_image_id = "sha256:" + "9" * 64
        container_specs = (
            ("postgres", "3", "sha256:" + "3" * 64, postgres_image),
            ("caddy", "4", "sha256:" + "4" * 64, caddy_image),
            ("api", "5", api_image_id, api_image),
            ("worker-interactive", "6", worker_image_id, worker_image),
            ("worker-background", "7", worker_image_id, worker_image),
        )
        containers = {
            service: {
                "config": _container_config(image),
                "id": character * 64,
                "image_id": image_id,
                "running": True,
            }
            for service, character, image_id, image in container_specs
        }
        state_path = root / "fake-oracle-host-state.json"
        _save_state(
            state_path,
            {
                "commands": [],
                "containers": containers,
                "database_revision": "0211",
                "effect_invocations": {
                    "publish": 0,
                    "reconcile-support": 0,
                    "unpublish": 0,
                },
                "effect_order": [],
                "jobs": {},
                "images": {
                    repair_api_image: {
                        "database_revision": "0211",
                        "id": "sha256:" + "6" * 64,
                        "oracle_digest": oracle_digest,
                        "source_sha": repair_source_sha,
                    },
                    repair_worker_image: {
                        "database_revision": "0211",
                        "id": "sha256:" + "7" * 64,
                        "oracle_digest": oracle_digest,
                        "source_sha": repair_source_sha,
                    },
                },
                "markers": [],
                "oracle": {
                    "publication": {
                        "corpus_key": "current",
                        "embedding_model": _EMBEDDING_MODEL,
                        "embedding_provider": _EMBEDDING_PROVIDER,
                        "manifest_digest": _PRIOR_ORACLE_DIGEST,
                    },
                    "published": False,
                    "support_ready": False,
                },
                "oracle_digest": oracle_digest,
                "oracle_execution_sources": [],
                "phase_interrupts": [],
                "post_effect_interrupts": [],
                "root": str(root),
                "source_sha": source_sha,
                "start_calls": [],
                "stop_calls": [],
                "unsafe_effects": {
                    "publish": 0,
                    "reconcile-support": 0,
                    "unpublish": 0,
                },
            },
        )
        record_completed_infrastructure_adoption(
            root,
            source_sha,
            docker_state_path=state_path,
        )

        release = _load_release(
            repo_root / "deploy/hetzner/release.py",
            "nexus_host_oracle_reconcile_setup",
        )
        paths = release.ReleasePaths.under(root)
        store = release.ReleaseStore(paths)
        release_containers = {
            service: release.ContainerEvidence(
                container_id=str(item["id"]),
                image=str(item["image_id"]),
                config_sha256=hashlib.sha256(_canonical_json(item["config"])).hexdigest(),
            )
            for service, item in containers.items()
        }
        release_attempt = release.ReleaseAttempt.prepared(
            source_sha=source_sha,
            manifest_sha256=hashlib.sha256(
                (bundle / "candidate-manifest.json").read_bytes()
            ).hexdigest(),
            candidate_api_image_id=api_image_id,
            candidate_worker_image_id=worker_image_id,
            predecessor_sha=None,
            forward_fix_of=None,
            containers=release_containers,
            config_path=str(config_path),
            config_sha256=config_digest,
            vercel_deployment_id="dpl_Oracle123",
            production_host="web.example.test",
            now="2026-08-06T12:00:00Z",
        )
        store.create_attempt(release_attempt)
        for index, phase in enumerate(
            (
                release.ReleasePhase.WritersStopped,
                release.ReleasePhase.BackendActivationStarted,
                release.ReleasePhase.AwaitingFrontendPromotion,
                release.ReleasePhase.FrontendPromoted,
                release.ReleasePhase.Succeeded,
            ),
            start=1,
        ):
            release_attempt = release_attempt.advance(
                phase,
                now=f"2026-08-06T12:0{index}:00Z",
            )
            store.replace_attempt(release_attempt)
        loaded_candidate = release.load_candidate_manifest(bundle / "candidate-manifest.json")
        store.create_record(
            release.ReleaseRecord.from_attempt(
                attempt=release_attempt,
                candidate=loaded_candidate,
                api_image_id=api_image_id,
                worker_image_id=worker_image_id,
                verified_at="2026-08-06T12:06:00Z",
            )
        )
        store.set_current(source_sha)

        immutable_inputs = tuple(path for path in bundle.rglob("*") if path.is_file()) + (
            config_path,
            caddy_path,
        )
        _root_own(immutable_inputs)

        target_name = f"{source_sha}-{oracle_digest.removeprefix('sha256:')}"
        attempt_path = paths.oracle_attempts / f"{target_name}.json"
        repair_path = paths.oracle_repairs / f"{target_name}.json"
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
        return cls(
            root=root,
            repo_root=repo_root,
            source_sha=source_sha,
            repair_source_sha=repair_source_sha,
            oracle_digest=oracle_digest,
            state_path=state_path,
            attempt_path=attempt_path,
            repair_path=repair_path,
            repair_bundle=repair_bundle,
            fake_bin=fake_bin,
        )

    def run_reconcile(
        self,
        *,
        interrupt_phase: str | None = None,
        interrupt_after_effect: str | None = None,
        repair: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        environment = self._environment()
        if interrupt_phase is not None:
            environment["NEXUS_FAKE_ORACLE_INTERRUPT_PHASE"] = interrupt_phase
        if interrupt_after_effect is not None:
            environment["NEXUS_FAKE_ORACLE_INTERRUPT_AFTER_EFFECT"] = interrupt_after_effect
        release_path = (
            self.root / "opt/nexus/releases" / self.repair_source_sha / "release.py"
            if repair
            else self.repo_root / "deploy/hetzner/release.py"
        )
        driver = (
            sys.executable,
            str(Path(__file__).resolve()),
            "reconcile",
            str(release_path),
            str(self.root),
            self.source_sha,
            self.repair_source_sha if repair else "",
        )
        return self._run_driver(driver, environment)

    def install_repair(self, *, bundle: Path | None = None) -> subprocess.CompletedProcess[str]:
        repair_bundle = self.repair_bundle if bundle is None else bundle
        driver = (
            sys.executable,
            str(Path(__file__).resolve()),
            "install-repair",
            str(repair_bundle / "release.py"),
            str(self.root),
            self.source_sha,
            str(repair_bundle),
        )
        return self._run_driver(driver, self._environment())

    def _environment(self) -> dict[str, str]:
        return {
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}",
            "PYTHONPATH": f"{self.repo_root / 'python'}{os.pathsep}"
            f"{os.environ.get('PYTHONPATH', '')}",
            "NEXUS_FAKE_ORACLE_ATTEMPT": str(self.attempt_path),
            "NEXUS_FAKE_ORACLE_STATE": str(self.state_path),
            "NEXUS_FAKE_TEST_GID": str(os.getgid()),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def _run_driver(
        self,
        driver: tuple[str, ...],
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

    def state(self) -> dict[str, Any]:
        return _load_state(self.state_path)

    def attempt(self) -> dict[str, Any]:
        value = json.loads(self.attempt_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise AssertionError("Oracle attempt must be an object")
        return value

    def repair(self) -> dict[str, Any]:
        value = json.loads(self.repair_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise AssertionError("Oracle repair binding must be an object")
        return value

    def writer_ids(self) -> tuple[str, ...]:
        state = self.state()
        return tuple(str(state["containers"][service]["id"]) for service in _WRITERS)


def _attempt_phase() -> str | None:
    raw = os.environ.get("NEXUS_FAKE_ORACLE_ATTEMPT")
    if raw is None or not Path(raw).exists():
        return None
    value = json.loads(Path(raw).read_text(encoding="utf-8"))
    return str(value["phase"])


def _observe_phase(state: dict[str, Any], state_path: Path, *, kill_pid: int) -> None:
    phase = _attempt_phase()
    if phase is None:
        return
    markers = state["markers"]
    if not markers or markers[-1] != phase:
        markers.append(phase)
    requested = os.environ.get("NEXUS_FAKE_ORACLE_INTERRUPT_PHASE")
    if requested == phase and phase not in state["phase_interrupts"]:
        state["phase_interrupts"].append(phase)
        _save_state(state_path, state)
        os.kill(kill_pid, signal.SIGKILL)


def _container_for_id(state: dict[str, Any], container_id: str) -> dict[str, Any]:
    for container in state["containers"].values():
        if container["id"] == container_id:
            return container
    raise AssertionError(f"unknown fake container {container_id}")


def _container_inspect(state: dict[str, Any], container_id: str) -> dict[str, object]:
    container = _container_for_id(state, container_id)
    inspected: dict[str, object] = {
        "Config": container["config"],
        "Image": container["image_id"],
        "State": {
            "Health": {"Status": "healthy"},
            "Running": container["running"],
        },
    }
    if container_id == state["containers"]["caddy"]["id"]:
        root = Path(state["root"])
        inspected["Mounts"] = [
            {
                "Destination": "/etc/caddy/Caddyfile",
                "RW": False,
                "Source": str((root / "etc/nexus/Caddyfile").resolve()),
                "Type": "bind",
            }
        ]
    return inspected


def _write_json(value: object) -> None:
    sys.stdout.buffer.write(_canonical_json(value))


def _oracle_status(state: dict[str, Any]) -> dict[str, object]:
    oracle = state["oracle"]
    support_ready = bool(oracle["support_ready"])
    published = bool(oracle["published"])
    status = (
        "published"
        if support_ready and published
        else "ready_unpublished"
        if support_ready
        else "not_ready"
    )
    return {
        "counts": {
            "anchors": 5,
            "plates": 2,
            "ready_media": 3 if support_ready else 0,
            "ready_plates": 2 if support_ready else 0,
            "resolved_anchors": 5 if support_ready else 0,
            "works": 3 if support_ready else 0,
        },
        "embedding_model": _EMBEDDING_MODEL,
        "embedding_provider": _EMBEDDING_PROVIDER,
        "errors": [],
        "manifest_digest": state["oracle_digest"],
        "publication": oracle["publication"],
        "published": published,
        "removals": {"anchor_keys": [], "plate_source_urls": [], "work_keys": []},
        "status": status,
        "support_ready": support_ready,
    }


def _apply_oracle_effect(state: dict[str, Any], command: str) -> dict[str, object]:
    state["effect_invocations"][command] += 1
    oracle = state["oracle"]
    if command == "unpublish":
        changed = oracle["publication"] is not None
        if changed:
            state["unsafe_effects"][command] += 1
            state["effect_order"].append(command)
            oracle["publication"] = None
            oracle["published"] = False
        return {
            "changed": changed,
            "manifest_digest": state["oracle_digest"],
            "status": "unpublished",
        }
    if command == "reconcile-support":
        if not oracle["support_ready"]:
            state["unsafe_effects"][command] += 1
            state["effect_order"].append(command)
            oracle["support_ready"] = True
        return {
            "index_job_ids": ["00000000-0000-4000-8000-000000000003"],
            "manifest_digest": state["oracle_digest"],
            "media_ids": ["00000000-0000-4000-8000-000000000001"],
            "plate_object_writes": 1 if state["effect_invocations"][command] == 1 else 0,
            "source_job_ids": ["00000000-0000-4000-8000-000000000002"],
            "status": "support_reconciled",
        }
    if command == "publish":
        publication = {
            "corpus_key": "current",
            "embedding_model": _EMBEDDING_MODEL,
            "embedding_provider": _EMBEDDING_PROVIDER,
            "manifest_digest": state["oracle_digest"],
        }
        if oracle["publication"] != publication:
            state["unsafe_effects"][command] += 1
            state["effect_order"].append(command)
            oracle["publication"] = publication
            oracle["published"] = True
        return {"manifest_digest": state["oracle_digest"], "status": "published"}
    raise AssertionError(f"unsupported Oracle effect {command}")


def _oracle_command(operation: list[str]) -> str:
    for command in ("status", "preflight", "unpublish", "reconcile-support", "publish"):
        if command in operation:
            return command
    raise AssertionError(f"fake Oracle command is missing from {operation!r}")


def _compose_operation(arguments: list[str]) -> list[str]:
    try:
        file_index = arguments.index("--file")
    except ValueError as exc:
        raise AssertionError("fake Compose command has no --file boundary") from exc
    return arguments[file_index + 2 :]


def _handle_oracle_run(
    state: dict[str, Any],
    operation: list[str],
    *,
    compose_file: str,
) -> None:
    command = _oracle_command(operation)
    state["oracle_execution_sources"].append(
        {
            "api_image": os.environ["API_IMAGE"],
            "command": command,
            "compose_file": compose_file,
            "worker_image": os.environ["WORKER_IMAGE"],
        }
    )
    if command == "status":
        _write_json(_oracle_status(state))
        return
    if command == "preflight":
        _write_json(
            {
                "manifest_digest": state["oracle_digest"],
                "removals": False,
                "status": "accepted",
            }
        )
        return
    payload = _apply_oracle_effect(state, command)
    if operation[:2] != ["run", "--name"]:
        raise AssertionError("mutating Oracle command must be one durable named job")
    name = operation[2]
    state["jobs"][name] = {
        "command": command,
        "exit_code": 0,
        "id": hashlib.sha256(name.encode()).hexdigest(),
        "logs": _canonical_json(payload).decode(),
        "running": False,
    }
    _write_json(payload)


def _handle_compose(
    state: dict[str, Any],
    operation: list[str],
    *,
    compose_file: str,
) -> None:
    if operation[:3] == ["ps", "--all", "--quiet"]:
        sys.stdout.write(str(state["containers"][operation[3]]["id"]) + "\n")
        return
    if operation[:2] == ["ps", "--quiet"]:
        sys.stdout.write(str(state["containers"][operation[2]]["id"]) + "\n")
        return
    if operation[:3] == ["exec", "-T", "api"]:
        command = " ".join(operation[3:])
        if "127.0.0.1:8000/version" in command:
            _write_json(
                {
                    "data": {
                        "expected_database_revision": state["database_revision"],
                        "expected_oracle_manifest_digest": state["oracle_digest"],
                        "source_sha": state["source_sha"],
                        "task_contract_digest": _TASK_CONTRACT_DIGEST,
                    }
                }
            )
        elif "127.0.0.1:8000/readyz" not in command:
            raise AssertionError(f"unsupported fake API command: {command}")
        return
    if operation[:3] == ["exec", "-T", "worker-interactive"]:
        _write_json(_worker_health(state, "interactive"))
        return
    if operation[:3] == ["exec", "-T", "worker-background"]:
        _write_json(_worker_health(state, "background"))
        return
    if operation[:3] == ["exec", "-T", "postgres"]:
        command = " ".join(operation[3:])
        if "to_regclass" in command:
            sys.stdout.write("alembic_version\n")
        elif "SELECT version_num" in command:
            sys.stdout.write(str(state["database_revision"]) + "\n")
        else:
            raise AssertionError(f"unsupported fake PostgreSQL command: {command}")
        return
    if operation[0] == "run":
        _handle_oracle_run(state, operation, compose_file=compose_file)
        return
    raise AssertionError(f"unsupported fake Compose operation: {operation!r}")


def _worker_health(state: dict[str, Any], lane: str) -> dict[str, object]:
    return {
        "expected_database_revision": state["database_revision"],
        "expected_oracle_manifest_digest": state["oracle_digest"],
        "lane": lane,
        "source_sha": state["source_sha"],
        "status": "ready",
        "task_contract_digest": _TASK_CONTRACT_DIGEST,
    }


def _interrupt_after_effect(
    state: dict[str, Any],
    state_path: Path,
    effect: str,
    *,
    kill_pid: int,
) -> None:
    requested = os.environ.get("NEXUS_FAKE_ORACLE_INTERRUPT_AFTER_EFFECT")
    if requested == effect and effect not in state["post_effect_interrupts"]:
        state["post_effect_interrupts"].append(effect)
        _save_state(state_path, state)
        os.kill(kill_pid, signal.SIGKILL)


def fake_docker_main() -> int:
    state_path = Path(os.environ["NEXUS_FAKE_ORACLE_STATE"])
    state = _load_state(state_path)
    arguments = sys.argv[2:]
    state["commands"].append(arguments)
    _observe_phase(state, state_path, kill_pid=os.getppid())

    if arguments[0] == "compose":
        file_index = arguments.index("--file")
        _handle_compose(
            state,
            _compose_operation(arguments),
            compose_file=arguments[file_index + 1],
        )
    elif arguments[:4] == ["ps", "--all", "--quiet", "--filter"]:
        name = arguments[4].removeprefix("name=^/").removesuffix("$")
        job = state["jobs"].get(name)
        if job is not None:
            sys.stdout.write(str(job["id"]) + "\n")
    elif arguments[0] == "inspect":
        if arguments[1:3] == ["--format", "{{.Image}}"]:
            sys.stdout.write(str(_container_for_id(state, arguments[3])["image_id"]) + "\n")
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
    elif arguments[0] == "stop":
        if arguments[1:3] != ["--time", "30"]:
            raise AssertionError(f"unsupported fake stop command: {arguments!r}")
        container_ids = arguments[3:]
        for container_id in container_ids:
            _container_for_id(state, container_id)["running"] = False
        state["stop_calls"].append(container_ids)
    elif arguments[0] == "start":
        container_ids = arguments[1:]
        for container_id in container_ids:
            _container_for_id(state, container_id)["running"] = True
        state["start_calls"].append(container_ids)
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
            command = str(state["jobs"][name]["command"])
            del state["jobs"][name]
            _interrupt_after_effect(
                state,
                state_path,
                command,
                kill_pid=os.getppid(),
            )
    elif arguments[0] == "pull":
        if arguments[1] not in state["images"]:
            raise AssertionError(f"unknown fake image {arguments[1]}")
    elif arguments[:2] == ["image", "inspect"]:
        image = state["images"].get(arguments[2])
        if image is None:
            raise AssertionError(f"unknown fake image {arguments[2]}")
        _write_json(
            [
                {
                    "Config": {
                        "Labels": {"org.opencontainers.image.revision": image["source_sha"]}
                    },
                    "Id": image["id"],
                }
            ]
        )
    elif arguments[:4] == ["run", "--rm", "--entrypoint", "cat"]:
        image = state["images"].get(arguments[4])
        if image is None or arguments[5] != "/app/runtime-identity.json":
            raise AssertionError(f"unsupported fake image identity command: {arguments!r}")
        _write_json(
            {
                "expected_database_revision": image["database_revision"],
                "expected_oracle_manifest_digest": image["oracle_digest"],
                "source_sha": image["source_sha"],
            }
        )
    else:
        raise AssertionError(f"unsupported fake Docker command: {arguments!r}")
    _save_state(state_path, state)
    return 0


class _FakeHeaders:
    def get(self, key: str) -> str | None:
        return "no-store" if key.lower() == "cache-control" else None

    def get_all(self, key: str, failobj: list[str]) -> list[str]:
        value = self.get(key)
        return [value] if value is not None else failobj

    def keys(self) -> tuple[str, ...]:
        return ("Cache-Control",)


class _FakeResponse:
    status = 200

    def __init__(self, state_path: Path, url: str, body: bytes) -> None:
        self._state_path = state_path
        self._url = url
        self._body = body
        self.headers = _FakeHeaders()

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *_error: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        if self._url == "https://api.example.test/readyz" and _attempt_phase() == "Published":
            state = _load_state(self._state_path)
            _interrupt_after_effect(
                state,
                self._state_path,
                "runtime-restore",
                kill_pid=os.getpid(),
            )
        return self._body

    def geturl(self) -> str:
        return self._url


class _FakeOpener:
    def __init__(self, state_path: Path) -> None:
        self._state_path = state_path

    def open(self, request: Any, *, timeout: int) -> _FakeResponse:
        if timeout != 8:
            raise AssertionError("public proof timeout changed")
        state = _load_state(self._state_path)
        url = str(request.full_url)
        if url == "https://web.example.test/version":
            payload: object = {"source_sha": state["source_sha"]}
        elif url == "https://api.example.test/version":
            payload = {
                "data": {
                    "expected_database_revision": state["database_revision"],
                    "expected_oracle_manifest_digest": state["oracle_digest"],
                    "source_sha": state["source_sha"],
                    "task_contract_digest": _TASK_CONTRACT_DIGEST,
                }
            }
        elif url == "https://api.example.test/readyz":
            payload = {"data": {"status": "ready"}}
        else:
            raise AssertionError(f"unsupported fake public proof URL {url}")
        return _FakeResponse(self._state_path, url, _canonical_json(payload))


def reconcile_main(arguments: list[str]) -> int:
    test_gid = os.environ.pop("NEXUS_FAKE_TEST_GID", None)
    if test_gid is not None:
        os.setgroups([int(test_gid)])
        os.setgid(int(test_gid))
    release_path, root, source_sha, execution_source_sha = arguments
    release = _load_release(Path(release_path), "nexus_host_oracle_reconcile_driver")
    state_path = Path(os.environ["NEXUS_FAKE_ORACLE_STATE"])
    release.urllib.request.build_opener = lambda *_handlers: _FakeOpener(state_path)
    result = release.HostOracleReconcile(release.ReleasePaths.under(Path(root))).reconcile(
        source_sha,
        execution_source_sha=execution_source_sha or None,
    )
    state = _load_state(state_path)
    _observe_phase(state, state_path, kill_pid=os.getpid())
    _save_state(state_path, state)
    _write_json({"result": result.value})
    return 0


def install_repair_main(arguments: list[str]) -> int:
    test_gid = os.environ.pop("NEXUS_FAKE_TEST_GID", None)
    if test_gid is not None:
        os.setgroups([int(test_gid)])
        os.setgid(int(test_gid))
    release_path, root, source_sha, repair_bundle = arguments
    release = _load_release(Path(release_path), "nexus_host_oracle_repair_driver")
    binding = release.install_oracle_repair_bundle(
        Path(repair_bundle),
        release.ReleasePaths.under(Path(root)),
        target_source_sha=source_sha,
    )
    _write_json(binding.as_json())
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        raise AssertionError("HostOracleReconcile helper requires a command")
    if sys.argv[1] == "docker":
        return fake_docker_main()
    if sys.argv[1] == "reconcile":
        return reconcile_main(sys.argv[2:])
    if sys.argv[1] == "install-repair":
        return install_repair_main(sys.argv[2:])
    raise AssertionError(f"unknown HostOracleReconcile helper command: {sys.argv[1]}")


if __name__ == "__main__":
    raise SystemExit(main())
