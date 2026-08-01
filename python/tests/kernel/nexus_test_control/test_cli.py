import json
import subprocess
from io import StringIO
from pathlib import Path

import pytest

from nexus_test_control.cli import (
    ControlPlaneError,
    DiagnoseCommand,
    ListCommand,
    ProveCommand,
    WorkflowCommand,
    _canonical_selection,
    _focus_selections,
    _route_selection_for_workflow,
    main,
    parse_command,
    write_summary,
)
from nexus_test_control.evidence import (
    CapabilityEvidence,
    InvocationEvidence,
    PeakOwnedMemory,
    RunEvidence,
    execution_input_fingerprint,
    prove_evidence_from_json,
    run_evidence_from_json,
)
from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    SensitivityMethod,
    Workflow,
)
from nexus_test_control.selection import load_selection_index


def test_parser_accepts_only_the_explicit_command_shapes() -> None:
    assert parse_command(
        [
            "changed",
            "--base",
            "main",
            "--ui",
            "playwright:apps/web/e2e/journeys/auth.journey.spec.ts::auth",
        ]
    ) == WorkflowCommand(
        Workflow.CHANGED,
        "main",
        ("playwright:apps/web/e2e/journeys/auth.journey.spec.ts::auth",),
        True,
    )
    assert parse_command(
        [
            "prove",
            "--proof",
            "pytest:python/tests/kernel/test_rule.py::test_rule",
            "--against",
            "fault:wrong-result",
        ]
    ) == ProveCommand(
        "pytest:python/tests/kernel/test_rule.py::test_rule",
        SensitivityMethod.FAULT,
        "wrong-result",
    )
    assert isinstance(parse_command(["list", "--json"]), ListCommand)
    assert parse_command(["diagnose", "--of", "0123456789abcdef"]) == DiagnoseCommand(
        "0123456789abcdef"
    )


@pytest.mark.parametrize(
    "argv",
    [
        (),
        ("list",),
        ("changed", "--ui"),
        ("changed", "--ui", "python/tests/kernel/test_rule.py"),
        ("changed", "../outside.py"),
        ("confidence", "python/tests/kernel/test_rule.py"),
        ("pr", "--base", "main"),
        ("prove", "--proof", "unknown:file.py", "--against", "base:HEAD"),
        ("prove", "--proof", "pytest:file.py", "--against", "fault:Bad_Fault"),
        ("diagnose",),
        ("diagnose", "--of", "too-short"),
        ("diagnose", "--of", "0123456789ABCDEF"),
        ("diagnose", "--of", "0123456789abcdef", "--proof", "pytest:file.py"),
    ],
)
def test_parser_rejects_ambiguous_or_unsafe_commands(argv: tuple[str, ...]) -> None:
    with pytest.raises(SystemExit):
        parse_command(argv)


def test_list_json_is_derived_from_the_typed_registry() -> None:
    output = StringIO()

    assert main(["list", "--json"], stdout=output) == 0

    payload = json.loads(output.getvalue())
    assert [workflow["id"] for workflow in payload["workflows"]] == [
        workflow.value for workflow in Workflow
    ]
    assert payload["workflows"][2]["capabilities"] == [
        {"id": requirement.capability.value, "scope": requirement.scope.value}
        for requirement in WORKFLOW_REGISTRY[Workflow.PR].requirements
    ]
    assert [command["id"] for command in payload["commands"]] == [
        "prove",
        "diagnose",
        "clean",
        "list",
    ]


