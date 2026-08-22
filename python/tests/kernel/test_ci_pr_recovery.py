"""Behavior proof for exact manual pull-request CI recovery."""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Mapping
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[3]
WORKFLOW = REPO_ROOT / ".github/workflows/ci.yml"
REPOSITORY = "NielsdaWheelz/nexus-web"
PULL_REQUEST_NUMBER = "17"
SYNTHETIC_IDENTITY = {
    "GIT_AUTHOR_NAME": "Nexus CI",
    "GIT_AUTHOR_EMAIL": "ci@nexus.local",
    "GIT_COMMITTER_NAME": "Nexus CI",
    "GIT_COMMITTER_EMAIL": "ci@nexus.local",
}


def _step_script(name: str) -> str:
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    step = f"      - name: {name}"
    try:
        step_index = lines.index(step)
        run_index = next(
            index for index in range(step_index + 1, len(lines)) if lines[index] == "        run: |"
        )
    except (ValueError, StopIteration) as error:
        raise AssertionError(
            f"workflow step is absent or has no owned shell body: {name}"
        ) from error

    body: list[str] = []
    for line in lines[run_index + 1 :]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:] if line else "")
    if not body:
        raise AssertionError(f"workflow step has an empty shell body: {name}")
    return "\n".join(body) + "\n"


def _step_environment(name: str) -> dict[str, str]:
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    step = f"      - name: {name}"
    try:
        step_index = lines.index(step)
    except ValueError as error:
        raise AssertionError(f"workflow step is absent: {name}") from error

    environment: dict[str, str] = {}
    in_environment = False
    for line in lines[step_index + 1 :]:
        if line.startswith("      - ") or (
            line.startswith("  ") and not line.startswith("        ")
        ):
            break
        if line == "        env:":
            in_environment = True
            continue
        if in_environment and line.startswith("          "):
            key, separator, value = line[10:].partition(": ")
            if not separator or not key or not value:
                raise AssertionError(
                    f"workflow step has a non-literal environment entry: {name}: {line!r}"
                )
            environment[key] = value
            continue
        if in_environment:
            break
    return environment


def _git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ("git", *arguments),
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _pull_request_repository(tmp_path: Path) -> tuple[Path, str, str]:
    repository = tmp_path / "repository"
    repository.mkdir()
    _git(repository, "init", "--initial-branch=main")
    (repository / "base.txt").write_text("base\n", encoding="utf-8")
    _git(repository, "add", "base.txt")
    _git(
        repository,
        "-c",
        "user.name=Nexus test",
        "-c",
        "user.email=test@nexus.local",
        "commit",
        "--no-gpg-sign",
        "--message",
        "base",
    )
    base_sha = _git(repository, "rev-parse", "HEAD")

    _git(repository, "switch", "--create", "feature")
    (repository / "head.txt").write_text("head\n", encoding="utf-8")
    _git(repository, "add", "head.txt")
    _git(
        repository,
        "-c",
        "user.name=Nexus test",
        "-c",
        "user.email=test@nexus.local",
        "commit",
        "--no-gpg-sign",
        "--message",
        "head",
    )
    head_sha = _git(repository, "rev-parse", "HEAD")
    _git(repository, "update-ref", "refs/remotes/origin/main", base_sha)
    return repository, base_sha, head_sha


def _pull_request_payload(base_sha: str, head_sha: str) -> dict[str, object]:
    return {
        "number": int(PULL_REQUEST_NUMBER),
        "state": "open",
        "base": {
            "ref": "main",
            "sha": base_sha,
            "repo": {"full_name": REPOSITORY},
        },
        "head": {
            "sha": head_sha,
            "repo": {"full_name": REPOSITORY},
        },
    }


def _run_recovery(
    tmp_path: Path,
    repository: Path,
    payload: Mapping[str, object],
    *,
    base_sha: str,
    head_sha: str,
) -> subprocess.CompletedProcess[str]:
    commands = tmp_path / "commands"
    commands.mkdir(exist_ok=True)
    gh = commands / "gh"
    gh.write_text("#!/bin/sh\nprintf '%s\\n' \"$PR_RESPONSE\"\n", encoding="utf-8")
    gh.chmod(0o755)
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_", "GIT_CONFIG_")):
            environment.pop(key)
    environment.pop("EMAIL", None)
    environment.update(
        {
            "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "user.useConfigOnly",
            "GIT_CONFIG_VALUE_0": "true",
            "GH_TOKEN": "test-boundary-token",
            "GITHUB_REPOSITORY": REPOSITORY,
            "PR_NUMBER": PULL_REQUEST_NUMBER,
            "EXPECTED_BASE_SHA": base_sha,
            "EXPECTED_HEAD_SHA": head_sha,
            "PR_RESPONSE": json.dumps(payload, separators=(",", ":")),
            "RUNNER_TEMP": str(tmp_path),
        }
    )
    step_environment = _step_environment("Construct the exact PR merge")
    environment.update(
        {key: value for key, value in step_environment.items() if key in SYNTHETIC_IDENTITY}
    )
    return subprocess.run(
        ("bash", "-euo", "pipefail", "-c", _step_script("Construct the exact PR merge")),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )


