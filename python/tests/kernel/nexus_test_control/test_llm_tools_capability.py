import os
import subprocess
from pathlib import Path

from nexus_test_control.cli import _route_selection_for_workflow
from nexus_test_control.model import Capability, RunStatus, Workflow
from nexus_test_control.runner import (
    CapabilityContext,
    _ensure_llm_tools_checkout,
    run_capability,
)
from nexus_test_control.selection import parse_git_name_status, select_changed

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_full_and_higher_ci_prepare_the_pinned_llm_tools_object_source() -> None:
    setup = (REPO_ROOT / ".github/actions/setup-test/action.yml").read_text(encoding="utf-8")

    assert "llm-tools:" in setup
    assert "inputs.llm-tools == 'true'" in setup
    assert "https://github.com/NielsdaWheelz/llm-tools.git" in setup
    assert 'test "$(git -C "$checkout" rev-parse HEAD)" = "$revision"' in setup
    assert "-m nexus_test_control.setup_dependencies" in setup
    assert 'prepared_suites+=(--suite "$package")' in setup
    for path in (
        ".github/workflows/ci.yml",
        ".github/workflows/nightly.yml",
        ".github/workflows/release.yml",
    ):
        workflow = (REPO_ROOT / path).read_text(encoding="utf-8")
        assert 'llm-tools: "true"' in workflow


def test_llm_tools_paths_route_to_exact_full_materialization(tmp_path: Path) -> None:
    path = "python/tests/llm_tools_contract/test_pinned_llm_tools.py"
    selections = select_changed(parse_git_name_status(f"M\0{path}\0".encode()))

    owner = next(selection for selection in selections if selection.proof == f"pytest:{path}")
    assert owner.capability is Capability.LLM_TOOLS
    assert Capability.LLM_TOOLS is not Capability.PROVIDER_RUNTIME
    deferred = _route_selection_for_workflow(Workflow.CHANGED, (owner,))
    assert deferred[0].deferred_to is Workflow.FULL

    repo_root = tmp_path / "nexus"
    source = tmp_path / "llm-tools"
    source.mkdir()
    _git(source, "init", "-q")
    _write(source / "pyproject.toml", "[project]\nname='llm-tools'\nversion='1'\n")
    _write(source / "uv.lock", "version = 1\nrevision = 1\nrequires-python = '>=3.12'\n")
    _write(source / "contract.txt", "pinned\n")
    _git(source, "add", ".")
    _git(
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
    revision = _git(source, "rev-parse", "HEAD").stdout.strip()
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"llm-tools = {{ git = 'https://example.invalid/llm-tools', rev = '{revision}' }}\n",
    )
    (repo_root / "python/.venv").mkdir(parents=True)
    _write(repo_root / path, "def test_pinned_llm_tools():\n    assert True\n")
    log = repo_root / "uv.log"
    tools = tmp_path / "bin"
    _write(
        tools / "uv",
        "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$*\" >> '" + str(log) + "'\n"
        'if [ "$1" = sync ]; then mkdir -p .venv/bin; fi\n',
    )
    (tools / "uv").chmod(0o755)

    result = run_capability(
        CapabilityContext(repo_root, Workflow.FULL, ()),
        Capability.LLM_TOOLS,
        {"PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
    )

    assert result.evidence.status is RunStatus.PASS
    checkout = repo_root / ".nexus-test/llm-tools" / revision
    assert (checkout / ".nexus-llm-tools-revision").read_text().strip() == revision
    assert (checkout / "contract.txt").read_text() == "pinned\n"
    _write(source / "contract.txt", "developer-head\n")
    assert (checkout / "contract.txt").read_text() == "pinned\n"
    assert log.read_text().splitlines() == [
        "run --frozen --no-sync pytest --maxfail=1 -p no:randomly ./tests/llm_tools_contract/test_pinned_llm_tools.py",
        "sync --all-extras --locked --offline --no-editable --reinstall-package llm-tools",
        "run --frozen --no-sync ruff check src tests",
        "run --frozen --no-sync ruff format --check src tests",
        "run --frozen --no-sync pyright src tests",
        "run --frozen --no-sync pytest --maxfail=1 -q -p no:randomly",
        "build --no-sources --offline",
    ]
    _git(source, "add", "contract.txt")
    _git(
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
    second_repo = tmp_path / "second-nexus"
    _write(
        second_repo / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"llm-tools = {{ git = 'https://example.invalid/llm-tools', rev = '{revision}' }}\n",
    )
    second_checkout = _ensure_llm_tools_checkout(
        second_repo,
        {"PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
    )
    assert (second_checkout / "contract.txt").read_text() == "pinned\n", (
        "llm-tools materialization followed developer HEAD instead of the lock pin"
    )
    _assert_doctor_checks_llm_tools_checkout(tmp_path, tools)


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(("git", *args), cwd=cwd, check=True, capture_output=True, text=True)


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _assert_doctor_checks_llm_tools_checkout(tmp_path: Path, tools: Path) -> None:
    repo_root = tmp_path / "doctor-nexus"
    provider_revision = "b" * 40
    llm_tools_revision = "c" * 40
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"provider-runtime = {{ git = 'https://example.invalid/provider', rev = '{provider_revision}' }}\n"
        f"llm-tools = {{ git = 'https://example.invalid/llm-tools', rev = '{llm_tools_revision}' }}\n",
    )
    for path in (
        "python/uv.lock",
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/node_modules/.ready",
        "apps/web/e2e/playwright.config.ts",
        "apps/android/gradlew",
        "node/ingest/package.json",
        "node/ingest/bun.lock",
        "node/ingest/node_modules/.ready",
    ):
        _write(repo_root / path, "ready\n")
    _write(repo_root / "python/.venv/bin/python", "#!/bin/sh\nexit 0\n")
    (repo_root / "python/.venv/bin/python").chmod(0o755)
    provider_checkout = repo_root / ".nexus-test/provider-runtime" / provider_revision
    (provider_checkout / ".venv").mkdir(parents=True)
    _write(provider_checkout / ".nexus-provider-runtime-revision", provider_revision + "\n")
    for tool in ("actionlint", "bun", "docker", "java", "supabase"):
        _write(tools / tool, "#!/bin/sh\nexit 0\n")
        (tools / tool).chmod(0o755)
    environment = {"PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"}
    context = CapabilityContext(repo_root, Workflow.DOCTOR, ())

    missing = run_capability(context, Capability.DOCTOR, environment)

    assert missing.evidence.status is RunStatus.NOT_RUN
    assert missing.detail == "pinned llm-tools checkout is unavailable"
    llm_tools_checkout = repo_root / ".nexus-test/llm-tools" / llm_tools_revision
    (llm_tools_checkout / ".venv").mkdir(parents=True)
    _write(llm_tools_checkout / ".nexus-llm-tools-revision", llm_tools_revision + "\n")

    ready = run_capability(context, Capability.DOCTOR, environment)

    assert ready.evidence.status is RunStatus.NOT_RUN
    assert ready.detail == "the Android SDK is absent"
