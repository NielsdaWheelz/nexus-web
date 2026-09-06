import os
import subprocess
from pathlib import Path

from nexus_test_control.runner import _ensure_provider_runtime_checkout


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
    state_root = tmp_path / "runtime-state"
    state_root.mkdir()
    (repo_root / ".nexus-test").symlink_to(state_root, target_is_directory=True)
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


def _write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
