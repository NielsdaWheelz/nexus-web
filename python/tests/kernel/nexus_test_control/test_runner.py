import json
from io import StringIO
from pathlib import Path

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
from nexus_test_control.runner import (
    CapabilityContext,
    CapabilityResult,
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


def test_doctor_is_not_run_when_its_locked_tool_owners_are_absent(tmp_path: Path) -> None:
    evidence = run_workflow(CapabilityContext(tmp_path, Workflow.DOCTOR, ()), StringIO(), {})

    assert evidence == (CapabilityEvidence(Capability.DOCTOR, RunStatus.NOT_RUN, 0, 0),)


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
        ["run", "test:unit", "--", "./src/example.unit.test.ts"],
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
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    _write(tmp_path / ".github/workflows/ci.yml", "name: CI\n")
    environment = _stub_tools(tmp_path, "actionlint", "bun", "uv")
    context = CapabilityContext(tmp_path, Workflow.CONFIDENCE, ())

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
    assert commands[8]["argv"][-1] == "../.github/workflows/ci.yml"
    assert commands[9]["argv"][-1] == "./tests/kernel/nexus_test_control/test_policy.py"
    assert commands[10]["argv"] == [
        "run",
        "test:unit",
        "--",
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
    checkout = tmp_path / "llm-calling"
    checkout.mkdir()
    (checkout / ".venv").mkdir()
    expected = "a" * 40
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f'provider-runtime = {{ git = "https://example.invalid/runtime", rev = "{expected}" }}\n',
    )
    environment = _stub_tools(repo_root, "uv", git_stdout=expected)
    context = CapabilityContext(repo_root, Workflow.FULL, ())

    result = run_capability(context, Capability.PROVIDER_RUNTIME, environment)

    assert result.evidence.status is RunStatus.PASS
    commands = _commands(repo_root)
    assert [command["tool"] for command in commands] == ["git", "uv", "uv", "uv", "uv"]
    assert commands[0]["argv"] == ["-C", str(checkout), "rev-parse", "HEAD"]
    assert commands[-1]["argv"] == ["run", "--frozen", "--no-sync", "pytest", "-q"]


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
    )

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[0]
    assert command["argv"] == [
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.class="
        "app.nexus.android.NativeAuthHandoffTest#"
        "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
    ]
    assert command["google_client_id"] == "nexus-test.apps.googleusercontent.com"


