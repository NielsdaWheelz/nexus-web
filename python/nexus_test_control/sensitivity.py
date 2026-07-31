from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from nexus_test_control.evidence import compute_proof_digest, redact_text
from nexus_test_control.model import (
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
from nexus_test_control.runner import CapabilityContext, CapabilityResult, run_proof
from nexus_test_control.runtime import workspace_heavy_lock
from nexus_test_control.services import clean_owned_runtime


class SensitivityError(ValueError):
    pass


RuntimeCleaner = Callable[[Path, Mapping[str, str]], tuple[str, ...]]


@dataclass(frozen=True, slots=True)
class FaultDefinition:
    id: str
    patch: str
    sha256: str
    proofs: tuple[str, ...]
    expected_failure: str


def prove(
    repo_root: Path,
    *,
    proof: str,
    changed_paths: Sequence[str],
    method: SensitivityMethod,
    against: str,
    environment: Mapping[str, str],
) -> Sensitivity:
    root = repo_root.resolve(strict=True)
    _require_clean_checkout(root)
    proof_path = _proof_path(proof)
    if not (root / proof_path).is_file():
        raise SensitivityError(f"proof owner is absent: {proof_path}")
    exact_changed_paths = tuple(dict.fromkeys(changed_paths))
    if proof_path not in exact_changed_paths:
        raise SensitivityError("sensitivity changed paths must include the proof owner")
    current_sha = _git_sha(root, "HEAD")

    fault: FaultDefinition | None = None
    if method is SensitivityMethod.BASE:
        against_sha = _git_sha(root, against)
        revision = against_sha
        overlays = _base_overlays(proof_path)
    else:
        fault = fault_definition(root, against, proof)
        against_sha = None
        revision = current_sha
        overlays = ()

    with isolated_worktree(root, revision, overlays=overlays) as red_root:
        if fault is not None:
            _apply_fault(red_root, root / fault.patch)
        red_result = run_proof(
            CapabilityContext(red_root, Workflow.CHANGED, ()),
            proof,
            environment,
        )
        red = behavioral_red(red_result, expected_failure=fault.expected_failure if fault else None)

    green_result = run_proof(
        CapabilityContext(root, Workflow.CHANGED, ()),
        proof,
        environment,
    )
    if green_result.evidence.status is not RunStatus.PASS:
        raise SensitivityError(
            "current proof did not pass at its intended boundary: "
            f"{green_result.evidence.status.value}: {green_result.detail}"
        )

    return Sensitivity(
        proof=proof,
        changed_paths=exact_changed_paths,
        proof_digest=compute_proof_digest(root, proof, exact_changed_paths),
        method=method,
        against=SensitivityAgainst(
            git_sha=against_sha,
            fault_id=fault.id if fault is not None else None,
        ),
        red=red,
        green=SensitivityGreen(current_sha),
    )


def behavioral_red(
    result: CapabilityResult,
    *,
    expected_failure: str | None,
) -> SensitivityRed:
    prefix = "proof_result=behavioral_assertion_failure|"
    if result.evidence.status is not RunStatus.FAIL or not result.detail.startswith(prefix):
        raise SensitivityError(
            "unfixed/faulted proof did not fail at its behavioral assertion: "
            f"{result.evidence.status.value}: {result.detail}"
        )
    detail = redact_text(result.detail.removeprefix(prefix))
    if expected_failure is not None and expected_failure not in detail:
        raise SensitivityError(
            "faulted proof failed for a different reason; expected fingerprint "
            f"{expected_failure!r}"
        )
    phase = (
        SensitivityPhase.PROPERTY
        if "falsifying example:" in detail.casefold()
        else SensitivityPhase.ASSERTION
    )
    fingerprint = expected_failure or _failure_fingerprint(detail)
    return SensitivityRed(phase, fingerprint)


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
) -> Iterator[Path]:
    temporary = Path(tempfile.mkdtemp(prefix="nexus-test-sensitivity-"))
    checkout = temporary / "checkout"
    _git(repo_root, "worktree", "add", "--detach", str(checkout), revision)
    try:
        for relative in overlays:
            _overlay(repo_root, checkout, relative)
        _link_dependency(repo_root / "python/.venv", checkout / "python/.venv")
        _link_dependency(
            repo_root / "apps/web/node_modules",
            checkout / "apps/web/node_modules",
        )
        yield checkout.resolve(strict=True)
    finally:
        try:
            with workspace_heavy_lock(checkout):
                runtime_cleaner(checkout, {"NEXUS_ENV": "test"})
        except BaseException as error:
            raise SensitivityError(
                "isolated sensitivity runtime cleanup failed; ownership evidence was retained at "
                f"{checkout}; recover with: cd {checkout} && ./scripts/test clean"
            ) from error
        _git(repo_root, "worktree", "remove", "--force", str(checkout))
        shutil.rmtree(temporary)


def sensitivity_json(value: Sensitivity) -> dict[str, object]:
    return {
        "proof": value.proof,
        "changed_paths": list(value.changed_paths),
        "proof_digest": value.proof_digest,
        "method": value.method.value,
        "against": {
            "git_sha": value.against.git_sha,
            "fault_id": value.against.fault_id,
        },
        "red": {
            "status": value.red.status.value,
            "phase": value.red.phase.value,
            "failure_fingerprint": value.red.failure_fingerprint,
        },
        "green": {
            "status": value.green.status.value,
            "git_sha": value.green.git_sha,
        },
    }


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


def _apply_fault(worktree: Path, patch: Path) -> None:
    _git(worktree, "apply", "--check", "--whitespace=error-all", str(patch))
    _git(worktree, "apply", "--whitespace=error-all", str(patch))


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