def test_workflow_writes_truthful_not_run_summary(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    output = StringIO()

    exit_code = main(["doctor"], repo_root=tmp_path, environment={}, stdout=output)

    assert exit_code == 1
    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text())
    assert summary["workflow"] == "doctor"
    assert summary["status"] == "not_run"
    capability = summary["capabilities"][0]
    assert capability == {
        "artifacts": [],
        "detail": (
            "locked tool owners are absent: python/pyproject.toml, python/uv.lock, "
            "python/.venv, apps/web/package.json, apps/web/bun.lock, "
            "apps/web/node_modules, apps/web/e2e/playwright.config.ts, apps/android/gradlew"
        ),
        "duration_ms": 0,
        "estimated_cost_usd": 0,
        "id": "doctor",
        "peak_owned_mib": capability["peak_owned_mib"],
        "provider_calls": 0,
        "status": "not_run",
    }
    assert capability["peak_owned_mib"] > 0
    assert summary["peak_owned_mib"]["total"] >= capability["peak_owned_mib"]


def test_summary_coexists_with_same_run_failure_artifacts(tmp_path: Path) -> None:
    run_id = "0123456789abcdef"
    run_directory = tmp_path / "test-results/runs" / run_id
    run_directory.mkdir(parents=True)
    (run_directory / "doctor-1.log").write_text("diagnostic\n", encoding="utf-8")
    evidence = RunEvidence(
        repo_root=tmp_path,
        run_id=run_id,
        workflow=Workflow.DOCTOR,
        git_sha="a" * 40,
        base_sha=None,
        duration_ms=1,
        peak_owned_mib=PeakOwnedMemory(1, 0, 1),
        selection=(),
        sensitivity=(),
        capabilities=(
            CapabilityEvidence(
                Capability.DOCTOR,
                RunStatus.FAIL,
                1,
                1,
                artifacts=(f"test-results/runs/{run_id}/doctor-1.log",),
                detail="diagnostic failure",
            ),
        ),
    )

    relative = write_summary(tmp_path, evidence)

    assert relative == f"test-results/runs/{run_id}/summary.json"
    assert (run_directory / "doctor-1.log").read_text(encoding="utf-8") == "diagnostic\n"
    assert (run_directory / "summary.json").is_file()
    original = (run_directory / "summary.json").read_bytes()
    with pytest.raises(ControlPlaneError, match="could not be published"):
        write_summary(tmp_path, evidence)
    assert (run_directory / "summary.json").read_bytes() == original


def test_diagnose_replays_failed_workflow_once_but_keeps_failed_verdict(
    tmp_path: Path,
) -> None:
    _git_repository(tmp_path)
    git_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    original_id = "0123456789abcdef"
    original = RunEvidence(
        repo_root=tmp_path,
        run_id=original_id,
        workflow=Workflow.DOCTOR,
        git_sha=git_sha,
        base_sha=None,
        duration_ms=1,
        peak_owned_mib=PeakOwnedMemory(1, 0, 1),
        selection=(),
        sensitivity=(),
        capabilities=(
            CapabilityEvidence(
                Capability.DOCTOR,
                RunStatus.FAIL,
                1,
                1,
                detail="first failure",
            ),
        ),
    )
    original_directory = tmp_path / "test-results/runs" / original_id
    original_directory.mkdir(parents=True)
    write_summary(tmp_path, original)
    output = StringIO()

    assert (
        main(
            ["diagnose", "--of", original_id],
            repo_root=tmp_path,
            environment={},
            stdout=output,
        )
        == 1
    )

    assert "diagnose: first=fail; diagnostic=not_run; verdict=fail;" in output.getvalue()
    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text())
    assert summary["status"] == "fail"
    assert summary["diagnostic_result"]["status"] == "not_run"
    assert summary["diagnostic_of"]["run_id"] == original_id
    claim = json.loads((original_directory / "diagnostic-rerun.json").read_text())
    assert claim["summary"] == summary_path.relative_to(tmp_path).as_posix()
    assert claim["state"] == "terminal"
    assert claim["diagnostic_status"] == "not_run"

    errors = StringIO()
    assert (
        main(
            ["diagnose", "--of", original_id],
            repo_root=tmp_path,
            environment={},
            stderr=errors,
        )
        == 1
    )
    assert "already has a formal diagnostic rerun" in errors.getvalue()


