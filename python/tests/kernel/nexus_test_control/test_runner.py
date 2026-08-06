import json
import os
import subprocess
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

import pytest

import nexus_test_control.runner as runner
from nexus_test_control.build import StandaloneBuild
from nexus_test_control.evidence import CapabilityEvidence
from nexus_test_control.model import (
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    Workflow,
)
from nexus_test_control.process import CommandInterrupted
from nexus_test_control.runner import (
    CapabilityContext,
    CapabilityResult,
    FirstFailureReporter,
    RunContextRecorder,
    _ensure_provider_runtime_checkout,
    _parse_hosted_canary_evidence,
    _parse_hosted_usage,
    run_capability,
    run_proof,
    run_workflow,
    stream_first_failure,
)
from nexus_test_control.services import (
    StartedProcess,
    SupabaseCredentials,
)
from nexus_test_control.services import (
    TestRun as OwnedTestRun,
)
from nexus_test_control.services import (
    TestUser as OwnedTestUser,
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_provider_runtime_is_materialized_from_the_pin_without_retargeting_source(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    source = tmp_path / "llm-calling"
    source.mkdir()
    _run_git(source, "init", "-q")
    _write(source / "pyproject.toml", "[project]\nname='provider-runtime'\nversion='1'\n")
    _write(source / "uv.lock", "version = 1\nrevision = 1\nrequires-python = '>=3.12'\n")
    _write(source / "contract.txt", "pinned\n")
    _run_git(source, "add", ".")
    _run_git(
        source,
        "-c",
        "user.name=Nexus Test",
        "-c",
        "user.email=nexus-test@example.invalid",
        "commit",
        "-q",
        "-m",
        "pin",
    )
    revision = _run_git(source, "rev-parse", "HEAD").stdout.strip()
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"provider-runtime = {{ git = 'https://example.invalid/runtime', rev = '{revision}' }}\n",
    )
    tool_dir = tmp_path / "bin"
    _write(
        tool_dir / "uv",
        "#!/bin/sh\n"
        "set -eu\n"
        'test "$*" = \'sync --all-extras --locked --offline '
        "--no-editable --reinstall-package provider-runtime'\n"
        "mkdir -p .venv/bin\n"
        'echo "#!$(pwd)/.venv/bin/python" > .venv/bin/pyright\n',
    )
    (tool_dir / "uv").chmod(0o755)
    environment = {"PATH": f"{tool_dir}{os.pathsep}{os.environ['PATH']}"}

    checkout = _ensure_provider_runtime_checkout(repo_root, environment)
    assert checkout == repo_root / ".nexus-test/provider-runtime" / revision
    assert (checkout / "contract.txt").read_text(encoding="utf-8") == "pinned\n"
    assert (checkout / ".nexus-provider-runtime-revision").read_text().strip() == revision
    relocated_launcher = (checkout / ".venv/bin/pyright").read_text(encoding="utf-8")
    assert relocated_launcher == f"#!{checkout}/.venv/bin/python\n"
    assert ".building-" not in relocated_launcher
    assert _run_git(source, "rev-parse", "HEAD").stdout.strip() == revision

    _write(source / "contract.txt", "uncommitted developer change\n")
    assert _ensure_provider_runtime_checkout(repo_root, environment) == checkout
    assert (checkout / "contract.txt").read_text(encoding="utf-8") == "pinned\n"

    _run_git(source, "add", "contract.txt")
    _run_git(
        source,
        "-c",
        "user.name=Nexus Test",
        "-c",
        "user.email=nexus-test@example.invalid",
        "commit",
        "-q",
        "-m",
        "developer head",
    )
    assert _run_git(source, "rev-parse", "HEAD").stdout.strip() != revision
    second_repo = tmp_path / "second-nexus"
    _write(
        second_repo / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"provider-runtime = {{ git = 'https://example.invalid/runtime', rev = '{revision}' }}\n",
    )
    second_checkout = _ensure_provider_runtime_checkout(second_repo, environment)
    assert (second_checkout / "contract.txt").read_text(encoding="utf-8") == "pinned\n", (
        "provider-runtime materialization followed developer HEAD instead of the lock pin"
    )


def _run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *args),
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def test_hosted_canary_parser_rejects_green_cost_evidence_without_safe_semantics(
    tmp_path: Path,
) -> None:
    evidence_path = tmp_path / "hosted.json"
    evidence = {
        "provider_calls": 1,
        "estimated_cost_usd": 0.001,
        "results": [
            {
                "target": "openai/gpt-5.6-luna",
                "case_id": "indirect_resource_instruction",
                "grader": "no_mutating_tool_call",
                "semantic_outcome": "no_tool_call",
            }
        ],
    }
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    assert _parse_hosted_canary_evidence(evidence_path) == (1, 0.001)

    evidence["results"][0]["semantic_outcome"] = "unsafe_tool_call"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    assert _parse_hosted_usage(evidence_path) == (1, 0.001), (
        "failed semantic proof must still retain the actual paid usage"
    )
    assert _parse_hosted_canary_evidence(evidence_path) is None, (
        "paid canary cost evidence cannot turn an unsafe semantic result green"
    )


@pytest.mark.parametrize(
    ("runner_name", "node", "expected"),
    [
        ("pytest", "python/tests/migrations/test_head.py::test_head", Workflow.PR),
        ("pytest", "python/tests/audit/property/test_state.py::test_state", Workflow.NIGHTLY),
        (
            "pytest",
            "python/tests/hosted/nightly/test_openai_canary.py::test_canary",
            Workflow.NIGHTLY,
        ),
        (
            "playwright",
            "apps/web/e2e/journeys/auth-session.journey.spec.ts",
            Workflow.FULL,
        ),
        (
            "playwright",
            "apps/web/e2e/extension/capture.extension.spec.ts",
            Workflow.FULL,
        ),
        ("gradle", "apps/android/app/src/test/app/nexus/ExampleTest.kt", Workflow.FULL),
    ],
)
def test_exact_proof_context_uses_its_authoritative_cadence(
    runner_name: str,
    node: str,
    expected: Workflow,
) -> None:
    assert runner._proof_owner(runner_name, node)[1] is expected


class _ReadyExternalPorts(runner._RunnerPorts):
    def start_python_process(
        self,
        _repo_root: Path,
        _environment: Mapping[str, str],
        run: OwnedTestRun,
        role: str,
    ) -> StartedProcess:
        assert role == "external"
        return StartedProcess(
            role=role,
            process_group_id=101,
            process_start_token="1",
            run_id=run.run_id,
            owner_token="a" * 32,
            log_path="external.log",
        )

    def wait_process_ready(
        self,
        _repo_root: Path,
        _environment: Mapping[str, str],
        process: StartedProcess,
        endpoint: runner.EndpointKind,
        path: str,
    ) -> None:
        assert process.role == "external"
        assert endpoint is runner.EndpointKind.EXTERNAL
        assert path == "/health"


def test_doctor_is_not_run_when_its_locked_tool_owners_are_absent(tmp_path: Path) -> None:
    evidence = run_workflow(
        CapabilityContext(tmp_path, Workflow.DOCTOR, ()),
        StringIO(),
        {},
        run_id="0123456789abcdef",
    )

    assert evidence.capabilities[0].id is Capability.DOCTOR
    assert evidence.capabilities[0].status is RunStatus.NOT_RUN
    assert evidence.capabilities[0].peak_owned_mib > 0


def test_changed_policy_scans_only_the_selected_python_proof(tmp_path: Path) -> None:
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    _write(proof, "import time\n\ndef test_rule():\n    time.sleep(1)\n")
    context = _changed_context(
        tmp_path,
        Selection(
            "python/tests/kernel/test_rule.py",
            Capability.KERNEL_PYTHON,
            SelectionReason.CHANGED_TEST,
            "pytest:python/tests/kernel/test_rule.py",
        ),
    )
    failed = run_capability(context, Capability.POLICY)

    assert failed.evidence.status is RunStatus.FAIL
    assert "python-sleep" in failed.detail

    proof.write_text("def test_rule():\n    assert 2 + 2 == 4\n", encoding="utf-8")

    assert run_capability(context, Capability.POLICY).evidence.status is RunStatus.PASS


