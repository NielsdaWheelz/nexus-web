from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from nexus_test_control.evidence import compute_proof_digest, redact_text
from nexus_test_control.memory import OwnedMemorySampler
from nexus_test_control.model import (
    PeakOwnedMemory,
    RunStatus,
    Sensitivity,
    SensitivityAgainst,
    SensitivityGreen,
    SensitivityMethod,
    SensitivityPhase,
    SensitivityRed,
    Workflow,
)
from nexus_test_control.policy import fault_manifest_violations
from nexus_test_control.runner import (
    CapabilityContext,
    CapabilityResult,
    RunContextRecorder,
    run_proof,
)
from nexus_test_control.runtime import workspace_heavy_lock
from nexus_test_control.services import clean_owned_runtime


class SensitivityError(ValueError):
    pass


class SensitivityExecutionError(SensitivityError):
    def __init__(
        self,
        message: str,
        *,
        proof_id: str,
        completed: tuple[Sensitivity, ...] = (),
        artifacts: tuple[str, ...] = (),
    ) -> None:
        super().__init__(message)
        self.proof_id = proof_id
        self.completed = completed
        self.artifacts = artifacts


RuntimeCleaner = Callable[[Path, Mapping[str, str]], tuple[str, ...]]


@dataclass(frozen=True, slots=True)
class FaultDefinition:
    id: str
    patch: str
    sha256: str
    proofs: tuple[str, ...]
    expected_failure: str


@dataclass(frozen=True, slots=True)
class SensitivityRequest:
    proof: str
    changed_paths: tuple[str, ...]
    method: SensitivityMethod
    against: str


@dataclass(frozen=True, slots=True)
class _PreparedSensitivity:
    request: SensitivityRequest
    proof_path: str
    fault: FaultDefinition | None
    against_sha: str | None
    revision: str
    overlays: tuple[str, ...]


def prove(
    repo_root: Path,
    *,
    proof: str,
    changed_paths: Sequence[str],
    method: SensitivityMethod,
    against: str,
    environment: Mapping[str, str],
    memory_sampler: OwnedMemorySampler | None = None,
    run_context: RunContextRecorder | None = None,
) -> Sensitivity:
    return prove_many(
        repo_root,
        requests=(SensitivityRequest(proof, tuple(changed_paths), method, against),),
        environment=environment,
        memory_sampler=memory_sampler,
        run_context=run_context,
    )[0]