def test_diagnose_requires_the_same_clean_committed_head(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    git_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    original_id = "0123456789abcdef"
    original_directory = tmp_path / "test-results/runs" / original_id
    original_directory.mkdir(parents=True)
    write_summary(
        tmp_path,
        RunEvidence(
            repo_root=tmp_path,
            run_id=original_id,
            workflow=Workflow.DOCTOR,
            git_sha=git_sha,
            base_sha=None,
            duration_ms=1,
            peak_owned_mib=PeakOwnedMemory(1, 0, 1),
            selection=(),
            sensitivity=(),
            capabilities=(
                CapabilityEvidence(Capability.DOCTOR, RunStatus.FAIL, 1, 1, detail="failed"),
            ),
        ),
    )
    (tmp_path / "README.md").write_text("dirty\n")
    errors = StringIO()

    assert main(["diagnose", "--of", original_id], repo_root=tmp_path, stderr=errors) == 1
    assert "clean committed checkout" in errors.getvalue()
    assert not (original_directory / "diagnostic-rerun.json").exists()


def test_diagnose_rejects_changed_execution_inputs_before_claiming_the_attempt(
    tmp_path: Path,
) -> None:
    _git_repository(tmp_path)
    git_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    run_id = "0123456789abcdef"
    run_directory = tmp_path / "test-results/runs" / run_id
    run_directory.mkdir(parents=True)
    write_summary(
        tmp_path,
        RunEvidence(
            repo_root=tmp_path,
            run_id=run_id,
            workflow=Workflow.DOCTOR,
            git_sha=git_sha,
            base_sha=None,
            duration_ms=1,
            peak_owned_mib=PeakOwnedMemory(1, 0, 1),
            selection=(),
            sensitivity=(),
            capabilities=(
                CapabilityEvidence(Capability.DOCTOR, RunStatus.FAIL, 1, 1, detail="failed"),
            ),
            invocation=InvocationEvidence(
                input_fingerprint=execution_input_fingerprint({"TZ": "UTC"})
            ),
        ),
    )
    errors = StringIO()

    assert (
        main(
            ["diagnose", "--of", run_id],
            repo_root=tmp_path,
            environment={"TZ": "America/Los_Angeles"},
            stderr=errors,
        )
        == 1
    )
    assert "original execution inputs" in errors.getvalue()
    assert not (run_directory / "diagnostic-rerun.json").exists()


def test_selection_failure_still_writes_a_typed_failed_run_summary(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("not-json\n", encoding="utf-8")
    output = StringIO()

    assert main(["changed"], repo_root=tmp_path, environment={}, stdout=output) == 1

    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["version"] == 2
    assert summary["status"] == "fail"
    policy = next(item for item in summary["capabilities"] if item["id"] == "policy")
    assert policy["status"] == "fail"
    assert "could not select changed proof" in policy["detail"]


def test_git_preflight_failure_still_writes_typed_fail_closed_workflow_evidence(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    output = StringIO()

    assert main(["doctor"], repo_root=tmp_path, environment={}, stdout=output) == 1

    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    evidence = run_evidence_from_json(tmp_path, summary)
    assert summary["version"] == 2
    assert evidence.git_sha is None
    assert evidence.status is RunStatus.FAIL
    assert "could not resolve git revision 'HEAD'" in evidence.capabilities[0].detail


@pytest.mark.parametrize(
    ("status", "add_unknown_field", "expected"),
    [
        (RunStatus.PASS, False, "requires a failed workflow run"),
        (RunStatus.FAIL, True, "run summary fields differ"),
    ],
)
def test_diagnose_rejects_nonfailed_or_untyped_original_evidence(
    tmp_path: Path,
    status: RunStatus,
    add_unknown_field: bool,
    expected: str,
) -> None:
    _git_repository(tmp_path)
    git_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    run_id = "0123456789abcdef"
    run_directory = tmp_path / "test-results/runs" / run_id
    run_directory.mkdir(parents=True)
    write_summary(
        tmp_path,
        RunEvidence(
            repo_root=tmp_path,
            run_id=run_id,
            workflow=Workflow.DOCTOR,
            git_sha=git_sha,
            base_sha=None,
            duration_ms=1,
            peak_owned_mib=PeakOwnedMemory(1, 0, 1),
            selection=(),
            sensitivity=(),
            capabilities=(CapabilityEvidence(Capability.DOCTOR, status, 1, 1, detail="result"),),
        ),
    )
    summary_path = run_directory / "summary.json"
    if add_unknown_field:
        payload = json.loads(summary_path.read_text())
        payload["unexpected"] = True
        summary_path.write_text(json.dumps(payload) + "\n")
    errors = StringIO()

    assert main(["diagnose", "--of", run_id], repo_root=tmp_path, stderr=errors) == 1
    assert expected in errors.getvalue()
    assert not (run_directory / "diagnostic-rerun.json").exists()


def test_changed_focus_uses_the_repository_root_and_records_explicit_selection(
    tmp_path: Path,
) -> None:
    _git_repository(tmp_path)
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_rule():\n    assert True\n")
    output = StringIO()

    exit_code = main(
        ["changed", "pytest:python/tests/kernel/test_rule.py::test_rule"],
        repo_root=proof.parent,
        environment={},
        stdout=output,
    )

    assert exit_code == 1
    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text())
    assert summary["selection"] == [
        {
            "capability": "kernel-python",
            "deferred_to": None,
            "path": "python/tests/kernel/test_rule.py",
            "proof": "pytest:python/tests/kernel/test_rule.py::test_rule",
            "reason": "explicit-focus",
            "sensitivity_required": False,
        }
    ]


def test_plain_focus_keeps_every_manifest_owned_journey_route(tmp_path: Path) -> None:
    source = tmp_path / "apps/web/src/lib/panes/paneRenderRegistry.tsx"
    source.parent.mkdir(parents=True)
    source.write_text("export const registry = {}\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [],
                "journeys": [
                    {
                        "proof": f"apps/web/e2e/journeys/{journey}.journey.spec.ts",
                        "source_globs": ["apps/web/src/lib/panes/paneRenderRegistry.tsx"],
                    }
                    for journey in ("reader-open", "search-open")
                ],
            }
        )
    )

    selections = _focus_selections(
        tmp_path,
        "apps/web/src/lib/panes/paneRenderRegistry.tsx",
        load_selection_index(tmp_path),
    )

    assert len(selections) == 3
    assert {selection.capability for selection in selections} == {
        Capability.COMPONENT,
        Capability.JOURNEYS_ALL,
    }
    assert {
        selection.path for selection in selections if selection.capability is Capability.COMPONENT
    } == {"apps/web/src/lib/panes/paneRenderRegistry.tsx"}
    assert all(selection.reason is SelectionReason.EXPLICIT_FOCUS for selection in selections)
    assert {selection.proof for selection in selections} == {
        None,
        "playwright:apps/web/e2e/journeys/reader-open.journey.spec.ts",
        "playwright:apps/web/e2e/journeys/search-open.journey.spec.ts",
    }


