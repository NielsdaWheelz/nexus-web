"""Behavior proof for exact manual pull-request CI recovery."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
from collections.abc import Mapping
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[3]
WORKFLOW = REPO_ROOT / ".github/workflows/ci.yml"
SETUP_ACTION = REPO_ROOT / ".github/actions/setup-test/action.yml"
GENERATED_BUILD_ACTION = REPO_ROOT / ".github/actions/clean-generated-web-build/action.yml"
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
        step_end = next(
            (
                index
                for index in range(step_index + 1, len(lines))
                if lines[index].startswith("      - ")
            ),
            len(lines),
        )
        run_index = next(
            index
            for index in range(step_index + 1, step_end)
            if lines[index].startswith("        run: ")
        )
    except (ValueError, StopIteration) as error:
        raise AssertionError(
            f"workflow step is absent or has no owned shell body: {name}"
        ) from error

    if lines[run_index] != "        run: |":
        return lines[run_index].removeprefix("        run: ") + "\n"
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


def _pr_proof_step_name() -> str:
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    job_start = lines.index("  pr:")
    name: str | None = None
    for line in lines[job_start + 1 :]:
        if line.startswith("  ") and not line.startswith("    "):
            break
        if line.startswith("      - name: "):
            name = line.removeprefix("      - name: ")
        elif line.startswith("      - "):
            name = None
        elif line == "        id: proof":
            assert name is not None, "PR proof step has no shell owner"
            return name
    raise AssertionError("PR job has no canonical proof step")


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
        'if [ -z "${FAKE_SKIP_RUN_CLAIM:-}" ]; then\n'
        '  if [ -n "${FAKE_MALFORMED_RUN_CLAIM:-}" ]; then\n'
        "    printf '{}\\n' >&\"$NEXUS_TEST_RUN_CLAIM_FD\"\n"
        "  else\n"
        '    claim_run_id="${FAKE_CLAIM_RUN_ID:-$FAKE_RUN_ID}"\n'
        "    printf "
        "'"
        '{"directory":"test-results/runs/%s","run_id":"%s","version":1}'
        "\\n' "
        '"$claim_run_id" "$claim_run_id" >&"$NEXUS_TEST_RUN_CLAIM_FD"\n'
        "  fi\n"
        "fi\n"
        'printf \'%s\\n\' "$*" >"$run_directory/invocation.txt"\n'
        "printf 'hidden\\n' >\"$run_directory/.hidden-evidence\"\n"
        'if [ -n "${FAKE_SIGNAL_CONTROLLER:-}" ]; then\n'
        '  exec "$FAKE_SIGNAL_CONTROLLER"\n'
        "fi\n"
        'git_sha="$(git rev-parse HEAD)"\n'
        'status="pass"\n'
        'if [ "${FAKE_TEST_STATUS:-0}" -ne 0 ]; then status="fail"; fi\n'
        'if [ -z "${FAKE_SKIP_SUMMARY:-}" ]; then\n'
        "  printf '{}\\n' >\"$run_directory/run-context.json\"\n"
        "  printf "
        '\'{"git_sha":"%s","run_context_artifact":'
        '"test-results/runs/%s/run-context.json","run_id":"%s",'
        '"status":"%s","version":3,"workflow":"%s"}\\n\' '
        '"$git_sha" "$FAKE_RUN_ID" "$FAKE_RUN_ID" "$status" "$1" '
        '>"$run_directory/summary.json"\n'
        "fi\n"
        'if [ -n "${FAKE_TRAILING_SUMMARY:-}" ]; then\n'
        "  printf '{}\\n' >>\"$run_directory/summary.json\"\n"
        "fi\n"
        'if [ -n "${FAKE_RUN_SYMLINK:-}" ]; then\n'
        '  ln -s -- /dev/null "$run_directory/foreign-link"\n'
        "fi\n"
        'if [ -n "${FAKE_SECOND_RUN_ID:-}" ]; then\n'
        '  mkdir -p -- "test-results/runs/${FAKE_SECOND_RUN_ID}"\n'
        "  printf 'nested\\n' >\"test-results/runs/${FAKE_SECOND_RUN_ID}/api.log\"\n"
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


@pytest.mark.parametrize(
    ("event", "proof", "expected_workflow"),
    (
        ("pull_request", "", "changed"),
        ("pull_request", "pr", "changed"),
        ("workflow_dispatch", "changed", "changed"),
        ("workflow_dispatch", "pr", "pr"),
        ("workflow_dispatch", "full", None),
        ("workflow_dispatch", "", None),
        ("workflow_dispatch", "pr; touch injected", None),
        ("push", "pr", None),
    ),
)
def test_manual_pr_proof_routes_only_the_explicit_bounded_workflow(
    tmp_path: Path,
    event: str,
    proof: str,
    expected_workflow: str | None,
) -> None:
    owner = tmp_path / "scripts/ci-proof-artifact.sh"
    owner.parent.mkdir()
    owner.write_text(
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\0\' "$@" > "$CAPTURE"\n',
        encoding="utf-8",
    )
    owner.chmod(0o755)
    capture = tmp_path / "invocation"
    base = "b" * 40
    completed = subprocess.run(
        ("bash", "-euo", "pipefail", "-c", _step_script(_pr_proof_step_name())),
        cwd=tmp_path,
        env={
            **os.environ,
            "CAPTURE": str(capture),
            "NEXUS_CI_EVENT_NAME": event,
            "NEXUS_CI_PROOF": proof,
            "NEXUS_TEST_BASE_SHA": base,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    if expected_workflow is None:
        assert completed.returncode != 0, "CI admitted an unsupported manual proof"
        assert not capture.exists(), "invalid proof reached the evidence owner"
    else:
        assert completed.returncode == 0, completed.stderr
        expected = ["run", expected_workflow]
        if expected_workflow == "changed":
            expected.extend(("--base", base))
        assert capture.read_bytes().split(b"\0")[:-1] == [value.encode() for value in expected], (
            "manual PR recovery did not run the requested same-run sensitivity gate"
        )
    assert not (tmp_path / "injected").exists()


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
    assert re.search(
        r"(?ms)^      proof:\n.*?^        required: true$.*?^        type: choice$"
        r".*?^        default: changed$.*?^        options:\n"
        r"          - changed\n          - pr$",
        dispatch_body,
    ), "manual recovery must expose only changed and pr with changed as the default"
    assert (
        "timeout-minutes: ${{ github.event_name == 'workflow_dispatch' "
        "&& inputs.proof == 'pr' && 480 || 120 }}"
    ) in workflow
    assert _step_environment("Run the selected PR proof") == {
        "NEXUS_CI_EVENT_NAME": "${{ github.event_name }}",
        "NEXUS_CI_PROOF": "${{ inputs.proof }}",
    }
    assert (
        workflow.count('scripts/ci-proof-artifact.sh run changed --base "$NEXUS_TEST_BASE_SHA"')
        == 1
    )
    assert workflow.count("scripts/ci-proof-artifact.sh run pr") == 1
    assert workflow.count("run: scripts/ci-proof-artifact.sh run full") == 1
    assert "github.event_name != 'workflow_dispatch'" not in workflow
    assert re.search(
        r"(?ms)^  pr:\n.*?^    if: github\.event_name == 'pull_request' "
        r"\|\| github\.event_name == 'workflow_dispatch'$"
        r".*?^      - name: Run the selected PR proof\n"
        r"        id: proof\n"
        r"        shell: bash\n"
        r"        env:\n.*?^        run: \|$",
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
    assert workflow.count('scripts/ci-proof-artifact.sh enforce "$NEXUS_CI_PROOF_RESULT"') == 2
    assert workflow.count("NEXUS_CI_PROOF_RESULT: ${{ steps.proof.outputs.result }}") == 2
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
@pytest.mark.parametrize("workflow", ("full", "pr"))
def test_ci_artifact_owner_stages_only_the_run_claimed_by_this_invocation(
    tmp_path: Path,
    test_status: int,
    workflow: str,
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
        (str(CI_ARTIFACT_OWNER), "run", workflow),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert completed.stderr == ""
    output = github_output.read_text(encoding="utf-8")
    output_lines = output.splitlines()
    assert len(output_lines) == 2
    assert output_lines[0].startswith("path=")
    assert output_lines[1] == f"result={'pass' if test_status == 0 else 'fail'}"
    evidence_workspace = Path(output_lines[0].removeprefix("path="))
    assert list(runner_temp.glob("nexus-test-run-claim.*")) == []
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
    ) == f"{workflow}\n"
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

    enforced = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "enforce", output_lines[1].removeprefix("result=")),
        cwd=repository,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert enforced.returncode == (0 if test_status == 0 else 1)
    assert enforced.stdout == ""
    assert enforced.stderr == (
        "" if test_status == 0 else "error: canonical test proof concluded fail\n"
    )


def test_ci_artifact_owner_stages_claimed_interrupted_run_before_failing_job(
    tmp_path: Path,
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_RUN_ID": "9999999999999999",
        "FAKE_SKIP_SUMMARY": "1",
        "FAKE_TEST_STATUS": "143",
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

    assert completed.returncode == 0, completed.stderr
    output = dict(line.split("=", 1) for line in github_output.read_text().splitlines())
    assert output["result"] == "incomplete"
    staged_run = Path(output["path"]) / "runs/9999999999999999"
    assert (staged_run / "invocation.txt").is_file()
    assert not (staged_run / "summary.json").exists()
    assert list(runner_temp.glob("nexus-test-run-claim.*")) == []


@pytest.mark.parametrize(
    "adapter_signal",
    (signal.SIGHUP, signal.SIGINT, signal.SIGTERM),
    ids=("SIGHUP", "SIGINT", "SIGTERM"),
)
def test_ci_artifact_owner_forwards_cancellation_and_reaps_the_owned_process_tree(
    tmp_path: Path, adapter_signal: signal.Signals
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    child_pid_path = tmp_path / "signal-child.pid"
    signal_receipt = tmp_path / "signal-receipt.txt"
    signal_controller = tmp_path / "signal-controller.py"
    signal_controller.write_text(
        """#!/usr/bin/env python3
