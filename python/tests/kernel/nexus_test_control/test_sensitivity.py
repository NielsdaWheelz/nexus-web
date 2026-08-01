from __future__ import annotations

import hashlib
import json
import os
import subprocess
from collections.abc import Mapping
from pathlib import Path

import pytest

from nexus_test_control.evidence import CapabilityEvidence
from nexus_test_control.model import (
    Capability,
    RunStatus,
    SensitivityMethod,
    SensitivityPhase,
)
from nexus_test_control.runner import CapabilityResult
from nexus_test_control.sensitivity import (
    SensitivityError,
    SensitivityRequest,
    behavioral_red,
    canonical_proof,
    declared_fault_for_proof,
    fault_definition,
    isolated_worktree,
    prove,
    prove_many,
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def _failure(detail: str, *, capability: Capability = Capability.SERVICE) -> CapabilityResult:
    return CapabilityResult(
        CapabilityEvidence(capability, RunStatus.FAIL, 1, 0),
        detail,
    )


def test_behavioral_red_rejects_collection_and_setup_failures() -> None:
    for kind in ("collection_failure", "setup_or_execution_failure"):
        with pytest.raises(SensitivityError, match="behavioral assertion"):
            behavioral_red(
                _failure(f"proof_result={kind}|unrelated harness failure"),
                expected_failure=None,
            )


def test_behavioral_red_records_the_declared_fault_fingerprint_and_property_phase() -> None:
    result = behavioral_red(
        _failure(
            "proof_result=behavioral_assertion_failure|"
            "AssertionError: exact invariant\nFalsifying example: value=0"
        ),
        expected_failure="exact invariant",
    )

    assert result.failure_fingerprint == "exact invariant"
    assert result.phase is SensitivityPhase.PROPERTY


def test_fault_lookup_requires_exact_proof_ownership(tmp_path: Path) -> None:
    proof = "pytest:python/tests/service/test_owner.py::test_owner"
    patch = tmp_path / "testdata/faults/owner.patch"
    patch.parent.mkdir(parents=True)
    patch.write_text(
        "diff --git a/python/nexus/owner.py b/python/nexus/owner.py\n"
        "--- a/python/nexus/owner.py\n"
        "+++ b/python/nexus/owner.py\n"
        "@@ -1 +1 @@\n"
        "-VALUE = 1\n"
        "+VALUE = 0\n"
    )
    manifest = {
        "version": 1,
        "faults": [
            {
                "id": "owner-fault",
                "patch": "testdata/faults/owner.patch",
                "sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
                "proofs": [proof],
                "expected_failure": "expected one",
            }
        ],
    }
    (tmp_path / "testdata/faults/manifest.json").write_text(json.dumps(manifest))

    definition = fault_definition(tmp_path, "owner-fault", proof)

    assert definition.expected_failure == "expected one"
    assert declared_fault_for_proof(tmp_path, proof) == "owner-fault"
    with pytest.raises(SensitivityError, match="does not own proof"):
        fault_definition(
            tmp_path,
            "owner-fault",
            "pytest:python/tests/service/test_other.py::test_other",
        )


def test_priority_manifest_canonicalizes_a_file_level_proof(tmp_path: Path) -> None:
    path = "python/tests/service/test_owner.py"
    exact = f"pytest:{path}::test_exact_owner"
    manifest = {
        "version": 1,
        "priority_risks": [{"proofs": [exact]}],
        "journeys": [],
    }
    target = tmp_path / "testdata/proofs.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps(manifest))

    assert canonical_proof(tmp_path, f"pytest:{path}") == exact


def test_base_sensitivity_runs_the_overlaid_proof_red_then_current_green(
    tmp_path: Path,
) -> None:
    (tmp_path / ".gitignore").write_text("python/.venv\ntest-results\n.nexus-test\n")
    project = tmp_path / "python"
    project.mkdir()
    (project / "pyproject.toml").write_bytes((REPO_ROOT / "python/pyproject.toml").read_bytes())
    (project / "uv.lock").write_bytes((REPO_ROOT / "python/uv.lock").read_bytes())
    (project / ".venv").symlink_to(REPO_ROOT / "python/.venv", target_is_directory=True)
    owner = project / "nexus"
    owner.mkdir()
    (owner / "__init__.py").write_text("")
    (owner / "value.py").write_text("VALUE = 1\n")
    proof_path = project / "tests/kernel/test_value.py"
    proof_path.parent.mkdir(parents=True)
    proof_path.write_text(
        "from nexus.value import VALUE\n\n"
        "def test_value():\n"
        "    assert VALUE == 2, 'expected current value'\n"
    )
    _commit(tmp_path, "base")
    base_sha = _git_output(tmp_path, "rev-parse", "HEAD")
    (owner / "value.py").write_text("VALUE = 2\n")
    _commit(tmp_path, "fix")
    proof = "pytest:python/tests/kernel/test_value.py::test_value"

    result = prove(
        tmp_path,
        proof=proof,
        changed_paths=("python/tests/kernel/test_value.py",),
        method=SensitivityMethod.BASE,
        against=base_sha,
        environment={
            key: value
            for key in ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ")
            if (value := os.environ.get(key)) is not None
        },
    )

    assert result.against.git_sha == base_sha
    assert result.red.phase is SensitivityPhase.ASSERTION
    assert result.red.failure_fingerprint.startswith("sha256:")
    assert result.green.status is RunStatus.PASS


def test_fault_portfolio_reverses_each_fault_without_mutating_the_source_checkout(
    tmp_path: Path,
) -> None:
    (tmp_path / ".gitignore").write_text("python/.venv\ntest-results\n.nexus-test\n")
    project = tmp_path / "python"
    project.mkdir()
    (project / "pyproject.toml").write_bytes((REPO_ROOT / "python/pyproject.toml").read_bytes())
    (project / "uv.lock").write_bytes((REPO_ROOT / "python/uv.lock").read_bytes())
    (project / ".venv").symlink_to(REPO_ROOT / "python/.venv", target_is_directory=True)
    owner = project / "nexus"
    owner.mkdir()
    (owner / "__init__.py").write_text("")
    (owner / "values.py").write_text("FIRST = 1\nSECOND = 1\n")
    proofs = project / "tests/kernel"
    proofs.mkdir(parents=True)
    (proofs / "test_first.py").write_text(
        "from nexus.values import FIRST\n\n"
        "def test_first():\n"
        "    assert FIRST == 1, 'first fault observed'\n"
    )
    (proofs / "test_second.py").write_text(
        "from nexus.values import SECOND\n\n"
        "def test_second():\n"
        "    assert SECOND == 1, 'second fault observed'\n"
    )
    faults = tmp_path / "testdata/faults"
    faults.mkdir(parents=True)
    first_patch = faults / "first.patch"
    first_patch.write_text(
        "diff --git a/python/nexus/values.py b/python/nexus/values.py\n"
        "--- a/python/nexus/values.py\n"
        "+++ b/python/nexus/values.py\n"
        "@@ -1,2 +1,2 @@\n"
        "-FIRST = 1\n"
        "+FIRST = 0\n"
        " SECOND = 1\n"
    )
    second_patch = faults / "second.patch"
    second_patch.write_text(
        "diff --git a/python/nexus/values.py b/python/nexus/values.py\n"
        "--- a/python/nexus/values.py\n"
        "+++ b/python/nexus/values.py\n"
        "@@ -1,2 +1,2 @@\n"
        " FIRST = 1\n"
        "-SECOND = 1\n"
        "+SECOND = 0\n"
    )
    first_proof = "pytest:python/tests/kernel/test_first.py::test_first"
    second_proof = "pytest:python/tests/kernel/test_second.py::test_second"
    (faults / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "faults": [
                    {
                        "id": "first-fault",
                        "patch": "testdata/faults/first.patch",
                        "sha256": hashlib.sha256(first_patch.read_bytes()).hexdigest(),
                        "proofs": [first_proof],
                        "expected_failure": "first fault observed",
                    },
                    {
                        "id": "second-fault",
                        "patch": "testdata/faults/second.patch",
                        "sha256": hashlib.sha256(second_patch.read_bytes()).hexdigest(),
                        "proofs": [second_proof],
                        "expected_failure": "second fault observed",
                    },
                ],
            }
        )
    )
    _commit(tmp_path, "fault portfolio")

    environment = {
        key: value
        for key in ("HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ")
        if (value := os.environ.get(key)) is not None
    }

    results = prove_many(
        tmp_path,
        requests=(
            SensitivityRequest(
                first_proof,
                ("python/tests/kernel/test_first.py",),
                SensitivityMethod.FAULT,
                "first-fault",
            ),
            SensitivityRequest(
                second_proof,
                ("python/tests/kernel/test_second.py",),
                SensitivityMethod.FAULT,
                "second-fault",
            ),
        ),
        environment=environment,
    )

    assert [result.red.failure_fingerprint for result in results] == [
        "first fault observed",
        "second fault observed",
    ]
    assert (owner / "values.py").read_text() == "FIRST = 1\nSECOND = 1\n"