def test_pr_records_later_cadence_selection_without_dispatching_it() -> None:
    routed = _route_selection_for_workflow(
        Workflow.PR,
        (
            Selection(
                "apps/web/src/lib/panes/paneRenderRegistry.tsx",
                Capability.JOURNEYS_ALL,
                SelectionReason.JOURNEY_OWNER,
                "playwright:apps/web/e2e/journeys/reader-open.journey.spec.ts",
                sensitivity_required=True,
            ),
            Selection(
                "python/tests/hosted/nightly/test_openai_canary.py",
                Capability.HOSTED,
                SelectionReason.CHANGED_TEST,
                "pytest:python/tests/hosted/nightly/test_openai_canary.py",
            ),
            Selection(
                "python/nexus/auth/verifier.py",
                Capability.SERVICE,
                SelectionReason.PRIORITY_RISK,
                "pytest:python/tests/service/test_auth_privacy.py::test_auth",
            ),
            Selection(
                "testdata/faults/manifest.json",
                Capability.SENSITIVITY,
                SelectionReason.PROMOTED_CAPABILITY,
            ),
        ),
    )

    assert [(selection.capability, selection.deferred_to) for selection in routed] == [
        (Capability.JOURNEYS_ALL, Workflow.FULL),
        (Capability.HOSTED, Workflow.NIGHTLY),
        (Capability.SERVICE, None),
        (Capability.SENSITIVITY, None),
    ]
    assert routed[0].sensitivity_required is True

    confidence = _route_selection_for_workflow(
        Workflow.CONFIDENCE,
        (
            Selection(
                "testdata/faults/manifest.json",
                Capability.SENSITIVITY,
                SelectionReason.PROMOTED_CAPABILITY,
            ),
        ),
    )
    assert confidence[0].deferred_to is Workflow.PR