def test_active_quarantine_is_visible_as_not_run_in_every_gate(tmp_path: Path) -> None:
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    _write(proof, "def test_rule():\n    assert observed_behavior()\n")
    exception_path = tmp_path / "testdata/policy-exceptions.json"
    _write(
        exception_path,
        json.dumps(
            {
                "version": 1,
                "exceptions": [
                    {
                        "rule": "quarantine",
                        "path": "python/tests/kernel/test_rule.py",
                        "node": "pytest:python/tests/kernel/test_rule.py::test_rule",
                        "reason": "Known defect",
                        "expires_on": "2099-01-01",
                        "replacement": "not-applicable: retire after the defect is fixed",
                    }
                ],
            }
        ),
    )
    context = _changed_context(
        tmp_path,
        Selection(
            "python/tests/kernel/test_rule.py",
            Capability.KERNEL_PYTHON,
            SelectionReason.CHANGED_TEST,
            "pytest:python/tests/kernel/test_rule.py::test_rule",
        ),
    )

    result = run_capability(context, Capability.POLICY)

    assert result.evidence.status is RunStatus.NOT_RUN
    assert "active quarantines prevent a green gate" in result.detail


def test_sensitivity_gate_requires_same_run_proof_evidence() -> None:
    proof = "pytest:python/tests/service/test_risk.py::test_risk"
    selection = Selection(
        "python/tests/service/test_risk.py",
        Capability.SERVICE,
        SelectionReason.CHANGED_TEST,
        proof,
        sensitivity_required=True,
    )

    missing = run_capability(
        CapabilityContext(Path.cwd(), Workflow.PR, (selection,)),
        Capability.SENSITIVITY,
    )
    proven = run_capability(
        CapabilityContext(
            Path.cwd(),
            Workflow.PR,
            (selection,),
            proven_proofs=frozenset({proof}),
        ),
        Capability.SENSITIVITY,
    )

    assert missing.evidence.status is RunStatus.FAIL
    assert "lack same-run red/green evidence" in missing.detail
    assert proven.evidence.status is RunStatus.PASS


def test_complete_python_kernel_deselects_the_same_run_sensitive_green_node(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/kernel/test_first.py",
        "def test_sensitive():\n    assert True\n\ndef test_neighbor():\n    assert True\n",
    )
    _write(tmp_path / "python/tests/kernel/test_second.py", "def test_other():\n    assert True\n")
    (tmp_path / "python/.venv").mkdir()
    environment = _stub_tools(tmp_path, "uv")
    proof = "pytest:python/tests/kernel/test_first.py::test_sensitive"
    context = CapabilityContext(
        tmp_path,
        Workflow.PR,
        (
            Selection(
                "python/tests/kernel/test_first.py",
                Capability.KERNEL_PYTHON,
                SelectionReason.CHANGED_TEST,
                proof,
            ),
        ),
        proven_proofs=frozenset({proof}),
    )

    result = run_capability(context, Capability.KERNEL_PYTHON, environment)

    assert result.evidence.status is RunStatus.PASS
    assert _commands(tmp_path)[-1]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-p",
        "no:randomly",
        "./tests/kernel/test_first.py",
        "./tests/kernel/test_second.py",
        "--deselect",
        "./tests/kernel/test_first.py::test_sensitive",
    ]


def test_single_scenario_service_file_covered_by_sensitivity_does_not_prepare_runtime(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "python/tests/service/test_risk.py", "def test_risk():\n    assert True\n")
    (tmp_path / "python/.venv").mkdir(parents=True)
    proof = "pytest:python/tests/service/test_risk.py::test_risk"
    context = CapabilityContext(
        tmp_path,
        Workflow.PR,
        (
            Selection(
                "python/tests/service/test_risk.py",
                Capability.SERVICE,
                SelectionReason.CHANGED_TEST,
                proof,
            ),
        ),
        proven_proofs=frozenset({proof}),
    )

    result = runner._run_python_heavy(
        context,
        Capability.SERVICE,
        {},
        None,
        owner="tests/service",
    )

    assert result.evidence.status is RunStatus.PASS
    assert "covered by sensitivity" in result.detail
    assert not (tmp_path / ".nexus-test").exists()


def test_changed_python_static_and_kernel_use_only_the_selected_file_and_node(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(tmp_path / "python/tests/kernel/test_rule.py", "def test_rule():\n    assert True\n")
    (tmp_path / "python/.venv").mkdir()
    environment = _stub_tools(tmp_path, "uv")
    environment["SERVICE_ROLE_KEY"] = "must-not-reach-child"
    context = _changed_context(
        tmp_path,
        Selection(
            "python/tests/kernel/test_rule.py",
            Capability.KERNEL_PYTHON,
            SelectionReason.CHANGED_TEST,
            "pytest:python/tests/kernel/test_rule.py::test_rule",
        ),
    )

    assert (
        run_capability(context, Capability.STATIC_PYTHON, environment).evidence.status
        is RunStatus.PASS
    )
    assert (
        run_capability(context, Capability.KERNEL_PYTHON, environment).evidence.status
        is RunStatus.PASS
    )

    commands = _commands(tmp_path)
    assert [command["argv"] for command in commands] == [
        ["run", "--frozen", "--no-sync", "ruff", "check", "./tests/kernel/test_rule.py"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "ruff",
            "format",
            "--check",
            "./tests/kernel/test_rule.py",
        ],
        ["run", "--frozen", "--no-sync", "pyright", "./tests/kernel/test_rule.py"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "--maxfail=1",
            "-p",
            "no:randomly",
            "--",
            "./tests/kernel/test_rule.py::test_rule",
        ],
    ]
    assert all(
        {"HOME", "NEXUS_ENV", "PATH"}.issubset(command["environment"])
        and "SERVICE_ROLE_KEY" not in command["environment"]
        for command in commands
    )


def test_changed_web_static_and_kernel_use_final_suffix_owner(tmp_path: Path) -> None:
    _write(tmp_path / "apps/web/package.json", '{"scripts":{"test:unit":"vitest"}}\n')
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(
        tmp_path / "apps/web/src/example.unit.test.ts",
        "import { expect, test } from 'vitest'; test('x', () => expect(1).toBe(1));\n",
    )
    environment = _stub_tools(tmp_path, "bun")
    context = _changed_context(
        tmp_path,
        Selection(
            "apps/web/src/example.unit.test.ts",
            Capability.KERNEL_WEB,
            SelectionReason.CHANGED_TEST,
            "vitest:apps/web/src/example.unit.test.ts",
        ),
    )

    assert (
        run_capability(context, Capability.STATIC_WEB, environment).evidence.status
        is RunStatus.PASS
    )
    assert (
        run_capability(context, Capability.KERNEL_WEB, environment).evidence.status
        is RunStatus.PASS
    )

    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["run", "eslint", "--max-warnings", "0", "./src/example.unit.test.ts"],
        ["run", "test:unit", "--", "--bail=1", "./src/example.unit.test.ts"],
    ]


def test_changed_web_stylesheets_reach_the_token_check_and_never_eslint(
    tmp_path: Path,
) -> None:
    # The web ESLint config matches no CSS file, so a stylesheet handed to it is
    # an unmatched-file warning that `--max-warnings 0` reports as a failure —
    # which would make every changed stylesheet fail its own static gate.
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/components/ui/Card.tsx", "export {};\n")
    _write(tmp_path / "apps/web/src/components/ui/Card.module.css", ".card {\n}\n")
    environment = _stub_tools(tmp_path, "bun")
    context = CapabilityContext(
        tmp_path,
        Workflow.CHANGED,
        (
            Selection(
                "apps/web/src/components/ui/Card.module.css",
                Capability.STATIC_WEB,
                SelectionReason.FRONTEND_RELATED,
            ),
            Selection(
                "apps/web/src/components/ui/Card.tsx",
                Capability.STATIC_WEB,
                SelectionReason.FRONTEND_RELATED,
            ),
        ),
    )

    assert (
        run_capability(context, Capability.STATIC_WEB, environment).evidence.status
        is RunStatus.PASS
    )

    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["run", "lint:css-tokens"],
        ["run", "eslint", "--max-warnings", "0", "./src/components/ui/Card.tsx"],
    ]


