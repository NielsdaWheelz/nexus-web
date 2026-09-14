from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from nexus_test_control.model import SensitivityMethod
from nexus_test_control.policy import fault_manifest_violations
from nexus_test_control.sensitivity import workflow_sensitivity_request


@pytest.mark.parametrize(
    ("runner", "proof_path", "source"),
    (
        (
            "vitest",
            "apps/web/src/reader.unit.test.ts",
            b'import { expect, it } from "vitest";\nit("retains source", () => expect(7).toBe(7));\n',
        ),
        (
            "gradle",
            "apps/android/app/src/test/java/app/nexus/ReaderTest.kt",
            b"import org.junit.Test\nclass ReaderTest { @Test fun retainsSource() { assert(7 == 7) } }\n",
        ),
    ),
)
def test_reviewed_file_fault_routes_only_its_pinned_canonical_owner(
    tmp_path: Path, runner: str, proof_path: str, source: bytes
) -> None:
    proof = f"{runner}:{proof_path}"
    owner = tmp_path / proof_path
    owner.parent.mkdir(parents=True)
    owner.write_bytes(source)
    target_path = "python/nexus/reader.py"
    target = tmp_path / target_path
    target.parent.mkdir(parents=True)
    target.write_text("SOURCE = 7\n", encoding="utf-8")
    for command in (
        ("git", "init", "-q"),
        ("git", "config", "user.email", "nexus-test@example.test"),
        ("git", "config", "user.name", "Nexus Test"),
        ("git", "add", "--", proof_path, target_path),
        ("git", "commit", "-qm", "base"),
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    base = subprocess.run(
        ("git", "rev-parse", "HEAD"), cwd=tmp_path, check=True, capture_output=True, text=True
    ).stdout.strip()
    patch = (
        "diff --git a/python/nexus/reader.py b/python/nexus/reader.py\n"
        "--- a/python/nexus/reader.py\n+++ b/python/nexus/reader.py\n"
        "@@ -1 +1 @@\n-SOURCE = 7\n+SOURCE = 8\n"
    )
    fault_dir = tmp_path / "testdata/faults"
    fault_dir.mkdir(parents=True)
    (fault_dir / "source-substitution.patch").write_text(patch, encoding="utf-8")
    fault = {
        "id": "source-substitution",
        "patch": "testdata/faults/source-substitution.patch",
        "sha256": hashlib.sha256(patch.encode()).hexdigest(),
        "proofs": [proof],
        "expected_failure": "source identity changed",
        "changed_owner_red": "coherent-fault",
        "changed_owner_sha256": hashlib.sha256(source).hexdigest(),
    }
    manifest = fault_dir / "manifest.json"
    manifest.write_text(json.dumps({"version": 1, "faults": [fault]}), encoding="utf-8")
    registry = tmp_path / "testdata/proofs.json"
    registry.write_text(json.dumps({"priority_risks": [{"proofs": [proof]}]}), encoding="utf-8")

    assert not fault_manifest_violations(tmp_path), "reviewed file owner was rejected"
    request = workflow_sensitivity_request(
        tmp_path, proof=proof, changed_paths=(proof_path,), base_sha=base
    )
    assert (request.method, request.against) == (SensitivityMethod.FAULT, "source-substitution")

    # Every byte belongs to a file owner, including comments and sibling tests.
    owner.write_bytes(source + b"// changed owner\n")
    assert "fault-coherent-owner-drift" in {
        item.rule for item in fault_manifest_violations(tmp_path)
    }, "changed file retained a stale fault exception"
    owner.write_bytes(source)
    registry.write_text(json.dumps({"priority_risks": []}), encoding="utf-8")
    assert "fault-coherent-owner" in {item.rule for item in fault_manifest_violations(tmp_path)}, (
        "unregistered file inherited a fault exception"
    )
    registry.write_text(json.dumps({"priority_risks": [{"proofs": [proof]}]}), encoding="utf-8")

    fault["proofs"] = [proof + "::retainsSource"]
    manifest.write_text(json.dumps({"version": 1, "faults": [fault]}), encoding="utf-8")
    assert "fault-coherent-owner" in {item.rule for item in fault_manifest_violations(tmp_path)}, (
        "qualified non-Python node was treated as a file owner"
    )
    fault["proofs"] = [proof]
    del fault["changed_owner_red"]
    del fault["changed_owner_sha256"]
    manifest.write_text(json.dumps({"version": 1, "faults": [fault]}), encoding="utf-8")
    request = workflow_sensitivity_request(
        tmp_path, proof=proof, changed_paths=(proof_path,), base_sha=base
    )
    assert (request.method, request.against) == (SensitivityMethod.BASE, base), (
        "unmarked changed file implicitly bypassed BASE"
    )


def _seed_reviewed_file_fault(
    tmp_path: Path, *, proof: str, proof_path: str, source: bytes
) -> None:
    """Write the repository shape a reviewed whole-file coherent fault requires."""
    owner = tmp_path / proof_path
    owner.parent.mkdir(parents=True)
    owner.write_bytes(source)
    target_path = "python/nexus/reader.py"
    target = tmp_path / target_path
    target.parent.mkdir(parents=True)
    target.write_text("SOURCE = 7\n", encoding="utf-8")
    for command in (
        ("git", "init", "-q"),
        ("git", "config", "user.email", "nexus-test@example.test"),
        ("git", "config", "user.name", "Nexus Test"),
        ("git", "add", "--", proof_path, target_path),
        ("git", "commit", "-qm", "base"),
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    patch = (
        "diff --git a/python/nexus/reader.py b/python/nexus/reader.py\n"
        "--- a/python/nexus/reader.py\n+++ b/python/nexus/reader.py\n"
        "@@ -1 +1 @@\n-SOURCE = 7\n+SOURCE = 8\n"
    )
    fault_dir = tmp_path / "testdata/faults"
    fault_dir.mkdir(parents=True)
    (fault_dir / "source-substitution.patch").write_text(patch, encoding="utf-8")
    (fault_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "faults": [
                    {
                        "id": "source-substitution",
                        "patch": "testdata/faults/source-substitution.patch",
                        "sha256": hashlib.sha256(patch.encode()).hexdigest(),
                        "proofs": [proof],
                        "expected_failure": "source identity changed",
                        "changed_owner_red": "coherent-fault",
                        "changed_owner_sha256": hashlib.sha256(source).hexdigest(),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "testdata/proofs.json").write_text(
        json.dumps({"priority_risks": [{"proofs": [proof]}]}), encoding="utf-8"
    )


@pytest.mark.parametrize(
    ("runner", "proof_path", "source"),
    (
        (
            "vitest",
            "apps/web/e2e/journeys/reader.unit.test.ts",
            b'import { expect, it } from "vitest";\nit("retains source", () => expect(7).toBe(7));\n',
        ),
        (
            "gradle",
            "apps/android/app/src/androidTest/java/app/nexus/ReaderDeviceTest.kt",
            b"import org.junit.Test\nclass ReaderDeviceTest { @Test fun retainsSource() { assert(7 == 7) } }\n",
        ),
    ),
)
def test_coherent_file_fault_refuses_an_owner_its_replay_lane_cannot_execute(
    tmp_path: Path, runner: str, proof_path: str, source: bytes
) -> None:
    """Registration, not the workflow, refuses an owner `changed` cannot replay.

    A coherent fault is replayed by PR sensitivity, which runs host Vitest under
    `apps/web/src/` and host Gradle under `apps/android/app/src/test/`. The
    filename alone does not settle that: a journey spec and an `androidTest`
    device class both carry executable-looking names, and the device class is a
    registered whole-file canonical proof, so a fault pinned to one would pass
    every other check and only reveal itself as ANDROID_DEVICE/NIGHTLY work that
    no pull request can run.
    """
    _seed_reviewed_file_fault(
        tmp_path, proof=f"{runner}:{proof_path}", proof_path=proof_path, source=source
    )

    assert {item.rule for item in fault_manifest_violations(tmp_path)} == {
        "fault-coherent-owner"
    }, "an owner outside the changed replay lane was accepted at registration"
