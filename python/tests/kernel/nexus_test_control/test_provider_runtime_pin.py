import os
import subprocess
from pathlib import Path

import pytest

from nexus_test_control.runner import _ensure_provider_runtime_checkout
from nexus_test_control.setup_dependencies import (
    PinnedSuiteSource,
    SetupDependencyError,
    hydrate_pinned_python_suites,
)


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


def test_local_setup_fetches_and_hydrates_pin_without_retargeting_dirty_source(
    tmp_path: Path,
) -> None:
    remote = tmp_path / "provider-remote"
    remote.mkdir()
    _run_git(remote, "init", "-q")
    _write(remote / "pyproject.toml", "[project]\nname='provider-runtime'\nversion='1'\n")
    _write(remote / "uv.lock", "version = 1\nrevision = 1\nrequires-python = '>=3.12'\n")
    _write(remote / "contract.txt", "pinned\n")
    _commit(remote, "pinned")
    revision = _run_git(remote, "rev-parse", "HEAD").stdout.strip()

    source = tmp_path / "llm-calling"
    source.mkdir()
    _run_git(source, "init", "-q")
    _write(source / "developer.txt", "current developer state\n")
    _commit(source, "developer")
    _write(source / "developer.txt", "tracked local edit\n")
    _write(source / "untracked.txt", "preserve me\n")
    before_head = _run_git(source, "rev-parse", "HEAD").stdout
    before_refs = _run_git(source, "show-ref", "--head", "--dereference").stdout
    before_status = _run_git(source, "status", "--porcelain=v1", "--untracked-files=all").stdout

    repo_root = tmp_path / "nexus"
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"provider-runtime = {{ git = 'https://example.invalid/provider', rev = '{revision}' }}\n",
    )
    tools = tmp_path / "bin"
    log = tmp_path / "uv.log"
    _write(
        tools / "uv",
        "#!/bin/sh\n"
        "set -eu\n"
        "directory=''\n"
        'while [ "$#" -gt 0 ]; do\n'
        '  if [ "$1" = --directory ]; then directory="$2"; shift 2; else shift; fi\n'
        "done\n"
        'test -n "$directory"\n'
        f'cat "$directory/contract.txt" >> {log}\n',
    )
    (tools / "uv").chmod(0o755)
    environment = dict(os.environ)
    environment["PATH"] = f"{tools}{os.pathsep}{environment['PATH']}"

    hydrate_pinned_python_suites(
        repo_root,
        environment=environment,
        suites=(
            PinnedSuiteSource(
                package="provider-runtime",
                source_directory="llm-calling",
                repository=str(remote),
            ),
        ),
    )

    assert _run_git(source, "cat-file", "-t", revision).stdout.strip() == "commit"
    assert _run_git(source, "rev-parse", "HEAD").stdout == before_head
    assert _run_git(source, "show-ref", "--head", "--dereference").stdout == before_refs
    assert (
        _run_git(source, "status", "--porcelain=v1", "--untracked-files=all").stdout
        == before_status
    )
    assert (source / "developer.txt").read_text(encoding="utf-8") == "tracked local edit\n"
    assert (source / "untracked.txt").read_text(encoding="utf-8") == "preserve me\n"
    assert log.read_text(encoding="utf-8") == "pinned\n"


def test_local_setup_checks_developer_state_even_when_hydration_fails(
    tmp_path: Path,
) -> None:
    remote = tmp_path / "provider-remote"
    remote.mkdir()
    _run_git(remote, "init", "-q")
    _write(remote / "pyproject.toml", "[project]\nname='provider-runtime'\nversion='1'\n")
    _write(remote / "uv.lock", "version = 1\nrevision = 1\nrequires-python = '>=3.12'\n")
    _commit(remote, "pinned")
    revision = _run_git(remote, "rev-parse", "HEAD").stdout.strip()

    _run_git(tmp_path, "clone", "-q", str(remote), "llm-calling")
    source = tmp_path / "llm-calling"
    developer_file = source / "pyproject.toml"
    untracked_file = source / "notes.txt"
    _write(developer_file, "existing tracked edit\n")
    _write(untracked_file, "existing untracked edit\n")
    repo_root = tmp_path / "nexus"
    _write(
        repo_root / "python/pyproject.toml",
        "[tool.uv.sources]\n"
        f"provider-runtime = {{ git = 'https://example.invalid/provider', rev = '{revision}' }}\n",
    )
    tools = tmp_path / "bin"
    _write(
        tools / "uv",
        "#!/bin/sh\n"
        "set -eu\n"
        "printf 'mutated by failed hydration\\n' > \"$NEXUS_TEST_MUTATION_TARGET\"\n"
        "printf 'mutated untracked file\\n' > \"$NEXUS_TEST_UNTRACKED_TARGET\"\n"
        "exit 17\n",
    )
    (tools / "uv").chmod(0o755)
    environment = dict(os.environ)
    environment["PATH"] = f"{tools}{os.pathsep}{environment['PATH']}"
    environment["NEXUS_TEST_MUTATION_TARGET"] = str(developer_file)
    environment["NEXUS_TEST_UNTRACKED_TARGET"] = str(untracked_file)

    with pytest.raises(
        SetupDependencyError,
        match="changed the adjacent developer worktree or refs",
    ):
        hydrate_pinned_python_suites(
            repo_root,
            environment=environment,
            suites=(
                PinnedSuiteSource(
                    package="provider-runtime",
                    source_directory="llm-calling",
                    repository=str(remote),
                ),
            ),
        )


def _run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *args),
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def _commit(repo: Path, message: str) -> None:
    _run_git(repo, "add", ".")
    _run_git(
        repo,
        "-c",
        "user.name=Nexus Test",
        "-c",
        "user.email=nexus-test@example.invalid",
        "commit",
        "-q",
        "-m",
        message,
    )


def _write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