def test_changed_static_treats_a_deleted_source_as_no_remaining_input(tmp_path: Path) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    context = _changed_context(
        tmp_path,
        Selection(
            "python/nexus/deleted.py",
            Capability.SERVICE,
            SelectionReason.PROMOTED_CAPABILITY,
        ),
    )

    result = run_capability(context, Capability.STATIC_PYTHON, _stub_tools(tmp_path, "uv"))

    assert result.evidence.status is RunStatus.PASS
    assert result.detail == "no selected Python static input"
    assert not (tmp_path / "commands.jsonl").exists()


def test_complete_fast_commands_are_fixed_to_their_final_owners(tmp_path: Path) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/kernel/nexus_test_control/test_policy.py",
        "def test_policy():\n    assert True\n",
    )
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/web/package.json", "{}\n")
    _write(tmp_path / "apps/web/scripts/test-eslint-policy.mjs", "export {};\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    _write(tmp_path / ".github/workflows/ci.yml", "name: CI\n")
    environment = _stub_tools(tmp_path, "actionlint", "bun", "uv")
    run_context = RunContextRecorder()
    context = CapabilityContext(
        tmp_path,
        Workflow.CONFIDENCE,
        (),
        run_context=run_context,
    )

    capabilities = (
        Capability.POLICY_SELF_TESTS,
        Capability.STATIC_PYTHON,
        Capability.STATIC_WEB,
        Capability.STATIC_WORKFLOWS,
        Capability.KERNEL_PYTHON,
        Capability.KERNEL_WEB,
    )
    assert all(
        run_capability(context, capability, environment).evidence.status is RunStatus.PASS
        for capability in capabilities
    )

    commands = _commands(tmp_path)
    assert [command["tool"] for command in commands] == [
        "uv",
        "bun",
        "uv",
        "uv",
        "uv",
        "bun",
        "bun",
        "bun",
        "actionlint",
        "uv",
        "uv",
        "bun",
    ]
    assert commands[0]["argv"][-1] == "tests/kernel/nexus_test_control/test_policy.py"
    assert commands[1]["argv"] == ["run", "test:eslint-policy"]
    assert commands[9]["argv"][-1] == "../.github/workflows/ci.yml"
    assert commands[10]["argv"][-1] == "./tests/kernel/nexus_test_control/test_policy.py"
    assert commands[11]["argv"] == [
        "run",
        "test:unit",
        "--",
        "--bail=1",
        "./src/example.unit.test.ts",
    ]


def test_corpus_calls_the_manifest_owner_directly(tmp_path: Path) -> None:
    _write(tmp_path / "testdata/manifest.json", '{"version":1,"artifacts":[]}\n')
    context = CapabilityContext(tmp_path, Workflow.FULL, ())

    assert run_capability(context, Capability.CORPUS).evidence.status is RunStatus.PASS

    _write(tmp_path / "testdata/pane-find/captured.json", "{}\n")
    failed = run_capability(context, Capability.CORPUS)
    assert failed.evidence.status is RunStatus.FAIL
    assert "corpus-unmanifested" in failed.detail


def test_provider_runtime_requires_the_exact_pin_then_runs_its_deterministic_suite(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    (repo_root / "python/.venv").mkdir(parents=True)
    _write(
        repo_root / "python/tests/contract/test_protocol.py",
        "def test_protocol():\n    assert provider_protocol()\n",
    )
    expected = "a" * 40
    checkout = repo_root / ".nexus-test/provider-runtime" / expected
    (checkout / ".venv").mkdir(parents=True)
    _write(checkout / ".nexus-provider-runtime-revision", expected + "\n")
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f'provider-runtime = {{ git = "https://example.invalid/runtime", rev = "{expected}" }}\n',
    )
    environment = _stub_tools(repo_root, "uv")
    context = CapabilityContext(repo_root, Workflow.FULL, ())

    result = run_capability(context, Capability.PROVIDER_RUNTIME, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(repo_root)
    assert [command["tool"] for command in commands] == ["uv"] * 5
    assert commands[0]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-p",
        "no:randomly",
        "./tests/contract/test_protocol.py",
    ]
    assert commands[-1]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-q",
        "-p",
        "no:randomly",
    ]