def prove_many(
    repo_root: Path,
    *,
    requests: Sequence[SensitivityRequest],
    environment: Mapping[str, str],
    memory_sampler: OwnedMemorySampler | None = None,
    run_context: RunContextRecorder | None = None,
) -> tuple[Sensitivity, ...]:
    """Demonstrate several proofs while reusing one isolated checkout per revision."""
    if not requests:
        return ()
    current_proof = requests[0].proof
    current_artifacts: tuple[str, ...] = ()
    completed: list[tuple[int, Sensitivity]] = []
    try:
        root = repo_root.resolve(strict=True)
        _require_clean_checkout(root)
        proof_environment = {**environment, "PYTHONDONTWRITEBYTECODE": "1"}
        current_sha = _git_sha(root, "HEAD")
        prepared: list[_PreparedSensitivity] = []
        for request in requests:
            current_proof = request.proof
            proof_path = _proof_path(request.proof)
            if not (root / proof_path).is_file():
                raise SensitivityError(f"proof owner is absent: {proof_path}")
            exact_changed_paths = tuple(dict.fromkeys(request.changed_paths))
            if proof_path not in exact_changed_paths:
                raise SensitivityError("sensitivity changed paths must include the proof owner")
            normalized = SensitivityRequest(
                request.proof,
                exact_changed_paths,
                request.method,
                request.against,
            )
            if request.method is SensitivityMethod.BASE:
                against_sha = _git_sha(root, request.against)
                prepared.append(
                    _PreparedSensitivity(
                        normalized,
                        proof_path,
                        None,
                        against_sha,
                        against_sha,
                        _base_overlays(proof_path),
                    )
                )
            else:
                prepared.append(
                    _PreparedSensitivity(
                        normalized,
                        proof_path,
                        fault_definition(root, request.against, request.proof),
                        None,
                        current_sha,
                        (),
                    )
                )

        grouped: dict[tuple[str, SensitivityMethod], list[tuple[int, _PreparedSensitivity]]] = {}
        for index, item in enumerate(prepared):
            grouped.setdefault((item.revision, item.request.method), []).append((index, item))
        for (_revision, _method), group in grouped.items():
            revision = group[0][1].revision
            overlays = tuple(dict.fromkeys(path for _, item in group for path in item.overlays))
            with isolated_worktree(
                root,
                revision,
                overlays=overlays,
                memory_sampler=memory_sampler,
            ) as red_root:
                for index, item in group:
                    current_proof = item.request.proof
                    current_artifacts = ()
                    fault_path = root / item.fault.patch if item.fault is not None else None
                    red_environment = _isolated_results_environment(
                        proof_environment,
                        red_root,
                    )
                    _begin_attempt(memory_sampler)
                    red_started = time.monotonic_ns()
                    with applied_fault(red_root, fault_path):
                        _clear_isolated_python_bytecode(red_root)
                        red_result = run_proof(
                            CapabilityContext(
                                red_root,
                                Workflow.CHANGED,
                                (),
                                proof_id=item.request.proof,
                                sensitivity_attempt="red",
                                run_context=run_context,
                            ),
                            item.request.proof,
                            red_environment,
                            _memory_sampler=memory_sampler,
                        )
                    red_duration_ms = (time.monotonic_ns() - red_started) // 1_000_000
                    red_memory = _finish_attempt(memory_sampler)
                    current_artifacts = _retain_attempt_artifacts(
                        red_root,
                        proof_environment,
                        item.request.proof,
                        "red",
                        red_result.evidence.artifacts,
                    )
                    red = behavioral_red(
                        red_result,
                        proof=item.request.proof,
                        expected_failure=(
                            item.fault.expected_failure if item.fault is not None else None
                        ),
                        duration_ms=red_duration_ms,
                        peak_owned_mib=red_memory,
                        artifacts=current_artifacts,
                    )

                    _begin_attempt(memory_sampler)
                    green_started = time.monotonic_ns()
                    green_result = run_proof(
                        CapabilityContext(
                            root,
                            Workflow.CHANGED,
                            (),
                            proof_id=item.request.proof,
                            sensitivity_attempt="green",
                            run_context=run_context,
                        ),
                        item.request.proof,
                        proof_environment,
                        _memory_sampler=memory_sampler,
                    )
                    green_duration_ms = (time.monotonic_ns() - green_started) // 1_000_000
                    green_memory = _finish_attempt(memory_sampler)
                    current_artifacts = green_result.evidence.artifacts
                    if green_result.evidence.status is not RunStatus.PASS:
                        raise SensitivityError(
                            "current proof did not pass at its intended boundary: "
                            f"{green_result.evidence.status.value}: {green_result.detail}"
                        )
                    completed.append(
                        (
                            index,
                            Sensitivity(
                                proof=item.request.proof,
                                changed_paths=item.request.changed_paths,
                                proof_digest=compute_proof_digest(
                                    root,
                                    item.request.proof,
                                    item.request.changed_paths,
                                ),
                                method=item.request.method,
                                against=SensitivityAgainst(
                                    git_sha=item.against_sha,
                                    fault_id=item.fault.id if item.fault is not None else None,
                                ),
                                red=red,
                                green=SensitivityGreen(
                                    current_sha,
                                    green_duration_ms,
                                    green_memory,
                                ),
                            ),
                        )
                    )
                    current_artifacts = ()
        return tuple(record for _index, record in sorted(completed))
    except SensitivityExecutionError:
        raise
    except Exception as error:
        raise SensitivityExecutionError(
            str(error),
            proof_id=current_proof,
            completed=tuple(record for _index, record in sorted(completed)),
            artifacts=current_artifacts,
        ) from error


