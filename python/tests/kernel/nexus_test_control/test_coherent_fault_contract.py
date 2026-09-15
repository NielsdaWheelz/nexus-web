from __future__ import annotations

import ast
import hashlib
import json
import subprocess
from pathlib import Path

from nexus_test_control.model import SensitivityMethod
from nexus_test_control.policy import fault_manifest_violations
from nexus_test_control.sensitivity import workflow_sensitivity_request

_OWNER_DIGEST_DOMAIN = b"nexus-python-exact-proof-source-v1\0"
_NODE_OWNER_DIGEST_DOMAIN = b"nexus-node-whole-file-proof-source-v1\0"
_REPO_ROOT = Path(__file__).resolve().parents[4]


def _independent_owner_sha256(source: str, selected_node: str) -> str:
    module = ast.parse(source)
    source_lines = source.splitlines(keepends=True)
    retained: list[str] = []
    selected = 0
    for statement in module.body:
        end_line = statement.end_lineno
        assert end_line is not None
        decorators = getattr(statement, "decorator_list", ())
        start_line = min((statement.lineno, *(item.lineno for item in decorators)))
        statement_source = "".join(source_lines[start_line - 1 : end_line])
        if isinstance(
            statement, (ast.FunctionDef, ast.AsyncFunctionDef)
        ) and statement.name.startswith("test_"):
            if statement.name == selected_node:
                retained.append(statement_source)
                selected += 1
            continue
        if isinstance(statement, ast.ClassDef) and statement.name.startswith("Test"):
            continue
        retained.append(statement_source)
    assert selected == 1
    digest = hashlib.sha256(_OWNER_DIGEST_DOMAIN)
    for statement in retained:
        encoded = statement.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, byteorder="big"))
        digest.update(encoded)
    return digest.hexdigest()


def _independent_node_owner_sha256(source: str) -> str:
    encoded = source.encode("utf-8")
    digest = hashlib.sha256(_NODE_OWNER_DIGEST_DOMAIN)
    digest.update(len(encoded).to_bytes(8, byteorder="big"))
    digest.update(encoded)
    return digest.hexdigest()