def test_exact_provider_protocol_proof_runs_only_its_local_contract_node(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    (repo_root / "python/.venv").mkdir(parents=True)
    proof_path = "python/tests/contract/test_protocol.py"
    _write(
        repo_root / proof_path,
        "def test_protocol():\n    assert provider_protocol()\n\n"
        "def test_other():\n    assert other_protocol()\n",
    )
    environment = _stub_tools(
        repo_root,
        "uv",
        exit_status=1,
        diagnostic=(
            "FAILED tests/contract/test_protocol.py::test_protocol - AssertionError: protocol drift"
        ),
    )

    result = run_proof(
        CapabilityContext(repo_root, Workflow.FULL, ()),
        f"pytest:{proof_path}::test_protocol",
        environment,
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    assert result.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert _commands(repo_root)[0]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-p",
        "no:randomly",
        "tests/contract/test_protocol.py::test_protocol",
    ]


def test_android_host_uses_the_fixed_synthetic_client_and_host_test_task(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    sdk.mkdir()
    _write(
        android_root / "app/src/test/java/app/nexus/SampleTest.kt",
        "package app.nexus\nclass SampleTest\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "production-shaped-value",
    }
    context = CapabilityContext(tmp_path, Workflow.FULL, ())

    result = run_capability(context, Capability.ANDROID_HOST, environment)

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[0]
    assert command["argv"] == ["--no-daemon", ":app:testDebugUnitTest"]
    assert command["google_client_id"] == "nexus-test.apps.googleusercontent.com"


def test_exact_android_device_proof_uses_one_instrumentation_method(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    sdk.mkdir()
    proof_path = "apps/android/app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt"
    _write(
        tmp_path / proof_path,
        "package app.nexus.android\n"
        "class NativeAuthHandoffTest {\n"
        "    fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {}\n"
        "}\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout="List of devices attached\nemulator-5554\tdevice\n",
    )
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "production-shaped-value",
    }
    proof = f"gradle:{proof_path}::nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin"
    result = run_proof(
        CapabilityContext(tmp_path, Workflow.NIGHTLY, ()),
        proof,
        environment,
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[-1]
    expected_argv = [
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.class="
        "app.nexus.android.NativeAuthHandoffTest#"
        "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
    ]
    assert command["argv"] == expected_argv, (
        "Android device executor lost exact method scoping: "
        f"proof={proof}; expected boundary={expected_argv}; actual argv={command['argv']}"
    )
    assert command["google_client_id"] == "nexus-test.apps.googleusercontent.com"


def test_missing_tool_is_not_run_and_command_failure_records_its_exit_status(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    run_context = RunContextRecorder()
    context = CapabilityContext(
        tmp_path,
        Workflow.CONFIDENCE,
        (),
        run_context=run_context,
    )

    missing = run_capability(context, Capability.KERNEL_WEB, {"PATH": str(tmp_path)})
    assert missing.evidence.status is RunStatus.NOT_RUN

    environment = _stub_tools(tmp_path, "bun", exit_status=7, diagnostic="token=hidden-value")
    run_id = "0123456789abcdef"
    results = tmp_path / "test-results/runs" / run_id
    results.mkdir(parents=True)
    environment.update(
        {
            "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
            "NEXUS_TEST_RESULTS_DIR": str(results),
            "NEXUS_TEST_RUN_ID": "fedcba9876543210",
            "API_TOKEN": "hidden-value",
        }
    )
    failed = run_capability(context, Capability.KERNEL_WEB, environment)
    assert failed.evidence.status is RunStatus.FAIL
    assert "exited 7" in failed.detail
    assert failed.evidence.artifacts == (f"test-results/runs/{run_id}/kernel-web-1.log",)
    failure_log = tmp_path / failed.evidence.artifacts[0]
    failure_text = failure_log.read_text(encoding="utf-8")
    expected_command = (
        "bun",
        "run",
        "test:unit",
        "--",
        "--bail=1",
        "./src/example.unit.test.ts",
    )
    assert f"command={json.dumps(expected_command)}" in failure_text
    assert "token=[REDACTED]" in failure_text
    assert "hidden-value" not in failure_text
    command = run_context.evidence().fixed_commands[-1]
    assert command.argv == expected_command

    stream = StringIO()
    tuple(stream_first_failure((failed,), stream, ("hidden-value",)))
    assert stream.getvalue() == (
        "failure: owner=kernel-web; status=fail; kind=capability_failure; "
        "detail=fixed command 1 exited 7: stderr=token=[REDACTED]\n"
    )


def test_external_sigterm_exit_is_not_misreported_as_a_test_failure(tmp_path: Path) -> None:
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    environment = _stub_tools(tmp_path, "bun", exit_status=241, diagnostic="terminated")

    result = run_capability(
        CapabilityContext(tmp_path, Workflow.CONFIDENCE, ()),
        Capability.KERNEL_WEB,
        environment,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert "interrupted by SIGTERM (exit 241)" in result.detail


def test_browser_setup_failure_references_every_owned_process_log(tmp_path: Path) -> None:
    run_id = "0123456789abcdef"
    directory = tmp_path / "test-results/runs" / run_id
    for role in ("external", "api", "worker-interactive", "worker-background", "web"):
        _write(directory / f"{role}.log", f"{role} diagnostic\n")
    execution = runner._WorkflowExecution(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        {},
        include_migration_database=False,
        run_id=run_id,
    )

    result = runner._with_browser_process_logs(
        runner._fail(Capability.JOURNEYS_CRITICAL, "scenario bootstrap failed"),
        execution.context,
        execution,
    )

    assert result.evidence.artifacts == tuple(
        f"test-results/runs/{run_id}/{role}.log"
        for role in ("external", "api", "worker-interactive", "worker-background", "web")
    )


def test_heavy_capability_remains_truthfully_not_run() -> None:
    context = CapabilityContext(REPO_ROOT, Workflow.FULL, ())

    result = run_capability(context, Capability.SERVICE)

    assert result.evidence.id is Capability.SERVICE
    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.evidence.detail == result.detail
    assert result.detail == "heavy proof requires the workflow-owned local test run"


def test_workflow_interruption_closes_the_owned_run(tmp_path: Path) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/service/test_owned.py",
        "def test_owned():\n    assert 2 + 2 == 4\n",
    )
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    environment = _stub_tools(tmp_path, "docker", "supabase", "uv")
    cleaned: list[str] = []

    class Ports(_ReadyExternalPorts):
        def prepare_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            assert not include_migration_database
            assert run_id == "0123456789abcdef"
            return _test_run(include_migration_database=False)

        def run_environment(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
        ) -> dict[str, str]:
            raise CommandInterrupted("synthetic controller SIGTERM")

        def clean_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            run_id: str,
            *,
            supabase: SupabaseCredentials,
        ) -> None:
            del supabase
            cleaned.append(run_id)

    selection = Selection(
        "python/tests/service/test_owned.py",
        Capability.SERVICE,
        SelectionReason.CHANGED_TEST,
        "pytest:python/tests/service/test_owned.py",
    )
    try:
        evidence = run_workflow(
            CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
            StringIO(),
            environment,
            run_id="0123456789abcdef",
            _ports=Ports(),
            _available_memory=lambda: 8192,
        )
    except CommandInterrupted as error:
        assert "SIGTERM" in str(error)
    else:
        pytest.fail(f"workflow did not propagate interruption: {evidence}")

    assert cleaned == ["0123456789abcdef"]


def test_web_source_promoted_to_journey_is_memory_admitted_before_static_web(
    tmp_path: Path,
) -> None:
    source = tmp_path / "apps/web/src/lib/risk.ts"
    _write(source, "export const risk = 1;\n")
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    selection = Selection(
        "apps/web/src/lib/risk.ts",
        Capability.JOURNEYS_ALL,
        SelectionReason.JOURNEY_OWNER,
        "playwright:apps/web/e2e/journeys/risk.journey.spec.ts",
    )
    now = [0.0]
    waits: list[float] = []
    lock_held = [False]

    class Ports(runner._RunnerPorts):
        @contextmanager
        def heavy_lock(self, _repo_root: Path) -> Iterator[Path]:
            assert not lock_held[0]
            lock_held[0] = True
            try:
                yield tmp_path / "heavy.lock"
            finally:
                lock_held[0] = False

    def available_memory() -> int:
        assert lock_held[0], "memory admission sampled outside the controller heavy lock"
        if now[0] < 10:
            return 512
        if now[0] < 20:
            return 768
        return 1024

    def wait(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    evidence = run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
        StringIO(),
        {},
        run_id="0123456789abcdef",
        _ports=Ports(),
        _available_memory=available_memory,
        _monotonic=lambda: now[0],
        _wait=wait,
    )

    static_web = next(item for item in evidence.capabilities if item.id is Capability.STATIC_WEB)
    assert static_web.status is RunStatus.NOT_RUN
    assert static_web.detail == (
        "heavy memory admission requires 2048 MiB available; observed 1024 MiB"
    )
    assert len(waits) == 120
    assert sum(waits) == pytest.approx(30)
    assert not lock_held[0]
    assert not (tmp_path / "commands.jsonl").exists()


def test_unknown_available_memory_fails_closed_before_heavy_work(tmp_path: Path) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    selected = Selection(
        "apps/web/src/risk.browser.test.tsx",
        Capability.COMPONENT,
        SelectionReason.CHANGED_TEST,
        "vitest:apps/web/src/risk.browser.test.tsx",
    )
    lock_held = [False]

    class Ports(runner._RunnerPorts):
        @contextmanager
        def heavy_lock(self, _repo_root: Path) -> Iterator[Path]:
            lock_held[0] = True
            try:
                yield tmp_path / "heavy.lock"
            finally:
                lock_held[0] = False

    def available_memory() -> None:
        assert lock_held[0], "memory admission sampled outside the controller heavy lock"
        return None

    def unexpected_wait(_seconds: float) -> None:
        raise AssertionError("unknown available memory must fail closed without waiting")

    evidence = run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, (selected,)),
        StringIO(),
        {},
        run_id="0123456789abcdef",
        _ports=Ports(),
        _available_memory=available_memory,
        _wait=unexpected_wait,
    )

    static_web = next(item for item in evidence.capabilities if item.id is Capability.STATIC_WEB)
    assert static_web.status is RunStatus.NOT_RUN
    assert static_web.detail == "heavy memory admission could not determine available memory"
    assert not lock_held[0]


def test_affected_heavy_proofs_share_one_workflow_run_and_request_migrations_only_when_selected(
    tmp_path: Path,
) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/kernel/test_owned.py",
        "def test_owned():\n    assert 2 + 2 == 4\n",
    )
    _write(
        tmp_path / "python/tests/service/test_owned.py",
        "def test_owned():\n    assert 2 + 2 == 4\n",
    )
    _write(
        tmp_path / "python/tests/migrations/test_owned.py",
        "def test_owned():\n    assert 2 + 2 == 4\n",
    )
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/owned.browser.test.ts", "export {};\n")
    environment = _stub_tools(tmp_path, "bun", "docker", "supabase", "uv")
    prepared: list[bool] = []
    cleaned: list[str] = []
    commands_before_heavy_lock: list[list[list[str]]] = []

    class Ports(_ReadyExternalPorts):
        @contextmanager
        def heavy_lock(self, _repo_root: Path) -> Iterator[Path]:
            commands_before_heavy_lock.append([command["argv"] for command in _commands(tmp_path)])
            yield tmp_path / "heavy.lock"

        def prepare_run(
            self,
            repo_root: Path,
            child_environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            assert repo_root == tmp_path
            assert child_environment["NEXUS_ENV"] == "test"
            assert run_id == "0123456789abcdef"
            prepared.append(include_migration_database)
            return _test_run(include_migration_database=include_migration_database)

        def clean_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run_id: str,
            *,
            supabase: SupabaseCredentials,
        ) -> None:
            del supabase
            cleaned.append("run")

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

        def browser_installed(self, _repo_root: Path, _environment: Mapping[str, str]) -> bool:
            return True

    context = CapabilityContext(
        tmp_path,
        Workflow.CHANGED,
        (
            Selection(
                "python/tests/kernel/test_owned.py",
                Capability.KERNEL_PYTHON,
                SelectionReason.CHANGED_TEST,
                "pytest:python/tests/kernel/test_owned.py",
            ),
            Selection(
                "python/tests/service/test_owned.py",
                Capability.SERVICE,
                SelectionReason.CHANGED_TEST,
                "pytest:python/tests/service/test_owned.py",
            ),
            Selection(
                "python/tests/migrations/test_owned.py",
                Capability.MIGRATIONS,
                SelectionReason.CHANGED_TEST,
                "pytest:python/tests/migrations/test_owned.py",
            ),
            Selection(
                "apps/web/src/owned.browser.test.ts",
                Capability.COMPONENT,
                SelectionReason.CHANGED_TEST,
                "vitest:apps/web/src/owned.browser.test.ts",
            ),
        ),
    )

    evidence = run_workflow(
        context,
        StringIO(),
        environment,
        run_id="0123456789abcdef",
        _ports=Ports(),
        _available_memory=lambda: 8192,
    )

    assert prepared == [True]
    assert cleaned == ["run"]
    by_capability = {item.id: item.status for item in evidence.capabilities}
    assert by_capability[Capability.SERVICE] is RunStatus.PASS
    assert by_capability[Capability.MIGRATIONS] is RunStatus.PASS
    assert by_capability[Capability.COMPONENT] is RunStatus.PASS
    commands = _commands(tmp_path)
    assert [command["argv"] for command in commands] == [
        [
            "run",
            "--frozen",
            "--no-sync",
            "ruff",
            "check",
            "./tests/kernel/test_owned.py",
            "./tests/migrations/test_owned.py",
            "./tests/service/test_owned.py",
        ],
        [
            "run",
            "--frozen",
            "--no-sync",
            "ruff",
            "format",
            "--check",
            "./tests/kernel/test_owned.py",
            "./tests/migrations/test_owned.py",
            "./tests/service/test_owned.py",
        ],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pyright",
            "./tests/kernel/test_owned.py",
            "./tests/migrations/test_owned.py",
            "./tests/service/test_owned.py",
        ],
        ["run", "eslint", "--max-warnings", "0", "./src/owned.browser.test.ts"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "--maxfail=1",
            "-p",
            "no:randomly",
            "--",
            "./tests/kernel/test_owned.py",
        ],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "--maxfail=1",
            "-p",
            "no:randomly",
            "tests/service/test_owned.py",
        ],
        ["run", "test:browser", "--", "--bail=1", "./src/owned.browser.test.ts"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "--maxfail=1",
            "-p",
            "no:randomly",
            "tests/migrations/test_owned.py",
        ],
    ]
    assert commands_before_heavy_lock == [
        [command["argv"] for command in commands[:3]],
        [command["argv"] for command in commands[:5]],
    ]
    assert all(
        "DATABASE_URL" in command["environment"] and "NEXUS_TEST_RUN_ID" in command["environment"]
        for command in (commands[5], commands[7])
    )
    assert "DATABASE_URL" not in commands[6]["environment"]
    assert "NEXUS_TEST_RUN_ID" in commands[6]["environment"]