@pytest.mark.parametrize(
    "proof_error",
    [RuntimeError("synthetic proof failure"), KeyboardInterrupt()],
    ids=("proof-error", "interruption"),
)
def test_isolated_worktree_cleans_runtime_before_removal_on_proof_exit(
    tmp_path: Path,
    proof_error: BaseException,
) -> None:
    (tmp_path / "proof.txt").write_text("proof\n")
    _commit(tmp_path, "base")
    revision = _git_output(tmp_path, "rev-parse", "HEAD")
    cleaned: list[tuple[Path, Mapping[str, str]]] = []
    checkout: Path | None = None

    def clean_runtime(
        worktree: Path,
        environment: Mapping[str, str],
    ) -> tuple[str, ...]:
        assert _git_output(worktree, "rev-parse", "HEAD") == revision
        cleaned.append((worktree, environment))
        return ()

    with pytest.raises(type(proof_error)):
        with isolated_worktree(
            tmp_path,
            revision,
            overlays=(),
            runtime_cleaner=clean_runtime,
        ) as red_root:
            checkout = red_root
            raise proof_error

    assert cleaned == [(checkout, {"NEXUS_ENV": "test"})]
    assert checkout is not None
    assert not checkout.exists()
    assert str(checkout) not in _git_output(tmp_path, "worktree", "list", "--porcelain")