def test_missing_tool_is_not_run_and_command_failure_records_its_exit_status(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/example.unit.test.ts", "export {};\n")
    context = CapabilityContext(tmp_path, Workflow.CONFIDENCE, ())

    missing = run_capability(context, Capability.KERNEL_WEB, {"PATH": str(tmp_path)})
    assert missing.evidence.status is RunStatus.NOT_RUN

    environment = _stub_tools(tmp_path, "bun", exit_status=7, diagnostic="token=hidden-value")
    failed = run_capability(context, Capability.KERNEL_WEB, environment)
    assert failed.evidence.status is RunStatus.FAIL
    assert "exited 7" in failed.detail

    stream = StringIO()
    tuple(stream_first_failure((failed,), stream, ("hidden-value",)))
    assert stream.getvalue() == "kernel-web: fixed command 1 exited 7: token=[REDACTED]\n"


def test_heavy_capability_remains_truthfully_not_run() -> None:
    context = CapabilityContext(Path.cwd(), Workflow.FULL, ())

    result = run_capability(context, Capability.SERVICE)

    assert result.evidence == CapabilityEvidence(Capability.SERVICE, RunStatus.NOT_RUN, 0, 0)


def test_affected_heavy_proofs_share_one_workflow_run_and_request_migrations_only_when_selected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "python/.venv").mkdir(parents=True)
    _write(tmp_path / "python/tests/service/test_owned.py", "def test_owned(): pass\n")
    _write(tmp_path / "python/tests/migrations/test_owned.py", "def test_owned(): pass\n")
    _write(tmp_path / "apps/web/package.json", "{}\n")
    (tmp_path / "apps/web/node_modules").mkdir()
    _write(tmp_path / "apps/web/src/owned.browser.test.ts", "export {};\n")
    environment = _stub_tools(tmp_path, "bun", "docker", "supabase", "uv")
    prepared: list[bool] = []
    cleaned: list[str] = []

    def prepare(
        repo_root: Path,
        child_environment: dict[str, str],
        *,
        include_migration_database: bool,
    ) -> OwnedTestRun:
        assert repo_root == tmp_path
        assert child_environment["NEXUS_ENV"] == "test"
        prepared.append(include_migration_database)
        return _test_run(include_migration_database=include_migration_database)

    monkeypatch.setattr(runner, "prepare_run", prepare)
    monkeypatch.setattr(runner, "clean_run", lambda *_args, **_kwargs: cleaned.append("run"))
    monkeypatch.setattr(runner, "run_environment", _stub_run_environment)
    monkeypatch.setattr(runner, "_browser_installed", lambda *_args: True)
    context = CapabilityContext(
        tmp_path,
        Workflow.CHANGED,
        (
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

    evidence = run_workflow(context, StringIO(), environment)

    assert prepared == [True]
    assert cleaned == ["run"]
    by_capability = {item.id: item.status for item in evidence}
    assert by_capability[Capability.SERVICE] is RunStatus.PASS
    assert by_capability[Capability.MIGRATIONS] is RunStatus.PASS
    assert by_capability[Capability.COMPONENT] is RunStatus.PASS
    commands = _commands(tmp_path)
    assert [command["argv"] for command in commands] == [
        ["run", "eslint", "--max-warnings", "0", "./src/owned.browser.test.ts"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "tests/service/test_owned.py",
        ],
        ["run", "test:browser", "--", "./src/owned.browser.test.ts"],
        [
            "run",
            "--frozen",
            "--no-sync",
            "pytest",
            "tests/migrations/test_owned.py",
        ],
    ]
    assert all(
        "DATABASE_URL" in command["environment"] and "NEXUS_TEST_RUN_ID" in command["environment"]
        for command in (commands[1], commands[3])
    )
    assert "DATABASE_URL" not in commands[2]["environment"]
    assert "NEXUS_TEST_RUN_ID" in commands[2]["environment"]


def test_affected_heavy_capabilities_with_no_selection_do_not_prepare_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        runner,
        "prepare_run",
        lambda *_args, **_kwargs: pytest.fail("empty affected proof prepared a local run"),
    )

    run_workflow(CapabilityContext(tmp_path, Workflow.CHANGED, ()), StringIO(), {})


def test_bundle_is_built_once_and_critical_journeys_consume_ledger_owned_processes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    web_root = tmp_path / "apps/web"
    _write(web_root / "package.json", "{}\n")
    (web_root / "node_modules").mkdir()
    for journey_id in (
        "auth-session",
        "grounded-chat-citation",
        "nexus-search-open-restore",
        "not-critical",
        "resource-share-boundary",
    ):
        _write(
            web_root / f"e2e/journeys/{journey_id}.journey.spec.ts",
            f'test.use({{ journeyId: "{journey_id}" }});\n',
        )
    environment = _stub_tools(tmp_path, "bun")
    execution = runner._WorkflowExecution(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        environment,
        include_migration_database=True,
        run=_test_run(include_migration_database=True),
    )
    build_calls: list[str] = []
    process_roles: list[str] = []
    users: list[str] = []
    entitlements: list[str] = []
    artifact = tmp_path / ".nexus-test/builds/fingerprint"
    _write(artifact / "server.js", "export {};\n")

    def build(*_args: object) -> StandaloneBuild:
        build_calls.append("build")
        return StandaloneBuild("a" * 64, artifact, artifact / "server.js")

    def start_python(*_args: object) -> StartedProcess:
        role = str(_args[-1])
        process_roles.append(role)
        return StartedProcess(role, len(process_roles) + 100, f"{role}.log")

    def start_web(*_args: object) -> StartedProcess:
        process_roles.append("web")
        return StartedProcess("web", 200, "web.log")

    def create_user(
        _root: Path,
        _environment: dict[str, str],
        _run_id: str,
        scenario_id: str,
        _credentials: SupabaseCredentials,
    ) -> OwnedTestUser:
        users.append(scenario_id)
        return OwnedTestUser(
            "00000000-0000-4000-8000-000000000001",
            f"nexus+0123456789abcdef+{scenario_id}@example.invalid",
            "test-password",
        )

    monkeypatch.setattr(runner, "ensure_standalone_build", build)
    monkeypatch.setattr(runner, "_browser_installed", lambda *_args: True)
    monkeypatch.setattr(runner, "run_environment", _stub_run_environment)
    monkeypatch.setattr(runner, "start_python_process", start_python)
    monkeypatch.setattr(runner, "start_web_process", start_web)
    monkeypatch.setattr(runner, "wait_process_ready", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "create_supabase_user", create_user)
    monkeypatch.setattr(
        runner,
        "grant_scenario_ai_entitlement",
        lambda _root, _environment, _run, user: entitlements.append(user.email),
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
    assert process_roles == ["api", "worker-interactive", "worker-background", "web"]
    assert users == [
        "auth-session",
        "grounded-chat-citation",
        "nexus-search-open-restore",
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
        "--config",
        "e2e/playwright.config.ts",
        "--workers=1",
        "--retries=0",
        "./e2e/journeys/auth-session.journey.spec.ts",
        "./e2e/journeys/grounded-chat-citation.journey.spec.ts",
        "./e2e/journeys/nexus-search-open-restore.journey.spec.ts",
        "./e2e/journeys/resource-share-boundary.journey.spec.ts",
    ]
    assert "NEXUS_TEST_SCENARIO_USERS" in command["environment"]
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
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

    def prepare(
        _root: Path,
        _environment: dict[str, str],
        *,
        include_migration_database: bool,
    ) -> OwnedTestRun:
        prepared.append(include_migration_database)
        return _test_run(include_migration_database=include_migration_database)

    monkeypatch.setattr(runner, "prepare_run", prepare)
    monkeypatch.setattr(runner, "run_environment", _stub_run_environment)
    monkeypatch.setattr(runner, "clean_run", lambda *_args, **_kwargs: cleaned.append("run"))

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.PR, ()),
        f"pytest:{proof}::test_exact",
        environment,
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
        "tests/service/test_owned.py::test_exact",
    ]