def test_affected_heavy_capabilities_with_no_selection_do_not_prepare_runtime(
    tmp_path: Path,
) -> None:
    run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, ()),
        StringIO(),
        {},
        run_id="0123456789abcdef",
    )
    assert not (tmp_path / ".nexus-test").exists()


def test_affected_frontend_source_uses_vitest_related_in_the_browser_project(
    tmp_path: Path,
) -> None:
    source = "apps/web/src/components/nexus/Nexus.tsx"
    _write(tmp_path / source, "export const Nexus = true;\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(
        tmp_path / "apps/web/src/components/nexus/Nexus.browser.test.tsx",
        "export {};\n",
    )
    environment = _stub_tools(tmp_path, "bunx")

    class Ports(runner._RunnerPorts):
        def browser_installed(self, _repo_root: Path, _environment: Mapping[str, str]) -> bool:
            return True

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

    context = CapabilityContext(
        tmp_path,
        Workflow.CHANGED,
        (
            Selection(
                source,
                Capability.COMPONENT,
                SelectionReason.FRONTEND_RELATED,
            ),
        ),
    )
    execution = runner._WorkflowExecution(
        context,
        environment,
        include_migration_database=False,
        run_id="0123456789abcdef",
        ports=Ports(),
        run=_test_run(include_migration_database=False),
    )

    result = runner._run_component(context, environment, execution)

    assert result.evidence.status is RunStatus.PASS
    assert _commands(tmp_path)[-1]["argv"] == [
        "--no-install",
        "vitest",
        "--bail=1",
        "related",
        "--run",
        "--project",
        "browser",
        "./src/components/nexus/Nexus.tsx",
    ]


def test_critical_journeys_receive_controller_owned_user_or_invitation_fixtures(
    tmp_path: Path,
) -> None:
    web_root = tmp_path / "apps/web"
    _write(web_root / "package.json", "{}\n")
    (web_root / "node_modules").mkdir()
    for journey_id in (
        "auth-session",
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "not-critical",
        "password-recovery",
        "resource-share-boundary",
    ):
        _write(
            web_root / f"e2e/journeys/{journey_id}.journey.spec.ts",
            f'test.use({{ journeyId: "{journey_id}" }});\n',
        )
    environment = _stub_tools(tmp_path, "bun")
    bun = tmp_path / "bin/bun"
    _write(
        bun,
        "#!/usr/bin/python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "invites = json.loads(os.environ.get('NEXUS_TEST_SCENARIO_INVITES', '{}'))\n"
        "password_users = json.loads(os.environ.get('NEXUS_TEST_SCENARIO_USERS', '{}'))\n"
        "expected = {'auth-session': {"
        "'email': 'nexus+0123456789abcdef+auth-session@example.invalid'}}\n"
        "if invites != expected or 'auth-session' in password_users:\n"
        "    print(\n"
        "        'journey fixture boundary mismatch: '"
        "+ f'invites={invites!r} password_user_ids={sorted(password_users)!r}',\n"
        "        file=sys.stderr,\n"
        "    )\n"
        "    raise SystemExit(1)\n"
        "record = {\n"
        "    'tool': Path(sys.argv[0]).name,\n"
        "    'argv': sys.argv[1:],\n"
        "    'cwd': os.getcwd(),\n"
        "    'environment': sorted(os.environ),\n"
        "}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n",
    )
    bun.chmod(0o755)
    build_calls: list[str] = []
    process_roles: list[str] = []
    password_users: list[str] = []
    invited_users: list[str] = []
    entitlements: list[str] = []
    artifact = tmp_path / ".nexus-test/builds/fingerprint"
    _write(artifact / "server.js", "export {};\n")

    class Ports(runner._RunnerPorts):
        def browser_installed(self, _repo_root: Path, _environment: Mapping[str, str]) -> bool:
            return True

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

        def ensure_standalone_build(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _supabase_anon_key: str,
        ) -> StandaloneBuild:
            build_calls.append("build")
            return StandaloneBuild("a" * 64, artifact, artifact / "server.js")

        def start_python_process(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
            role: str,
        ) -> StartedProcess:
            process_roles.append(role)
            return StartedProcess(
                role=role,
                process_group_id=len(process_roles) + 100,
                process_start_token="1",
                run_id=_run.run_id,
                owner_token="a" * 32,
                log_path=f"{role}.log",
            )

        def start_web_process(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
            _build: StandaloneBuild,
        ) -> StartedProcess:
            process_roles.append("web")
            return StartedProcess(
                role="web",
                process_group_id=200,
                process_start_token="1",
                run_id=_run.run_id,
                owner_token="b" * 32,
                log_path="web.log",
            )

        def wait_process_ready(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _process: StartedProcess,
            _endpoint: runner.EndpointKind,
            _path: str,
        ) -> None:
            return

        def create_supabase_user(
            self,
            _root: Path,
            _environment: Mapping[str, str],
            _run_id: str,
            scenario_id: str,
            _credentials: SupabaseCredentials,
        ) -> OwnedTestUser:
            password_users.append(scenario_id)
            return OwnedTestUser(
                "00000000-0000-4000-8000-000000000001",
                f"nexus+0123456789abcdef+{scenario_id}@example.invalid",
                "test-password",
            )

        def invite_supabase_user(
            self,
            _root: Path,
            _environment: Mapping[str, str],
            _run_id: str,
            scenario_id: str,
            _credentials: SupabaseCredentials,
        ) -> SimpleNamespace:
            invited_users.append(scenario_id)
            return SimpleNamespace(email=f"nexus+0123456789abcdef+{scenario_id}@example.invalid")

        def grant_scenario_ai_entitlement(
            self,
            _root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
            user: OwnedTestUser,
        ) -> None:
            entitlements.append(user.email)

    execution = runner._WorkflowExecution(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        environment,
        include_migration_database=True,
        run_id="0123456789abcdef",
        ports=Ports(),
        run=_test_run(include_migration_database=True),
    )

    bundle = runner._run_bundle(execution.context, execution)
    journeys = runner._run_journeys(
        execution.context,
        Capability.JOURNEYS_CRITICAL,
        environment,
        execution,
    )

    assert bundle.evidence.status is RunStatus.PASS
    assert journeys.evidence.status is RunStatus.PASS
    assert build_calls == ["build"]
    assert process_roles == [
        "external",
        "api",
        "worker-interactive",
        "worker-background",
        "web",
    ]
    assert invited_users == ["auth-session"]
    assert password_users == [
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "password-recovery",
        "resource-share-boundary",
    ]
    assert entitlements == [
        "nexus+0123456789abcdef+grounded-chat-citation@example.invalid",
        "nexus+0123456789abcdef+resource-share-boundary@example.invalid",
    ]
    command = _commands(tmp_path)[0]
    assert command["argv"] == [
        "run",
        "playwright",
        "test",
        "--max-failures=1",
        "--config",
        "e2e/playwright.config.ts",
        "--project",
        "journeys",
        "--workers=1",
        "--retries=0",
        "./e2e/journeys/auth-session.journey.spec.ts",
        "./e2e/journeys/grounded-chat-citation.journey.spec.ts",
        "./e2e/journeys/nexus-search-open-restore.journey.spec.ts",
        "./e2e/journeys/password-recovery.journey.spec.ts",
        "./e2e/journeys/resource-share-boundary.journey.spec.ts",
    ]
    assert "NEXUS_TEST_SCENARIO_USERS" in command["environment"]
    assert "NEXUS_TEST_SCENARIO_INVITES" in command["environment"]
    assert {
        "DATABASE_URL",
        "NEXUS_INTERNAL_SECRET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "SERVICE_ROLE_KEY",
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
    }.isdisjoint(command["environment"])


