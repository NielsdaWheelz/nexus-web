from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from importlib.util import find_spec
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest

import nexus_test_control.memory as memory
import nexus_test_control.runner as runner
from nexus_test_control.build import StandaloneBuild
from nexus_test_control.evidence import CapabilityEvidence
from nexus_test_control.model import (
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    SensitivityMethod,
    Workflow,
)
from nexus_test_control.process import CommandInterrupted
from nexus_test_control.runner import (
    CapabilityContext,
    CapabilityResult,
    FirstFailureReporter,
    RunContextRecorder,
    run_capability,
    run_proof,
    run_workflow,
    stream_first_failure,
)
from nexus_test_control.runtime import (
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    initialize_runtime,
)
from nexus_test_control.sensitivity import prove
from nexus_test_control.services import (
    StartedProcess,
    SupabaseCredentials,
    authorized_instrumentation_device,
    authorized_usb_physical_device,
)
from nexus_test_control.services import (
    TestRun as OwnedTestRun,
)
from nexus_test_control.services import (
    TestUser as OwnedTestUser,
)

if TYPE_CHECKING:
    from nexus_test_control.services import EmbeddingPeer, ProviderApiPeer

REPO_ROOT = Path(__file__).resolve().parents[4]
_CANDIDATE_WORKER_IMAGE_ID = "sha256:" + "c" * 64
_CANDIDATE_SHA = "a" * 40
_GENERATION_CUTOVER_PRESENT = find_spec("nexus.services.generation_catalog") is not None


@pytest.mark.parametrize(
    ("platform_name", "machine", "expected"),
    (
        ("linux", "x86_64", ("chrome", "chrome-headless-shell")),
        ("linux", "aarch64", ("chrome", "headless_shell")),
        ("darwin", "x86_64", ("Google Chrome for Testing", "chrome-headless-shell")),
        ("darwin", "arm64", ("Google Chrome for Testing", "chrome-headless-shell")),
        ("linux", "riscv64", None),
        ("win32", "AMD64", None),
    ),
)
def test_browser_admission_uses_only_the_supported_playwright_executable_layouts(
    platform_name: str,
    machine: str,
    expected: tuple[str, str] | None,
) -> None:
    assert runner._browser_executable_names(platform_name, machine) == expected


def test_browser_admission_requires_both_complete_locked_platform_artifacts(
    tmp_path: Path,
) -> None:
    revisions = {"chromium": "1217", "chromium-headless-shell": "1217"}
    _write(
        tmp_path / "apps/web/node_modules/playwright-core/browsers.json",
        json.dumps(
            {
                "browsers": [
                    {"name": name, "revision": revision} for name, revision in revisions.items()
                ]
            }
        ),
    )
    cache = tmp_path / "browsers"
    executables = runner._browser_executable_names(sys.platform, os.uname().machine)
    assert executables is not None
    owners = (
        cache / f"chromium-{revisions['chromium']}",
        cache / f"chromium_headless_shell-{revisions['chromium-headless-shell']}",
    )
    for owner, executable in zip(owners, executables, strict=True):
        owner.mkdir(parents=True)
        (owner / "INSTALLATION_COMPLETE").write_text("", encoding="utf-8")
        binary = owner / "platform" / executable
        _write(binary, "browser\n")
        binary.chmod(0o755)

    environment = {"PLAYWRIGHT_BROWSERS_PATH": str(cache)}
    assert runner._browser_installed(tmp_path, environment)

    (owners[1] / "INSTALLATION_COMPLETE").unlink()
    assert not runner._browser_installed(tmp_path, environment)


def test_browser_admission_accepts_playwright_macos_default_install(
    tmp_path: Path,
) -> None:
    """Risk: a fresh macOS setup installs Chromium where the controller never admits it."""

    repo_root = tmp_path / "repo"
    revisions = {"chromium": "1217", "chromium-headless-shell": "1217"}
    _write(
        repo_root / "apps/web/node_modules/playwright-core/browsers.json",
        json.dumps(
            {
                "browsers": [
                    {"name": name, "revision": revision} for name, revision in revisions.items()
                ]
            }
        ),
    )
    home = tmp_path / "home"
    cache = home / "Library/Caches/ms-playwright"
    executables = ("Google Chrome for Testing", "chrome-headless-shell")
    owners = (
        cache / f"chromium-{revisions['chromium']}",
        cache / f"chromium_headless_shell-{revisions['chromium-headless-shell']}",
    )
    for owner, executable in zip(owners, executables, strict=True):
        owner.mkdir(parents=True)
        (owner / "INSTALLATION_COMPLETE").write_text("", encoding="utf-8")
        binary = owner / "platform" / executable
        _write(binary, "browser\n")
        binary.chmod(0o755)

    assert runner._browser_installed_for_platform(
        repo_root,
        {"HOME": str(home)},
        platform_name="darwin",
        machine="arm64",
    )


@pytest.mark.parametrize(
    ("environment", "platform_name", "expected"),
    (
        ({"HOME": "/users/owner"}, "darwin", Path("/users/owner/Library/Caches/ms-playwright")),
        ({"HOME": "/users/owner"}, "linux", Path("/users/owner/.cache/ms-playwright")),
        (
            {"HOME": "/users/owner", "XDG_CACHE_HOME": "/cache"},
            "linux",
            Path("/cache/ms-playwright"),
        ),
        ({"PLAYWRIGHT_BROWSERS_PATH": "/browsers"}, "darwin", Path("/browsers")),
        ({}, "darwin", None),
        ({}, "win32", None),
    ),
)
def test_browser_admission_uses_playwright_platform_cache_defaults(
    environment: dict[str, str], platform_name: str, expected: Path | None
) -> None:
    assert runner._browser_cache_directory(environment, platform_name) == expected


def test_browser_admission_uses_the_playwright_host_default_cache(tmp_path: Path) -> None:
    revisions = {"chromium": "1217", "chromium-headless-shell": "1217"}
    _write(
        tmp_path / "apps/web/node_modules/playwright-core/browsers.json",
        json.dumps(
            {
                "browsers": [
                    {"name": name, "revision": revision} for name, revision in revisions.items()
                ]
            }
        ),
    )
    home = tmp_path / "home"
    cache = runner._browser_cache_directory({"HOME": str(home)}, sys.platform)
    assert cache is not None
    executables = runner._browser_executable_names(sys.platform, os.uname().machine)
    assert executables is not None
    owners = (
        cache / f"chromium-{revisions['chromium']}",
        cache / f"chromium_headless_shell-{revisions['chromium-headless-shell']}",
    )
    for owner, executable in zip(owners, executables, strict=True):
        owner.mkdir(parents=True)
        (owner / "INSTALLATION_COMPLETE").write_text("", encoding="utf-8")
        binary = owner / "platform" / executable
        _write(binary, "browser\n")
        binary.chmod(0o755)

    assert runner._browser_installed(tmp_path, {"HOME": str(home)})


