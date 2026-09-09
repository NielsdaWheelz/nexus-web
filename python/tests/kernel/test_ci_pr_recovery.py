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
CI_ARTIFACT_OWNER = REPO_ROOT / "scripts/ci-proof-artifact.sh"
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


def _ci_artifact_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "artifact-repository"
    repository.mkdir()
    _git(repository, "init", "--initial-branch=main")
    (repository / ".gitignore").write_text("/test-results/\n", encoding="utf-8")
    test_entrypoint = repository / "scripts/test"
    test_entrypoint.parent.mkdir()
    test_entrypoint.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'run_directory="test-results/runs/${FAKE_RUN_ID}"\n'
        'mkdir -p -- "$run_directory"\n'
        'printf \'%s\\n\' "$*" >"$run_directory/invocation.txt"\n'
        "printf 'hidden\\n' >\"$run_directory/.hidden-evidence\"\n"
        'git_sha="$(git rev-parse HEAD)"\n'
        'status="pass"\n'
        'if [ "${FAKE_TEST_STATUS:-0}" -ne 0 ]; then status="fail"; fi\n'
        "printf '{}\\n' >\"$run_directory/run-context.json\"\n"
        "printf "
        '\'{"git_sha":"%s","run_context_artifact":'
        '"test-results/runs/%s/run-context.json","run_id":"%s",'
        '"status":"%s","version":3,"workflow":"%s"}\\n\' '
        '"$git_sha" "$FAKE_RUN_ID" "$FAKE_RUN_ID" "$status" "$1" '
        '>"$run_directory/summary.json"\n'
        'if [ -n "${FAKE_TRAILING_SUMMARY:-}" ]; then\n'
        "  printf '{}\\n' >>\"$run_directory/summary.json\"\n"
        "fi\n"
        'if [ -n "${FAKE_RUN_SYMLINK:-}" ]; then\n'
        '  ln -s -- /dev/null "$run_directory/foreign-link"\n'
        "fi\n"
        'if [ -n "${FAKE_SECOND_RUN_ID:-}" ]; then\n'
        '  mkdir -p -- "test-results/runs/${FAKE_SECOND_RUN_ID}"\n'
        "fi\n"
        'exit "${FAKE_TEST_STATUS:-0}"\n',
        encoding="utf-8",
    )
    test_entrypoint.chmod(0o755)
    _git(repository, "add", ".gitignore", "scripts/test")
    _git(
        repository,
        "-c",
        "user.name=Nexus test",
        "-c",
        "user.email=test@nexus.local",
        "commit",
        "--no-gpg-sign",
        "--message",
        "fixture",
    )
    return repository


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
    assert (
        workflow.count(
            'run: scripts/ci-proof-artifact.sh run changed --base "$NEXUS_TEST_BASE_SHA"'
        )
        == 1
    )
    assert workflow.count("run: scripts/ci-proof-artifact.sh run full") == 1
    assert "github.event_name != 'workflow_dispatch'" not in workflow
    assert re.search(
        r"(?ms)^  pr:\n.*?^    if: github\.event_name == 'pull_request' "
        r"\|\| github\.event_name == 'workflow_dispatch'$"
        r".*?^      - name: Run the changed proof\n"
        r"        id: proof\n"
        r"        shell: bash\n"
        r'        run: scripts/ci-proof-artifact\.sh run changed --base "\$NEXUS_TEST_BASE_SHA"$',
        workflow,
    )
    assert re.search(
        r"(?ms)^  candidate-full:\n.*?^    if: github\.event_name == 'push'$"
        r".*?^      - name: Run the candidate full gate\n"
        r"        id: proof\n"
        r"        shell: bash\n"
        r"        run: scripts/ci-proof-artifact\.sh run full$",
        workflow,
    )
    assert workflow.count("id: proof") == 2
    assert workflow.count("path: ${{ steps.proof.outputs.path }}/") == 2
    assert workflow.count("if-no-files-found: error") >= 2
    assert workflow.count("include-hidden-files: true") == 2
    assert "path: test-results/" not in workflow
    assert workflow.count('scripts/ci-proof-artifact.sh cleanup "$NEXUS_CI_EVIDENCE_PATH"') == 2
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