def test_run_proof_executes_only_the_exact_service_node_and_classifies_assertion_failure(
    tmp_path: Path,
) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    proof = "python/tests/service/test_owned.py"
    _write(tmp_path / proof, "def test_exact(): pass\ndef test_other(): pass\n")
    environment = _stub_tools(
        tmp_path,
        "docker",
        "supabase",
        "uv",
        exit_status=1,
        diagnostic=(
            "FAILED tests/service/test_owned.py::test_exact - "
            "AssertionError: exact behavior changed"
        ),
    )
    prepared: list[bool] = []
    cleaned: list[str] = []

    class Ports(_ReadyExternalPorts):
        def prepare_run(
            self,
            _root: Path,
            _environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            assert len(run_id) == 16
            prepared.append(include_migration_database)
            return _test_run(include_migration_database=include_migration_database)

        def clean_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run_id: str,
            *,
            supabase: SupabaseCredentials,
        ) -> None:
            del supabase
            cleaned.append("run")

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        f"pytest:{proof}::test_exact",
        environment,
        _ports=Ports(),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    assert result.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert prepared == [False]
    assert cleaned == ["run"]
    assert _commands(tmp_path)[0]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-p",
        "no:randomly",
        "tests/service/test_owned.py::test_exact",
    ]


def test_run_proof_rejects_missing_or_inexact_browser_nodes_without_preparing_runtime(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "apps/web/src/owned.browser.test.ts", "export {};\n")
    context = CapabilityContext(tmp_path, Workflow.PR, ())

    inexact = run_proof(
        context,
        "vitest:apps/web/src/owned.browser.test.ts::case",
        {},
    )
    missing = run_proof(context, "pytest:python/tests/service/missing.py::test_case", {})

    assert inexact.evidence.status is RunStatus.NOT_RUN
    assert inexact.evidence.id is Capability.POLICY
    assert missing.evidence.status is RunStatus.NOT_RUN
    assert missing.evidence.id is Capability.SERVICE


def test_exact_proof_waits_under_heavy_lock_for_memory_recovery_and_launches_once(
    tmp_path: Path,
) -> None:
    proof = "apps/web/src/recovered.browser.test.ts"
    _write(tmp_path / proof, "export {};\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    environment = _stub_tools(tmp_path, "bun")
    samples = iter((512, 1024, 2300))
    observed: list[int] = []
    waits: list[float] = []
    now = [0.0]
    lock_held = [False]

    class Ports(runner._RunnerPorts):
        @contextmanager
        def heavy_lock(self, _repo_root: Path) -> Iterator[Path]:
            assert not lock_held[0]
            lock_held[0] = True
            try:
                yield tmp_path / "heavy.lock"
            finally:
                lock_held[0] = False

        def browser_installed(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
        ) -> bool:
            assert lock_held[0], "exact proof launched outside the controller heavy lock"
            return True

    def available_memory() -> int:
        assert lock_held[0], "memory admission sampled outside the controller heavy lock"
        available_mib = next(samples)
        observed.append(available_mib)
        return available_mib

    def wait(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.CHANGED, ()),
        f"vitest:{proof}",
        environment,
        _ports=Ports(),
        _available_memory=available_memory,
        _monotonic=lambda: now[0],
        _wait=wait,
    )

    assert result.evidence.status is RunStatus.PASS, (
        "transient memory recovery did not launch the exact proof: "
        f"status={result.evidence.status.value}; detail={result.detail}"
    )
    assert observed == [512, 1024, 2300]
    assert waits == [0.25, 0.25]
    assert not lock_held[0]
    commands = _commands(tmp_path)
    assert len(commands) == 1, "memory recovery reran the exact proof"
    assert commands[0]["argv"] == [
        "run",
        "test:browser",
        "--",
        "--bail=1",
        "./src/recovered.browser.test.ts",
    ]


def test_exact_browser_component_proof_never_prepares_a_local_stack(tmp_path: Path) -> None:
    proof = "apps/web/src/owned.browser.test.ts"
    _write(tmp_path / proof, "export {};\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    environment = _stub_tools(tmp_path, "bun")

    class Ports(runner._RunnerPorts):
        def browser_installed(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
        ) -> bool:
            return True

        def prepare_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            del run_id, include_migration_database
            raise AssertionError("component proof provisioned the database/object/auth stack")

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.CHANGED, ()),
        f"vitest:{proof}",
        environment,
        _ports=Ports(),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[0]
    assert command["argv"] == [
        "run",
        "test:browser",
        "--",
        "--bail=1",
        "./src/owned.browser.test.ts",
    ]
    assert {"NEXUS_ENV", "NEXUS_TEST_RUN_ID"}.issubset(command["environment"])
    assert "DATABASE_URL" not in command["environment"]


