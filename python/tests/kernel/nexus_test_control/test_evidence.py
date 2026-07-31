from pathlib import Path

import pytest

from nexus_test_control.evidence import (
    REDACTED,
    CapabilityEvidence,
    PeakOwnedMemory,
    RunEvidence,
    compute_proof_digest,
    evidence_json,
    redact_json,
)
from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    Sensitivity,
    SensitivityAgainst,
    SensitivityGreen,
    SensitivityMethod,
    SensitivityPhase,
    SensitivityRed,
    Workflow,
)


def _capabilities(
    workflow: Workflow, overrides: dict[Capability, RunStatus] | None = None
) -> tuple[CapabilityEvidence, ...]:
    statuses = overrides or {}
    return tuple(
        CapabilityEvidence(
            requirement.capability,
            statuses.get(requirement.capability, RunStatus.PASS),
            0,
            0,
        )
        for requirement in WORKFLOW_REGISTRY[workflow].requirements
    )


def _proof(repo_root: Path) -> tuple[str, str, str]:
    relative = "python/tests/kernel/example.py"
    path = repo_root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("def test_example():\n    assert observed == expected\n")
    node = f"pytest:{relative}::test_example"
    return relative, node, compute_proof_digest(repo_root, node, (relative,))


def test_evidence_matches_schema_and_preserves_not_run(tmp_path: Path) -> None:
    relative, proof, digest = _proof(tmp_path)
    evidence = RunEvidence(
        repo_root=tmp_path,
        run_id="run-1",
        workflow=Workflow.PR,
        git_sha="a" * 40,
        base_sha="b" * 40,
        duration_ms=12,
        peak_owned_mib=PeakOwnedMemory(10, 20, 30),
        selection=(
            Selection(
                relative,
                Capability.KERNEL_PYTHON,
                SelectionReason.CHANGED_TEST,
                proof=proof,
                sensitivity_required=True,
            ),
        ),
        sensitivity=(
            Sensitivity(
                proof=proof,
                changed_paths=(relative,),
                proof_digest=digest,
                method=SensitivityMethod.BASE,
                against=SensitivityAgainst(git_sha="b" * 40, fault_id=None),
                red=SensitivityRed(SensitivityPhase.ASSERTION, "expected-not-actual"),
                green=SensitivityGreen("a" * 40),
            ),
        ),
        capabilities=_capabilities(Workflow.PR, {Capability.SERVICE: RunStatus.NOT_RUN}),
    )

    payload = evidence_json(evidence)

    assert payload["version"] == 1
    assert payload["status"] == "not_run"
    assert payload["selection"] == [
        {
            "capability": "kernel-python",
            "deferred_to": None,
            "path": relative,
            "proof": proof,
            "reason": "changed-test",
            "sensitivity_required": True,
        }
    ]
    assert payload["sensitivity"][0]["red"]["phase"] == "assertion"  # type: ignore[index]  # justify-type-assertion: exact JSON schema shape is under proof.


def test_run_evidence_rejects_missing_required_capability(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="capability evidence differs"):
        RunEvidence(
            repo_root=tmp_path,
            run_id="run-1",
            workflow=Workflow.PR,
            git_sha="a" * 40,
            base_sha=None,
            duration_ms=0,
            peak_owned_mib=PeakOwnedMemory(0, 0, 0),
            selection=(),
            sensitivity=(),
            capabilities=(CapabilityEvidence(Capability.SERVICE, RunStatus.NOT_RUN, 0, 0),),
        )


def test_pr_rejects_materially_changed_proof_without_sensitivity(tmp_path: Path) -> None:
    relative, proof, _ = _proof(tmp_path)
    with pytest.raises(ValueError, match="lack sensitivity"):
        RunEvidence(
            repo_root=tmp_path,
            run_id="run-1",
            workflow=Workflow.PR,
            git_sha="a" * 40,
            base_sha="b" * 40,
            duration_ms=0,
            peak_owned_mib=PeakOwnedMemory(0, 0, 0),
            selection=(
                Selection(
                    relative,
                    Capability.KERNEL_PYTHON,
                    SelectionReason.CHANGED_TEST,
                    proof=proof,
                    sensitivity_required=True,
                ),
            ),
            sensitivity=(),
            capabilities=_capabilities(Workflow.PR),
        )