def test_run_proof_rejects_missing_or_inexact_browser_nodes_without_preparing_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "apps/web/src/owned.browser.test.ts", "export {};\n")
    monkeypatch.setattr(
        runner,
        "prepare_run",
        lambda *_args, **_kwargs: pytest.fail("invalid exact proof prepared a local run"),
    )
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


def test_exact_proof_failure_kinds_are_stable_and_setup_assertions_are_not_behavioral() -> None:
    evidence = CapabilityEvidence(Capability.SERVICE, RunStatus.FAIL, 1, 0)

    collection = runner._classified_exact_result(
        CapabilityResult(evidence, "ERROR collecting tests/service/test_owned.py")
    )
    setup = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "ERROR at setup of test_exact AssertionError: fixture invariant",
        )
    )
    assertion = runner._classified_exact_result(
        CapabilityResult(
            evidence,
            "FAILED tests/service/test_owned.py::test_exact - AssertionError: property",
        )
    )

    assert collection.detail.startswith("proof_result=collection_failure|")
    assert setup.detail.startswith("proof_result=setup_or_execution_failure|")
    assert assertion.detail.startswith("proof_result=behavioral_assertion_failure|")


def test_first_failure_streams_before_later_results_and_redacts_secrets() -> None:
    stream = StringIO()

    def results():
        yield CapabilityResult(
            CapabilityEvidence(Capability.POLICY, RunStatus.FAIL, 1, 0),
            "token=hidden-value",
        )
        assert stream.getvalue() == "policy: token=[REDACTED]\n"
        yield CapabilityResult(
            CapabilityEvidence(Capability.STATIC_PYTHON, RunStatus.FAIL, 1, 0),
            "later failure",
        )

    observed = tuple(stream_first_failure(results(), stream, ("hidden-value",)))

    assert len(observed) == 2
    assert stream.getvalue() == "policy: token=[REDACTED]\n"


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
        bucket="nexus-test-0123456789abcdef",
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
