"""Hydrate immutable external-suite inputs for offline test execution."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path


class SetupDependencyError(RuntimeError):
    """The local dependency source cannot satisfy the immutable test contract."""


@dataclass(frozen=True, slots=True)
class PinnedSuiteSource:
    package: str
    source_directory: str
    repository: str

    @property
    def marker_name(self) -> str:
        return f".nexus-{self.package}-revision"


@dataclass(frozen=True, slots=True)
class _SourceSnapshot:
    head: str
    symbolic_head: str
    refs: str
    status: str
    index_sha256: str
    tracked_sha256: str
    untracked_sha256: str


LLM_AGENT_KERNEL_SOURCE = PinnedSuiteSource(
    package="llm-agent-kernel",
    source_directory="llm-agent-kernel",
    repository="https://github.com/NielsdaWheelz/llm-agent-kernel.git",
)

PINNED_SUITE_SOURCES = (
    PinnedSuiteSource(
        package="provider-runtime",
        source_directory="llm-calling",
        repository="https://github.com/NielsdaWheelz/llm-calling.git",
    ),
    PinnedSuiteSource(
        package="llm-tools",
        source_directory="llm-tools",
        repository="https://github.com/NielsdaWheelz/llm-tools.git",
    ),
    LLM_AGENT_KERNEL_SOURCE,
)


def _run(
    argv: Sequence[str],
    *,
    cwd: Path,
    environment: Mapping[str, str],
    capture_output: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        tuple(argv),
        cwd=cwd,
        env=dict(environment),
        check=check,
        capture_output=capture_output,
        text=True,
    )


def _pinned_revision(repo_root: Path, package: str) -> str:
    try:
        project = tomllib.loads((repo_root / "python/pyproject.toml").read_text(encoding="utf-8"))
        revision = project["tool"]["uv"]["sources"][package]["rev"]
    except (KeyError, OSError, TypeError, tomllib.TOMLDecodeError) as error:
        raise SetupDependencyError(f"{package} pin is invalid or absent") from error
    if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise SetupDependencyError(f"{package} pin is not a full Git SHA")
    return revision


def _git_output(
    source: Path,
    args: Sequence[str],
    environment: Mapping[str, str],
) -> str:
    completed = _run(
        ("git", "-C", str(source), *args),
        cwd=source,
        environment=environment,
        capture_output=True,
    )
    return completed.stdout


def _optional_git_output(
    source: Path,
    args: Sequence[str],
    environment: Mapping[str, str],
) -> str:
    completed = _run(
        ("git", "-C", str(source), *args),
        cwd=source,
        environment=environment,
        capture_output=True,
        check=False,
    )
    if completed.returncode not in (0, 1):
        raise subprocess.CalledProcessError(
            completed.returncode,
            completed.args,
            completed.stdout,
            completed.stderr,
        )
    return completed.stdout


def _digest_path(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        digest.update(b"missing\0")
        return digest.hexdigest()
    digest.update(
        f"{stat.S_IFMT(metadata.st_mode):o}:{stat.S_IMODE(metadata.st_mode):o}\0".encode()
    )
    if stat.S_ISREG(metadata.st_mode):
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    elif stat.S_ISLNK(metadata.st_mode):
        digest.update(os.fsencode(os.readlink(path)))
    else:
        digest.update(b"unsupported")
    return digest.hexdigest()


def _digest_worktree_paths(
    source: Path,
    git_arguments: Sequence[str],
    environment: Mapping[str, str],
) -> str:
    paths = _git_output(source, git_arguments, environment).split("\0")
    digest = hashlib.sha256()
    for relative in paths:
        if not relative:
            continue
        encoded = os.fsencode(relative)
        digest.update(len(encoded).to_bytes(8, byteorder="big"))
        digest.update(encoded)
        digest.update(bytes.fromhex(_digest_path(source / relative)))
    return digest.hexdigest()


def _source_snapshot(source: Path, environment: Mapping[str, str]) -> _SourceSnapshot:
    index_value = _git_output(source, ("rev-parse", "--git-path", "index"), environment).strip()
    index_path = Path(index_value)
    if not index_path.is_absolute():
        index_path = source / index_path
    return _SourceSnapshot(
        head=_git_output(source, ("rev-parse", "HEAD"), environment),
        symbolic_head=_optional_git_output(source, ("symbolic-ref", "-q", "HEAD"), environment),
        refs=_git_output(source, ("show-ref", "--head", "--dereference"), environment),
        status=_git_output(
            source,
            (
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ),
            environment,
        ),
        index_sha256=_digest_path(index_path),
        tracked_sha256=_digest_worktree_paths(
            source,
            ("ls-files", "--cached", "-z"),
            environment,
        ),
        untracked_sha256=_digest_worktree_paths(
            source,
            ("ls-files", "--others", "--exclude-standard", "-z"),
            environment,
        ),
    )


def _has_commit(source: Path, revision: str, environment: Mapping[str, str]) -> bool:
    completed = _run(
        ("git", "-C", str(source), "cat-file", "-e", f"{revision}^{{commit}}"),
        cwd=source,
        environment=environment,
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0


def _hydrate_suite(
    repo_root: Path,
    suite: PinnedSuiteSource,
    environment: Mapping[str, str],
) -> None:
    revision = _pinned_revision(repo_root, suite.package)
    source = repo_root.parent / suite.source_directory
    if source.is_symlink() or not source.is_dir():
        raise SetupDependencyError(f"{suite.package} requires the adjacent Git checkout {source}")
    source = source.resolve(strict=True)
    try:
        source_root = Path(
            _git_output(source, ("rev-parse", "--show-toplevel"), environment).strip()
        ).resolve(strict=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SetupDependencyError(f"{source} is not a usable Git worktree") from error
    if source_root != source:
        raise SetupDependencyError(f"{source} is not the root of its Git worktree")

    try:
        before = _source_snapshot(source, environment)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SetupDependencyError(
            f"could not snapshot {suite.package} developer state before hydration"
        ) from error
    try:
        if not _has_commit(source, revision, environment):
            try:
                _run(
                    (
                        "git",
                        "-C",
                        str(source),
                        "fetch",
                        "--no-tags",
                        "--no-write-fetch-head",
                        "--no-auto-maintenance",
                        "--recurse-submodules=no",
                        suite.repository,
                        revision,
                    ),
                    cwd=source,
                    environment=environment,
                )
            except subprocess.CalledProcessError as error:
                raise SetupDependencyError(
                    f"could not fetch pinned {suite.package} commit {revision}"
                ) from error
        if not _has_commit(source, revision, environment):
            raise SetupDependencyError(f"pinned {suite.package} object is not a commit: {revision}")

        try:
            with tempfile.TemporaryDirectory(prefix="nexus-pinned-suite-") as temporary:
                temporary_root = Path(temporary)
                archive = temporary_root / "source.tar"
                hydrated_checkout = temporary_root / "hydrated-source"
                hydrated_checkout.mkdir(mode=0o700)
                _run(
                    (
                        "git",
                        "-C",
                        str(source),
                        "archive",
                        "--format=tar",
                        f"--output={archive}",
                        revision,
                    ),
                    cwd=source,
                    environment=environment,
                )
                with tarfile.open(archive, mode="r:") as bundle:
                    bundle.extractall(hydrated_checkout, filter="data")
                _run(
                    (
                        "uv",
                        "sync",
                        "--all-extras",
                        "--locked",
                        "--reinstall",
                        "--no-progress",
                        "--directory",
                        str(hydrated_checkout),
                    ),
                    cwd=repo_root,
                    environment=environment,
                )

                offline_checkout = temporary_root / "offline-source"
                offline_checkout.mkdir(mode=0o700)
                try:
                    with tarfile.open(archive, mode="r:") as bundle:
                        bundle.extractall(offline_checkout, filter="data")
                    _run(
                        (
                            "uv",
                            "sync",
                            "--all-extras",
                            "--locked",
                            "--offline",
                            "--no-editable",
                            "--reinstall-package",
                            suite.package,
                        ),
                        cwd=offline_checkout,
                        environment=environment,
                    )
                    if not (offline_checkout / ".venv").is_dir():
                        raise SetupDependencyError(
                            f"fresh offline {suite.package} materialization did not create a venv"
                        )
                except (OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
                    raise SetupDependencyError(
                        f"could not verify fresh offline {suite.package} materialization"
                    ) from error
        except (OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
            raise SetupDependencyError(
                f"could not hydrate locked {suite.package} artifacts at {revision}"
            ) from error
    finally:
        try:
            after = _source_snapshot(source, environment)
        except (OSError, subprocess.CalledProcessError) as error:
            raise SetupDependencyError(
                f"could not verify {suite.package} developer state after hydration"
            ) from error
        if after != before:
            raise SetupDependencyError(
                f"hydrating {suite.package} changed the adjacent developer worktree or refs"
            )
    print(f"Hydrated {suite.package} at {revision} for offline proof.")


def hydrate_pinned_python_suites(
    repo_root: Path,
    *,
    environment: Mapping[str, str] | None = None,
    suites: Sequence[PinnedSuiteSource] = PINNED_SUITE_SOURCES,
) -> None:
    if repo_root.is_symlink() or not repo_root.is_dir():
        raise SetupDependencyError("repository root must be a real directory")
    root = repo_root.resolve(strict=True)
    child_environment = dict(os.environ if environment is None else environment)
    path = child_environment.get("PATH")
    for command in ("git", "uv"):
        if shutil.which(command, path=path) is None:
            raise SetupDependencyError(f"{command} is required to hydrate pinned suites")
    for suite in suites:
        _hydrate_suite(root, suite, child_environment)


def _select_pinned_suites(suite_names: Sequence[str] | None) -> tuple[PinnedSuiteSource, ...]:
    if suite_names is None:
        return PINNED_SUITE_SOURCES
    if len(suite_names) != len(set(suite_names)):
        raise SetupDependencyError("each pinned suite may be selected only once")
    by_package = {suite.package: suite for suite in PINNED_SUITE_SOURCES}
    try:
        return tuple(by_package[name] for name in suite_names)
    except KeyError as error:
        raise SetupDependencyError(f"unknown pinned suite: {error.args[0]}") from error


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Hydrate exact external-suite artifacts for offline Nexus proof."
    )
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument(
        "--suite",
        action="append",
        choices=tuple(suite.package for suite in PINNED_SUITE_SOURCES),
        dest="suite_names",
        help="hydrate only this pinned suite; repeat to select multiple suites",
    )
    arguments = parser.parse_args(argv)
    try:
        suites = _select_pinned_suites(arguments.suite_names)
        hydrate_pinned_python_suites(arguments.repo_root, suites=suites)
    except SetupDependencyError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
