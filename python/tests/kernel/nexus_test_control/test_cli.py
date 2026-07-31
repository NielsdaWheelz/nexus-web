import json
import subprocess
from io import StringIO
from pathlib import Path

import pytest

from nexus_test_control.cli import (
    ListCommand,
    ProveCommand,
    WorkflowCommand,
    _focus_selections,
    _route_selection_for_workflow,
    main,
    parse_command,
    write_summary,
)
from nexus_test_control.evidence import CapabilityEvidence, PeakOwnedMemory, RunEvidence
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
    manifest.parent.mkdir(parents=True)
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

    assert len(selections) == 2
    assert {selection.capability for selection in selections} == {Capability.JOURNEYS_ALL}
    assert {selection.proof for selection in selections} == {
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


def test_prove_requires_a_clean_committed_checkout(tmp_path: Path) -> None:
    _git_repository(tmp_path)
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_rule():\n    assert True\n")
    errors = StringIO()

    exit_code = main(
        [
            "prove",
            "--proof",
            "pytest:python/tests/kernel/test_rule.py::test_rule",
            "--against",
            "base:HEAD",
        ],
        repo_root=tmp_path,
        stderr=errors,
    )

    assert exit_code == 1
    assert errors.getvalue() == (
        "test control failed: sensitivity requires a clean committed checkout\n"
    )


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
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
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
