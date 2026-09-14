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
SETUP_ACTION = REPO_ROOT / ".github/actions/setup-test/action.yml"
REPOSITORY = "NielsdaWheelz/nexus-web"
PULL_REQUEST_NUMBER = "17"


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
    _git(repository, "config", "user.name", "Nexus test")
    _git(repository, "config", "user.email", "test@nexus.local")
    (repository / "base.txt").write_text("base\n", encoding="utf-8")
    _git(repository, "add", "base.txt")
    _git(repository, "commit", "--message", "base")
    base_sha = _git(repository, "rev-parse", "HEAD")

    _git(repository, "switch", "--create", "feature")
    (repository / "head.txt").write_text("head\n", encoding="utf-8")
    _git(repository, "add", "head.txt")
    _git(repository, "commit", "--message", "head")
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
    environment = {
        **os.environ,
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "GH_TOKEN": "test-boundary-token",
        "GITHUB_REPOSITORY": REPOSITORY,
        "PR_NUMBER": PULL_REQUEST_NUMBER,
        "EXPECTED_BASE_SHA": base_sha,
        "EXPECTED_HEAD_SHA": head_sha,
        "PR_RESPONSE": json.dumps(payload, separators=(",", ":")),
        "RUNNER_TEMP": str(tmp_path),
    }
    return subprocess.run(
        ("bash", "-euo", "pipefail", "-c", _step_script("Construct the exact PR merge")),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )


def _runtime_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "runtime-repository"
    repository.mkdir()
    _git(repository, "init", "--initial-branch=main")
    _git(repository, "config", "user.name", "Nexus test")
    _git(repository, "config", "user.email", "test@nexus.local")
    (repository / ".gitignore").write_text(".nexus-test/\n", encoding="utf-8")
    (repository / "scripts").mkdir()
    _git(repository, "add", ".gitignore")
    _git(repository, "commit", "--message", "runtime owner")
    return repository


def _run_prior_runtime_retirement(
    tmp_path: Path, repository: Path
) -> subprocess.CompletedProcess[str]:
    command = (
        "bash",
        "-euo",
        "pipefail",
        "-c",
        _step_script("Retire prior checkout test runtime"),
    )
    return subprocess.run(
        command,
        cwd=tmp_path,
        env={
            **os.environ,
            "CLEAN_INVOCATION": str(tmp_path / "clean-invocation"),
            "GITHUB_WORKSPACE": str(repository),
        },
        check=False,
        capture_output=True,
        text=True,
    )


def test_prior_runtime_is_retired_by_its_own_checkout_before_replacement(
    tmp_path: Path,
) -> None:
    repository = _runtime_repository(tmp_path)
    runtime = repository / ".nexus-test/runtime.json"
    runtime.parent.mkdir()
    runtime.write_text('{"version":5}\n', encoding="utf-8")
    owner_route = repository / "scripts/test"
    owner_route.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        'printf \'%s\\n\' "$PWD" "$@" > "$CLEAN_INVOCATION"\n'
        'rm -- "$GITHUB_WORKSPACE/.nexus-test/runtime.json"\n',
        encoding="utf-8",
    )
    owner_route.chmod(0o755)

    completed = _run_prior_runtime_retirement(tmp_path, repository)

    assert completed.returncode == 0, completed.stderr
    assert not runtime.exists()
    invocation = (tmp_path / "clean-invocation").read_text(encoding="utf-8").splitlines()
    assert invocation == [str(repository), "clean"]


def test_prior_runtime_retirement_is_a_no_op_for_a_fresh_runner(tmp_path: Path) -> None:
    repository = tmp_path / "not-yet-checked-out"

    completed = _run_prior_runtime_retirement(tmp_path, repository)

    assert completed.returncode == 0, completed.stderr
    assert not (tmp_path / "clean-invocation").exists()