@pytest.mark.parametrize(
    ("runner_name", "node", "expected"),
    [
        ("pytest", "python/tests/migrations/test_head.py::test_head", Workflow.PR),
        ("pytest", "python/tests/audit/property/test_state.py::test_state", Workflow.NIGHTLY),
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


class _ReadyProtocolPorts(runner._RunnerPorts):
    def materialize_provider_api_peer(
        self,
        _repo_root: Path,
        _environment: Mapping[str, str],
        run: OwnedTestRun,
    ) -> ProviderApiPeer:
        from nexus_test_control.services import ProviderApiPeer

        return ProviderApiPeer(
            Path(f"/{run.run_id}/provider-api-peer"),
            Path(f"/{run.run_id}/provider-api-peer/ca.pem"),
            Path(f"/{run.run_id}/provider-api-peer/server-key.pem"),
            Path(f"/{run.run_id}/provider-api-peer/requests.jsonl"),
            19093,
        )

    def start_python_process(
        self,
        _repo_root: Path,
        _environment: Mapping[str, str],
        run: OwnedTestRun,
        role: str,
    ) -> StartedProcess:
        assert role in {"external", "provider-api-peer"}
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
        *,
        tls_ca: Path | None = None,
    ) -> None:
        expected_endpoint = (
            runner.EndpointKind.EXTERNAL
            if process.role == "external"
            else runner.EndpointKind.PROVIDER_API
        )
        assert endpoint is expected_endpoint
        assert path == "/livez"
        if process.role == "provider-api-peer":
            assert tls_ca == Path(f"/{process.run_id}/provider-api-peer/ca.pem")
        else:
            assert tls_ca is None


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


@pytest.mark.parametrize(
    ("returncode", "expected_failure"),
    (
        (0, None),
        (1, "locked Python artifacts cannot materialize a fresh offline environment"),
    ),
)
def test_doctor_materializes_a_disposable_fresh_offline_python_environment(
    tmp_path: Path,
    returncode: int,
    expected_failure: str | None,
) -> None:
    observed_environment: dict[str, str] = {}
    isolated_root: Path | None = None

    def command_runner(
        command: tuple[str, ...],
        *,
        cwd: Path,
        env: Mapping[str, str],
        capture_output: bool,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        nonlocal isolated_root
        assert command == (
            "uv",
            "sync",
            "--project",
            str(tmp_path / "python"),
            "--all-extras",
            "--locked",
            "--offline",
            "--no-progress",
        )
        assert cwd == tmp_path
        assert capture_output is True
        assert check is False
        observed_environment.update(env)
        isolated_root = Path(env["UV_PROJECT_ENVIRONMENT"]).parent
        assert isolated_root.is_dir()
        return subprocess.CompletedProcess(command, returncode, "", "")

    environment = {"PATH": "/bin", "UV_PROJECT_ENVIRONMENT": "/foreign"}
    cache_check = getattr(runner, "_isolated_python_cache_failure", None)
    assert callable(cache_check), "doctor does not prove fresh offline Python setup"
    assert (
        cache_check(
            tmp_path,
            environment,
            command_runner=command_runner,
        )
        == expected_failure
    )

    assert environment == {"PATH": "/bin", "UV_PROJECT_ENVIRONMENT": "/foreign"}
    assert observed_environment["PATH"] == "/bin"
    assert observed_environment["UV_PROJECT_ENVIRONMENT"] != "/foreign"
    assert isolated_root is not None and not isolated_root.exists()


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


def test_root_owned_kernel_proof_is_not_run_before_workflow_portfolio_without_privilege(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "python/tests/kernel/test_production_release.py",
        "def test_owned(): pass\n",
    )
    environment = _stub_tools(
        tmp_path,
        "sudo",
        exit_status=1,
        diagnostic='sudo: The "no new privileges" flag is set',
    )
    stream = StringIO()

    result = run_workflow(
        CapabilityContext(tmp_path, Workflow.CONFIDENCE, ()),
        stream,
        environment,
        run_id="0123456789abcdef",
        _effective_uid=lambda: 1000,
    )

    kernel = next(item for item in result.capabilities if item.id is Capability.KERNEL_PYTHON)
    assert all(item.status is RunStatus.NOT_RUN for item in result.capabilities)
    assert "effective uid 0 or non-interactive sudo" in kernel.detail
    assert 'sudo: The "no new privileges" flag is set' in kernel.detail
    assert "owner=kernel-python; status=not_run" in stream.getvalue()
    commands = _commands(tmp_path)
    assert [(command["tool"], command["argv"], command["cwd"]) for command in commands] == [
        ("sudo", ["--non-interactive", "true"], str(tmp_path))
    ]
    assert {"HOME", "NEXUS_ENV", "PATH"}.issubset(commands[0]["environment"])


def test_qualified_root_owned_kernel_proof_runs_after_privilege_admission(
    tmp_path: Path,
) -> None:
    proof_path = "python/tests/kernel/test_production_release.py"
    _write(tmp_path / proof_path, "def test_owned(): pass\n")
    (tmp_path / "python/.venv").mkdir()
    environment = _stub_tools(tmp_path, "sudo", "uv")
    context = _changed_context(
        tmp_path,
        Selection(
            proof_path,
            Capability.KERNEL_PYTHON,
            SelectionReason.EXPLICIT_FOCUS,
            f"pytest:{proof_path}::test_owned",
        ),
    )

    admission = runner._workflow_root_ownership_admission(
        context,
        environment,
        effective_uid=1000,
    )
    result = runner._run_kernel_python(
        context,
        environment,
        root_ownership_admitted=admission is None,
    )

    assert admission is None
    assert result.evidence.status is RunStatus.PASS
    assert [(command["tool"], command["argv"]) for command in _commands(tmp_path)] == [
        ("sudo", ["--non-interactive", "true"]),
        (
            "uv",
            [
                "run",
                "--frozen",
                "--no-sync",
                "pytest",
                "--maxfail=1",
                "-p",
                "no:randomly",
                "--",
                "./tests/kernel/test_production_release.py::test_owned",
            ],
        ),
    ]


def test_doctor_reports_missing_host_proof_privilege_before_dependency_checks(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "python/tests/kernel/test_oracle_host_release.py",
        "def test_owned(): pass\n",
    )
    environment = _stub_tools(
        tmp_path,
        "actionlint",
        "bun",
        "docker",
        "git",
        "java",
        "sudo",
        "supabase",
        "uv",
    )
    _write_executable(
        tmp_path / "bin/sudo",
        exit_status=1,
        diagnostic="sudo: a password is required",
    )
    result = runner._run_doctor(
        CapabilityContext(tmp_path, Workflow.DOCTOR, ()),
        environment,
        _effective_uid=lambda: 1000,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert "effective uid 0 or non-interactive sudo" in result.detail
    assert "sudo: a password is required" in result.detail
    assert [command["tool"] for command in _commands(tmp_path)] == ["sudo"]


@pytest.mark.parametrize(
    ("owner", "source"),
    (
        ("apps/api/main.py", "app = object()\n"),
        ("apps/worker/health.py", "def health():\n    return None\n"),
        ("apps/worker/main.py", "def main():\n    return None\n"),
        ("apps/codex_agent/egress_policy.py", "def policy():\n    return None\n"),
        ("apps/codex_agent/network_health.py", "def health():\n    return None\n"),
        ("deploy/hetzner/release.py", "def release():\n    return None\n"),
    ),
)
def test_changed_python_static_owns_entrypoints_outside_python(
    tmp_path: Path,
    owner: str,
    source: str,
) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / owner, source)
    environment = _stub_tools(tmp_path, "uv")
    context = _changed_context(
        tmp_path,
        Selection(
            owner,
            Capability.KERNEL_PYTHON,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PYTHON, environment)

    assert result.evidence.status is RunStatus.PASS
    relative = f"../{owner}"
    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["run", "--frozen", "--no-sync", "ruff", "check", relative],
        [
            "run",
            "--frozen",
            "--no-sync",
            "ruff",
            "format",
            "--check",
            relative,
        ],
        ["run", "--frozen", "--no-sync", "pyright", relative],
    ]


def test_changed_static_platform_runs_only_selected_shell_checks(tmp_path: Path) -> None:
    _write(tmp_path / "deploy/hetzner/deploy.sh", "#!/usr/bin/env bash\nset -eu\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(
            "deploy/hetzner/deploy.sh",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["-n", "./deploy/hetzner/deploy.sh"],
        ["./deploy/hetzner/deploy.sh"],
    ]


def test_changed_static_platform_owns_the_release_bundle_resolver(tmp_path: Path) -> None:
    owner = "deploy/hetzner/fetch-release-bundle.sh"
    _write(tmp_path / owner, "#!/usr/bin/env bash\nset -eu\n")
    environment = _stub_tools(tmp_path, "bash", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(owner, Capability.STATIC_PLATFORM, SelectionReason.PRIORITY_RISK),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["-n", f"./{owner}"],
        [f"./{owner}"],
    ]


def test_changed_static_platform_owns_the_backend_publisher_workspace(tmp_path: Path) -> None:
    owner = "deploy/hetzner/backend-publisher-workspace.sh"
    _write(tmp_path / owner, "#!/usr/bin/env bash\nset -eu\n")
    environment = _stub_tools(tmp_path, "bash", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(owner, Capability.STATIC_PLATFORM, SelectionReason.PRIORITY_RISK),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["-n", f"./{owner}"],
        [f"./{owner}"],
    ]


def test_changed_static_platform_runs_only_selected_compose_check(tmp_path: Path) -> None:
    _write(tmp_path / "docker/docker-compose.yml", "services: {}\n")
    _write(tmp_path / "docker/docker-compose.worker.yml", "services: {}\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(
            "docker/docker-compose.worker.yml",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(tmp_path)
    assert len(commands) == 1
    assert commands[0]["tool"] == "env"
    assert commands[0]["argv"][-10:] == [
        "docker",
        "compose",
        "--project-name",
        "nexus-static-local-worker",
        "--file",
        "./docker/docker-compose.yml",
        "--file",
        "./docker/docker-compose.worker.yml",
        "config",
        "--quiet",
    ]
    assert "NEXUS_LOCAL_SOURCE_SHA=" + "0" * 40 in commands[0]["argv"]
    assert "NEXUS_LOCAL_RUNTIME_IDENTITY_FILE=/dev/null" in commands[0]["argv"]


def test_changed_static_platform_validates_production_compose_with_placeholders(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "deploy/hetzner/docker-compose.yml", "services: {}\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(
            "deploy/hetzner/docker-compose.yml",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(tmp_path)
    assert len(commands) == 1
    assert commands[0]["tool"] == "env"
    assert commands[0]["argv"][-8:] == [
        "docker",
        "compose",
        "--project-name",
        "nexus-static-production",
        "--file",
        "./deploy/hetzner/docker-compose.yml",
        "config",
        "--quiet",
    ]
    for placeholder in (
        "POSTGRES_PASSWORD=not-a-secret",
        "NEXUS_CONFIG_FILE=/dev/null",
        "CADDY_SITE=nexus.example.invalid",
        "CADDY_ACME_EMAIL=nexus@example.invalid",
    ):
        assert placeholder in commands[0]["argv"]


def test_changed_static_platform_runs_only_selected_cloud_init_check(tmp_path: Path) -> None:
    _write(tmp_path / "deploy/hetzner/cloud-init.yml", "#cloud-config\nusers: []\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(
            "deploy/hetzner/cloud-init.yml",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    assert [command["argv"] for command in _commands(tmp_path)] == [
        ["schema", "--config-file", "./deploy/hetzner/cloud-init.yml"]
    ]


def test_changed_static_platform_checks_both_backend_targets(tmp_path: Path) -> None:
    _write(tmp_path / "docker/Dockerfile.backend", "FROM scratch AS api\nFROM scratch AS worker\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = _changed_context(
        tmp_path,
        Selection(
            "docker/Dockerfile.backend",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    assert [command["argv"] for command in _commands(tmp_path)] == [
        [
            "buildx",
            "build",
            "--check",
            "--file",
            "./docker/Dockerfile.backend",
            "--target",
            target,
            "--build-arg",
            "SOURCE_SHA=" + "0" * 40,
            ".",
        ]
        for target in ("api", "worker")
    ]


def test_static_platform_fails_closed_when_a_selected_owner_is_missing(tmp_path: Path) -> None:
    context = _changed_context(
        tmp_path,
        Selection(
            "deploy/hetzner/deploy.sh",
            Capability.STATIC_PLATFORM,
            SelectionReason.PRIORITY_RISK,
        ),
    )

    result = run_capability(context, Capability.STATIC_PLATFORM)

    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.detail == "selected platform static owner is absent: deploy/hetzner/deploy.sh"


def test_complete_static_platform_runs_every_owned_check(tmp_path: Path) -> None:
    shell_paths = (
        "deploy/cloudflare/apply-r2-cors.sh",
        "deploy/cloudflare/apply-r2-lifecycle.sh",
        "deploy/hetzner/backend-publisher-workspace.sh",
        "deploy/hetzner/deploy.sh",
        "deploy/hetzner/fetch-release-bundle.sh",
        "deploy/hetzner/prove-codex-capacity.sh",
        "deploy/hetzner/provision.sh",
        "deploy/hetzner/reconcile-oracle.sh",
        "deploy/hetzner/sync-env.sh",
        "deploy/smoke/auth-smoke.sh",
        "deploy/supabase/verify-auth-config.sh",
        "deploy/vercel/sync-env.sh",
        "deploy/vercel/sync-resource-sharing-firewall.sh",
        "scripts/ci-proof-artifact.sh",
    )
    for path in shell_paths:
        _write(tmp_path / path, "#!/usr/bin/env bash\nset -eu\n")
    _write(tmp_path / "deploy/hetzner/docker-compose.yml", "services: {}\n")
    _write(tmp_path / "docker/docker-compose.yml", "services: {}\n")
    _write(tmp_path / "docker/docker-compose.worker.yml", "services: {}\n")
    _write(tmp_path / "deploy/hetzner/cloud-init.yml", "#cloud-config\nusers: []\n")
    _write(tmp_path / "docker/Dockerfile.backend", "FROM scratch AS api\nFROM scratch AS worker\n")
    environment = _stub_tools(tmp_path, "bash", "cloud-init", "docker", "env", "shellcheck")
    context = CapabilityContext(tmp_path, Workflow.CONFIDENCE, ())

    result = run_capability(context, Capability.STATIC_PLATFORM, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(tmp_path)
    root_shell_paths = [f"./{path}" for path in shell_paths]
    assert [command["tool"] for command in commands] == [
        "bash",
        "shellcheck",
        "env",
        "env",
        "cloud-init",
        "docker",
        "docker",
    ]
    assert commands[0]["argv"] == ["-n", *root_shell_paths]
    assert commands[1]["argv"] == root_shell_paths
    assert commands[2]["argv"][-8:] == [
        "docker",
        "compose",
        "--project-name",
        "nexus-static-production",
        "--file",
        "./deploy/hetzner/docker-compose.yml",
        "config",
        "--quiet",
    ]
    assert commands[3]["argv"][-10:] == [
        "docker",
        "compose",
        "--project-name",
        "nexus-static-local-worker",
        "--file",
        "./docker/docker-compose.yml",
        "--file",
        "./docker/docker-compose.worker.yml",
        "config",
        "--quiet",
    ]
    assert commands[4]["argv"] == [
        "schema",
        "--config-file",
        "./deploy/hetzner/cloud-init.yml",
    ]
    assert [command["argv"][6] for command in commands[5:]] == ["api", "worker"]


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


def test_unselected_heavy_capability_does_not_lock_a_selected_kernel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import fcntl

    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(
        tmp_path / "python/tests/kernel/test_owned.py", "def test_owned():\n    assert 2 + 2 == 4\n"
    )
    _write(tmp_path / "apps/web/package.json", "{}\n")
    _write(tmp_path / "apps/web/src/owned.ts", "export const owned = 1;\n")
    environment = _stub_tools(tmp_path, "uv", "bun")
    operations: list[int] = []

    def observe_flock(_descriptor: int, operation: int) -> None:
        operations.append(operation)

    monkeypatch.setattr(fcntl, "flock", observe_flock)
    kernel_context = _changed_context(
        tmp_path,
        Selection(
            "python/tests/kernel/test_owned.py",
            Capability.KERNEL_PYTHON,
            SelectionReason.EXPLICIT_FOCUS,
            "pytest:python/tests/kernel/test_owned.py",
        ),
    )
    kernel = run_capability(kernel_context, Capability.KERNEL_PYTHON, environment)
    unselected = run_capability(kernel_context, Capability.STATIC_WEB, environment)
    assert kernel.evidence.status is RunStatus.PASS
    assert unselected.evidence.status is RunStatus.PASS
    assert operations == [], "unselected heavy capability locked the selected kernel"

    web_context = _changed_context(
        tmp_path,
        Selection("apps/web/src/owned.ts", Capability.COMPONENT, SelectionReason.CHANGED_TEST),
    )
    (tmp_path / "apps/web/node_modules").mkdir()
    selected = run_capability(web_context, Capability.STATIC_WEB, environment)
    assert selected.evidence.status is RunStatus.PASS
    assert operations == [fcntl.LOCK_EX, fcntl.LOCK_UN], (
        "selected heavy capability escaped its lock"
    )


def test_complete_fast_commands_are_fixed_to_their_final_owners(tmp_path: Path) -> None:
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/kernel/nexus_test_control/test_policy.py",
        "def test_policy():\n    assert True\n",
    )
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/api/main.py", "app = object()\n")
    _write(tmp_path / "apps/worker/health.py", "def health():\n    return None\n")
    _write(tmp_path / "apps/worker/main.py", "def main():\n    return None\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    _write(tmp_path / "apps/web/scripts/test-eslint-policy.mjs", "export {};\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    _write(tmp_path / ".github/workflows/ci.yml", "name: CI\n")
    _write(tmp_path / "deploy/hetzner/release.py", "def release():\n    return None\n")
    for path in (
        "deploy/cloudflare/apply-r2-cors.sh",
        "deploy/cloudflare/apply-r2-lifecycle.sh",
        "deploy/hetzner/backend-publisher-workspace.sh",
        "deploy/hetzner/deploy.sh",
        "deploy/hetzner/fetch-release-bundle.sh",
        "deploy/hetzner/prove-codex-capacity.sh",
        "deploy/hetzner/provision.sh",
        "deploy/hetzner/reconcile-oracle.sh",
        "deploy/hetzner/sync-env.sh",
        "deploy/smoke/auth-smoke.sh",
        "deploy/supabase/verify-auth-config.sh",
        "deploy/vercel/sync-env.sh",
        "deploy/vercel/sync-resource-sharing-firewall.sh",
        "scripts/ci-proof-artifact.sh",
    ):
        _write(tmp_path / path, "#!/usr/bin/env bash\nset -eu\n")
    _write(tmp_path / "deploy/hetzner/docker-compose.yml", "services: {}\n")
    _write(tmp_path / "docker/docker-compose.yml", "services: {}\n")
    _write(tmp_path / "docker/docker-compose.worker.yml", "services: {}\n")
    _write(tmp_path / "deploy/hetzner/cloud-init.yml", "#cloud-config\nusers: []\n")
    _write(
        tmp_path / "docker/Dockerfile.backend",
        "FROM scratch AS api\nFROM scratch AS worker\n",
    )
    environment = _stub_tools(
        tmp_path,
        "actionlint",
        "bash",
        "bun",
        "cloud-init",
        "docker",
        "env",
        "shellcheck",
        "uv",
    )
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
        Capability.STATIC_PLATFORM,
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
        "uv",
        "bun",
        "bun",
        "bun",
        "actionlint",
        "uv",
        "bash",
        "shellcheck",
        "env",
        "env",
        "cloud-init",
        "docker",
        "docker",
        "uv",
        "bun",
    ]
    assert commands[0]["argv"][-1] == "tests/kernel/nexus_test_control/test_policy.py"
    assert commands[1]["argv"] == ["run", "test:eslint-policy"]
    assert commands[2]["argv"][-19:] == [
        ".",
        "../apps/api/main.py",
        "../apps/codex_agent/__init__.py",
        "../apps/codex_agent/auth_environment.py",
        "../apps/codex_agent/capacity.py",
        "../apps/codex_agent/capacity_canary.py",
        "../apps/codex_agent/confined_runtime.py",
        "../apps/codex_agent/credential_state.py",
        "../apps/codex_agent/egress_policy.py",
        "../apps/codex_agent/enroll.py",
        "../apps/codex_agent/health.py",
        "../apps/codex_agent/host.py",
        "../apps/codex_agent/main.py",
        "../apps/codex_agent/network_health.py",
        "../apps/codex_agent/path_environment.py",
        "../apps/codex_agent/sandbox_health.py",
        "../apps/worker/health.py",
        "../apps/worker/main.py",
        "../deploy/hetzner/release.py",
    ]
    assert commands[3]["argv"][-19:] == [
        ".",
        "../apps/api/main.py",
        "../apps/codex_agent/__init__.py",
        "../apps/codex_agent/auth_environment.py",
        "../apps/codex_agent/capacity.py",
        "../apps/codex_agent/capacity_canary.py",
        "../apps/codex_agent/confined_runtime.py",
        "../apps/codex_agent/credential_state.py",
        "../apps/codex_agent/egress_policy.py",
        "../apps/codex_agent/enroll.py",
        "../apps/codex_agent/health.py",
        "../apps/codex_agent/host.py",
        "../apps/codex_agent/main.py",
        "../apps/codex_agent/network_health.py",
        "../apps/codex_agent/path_environment.py",
        "../apps/codex_agent/sandbox_health.py",
        "../apps/worker/health.py",
        "../apps/worker/main.py",
        "../deploy/hetzner/release.py",
    ]
    assert commands[4]["argv"] == ["run", "--frozen", "--no-sync", "pyright"]
    assert commands[5]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pyright",
        "../apps/api/main.py",
        "../apps/codex_agent/__init__.py",
        "../apps/codex_agent/auth_environment.py",
        "../apps/codex_agent/capacity.py",
        "../apps/codex_agent/capacity_canary.py",
        "../apps/codex_agent/confined_runtime.py",
        "../apps/codex_agent/credential_state.py",
        "../apps/codex_agent/egress_policy.py",
        "../apps/codex_agent/enroll.py",
        "../apps/codex_agent/health.py",
        "../apps/codex_agent/host.py",
        "../apps/codex_agent/main.py",
        "../apps/codex_agent/network_health.py",
        "../apps/codex_agent/path_environment.py",
        "../apps/codex_agent/sandbox_health.py",
        "../apps/worker/health.py",
        "../apps/worker/main.py",
        "../deploy/hetzner/release.py",
    ]
    assert commands[10]["argv"][-1] == "../.github/workflows/ci.yml"
    assert commands[18]["argv"][-1] == "./tests/kernel/nexus_test_control/test_policy.py"
    assert commands[19]["argv"] == [
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
    kernel_revision = "b" * 40
    kernel = repo_root / ".nexus-test/llm-agent-kernel" / kernel_revision
    (kernel / ".venv").mkdir(parents=True)
    _write(kernel / ".nexus-llm-agent-kernel-revision", kernel_revision + "\n")
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f'provider-runtime = {{ git = "https://example.invalid/runtime", rev = "{expected}" }}\n'
        f'llm-agent-kernel = {{ git = "https://example.invalid/kernel", rev = "{kernel_revision}" }}\n',
    )
    environment = _stub_tools(repo_root, "uv")
    context = CapabilityContext(repo_root, Workflow.FULL, ())

    result = run_capability(context, Capability.PROVIDER_RUNTIME, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(repo_root)
    assert [command["tool"] for command in commands[:5]] == ["uv"] * 5
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
    assert commands[4]["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-q",
        "-p",
        "no:randomly",
    ]

    assert [command["cwd"] for command in commands[1:5]] == [str(checkout)] * 4
    assert [command["tool"] for command in commands[5:]] == ["uv"] * 5
    assert [command["cwd"] for command in commands[5:]] == [str(kernel)] * 5
    assert [command["argv"] for command in commands[5:9]] == [
        command["argv"] for command in commands[1:5]
    ]
    assert commands[9]["argv"] == ["build", "--no-sources", "--offline"]


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
        _available_storage=lambda _root, _docker: 16384,
    )

    assert result.evidence.status is RunStatus.FAIL
    # The external uv stub proves routing, not an executed pytest assertion.
    assert result.detail.startswith("proof_result=setup_or_execution_failure|")
    assert "pytest failure evidence is missing" in result.detail
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


def test_exact_release_artifact_proof_materializes_an_owned_worker_image(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    proof_path = "python/tests/release_artifact/test_image_binding.py"
    _write(
        repo_root / proof_path,
        "def test_image_binding():\n    assert True\n\n"
        "def test_other_release_artifact_contract():\n    assert True\n",
    )
    (repo_root / "python/.venv").mkdir(parents=True)
    _initialize_local_runtime(repo_root)
    environment = _stub_tools(
        repo_root,
        "uv",
        git_stdout="a" * 40,
        exit_status=1,
        diagnostic="FAILED exact binding - AssertionError: expected candidate image",
    )
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(repo_root / "bin/docker")
    ambient_image = "sha256:" + "f" * 64
    environment["NEXUS_TEST_CANDIDATE_WORKER_IMAGE"] = ambient_image
    run_context = RunContextRecorder()

    result = run_proof(
        CapabilityContext(repo_root, Workflow.RELEASE, (), run_context=run_context),
        f"pytest:{proof_path}::test_image_binding",
        environment,
        _ports=_LocalDockerPorts(),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.id is Capability.RELEASE_ARTIFACT
    assert result.evidence.status is RunStatus.FAIL
    # The external uv stub proves routing, not an executed pytest assertion.
    assert result.detail.startswith("proof_result=setup_or_execution_failure|")
    assert "pytest failure evidence is missing" in result.detail
    commands = _commands(repo_root)
    assert [command["tool"] for command in commands] == ["git", "docker", "uv", "docker"]
    build = commands[1]
    assert build["argv"][:12] == [
        "buildx",
        "build",
        "--load",
        "--file",
        "./docker/Dockerfile.backend",
        "--target",
        "worker",
        "--build-arg",
        f"SOURCE_SHA={'a' * 40}",
        "--tag",
        build["argv"][10],
        "--iidfile",
    ]
    assert str(build["argv"][10]).startswith("nexus-test-worker-")
    iidfile = Path(str(build["argv"][12]))
    assert iidfile.name == "worker.iid"
    assert build["argv"][13] == "."
    assert not iidfile.exists()
    proof = commands[2]
    assert proof["argv"] == [
        "run",
        "--frozen",
        "--no-sync",
        "pytest",
        "--maxfail=1",
        "-p",
        "no:randomly",
        "tests/release_artifact/test_image_binding.py::test_image_binding",
    ]
    assert proof["candidate_worker_image"] == _CANDIDATE_WORKER_IMAGE_ID
    assert proof["candidate_worker_image"] != ambient_image
    assert proof["docker_host"] == "unix:///test/docker.sock"
    assert proof["docker_context"] == "default"
    assert commands[3]["argv"] == ["image", "rm", build["argv"][10]]
    recorded = run_context.evidence().fixed_commands
    assert (recorded[0].argv[3], recorded[1].argv[4], recorded[2].argv[3]) == (
        "docker",
        "uv",
        "docker",
    )
    assert recorded[1].argv[3] == (
        f"NEXUS_TEST_CANDIDATE_WORKER_IMAGE={_CANDIDATE_WORKER_IMAGE_ID}"
    )


def test_release_artifact_runs_its_python_proofs_before_staging_android_evidence(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    run_id = "0123456789abcdef"
    proof_path = "python/tests/release_artifact/test_image_binding.py"
    _write(repo_root / proof_path, "def test_image_binding():\n    assert True\n")
    (repo_root / "python/.venv").mkdir(parents=True)
    apk = repo_root / "apps/android/app/build/outputs/apk/release/app-release.apk"
    _write(apk, "signed release bytes\n")
    sha256 = runner._sha256_file(apk)
    signer = "ab" * 32
    _initialize_local_runtime(repo_root)
    corpus = repo_root / "testdata/android/player-protocol.json"
    _write(corpus, '{"version": 2}\n')
    player_protocol = runner._android_player_protocol_identity(repo_root)
    _write(
        repo_root / f"test-results/runs/{run_id}/android-release.json",
        json.dumps(
            {
                "version": 3,
                "run_id": run_id,
                "tag": "android-v1.2.3",
                "apk_path": apk.relative_to(repo_root).as_posix(),
                "apk_sha256": sha256,
                "signer_sha256": signer,
                "package": "app.nexus.android",
                "version_code": 123,
                "previous_version_code": 122,
                "version_name": "1.2.3",
                "git_sha": "a" * 40,
                "offline_baseline_mode": "compatible",
                "physical_device": {"serial": "R5CT1234"},
                "app_link_host": "nexus.nielseriknandal.com",
                "api_origin": "https://api.nielseriknandal.com",
                "api_origin_source": "signed_apk_build_config",
                "target_sdk": 36,
                "player_protocol": player_protocol.as_json(),
            }
        ),
    )
    environment = _stub_tools(repo_root, "uv", "git", git_stdout="a" * 40)
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(repo_root / "bin/docker")
    android_home = tmp_path / "android-sdk"
    _write_executable(android_home / "platform-tools/adb")
    _write_executable(
        android_home / "build-tools/35.0.1/apksigner",
        stdout=f"Signer #1 certificate SHA-256 digest: {signer}",
    )
    _write_executable(
        android_home / "cmdline-tools/latest/bin/apkanalyzer",
        stdout_by_subcommand={
            "manifest": (
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android" '
                'package="app.nexus.android" android:versionCode="123" android:versionName="1.2.3">'
                '<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/>'
                '<application android:usesCleartextTraffic="false">'
                '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_VERSION" '
                f'android:value="{player_protocol.version}"/>'
                '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256" '
                f'android:value="{player_protocol.contract_sha256}"/>'
                '<activity><intent-filter android:autoVerify="true">'
                '<data android:scheme="https" android:host="nexus.nielseriknandal.com"/>'
                "</intent-filter></activity></application></manifest>"
            ),
            "dex": (
                ".field public static final NEXUS_API_ORIGIN:Ljava/lang/String; = "
                '"https://api.nielseriknandal.com"'
            ),
        },
    )
    environment["ANDROID_HOME"] = str(android_home)

    result = runner._run_release_artifact(
        CapabilityContext(repo_root, Workflow.RELEASE, ()),
        environment,
        SimpleNamespace(run_id=run_id, run=None, ports=_LocalDockerPorts()),
    )

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(repo_root)
    proof_index = next(index for index, command in enumerate(commands) if command["tool"] == "uv")
    cleanup_index = next(
        index
        for index, command in enumerate(commands)
        if command["tool"] == "docker" and command["argv"][:2] == ["image", "rm"]
    )
    android_index = next(
        index for index, command in enumerate(commands) if command["tool"] == "apksigner"
    )
    assert commands[proof_index]["argv"][-1] == "./tests/release_artifact/test_image_binding.py"
    assert proof_index < cleanup_index < android_index
    staged = repo_root / f"test-results/runs/{run_id}/release"
    assert (staged / "nexus-android.apk").is_file()
    assert (staged / "release-manifest.json").is_file()


def test_release_artifact_image_build_failure_is_setup_and_skips_pytest(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "nexus"
    proof_path = "python/tests/release_artifact/test_image_binding.py"
    _write(repo_root / proof_path, "def test_image_binding():\n    assert True\n")
    (repo_root / "python/.venv").mkdir(parents=True)
    _initialize_local_runtime(repo_root)
    environment = _stub_tools(repo_root, "uv", git_stdout="a" * 40)
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(
        repo_root / "bin/docker",
        build_exit_status=17,
        diagnostic="worker image build failed",
    )

    result = run_proof(
        CapabilityContext(repo_root, Workflow.RELEASE, ()),
        f"pytest:{proof_path}::test_image_binding",
        environment,
        _ports=_LocalDockerPorts(),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    assert result.detail.startswith("proof_result=setup_or_execution_failure|")
    assert [command["tool"] for command in _commands(repo_root)] == ["git", "docker"]


def test_release_artifact_reports_not_run_when_the_local_runtime_is_uninitialized(
    tmp_path: Path,
) -> None:
    """A fresh host has no runtime state; the proof must report it, not raise."""

    repo_root = tmp_path / "nexus"
    proof_path = "python/tests/release_artifact/test_image_binding.py"
    _write(repo_root / proof_path, "def test_image_binding():\n    assert True\n")
    (repo_root / "python/.venv").mkdir(parents=True)
    environment = _stub_tools(repo_root, "uv", git_stdout="a" * 40)
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(repo_root / "bin/docker")

    result = run_proof(
        CapabilityContext(repo_root, Workflow.RELEASE, ()),
        f"pytest:{proof_path}::test_image_binding",
        environment,
        _ports=_LocalDockerPorts(),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert "candidate worker image setup is unavailable" in result.detail
    assert [command["tool"] for command in _commands(repo_root)] == ["git"]


def test_changed_capacity_proof_file_runs_its_candidate_nodes_and_never_an_incident_baseline(
    tmp_path: Path,
) -> None:
    """`changed` selects a capacity proof file, never a node, so the file must
    stand for the candidate proofs it owns; the historical incident baselines
    measure a published image and are qualification inputs, not candidates."""

    repo_root = tmp_path / "nexus"
    _write_api_capacity_repository(repo_root)
    _write_capacity_git(repo_root / "bin/git", sha=_CANDIDATE_SHA, porcelain="")
    environment = _stub_tools(
        repo_root,
        "uv",
        "supabase",
        exit_status=1,
        diagnostic="FAILED candidate reader admission - AssertionError: admission exhausted",
    )
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(repo_root / "bin/docker")
    ports = _ApiCapacityPorts()

    result = run_proof(
        CapabilityContext(repo_root, Workflow.CHANGED, ()),
        "pytest:python/tests/capacity/test_api_reader_capacity.py",
        environment,
        _ports=ports,
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    commands = _commands(repo_root)
    assert [command["tool"] for command in commands] == [
        "git",
        "git",
        "docker",
        "docker",
        "uv",
    ]
    proof = commands[-1]
    assert proof["argv"][proof["argv"].index("no:randomly") + 1 :] == [
        "tests/capacity/test_api_reader_capacity.py"
        "::test_candidate_reader_admission_under_incident_overlap",
        "tests/capacity/test_api_reader_capacity.py::test_candidate_artwork_overlap",
        "tests/capacity/test_api_reader_capacity.py::test_candidate_metadata_overlap",
        "tests/capacity/test_api_reader_capacity.py::test_candidate_background_worker_overlap",
    ]
    # The candidate worker proof is selected with the file, so its image is built
    # and its owned run holds the migration database that proof requires.
    assert [build["argv"][6] for build in commands[2:4]] == ["api", "worker"]
    assert ports.migration_databases == [True]
    identity = json.loads(
        (repo_root / "test-results/runs" / ports.run_ids[0] / "api-build-inputs.json").read_text()
    )
    assert identity["build_targets"] == ["api", "worker"]
    assert identity["source_sha_label"] == _CANDIDATE_SHA
    assert identity["dirty_worktree"] is False
    assert [arguments[:2] for arguments in ports.docker] == [
        ("image", "ls"),
        ("image", "rm"),
        ("image", "ls"),
        ("image", "rm"),
    ]
    removed = [arguments[2] for arguments in ports.docker if arguments[1] == "rm"]
    assert removed[0].startswith("nexus-test-capacity-worker-")
    assert removed[1].startswith("nexus-test-api-")
    assert all(tag.endswith(f":{ports.run_ids[0]}") for tag in removed)


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_workflow_capacity_exception_retains_completed_evidence(
    tmp_path: Path, cleanup_fails: bool
) -> None:
    _write_api_capacity_repository(tmp_path)
    _write(
        tmp_path / "python/tests/capacity/test_api_reader_capacity.py",
        "from pathlib import Path\n\n"
        "def test_candidate_metadata_overlap():\n"
        "    assert Path(__file__).is_file()\n",
    )
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write_capacity_git(tmp_path / "bin/git", sha=_CANDIDATE_SHA, porcelain="")
    environment = _stub_tools(tmp_path, "uv", "supabase", "docker")
    cleaned: list[str] = []

    class Ports(_ApiCapacityPorts):
        def local_docker_host(self) -> str:
            raise OSError(28, "capacity fixture exhausted storage")

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
            if cleanup_fails:
                raise RuntimeError("capacity fixture cleanup failed")

    path = "python/tests/capacity/test_api_reader_capacity.py"
    selection = Selection(
        path,
        Capability.API_CAPACITY,
        SelectionReason.CHANGED_TEST,
        f"pytest:{path}::test_candidate_metadata_overlap",
    )
    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=lambda _repo_root: 0,
    )
    with pytest.raises(Exception) as raised:
        outcome = run_workflow(
            CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
            StringIO(),
            environment,
            run_id="0123456789abcdef",
            _ports=Ports(),
            _available_memory=lambda: 8192,
            _memory_sampler=sampler,
        )
        pytest.fail(f"capacity fixture did not reach its external fault: {outcome.capabilities}")

    error = raised.value
    assert getattr(error, "owner", None) is Capability.API_CAPACITY, (
        "workflow exception lost the active capacity owner"
    )
    completed = getattr(error, "completed", ())
    assert completed, "workflow exception lost completed evidence"
    assert completed[0].id is Capability.POLICY
    assert completed[0].status is RunStatus.PASS
    assert all(item.status is RunStatus.PASS for item in completed)
    assert completed[-1].id is Capability.JOURNEYS_ALL
    assert "capacity fixture exhausted storage" in str(error)
    if cleanup_fails:
        assert "capacity fixture cleanup failed" in str(error)
        assert isinstance(error.__cause__, RuntimeError)
        assert isinstance(error.__cause__.__context__, OSError)
    else:
        assert isinstance(error.__cause__, OSError)
    assert cleaned == ["0123456789abcdef"]


def test_api_capacity_refuses_a_dirty_worktree_before_labelling_a_candidate_image(
    tmp_path: Path,
) -> None:
    """SOURCE_SHA becomes the image revision label and the runtime identity the
    API serves, so a candidate built from uncommitted work would attest a commit
    it does not contain."""

    repo_root = tmp_path / "nexus"
    _write_api_capacity_repository(repo_root)
    _write_capacity_git(
        repo_root / "bin/git",
        sha=_CANDIDATE_SHA,
        porcelain=" M python/nexus/api/read_admission.py\n",
    )
    environment = _stub_tools(repo_root, "uv", "supabase")
    _write_passthrough_env(repo_root / "bin/env")
    _write_release_artifact_docker(repo_root / "bin/docker")
    ports = _ApiCapacityPorts()

    result = run_proof(
        CapabilityContext(repo_root, Workflow.CHANGED, ()),
        "pytest:python/tests/capacity/test_api_reader_capacity.py",
        environment,
        _ports=ports,
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    assert "clean committed candidate" in result.detail
    assert [command["tool"] for command in _commands(repo_root)] == ["git", "git"]
    assert ports.docker == []
    relative = f"test-results/runs/{ports.run_ids[0]}/api-build-inputs.json"
    assert result.evidence.artifacts == (relative,)
    identity = json.loads((repo_root / relative).read_text())
    assert identity["dirty_worktree"] is True
    assert identity["source_sha_label"] == _CANDIDATE_SHA


def test_capacity_receipt_is_retained_only_when_it_measured_this_run_s_build(
    tmp_path: Path,
) -> None:
    """A receipt is the qualification evidence, so it must name the image this
    run built and the inputs that image was built from."""

    run_id = "0123456789abcdef"
    image_id = "sha256:" + "c" * 64
    digest = "d" * 64
    receipt = tmp_path / "test-results/runs" / run_id / "api-capacity-candidate-reader.json"
    selected = (runner.API_CAPACITY_CANDIDATE_READER_PROOF,)
    passed = CapabilityResult(
        CapabilityEvidence(Capability.API_CAPACITY, RunStatus.PASS, 1, 0),
        "candidate reader admission",
    )

    def retain(measured_image: str, measured_digest: str) -> CapabilityResult:
        _write(
            receipt,
            json.dumps(
                {
                    "image": measured_image,
                    "build_inputs": {"build_input_digest": measured_digest},
                    "samples": [{"phase": "admitted"}],
                }
            ),
        )
        return runner._retain_api_capacity_evidence(
            tmp_path,
            run_id,
            selected,
            passed,
            build=runner._ApiCapacityBuild(image_id, digest),
        )

    retained = retain(image_id, digest)
    assert retained.evidence.status is RunStatus.PASS
    assert retained.evidence.artifacts == (
        f"test-results/runs/{run_id}/api-build-inputs.json",
        f"test-results/runs/{run_id}/api-capacity-candidate-reader.json",
    )

    foreign_image = retain("sha256:" + "e" * 64, digest)
    assert foreign_image.evidence.status is RunStatus.NOT_RUN
    assert "measured another image" in foreign_image.detail

    foreign_inputs = retain(image_id, "f" * 64)
    assert foreign_inputs.evidence.status is RunStatus.NOT_RUN
    assert "omits this build's input digest" in foreign_inputs.detail


def test_android_host_discovers_the_sdk_and_uses_the_fixed_host_contract(
    tmp_path: Path,
) -> None:
    android_root = tmp_path / "apps/android"
    (tmp_path / "Android/Sdk").mkdir(parents=True)
    _write(
        android_root / "app/src/test/java/app/nexus/SampleTest.kt",
        "package app.nexus\nclass SampleTest\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "production-shaped-value",
    }
    context = CapabilityContext(tmp_path, Workflow.FULL, ())

    result = run_capability(context, Capability.ANDROID_HOST, environment)

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[0]
    assert command["argv"] == ["--no-daemon", ":app:testDebugUnitTest"]
    assert "ANDROID_HOME" in command["environment"]
    assert command["google_client_id"] == "nexus-test.apps.googleusercontent.com"


def test_exact_android_host_proof_selects_only_its_class(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    (tmp_path / "Android/Sdk").mkdir(parents=True)
    proof = "apps/android/app/src/test/java/app/nexus/SampleTest.kt"
    _write(tmp_path / proof, "package app.nexus\nclass SampleTest\n")
    _stub_tools(tmp_path, "java")
    _write_host_gradle(
        android_root / "gradlew",
        '<testsuite name="app.nexus.SampleTest" tests="1" failures="0" errors="0" skipped="0">'
        '<testcase classname="app.nexus.SampleTest" name="selected case"/>'
        "<system-out>geometry rows=65536 bytes=4194304</system-out></testsuite>",
    )

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.FULL, ()),
        f"gradle:{proof}",
        _tool_environment(tmp_path),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.PASS
    assert _commands(tmp_path)[0]["argv"] == [
        "--no-daemon",
        ":app:testDebugUnitTest",
        "--tests",
        "app.nexus.SampleTest",
    ], "exact native proof silently ran unrelated classes"

    retained = json.loads((tmp_path / result.evidence.artifacts[-1]).read_text())
    assert retained.get("system_out") == "geometry rows=65536 bytes=4194304", (
        "fresh native measurement output was discarded"
    )


@pytest.mark.parametrize(
    "case",
    [
        "assertion",
        "array",
        "nested",
        "runtime",
        "nested_runtime",
        "foreign",
        "lookalike",
        "foreign_nested",
        "message_only",
        "stale",
    ],
)
def test_exact_android_host_red_requires_fresh_owned_junit_assertion(
    tmp_path: Path, case: str
) -> None:
    android_root = tmp_path / "apps/android"
    (tmp_path / "Android/Sdk").mkdir(parents=True)
    proof = "apps/android/app/src/test/java/app/nexus/SampleTest.kt"
    _write(tmp_path / proof, "package app.nexus\nclass SampleTest\n")
    _stub_tools(tmp_path, "java")
    failure_type = {
        "runtime": "java.lang.IllegalStateException",
        "nested_runtime": "java.lang.IllegalStateException",
        "array": "org.junit.internal.ArrayComparisonFailure",
    }.get(case, "java.lang.AssertionError")
    owner = "app.nexus.ForeignTest" if case == "foreign" else "app.nexus.SampleTest"
    # Kotlin suspend assertions may retain only an owned compiled closure
    # frame across the coroutine boundary, as native receipt a0c1a26c63550a55 does.
    frame_owner = {
        "nested": "app.nexus.SampleTest$source is distinct$1$2",
        "nested_runtime": "app.nexus.SampleTest$source is distinct$1$2",
        "lookalike": "app.nexus.SampleTestOther$1",
        "foreign_nested": "foreign.app.nexus.SampleTest$1",
        "message_only": "app.nexus.ForeignTest",
    }.get(case, owner)
    diagnostic = (
        "diagnostic mentions at app.nexus.SampleTest.source and app.nexus.SampleTest$1\n"
        if case == "message_only"
        else ""
    )
    xml = (
        f'<testsuite name="{owner}" tests="1" failures="1" errors="0" skipped="0">'
        f'<testcase classname="{owner}" name="source is distinct">'
        f'<failure type="{failure_type}" message="wrong source was acknowledged">'
        f"{failure_type}: wrong source was acknowledged\n"
        f"{diagnostic}\tat {frame_owner}.source is distinct(SampleTest.kt:23)"
        "</failure></testcase></testsuite>"
    )
    report = android_root / "app/build/test-results/testDebugUnitTest/TEST-app.nexus.SampleTest.xml"
    _write(report, xml)
    _write_host_gradle(android_root / "gradlew", None if case == "stale" else xml, exit_status=1)

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.FULL, ()),
        f"gradle:{proof}",
        _tool_environment(tmp_path),
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.FAIL
    behavioral = result.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert behavioral is (case in {"assertion", "array", "nested"}), (
        "native red trusted stale or unrelated JUnit output"
    )
    if case in {"assertion", "array", "nested"}:
        assert "wrong source was acknowledged" in result.detail
        retained = json.loads((tmp_path / result.evidence.artifacts[-1]).read_text())
        assert retained["cases"][0]["message"] == "wrong source was acknowledged"


def test_native_sensitivity_retains_green_report_after_build_output_changes(tmp_path: Path) -> None:
    android = tmp_path / "apps/android"
    (tmp_path / "Android/Sdk").mkdir(parents=True)
    (tmp_path / ".gitignore").write_text(
        ".nexus-test\ntest-results\ncommands.jsonl\napps/android/app/build\n"
    )
    proof = "apps/android/app/src/test/java/app/nexus/SampleTest.kt"
    _write(tmp_path / proof, "package app.nexus\nclass SampleTest\n")
    environment = _stub_tools(tmp_path, "java")
    _write_host_gradle(
        android / "gradlew",
        '<testsuite name="app.nexus.SampleTest" tests="1" failures="1" errors="0" skipped="0">'
        '<testcase classname="app.nexus.SampleTest" name="geometry">'
        '<failure type="java.lang.AssertionError" message="expected geometry rows">'
        "java.lang.AssertionError: expected geometry rows\n"
        "at app.nexus.SampleTest.geometry(SampleTest.kt:1)</failure></testcase></testsuite>",
        exit_status=1,
    )
    for command in (
        ("git", "init", "-q"),
        ("git", "config", "user.email", "nexus-test@example.test"),
        ("git", "config", "user.name", "Nexus Test"),
        ("git", "add", "."),
        ("git", "commit", "-qm", "external Gradle failing result"),
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    base = subprocess.check_output(("git", "rev-parse", "HEAD"), cwd=tmp_path, text=True).strip()
    _write_host_gradle(
        android / "gradlew",
        '<testsuite name="app.nexus.SampleTest" tests="1" failures="0" errors="0" skipped="0">'
        '<testcase classname="app.nexus.SampleTest" name="geometry"/>'
        "<system-out>geometry rows=65536 bytes=4194304</system-out></testsuite>",
    )
    subprocess.run(("git", "add", "."), cwd=tmp_path, check=True)
    subprocess.run(
        ("git", "commit", "-qm", "external Gradle successful result"), cwd=tmp_path, check=True
    )
    run_id = "0123456789abcdef"
    results = tmp_path / "test-results/runs" / run_id
    results.mkdir(parents=True)
    environment.update(
        {"NEXUS_TEST_EVIDENCE_RUN_ID": run_id, "NEXUS_TEST_RESULTS_DIR": str(results)}
    )
    result = prove(
        tmp_path,
        proof=f"gradle:{proof}",
        changed_paths=(proof,),
        method=SensitivityMethod.BASE,
        against=base,
        environment=environment,
    )
    artifacts = [tmp_path / path for path in result.green.artifacts if path.endswith(".nexus.json")]
    assert len(artifacts) == 1, "successful native evidence was omitted from its receipt"
    build_report = (
        android / "app/build/test-results/testDebugUnitTest/TEST-app.nexus.SampleTest.nexus.json"
    )
    build_report.write_text("later build replaced this output")
    retained = json.loads(artifacts[0].read_text())
    assert retained["cases"] == [{"name": "geometry", "status": "pass"}]
    assert retained.get("system_out") == "geometry rows=65536 bytes=4194304"


def test_android_host_does_not_mask_conflicting_sdk_roots_with_local_properties(
    tmp_path: Path,
) -> None:
    android_root = tmp_path / "apps/android"
    first_sdk = tmp_path / "first-sdk"
    second_sdk = tmp_path / "second-sdk"
    first_sdk.mkdir()
    second_sdk.mkdir()
    _write(
        android_root / "app/src/test/java/app/nexus/SampleTest.kt",
        "package app.nexus\nclass SampleTest\n",
    )
    _write(android_root / "local.properties", f"sdk.dir={first_sdk}\n")
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(first_sdk),
        "ANDROID_SDK_ROOT": str(second_sdk),
    }

    result = run_capability(
        CapabilityContext(tmp_path, Workflow.FULL, ()),
        Capability.ANDROID_HOST,
        environment,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.detail == "Android SDK is absent"
    assert not (tmp_path / "commands.jsonl").exists()


def test_android_release_control_owns_physical_device_and_exact_signed_methods(
    tmp_path: Path,
) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    sdk.mkdir()
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/DeviceTest.kt",
        "package app.nexus.android\nclass DeviceTest\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=(
            "List of devices attached\nemulator-5554 device product:sdk model:sdk transport_id:1\n"
        ),
    )
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(sdk),
    }

    result = run_capability(
        CapabilityContext(
            tmp_path,
            Workflow.RELEASE,
            (),
            candidate_sha=_CANDIDATE_SHA,
        ),
        Capability.ANDROID_DEVICE,
        environment,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.detail == "no authorized USB-backed physical Android device is attached"
    assert all(command["tool"] != "gradlew" for command in _commands(tmp_path))
    assert runner._ANDROID_RELEASE_INSTRUMENTATION_NODES == (
        "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt::"
        "acquiresAllFormatsAndPersistsPendingProgress",
        "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt::"
        "attestsEmptyOfflineStateOnIncompatibleBaseline",
        "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt::"
        "opensShelfAfterForceStopRebootAndAirplaneMode",
        "apps/android/app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt::"
        "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
        "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingDeviceLifecycleTest.kt::"
        "sqliteFilesSealRecreateLeaseRemovalAndAccountPurge",
        "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt::"
        "reopensPersistedPackagesThenPurgesOfflineState",
    )
    _assert_release_artifact_retains_pinned_api_origin(tmp_path, sdk)


def test_android_device_accepts_the_emulator_only_for_the_bootstrap_release(
    tmp_path: Path,
) -> None:
    """Without a handset anywhere, the bootstrap release still runs the device
    suite — on the emulator every non-release workflow already uses."""
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    run_id = "0123456789abcdef"
    results = tmp_path / "test-results/runs" / run_id
    sdk.mkdir()
    results.mkdir(parents=True)
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/DeviceTest.kt",
        "package app.nexus.android\nclass DeviceTest\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=(
            "List of devices attached\nemulator-5554 device product:sdk model:sdk transport_id:1\n"
        ),
    )
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE": "true",
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(results),
    }

    result = run_capability(
        CapabilityContext(
            tmp_path,
            Workflow.RELEASE,
            (),
            candidate_sha=_CANDIDATE_SHA,
        ),
        Capability.ANDROID_DEVICE,
        environment,
    )

    assert result.evidence.status is RunStatus.PASS, result.detail
    gradle = [command for command in _commands(tmp_path) if command["tool"] == "gradlew"]
    assert len(gradle) == 1
    assert gradle[0]["argv"] == [
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.notAnnotation="
        "app.nexus.android.offline.reading.SignedPromotion",
    ]
    assert gradle[0]["android_serial"] == "emulator-5554"


@pytest.mark.parametrize(
    ("inventory", "expected_serial", "expected_detail"),
    [
        pytest.param(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n",
            "R5CT1234",
            "",
            id="one-usb-handset",
        ),
        pytest.param(
            "List of devices attached\nemulator-5554 device product:sdk model:sdk transport_id:1\n",
            None,
            "no authorized USB-backed physical Android device is attached",
            id="emulator",
        ),
        pytest.param(
            "List of devices attached\n"
            "192.168.1.5:5555 device product:nexus model:Pixel transport_id:2\n",
            None,
            "no authorized USB-backed physical Android device is attached",
            id="wireless-adb",
        ),
        pytest.param(
            "List of devices attached\nR5CT1234 unauthorized usb:1-2 transport_id:1\n",
            None,
            "no authorized USB-backed physical Android device is attached",
            id="unauthorized",
        ),
        pytest.param(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n"
            "R5CT9999 device usb:1-3 product:nexus model:Pixel transport_id:2\n",
            None,
            "Android device proof requires exactly one USB-backed physical device",
            id="two-usb-handsets",
        ),
        pytest.param(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n"
            "192.168.1.5:5555 device product:nexus model:Pixel transport_id:2\n",
            None,
            "Android device proof requires exactly one authorized device row",
            id="usb-plus-wireless-adb",
        ),
    ],
)
def test_signed_release_device_attestation_admits_only_one_usb_handset(
    tmp_path: Path,
    inventory: str,
    expected_serial: str | None,
    expected_detail: str,
) -> None:
    """The signed lane binds one wired handset; every other transport is a lane of its own."""
    sdk = tmp_path / "android-sdk"
    adb = sdk / "platform-tools/adb"
    _write_executable(adb, stdout=inventory.rstrip("\n"))
    environment = {**_tool_environment(tmp_path), "ANDROID_HOME": str(sdk)}

    device, detail = authorized_usb_physical_device(adb, environment, tmp_path)

    assert (device.serial if device is not None else None, detail) == (
        expected_serial,
        expected_detail,
    )
    if device is not None:
        assert device.adb_devices_row == inventory.splitlines()[1]


@pytest.mark.parametrize(
    ("inventory", "expected_serial", "expected_detail"),
    [
        pytest.param(
            "List of devices attached\nemulator-5554 device product:sdk model:sdk transport_id:1\n",
            "emulator-5554",
            "",
            id="hosted-emulator",
        ),
        pytest.param(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n",
            "R5CT1234",
            "",
            id="usb-handset",
        ),
        pytest.param(
            "List of devices attached\n"
            "192.168.1.5:5555 device product:nexus model:Pixel transport_id:2\n",
            None,
            "no authorized local emulator or USB-backed Android device is attached",
            id="wireless-adb",
        ),
        pytest.param(
            "List of devices attached\n"
            "emulator-5554 device product:sdk transport_id:1\n"
            "R5CT1234 device usb:1-2 product:nexus transport_id:2\n",
            None,
            "Android device proof requires exactly one local emulator or USB device",
            id="ambiguous-inventory",
        ),
        pytest.param(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus transport_id:1\n"
            "192.168.1.5:5555 device product:nexus transport_id:2\n",
            None,
            "Android device proof requires exactly one authorized device row",
            id="usb-plus-wireless-adb",
        ),
        pytest.param(
            "emulator-5554 device product:sdk model:sdk transport_id:1\n",
            None,
            "Android device inventory could not be read",
            id="missing-adb-header",
        ),
    ],
)
def test_ordinary_device_attestation_admits_an_emulator_but_never_wireless_adb(
    tmp_path: Path,
    inventory: str,
    expected_serial: str | None,
    expected_detail: str,
) -> None:
    """Nightly keeps its hosted emulator lane; a wireless transport is never owned."""
    sdk = tmp_path / "android-sdk"
    adb = sdk / "platform-tools/adb"
    _write_executable(adb, stdout=inventory.rstrip("\n"))
    environment = {**_tool_environment(tmp_path), "ANDROID_HOME": str(sdk)}

    device, detail = authorized_instrumentation_device(adb, environment, tmp_path)

    assert (device.serial if device is not None else None, detail) == (
        expected_serial,
        expected_detail,
    )
    if device is not None:
        assert device.adb_devices_row == inventory.splitlines()[1]


def test_android_device_attestation_rejects_a_tail_truncated_inventory(
    tmp_path: Path,
) -> None:
    sdk = tmp_path / "android-sdk"
    adb = sdk / "platform-tools/adb"
    oversized = (
        "List of devices attached\n"
        + "transport unavailable product:sdk model:sdk\n" * 2_000
        + "emulator-5554 device product:sdk model:sdk transport_id:1\n"
    )
    _write_executable(adb, stdout=oversized.rstrip("\n"))
    environment = {**_tool_environment(tmp_path), "ANDROID_HOME": str(sdk)}

    device, detail = authorized_instrumentation_device(adb, environment, tmp_path)

    assert device is None
    assert detail == "Android device inventory could not be read"


def test_android_device_sweep_never_selects_the_signed_promotion_methods(
    tmp_path: Path,
) -> None:
    """The debug sweep must exclude the promotion class it cannot stage.

    `OfflineReadingSignedPhysicalPromotionTest` requires the strictly older
    signed baseline, the protected fixture identifiers, and controller-owned
    force-stop/reboot/airplane steps. Running it inside the plain
    `connectedDebugAndroidTest` sweep is a guaranteed hard failure that would
    block nightly and the signed lane behind it.
    """
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    run_id = "fedcba9876543210"
    results = tmp_path / "test-results/runs" / run_id
    sdk.mkdir()
    results.mkdir(parents=True)
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt",
        "package app.nexus.android.offline.reading\n"
        "@SignedPromotion\nclass OfflineReadingSignedPhysicalPromotionTest\n",
    )
    _stub_tools(tmp_path, "java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=(
            "List of devices attached\nemulator-5554 device product:sdk model:sdk transport_id:1\n"
        ),
    )
    _write_executable(android_root / "gradlew")
    environment = {
        **_tool_environment(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(results),
    }

    result = run_capability(
        CapabilityContext(
            tmp_path,
            Workflow.NIGHTLY,
            (),
            candidate_sha=_CANDIDATE_SHA,
        ),
        Capability.ANDROID_DEVICE,
        environment,
    )

    assert result.evidence.status is RunStatus.PASS, result.detail
    command = _commands(tmp_path)[-1]
    assert command["argv"] == [
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.notAnnotation="
        "app.nexus.android.offline.reading.SignedPromotion",
    ], f"the debug device sweep no longer excludes the signed promotion class: {command['argv']}"
    assert command["android_serial"] == "emulator-5554"

    # The signed lane still owns exactly those promotion methods.
    promotion_methods = [
        node.split("::", 1)[1]
        for node in runner._ANDROID_RELEASE_INSTRUMENTATION_NODES
        if node.split("::", 1)[0].endswith("OfflineReadingSignedPhysicalPromotionTest.kt")
    ]
    assert promotion_methods == [
        "acquiresAllFormatsAndPersistsPendingProgress",
        "attestsEmptyOfflineStateOnIncompatibleBaseline",
        "opensShelfAfterForceStopRebootAndAirplaneMode",
        "reopensPersistedPackagesThenPurgesOfflineState",
    ]
    annotation_source = (
        REPO_ROOT / "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "SignedPromotion.kt"
    ).read_text(encoding="utf-8")
    assert "annotation class SignedPromotion" in annotation_source
    promotion_source = (
        REPO_ROOT / "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt"
    ).read_text(encoding="utf-8")
    assert "@SignedPromotion" in promotion_source, (
        "the excluded annotation is not applied to the promotion owner, so the "
        "notAnnotation filter would exclude nothing"
    )


def test_android_release_fails_closed_without_full_signed_physical_scenario(
    tmp_path: Path,
) -> None:
    run_context = RunContextRecorder()
    context = CapabilityContext(
        tmp_path,
        Workflow.RELEASE,
        (),
        run_context=run_context,
    )
    execution = runner._WorkflowExecution(
        context,
        {},
        include_migration_database=False,
        run_id="0123456789abcdef",
    )

    result = runner._run_android_release(context, {}, execution)

    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.detail == ("signed physical offline-reading promotion scenario owner is absent")
    assert run_context.evidence().fixed_commands == ()


@pytest.mark.parametrize(
    ("output", "expected"),
    (
        ("OK (1 test)\n", True),
        (
            "INSTRUMENTATION_STATUS: class=app.nexus.android.offline.reading.Promotion\n"
            "INSTRUMENTATION_STATUS_CODE: 1\n"
            "INSTRUMENTATION_RESULT: stream=\nOK (1 test)\n\n"
            "INSTRUMENTATION_CODE: -1\n",
            True,
        ),
        ("OK (0 tests)\n", False),
        ("OK (2 tests)\n", False),
        ("FAILURES!!!\nTests run: 1, Failures: 1\n", False),
        (
            "INSTRUMENTATION_RESULT: stream=\nOK (1 test)\nFAILURES!!!\nINSTRUMENTATION_CODE: -1\n",
            False,
        ),
        (
            "INSTRUMENTATION_RESULT: stream=\nOK (1 test)\n"
            "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\n"
            "INSTRUMENTATION_CODE: -1\n",
            False,
        ),
        (
            "INSTRUMENTATION_RESULT: stream=\nOK (1 test)\nINSTRUMENTATION_CODE: 0\n",
            False,
        ),
    ),
)
def test_android_release_instrumentation_requires_one_exact_passing_method(
    output: str, expected: bool
) -> None:
    assert runner._android_instrumentation_one_test_passed(output) is expected


def test_android_release_promotion_fixtures_are_validated_before_protected_inputs(
    tmp_path: Path,
) -> None:
    promotion = (
        tmp_path / "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt"
    )
    _write(promotion, "package app.nexus.android.offline.reading\nclass Promotion\n")
    context = CapabilityContext(tmp_path, Workflow.RELEASE, ())
    execution = runner._WorkflowExecution(
        context, {}, include_migration_database=False, run_id="0123456789abcdef"
    )
    result = runner._run_android_release(
        context,
        {},
        execution,
        operations=runner._AndroidReleaseOperations(
            inputs=lambda *_: pytest.fail(
                "fixture validation must precede protected release inputs"
            ),
            command=lambda *_: pytest.fail("fixture validation must not invoke a command"),
            manifest_facts=lambda _: None,
            read_apk_api_origin=lambda *_: None,
            installed_version_code=lambda *_: None,
        ),
    )
    assert result.evidence.status is RunStatus.NOT_RUN
    assert "PROMOTION_ACCOUNT_ID" in result.detail


@pytest.mark.parametrize(
    ("environment", "status"),
    (
        (
            {
                "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID": "11111111-1111-4111-8111-111111111111",
                "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID": "22222222-2222-4222-8222-222222222222",
                "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID": "33333333-3333-4333-8333-333333333333",
                "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID": "44444444-4444-4444-8444-444444444444",
            },
            None,
        ),
        (
            {
                "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID": "not-a-uuid",
                "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID": "22222222-2222-4222-8222-222222222222",
                "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID": "33333333-3333-4333-8333-333333333333",
                "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID": "44444444-4444-4444-8444-444444444444",
            },
            RunStatus.FAIL,
        ),
        (
            {
                "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID": "11111111-1111-4111-8111-111111111111",
                "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID": "22222222-2222-4222-8222-222222222222",
                "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID": "22222222-2222-4222-8222-222222222222",
                "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID": "44444444-4444-4444-8444-444444444444",
            },
            RunStatus.FAIL,
        ),
    ),
)
def test_android_release_promotion_fixture_argument_contract(
    environment: dict[str, str],
    status: RunStatus | None,
) -> None:
    arguments = runner._android_release_promotion_arguments(environment)
    if status is None:
        assert arguments == (
            "-e",
            "nexus_offline_reading_promotion_account_id",
            environment["NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID"],
            "-e",
            "nexus_offline_reading_promotion_pdf_media_id",
            environment["NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID"],
            "-e",
            "nexus_offline_reading_promotion_epub_media_id",
            environment["NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID"],
            "-e",
            "nexus_offline_reading_promotion_article_media_id",
            environment["NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID"],
        )
    else:
        assert isinstance(arguments, CapabilityResult)
        assert arguments.evidence.status is status


def test_signed_physical_promotion_owner_uses_real_storage_webview_and_bridge_paths() -> None:
    source = (
        REPO_ROOT / "apps/android/app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt"
    ).read_text(encoding="utf-8")
    for required in (
        "InstrumentationRegistry.getArguments()",
        'command("ConnectHosted")',
        'command("ConnectOffline")',
        'command("OpenDownloadedCopy"',
        'command("OpenReading"',
        '"SaveReaderProgress"',
        'command("LogoutAndPurge")',
        "fetch(${JSONObject.quote(readerUrl)}",
        "PromotionProgressCheckpoint",
        "SQLiteDatabase.OPEN_READONLY",
        "offline_reader_progress_pending",
        "launchHosted()",
        'optJSONObject("state")',
        "headers: {Range: 'bytes=0-4'}",
    ):
        assert required in source
    for prohibited in (
        "OfflineReadingStore(",
        "OfflineReadingDatabase(",
        "OfflineReadingPackageVerifier",
        "SQLiteDatabase.OPEN_READWRITE",
        ".execSQL(",
        "deleteRecursively(",
        "DeviceFixture",
        "SESSION_COOKIE",
        "CookieManager.setCookie",
    ):
        assert prohibited not in source
    workflow = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    for name in runner._ANDROID_RELEASE_PROMOTION_INPUTS:
        assert name in workflow
    assert "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT" in workflow
    assert "inputs.empty_baseline_hard_cut" in workflow
    assert "PROMOTION_SESSION" not in workflow
    assert "PROMOTION_COOKIE" not in workflow


def _android_release_environment(inputs: runner._AndroidReleaseInputs) -> dict[str, str]:
    return {
        "NEXUS_ANDROID_RELEASE_BASE_URL": inputs.base_url,
        "NEXUS_ANDROID_RELEASE_OWNED_HOST": inputs.owned_host,
        "NEXUS_ANDROID_RELEASE_API_ORIGIN": inputs.api_origin,
        "NEXUS_ANDROID_RELEASE_CERT_SHA256": inputs.certificate_sha256,
        "NEXUS_ANDROID_RELEASE_STORE_FILE": str(inputs.keystore),
        "NEXUS_ANDROID_RELEASE_STORE_PASSWORD": "test-password",
        "NEXUS_ANDROID_RELEASE_KEY_ALIAS": "test-key",
        "NEXUS_ANDROID_RELEASE_KEY_PASSWORD": "test-password",
        "NEXUS_ANDROID_VERSION_CODE": str(inputs.version_code),
        "NEXUS_ANDROID_VERSION_NAME": inputs.version_name,
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "test-client",
        "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT": str(
            getattr(inputs, "empty_baseline_hard_cut", False)
        ).lower(),
        "NEXUS_ANDROID_RELEASE_PROMOTION_ACCOUNT_ID": "11111111-1111-4111-8111-111111111111",
        "NEXUS_ANDROID_RELEASE_PROMOTION_PDF_MEDIA_ID": "22222222-2222-4222-8222-222222222222",
        "NEXUS_ANDROID_RELEASE_PROMOTION_EPUB_MEDIA_ID": "33333333-3333-4333-8333-333333333333",
        "NEXUS_ANDROID_RELEASE_PROMOTION_ARTICLE_MEDIA_ID": "44444444-4444-4444-8444-444444444444",
    }


@pytest.mark.parametrize(
    "empty_hard_cut",
    (False, True),
    ids=("compatible-update", "empty-baseline-hard-cut"),
)
def test_android_release_controller_stages_physical_promotion_contract(
    tmp_path: Path,
    empty_hard_cut: bool,
) -> None:
    """The controller's topology is testable without a physical device.

    The temporary owner is only a parser fixture.  The real repository remains
    fail-closed until this owner is supplied by an executable device scenario.
    """
    android_root = tmp_path / "apps/android"
    promotion = (
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt"
    )
    _write(
        promotion,
        "package app.nexus.android.offline.reading\n"
        "class OfflineReadingSignedPhysicalPromotionTest {\n"
        " fun acquiresAllFormatsAndPersistsPendingProgress() {}\n"
        " fun attestsEmptyOfflineStateOnIncompatibleBaseline() {}\n"
        " fun opensShelfAfterForceStopRebootAndAirplaneMode() {}\n"
        " fun reopensPersistedPackagesThenPurgesOfflineState() {}\n"
        "}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt",
        "package app.nexus.android\nclass NativeAuthHandoffTest {\n"
        " fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {}\n}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingDeviceLifecycleTest.kt",
        "package app.nexus.android.offline.reading\nclass OfflineReadingDeviceLifecycleTest {\n"
        " fun sqliteFilesSealRecreateLeaseRemovalAndAccountPurge() {}\n}\n",
    )
    apk = android_root / "app/build/outputs/apk/release/app-release.apk"
    test_apk = (
        android_root / "app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
    )
    _write(tmp_path / "testdata/android/player-protocol.json", '{"version": 2}\n')
    player_protocol = runner._android_player_protocol_identity(tmp_path)
    inputs = runner._AndroidReleaseDeviceInputs(
        "android-v2.1",
        "a" * 40,
        "https://nexus.nielseriknandal.com",
        "https://api.nielseriknandal.com",
        "nexus.nielseriknandal.com",
        "a" * 64,
        tmp_path / "release.jks",
        42,
        41,
        "2.1",
        tmp_path / "adb",
        tmp_path / "apksigner",
        tmp_path / "apkanalyzer",
        "R5CT1234",
        empty_hard_cut,
    )
    commands: list[tuple[str, ...]] = []
    airplane = {"enabled": False}

    def command(
        argv: tuple[str, ...], _cwd: Path, _environment: Mapping[str, str]
    ) -> subprocess.CompletedProcess[str]:
        commands.append(argv)
        if argv[0] == "./gradlew":
            apk.parent.mkdir(parents=True, exist_ok=True)
            apk.write_bytes(b"signed candidate")
            test_apk.parent.mkdir(parents=True, exist_ok=True)
            test_apk.write_bytes(b"baseline test")
        stdout = ""
        if argv[-2:] == ("airplane-mode", "disable"):
            airplane["enabled"] = False
        elif argv[-2:] == ("airplane-mode", "enable"):
            airplane["enabled"] = True
        elif "settings" in argv:
            stdout = "1\n" if airplane["enabled"] else "0\n"
        elif "getprop" in argv:
            if argv[-1] == "sys.user.0.ce_available":
                stdout = "true\n"
            elif argv[-1] in {"ro.kernel.qemu", "ro.boot.qemu"}:
                # A physical handset reports these as empty.
                stdout = "\n"
            else:
                stdout = "1\n"
        elif "instrument" in argv:
            stdout = "OK (1 test)\n"
        elif "resolve-activity" in argv:
            stdout = "app.nexus.android/.MainActivity\n"
        elif argv and argv[0] == str(inputs.apksigner):
            stdout = "Signer #1 certificate SHA-256 digest: " + ":".join(["aa"] * 32)
        return subprocess.CompletedProcess(argv, 0, stdout, "")

    operations = runner._AndroidReleaseOperations(
        inputs=lambda *_: inputs,
        command=command,
        manifest_facts=lambda _: (
            "app.nexus.android",
            "42",
            "2.1",
            "nexus.nielseriknandal.com",
            "36",
            str(player_protocol.version),
            player_protocol.contract_sha256,
        ),
        read_apk_api_origin=lambda *_: inputs.api_origin,
        installed_version_code=lambda *_: (
            42 if any("install" in item and str(apk) in item for item in commands) else 41
        ),
    )
    environment = {
        **_android_release_environment(inputs),
        "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT": str(empty_hard_cut).lower(),
    }
    context = CapabilityContext(tmp_path, Workflow.RELEASE, ())
    execution = runner._WorkflowExecution(
        context, {}, include_migration_database=False, run_id="0123456789abcdef"
    )

    result = runner._run_android_release(
        context,
        environment,
        execution,
        operations=operations,
    )

    assert result.evidence.status is RunStatus.PASS
    acquisition_target = (
        "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
        "acquiresAllFormatsAndPersistsPendingProgress"
    )
    empty_target = (
        "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
        "attestsEmptyOfflineStateOnIncompatibleBaseline"
    )
    offline_target = (
        "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
        "opensShelfAfterForceStopRebootAndAirplaneMode"
    )
    candidate_target = (
        "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
        "reopensPersistedPackagesThenPurgesOfflineState"
    )
    baseline_target = empty_target if empty_hard_cut else acquisition_target
    baseline_run = next(index for index, argv in enumerate(commands) if baseline_target in argv)
    acquisition_run = next(
        index for index, argv in enumerate(commands) if acquisition_target in argv
    )
    offline_run = next(index for index, argv in enumerate(commands) if offline_target in argv)
    candidate_run = next(index for index, argv in enumerate(commands) if candidate_target in argv)
    candidate_install = next(
        index
        for index, argv in enumerate(commands)
        if argv[-1:] == (str(apk),) and "install" in argv
    )
    test_install = next(
        index
        for index, argv in enumerate(commands)
        if argv[-1:] == (str(test_apk),) and "install" in argv
    )
    force_stops = [
        index
        for index, argv in enumerate(commands)
        if ("force-stop", "app.nexus.android") == argv[-2:]
    ]
    force_stop = force_stops[-1]
    if empty_hard_cut:
        assert (
            force_stops[0]
            < test_install
            < baseline_run
            < candidate_install
            < acquisition_run
            < force_stop
            < offline_run
            < candidate_run
        )
        assert len(force_stops) == 2
    else:
        assert (
            test_install
            < baseline_run
            < force_stop
            < offline_run
            < candidate_install
            < candidate_run
        )
        assert len(force_stops) == 1
    for target in runner._ANDROID_RELEASE_CANDIDATE_VALIDATION_NODES:
        assert candidate_install < next(
            index
            for index, argv in enumerate(commands)
            if target.rsplit("::", 1)[1] in " ".join(argv)
        )
    assert any(argv[-1:] == ("reboot",) for argv in commands)
    assert any(argv[-1:] == ("wait-for-device",) for argv in commands)
    assert any(argv[-1:] == ("sys.user.0.ce_available",) for argv in commands)
    assert any(argv[-2:] == ("airplane-mode", "enable") for argv in commands)
    online_preflight = next(
        index for index, argv in enumerate(commands) if argv[-2:] == ("airplane-mode", "disable")
    )
    if empty_hard_cut:
        assert baseline_run < candidate_install < online_preflight < acquisition_run
    else:
        assert online_preflight < test_install
    assert any(argv[-1:] == ("airplane_mode_on",) for argv in commands)
    promotion_argv = commands[baseline_run]
    assert promotion_argv.count("-e") == 5
    for _, instrumentation_name in runner._ANDROID_RELEASE_PROMOTION_ARGUMENTS:
        assert instrumentation_name in promotion_argv

    # Retained release evidence may only carry facts the controller read back.
    evidence = json.loads(
        (tmp_path / "test-results/runs/0123456789abcdef/android-release.json").read_text()
    )
    assert evidence["physical_device"] == {
        "serial": inputs.serial,
        "connection": "usb",
        "qemu_properties": {"ro.kernel.qemu": "", "ro.boot.qemu": ""},
    }, f"release evidence recorded an unmeasured device claim: {evidence['physical_device']!r}"
    expected_network = {
        "baseline": {
            "phase": (
                "airplane_attested_empty_offline_state"
                if empty_hard_cut
                else "airplane_disabled_then_real_api_acquisition"
            ),
            "airplane_mode_on": "1" if empty_hard_cut else "0",
        },
        "cold_offline": {
            "phase": "airplane_attested_after_reboot",
            "airplane_mode_on": "1",
        },
    }
    if empty_hard_cut:
        expected_network["candidate_acquisition"] = {
            "phase": "airplane_disabled_then_real_api_acquisition",
            "airplane_mode_on": "0",
        }
    assert evidence["network_phases"] == expected_network, (
        f"release evidence recorded an unmeasured network claim: {evidence['network_phases']!r}"
    )
    assert evidence["offline_baseline_mode"] == (
        "empty_hard_cut" if empty_hard_cut else "compatible"
    )
    assert evidence["version"] == 3
    assert evidence["instrumentation_stages"]["baseline"] == [baseline_target]
    assert evidence["instrumentation_stages"]["candidate_acquisition"] == (
        [acquisition_target] if empty_hard_cut else []
    )
    assert evidence["instrumentation_stages"]["cold_offline"] == [offline_target]
    assert evidence["instrumentation_stages"]["candidate_validation"][-1] == candidate_target
    assert "production_network_contact" not in evidence, (
        "release evidence still asserts production network contact the controller never observed"
    )
    assert evidence["player_protocol"] == player_protocol.as_json()
    qemu_reads = [
        argv for argv in commands if argv[-1:] in (("ro.kernel.qemu",), ("ro.boot.qemu",))
    ]
    assert len(qemu_reads) == 2, f"the emulator properties were not measured: {qemu_reads!r}"


def test_android_release_refuses_an_emulated_device_that_passes_usb_topology(
    tmp_path: Path,
) -> None:
    """A `usb:` row is a topology fact, not proof the endpoint is real hardware."""
    android_root = tmp_path / "apps/android"
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt",
        "package app.nexus.android.offline.reading\n"
        "class OfflineReadingSignedPhysicalPromotionTest {\n"
        " fun acquiresAllFormatsAndPersistsPendingProgress() {}\n"
        " fun attestsEmptyOfflineStateOnIncompatibleBaseline() {}\n"
        " fun opensShelfAfterForceStopRebootAndAirplaneMode() {}\n"
        " fun reopensPersistedPackagesThenPurgesOfflineState() {}\n"
        "}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt",
        "package app.nexus.android\nclass NativeAuthHandoffTest {\n"
        " fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {}\n}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingDeviceLifecycleTest.kt",
        "package app.nexus.android.offline.reading\nclass OfflineReadingDeviceLifecycleTest {\n"
        " fun sqliteFilesSealRecreateLeaseRemovalAndAccountPurge() {}\n}\n",
    )
    apk = android_root / "app/build/outputs/apk/release/app-release.apk"
    test_apk = (
        android_root / "app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
    )
    _write(tmp_path / "testdata/android/player-protocol.json", '{"version": 2}\n')
    player_protocol = runner._android_player_protocol_identity(tmp_path)
    inputs = runner._AndroidReleaseDeviceInputs(
        "android-v2.1",
        "a" * 40,
        "https://nexus.nielseriknandal.com",
        "https://api.nielseriknandal.com",
        "nexus.nielseriknandal.com",
        "a" * 64,
        tmp_path / "release.jks",
        42,
        41,
        "2.1",
        tmp_path / "adb",
        tmp_path / "apksigner",
        tmp_path / "apkanalyzer",
        "R5CT1234",
    )

    def command(
        argv: tuple[str, ...], _cwd: Path, _environment: Mapping[str, str]
    ) -> subprocess.CompletedProcess[str]:
        if argv[0] == "./gradlew":
            apk.parent.mkdir(parents=True, exist_ok=True)
            apk.write_bytes(b"signed candidate")
            test_apk.parent.mkdir(parents=True, exist_ok=True)
            test_apk.write_bytes(b"baseline test")
        stdout = ""
        if "settings" in argv:
            stdout = "0\n"
        elif argv[-1:] == ("ro.kernel.qemu",):
            stdout = "1\n"
        elif "getprop" in argv:
            stdout = "\n"
        elif "instrument" in argv:
            pytest.fail("an emulated release device must be refused before instrumentation")
        elif argv and argv[0] == str(inputs.apksigner):
            stdout = "Signer #1 certificate SHA-256 digest: " + ":".join(["aa"] * 32)
        return subprocess.CompletedProcess(argv, 0, stdout, "")

    operations = runner._AndroidReleaseOperations(
        inputs=lambda *_: inputs,
        command=command,
        manifest_facts=lambda _: (
            "app.nexus.android",
            "42",
            "2.1",
            "nexus.nielseriknandal.com",
            "36",
            str(player_protocol.version),
            player_protocol.contract_sha256,
        ),
        read_apk_api_origin=lambda *_: inputs.api_origin,
        installed_version_code=lambda *_: 41,
    )
    context = CapabilityContext(tmp_path, Workflow.RELEASE, ())
    execution = runner._WorkflowExecution(
        context, {}, include_migration_database=False, run_id="0123456789abcdef"
    )

    result = runner._run_android_release(
        context,
        _android_release_environment(inputs),
        execution,
        operations=operations,
    )

    assert result.evidence.status is RunStatus.FAIL
    assert result.detail == (
        "signed release proof requires physical hardware, not an emulated device"
    )


@pytest.mark.parametrize(
    ("previous_version_code", "expected_detail"),
    [
        pytest.param(
            "16",
            None,
            id="published-stable-code",
        ),
        pytest.param(
            "",
            "Android bootstrap release requires the published stable version code",
            id="absent",
        ),
        pytest.param(
            "0",
            "Android bootstrap release requires the published stable version code",
            id="zero",
        ),
        pytest.param(
            "sixteen",
            "Android bootstrap release requires the published stable version code",
            id="non-integer",
        ),
        pytest.param(
            "17",
            "Android release version code must be greater than the published stable baseline",
            id="not-monotonic",
        ),
    ],
)
def test_android_release_bootstrap_inputs_attest_no_device_and_require_published_code(
    tmp_path: Path,
    previous_version_code: str,
    expected_detail: str | None,
) -> None:
    """Bootstrap mode replaces the measured installed baseline with an explicit
    operator attestation and must never touch a device inventory."""
    sdk = tmp_path / "android-sdk"
    _write_executable(sdk / "platform-tools/adb", stdout="List of devices attached")
    _write_executable(sdk / "build-tools/35.0.0/apksigner")
    _write_executable(sdk / "cmdline-tools/latest/bin/apkanalyzer")
    keystore = tmp_path / "release.jks"
    keystore.write_bytes(b"keystore")
    keystore.chmod(0o600)
    environment = {
        **_stub_tools(tmp_path, git_stdout="a" * 40),
        "ANDROID_HOME": str(sdk),
        "ANDROID_RELEASE_TAG": "android-v0.2.14",
        "NEXUS_ANDROID_RELEASE_BASE_URL": "https://nexus.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST": "nexus.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_API_ORIGIN": "https://api.nexus.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_CERT_SHA256": "a" * 64,
        "NEXUS_ANDROID_RELEASE_STORE_FILE": str(keystore),
        "NEXUS_ANDROID_RELEASE_STORE_PASSWORD": "test-password",
        "NEXUS_ANDROID_RELEASE_KEY_ALIAS": "test-key",
        "NEXUS_ANDROID_RELEASE_KEY_PASSWORD": "test-password",
        "NEXUS_ANDROID_VERSION_CODE": "17",
        "NEXUS_ANDROID_VERSION_NAME": "0.2.14",
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "test-client",
        "NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE": "true",
        "NEXUS_ANDROID_PREVIOUS_VERSION_CODE": previous_version_code,
    }

    inputs = runner._android_release_inputs(tmp_path, environment)

    if expected_detail is None:
        assert isinstance(inputs, runner._AndroidReleaseBootstrapInputs)
        assert inputs.bootstrap is True
        assert inputs.serial is None
        assert inputs.previous_version_code == 16
        invalid_bootstrap = runner._android_release_inputs(
            tmp_path,
            {
                **environment,
                "NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE": "yes",
            },
        )
        assert isinstance(invalid_bootstrap, CapabilityResult)
        assert invalid_bootstrap.evidence.status is RunStatus.FAIL
        assert invalid_bootstrap.detail == ("Android release bootstrap input must be true or false")
        invalid_mode = runner._android_release_inputs(
            tmp_path,
            {
                **environment,
                "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT": "yes",
            },
        )
        assert isinstance(invalid_mode, CapabilityResult)
        assert invalid_mode.evidence.status is RunStatus.FAIL
        assert invalid_mode.detail == (
            "Android release empty-baseline hard-cut input must be true or false"
        )
        incompatible_modes = runner._android_release_inputs(
            tmp_path,
            {
                **environment,
                "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT": "true",
            },
        )
        assert isinstance(incompatible_modes, CapabilityResult)
        assert incompatible_modes.evidence.status is RunStatus.FAIL
        assert incompatible_modes.detail == (
            "Android release bootstrap and empty-baseline hard-cut modes are mutually exclusive"
        )
        for variable, value, detail in (
            (
                "NEXUS_ANDROID_RELEASE_BASE_URL",
                "https://nexus.nielseriknandal.com/",
                "Android release URL must be the canonical HTTPS origin",
            ),
            (
                "NEXUS_ANDROID_RELEASE_API_ORIGIN",
                "https://api.nexus.nielseriknandal.com/",
                "Android release API origin must be one exact HTTPS origin",
            ),
        ):
            rejected = runner._android_release_inputs(
                tmp_path,
                {**environment, variable: value},
            )
            assert isinstance(rejected, CapabilityResult)
            assert rejected.evidence.status is RunStatus.FAIL
            assert rejected.detail == detail
    else:
        assert isinstance(inputs, CapabilityResult)
        assert inputs.evidence.status is RunStatus.FAIL
        assert inputs.detail == expected_detail
    adb_calls = [record for record in _commands(tmp_path) if record["tool"] == "adb"]
    assert adb_calls == [], "bootstrap inputs must not attest or read any device"


def test_android_release_inputs_bind_the_empty_baseline_hard_cut_to_the_usb_device(
    tmp_path: Path,
) -> None:
    sdk = tmp_path / "android-sdk"
    _write_executable(
        sdk / "platform-tools/adb",
        stdout_by_subcommand={
            "devices": (
                "List of devices attached\n"
                "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n"
            ),
            "-s": "  versionCode=41 minSdk=26 targetSdk=36\n",
        },
    )
    _write_executable(sdk / "build-tools/35.0.0/apksigner")
    _write_executable(sdk / "cmdline-tools/latest/bin/apkanalyzer")
    keystore = tmp_path / "release.jks"
    keystore.write_bytes(b"keystore")
    keystore.chmod(0o600)
    environment = {
        **_stub_tools(tmp_path, git_stdout="a" * 40),
        "ANDROID_HOME": str(sdk),
        "ANDROID_RELEASE_TAG": "android-v2.1",
        "NEXUS_ANDROID_RELEASE_BASE_URL": "https://nexus.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_OWNED_HOST": "nexus.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_API_ORIGIN": "https://api.nielseriknandal.com",
        "NEXUS_ANDROID_RELEASE_CERT_SHA256": "a" * 64,
        "NEXUS_ANDROID_RELEASE_STORE_FILE": str(keystore),
        "NEXUS_ANDROID_RELEASE_STORE_PASSWORD": "test-password",
        "NEXUS_ANDROID_RELEASE_KEY_ALIAS": "test-key",
        "NEXUS_ANDROID_RELEASE_KEY_PASSWORD": "test-password",
        "NEXUS_ANDROID_VERSION_CODE": "42",
        "NEXUS_ANDROID_VERSION_NAME": "2.1",
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "test-client",
        "NEXUS_ANDROID_RELEASE_EMPTY_BASELINE_HARD_CUT": "true",
    }

    inputs = runner._android_release_inputs(tmp_path, environment)

    assert isinstance(inputs, runner._AndroidReleaseDeviceInputs)
    assert inputs.serial == "R5CT1234"
    assert inputs.previous_version_code == 41
    assert inputs.empty_baseline_hard_cut is True


def test_android_release_bootstrap_skips_device_stages_and_records_explicit_evidence(
    tmp_path: Path,
) -> None:
    """The bootstrap release verifies everything a device does not own — build,
    signature, manifest/protocol contract, pinned API origin — and its retained
    evidence must state the skipped stages instead of implying a handset ran."""
    android_root = tmp_path / "apps/android"
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingSignedPhysicalPromotionTest.kt",
        "package app.nexus.android.offline.reading\n"
        "class OfflineReadingSignedPhysicalPromotionTest {\n"
        " fun acquiresAllFormatsAndPersistsPendingProgress() {}\n"
        " fun attestsEmptyOfflineStateOnIncompatibleBaseline() {}\n"
        " fun opensShelfAfterForceStopRebootAndAirplaneMode() {}\n"
        " fun reopensPersistedPackagesThenPurgesOfflineState() {}\n"
        "}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt",
        "package app.nexus.android\nclass NativeAuthHandoffTest {\n"
        " fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {}\n}\n",
    )
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/offline/reading/"
        "OfflineReadingDeviceLifecycleTest.kt",
        "package app.nexus.android.offline.reading\nclass OfflineReadingDeviceLifecycleTest {\n"
        " fun sqliteFilesSealRecreateLeaseRemovalAndAccountPurge() {}\n}\n",
    )
    apk = android_root / "app/build/outputs/apk/release/app-release.apk"
    test_apk = (
        android_root / "app/build/outputs/apk/androidTest/release/app-release-androidTest.apk"
    )
    _write(tmp_path / "testdata/android/player-protocol.json", '{"version": 2}\n')
    player_protocol = runner._android_player_protocol_identity(tmp_path)
    inputs = runner._AndroidReleaseBootstrapInputs(
        "android-v2.1",
        "a" * 40,
        "https://nexus.nielseriknandal.com",
        "https://api.nielseriknandal.com",
        "nexus.nielseriknandal.com",
        "a" * 64,
        tmp_path / "release.jks",
        42,
        41,
        "2.1",
        tmp_path / "adb",
        tmp_path / "apksigner",
        tmp_path / "apkanalyzer",
    )
    commands: list[tuple[str, ...]] = []

    def command(
        argv: tuple[str, ...], _cwd: Path, environment: Mapping[str, str]
    ) -> subprocess.CompletedProcess[str]:
        commands.append(argv)
        assert "ANDROID_SERIAL" not in environment, "bootstrap must not bind a device serial"
        if argv[0] == "./gradlew":
            apk.parent.mkdir(parents=True, exist_ok=True)
            apk.write_bytes(b"signed candidate")
            test_apk.parent.mkdir(parents=True, exist_ok=True)
            test_apk.write_bytes(b"candidate test")
        stdout = ""
        if argv and argv[0] == str(inputs.apksigner):
            stdout = "Signer #1 certificate SHA-256 digest: " + ":".join(["aa"] * 32)
        return subprocess.CompletedProcess(argv, 0, stdout, "")

    operations = runner._AndroidReleaseOperations(
        inputs=lambda *_: inputs,
        command=command,
        manifest_facts=lambda _: (
            "app.nexus.android",
            "42",
            "2.1",
            "nexus.nielseriknandal.com",
            "36",
            str(player_protocol.version),
            player_protocol.contract_sha256,
        ),
        read_apk_api_origin=lambda *_: inputs.api_origin,
        installed_version_code=lambda *_: pytest.fail(
            "bootstrap must never read an installed baseline"
        ),
    )
    environment = {
        **_android_release_environment(inputs),
        "NEXUS_ANDROID_RELEASE_BOOTSTRAP_NO_DEVICE": "true",
        "NEXUS_ANDROID_PREVIOUS_VERSION_CODE": "41",
    }
    context = CapabilityContext(tmp_path, Workflow.RELEASE, ())
    execution = runner._WorkflowExecution(
        context, {}, include_migration_database=False, run_id="0123456789abcdef"
    )

    result = runner._run_android_release(
        context,
        environment,
        execution,
        operations=operations,
    )

    assert result.evidence.status is RunStatus.PASS
    assert result.detail == (
        "signed build, manifest/protocol contract, and pinned API origin verified; "
        "signed-physical device stages explicitly skipped by the bootstrap release"
    )
    device_tokens = (
        "install",
        "instrument",
        "reboot",
        "wait-for-device",
        "getprop",
        "resolve-activity",
        "airplane-mode",
        "force-stop",
    )
    device_commands = [argv for argv in commands if any(token in argv for token in device_tokens)]
    assert device_commands == [], f"bootstrap ran device commands: {device_commands!r}"
    assert any(argv[0] == "./gradlew" for argv in commands)
    signer_runs = [argv for argv in commands if argv[0] == str(inputs.apksigner)]
    assert len(signer_runs) == 1, "bootstrap verifies the signature exactly once"

    evidence = json.loads(
        (tmp_path / "test-results/runs/0123456789abcdef/android-release.json").read_text()
    )
    assert evidence["physical_device"] is None
    assert evidence["offline_baseline_mode"] == "bootstrap_no_device"
    assert evidence["version"] == 3
    stage_targets = {
        "baseline": [
            "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
            "acquiresAllFormatsAndPersistsPendingProgress",
        ],
        "candidate_acquisition": [],
        "cold_offline": [
            "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
            "opensShelfAfterForceStopRebootAndAirplaneMode",
        ],
        "candidate_validation": [
            "app.nexus.android.NativeAuthHandoffTest#"
            "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
            "app.nexus.android.offline.reading.OfflineReadingDeviceLifecycleTest#"
            "sqliteFilesSealRecreateLeaseRemovalAndAccountPurge",
            "app.nexus.android.offline.reading.OfflineReadingSignedPhysicalPromotionTest#"
            "reopensPersistedPackagesThenPurgesOfflineState",
        ],
    }
    assert evidence["bootstrap"] == {
        "no_device": True,
        "previous_version_code_source": "operator_attested_published_stable",
        "skipped_stages": stage_targets,
    }
    assert evidence["instrumentation_proofs"] == []
    assert evidence["instrumentation_stages"] == {}
    assert evidence["network_phases"] == {}
    assert "resolved_activity" not in evidence
    assert evidence["previous_version_code"] == 41
    assert evidence["player_protocol"] == player_protocol.as_json()


def _assert_release_artifact_retains_pinned_api_origin(tmp_path: Path, sdk: Path) -> None:
    run_id = "0123456789abcdef"
    git_sha = "a" * 40
    tag = "android-v2.1"
    api_origin = "https://api.nielseriknandal.com"
    apk_relative = "apps/android/app/build/outputs/apk/release/app-release.apk"
    apk = tmp_path / apk_relative
    apk.parent.mkdir(parents=True, exist_ok=True)
    apk.write_bytes(b"signed-apk")
    apk_sha256 = runner._sha256_file(apk)
    _write(
        tmp_path / "python/tests/release_artifact/test_image_binding.py",
        "def test_image_binding():\n    assert True\n",
    )
    (tmp_path / "python/.venv").mkdir(parents=True)
    _initialize_local_runtime(tmp_path)
    _write_executable(tmp_path / "bin/uv")
    _write_passthrough_env(tmp_path / "bin/env")
    _write_release_artifact_docker(tmp_path / "bin/docker")
    _write(tmp_path / "testdata/android/player-protocol.json", '{"version": 2}\n')
    player_protocol = runner._android_player_protocol_identity(tmp_path)
    evidence = tmp_path / f"test-results/runs/{run_id}/android-release.json"
    _write(
        evidence,
        json.dumps(
            {
                "version": 3,
                "run_id": run_id,
                "git_sha": git_sha,
                "tag": tag,
                "apk_path": apk_relative,
                "apk_sha256": apk_sha256,
                "apk_size": apk.stat().st_size,
                "package": "app.nexus.android",
                "version_code": 42,
                "previous_version_code": 41,
                "version_name": "2.1",
                "signer_sha256": "b" * 64,
                "offline_baseline_mode": "compatible",
                "physical_device": {"serial": "R5CT1234"},
                "app_link_host": "nexus.nielseriknandal.com",
                "api_origin": api_origin,
                "api_origin_source": "signed_apk_build_config",
                "target_sdk": 36,
                "player_protocol": player_protocol.as_json(),
            }
        ),
    )
    _write_executable(
        sdk / "build-tools/36.0.0/apksigner",
        stdout="Signer #1 certificate SHA-256 digest: " + "b" * 64,
    )
    _write_executable(
        sdk / "cmdline-tools/latest/bin/apkanalyzer",
        stdout_by_subcommand={
            "manifest": (
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android" '
                'package="app.nexus.android" android:versionCode="42" android:versionName="2.1">'
                '<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/>'
                '<application android:usesCleartextTraffic="false">'
                '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_VERSION" '
                f'android:value="{player_protocol.version}"/>'
                '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256" '
                f'android:value="{player_protocol.contract_sha256}"/>'
                '<activity><intent-filter android:autoVerify="true">'
                '<data android:scheme="https" android:host="nexus.nielseriknandal.com"/>'
                "</intent-filter></activity></application></manifest>"
            ),
            "dex": f'.field public static final NEXUS_API_ORIGIN:Ljava/lang/String; = "{api_origin}"',
        },
    )
    git_script = tmp_path / "bin/git"
    _write(git_script, f"#!/bin/sh\nset -eu\nprintf '%s\\n' '{git_sha}'\n")
    git_script.chmod(0o755)
    execution = runner._WorkflowExecution(
        CapabilityContext(tmp_path, Workflow.RELEASE, ()),
        {},
        include_migration_database=False,
        run_id=run_id,
    )

    result = runner._run_release_artifact(
        execution.context,
        {**_tool_environment(tmp_path), "ANDROID_HOME": str(sdk)},
        execution,
    )

    assert result.evidence.status is RunStatus.PASS
    manifest = json.loads(
        (tmp_path / f"test-results/runs/{run_id}/release/release-manifest.json").read_text()
    )
    assert manifest["api_origin"] == api_origin
    assert manifest["target_sdk"] == 36
    assert manifest["player_protocol"] == player_protocol.as_json()


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


def test_heavy_capability_remains_truthfully_not_run(tmp_path: Path) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/tests/service/test_owned.py", "def test_owned(): pass\n")
    context = CapabilityContext(tmp_path, Workflow.FULL, ())

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

    class Ports(_ReadyProtocolPorts):
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
            _available_storage=lambda _root, _docker: 16384,
        )
    except runner.WorkflowExecutionError as error:
        assert isinstance(error.__cause__, CommandInterrupted)
        assert error.owner is Capability.SERVICE
        assert "SIGTERM" in str(error)
    else:
        pytest.fail(f"workflow did not propagate interruption: {evidence}")

    assert cleaned == ["0123456789abcdef"]


def test_workflow_cleanup_failure_replaces_the_passed_runtime_owner(tmp_path: Path) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    path = "python/tests/service/test_owned.py"
    _write(tmp_path / path, "def test_owned():\n    assert 2 + 2 == 4\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    environment = _stub_tools(tmp_path, "docker", "supabase", "uv")
    cleaned: list[str] = []

    class Ports(_ReadyProtocolPorts):
        def prepare_run(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            assert run_id == "0123456789abcdef"
            assert not include_migration_database
            return _test_run(include_migration_database=False)

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

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
            raise RuntimeError("completed service cleanup failed")

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=lambda _repo_root: 0,
    )
    selection = Selection(path, Capability.SERVICE, SelectionReason.CHANGED_TEST, f"pytest:{path}")
    with pytest.raises(runner.WorkflowExecutionError) as raised:
        run_workflow(
            CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
            StringIO(),
            environment,
            run_id="0123456789abcdef",
            _ports=Ports(),
            _available_memory=lambda: 8192,
            _memory_sampler=sampler,
        )

    error = raised.value
    assert error.owner is Capability.SERVICE
    assert all(item.status is RunStatus.PASS for item in error.completed)
    service = next(item for item in error.completed if item.id is Capability.SERVICE)
    assert service.duration_ms > 0
    assert service.peak_owned_mib == 2
    assert isinstance(error.__cause__, RuntimeError)
    assert "completed service cleanup failed" in str(error)
    assert cleaned == ["0123456789abcdef"]


def _assert_container_measurement_stops_before_owned_runtime_cleanup(
    tmp_path: Path, *, exact_proof: bool
) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    _write(
        tmp_path / "python/tests/service/test_owned.py",
        "def test_owned():\n    assert 2 + 2 == 4\n",
    )
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    environment = _stub_tools(tmp_path, "docker", "supabase", "uv")
    cleanup_started = False
    container_reads_after_cleanup = 0
    cleaned: list[str] = []

    def read_container(_repo_root: Path) -> int:
        nonlocal container_reads_after_cleanup
        if cleanup_started:
            container_reads_after_cleanup += 1
            raise RuntimeContractError("owned runtime is already being removed")
        return 4 * 1024 * 1024

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=read_container,
    )

    class Ports(_ReadyProtocolPorts):
        def prepare_run(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            *,
            run_id: str,
            include_migration_database: bool,
        ) -> OwnedTestRun:
            del repo_root, environment
            assert not include_migration_database
            assert run_id
            return _test_run(include_migration_database=False)

        def run_environment(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(environment), run)

        def clean_run(
            self,
            repo_root: Path,
            environment: Mapping[str, str],
            run_id: str,
            *,
            supabase: SupabaseCredentials,
        ) -> None:
            nonlocal cleanup_started
            del repo_root, environment, run_id, supabase
            cleanup_started = True
            sampler._sample(include_containers=True)
            cleaned.append("run")

    selection = Selection(
        "python/tests/service/test_owned.py",
        Capability.SERVICE,
        SelectionReason.CHANGED_TEST,
        "pytest:python/tests/service/test_owned.py",
    )
    context = CapabilityContext(tmp_path, Workflow.CHANGED, (selection,))
    if exact_proof:
        result = run_proof(
            context,
            "pytest:python/tests/service/test_owned.py",
            environment,
            _ports=Ports(),
            _available_memory=lambda: 8192,
            _memory_sampler=sampler,
        )
        status = result.evidence.status
        peak_owned_mib = sampler.snapshot()
    else:
        evidence = run_workflow(
            CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
            StringIO(),
            environment,
            run_id="0123456789abcdef",
            _ports=Ports(),
            _available_memory=lambda: 8192,
            _memory_sampler=sampler,
        )
        service = next(item for item in evidence.capabilities if item.id is Capability.SERVICE)
        status = service.status
        peak_owned_mib = evidence.peak_owned_mib

    assert cleaned == ["run"]
    assert status is RunStatus.PASS
    assert peak_owned_mib.measurement_complete is True
    assert peak_owned_mib.container_working_set == 4
    assert container_reads_after_cleanup == 0


def test_workflow_stops_container_measurement_before_owned_runtime_cleanup(
    tmp_path: Path,
) -> None:
    _assert_container_measurement_stops_before_owned_runtime_cleanup(tmp_path, exact_proof=False)


def test_exact_proof_stops_container_measurement_before_owned_runtime_cleanup(
    tmp_path: Path,
) -> None:
    _assert_container_measurement_stops_before_owned_runtime_cleanup(tmp_path, exact_proof=True)


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
        _available_storage=lambda _root, _docker: 16384,
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


def test_insufficient_storage_fails_closed_under_the_heavy_lock(tmp_path: Path) -> None:
    source = tmp_path / "apps/web/src/risk.ts"
    _write(source, "export const risk = 1;\n")
    _write(tmp_path / "python/pyproject.toml", "[project]\nname='fixture'\nversion='1'\n")
    (tmp_path / "python/.venv").mkdir()
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    selection = Selection(
        "apps/web/src/risk.ts",
        Capability.COMPONENT,
        SelectionReason.FRONTEND_RELATED,
    )
    lock_held = [False]
    observed: list[tuple[Path, bool]] = []

    class Ports(runner._RunnerPorts):
        @contextmanager
        def heavy_lock(self, _repo_root: Path) -> Iterator[Path]:
            lock_held[0] = True
            try:
                yield tmp_path / "heavy.lock"
            finally:
                lock_held[0] = False

    def available_storage(repo_root: Path, include_docker: bool) -> int:
        assert lock_held[0], "storage admission sampled outside the controller heavy lock"
        observed.append((repo_root, include_docker))
        return 1024

    evidence = run_workflow(
        CapabilityContext(tmp_path, Workflow.CHANGED, (selection,)),
        StringIO(),
        {},
        run_id="0123456789abcdef",
        _ports=Ports(),
        _available_memory=lambda: 8192,
        _available_storage=available_storage,
    )

    static_web = next(item for item in evidence.capabilities if item.id is Capability.STATIC_WEB)
    assert static_web.status is RunStatus.NOT_RUN
    assert static_web.detail == (
        "heavy storage admission requires 8192 MiB available; observed 1024 MiB"
    )
    assert observed == [(tmp_path, False)]
    assert not lock_held[0]
    assert not (tmp_path / "commands.jsonl").exists()


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

    class Ports(_ReadyProtocolPorts):
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
        _available_storage=lambda _root, _docker: 16384,
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
        "durable-ingest-reader-open",
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
    process_overrides: dict[str, Mapping[str, str] | None] = {}
    readiness_calls: list[tuple[str, runner.EndpointKind, str]] = []
    generation_readiness_calls: list[str] = []
    password_users: list[str] = []
    invited_users: list[str] = []
    entitlements: list[str] = []
    data_plane_resets: list[str] = []
    artifact = tmp_path / ".nexus-test/builds/fingerprint"
    _write(artifact / "server.js", "export {};\n")

    class Ports(runner._RunnerPorts):
        def reset_run_data_plane(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> None:
            assert process_roles == []
            data_plane_resets.append(run.run_id)

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

        def materialize_embedding_peer(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
        ) -> EmbeddingPeer:
            from nexus_test_control.services import EmbeddingPeer

            state = tmp_path / "embedding-peer"
            state.mkdir()
            certificate = state / "ca.pem"
            key = state / "server-key.pem"
            audit = state / "requests.jsonl"
            for path in (certificate, key, audit):
                _write(path, "owned\n")
            return EmbeddingPeer(state, certificate, key, audit, 4443)

        def materialize_provider_api_peer(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
        ) -> ProviderApiPeer:
            from nexus_test_control.services import ProviderApiPeer

            state = tmp_path / "provider-api-peer"
            state.mkdir()
            certificate = state / "ca.pem"
            key = state / "server-key.pem"
            audit = state / "requests.jsonl"
            for path in (certificate, key, audit):
                _write(path, "owned\n")
            return ProviderApiPeer(state, certificate, key, audit, 4444)

        def materialize_generation_peer(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
        ) -> SimpleNamespace:
            state = tmp_path / "generation-peer"
            state.mkdir()
            socket_path = state / "agent.sock"
            audit = state / "requests.jsonl"
            _write(audit, "")
            return SimpleNamespace(
                socket=socket_path,
                audit=audit,
                client_environment=lambda: {
                    "NEXUS_CODEX_AGENT_SOCKET": str(socket_path),
                },
            )

        def start_python_process(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _run: OwnedTestRun,
            role: str,
            *,
            overrides: Mapping[str, str] | None = None,
        ) -> StartedProcess:
            process_roles.append(role)
            process_overrides[role] = overrides
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
            *,
            tls_ca: Path | None = None,
        ) -> None:
            readiness_calls.append((_process.role, _endpoint, _path))
            if _endpoint in {
                runner.EndpointKind.PROVIDER_OPENAI,
                runner.EndpointKind.PROVIDER_API,
            }:
                assert tls_ca is not None
            return

        def wait_generation_peer_ready(
            self,
            _repo_root: Path,
            _environment: Mapping[str, str],
            _process: StartedProcess,
            _socket_path: Path,
        ) -> None:
            assert _socket_path == tmp_path / "generation-peer/agent.sock"
            generation_readiness_calls.append(_process.role)

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

        def grant_scenario_paid_entitlement(
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
    assert data_plane_resets == ["0123456789abcdef"]
    assert process_roles == [
        "external",
        "provider-api-peer",
        "provider-openai",
        "codex-generation-peer",
        "api",
        "worker-interactive",
        "worker-background",
        "web",
    ]
    assert readiness_calls == [
        ("external", runner.EndpointKind.EXTERNAL, "/livez"),
        ("provider-api-peer", runner.EndpointKind.PROVIDER_API, "/livez"),
        ("provider-openai", runner.EndpointKind.PROVIDER_OPENAI, "/livez"),
        ("api", runner.EndpointKind.API, "/readyz"),
        (
            "worker-interactive",
            runner.EndpointKind.AGENT_TOOLS_MCP,
            "/internal/agent-tools/mcp",
        ),
        ("web", runner.EndpointKind.WEB, "/login"),
    ]
    assert generation_readiness_calls == ["codex-generation-peer"]
    embedding_environment = {
        "BRAVE_SEARCH_API_KEY": "nexus-test-fixture-brave-key",
        "BRAVE_SEARCH_BASE_URL": "https://127.0.0.1:4443/res/v1",
        "NEXUS_TEST_STATIC_DNS": (
            '{"api.openai.com":{"address":"127.0.0.1","port":4443},"www.nasa.gov":"93.184.216.34"}'
        ),
        "NEXUS_TEST_TLS_CA_CERT": str(tmp_path / "embedding-peer/ca.pem"),
    }
    app_environment = {
        **embedding_environment,
        "NEXUS_CODEX_AGENT_SOCKET": str(tmp_path / "generation-peer/agent.sock"),
        "SYNAPSE_ENABLED": "false",
    }
    assert process_overrides == {
        "external": None,
        "provider-api-peer": None,
        "provider-openai": None,
        "codex-generation-peer": None,
        "api": app_environment,
        "worker-interactive": app_environment,
        "worker-background": app_environment,
    }
    assert invited_users == ["auth-session"]
    assert password_users == [
        "durable-ingest-reader-open",
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "password-recovery",
        "resource-share-boundary",
    ]
    assert entitlements == [
        "nexus+0123456789abcdef+durable-ingest-reader-open@example.invalid",
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
        "./e2e/journeys/durable-ingest-reader-open.journey.spec.ts",
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


def test_run_proof_executes_only_the_exact_service_node_and_refuses_missing_evidence(
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

    class Ports(_ReadyProtocolPorts):
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
        _available_storage=lambda _root, _docker: 16384,
    )

    assert result.evidence.status is RunStatus.FAIL
    # The external uv stub proves routing, not an executed pytest assertion.
    assert result.detail.startswith("proof_result=setup_or_execution_failure|")
    assert "pytest failure evidence is missing" in result.detail
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


def test_exact_deterministic_llm_eval_does_not_start_an_unowned_external_protocol(
    tmp_path: Path,
) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    proof = "python/tests/evals/test_owned.py"
    _write(tmp_path / proof, "def test_exact(): pass\n")
    environment = _stub_tools(tmp_path, "docker", "supabase", "uv")
    process_roles: list[str] = []
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
            assert not include_migration_database
            return _test_run(include_migration_database=False)

        def start_python_process(
            self,
            repo_root: Path,
            child_environment: Mapping[str, str],
            run: OwnedTestRun,
            role: str,
        ) -> StartedProcess:
            process_roles.append(role)
            return super().start_python_process(repo_root, child_environment, run, role)

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

        def run_environment(
            self,
            repo_root: Path,
            child_environment: Mapping[str, str],
            run: OwnedTestRun,
        ) -> dict[str, str]:
            return _stub_run_environment(repo_root, dict(child_environment), run)

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        f"pytest:{proof}::test_exact",
        environment,
        _ports=Ports(),
        _available_memory=lambda: 8192,
        _available_storage=lambda _root, _docker: 16384,
    )

    assert result.evidence.status is RunStatus.PASS
    assert process_roles == [], "a zero-network eval acquired an external listener"
    assert len(cleaned) == 1


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
        _available_storage=lambda _root, _docker: 16384,
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
        _available_storage=lambda _root, _docker: 16384,
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


def test_bounded_browser_failure_retains_its_testing_library_query_error() -> None:
    """A missing element is the most common browser red, and its query error is
    the whole diagnostic; past the output bound it has to survive on its own."""
    query_error = (
        "TestingLibraryElementError: Unable to find an accessible element with the "
        'role "button" and name "Retry upload"'
    )
    matcher_error = "expect(element).toBeVisible() failed"
    noise = "\n".join(
        f"stdout | ImportsWorkspace.browser.test.tsx > offers the retry > step {step}"
        for step in range(200)
    )
    captured = (
        f"{noise}\n"
        " FAIL  src/components/imports/ImportsWorkspace.browser.test.tsx > offers the retry\n"
        f"{query_error}\n"
        "Ignored nodes: comments, script, style\n"
        f"{matcher_error}\n"
        f"{noise}\n"
        " Test Files  1 failed (1)\n"
        "      Tests  1 failed | 16 passed (27)\n"
    )
    assert len(captured) > 1900, "the capture must exceed the bound this case is about"

    detail = runner._command_result_detail(
        1,
        subprocess.CompletedProcess(("bun", "run", "vitest"), 1, captured, ""),
    )

    assert query_error in detail, detail
    assert matcher_error in detail, detail
    assert "step 0" not in detail, "the bound still drops the reporter's own noise"


def test_bounded_capture_keeps_the_first_red_and_the_runner_summary() -> None:
    """The bound is a whole command's capture, not one test's: a browser file
    reds every case a removed control breaks. The fingerprint a registered fault
    is matched against is the first of those reds, and the runner's own summary
    line is what classifies the result, so both ends have to survive."""
    fingerprint = "the stranded upload stopped offering the retry it accepts"
    later_reds = "\n".join(
        "TestingLibraryElementError: Unable to find an accessible element with "
        f'the role "button" and name "Retry upload" in case {case}'
        for case in range(40)
    )
    captured = (
        " FAIL  src/components/imports/ImportsWorkspace.browser.test.tsx > offers the retry\n"
        f"AssertionError: {fingerprint}\n"
        f"{later_reds}\n"
        "      Tests  5 failed | 16 passed (27)\n"
    )

    bounded = runner._decisive_output(captured)

    assert len(bounded) <= 1900, "the bound still holds"
    assert fingerprint in bounded, bounded
    assert "Tests  5 failed" in bounded, bounded
    assert "in case 20" not in bounded, "the middle is what a full set gives up"


def test_exact_node_tap_assertion_retains_the_first_bounded_oracle() -> None:
    evidence = CapabilityEvidence(Capability.INGEST_NODE, RunStatus.FAIL, 1, 0)
    proof = "node-test:node/ingest/test/accepted_url_egress.test.mjs"
    first_oracle = "expected UnsafeDestination before any request; CLI returned Success"
    assertion_tap = (
        "TAP version 13\n"
        "# Subtest: public redirect to a private destination sends zero private requests\n"
        "not ok 1 - public redirect to a private destination sends zero private requests\n"
        "  ---\n"
        "  duration_ms: 12.5\n"
        "  type: 'test'\n"
        "  location: '/workspace/node/ingest/test/accepted_url_egress.test.mjs:261:1'\n"
        "  failureType: 'testCodeFailure'\n"
        "  error: |-\n"
        f"    {first_oracle}\n"
        "  code: 'ERR_ASSERTION'\n"
        "  name: 'AssertionError'\n"
        "  expected: 'Failure'\n"
        "  actual: 'Success'\n"
        "  operator: 'strictEqual'\n"
        "  stack: |-\n"
        "    TestContext.<anonymous> (accepted_url_egress.test.mjs:289:16)\n"
        "  ...\n"
        "# Subtest: later assertion\n"
        "not ok 2 - later assertion\n"
        "  ---\n"
        "  failureType: 'testCodeFailure'\n"
        "  error: 'later assertion must not replace the first oracle'\n"
        "  code: 'ERR_ASSERTION'\n"
        "  name: 'AssertionError'\n"
        "  ...\n" + "# trailing diagnostic\n" * 300
    )
    detail = runner._command_result_detail(
        1,
        subprocess.CompletedProcess(("node", "--test"), 1, assertion_tap, ""),
    )
    assertion = runner._classified_exact_result(CapabilityResult(evidence, detail), proof)

    timeout_tap = (
        "not ok 1 - bounded transport\n"
        "  ---\n"
        "  failureType: 'testTimeoutFailure'\n"
        "  error: 'test timed out after 100ms'\n"
        "  code: 'ERR_TEST_FAILURE'\n"
        "  ..."
    )
    timeout = runner._classified_exact_result(CapabilityResult(evidence, timeout_tap), proof)
    runtime_tap = (
        "not ok 1 - bounded transport\n"
        "  ---\n"
        "  failureType: 'testCodeFailure'\n"
        "  error: 'socket owner crashed'\n"
        "  code: 'ERR_TEST_FAILURE'\n"
        "  name: 'TypeError'\n"
        "  ..."
    )
    runtime = runner._classified_exact_result(CapabilityResult(evidence, runtime_tap), proof)

    assert len(detail) <= 2_000
    assert "not ok 1 - public redirect" in detail
    assert first_oracle in detail
    assert "later assertion must not replace the first oracle" not in detail
    assert assertion.detail.startswith("proof_result=behavioral_assertion_failure|")
    assert timeout.detail.startswith("proof_result=setup_or_execution_failure|")
    assert runtime.detail.startswith("proof_result=setup_or_execution_failure|")


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
        '<uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/>'
        '<application android:usesCleartextTraffic="false">'
        '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_VERSION" '
        'android:value="2"/>'
        '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256" '
        f'android:value="{"d" * 64}"/>'
        "<activity>"
        '<intent-filter android:autoVerify="true">'
        '<data android:scheme="https" android:host="nexus.nielseriknandal.com"/>'
        "</intent-filter></activity></application></manifest>"
    )

    expected_manifest = (
        "app.nexus.android",
        "42",
        "2.1",
        "nexus.nielseriknandal.com",
        "36",
        "2",
        "d" * 64,
    )
    manifest_result = subprocess.CompletedProcess(("apkanalyzer",), 0, manifest, "")

    assert runner._apksigner_certificate(completed) == certificate
    assert runner._release_manifest_facts(manifest) == expected_manifest
    assert runner._release_apk_contract_is_exact(
        signer=completed,
        manifest=manifest_result,
        expected_certificate=certificate,
        expected_manifest=expected_manifest,
    )
    assert not runner._release_apk_contract_is_exact(
        signer=completed,
        manifest=subprocess.CompletedProcess(
            ("apkanalyzer",),
            0,
            manifest.replace("d" * 64, "e" * 64),
            "",
        ),
        expected_certificate=certificate,
        expected_manifest=expected_manifest,
    )
    digest_metadata = (
        '<meta-data android:name="app.nexus.android.PLAYER_PROTOCOL_CONTRACT_SHA256" '
        f'android:value="{"d" * 64}"/>'
    )
    assert runner._release_manifest_facts(manifest.replace(digest_metadata, "")) is None
    assert (
        runner._release_manifest_facts(
            manifest.replace(digest_metadata, digest_metadata + digest_metadata)
        )
        is None
    )
    assert (
        runner._apksigner_certificate(
            subprocess.CompletedProcess(("apksigner",), 0, "unsigned", "")
        )
        is None
    )
    assert runner._release_manifest_facts(manifest.replace('"false"', '"true"')) is None
    assert (
        runner._release_manifest_facts(
            manifest.replace('targetSdkVersion="36"', 'targetSdkVersion="35"')
        )
        is None
    )
    assert runner._is_exact_https_origin("https://api.nielseriknandal.com")
    for invalid_origin in (
        "http://api.nielseriknandal.com",
        "https://user@api.nielseriknandal.com",
        "https://api.nielseriknandal.com/path",
        "https://api.nielseriknandal.com/",
    ):
        assert not runner._is_exact_https_origin(invalid_origin)


def test_android_tool_versions_and_installed_release_version_are_exact(
    tmp_path: Path,
) -> None:
    assert runner._android_tool_version("35.0.1-rc2") == (35, 0, 1, 2)
    assert runner._android_tool_version("preview") == (0,)
    adb = tmp_path / "sdk/adb"
    _write_executable(
        adb,
        stdout="  versionCode=41 minSdk=26 targetSdk=36\n",
    )

    assert (
        runner._installed_android_version_code(
            adb,
            "R5CT1234",
            tmp_path,
            _tool_environment(tmp_path),
        )
        == 41
    )


class _ApiCapacityPorts(runner._RunnerPorts):
    """Owns the capacity proof's local run and its Docker image boundary."""

    def __init__(self) -> None:
        self.run_ids: list[str] = []
        self.migration_databases: list[bool] = []
        self.docker: list[tuple[str, ...]] = []

    def prepare_run(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        *,
        run_id: str,
        include_migration_database: bool,
    ) -> OwnedTestRun:
        del environment
        self.run_ids.append(run_id)
        self.migration_databases.append(include_migration_database)
        claim_run(repo_root, {"NEXUS_ENV": "test"}, run_id)
        database = f"postgresql+psycopg://127.0.0.1:54321/nexus_run_{run_id}"
        migration = f"postgresql+psycopg://127.0.0.1:54321/nexus_migration_{run_id}"
        credentials = "?user=postgres&password=postgres"
        return OwnedTestRun(
            run_id=run_id,
            database_url=f"{database}{credentials}",
            migration_database_url=(
                f"{migration}{credentials}" if include_migration_database else None
            ),
            bucket=f"nexus-run-{run_id}",
            supabase=SupabaseCredentials(
                "http://127.0.0.1:54322",
                "anon-test-key",
                "admin-test-key",
            ),
        )

    def run_environment(
        self,
        repo_root: Path,
        environment: Mapping[str, str],
        run: OwnedTestRun,
    ) -> dict[str, str]:
        return _stub_run_environment(repo_root, dict(environment), run)

    def local_docker_host(self) -> str:
        return "unix:///test/docker.sock"

    def local_docker(self, arguments: Sequence[str]) -> str:
        self.docker.append(tuple(arguments))
        if tuple(arguments[:2]) == ("image", "ls"):
            return arguments[3].removeprefix("reference=") + "\n"
        return ""


def _write_api_capacity_repository(repo_root: Path) -> None:
    """The exact build inputs the capacity candidate image is digested from."""

    (repo_root / "python/.venv").mkdir(parents=True)
    _write(
        repo_root / "python/tests/capacity/test_api_reader_capacity.py",
        "def test_incident_reader_workload():\n    assert True\n\n"
        "def test_incident_artwork_overlap():\n    assert True\n\n"
        "def test_candidate_reader_admission_under_incident_overlap():\n    assert True\n\n"
        "def test_candidate_artwork_overlap():\n    assert True\n\n"
        "def test_candidate_metadata_overlap():\n    assert True\n\n"
        "def test_candidate_background_worker_overlap():\n    assert True\n",
    )
    for relative in (
        ".dockerignore",
        "docker/Dockerfile.backend",
        "python/pyproject.toml",
        "python/uv.lock",
        "python/README.md",
        "python/nexus/api/read_admission.py",
        "apps/api/main.py",
        "apps/worker/main.py",
        "apps/codex_agent/main.py",
        "migrations/0001_initial.sql",
        "scripts/oracle/manifest.json",
        "node/ingest/package.json",
        "node/ingest/bun.lock",
        "node/ingest/ingest.mjs",
        "node/ingest/accepted_url_egress.mjs",
        "node/reader/word_boundaries.mjs",
        "node/reader/epub_paths.mjs",
    ):
        _write(repo_root / relative, f"{relative}\n")
    _initialize_local_runtime(repo_root)


def _write_capacity_git(path: Path, *, sha: str, porcelain: str) -> None:
    """Answer `rev-parse` with one commit and `status --porcelain` verbatim."""

    _write(
        path,
        "#!/usr/bin/python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "record = {'tool': 'git', 'argv': sys.argv[1:], 'cwd': os.getcwd()}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n"
        f"sys.stdout.write(({sha!r} + '\\n') if sys.argv[1] == 'rev-parse' else {porcelain!r})\n"
        "raise SystemExit(0)\n",
    )
    path.chmod(0o755)


def _initialize_local_runtime(repo_root: Path) -> None:
    repo_root.mkdir(parents=True, exist_ok=True)
    initialize_runtime(repo_root, {"NEXUS_ENV": "test"}, RuntimePorts(*range(21001, 21014)))


def _changed_context(repo_root: Path, selection: Selection) -> CapabilityContext:
    return CapabilityContext(repo_root, Workflow.CHANGED, (selection,))


class _LocalDockerPorts(runner._RunnerPorts):
    def local_docker_host(self) -> str:
        return "unix:///test/docker.sock"


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


def _write_host_gradle(path: Path, xml: str | None, *, exit_status: int = 0) -> None:
    _write_executable(path, exit_status=exit_status)
    if xml is not None:
        output = (
            "report = Path('app/build/test-results/testDebugUnitTest/TEST-app.nexus.SampleTest.xml')\n"
            "report.parent.mkdir(parents=True, exist_ok=True)\n"
            f"report.write_text({xml!r})\n"
        )
        path.write_text(path.read_text().replace("raise SystemExit(", output + "raise SystemExit("))


def _write_executable(
    path: Path,
    *,
    stdout: str = "",
    stdout_by_subcommand: Mapping[str, str] | None = None,
    exit_status: int = 0,
    diagnostic: str = "",
) -> None:
    """Write a recording stand-in tool.

    `stdout_by_subcommand` answers by the first argument (for example
    `apkanalyzer manifest ...` versus `apkanalyzer dex ...`); any other
    invocation prints `stdout`.
    """
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
        "    'candidate_worker_image': "
        "os.environ.get('NEXUS_TEST_CANDIDATE_WORKER_IMAGE'),\n"
        "    'docker_host': os.environ.get('DOCKER_HOST'),\n"
        "    'docker_context': os.environ.get('DOCKER_CONTEXT'),\n"
        "    'android_serial': os.environ.get('ANDROID_SERIAL'),\n"
        "}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n"
        f"by_subcommand = {dict(stdout_by_subcommand or {})!r}\n"
        "subcommand = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        f"print(by_subcommand.get(subcommand, {stdout!r}))\n"
        f"print({diagnostic!r}, file=sys.stderr)\n"
        f"raise SystemExit({exit_status})\n",
    )
    path.chmod(0o755)


def _write_passthrough_env(path: Path) -> None:
    _write(
        path,
        "#!/usr/bin/python3\n"
        "import os\n"
        "import sys\n"
        "arguments = sys.argv[1:]\n"
        "while arguments and '=' in arguments[0]:\n"
        "    key, value = arguments.pop(0).split('=', 1)\n"
        "    os.environ[key] = value\n"
        "if not arguments:\n"
        "    raise SystemExit(125)\n"
        "os.execvpe(arguments[0], arguments, os.environ)\n",
    )
    path.chmod(0o755)


def _write_release_artifact_docker(
    path: Path,
    *,
    build_exit_status: int = 0,
    cleanup_exit_status: int = 0,
    diagnostic: str = "",
) -> None:
    _write(
        path,
        "#!/usr/bin/python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "arguments = sys.argv[1:]\n"
        "record = {\n"
        "    'tool': Path(sys.argv[0]).name,\n"
        "    'argv': arguments,\n"
        "    'cwd': os.getcwd(),\n"
        "    'environment': sorted(os.environ),\n"
        "    'candidate_worker_image': "
        "os.environ.get('NEXUS_TEST_CANDIDATE_WORKER_IMAGE'),\n"
        "    'docker_host': os.environ.get('DOCKER_HOST'),\n"
        "    'docker_context': os.environ.get('DOCKER_CONTEXT'),\n"
        "}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n"
        "if arguments[:2] == ['buildx', 'build']:\n"
        f"    print({diagnostic!r}, file=sys.stderr)\n"
        f"    if {build_exit_status} == 0:\n"
        "        iidfile = Path(arguments[arguments.index('--iidfile') + 1])\n"
        f"        iidfile.write_text({_CANDIDATE_WORKER_IMAGE_ID!r} + '\\n')\n"
        f"    raise SystemExit({build_exit_status})\n"
        "if arguments[:2] == ['image', 'rm']:\n"
        f"    raise SystemExit({cleanup_exit_status})\n"
        "raise SystemExit(99)\n",
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
        _available_storage=lambda _root, _docker: 16384,
    )

    static_web = next(item for item in evidence.capabilities if item.id is Capability.STATIC_WEB)
    assert static_web.status is RunStatus.PASS, static_web.detail
    invocations = [command["argv"] for command in _commands(tmp_path)]
    assert invocations == [["run", "lint:css-tokens"]], invocations