def test_bound_coherent_fault_is_admitted_routed_and_invalidated_on_owner_drift(
    tmp_path: Path,
) -> None:
    proof_path = "python/tests/service/test_contract_owner.py"
    proof_node = "test_contract_owner"
    proof = f"pytest:{proof_path}::{proof_node}"
    owner_source = """\
LIMIT = 16

def test_contract_owner() -> None:
    assert LIMIT == 16

def test_unrelated_sibling() -> None:
    assert True
"""
    owner = tmp_path / proof_path
    owner.parent.mkdir(parents=True)
    owner.write_text(owner_source, encoding="utf-8")
    target_path = "python/nexus/runtime_health.py"
    target = tmp_path / target_path
    target.parent.mkdir(parents=True)
    target.write_text("READY = False\n", encoding="utf-8")
    for command in (
        ("git", "init", "-q"),
        ("git", "config", "user.email", "nexus-test@example.test"),
        ("git", "config", "user.name", "Nexus Test"),
        ("git", "add", "--", proof_path, target_path),
        ("git", "commit", "-qm", "base"),
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    base_sha = subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    patch = (
        "diff --git a/python/nexus/runtime_health.py b/python/nexus/runtime_health.py\n"
        "--- a/python/nexus/runtime_health.py\n"
        "+++ b/python/nexus/runtime_health.py\n"
        "@@ -1 +1 @@\n"
        "-READY = False\n"
        "+READY = True\n"
    )
    fault_dir = tmp_path / "testdata/faults"
    fault_dir.mkdir(parents=True)
    (fault_dir / "contract-fault.patch").write_text(patch, encoding="utf-8")
    manifest = {
        "version": 1,
        "faults": [
            {
                "id": "contract-fault",
                "patch": "testdata/faults/contract-fault.patch",
                "sha256": hashlib.sha256(patch.encode()).hexdigest(),
                "proofs": [proof],
                "expected_failure": "contract owner detected the fault",
                "changed_owner_red": "coherent-fault",
                "changed_owner_sha256": _independent_owner_sha256(
                    owner_source,
                    proof_node,
                ),
            }
        ],
    }
    (fault_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    proof_manifest = tmp_path / "testdata/proofs.json"
    proof_manifest.write_text(
        json.dumps({"priority_risks": [{"proofs": [proof]}]}),
        encoding="utf-8",
    )

    violations = fault_manifest_violations(tmp_path)
    assert not violations, "candidate controller rejected a bound coherent-fault manifest"
    request = workflow_sensitivity_request(
        tmp_path,
        proof=proof,
        changed_paths=(proof_path,),
        base_sha=base_sha,
    )
    assert (request.method, request.against) == (
        SensitivityMethod.FAULT,
        "contract-fault",
    ), "candidate controller did not route the admitted coherent fault"

    owner.write_text(owner_source.replace("assert True", "assert 1 == 1"), encoding="utf-8")
    assert not fault_manifest_violations(tmp_path), (
        "an unrelated sibling test invalidated the exact coherent owner"
    )

    for drifted_source in (
        owner_source.replace("LIMIT = 16", "LIMIT = 17"),
        owner_source.replace("assert LIMIT == 16", "assert LIMIT == 17"),
    ):
        owner.write_text(drifted_source, encoding="utf-8")
        assert any(
            violation.rule == "fault-coherent-owner-drift"
            for violation in fault_manifest_violations(tmp_path)
        ), "candidate controller retained a coherent-fault exception after owner drift"

    node_proof_path = "node/ingest/test/article_extraction.test.mjs"
    node_proof = f"node-test:{node_proof_path}"
    node_owner_source = """\
import assert from 'node:assert/strict';
import test from 'node:test';

test('semantic main owns extraction', () => {
    assert.equal(true, true);
});
"""
    node_owner = tmp_path / node_proof_path
    node_owner.parent.mkdir(parents=True)
    node_owner.write_text(node_owner_source, encoding="utf-8")
    node_target_path = "node/ingest/article_extraction.mjs"
    node_target = tmp_path / node_target_path
    node_target.write_text("export const USE_MAIN = false;\n", encoding="utf-8")
    (fault_dir / "contract-fault.patch").unlink()
    node_patch = (
        "diff --git a/node/ingest/article_extraction.mjs "
        "b/node/ingest/article_extraction.mjs\n"
        "--- a/node/ingest/article_extraction.mjs\n"
        "+++ b/node/ingest/article_extraction.mjs\n"
        "@@ -1 +1 @@\n"
        "-export const USE_MAIN = false;\n"
        "+export const USE_MAIN = true;\n"
    )
    node_patch_path = fault_dir / "node-contract-fault.patch"
    node_patch_path.write_text(node_patch, encoding="utf-8")
    node_fault = {
        "version": 1,
        "faults": [
            {
                "id": "node-contract-fault",
                "patch": "testdata/faults/node-contract-fault.patch",
                "sha256": hashlib.sha256(node_patch.encode()).hexdigest(),
                "proofs": [node_proof],
                "expected_failure": "semantic main owns extraction",
                "changed_owner_red": "coherent-fault",
                "changed_owner_sha256": _independent_node_owner_sha256(node_owner_source),
            }
        ],
    }
    (fault_dir / "manifest.json").write_text(json.dumps(node_fault), encoding="utf-8")
    proof_manifest.write_text(
        json.dumps({"priority_risks": [{"proofs": [node_proof]}]}),
        encoding="utf-8",
    )

    assert not fault_manifest_violations(tmp_path), (
        "candidate controller rejected a bound whole-file Node coherent fault"
    )
    node_request = workflow_sensitivity_request(
        tmp_path,
        proof=node_proof,
        changed_paths=(node_proof_path,),
        base_sha=base_sha,
    )
    assert (node_request.method, node_request.against) == (
        SensitivityMethod.FAULT,
        "node-contract-fault",
    ), "candidate controller did not route the admitted whole-file Node fault"

    node_owner.write_text(
        node_owner_source.replace("assert.equal(true, true)", "assert.equal(true, false)"),
        encoding="utf-8",
    )
    assert any(
        violation.rule == "fault-coherent-owner-drift"
        for violation in fault_manifest_violations(tmp_path)
    ), "candidate controller retained a whole-file Node exception after owner drift"

    reviewed_routes = (
        (
            "pytest:python/tests/service/test_durable_job_replay.py::"
            "test_reused_worker_identity_cannot_settle_a_reclaimed_attempt",
            "durable-job-fence-bypass",
        ),
        (
            "pytest:python/tests/service/test_background_worker_process_containment.py::"
            "test_kernel_oom_and_timeout_are_terminally_fenced_before_next_fresh_child",
            "document-import-time-dimension-bypass",
        ),
        (
            "pytest:python/tests/service/test_ingest_reconciliation_readiness.py::"
            "test_deployed_database_readiness_requires_the_latest_reconciler_to_succeed_freshly",
            "document-import-reconciler-readiness-bypass",
        ),
    )
    for reviewed_proof, expected_fault in reviewed_routes:
        reviewed_path = reviewed_proof.partition(":")[2].split("::", 1)[0]
        reviewed_request = workflow_sensitivity_request(
            _REPO_ROOT,
            proof=reviewed_proof,
            changed_paths=(reviewed_path,),
            base_sha="HEAD",
        )
        assert (reviewed_request.method, reviewed_request.against) == (
            SensitivityMethod.FAULT,
            expected_fault,
        ), f"reviewed coherent owner did not route its declared fault: {reviewed_proof}"
