from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import TextIO

from nexus_test_control.evidence import (
    CapabilityEvidence,
    DiagnosticRerunEvidence,
    InvocationEvidence,
    PeakOwnedMemory,
    ProveEvidence,
    RunEvidence,
    diagnostic_evidence_json,
    evidence_json,
    execution_input_fingerprint,
    prove_evidence_json,
    redact_text,
    run_evidence_from_json,
    write_evidence_json,
)
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
    SensitivityRequest,
    canonical_proof,
    declared_fault_for_proof,
    prove_many,
)
from nexus_test_control.sensitivity import (
    prove as prove_sensitivity,
)
from nexus_test_control.services import clean_owned_runtime, new_run_id, test_environment

_PROOF_RUNNERS = frozenset({"gradle", "playwright", "pytest", "static", "vitest"})
_FAULT_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_RUN_ID = re.compile(r"[0-9a-f]{16}\Z")
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
class DiagnoseCommand:
    original_run_id: str


@dataclass(frozen=True, slots=True)
class CleanCommand:
    pass


@dataclass(frozen=True, slots=True)
class ListCommand:
    pass


type Command = WorkflowCommand | ProveCommand | DiagnoseCommand | CleanCommand | ListCommand


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

    diagnose = commands.add_parser("diagnose")
    diagnose.add_argument("--of", required=True)

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
    if command == "diagnose":
        if _RUN_ID.fullmatch(parsed.of) is None:
            argument_parser.error("--of must be a 16-character lowercase hexadecimal run id")
        return DiagnoseCommand(parsed.of)
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
        "commands": [
            {"id": "prove"},
            {"id": "diagnose"},
            {"id": "clean"},
            {"id": "list"},
        ],
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
            if isinstance(command, DiagnoseCommand):
                return _execute_diagnose(root, command, env, output)
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
    run_id, results_directory = _claim_results_directory(repo_root)
    invocation = InvocationEvidence(
        ui=command.ui,
        input_fingerprint=execution_input_fingerprint(environment),
    )
    git_sha: str | None = None
    base_sha: str | None = None
    selection: tuple[Selection, ...] = ()
    sensitivity: tuple[Sensitivity, ...] = ()
    failure_owner = Capability.POLICY
    try:
        git_sha = _git_sha(repo_root, "HEAD")
        base_override = None
        if command.workflow is Workflow.PR:
            base_override = environment.get("NEXUS_TEST_BASE_SHA") or "HEAD^"
        base_sha, selection = _selection(repo_root, command, base_override=base_override)
        selected = tuple(_canonical_selection(repo_root, item) for item in selection)
        selection = _route_selection_for_workflow(command.workflow, selected)
        active_selection = tuple(item for item in selection if item.deferred_to is None)
        failure_owner = Capability.SENSITIVITY
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
        failure_owner = WORKFLOW_REGISTRY[command.workflow].requirements[0].capability
        workflow_run = run_workflow(context, output, owned_environment, run_id=run_id)
        capabilities = workflow_run.capabilities
        peak_owned_mib = workflow_run.peak_owned_mib
    except BaseException as error:
        capabilities = _failed_capabilities(
            command.workflow,
            failure_owner,
            f"controller execution did not complete: {error}",
        )
        peak_owned_mib = PeakOwnedMemory(0, 0, 0, measurement_complete=False)
    duration_ms = (time.monotonic_ns() - started) // 1_000_000
    evidence = RunEvidence(
        repo_root=repo_root,
        run_id=run_id,
        workflow=command.workflow,
        git_sha=git_sha,
        base_sha=base_sha,
        duration_ms=duration_ms,
        peak_owned_mib=peak_owned_mib,
        selection=selection,
        sensitivity=sensitivity,
        capabilities=capabilities,
        invocation=invocation,
    )
    relative_summary = write_summary(repo_root, evidence, environment_secrets(environment))
    output.write(f"{command.workflow.value}: {evidence.status.value}; summary={relative_summary}\n")
    return 0 if evidence.status is RunStatus.PASS else 1