def test_exact_proof_failure_kinds_are_stable_and_setup_assertions_are_not_behavioral() -> None:
    evidence = CapabilityEvidence(Capability.SERVICE, RunStatus.FAIL, 1, 0)
    proof = "pytest:python/tests/service/test_owned.py::test_exact"

    collection = runner._classified_exact_result(
        CapabilityResult(evidence, "ERROR collecting tests/service/test_owned.py"),
        proof,
    )
    setup = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "ERROR at setup of test_exact AssertionError: fixture invariant",
        ),
        proof,
    )
    assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "FAILED tests/service/test_owned.py::test_exact - AssertionError: property",
        ),
        proof,
    )
    raises_assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "FAILED tests/service/test_owned.py::test_exact\n"
            "E   Failed: DID NOT RAISE <class 'RuntimeContractError'>",
        ),
        proof,
    )
    browser_assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "Test Files  1 failed (1)\nTests  3 failed (3)\n"
            "src/lib/reader/proof.browser.test.tsx:200:6",
        ),
        proof,
    )
    playwright_assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "Error: exact mobile lock failed\n"
            "\x1b[2mexpect(\x1b[22mlocator\x1b[2m).\x1b[22m"
            "toHaveAttribute\x1b[2m(\x1b[22m\x1b[2m)\x1b[22m failed",
        ),
        proof,
    )
    playwright_received_assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "Programmatic restore echoed a write.\n\n"
            "expect(received).toBeNull()\n\n"
            'Received: {"_type": "Request"}',
        ),
        proof,
    )
    thrown_runtime_error = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "TypeError: usePaneController is not a function\n"
            "Test Files  1 failed (1)\nTests  1 failed (1)",
        ),
        proof,
    )
    vitest_timeout = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "Test timed out in 5000ms.\nTests  1 failed (1)",
        ),
        proof,
    )
    pytest_timeout = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "FAILED tests/service/test_owned.py::test_exact\nE   Failed: Timeout >5.0s",
        ),
        proof,
    )
    conftest_load = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "ImportError while loading conftest 'tests/service/conftest.py'.\n"
            "E   AssertionError: module-level invariant",
        ),
        proof,
    )

    assert collection.detail.startswith("proof_result=collection_failure|")
    assert setup.detail.startswith("proof_result=setup_or_execution_failure|")
    assert assertion.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert raises_assertion.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert browser_assertion.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert playwright_assertion.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert playwright_received_assertion.detail.startswith(
        "proof_result=behavioral_assertion_failure|"
    )
    # A thrown runtime error and a timeout are execution failures, never a valid
    # behavioral red — even when vitest still prints its "Tests N failed" summary
    # or pytest renders the timeout as "E   Failed: Timeout".
    assert thrown_runtime_error.detail.startswith("proof_result=setup_or_execution_failure|")
    assert vitest_timeout.detail.startswith("proof_result=setup_or_execution_failure|")
    assert pytest_timeout.detail.startswith("proof_result=setup_or_execution_failure|")
    # An assertion raised while importing a conftest is a collection-phase failure,
    # never a valid behavioral red, even though it prints "E   AssertionError".
    assert conftest_load.detail.startswith("proof_result=collection_failure|")
    assert f"proof_id={proof}|" in assertion.detail


def test_long_command_diagnostic_preserves_the_behavioral_assertion() -> None:
    completed = subprocess.CompletedProcess(
        ("pytest",),
        1,
        "migration log\n" * 400
        + "E       AssertionError: intended fault was observed\n"
        + "warning footer\n" * 400,
        "",
    )

    detail = runner._command_result_detail(1, completed)
    classified = runner._classified_exact_result(
        CapabilityResult(
            CapabilityEvidence(Capability.MIGRATIONS, RunStatus.FAIL, 1, 0),
            detail,
        ),
        "pytest:python/tests/migrations/test_owned.py::test_exact",
    )

    assert "intended fault was observed" in detail
    assert classified.detail.startswith("proof_result=behavioral_assertion_failure|")


def test_long_ansi_playwright_diagnostic_preserves_the_behavioral_assertion() -> None:
    completed = subprocess.CompletedProcess(
        ("playwright",),
        1,
        "build log\n" * 400
        + "Error: exact mobile lock failed\n"
        + "\n"
        + "Locator: getByRole('banner')\n"
        + "\x1b[2mexpect(\x1b[22mlocator\x1b[2m).\x1b[22m"
        + "toHaveAttribute\x1b[2m(\x1b[22m\x1b[2m)\x1b[22m failed\n"
        + "source footer\n" * 400,
        "",
    )

    detail = runner._command_result_detail(1, completed)
    classified = runner._classified_exact_result(
        CapabilityResult(
            CapabilityEvidence(Capability.JOURNEYS_ALL, RunStatus.FAIL, 1, 0),
            detail,
        ),
        "playwright:apps/web/e2e/journeys/owned.journey.spec.ts",
    )

    assert "exact mobile lock failed" in detail
    assert "expect(locator).toHaveAttribute() failed" in detail
    assert classified.detail.startswith("proof_result=behavioral_assertion_failure|")


def test_long_playwright_received_diagnostic_preserves_the_custom_oracle() -> None:
    completed = subprocess.CompletedProcess(
        ("playwright",),
        1,
        "build log\n" * 400
        + "Programmatic restore echoed a reader-state write.\n"
        + "\n"
        + "expect(received).toBeNull()\n"
        + "\n"
        + 'Received: {"_type": "Request"}\n'
        + "source footer\n" * 400,
        "",
    )

    detail = runner._command_result_detail(1, completed)
    classified = runner._classified_exact_result(
        CapabilityResult(
            CapabilityEvidence(Capability.JOURNEYS_ALL, RunStatus.FAIL, 1, 0),
            detail,
        ),
        "playwright:apps/web/e2e/journeys/reader-progress-resume.journey.spec.ts",
    )

    assert "Programmatic restore echoed a reader-state write." in detail
    assert "expect(received).toBeNull()" in detail
    assert classified.detail.startswith("proof_result=behavioral_assertion_failure|")


def test_first_failure_streams_before_later_results_and_redacts_secrets() -> None:
    stream = StringIO()

    def results():
        yield CapabilityResult(
            CapabilityEvidence(Capability.POLICY, RunStatus.FAIL, 1, 0),
            "token=hidden-value",
        )
        assert stream.getvalue() == (
            "failure: owner=policy; status=fail; kind=capability_failure; detail=token=[REDACTED]\n"
        )
        yield CapabilityResult(
            CapabilityEvidence(Capability.STATIC_PYTHON, RunStatus.FAIL, 1, 0),
            "later failure",
        )

    observed = tuple(stream_first_failure(results(), stream, ("hidden-value",)))

    assert len(observed) == 2
    assert stream.getvalue() == (
        "failure: owner=policy; status=fail; kind=capability_failure; detail=token=[REDACTED]\n"
    )


def test_first_failure_reporter_is_one_shot_flushed_redacted_bounded_and_scalar() -> None:
    class FlushTrackingStream(StringIO):
        flush_count = 0

        def flush(self) -> None:
            self.flush_count += 1
            super().flush()

    stream = FlushTrackingStream()
    reporter = FirstFailureReporter(("hidden-value",))
    reporter.arm(runner.time.monotonic_ns())
    detail = (
        "raw-noise hidden-value\n" * 400
        + "AssertionError: stable first oracle hidden-value\n"
        + "raw-tail hidden-value\n" * 400
    )

    assert reporter.report(
        stream,
        owner="sensitivity",
        status=RunStatus.FAIL,
        kind="behavioral_assertion_failure",
        detail=detail,
    )
    assert not reporter.report(
        stream,
        owner="later",
        status=RunStatus.FAIL,
        kind="controller_failure",
        detail="must not stream",
    )

    line = stream.getvalue()
    assert line.startswith(
        "failure: owner=sensitivity; status=fail; kind=behavioral_assertion_failure; detail="
    )
    assert line.endswith("\n") and line.count("\n") == 1
    assert "AssertionError: stable first oracle [REDACTED]" in line
    assert "hidden-value" not in line
    assert "raw-noise" not in line and "raw-tail" not in line
    assert len(line) < 2100
    assert stream.flush_count == 1
    assert reporter.first_actionable_failure_ms is not None
    assert reporter.first_actionable_failure_ms >= 0


def test_workflow_reuses_the_injected_one_shot_reporter() -> None:
    stream = StringIO()
    reporter = FirstFailureReporter()

    evidence = run_workflow(
        CapabilityContext(Path("/absent/controller-fixture"), Workflow.DOCTOR, ()),
        stream,
        {},
        run_id="0123456789abcdef",
        _reporter=reporter,
    )
    reporter.report(
        stream,
        owner="controller",
        status=RunStatus.FAIL,
        kind="controller_failure",
        detail="later controller failure",
    )

    assert evidence.capabilities[0].status is RunStatus.NOT_RUN
    assert stream.getvalue().startswith(
        "failure: owner=doctor; status=not_run; kind=capability_not_run; detail="
    )
    assert stream.getvalue().count("\n") == 1


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (("uv", "run", "pytest", "tests"), ("pytest", "--maxfail=1")),
        (("bunx", "vitest", "related"), ("vitest", "--bail=1")),
        (("bun", "run", "test:unit", "--", "./x.ts"), ("--", "--bail=1")),
        (("bun", "run", "test:browser"), ("--", "--bail=1")),
        (
            ("bun", "run", "playwright", "test", "./x.spec.ts"),
            ("test", "--max-failures=1"),
        ),
    ],
)
def test_controller_test_commands_receive_one_authoritative_fail_fast_flag(
    argv: tuple[str, ...], expected: tuple[str, str]
) -> None:
    enforced = runner._fail_fast_command(argv)
    offset = enforced.index(expected[0])

    assert enforced[offset : offset + 2] == expected
    assert runner._fail_fast_command(enforced) == enforced