def test_sensitivity_rejects_unselected_changed_path(tmp_path: Path) -> None:
    relative, proof, _ = _proof(tmp_path)
    other = "python/tests/kernel/other.py"
    (tmp_path / other).write_text("def test_other():\n    assert observed == expected\n")
    sensitivity = Sensitivity(
        proof=proof,
        changed_paths=(other,),
        proof_digest=compute_proof_digest(tmp_path, proof, (other,)),
        method=SensitivityMethod.BASE,
        against=SensitivityAgainst(git_sha="b" * 40, fault_id=None),
        red=SensitivityRed(SensitivityPhase.ASSERTION, "expected-not-actual"),
        green=SensitivityGreen("a" * 40),
    )
    with pytest.raises(ValueError, match="changed paths"):
        RunEvidence(
            repo_root=tmp_path,
            run_id="run-1",
            workflow=Workflow.PR,
            git_sha="a" * 40,
            base_sha="b" * 40,
            duration_ms=0,
            peak_owned_mib=PeakOwnedMemory(0, 0, 0),
            selection=(
                Selection(
                    relative,
                    Capability.KERNEL_PYTHON,
                    SelectionReason.CHANGED_TEST,
                    proof=proof,
                    sensitivity_required=True,
                ),
            ),
            sensitivity=(sensitivity,),
            capabilities=_capabilities(Workflow.PR),
        )


def test_sensitivity_digest_is_computed_from_current_files(tmp_path: Path) -> None:
    relative, proof, _ = _proof(tmp_path)
    sensitivity = Sensitivity(
        proof=proof,
        changed_paths=(relative,),
        proof_digest="c" * 64,
        method=SensitivityMethod.BASE,
        against=SensitivityAgainst(git_sha="b" * 40, fault_id=None),
        red=SensitivityRed(SensitivityPhase.ASSERTION, "expected-not-actual"),
        green=SensitivityGreen("a" * 40),
    )
    with pytest.raises(ValueError, match="selected proof contents"):
        RunEvidence(
            repo_root=tmp_path,
            run_id="run-1",
            workflow=Workflow.PR,
            git_sha="a" * 40,
            base_sha="b" * 40,
            duration_ms=0,
            peak_owned_mib=PeakOwnedMemory(0, 0, 0),
            selection=(
                Selection(
                    relative,
                    Capability.KERNEL_PYTHON,
                    SelectionReason.CHANGED_TEST,
                    proof=proof,
                    sensitivity_required=True,
                ),
            ),
            sensitivity=(sensitivity,),
            capabilities=_capabilities(Workflow.PR),
        )


def test_evidence_rejects_string_enums_instead_of_treating_them_as_pass(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="typed enums"):
        CapabilityEvidence(
            Capability.POLICY,
            "pass",  # type: ignore[arg-type]  # justify-type-assertion: hostile deserialized value is the behavior under proof.
            0,
            0,
        )
    with pytest.raises(ValueError, match="typed Workflow"):
        RunEvidence(
            repo_root=tmp_path,
            run_id="run-1",
            workflow="pr",  # type: ignore[arg-type]  # justify-type-assertion: hostile deserialized value is the behavior under proof.
            git_sha="a" * 40,
            base_sha="b" * 40,
            duration_ms=0,
            peak_owned_mib=PeakOwnedMemory(0, 0, 0),
            selection=(),
            sensitivity=(),
            capabilities=_capabilities(Workflow.PR),
        )


def test_redaction_removes_nested_secrets_command_values_and_bearer_tokens() -> None:
    payload = redact_json(
        {
            "command": ["runner", "--credential", "raw-secret"],
            "nested": {
                "service_role_token": "raw-secret",
                "message": "request used Bearer abc.def and raw-secret",
            },
        },
        ("raw-secret",),
    )

    assert payload == {
        "command": REDACTED,
        "nested": {
            "service_role_token": REDACTED,
            "message": f"request used Bearer {REDACTED} and {REDACTED}",
        },
    }


def test_sensitivity_rejects_collection_failure_as_red() -> None:
    with pytest.raises(ValueError, match="red result must fail"):
        SensitivityRed(
            SensitivityPhase.ASSERTION,
            "collection-error",
            status=RunStatus.NOT_RUN,
        )