def _execute_diagnose(
    repo_root: Path,
    command: DiagnoseCommand,
    environment: Mapping[str, str],
    output: TextIO,
) -> int:
    original = _load_failed_run(repo_root, command.original_run_id)
    git_sha = _git_sha(repo_root, "HEAD")
    if original.git_sha != git_sha:
        raise ControlPlaneError("diagnostic rerun requires the original committed HEAD")
    _require_clean_checkout(repo_root)
    input_fingerprint = execution_input_fingerprint(environment)
    if original.invocation.input_fingerprint != input_fingerprint:
        raise ControlPlaneError("diagnostic rerun requires the original execution inputs")

    run_id = new_run_id()
    original_directory = repo_root / "test-results" / "runs" / original.run_id
    claim = original_directory / "diagnostic-rerun.json"
    relative_summary = Path("test-results") / "runs" / run_id / "summary.json"
    absolute_results_directory = repo_root / relative_summary.parent
    absolute_results_directory.mkdir(parents=True, exist_ok=False)
    try:
        with claim.open("x", encoding="utf-8") as target:
            target.write(
                json.dumps(
                    {
                        "version": 2,
                        "command": "diagnose",
                        "diagnostic_run_id": run_id,
                        "summary": relative_summary.as_posix(),
                        "state": "started",
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            )
            target.flush()
            os.fsync(target.fileno())
    except FileExistsError as error:
        absolute_results_directory.rmdir()
        raise ControlPlaneError("failed run already has a formal diagnostic rerun") from error

    started = time.monotonic_ns()
    context = CapabilityContext(
        repo_root,
        original.workflow,
        tuple(item for item in original.selection if item.deferred_to is None),
        original.invocation.ui,
        frozenset(item.proof for item in original.sensitivity),
    )
    owned_environment = {
        **environment,
        "NEXUS_TEST_RESULTS_DIR": str(absolute_results_directory),
        "NEXUS_TEST_RUN_ID": run_id,
    }
    try:
        workflow_run = run_workflow(context, output, owned_environment, run_id=run_id)
        peak_owned_mib = workflow_run.peak_owned_mib
        capabilities = workflow_run.capabilities
    except BaseException as error:
        peak_owned_mib = PeakOwnedMemory(0, 0, 0, measurement_complete=False)
        capabilities = _aborted_capabilities(
            original.workflow,
            f"diagnostic execution did not complete: {error}",
        )
    evidence = DiagnosticRerunEvidence(
        run_id=run_id,
        workflow=original.workflow,
        git_sha=git_sha,
        diagnostic_of_run_id=original.run_id,
        duration_ms=(time.monotonic_ns() - started) // 1_000_000,
        peak_owned_mib=peak_owned_mib,
        capabilities=capabilities,
        invocation=original.invocation,
    )
    summary_payload = diagnostic_evidence_json(evidence, environment_secrets(environment))
    with (repo_root / relative_summary).open("x", encoding="utf-8") as target:
        target.write(json.dumps(summary_payload, indent=2, sort_keys=True) + "\n")
        target.flush()
        os.fsync(target.fileno())
    terminal_claim = {
        "version": 2,
        "command": "diagnose",
        "diagnostic_run_id": run_id,
        "summary": relative_summary.as_posix(),
        "state": "terminal",
        "diagnostic_status": evidence.diagnostic_status.value,
    }
    claim_update = claim.with_suffix(".json.tmp")
    with claim_update.open("x", encoding="utf-8") as target:
        target.write(json.dumps(terminal_claim, indent=2, sort_keys=True) + "\n")
        target.flush()
        os.fsync(target.fileno())
    os.replace(claim_update, claim)
    output.write(
        "diagnose: first=fail; "
        f"diagnostic={evidence.diagnostic_status.value}; verdict=fail; "
        f"summary={relative_summary.as_posix()}\n"
    )
    return 1


def _aborted_capabilities(
    workflow: Workflow,
    detail: str,
) -> tuple[CapabilityEvidence, ...]:
    return tuple(
        CapabilityEvidence(
            requirement.capability,
            RunStatus.NOT_RUN,
            0,
            0,
            detail=detail if index == 0 else "blocked by controller interruption",
        )
        for index, requirement in enumerate(WORKFLOW_REGISTRY[workflow].requirements)
    )


def _failed_capabilities(
    workflow: Workflow,
    owner: Capability,
    detail: str,
) -> tuple[CapabilityEvidence, ...]:
    required = WORKFLOW_REGISTRY[workflow].requirements
    if owner not in {requirement.capability for requirement in required}:
        owner = required[0].capability
    return tuple(
        CapabilityEvidence(
            requirement.capability,
            RunStatus.FAIL if requirement.capability is owner else RunStatus.NOT_RUN,
            0,
            0,
            detail=(
                detail
                if requirement.capability is owner
                else f"blocked by controller failure in {owner.value}"
            ),
        )
        for requirement in required
    )


def _load_failed_run(repo_root: Path, run_id: str) -> RunEvidence:
    relative = Path("test-results") / "runs" / run_id / "summary.json"
    summary = repo_root / relative
    try:
        resolved = summary.resolve(strict=True)
        resolved.relative_to(repo_root.resolve(strict=True))
        value = json.loads(resolved.read_text(encoding="utf-8"))
        evidence = run_evidence_from_json(repo_root, value)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise ControlPlaneError(f"invalid original run summary: {error}") from error
    if resolved != summary or evidence.run_id != run_id:
        raise ControlPlaneError("original run summary identity does not match --of")
    if evidence.status is not RunStatus.FAIL:
        raise ControlPlaneError("diagnostic rerun requires a failed workflow run")
    return evidence


def _require_clean_checkout(repo_root: Path) -> None:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise ControlPlaneError("could not inspect the diagnostic checkout") from error
    if status.strip():
        raise ControlPlaneError("diagnostic rerun requires a clean committed checkout")


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


def _canonical_selection(repo_root: Path, item: Selection) -> Selection:
    if not item.sensitivity_required or item.proof is None:
        return item
    proof = canonical_proof(repo_root, item.proof)
    requires_machine_sensitivity = (
        proof != item.proof or declared_fault_for_proof(repo_root, proof) is not None
    )
    return replace(
        item,
        proof=proof,
        sensitivity_required=requires_machine_sensitivity,
    )


def _execute_prove(
    repo_root: Path,
    command: ProveCommand,
    environment: Mapping[str, str],
    output: TextIO,
) -> int:
    started = time.monotonic_ns()
    run_id, _results_directory = _claim_results_directory(repo_root)
    invocation = InvocationEvidence(
        input_fingerprint=execution_input_fingerprint(environment),
    )
    git_sha: str | None = None
    proof = command.proof
    status = RunStatus.FAIL
    sensitivity: tuple[Sensitivity, ...] = ()
    detail = ""
    try:
        git_sha = _git_sha(repo_root, "HEAD")
        proof = canonical_proof(repo_root, command.proof)
        record = prove_sensitivity(
            repo_root,
            proof=proof,
            changed_paths=(_proof_path(proof),),
            method=command.method,
            against=command.against,
            environment=environment,
        )
        sensitivity = (record,)
        status = RunStatus.PASS
    except BaseException as error:
        detail = f"sensitivity execution did not complete: {error}"
    evidence = ProveEvidence(
        repo_root=repo_root,
        run_id=run_id,
        proof=proof,
        method=command.method,
        against=command.against,
        git_sha=git_sha,
        duration_ms=(time.monotonic_ns() - started) // 1_000_000,
        status=status,
        sensitivity=sensitivity,
        detail=detail,
        invocation=invocation,
    )
    relative = Path("test-results") / "runs" / run_id / "summary.json"
    try:
        write_evidence_json(
            repo_root / relative,
            prove_evidence_json(evidence, environment_secrets(environment)),
        )
    except ValueError as error:
        raise ControlPlaneError(str(error)) from error
    output.write(f"prove: {status.value}; summary={relative.as_posix()}\n")
    return 0 if status is RunStatus.PASS else 1


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
    requests: list[SensitivityRequest] = []
    for proof, paths in sorted(by_proof.items()):
        fault_id = declared_fault_for_proof(repo_root, proof)
        requests.append(
            SensitivityRequest(
                proof=proof,
                changed_paths=tuple(paths),
                method=SensitivityMethod.FAULT if fault_id else SensitivityMethod.BASE,
                against=fault_id or base_sha,
            )
        )
    return prove_many(repo_root, requests=requests, environment=environment)


def write_summary(
    repo_root: Path,
    evidence: RunEvidence,
    secrets: Sequence[str] = (),
) -> str:
    relative = Path("test-results") / "runs" / evidence.run_id / "summary.json"
    path = repo_root / relative
    if not path.parent.is_dir():
        raise ControlPlaneError("run evidence directory is absent")
    try:
        write_evidence_json(path, evidence_json(evidence, secrets))
    except ValueError as error:
        raise ControlPlaneError(str(error)) from error
    return relative.as_posix()


def _claim_results_directory(repo_root: Path) -> tuple[str, Path]:
    runs = repo_root / "test-results" / "runs"
    try:
        runs.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ControlPlaneError("could not create the run evidence directory") from error
    for _attempt in range(4):
        run_id = new_run_id()
        directory = runs / run_id
        try:
            directory.mkdir()
        except FileExistsError:
            continue
        except OSError as error:
            raise ControlPlaneError("could not claim a run evidence directory") from error
        return run_id, directory
    raise ControlPlaneError("could not allocate a unique run evidence directory")


def _selection(
    repo_root: Path,
    command: WorkflowCommand,
    *,
    base_override: str | None = None,
) -> tuple[str | None, tuple[Selection, ...]]:
    if command.workflow not in {Workflow.CHANGED, Workflow.CONFIDENCE, Workflow.PR}:
        return None, ()
    default_base = "HEAD^" if command.workflow is Workflow.CONFIDENCE else "HEAD"
    base = command.base or base_override or default_base
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
