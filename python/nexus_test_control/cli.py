from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import TextIO

from nexus_test_control.evidence import RunEvidence, evidence_json, redact_text
from nexus_test_control.model import (
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    Sensitivity,
    SensitivityMethod,
    Workflow,
)
from nexus_test_control.process import CommandInterrupted, controller_signal_handlers
from nexus_test_control.runner import CapabilityContext, environment_secrets, run_workflow
from nexus_test_control.runtime import RuntimeContractError, workspace_heavy_lock
from nexus_test_control.selection import (
    ChangedPath,
    GitChangeKind,
    SelectionIndex,
    load_selection_index,
    read_git_changes,
    select_changed,
)
from nexus_test_control.sensitivity import (
    SensitivityError,
    canonical_proof,
    declared_fault_for_proof,
    sensitivity_json,
)
from nexus_test_control.sensitivity import (
    prove as prove_sensitivity,
)
from nexus_test_control.services import clean_owned_runtime, new_run_id, test_environment

_PROOF_RUNNERS = frozenset({"gradle", "playwright", "pytest", "static", "vitest"})
_FAULT_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_DEFERRED_OWNER = {
    Capability.SENSITIVITY: Workflow.PR,
    Capability.MIGRATIONS: Workflow.PR,
    Capability.BUNDLE: Workflow.PR,
    Capability.JOURNEYS_ALL: Workflow.FULL,
    Capability.CORPUS: Workflow.FULL,
    Capability.PROVIDER_RUNTIME: Workflow.FULL,
    Capability.LLM_EVAL: Workflow.FULL,
    Capability.EXTENSION: Workflow.FULL,
    Capability.ANDROID_HOST: Workflow.FULL,
    Capability.AUDIT: Workflow.NIGHTLY,
    Capability.HOSTED: Workflow.NIGHTLY,
    Capability.ANDROID_DEVICE: Workflow.NIGHTLY,
    Capability.PROVIDER_CERTIFICATION: Workflow.RELEASE,
    Capability.ANDROID_RELEASE: Workflow.RELEASE,
    Capability.RELEASE_ARTIFACT: Workflow.RELEASE,
}


class ControlPlaneError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class WorkflowCommand:
    workflow: Workflow
    base: str | None = None
    focus: tuple[str, ...] = ()
    ui: bool = False


@dataclass(frozen=True, slots=True)
class ProveCommand:
    proof: str
    method: SensitivityMethod
    against: str


@dataclass(frozen=True, slots=True)
class CleanCommand:
    pass


@dataclass(frozen=True, slots=True)
class ListCommand:
    pass


type Command = WorkflowCommand | ProveCommand | CleanCommand | ListCommand


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="nexus-test")
    commands = root.add_subparsers(dest="command", required=True)
    workflow_parsers = {
        workflow: commands.add_parser(workflow.value) for workflow in WORKFLOW_REGISTRY
    }

    changed = workflow_parsers[Workflow.CHANGED]
    changed.add_argument("--base")
    changed.add_argument("--ui", action="store_true")
    changed.add_argument("focus", nargs="*")

    confidence = workflow_parsers[Workflow.CONFIDENCE]
    confidence.add_argument("--base")

    prove = commands.add_parser("prove")
    prove.add_argument("--proof", required=True)
    prove.add_argument("--against", required=True)

    commands.add_parser("clean")
    list_command = commands.add_parser("list")
    list_command.add_argument("--json", action="store_true")
    return root