def test_isolated_worktree_retains_ownership_evidence_when_runtime_cleanup_fails(
    tmp_path: Path,
) -> None:
    (tmp_path / "proof.txt").write_text("proof\n")
    _commit(tmp_path, "base")
    revision = _git_output(tmp_path, "rev-parse", "HEAD")
    checkout: Path | None = None

    def fail_cleanup(
        worktree: Path,
        environment: Mapping[str, str],
    ) -> tuple[str, ...]:
        assert worktree.exists()
        assert environment == {"NEXUS_ENV": "test"}
        raise RuntimeError("synthetic cleanup failure")

    try:
        with pytest.raises(SensitivityError, match="ownership evidence was retained") as error:
            with isolated_worktree(
                tmp_path,
                revision,
                overlays=(),
                runtime_cleaner=fail_cleanup,
            ) as red_root:
                checkout = red_root

        assert checkout is not None
        assert checkout.exists()
        assert str(checkout) in _git_output(tmp_path, "worktree", "list", "--porcelain")
        assert f"cd {checkout} && ./scripts/test clean" in str(error.value)
    finally:
        if checkout is not None and checkout.exists():
            _git_output(tmp_path, "worktree", "remove", "--force", str(checkout))
            checkout.parent.rmdir()


def _commit(repo: Path, message: str) -> None:
    if not (repo / ".git").exists():
        subprocess.run(("git", "init", "-q"), cwd=repo, check=True)
    subprocess.run(("git", "add", "."), cwd=repo, check=True)
    subprocess.run(
        (
            "git",
            "-c",
            "user.name=Nexus Test",
            "-c",
            "user.email=nexus@example.invalid",
            "commit",
            "-qm",
            message,
        ),
        cwd=repo,
        check=True,
    )


def _git_output(repo: Path, *arguments: str) -> str:
    return subprocess.run(
        ("git", *arguments),
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