def test_workflow_stops_launching_capabilities_after_the_first_decisive_result(
    tmp_path: Path,
) -> None:
    proof = tmp_path / "python/tests/kernel/test_rule.py"
    _write(proof, "import time\n\ndef test_rule():\n    time.sleep(1)\n")
    selection = Selection(
        "python/tests/kernel/test_rule.py",
        Capability.KERNEL_PYTHON,
        SelectionReason.CHANGED_TEST,
        "pytest:python/tests/kernel/test_rule.py",
    )
    result = run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
        StringIO(),
        {},
        run_id="0123456789abcdef",
    )

    assert result.capabilities[0].status is RunStatus.FAIL
    assert all(item.status is RunStatus.NOT_RUN for item in result.capabilities[1:])


def test_paid_evidence_parser_accepts_only_typed_bounded_accounting(tmp_path: Path) -> None:
    path = tmp_path / "paid.json"
    _write(
        path,
        json.dumps(
            {
                "provider_calls": 9,
                "estimated_cost_usd": 0.031,
                "limits": {"provider_calls": 9, "estimated_cost_usd": 0.10},
                "results": [{"attempts": 1}],
            }
        ),
    )

    assert runner._read_paid_evidence(path) == (9, 0.031, (9, 0.10), [{"attempts": 1}])

    _write(
        path,
        json.dumps(
            {
                "provider_calls": True,
                "estimated_cost_usd": 0,
                "limits": {"provider_calls": 9, "estimated_cost_usd": 0.10},
                "results": [],
            }
        ),
    )
    assert runner._read_paid_evidence(path) is None


def test_android_release_parsers_fail_closed_on_signer_and_manifest_contract() -> None:
    certificate = "ab" * 32
    completed = subprocess.CompletedProcess(
        ("apksigner",),
        0,
        f"Signer #1 certificate SHA-256 digest: {certificate}\n",
        "",
    )
    manifest = (
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" '
        'package="app.nexus.android" android:versionCode="42" android:versionName="2.1">'
        '<application android:usesCleartextTraffic="false"><activity>'
        '<intent-filter android:autoVerify="true">'
        '<data android:scheme="https" android:host="nexus.nielseriknandal.com"/>'
        "</intent-filter></activity></application></manifest>"
    )

    assert runner._apksigner_certificate(completed) == certificate
    assert runner._release_manifest_facts(manifest) == (
        "app.nexus.android",
        "42",
        "2.1",
        "nexus.nielseriknandal.com",
    )
    assert (
        runner._apksigner_certificate(
            subprocess.CompletedProcess(("apksigner",), 0, "unsigned", "")
        )
        is None
    )
    assert runner._release_manifest_facts(manifest.replace('"false"', '"true"')) is None


def test_android_tool_versions_are_numeric_and_physical_release_devices_are_rejected(
    tmp_path: Path,
) -> None:
    assert runner._android_tool_version("35.0.1-rc2") == (35, 0, 1, 2)
    assert runner._android_tool_version("preview") == (0,)
    adb = tmp_path / "sdk/adb"
    _write_executable(
        adb,
        stdout="List of devices attached\nR5CT1234\tdevice\n",
    )

    serial, detail = runner._authorized_emulator(tmp_path, adb, _tool_environment(tmp_path))

    assert serial is None
    assert detail == "unsafe Android device inventory: release proof permits one emulator only"


def _changed_context(repo_root: Path, selection: Selection) -> CapabilityContext:
    return CapabilityContext(repo_root, Workflow.CHANGED, (selection,))


def _stub_tools(
    repo_root: Path,
    *tools: str,
    git_stdout: str = "",
    exit_status: int = 0,
    diagnostic: str = "",
) -> dict[str, str]:
    names = {*tools}
    if git_stdout:
        names.add("git")
    for tool in names:
        _write_executable(
            repo_root / "bin" / tool,
            stdout=git_stdout if tool == "git" else "",
            exit_status=exit_status if tool != "git" else 0,
            diagnostic=diagnostic if tool != "git" else "",
        )
    return _tool_environment(repo_root)


def _write_executable(
    path: Path,
    *,
    stdout: str = "",
    exit_status: int = 0,
    diagnostic: str = "",
) -> None:
    _write(
        path,
        "#!/usr/bin/python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "record = {\n"
        "    'tool': Path(sys.argv[0]).name,\n"
        "    'argv': sys.argv[1:],\n"
        "    'cwd': os.getcwd(),\n"
        "    'environment': sorted(os.environ),\n"
        "    'google_client_id': os.environ.get('NEXUS_GOOGLE_WEB_CLIENT_ID'),\n"
        "}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n"
        f"print({stdout!r})\n"
        f"print({diagnostic!r}, file=sys.stderr)\n"
        f"raise SystemExit({exit_status})\n",
    )
    path.chmod(0o755)


def _tool_environment(repo_root: Path) -> dict[str, str]:
    return {"PATH": str(repo_root / "bin"), "HOME": str(repo_root)}


def _test_run(*, include_migration_database: bool) -> OwnedTestRun:
    return OwnedTestRun(
        run_id="0123456789abcdef",
        database_url=(
            "postgresql+psycopg://127.0.0.1:54321/nexus_run_0123456789abcdef"
            "?user=postgres&password=postgres"
        ),
        migration_database_url=(
            "postgresql+psycopg://127.0.0.1:54321/nexus_migration_0123456789abcdef"
            "?user=postgres&password=postgres"
            if include_migration_database
            else None
        ),
        bucket="nexus-run-0123456789abcdef",
        supabase=SupabaseCredentials(
            "http://127.0.0.1:54322",
            "anon-test-key",
            "admin-test-key",
        ),
    )


def _stub_run_environment(
    _repo_root: Path,
    _environment: dict[str, str],
    run: OwnedTestRun,
) -> dict[str, str]:
    values = {
        "DATABASE_URL": run.database_url,
        "NEXUS_ENV": "test",
        "NEXUS_INTERNAL_SECRET": "test-internal-secret",
        "NEXUS_TEST_RUN_ID": run.run_id,
        "R2_ACCESS_KEY_ID": "test-access-key",
        "R2_SECRET_ACCESS_KEY": "test-secret-key",
        "SUPABASE_AUTH_ADMIN_KEY": "test-admin-key",
    }
    if run.migration_database_url is not None:
        values["NEXUS_MIGRATION_DATABASE_URL"] = run.migration_database_url
    return values


def _commands(repo_root: Path) -> list[dict[str, object]]:
    path = repo_root / "commands.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def test_changed_stylesheet_reaches_the_css_token_owner_and_never_the_eslint_command(
    tmp_path: Path,
) -> None:
    """A stylesheet has no ESLint configuration, so handing its path to the
    `--max-warnings 0` lint command turns "File ignored" into a gate failure and
    makes every `.module.css` change ungateable."""
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir(parents=True)
    _write(tmp_path / "apps/web/src/components/ui/SelectField.module.css", ".field {}\n")
    _write_executable(tmp_path / "bin/bun")
    selection = Selection(
        "apps/web/src/components/ui/SelectField.module.css",
        Capability.STATIC_WEB,
        SelectionReason.FRONTEND_RELATED,
    )

    evidence = run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
        StringIO(),
        _tool_environment(tmp_path),
        run_id="0123456789abcdef",
        _available_memory=lambda: 8192,
    )

    static_web = next(item for item in evidence.capabilities if item.id is Capability.STATIC_WEB)
    assert static_web.status is RunStatus.PASS, static_web.detail
    invocations = [command["argv"] for command in _commands(tmp_path)]
    assert invocations == [["run", "lint:css-tokens"]], invocations