def test_machine_sensitivity_is_reserved_for_declared_risk_or_fault_owners(
    tmp_path: Path,
) -> None:
    path = "python/tests/service/test_risk.py"
    file_proof = f"pytest:{path}"
    selection = Selection(
        path,
        Capability.SERVICE,
        SelectionReason.CHANGED_TEST,
        file_proof,
        sensitivity_required=True,
    )
    fault_manifest = tmp_path / "testdata/faults/manifest.json"
    fault_manifest.parent.mkdir(parents=True)
    fault_manifest.write_text('{"version":1,"faults":[]}\n', encoding="utf-8")

    ordinary = _canonical_selection(tmp_path, selection)

    assert ordinary.proof == file_proof
    assert ordinary.sensitivity_required is False

    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    exact_proof = f"{file_proof}::test_priority_risk"
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [{"proofs": [exact_proof]}],
                "journeys": [],
            }
        ),
        encoding="utf-8",
    )

    priority = _canonical_selection(tmp_path, selection)

    assert priority.proof == exact_proof
    assert priority.sensitivity_required is True


def test_prove_requires_a_clean_committed_checkout(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_rule():\n    assert True\n")
    errors = StringIO()
    output = StringIO()

    exit_code = main(
        [
            "prove",
            "--proof",
            "pytest:python/tests/kernel/test_rule.py::test_rule",
            "--against",
            "base:HEAD",
        ],
        repo_root=tmp_path,
        stdout=output,
        stderr=errors,
    )

    assert exit_code == 1
    assert errors.getvalue() == ""
    summary_path = tmp_path / output.getvalue().strip().split("summary=", 1)[1]
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    evidence = prove_evidence_from_json(tmp_path, summary)
    assert summary["version"] == 2
    assert summary["command"] == "prove"
    assert evidence.status is RunStatus.FAIL
    assert "clean committed checkout" in evidence.detail


def test_clean_is_a_no_op_without_owned_runtime_state(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    output = StringIO()

    assert main(["clean"], repo_root=tmp_path, environment={}, stdout=output) == 0
    assert output.getvalue() == "clean: pass; runs=0; runtime=absent\n"


def test_clean_rejects_caller_resource_configuration_before_contact(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    errors = StringIO()

    assert (
        main(
            ["clean"],
            repo_root=tmp_path,
            environment={
                "NEXUS_ENV": "production",
                "DATABASE_URL": "postgresql://production.example/app",
            },
            stderr=errors,
        )
        == 1
    )
    assert "non-test NEXUS_ENV" in errors.getvalue()


def _git_repository(path: Path) -> None:
    (path / "README.md").write_text("test repository\n")
    (path / ".gitignore").write_text("test-results/\n.nexus-test/\n")
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "add", "README.md", ".gitignore"], cwd=path, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Nexus Test",
            "-c",
            "user.email=nexus@example.invalid",
            "commit",
            "-qm",
            "test fixture",
        ],
        cwd=path,
        check=True,
    )