def behavioral_red(
    result: CapabilityResult,
    *,
    proof: str,
    expected_failure: str | None,
    duration_ms: int | None = None,
    peak_owned_mib: PeakOwnedMemory | None = None,
    artifacts: tuple[str, ...] = (),
) -> SensitivityRed:
    prefix = "proof_result=behavioral_assertion_failure|"
    if result.evidence.status is not RunStatus.FAIL or not result.detail.startswith(prefix):
        raise SensitivityError(
            "unfixed/faulted proof did not fail at its behavioral assertion: "
            f"{result.evidence.status.value}: {result.detail}"
        )
    bound_prefix = f"proof_id={proof}|"
    bound_detail = result.detail.removeprefix(prefix)
    if not bound_detail.startswith(bound_prefix):
        raise SensitivityError("unfixed/faulted failure was not bound to the exact requested proof")
    detail = redact_text(bound_detail.removeprefix(bound_prefix))
    if expected_failure is not None and expected_failure not in detail:
        raise SensitivityError(
            "faulted proof failed for a different reason; expected fingerprint "
            f"{expected_failure!r}; observed {detail}"
        )
    phase = (
        SensitivityPhase.PROPERTY
        if "falsifying example:" in detail.casefold()
        else SensitivityPhase.ASSERTION
    )
    assertion_fingerprint = expected_failure or _failure_fingerprint(detail)
    fingerprint = (
        "sha256:" + hashlib.sha256(f"{proof}\0{assertion_fingerprint}".encode()).hexdigest()
    )
    return SensitivityRed(
        phase,
        fingerprint,
        result.evidence.duration_ms if duration_ms is None else duration_ms,
        peak_owned_mib or PeakOwnedMemory(0, 0, 0, measurement_complete=False),
        artifacts,
    )


def _begin_attempt(sampler: OwnedMemorySampler | None) -> None:
    if sampler is not None:
        sampler.checkpoint()


def _finish_attempt(sampler: OwnedMemorySampler | None) -> PeakOwnedMemory:
    if sampler is None:
        return PeakOwnedMemory(0, 0, 0, measurement_complete=False)
    return sampler.checkpoint()


def _results_directory(environment: Mapping[str, str]) -> Path | None:
    raw_directory = environment.get("NEXUS_TEST_RESULTS_DIR")
    run_id = environment.get("NEXUS_TEST_EVIDENCE_RUN_ID")
    if raw_directory is None or run_id is None:
        return None
    directory = Path(raw_directory)
    if not directory.is_absolute() or directory.name != run_id:
        return None
    return directory


def _isolated_results_environment(
    environment: Mapping[str, str],
    isolated_root: Path,
) -> dict[str, str]:
    isolated = dict(environment)
    destination = _results_directory(environment)
    if destination is None:
        return isolated
    source = isolated_root / "test-results/runs" / destination.name
    source.mkdir(parents=True, exist_ok=True)
    isolated["NEXUS_TEST_RESULTS_DIR"] = str(source)
    return isolated


def _retain_attempt_artifacts(
    source_root: Path,
    environment: Mapping[str, str],
    proof_id: str,
    attempt: str,
    artifacts: tuple[str, ...],
) -> tuple[str, ...]:
    destination = _results_directory(environment)
    if destination is None or not artifacts:
        return ()
    proof_key = hashlib.sha256(proof_id.encode()).hexdigest()[:16]
    retained_root = destination / "sensitivity" / proof_key / attempt
    retained_root.mkdir(parents=True, exist_ok=True)
    retained: list[str] = []
    skipped: list[str] = []
    retained_bytes = 0
    max_bytes = 16 * 1024 * 1024
    max_files = 64
    source_root = source_root.resolve(strict=True)
    for artifact_index, artifact in enumerate(artifacts, start=1):
        relative = PurePosixPath(artifact)
        if relative.is_absolute() or ".." in relative.parts:
            skipped.append(f"unsafe:{artifact}")
            continue
        source = source_root.joinpath(*relative.parts)
        candidates = (source,) if source.is_file() else tuple(sorted(source.rglob("*")))
        files = tuple(path for path in candidates if path.is_file() and not path.is_symlink())
        if not files:
            skipped.append(f"absent:{artifact}")
            continue
        artifact_root = retained_root / f"{artifact_index}-{source.name}"
        for file in files:
            if len(retained) >= max_files:
                skipped.append(f"file-limit:{artifact}")
                break
            size = file.stat().st_size
            if size > max_bytes - retained_bytes:
                skipped.append(f"byte-limit:{file.name}")
                continue
            suffix = Path(file.name) if source.is_file() else file.relative_to(source)
            target = artifact_root / suffix
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            retained_bytes += size
            retained.append(target.as_posix())
    manifest = retained_root / "retention.json"
    relative_prefix = Path("test-results/runs") / destination.name
    retained_relative = tuple(
        (relative_prefix / path.relative_to(destination)).as_posix()
        for path in sorted(retained_root.rglob("*"))
        if path.is_file() and path != manifest
    )
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "proof_id": proof_id,
                "attempt": attempt,
                "retained_files": len(retained_relative),
                "retained_bytes": retained_bytes,
                "skipped": skipped,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return (
        *retained_relative,
        (relative_prefix / manifest.relative_to(destination)).as_posix(),
    )