def parse_command(argv: Sequence[str]) -> Command:
    argument_parser = parser()
    parsed = argument_parser.parse_args(argv)
    command = parsed.command
    if command == Workflow.CHANGED.value:
        focus = tuple(parsed.focus)
        for item in focus:
            _validate_proof_path(item, argument_parser)
        if parsed.ui and (len(focus) != 1 or not _is_playwright_target(focus[0])):
            argument_parser.error("changed --ui requires exactly one Playwright target")
        _validate_git_ref(parsed.base, argument_parser)
        return WorkflowCommand(Workflow.CHANGED, parsed.base, focus, parsed.ui)
    if command == Workflow.CONFIDENCE.value:
        _validate_git_ref(parsed.base, argument_parser)
        return WorkflowCommand(Workflow.CONFIDENCE, parsed.base)
    if command in {workflow.value for workflow in WORKFLOW_REGISTRY}:
        return WorkflowCommand(Workflow(command))
    if command == "prove":
        _validate_proof_path(parsed.proof, argument_parser)
        method_value, separator, against = parsed.against.partition(":")
        if not separator or not against:
            argument_parser.error("--against must be base:<git-ref> or fault:<fault-id>")
        try:
            method = SensitivityMethod(method_value)
        except ValueError:
            argument_parser.error("--against must be base:<git-ref> or fault:<fault-id>")
        if method is SensitivityMethod.BASE:
            _validate_git_ref(against, argument_parser)
        elif _FAULT_ID.fullmatch(against) is None:
            argument_parser.error("fault id must be a lowercase hyphenated identifier")
        return ProveCommand(parsed.proof, method, against)
    if command == "clean":
        return CleanCommand()
    if command == "list":
        if not parsed.json:
            argument_parser.error("list requires --json")
        return ListCommand()
    raise AssertionError(f"unhandled parsed command: {command}")


def list_json() -> dict[str, object]:
    return {
        "version": 1,
        "workflows": [
            {
                "id": workflow.value,
                "capabilities": [
                    {
                        "id": requirement.capability.value,
                        "scope": requirement.scope.value,
                    }
                    for requirement in WORKFLOW_REGISTRY[workflow].requirements
                ],
            }
            for workflow in WORKFLOW_REGISTRY
        ],
    }