@pytest.mark.parametrize("test_status", (0, 17))
def test_ci_artifact_owner_stages_only_the_run_claimed_by_this_invocation(
    tmp_path: Path,
    test_status: int,
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    old_run = repository / "test-results/runs/1111111111111111"
    old_run.mkdir(parents=True)
    (old_run / "summary.json").write_text('{"status":"not_run"}\n', encoding="utf-8")
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_RUN_ID": "2222222222222222",
        "FAKE_TEST_STATUS": str(test_status),
        "GITHUB_OUTPUT": str(github_output),
        "GITHUB_WORKSPACE": str(repository),
        "RUNNER_TEMP": str(runner_temp),
    }

    completed = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "run", "full"),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == test_status, completed.stderr
    assert completed.stdout == ""
    assert completed.stderr == ""
    output = github_output.read_text(encoding="utf-8")
    assert output.startswith("path=") and output.endswith("\n") and output.count("\n") == 1
    evidence_workspace = Path(output.removeprefix("path=").strip())
    assert evidence_workspace.parent == runner_temp
    assert evidence_workspace.name.startswith("nexus-ci-evidence.")
    assert evidence_workspace.stat().st_mode & 0o777 == 0o700
    assert sorted(
        path.relative_to(evidence_workspace).as_posix() for path in evidence_workspace.rglob("*")
    ) == [
        "runs",
        "runs/2222222222222222",
        "runs/2222222222222222/.hidden-evidence",
        "runs/2222222222222222/invocation.txt",
        "runs/2222222222222222/run-context.json",
        "runs/2222222222222222/summary.json",
    ]
    assert (evidence_workspace / "runs/2222222222222222/invocation.txt").read_text(
        encoding="utf-8"
    ) == "full\n"
    assert (old_run / "summary.json").read_text(encoding="utf-8") == ('{"status":"not_run"}\n')

    rejected_cleanup = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "cleanup", str(repository)),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert rejected_cleanup.returncode != 0
    assert rejected_cleanup.stdout == ""
    assert rejected_cleanup.stderr == (
        "error: evidence workspace is outside the exact runner-owned namespace\n"
    )
    assert repository.is_dir()

    cleaned = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "cleanup", str(evidence_workspace)),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert cleaned.returncode == 0, cleaned.stderr
    assert not evidence_workspace.exists()


def test_ci_artifact_owner_rejects_ambiguous_new_run_evidence(tmp_path: Path) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_RUN_ID": "3333333333333333",
        "FAKE_SECOND_RUN_ID": "4444444444444444",
        "GITHUB_OUTPUT": str(github_output),
        "GITHUB_WORKSPACE": str(repository),
        "RUNNER_TEMP": str(runner_temp),
    }

    completed = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "run", "changed", "--base", "HEAD"),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert completed.stdout == ""
    assert completed.stderr == (
        "error: test invocation did not claim exactly one new run evidence directory\n"
    )
    assert github_output.read_text(encoding="utf-8") == ""


@pytest.mark.parametrize(
    ("environment_flag", "expected_error"),
    (
        (
            "FAKE_TRAILING_SUMMARY",
            "error: terminal run evidence does not match the CI invocation\n",
        ),
        (
            "FAKE_RUN_SYMLINK",
            "error: run evidence contains a symlink, special file, or foreign owner\n",
        ),
    ),
)
def test_ci_artifact_owner_rejects_noncanonical_run_evidence(
    tmp_path: Path,
    environment_flag: str,
    expected_error: str,
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_RUN_ID": "6666666666666666",
        environment_flag: "1",
        "GITHUB_OUTPUT": str(github_output),
        "GITHUB_WORKSPACE": str(repository),
        "RUNNER_TEMP": str(runner_temp),
    }

    completed = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "run", "full"),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert completed.stdout == ""
    assert completed.stderr == expected_error
    assert github_output.read_text(encoding="utf-8") == ""
    assert list(runner_temp.glob("nexus-ci-evidence.*")) == []


def test_ci_artifact_owner_rejects_a_non_ci_workflow_before_test_execution(
    tmp_path: Path,
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()

    completed = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "run", "doctor"),
        cwd=repository,
        env={
            **os.environ,
            "FAKE_RUN_ID": "5555555555555555",
            "GITHUB_OUTPUT": str(github_output),
            "GITHUB_WORKSPACE": str(repository),
            "RUNNER_TEMP": str(runner_temp),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert completed.stdout == ""
    assert completed.stderr == "error: CI evidence staging admits only changed or full\n"
    assert not (repository / "test-results").exists()
    assert github_output.read_text(encoding="utf-8") == ""