def test_manual_recovery_constructs_one_merge_with_the_exact_verified_parents(
    tmp_path: Path,
) -> None:
    repository, base_sha, head_sha = _pull_request_repository(tmp_path)
    config_before = _git(repository, "config", "--local", "--list")
    head_timestamp = _git(repository, "show", "--no-patch", "--format=%cI", head_sha)

    completed = _run_recovery(
        tmp_path,
        repository,
        _pull_request_payload(base_sha, head_sha),
        base_sha=base_sha,
        head_sha=head_sha,
    )

    assert completed.returncode == 0, (
        "expected exact same-repository recovery to construct a merge; "
        f"stdout={completed.stdout!r}; stderr={completed.stderr!r}"
    )
    merge_sha, *parents = _git(repository, "rev-list", "--parents", "-n", "1", "HEAD").split()
    assert parents == [base_sha, head_sha], (
        "synthetic merge must bind only expected base then expected head; "
        f"merge={merge_sha}; parents={parents}"
    )
    assert (repository / "base.txt").read_text(encoding="utf-8") == "base\n"
    assert (repository / "head.txt").read_text(encoding="utf-8") == "head\n"
    identity = _git(
        repository,
        "show",
        "--no-patch",
        "--format=%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%cI",
        "HEAD",
    ).split("\0")
    assert identity == [
        "Nexus CI",
        "ci@nexus.local",
        "Nexus CI",
        "ci@nexus.local",
        head_timestamp,
        head_timestamp,
    ]
    assert _git(repository, "config", "--local", "--list") == config_before

    _git(repository, "checkout", "--detach", head_sha)
    replay = _run_recovery(
        tmp_path,
        repository,
        _pull_request_payload(base_sha, head_sha),
        base_sha=base_sha,
        head_sha=head_sha,
    )
    assert replay.returncode == 0, (
        "expected exact recovery replay to reconstruct the same merge; "
        f"stdout={replay.stdout!r}; stderr={replay.stderr!r}"
    )
    assert _git(repository, "rev-parse", "HEAD") == merge_sha


@pytest.mark.parametrize(
    ("path", "invalid_value"),
    [
        (("state",), "closed"),
        (("base", "ref"), "develop"),
        (("base", "repo", "full_name"), "someone/fork"),
        (("head", "repo", "full_name"), "someone/fork"),
        (("number",), PULL_REQUEST_NUMBER),
    ],
)
def test_manual_recovery_rejects_noncanonical_pull_request_identity_before_merge(
    tmp_path: Path, path: tuple[str, ...], invalid_value: object
) -> None:
    repository, base_sha, head_sha = _pull_request_repository(tmp_path)
    payload = _pull_request_payload(base_sha, head_sha)
    target: dict[str, object] = payload
    for key in path[:-1]:
        nested = target[key]
        assert isinstance(nested, dict)
        target = nested
    target[path[-1]] = invalid_value

    completed = _run_recovery(
        tmp_path,
        repository,
        payload,
        base_sha=base_sha,
        head_sha=head_sha,
    )

    assert completed.returncode != 0, (
        "recovery accepted a PR outside the exact open same-repository-to-main contract; "
        f"path={path}; value={invalid_value!r}; stdout={completed.stdout!r}; "
        f"stderr={completed.stderr!r}"
    )
    assert _git(repository, "rev-parse", "HEAD") == head_sha


def test_ci_routes_dispatch_only_to_exact_pr_recovery_and_keeps_full_on_main_push() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    dispatch = re.search(
        r"(?ms)^  workflow_dispatch:\n(?P<body>.*?)(?=^\S|^  [a-z])",
        workflow,
    )
    assert dispatch is not None
    dispatch_body = dispatch.group("body")
    for input_name in (
        "pull_request_number",
        "expected_head_sha",
        "expected_base_sha",
    ):
        assert re.search(
            rf"(?ms)^      {input_name}:\n.*?^        required: true$.*?^        type: string$",
            dispatch_body,
        ), f"workflow_dispatch must require canonical string input {input_name}"

    assert "permissions: {}" in workflow
    assert "pull-requests: read" in workflow
    assert workflow.count("run: ./scripts/test pr") == 1
    assert workflow.count("run: ./scripts/test full") == 1
    assert "github.event_name != 'workflow_dispatch'" not in workflow
    assert re.search(
        r"(?ms)^  pr:\n.*?^    if: github\.event_name == 'pull_request' "
        r"\|\| github\.event_name == 'workflow_dispatch'$"
        r".*?^      - name: Run the deterministic PR gate\n"
        r"        run: \./scripts/test pr$",
        workflow,
    )
    assert re.search(
        r"(?ms)^  candidate-full:\n.*?^    if: github\.event_name == 'push'$"
        r".*?^      - name: Run the candidate full gate\n        run: \./scripts/test full$",
        workflow,
    )
    recovery = _step_script("Construct the exact PR merge")
    step_environment = _step_environment("Construct the exact PR merge")
    assert {key: step_environment.get(key) for key in SYNTHETIC_IDENTITY} == (SYNTHETIC_IDENTITY)
    assert "git config" not in recovery
    for strict_fact in (
        "jq -e --slurp",
        '.[0].state == "open"',
        '.[0].base.ref == "main"',
        ".[0].base.repo.full_name == $repository",
        ".[0].head.repo.full_name == $repository",
        ".[0].base.sha == $base_sha",
        ".[0].head.sha == $head_sha",
        "refs/remotes/origin/main",
        "GIT_COMMITTER_DATE",
        "git rev-list --parents -n 1 HEAD",
    ):
        assert strict_fact in recovery