import os
import signal
import subprocess
import sys
from pathlib import Path

child = subprocess.Popen(
    (sys.executable, "-c", "import signal; signal.pause()"),
    start_new_session=True,
)


def terminate(signum: int, _frame: object) -> None:
    Path(os.environ["FAKE_SIGNAL_RECEIPT"]).write_text(
        signal.Signals(signum).name,
        encoding="utf-8",
    )
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    child.wait(timeout=3)
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, terminate)
Path(os.environ["FAKE_CHILD_PID_PATH"]).write_text(str(child.pid), encoding="utf-8")
child.wait()
""",
        encoding="utf-8",
    )
    signal_controller.chmod(0o755)
    environment = {
        **os.environ,
        "FAKE_CHILD_PID_PATH": str(child_pid_path),
        "FAKE_RUN_ID": "8888888888888888",
        "FAKE_SIGNAL_CONTROLLER": str(signal_controller),
        "FAKE_SIGNAL_RECEIPT": str(signal_receipt),
        "FAKE_SKIP_SUMMARY": "1",
        "GITHUB_OUTPUT": str(github_output),
        "GITHUB_WORKSPACE": str(repository),
        "RUNNER_TEMP": str(runner_temp),
    }
    adapter = subprocess.Popen(
        (str(CI_ARTIFACT_OWNER), "run", "full"),
        cwd=repository,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _attempt in range(500):
        if child_pid_path.is_file() or adapter.poll() is not None:
            break
        threading.Event().wait(0.01)
    assert child_pid_path.is_file()
    child_pid = int(child_pid_path.read_text(encoding="utf-8"))

    try:
        os.kill(adapter.pid, adapter_signal)
        stdout, stderr = adapter.communicate(timeout=15)

        assert adapter.returncode == 0, (stdout, stderr)
        assert signal_receipt.read_text(encoding="utf-8") == "SIGTERM"
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
        output = dict(line.split("=", 1) for line in github_output.read_text().splitlines())
        assert output["result"] == "incomplete"
        staged_run = Path(output["path"]) / "runs/8888888888888888"
        assert (staged_run / "invocation.txt").is_file()
        assert not (staged_run / "summary.json").exists()
        assert list(runner_temp.glob("nexus-test-run-claim.*")) == []
    finally:
        if adapter.poll() is None:
            adapter.kill()
            adapter.wait(timeout=3)
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@pytest.mark.parametrize(
    ("result", "expected_status", "expected_error"),
    (
        ("pass", 0, ""),
        ("fail", 1, "error: canonical test proof concluded fail\n"),
        ("not_run", 1, "error: canonical test proof concluded not_run\n"),
        ("incomplete", 1, "error: canonical test proof concluded incomplete\n"),
        ("", 1, "error: proof result is absent or invalid\n"),
        ("unexpected", 1, "error: proof result is absent or invalid\n"),
    ),
)
def test_ci_artifact_owner_enforces_every_proof_result(
    result: str,
    expected_status: int,
    expected_error: str,
) -> None:
    completed = subprocess.run(
        (str(CI_ARTIFACT_OWNER), "enforce", result),
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == expected_status
    assert completed.stdout == ""
    assert completed.stderr == expected_error


def test_ci_artifact_owner_uses_exact_claim_amid_subordinate_run_evidence(
    tmp_path: Path,
) -> None:
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

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert completed.stderr == ""
    output = dict(line.split("=", 1) for line in github_output.read_text().splitlines())
    evidence_workspace = Path(output["path"])
    assert output["result"] == "pass"
    assert (evidence_workspace / "runs/3333333333333333/summary.json").is_file()
    assert not (evidence_workspace / "runs/4444444444444444").exists()
    assert (repository / "test-results/runs/4444444444444444/api.log").read_text(
        encoding="utf-8"
    ) == "nested\n"


@pytest.mark.parametrize("environment_flag", ("FAKE_SKIP_RUN_CLAIM", "FAKE_MALFORMED_RUN_CLAIM"))
def test_ci_artifact_owner_requires_one_exact_controller_claim(
    tmp_path: Path,
    environment_flag: str,
) -> None:
    repository = _ci_artifact_repository(tmp_path)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_RUN_ID": "5555555555555555",
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
    assert completed.stderr == "error: test controller did not publish one exact run claim\n"
    assert github_output.read_text(encoding="utf-8") == ""
    assert list(runner_temp.glob("nexus-test-run-claim.*")) == []


def test_ci_artifact_owner_rejects_claim_to_historical_run(tmp_path: Path) -> None:
    repository = _ci_artifact_repository(tmp_path)
    historical = repository / "test-results/runs/7777777777777777"
    historical.mkdir(parents=True)
    (historical / "historical.txt").write_text("preserve\n", encoding="utf-8")
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    github_output = runner_temp / "github-output"
    github_output.touch()
    environment = {
        **os.environ,
        "FAKE_CLAIM_RUN_ID": "7777777777777777",
        "FAKE_RUN_ID": "8888888888888888",
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
    assert completed.stderr == (
        "error: test controller claimed a pre-existing run evidence directory\n"
    )
    assert (historical / "historical.txt").read_text(encoding="utf-8") == "preserve\n"
    assert github_output.read_text(encoding="utf-8") == ""
    assert list(runner_temp.glob("nexus-test-run-claim.*")) == []


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
    assert completed.stderr == "error: CI evidence staging admits only changed, pr, or full\n"
    assert not (repository / "test-results").exists()
    assert github_output.read_text(encoding="utf-8") == ""


def _generated_build_cleanup_script() -> str:
    lines = GENERATED_BUILD_ACTION.read_text(encoding="utf-8").splitlines()
    step = "    - name: Remove generated web build"
    try:
        step_index = lines.index(step)
        run_index = next(
            index for index in range(step_index + 1, len(lines)) if lines[index] == "      run: |"
        )
    except (ValueError, StopIteration) as error:
        raise AssertionError("generated-build cleanup action has no owned shell body") from error

    body: list[str] = []
    for line in lines[run_index + 1 :]:
        if line and not line.startswith("        "):
            break
        body.append(line[8:] if line else "")
    if not body:
        raise AssertionError("generated-build cleanup action has an empty shell body")
    return "\n".join(body) + "\n"


def _generated_build_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "generated-build-repository"
    repository.mkdir()
    _git(repository, "init", "--initial-branch=main")
    _git(repository, "config", "user.name", "Nexus test")
    _git(repository, "config", "user.email", "test@nexus.local")
    (repository / ".gitignore").write_text(".next/\n", encoding="utf-8")
    (repository / "apps/web").mkdir(parents=True)
    (repository / "apps/web/source.ts").write_text("export {};\n", encoding="utf-8")
    _git(repository, "add", ".")
    _git(repository, "commit", "--message", "source")
    return repository


def _run_generated_build_cleanup(repository: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("bash", "-euo", "pipefail", "-c", _generated_build_cleanup_script()),
        cwd=repository,
        env={**os.environ, "GITHUB_WORKSPACE": str(repository)},
        check=False,
        capture_output=True,
        text=True,
    )


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


def test_ci_recreates_the_locked_python_environment_with_a_safe_exact_target() -> None:
    setup = SETUP_ACTION.read_text(encoding="utf-8")

    cleanup = setup.index("    - name: Recreate locked Python environment\n")
    sync = setup.index("    - name: Install locked Python dependencies\n")
    assert cleanup < sync
    for required_contract in (
        'checkout="$(realpath -e -- "$GITHUB_WORKSPACE")"',
        "command -v mountpoint >/dev/null",
        'repository_root="$(realpath -e -- "$(git -C "$checkout" rev-parse --show-toplevel)")"',
        'test "$checkout" = "$repository_root"',
        'test "$(stat -c \'%u\' -- "$checkout")" = "$(id -u)"',
        'test ! -L "$checkout/python"',
        'git -C "$checkout" check-ignore --quiet -- python/.venv',
        'test ! -L "$environment"',
        '! mountpoint --quiet -- "$environment"',
        'sudo --non-interactive rm --recursive --force --one-file-system -- "$environment"',
        'test ! -e "$environment"',
        "uv sync --all-extras --locked --directory python",
    ):
        assert required_contract in setup


def test_ci_recreates_the_generated_web_build_with_a_safe_exact_target() -> None:
    setup = SETUP_ACTION.read_text(encoding="utf-8")
    action = GENERATED_BUILD_ACTION.read_text(encoding="utf-8")

    cleanup = setup.index("    - name: Recreate generated web build\n")
    install = setup.index("    - name: Install locked JavaScript dependencies\n")
    assert cleanup < install
    assert "      uses: ./.github/actions/clean-generated-web-build\n" in setup
    for required_contract in (
        "command -v mountpoint >/dev/null",
        'checkout="$(realpath -e -- "$GITHUB_WORKSPACE")"',
        'repository_root="$(realpath -e -- "$(git -C "$checkout" rev-parse --show-toplevel)")"',
        'build="$checkout/apps/web/.next"',
        'test "$checkout" = "$repository_root"',
        'test "$(stat -c \'%u\' -- "$checkout")" = "$(id -u)"',
        'test ! -L "$checkout/apps/web"',
        'git -C "$checkout" check-ignore --quiet -- apps/web/.next/',
        'test ! -L "$build"',
        '! mountpoint --quiet -- "$build"',
        'test "$(stat -c \'%u\' -- "$build")" = "$(id -u)"',
        'git -C "$checkout" clean -qfdx -- apps/web/.next',
        'test ! -e "$build"',
    ):
        assert required_contract in action


def test_generated_web_build_cleanup_accepts_an_absent_ignored_directory(
    tmp_path: Path,
) -> None:
    repository = _generated_build_repository(tmp_path)

    completed = _run_generated_build_cleanup(repository)

    assert completed.returncode == 0, completed.stderr
    assert not (repository / "apps/web/.next").exists()


def test_generated_web_build_cleanup_removes_only_the_exact_ignored_tree(
    tmp_path: Path,
) -> None:
    repository = _generated_build_repository(tmp_path)
    build = repository / "apps/web/.next"
    build.mkdir()
    (build / "artifact").write_text("generated\n", encoding="utf-8")

    completed = _run_generated_build_cleanup(repository)

    assert completed.returncode == 0, completed.stderr
    assert not build.exists()
    assert (repository / "apps/web/source.ts").read_text(encoding="utf-8") == "export {};\n"
    assert _git(repository, "status", "--short") == ""


def test_generated_web_build_cleanup_rejects_a_symlink_without_touching_its_target(
    tmp_path: Path,
) -> None:
    repository = _generated_build_repository(tmp_path)
    foreign = tmp_path / "foreign-build"
    foreign.mkdir()
    marker = foreign / "artifact"
    marker.write_text("foreign\n", encoding="utf-8")
    build = repository / "apps/web/.next"
    build.symlink_to(foreign, target_is_directory=True)

    completed = _run_generated_build_cleanup(repository)

    assert completed.returncode != 0
    assert build.is_symlink()
    assert marker.read_text(encoding="utf-8") == "foreign\n"


def test_ci_retires_generated_web_builds_on_every_terminal_job_path() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert workflow.count("      - name: Retire generated web build\n") == 2
    assert (
        workflow.count(
            "      - name: Retire generated web build\n"
            "        if: always()\n"
            "        uses: ./.github/actions/clean-generated-web-build\n"
        )
        == 2
    )