def fault_definition(repo_root: Path, fault_id: str, proof: str) -> FaultDefinition:
    violations = fault_manifest_violations(repo_root)
    if violations:
        first = violations[0]
        raise SensitivityError(
            f"fault manifest is invalid: {first.path}: {first.rule}: {first.message}"
        )
    data = json.loads((repo_root / "testdata/faults/manifest.json").read_text(encoding="utf-8"))
    for item in data["faults"]:
        if item["id"] != fault_id:
            continue
        if proof not in item["proofs"]:
            raise SensitivityError(f"fault {fault_id!r} does not own proof {proof!r}")
        return FaultDefinition(
            id=item["id"],
            patch=item["patch"],
            sha256=item["sha256"],
            proofs=tuple(item["proofs"]),
            expected_failure=item["expected_failure"],
        )
    raise SensitivityError(f"unknown fault id: {fault_id}")


def declared_fault_for_proof(repo_root: Path, proof: str) -> str | None:
    violations = fault_manifest_violations(repo_root)
    if violations:
        first = violations[0]
        raise SensitivityError(
            f"fault manifest is invalid: {first.path}: {first.rule}: {first.message}"
        )
    data = json.loads((repo_root / "testdata/faults/manifest.json").read_text(encoding="utf-8"))
    owners = [item["id"] for item in data["faults"] if proof in item["proofs"]]
    if len(owners) > 1:
        raise SensitivityError(f"proof has multiple declared faults: {proof}")
    return owners[0] if owners else None


def canonical_proof(repo_root: Path, proof: str) -> str:
    path = _proof_path(proof)
    manifest_path = repo_root / "testdata/proofs.json"
    if not manifest_path.is_file():
        return proof
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    candidates = {
        candidate
        for risk in data.get("priority_risks", [])
        for candidate in risk.get("proofs", [])
        if _proof_path(candidate) == path
    }
    if len(candidates) > 1:
        raise SensitivityError(f"proof owner has multiple priority nodes: {path}")
    return next(iter(candidates), proof)


@contextmanager
def isolated_worktree(
    repo_root: Path,
    revision: str,
    *,
    overlays: Sequence[str],
    runtime_cleaner: RuntimeCleaner = clean_owned_runtime,
    memory_sampler: OwnedMemorySampler | None = None,
) -> Iterator[Path]:
    temporary = Path(tempfile.mkdtemp(prefix="nexus-test-sensitivity-"))
    checkout = temporary / "checkout"
    _git(repo_root, "worktree", "add", "--detach", str(checkout), revision)
    try:
        for relative in overlays:
            _overlay(repo_root, checkout, relative)
        _prepare_isolated_python_environment(checkout)
        _link_dependency(
            repo_root / "apps/web/node_modules",
            checkout / "apps/web/node_modules",
        )
        _clear_isolated_python_bytecode(checkout)
        yield checkout.resolve(strict=True)
    finally:
        try:
            with workspace_heavy_lock(checkout):
                if memory_sampler is not None:
                    memory_sampler.disable_containers(checkout.resolve(strict=True))
                runtime_cleaner(checkout, {"NEXUS_ENV": "test"})
        except BaseException as error:
            raise SensitivityError(
                "isolated sensitivity runtime cleanup failed; ownership evidence was retained at "
                f"{checkout}; recover with: cd {checkout} && ./scripts/test clean"
            ) from error
        _git(repo_root, "worktree", "remove", "--force", str(checkout))
        shutil.rmtree(temporary)


def _base_overlays(proof_path: str) -> tuple[str, ...]:
    shared = [proof_path, "testdata", "docker/docker-compose.test.yml"]
    if proof_path.startswith("python/"):
        shared.extend(
            (
                "python/tests/conftest.py",
                "python/tests/testkit",
                "python/pyproject.toml",
                "python/uv.lock",
            )
        )
    elif proof_path.startswith("apps/web/"):
        shared.extend(
            (
                "apps/web/e2e/fixtures.ts",
                "apps/web/e2e/playwright.config.ts",
                "apps/web/e2e/runtime.ts",
                "apps/web/vitest.browser-setup.ts",
                "apps/web/vitest.config.ts",
                "apps/web/package.json",
                "apps/web/bun.lock",
            )
        )
    return tuple(dict.fromkeys(shared))


