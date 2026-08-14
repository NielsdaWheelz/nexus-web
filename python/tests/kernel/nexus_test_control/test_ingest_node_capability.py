from __future__ import annotations

import os
from pathlib import Path

from nexus_test_control.cli import _route_selection_for_workflow
from nexus_test_control.model import Capability, RunStatus, Workflow
from nexus_test_control.runner import CapabilityContext, run_capability
from nexus_test_control.selection import parse_git_name_status, select_changed

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_ingest_node_test_paths_defer_to_full_run_behind_loopback_guard_and_require_doctor_owner(
    tmp_path: Path,
) -> None:
    capability = Capability("ingest-node")
    path = "node/ingest/test/accepted_url_egress.test.mjs"
    selections = select_changed(parse_git_name_status(f"M\0{path}\0".encode()))

    owner = next(selection for selection in selections if selection.proof == f"node-test:{path}")
    assert owner.capability is capability
    deferred = _route_selection_for_workflow(Workflow.CHANGED, (owner,))
    assert deferred[0].deferred_to is Workflow.FULL
    setup = (REPO_ROOT / ".github/actions/setup-test/action.yml").read_text(encoding="utf-8")
    assert 'node-version: "22"' in setup
    assert "bun install --frozen-lockfile --cwd node/ingest" in setup

    repo_root = tmp_path / "nexus"
    _write(repo_root / path, "import test from 'node:test';\ntest('egress', () => {});\n")
    _write(repo_root / "node/ingest/package.json", '{"name":"nexus-ingest"}\n')
    _write(repo_root / "node/ingest/bun.lock", "lockfileVersion: 1\n")
    _write(repo_root / "python/tests/testkit/node-network-guard.mjs", "export {};\n")
    (repo_root / "node/ingest/node_modules").mkdir(parents=True)
    log = repo_root / "node.log"
    tools = tmp_path / "bin"
    _write(
        tools / "node",
        "#!/bin/sh\nset -eu\nprintf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\" >> '"
        + str(log)
        + "'\nprintf 'ARGV=%s\\n' \"$*\" >> '"
        + str(log)
        + "'\n",
    )
    (tools / "node").chmod(0o755)

    result = run_capability(
        CapabilityContext(repo_root, Workflow.FULL, (owner,)),
        capability,
        {
            "NODE_OPTIONS": "--inspect",
            "PATH": f"{tools}{os.pathsep}{os.environ['PATH']}",
        },
    )

    assert result.evidence.status is RunStatus.PASS
    inherited_node_options, command = log.read_text(encoding="utf-8").splitlines()
    assert inherited_node_options.startswith("NODE_OPTIONS=--import=")
    assert inherited_node_options.endswith("python/tests/testkit/node-network-guard.mjs")
    assert "--inspect" not in inherited_node_options
    assert command == f"ARGV=--test --test-concurrency=1 {path}"

    doctor_root = tmp_path / "doctor-nexus"
    _doctor_fixture(doctor_root, tools)
    missing = run_capability(
        CapabilityContext(doctor_root, Workflow.DOCTOR, ()),
        Capability.DOCTOR,
        {"PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
    )
    assert missing.evidence.status is RunStatus.NOT_RUN
    assert missing.detail == "locked tool owners are absent: node/ingest/node_modules"

    (doctor_root / "node/ingest/node_modules").mkdir(parents=True)
    ready = run_capability(
        CapabilityContext(doctor_root, Workflow.DOCTOR, ()),
        Capability.DOCTOR,
        {"PATH": f"{tools}{os.pathsep}{os.environ['PATH']}"},
    )
    assert ready.evidence.status is RunStatus.NOT_RUN
    assert ready.detail == "the Android SDK is absent"


def _doctor_fixture(repo_root: Path, tools: Path) -> None:
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
    ):
        _write(repo_root / path, "ready\n")
    _write(repo_root / "python/.venv/bin/python", "#!/bin/sh\nexit 0\n")
    (repo_root / "python/.venv/bin/python").chmod(0o755)
    for package, revision in (
        ("provider-runtime", provider_revision),
        ("llm-tools", llm_tools_revision),
    ):
        checkout = repo_root / ".nexus-test" / package / revision
        (checkout / ".venv").mkdir(parents=True)
        _write(checkout / f".nexus-{package}-revision", revision + "\n")
    for tool in ("actionlint", "bun", "docker", "git", "java", "supabase", "uv"):
        if (tools / tool).exists():
            continue
        _write(tools / tool, "#!/bin/sh\nexit 0\n")
        (tools / tool).chmod(0o755)


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