def test_prior_runtime_retirement_rejects_a_symlinked_ownership_record(
    tmp_path: Path,
) -> None:
    repository = _runtime_repository(tmp_path)
    runtime = repository / ".nexus-test/runtime.json"
    runtime.parent.mkdir()
    foreign = tmp_path / "foreign-runtime.json"
    foreign.write_text('{"version":5}\n', encoding="utf-8")
    runtime.symlink_to(foreign)

    completed = _run_prior_runtime_retirement(tmp_path, repository)

    assert completed.returncode != 0
    assert foreign.read_text(encoding="utf-8") == '{"version":5}\n'
    assert not (tmp_path / "clean-invocation").exists()


def test_manual_recovery_constructs_one_merge_with_the_exact_verified_parents(
    tmp_path: Path,
) -> None:
    repository, base_sha, head_sha = _pull_request_repository(tmp_path)

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
    setup = SETUP_ACTION.read_text(encoding="utf-8")

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
    assert "ubuntu-latest" not in workflow
    assert workflow.count("runs-on: [self-hosted, linux, x64]") == 2
    assert "cancel-in-progress: false" in workflow
    assert workflow.count("clean: false") == 2
    assert workflow.count("- name: Retire prior checkout test runtime") == 2
    assert workflow.count('test -x "$checkout/scripts/test"') == 2
    assert workflow.count('            cd "$checkout"') == 2
    assert workflow.count("            ./scripts/test clean") == 4
    assert "from nexus_test_control.services import clean_owned_runtime" not in workflow
    assert workflow.count("- name: Clear prior runner evidence") == 2
    assert workflow.count("git clean -qffdx -- test-results/") == 2
    assert workflow.count("run: ./scripts/test pr") == 1
    assert workflow.count("run: ./scripts/test full") == 1
    assert workflow.count("- name: Retire current checkout test runtime") == 2
    assert 'command -v "$tool"' in setup
    assert "sudo -n true" in setup
    assert setup.index("- name: Qualify host ownership proofs") < setup.index(
        "- uses: actions/setup-go@"
    )
    assert "sudo --non-interactive true" in setup
    assert "uv sync --all-extras --locked --reinstall --directory python" in setup
    assert 'checkout="$(realpath -m -- "$checkout")"' in setup
    assert 'rm --recursive --force --one-file-system -- "$checkout"' in setup
    assert "github.event_name != 'workflow_dispatch'" not in workflow
    assert re.search(
        r"(?ms)^  pr:\n.*?^    if: github\.event_name == 'pull_request' "
        r"\|\| github\.event_name == 'workflow_dispatch'$"
        r".*?^      - name: Retire prior checkout test runtime$"
        r".*?^            \./scripts/test clean$"
        r".*?^      - uses: actions/checkout@"
        r".*?^      - name: Run the deterministic PR gate\n"
        r"        run: \./scripts/test pr$"
        r".*?^      - name: Upload run evidence$"
        r".*?^      - name: Retire current checkout test runtime$"
        r".*?^            \./scripts/test clean$",
        workflow,
    )
    assert re.search(
        r"(?ms)^  candidate-full:\n.*?^    if: github\.event_name == 'push'$"
        r".*?^      - name: Retire prior checkout test runtime$"
        r".*?^            \./scripts/test clean$"
        r".*?^      - uses: actions/checkout@"
        r".*?^      - name: Run the candidate full gate\n        run: \./scripts/test full$"
        r".*?^      - name: Upload run evidence$"
        r".*?^      - name: Retire current checkout test runtime$"
        r".*?^            \./scripts/test clean$",
        workflow,
    )
    recovery = _step_script("Construct the exact PR merge")
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


def test_ci_uses_an_invocation_owned_offline_complete_uv_cache() -> None:
    setup = SETUP_ACTION.read_text(encoding="utf-8")

    required_configuration = (
        "        enable-cache: true\n"
        "        cache-local-path: ${{ runner.temp }}/nexus-uv-cache-"
        "${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}\n"
        "        cache-suffix: nexus-offline-complete-v1\n"
        "        prune-cache: false\n"
    )
    if required_configuration not in setup:
        raise AssertionError("ci uv cache must be job-owned and retain downloaded wheels")