def _overlay(source_root: Path, target_root: Path, relative: str) -> None:
    source = source_root / relative
    if not source.exists():
        return
    target = target_root / relative
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _link_dependency(source: Path, target: Path) -> None:
    if not source.is_dir() or target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(source, target_is_directory=True)


def _prepare_isolated_python_environment(worktree: Path) -> None:
    project = worktree / "python"
    if not (project / "pyproject.toml").is_file() or not (project / "uv.lock").is_file():
        return
    environment = {
        key: value
        for key in ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ", "XDG_CACHE_HOME")
        if (value := os.environ.get(key)) is not None
    }
    try:
        subprocess.run(
            (
                "uv",
                "sync",
                "--project",
                str(project),
                "--all-extras",
                "--locked",
                "--offline",
                "--no-progress",
            ),
            cwd=worktree,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SensitivityError(
            "isolated locked Python environment could not be materialized from the local cache"
        ) from error
    environment_root = project / ".venv"
    if environment_root.is_symlink() or not environment_root.is_dir():
        raise SensitivityError("isolated Python environment is not independently owned")


def _clear_isolated_python_bytecode(worktree: Path) -> None:
    for relative in ("migrations", "python", "scripts"):
        root = worktree / relative
        if not root.is_dir():
            continue
        for directory, names, files in os.walk(root, followlinks=False):
            directory_path = Path(directory)
            names[:] = [name for name in names if not (directory_path / name).is_symlink()]
            if "__pycache__" in names:
                shutil.rmtree(directory_path / "__pycache__")
                names.remove("__pycache__")
            for name in files:
                if name.endswith((".pyc", ".pyo")):
                    (directory_path / name).unlink()


def _apply_fault(worktree: Path, patch: Path) -> None:
    _git(worktree, "apply", "--check", "--whitespace=error-all", str(patch))
    _git(worktree, "apply", "--whitespace=error-all", str(patch))


@contextmanager
def applied_fault(worktree: Path, patch: Path | None) -> Iterator[None]:
    if patch is None:
        yield
        return
    _apply_fault(worktree, patch)
    try:
        yield
    finally:
        _git(worktree, "apply", "--check", "--reverse", "--whitespace=error-all", str(patch))
        _git(worktree, "apply", "--reverse", "--whitespace=error-all", str(patch))
        try:
            _git(worktree, "diff", "--exit-code", capture=True)
        except SensitivityError as error:
            raise SensitivityError(
                "fault reversal did not restore the isolated checkout"
            ) from error


def _require_clean_checkout(repo_root: Path) -> None:
    result = _git(repo_root, "status", "--porcelain=v1", "--untracked-files=all", capture=True)
    if result.stdout:
        raise SensitivityError("sensitivity requires a clean committed checkout")


def _git_sha(repo_root: Path, revision: str) -> str:
    result = _git(repo_root, "rev-parse", "--verify", f"{revision}^{{commit}}", capture=True)
    sha = result.stdout.strip()
    if len(sha) != 40 or any(character not in "0123456789abcdef" for character in sha):
        raise SensitivityError(f"Git returned a non-canonical SHA for {revision!r}")
    return sha


def _git(
    repo_root: Path,
    *arguments: str,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ("git", *arguments),
            cwd=repo_root,
            env={
                key: value
                for key in ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ")
                if (value := os.environ.get(key)) is not None
            },
            check=True,
            capture_output=capture,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SensitivityError(
            f"isolated Git operation failed: git {' '.join(arguments)}"
        ) from error


def _proof_path(proof: str) -> str:
    runner, separator, node = proof.partition(":")
    path = node.split("::", 1)[0]
    parsed = PurePosixPath(path)
    if (
        not separator
        or runner not in {"gradle", "playwright", "pytest", "static", "vitest"}
        or not path
        or parsed.is_absolute()
        or ".." in parsed.parts
        or "\\" in path
        or str(parsed) != path
    ):
        raise SensitivityError(f"invalid runner-qualified proof id: {proof}")
    return path


def _failure_fingerprint(detail: str) -> str:
    normalized = " ".join(detail.split())
    return f"sha256:{hashlib.sha256(normalized.encode()).hexdigest()}"