def main(
    argv: Sequence[str] | None = None,
    *,
    repo_root: Path | None = None,
    environment: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    arguments = tuple(argv) if argv is not None else tuple(sys.argv[1:])
    output = stdout if stdout is not None else sys.stdout
    errors = stderr if stderr is not None else sys.stderr
    command = parse_command(arguments)
    if isinstance(command, ListCommand):
        json.dump(list_json(), output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
        return 0
    env = environment if environment is not None else os.environ
    try:
        root = _git_repo_root(repo_root or Path.cwd())
        local_test_environment = test_environment(env)
        with controller_signal_handlers():
            if isinstance(command, ProveCommand):
                return _execute_prove(root, command, env, output)
            if isinstance(command, CleanCommand):
                with workspace_heavy_lock(root):
                    runtime_existed = (root / ".nexus-test/runtime.json").is_file()
                    cleaned = clean_owned_runtime(root, local_test_environment)
                output.write(
                    f"clean: pass; runs={len(cleaned)}; "
                    f"runtime={'removed' if runtime_existed else 'absent'}\n"
                )
                return 0
            return _execute_workflow(root, command, env, output)
    except (CommandInterrupted, ControlPlaneError, RuntimeContractError, SensitivityError) as error:
        errors.write(redact_text(f"test control failed: {error}\n", environment_secrets(env)))
        return 1


def _execute_workflow(
    repo_root: Path,
    command: WorkflowCommand,
    environment: Mapping[str, str],
    output: TextIO,
) -> int:
    started = time.monotonic_ns()
    run_id = new_run_id()
    results_directory = repo_root / "test-results" / "runs" / run_id
    results_directory.mkdir(parents=True, exist_ok=False)
    git_sha = _git_sha(repo_root, "HEAD")
    base_override = None
    if command.workflow is Workflow.PR:
        base_override = environment.get("NEXUS_TEST_BASE_SHA") or "HEAD^"
    base_sha, selection = _selection(repo_root, command, base_override=base_override)
    selected = tuple(
        Selection(
            item.path,
            item.capability,
            item.reason,
            canonical_proof(repo_root, item.proof)
            if item.sensitivity_required and item.proof is not None
            else item.proof,
            item.sensitivity_required,
            item.deferred_to,
        )
        for item in selection
    )
    selection = _route_selection_for_workflow(command.workflow, selected)
    active_selection = tuple(item for item in selection if item.deferred_to is None)
    sensitivity = _workflow_sensitivity(repo_root, command, environment, base_sha, selection)
    context = CapabilityContext(
        repo_root,
        command.workflow,
        active_selection,
        command.ui,
        frozenset(item.proof for item in sensitivity),
    )
    owned_environment = {
        **environment,
        "NEXUS_TEST_RESULTS_DIR": str(results_directory),
        "NEXUS_TEST_RUN_ID": run_id,
    }
    workflow_run = run_workflow(context, output, owned_environment, run_id=run_id)
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    evidence = RunEvidence(
        repo_root=repo_root,
        run_id=run_id,
        workflow=command.workflow,
        git_sha=git_sha,
        base_sha=base_sha,
        duration_ms=duration_ms,
        peak_owned_mib=workflow_run.peak_owned_mib,
        selection=selection,
        sensitivity=sensitivity,
        capabilities=workflow_run.capabilities,
    )
    relative_summary = write_summary(repo_root, evidence, environment_secrets(environment))
    output.write(f"{command.workflow.value}: {evidence.status.value}; summary={relative_summary}\n")
    return 0 if evidence.status is RunStatus.PASS else 1


def _route_selection_for_workflow(
    workflow: Workflow, selection: tuple[Selection, ...]
) -> tuple[Selection, ...]:
    required = {requirement.capability for requirement in WORKFLOW_REGISTRY[workflow].requirements}
    routed: list[Selection] = []
    for item in selection:
        if item.capability in required:
            routed.append(item)
            continue
        owner = _DEFERRED_OWNER.get(item.capability)
        if owner is None:
            raise ControlPlaneError(
                f"{workflow.value} has no owner for selected {item.capability.value} proof"
            )
        routed.append(replace(item, deferred_to=owner))
    return tuple(routed)


def _execute_prove(
    repo_root: Path,
    command: ProveCommand,
    environment: Mapping[str, str],
    output: TextIO,
) -> int:
    started = time.monotonic_ns()
    proof = canonical_proof(repo_root, command.proof)
    record = prove_sensitivity(
        repo_root,
        proof=proof,
        changed_paths=(_proof_path(proof),),
        method=command.method,
        against=command.against,
        environment=environment,
    )
    run_id = uuid.uuid4().hex
    relative = Path("test-results") / "runs" / run_id / "summary.json"
    path = repo_root / relative
    path.parent.mkdir(parents=True, exist_ok=False)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "command": "prove",
                "run_id": run_id,
                "git_sha": record.green.git_sha,
                "status": "pass",
                "duration_ms": (time.monotonic_ns() - started) // 1_000_000,
                "sensitivity": [sensitivity_json(record)],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    output.write(f"prove: pass; summary={relative.as_posix()}\n")
    return 0


def _workflow_sensitivity(
    repo_root: Path,
    command: WorkflowCommand,
    environment: Mapping[str, str],
    base_sha: str | None,
    selection: tuple[Selection, ...],
) -> tuple[Sensitivity, ...]:
    if command.workflow is not Workflow.PR:
        return ()
    if base_sha is None:
        raise ControlPlaneError("pr requires an exact base revision")
    by_proof: dict[str, list[str]] = {}
    for item in selection:
        if item.sensitivity_required and item.proof is not None:
            by_proof.setdefault(item.proof, []).append(item.path)
    records: list[Sensitivity] = []
    for proof, paths in sorted(by_proof.items()):
        fault_id = declared_fault_for_proof(repo_root, proof)
        records.append(
            prove_sensitivity(
                repo_root,
                proof=proof,
                changed_paths=tuple(paths),
                method=SensitivityMethod.FAULT if fault_id else SensitivityMethod.BASE,
                against=fault_id or base_sha,
                environment=environment,
            )
        )
    return tuple(records)


def write_summary(
    repo_root: Path,
    evidence: RunEvidence,
    secrets: Sequence[str] = (),
) -> str:
    relative = Path("test-results") / "runs" / evidence.run_id / "summary.json"
    path = repo_root / relative
    if not path.parent.is_dir():
        raise ControlPlaneError("run evidence directory is absent")
    with path.open("x", encoding="utf-8") as target:
        target.write(json.dumps(evidence_json(evidence, secrets), indent=2, sort_keys=True) + "\n")
    return relative.as_posix()


def _selection(
    repo_root: Path,
    command: WorkflowCommand,
    *,
    base_override: str | None = None,
) -> tuple[str | None, tuple[Selection, ...]]:
    if command.workflow not in {Workflow.CHANGED, Workflow.CONFIDENCE, Workflow.PR}:
        return None, ()
    base = command.base or base_override or "HEAD"
    base_sha = _git_sha(repo_root, base)
    if command.focus:
        try:
            index = load_selection_index(repo_root)
        except (OSError, ValueError) as error:
            raise ControlPlaneError(f"could not load focused proof routing: {error}") from error
        focused = tuple(
            selection
            for item in command.focus
            for selection in _focus_selections(repo_root, item, index)
        )
        return base_sha, tuple(dict.fromkeys(focused))
    try:
        return base_sha, select_changed(
            read_git_changes(repo_root, base),
            load_selection_index(repo_root),
        )
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        raise ControlPlaneError(f"could not select changed proof: {error}") from error


def _focus_selections(repo_root: Path, value: str, index: SelectionIndex) -> tuple[Selection, ...]:
    path = _proof_path(value)
    candidate = (repo_root / path).resolve(strict=False)
    try:
        relative = candidate.relative_to(repo_root)
    except ValueError as error:
        raise ControlPlaneError(f"focus must remain inside the repository: {value}") from error
    if not candidate.is_file() or relative.as_posix() != path:
        raise ControlPlaneError(f"focus path is not an exact repository file: {value}")
    selections = select_changed((ChangedPath(GitChangeKind.MODIFIED, path),), index)
    if not selections:
        raise ControlPlaneError(f"focus did not resolve: {value}")
    if ":" in value:
        runner = value.partition(":")[0]
        direct_proof = f"{runner}:{path}"
        selections = tuple(
            selection
            for selection in selections
            if selection.reason is SelectionReason.CHANGED_TEST and selection.proof == direct_proof
        )
        if len(selections) != 1:
            raise ControlPlaneError(f"focused proof has no exact executable owner: {value}")
    return tuple(
        Selection(
            path,
            selection.capability,
            SelectionReason.EXPLICIT_FOCUS,
            proof=value if ":" in value else selection.proof,
        )
        for selection in selections
    )


def _proof_path(value: str) -> str:
    runner, separator, node = value.partition(":")
    path = node.split("::", 1)[0] if separator else value
    if separator and runner not in _PROOF_RUNNERS:
        raise ControlPlaneError(f"unknown proof runner: {runner}")
    parsed = PurePosixPath(path)
    if (
        not path
        or parsed.is_absolute()
        or ".." in parsed.parts
        or "\\" in path
        or str(parsed) != path
    ):
        raise ControlPlaneError(f"proof path must be repository-relative: {value}")
    return path


def _is_playwright_target(value: str) -> bool:
    runner, separator, node = value.partition(":")
    path = node.split("::", 1)[0] if separator else value
    return (not separator or runner == "playwright") and path.endswith(
        (".journey.spec.ts", ".extension.spec.ts")
    )


def _git_sha(repo_root: Path, revision: str) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", f"{revision}^{{commit}}"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControlPlaneError(f"could not resolve git revision {revision!r}") from error
    if len(result) != 40 or any(character not in "0123456789abcdef" for character in result):
        raise ControlPlaneError(f"git returned a non-canonical SHA for {revision!r}")
    return result


def _git_repo_root(path: Path) -> Path:
    candidate = path.resolve(strict=True)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=candidate,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControlPlaneError(f"not inside a Git repository: {candidate}") from error
    root = Path(result).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ControlPlaneError("Git returned a repository outside the requested path") from error
    return root


def _validate_git_ref(value: str | None, argument_parser: argparse.ArgumentParser) -> None:
    if value is not None and (not value.strip() or value.startswith("-")):
        argument_parser.error("base must be a non-option git revision")


def _validate_proof_path(value: str, argument_parser: argparse.ArgumentParser) -> None:
    try:
        _proof_path(value)
    except ControlPlaneError as error:
        argument_parser.error(str(error))
