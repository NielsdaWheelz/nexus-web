import json
import os
import re
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from nexus_test_control.model import Capability, Selection, SelectionReason


class GitChangeKind(StrEnum):
    ADDED = "A"
    COPIED = "C"
    DELETED = "D"
    MODIFIED = "M"
    RENAMED = "R"
    TYPE_CHANGED = "T"
    UNMERGED = "U"


@dataclass(frozen=True, slots=True)
class ChangedPath:
    kind: GitChangeKind
    path: str
    previous_path: str | None = None
    similarity: int | None = None

    @property
    def requires_sensitivity(self) -> bool:
        return self.kind is not GitChangeKind.DELETED and not (
            self.kind is GitChangeKind.RENAMED and self.similarity == 100
        )


@dataclass(frozen=True, slots=True)
class SelectionTarget:
    capability: Capability
    proof: str | None = None


@dataclass(frozen=True, slots=True)
class IndexedRoute:
    path_glob: str
    target: SelectionTarget
    reason: SelectionReason


@dataclass(frozen=True, slots=True)
class SelectionIndex:
    routes: tuple[IndexedRoute, ...] = ()

    def for_path(self, path: str) -> tuple[IndexedRoute, ...]:
        return tuple(route for route in self.routes if _glob_matches(path, route.path_glob))


EMPTY_SELECTION_INDEX = SelectionIndex()


SelectionResolver = Callable[[str], Iterable[SelectionTarget]]


def load_selection_index(repo_root: Path) -> SelectionIndex:
    manifest_path = repo_root / "testdata/proofs.json"
    if not manifest_path.is_file():
        return EMPTY_SELECTION_INDEX
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        risks = manifest["priority_risks"]
        journeys = manifest["journeys"]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError("priority proof manifest is unreadable") from error
    if not isinstance(risks, list):
        raise ValueError("priority proof manifest risks must be a list")
    if not isinstance(journeys, list):
        raise ValueError("priority proof manifest journeys must be a list")
    routes: list[IndexedRoute] = []
    for risk in risks:
        if not isinstance(risk, dict):
            raise ValueError("priority proof manifest risk must be an object")
        source_globs = risk.get("source_globs")
        proofs = risk.get("proofs")
        capabilities = risk.get("capabilities")
        if (
            not isinstance(source_globs, list)
            or not isinstance(proofs, list)
            or not isinstance(capabilities, list)
        ):
            raise ValueError("priority proof manifest routing fields must be lists")
        for proof in proofs:
            if not isinstance(proof, str):
                raise ValueError("priority proof id must be a string")
            target = _proof_target(proof)
            if target.capability.value not in capabilities:
                raise ValueError("priority proof runner is absent from its capability contract")
            for source_glob in source_globs:
                if not isinstance(source_glob, str) or not source_glob:
                    raise ValueError("priority source glob must be a non-empty string")
                routes.append(IndexedRoute(source_glob, target, SelectionReason.PRIORITY_RISK))
    for journey in journeys:
        if not isinstance(journey, dict):
            raise ValueError("journey proof manifest entry must be an object")
        proof = journey.get("proof")
        source_globs = journey.get("source_globs")
        if not isinstance(proof, str) or not isinstance(source_globs, list):
            raise ValueError("journey proof manifest routing fields are invalid")
        target = _proof_target(f"playwright:{proof}")
        if target.capability is not Capability.JOURNEYS_ALL:
            raise ValueError("journey proof manifest entry is outside the journey owner")
        for source_glob in source_globs:
            if not isinstance(source_glob, str) or not source_glob:
                raise ValueError("journey source glob must be a non-empty string")
            routes.append(IndexedRoute(source_glob, target, SelectionReason.JOURNEY_OWNER))
    return SelectionIndex(tuple(routes))


def _proof_target(proof: str) -> SelectionTarget:
    runner, separator, node = proof.partition(":")
    if not separator or not node:
        raise ValueError("priority proof must be runner-qualified")
    path = node.split("::", 1)[0]
    direct = _direct_test_target(path)
    if direct is None or proof.partition(":")[0] not in {
        "gradle",
        "playwright",
        "pytest",
        "vitest",
    }:
        raise ValueError(f"priority proof has no executable owner: {proof}")
    expected_runner = {
        Capability.ANDROID_DEVICE: "gradle",
        Capability.COMPONENT: "vitest",
        Capability.JOURNEYS_ALL: "playwright",
        Capability.KERNEL_PYTHON: "pytest",
        Capability.KERNEL_WEB: "vitest",
        Capability.LLM_EVAL: "pytest",
        Capability.MIGRATIONS: "pytest",
        Capability.SERVICE: "pytest",
    }.get(direct.capability)
    if runner != expected_runner:
        raise ValueError(f"priority proof runner does not match its owner: {proof}")
    return SelectionTarget(direct.capability, proof)


def _glob_matches(path: str, pattern: str) -> bool:
    expression = ""
    index = 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            expression += "(?:.*/)?"
            index += 3
        elif pattern.startswith("**", index):
            expression += ".*"
            index += 2
        elif pattern[index] == "*":
            expression += "[^/]*"
            index += 1
        elif pattern[index] == "?":
            expression += "[^/]"
            index += 1
        else:
            expression += re.escape(pattern[index])
            index += 1
    return re.fullmatch(expression, path) is not None


def parse_git_name_status(output: bytes) -> tuple[ChangedPath, ...]:
    fields = output.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[ChangedPath] = []
    index = 0
    while index < len(fields):
        raw_status = os.fsdecode(fields[index])
        index += 1
        if not raw_status:
            raise ValueError("git diff contained a blank status")
        try:
            kind = GitChangeKind(raw_status[0])
        except ValueError as error:
            raise ValueError(f"unsupported git change status: {raw_status}") from error
        similarity = int(raw_status[1:]) if len(raw_status) > 1 else None
        if kind in (GitChangeKind.COPIED, GitChangeKind.RENAMED):
            if index + 1 >= len(fields):
                raise ValueError("git diff rename/copy record is incomplete")
            previous_path = os.fsdecode(fields[index])
            path = os.fsdecode(fields[index + 1])
            index += 2
        else:
            if index >= len(fields):
                raise ValueError("git diff record is incomplete")
            previous_path = None
            path = os.fsdecode(fields[index])
            index += 1
        changes.append(ChangedPath(kind, path, previous_path, similarity))
    return tuple(changes)


def read_git_changes(repo_root: Path, base: str) -> tuple[ChangedPath, ...]:
    if not base.strip() or base.startswith("-"):
        raise ValueError("base must be a non-option git revision")
    diff = subprocess.run(
        ["git", "diff", "--name-status", "-z", "--find-renames", base, "--"],
        cwd=repo_root,
        check=True,
        capture_output=True,
    ).stdout
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z", "--"],
        cwd=repo_root,
        check=True,
        capture_output=True,
    ).stdout
    changes = list(parse_git_name_status(diff))
    known_paths = {change.path for change in changes}
    changes.extend(
        ChangedPath(GitChangeKind.ADDED, os.fsdecode(path))
        for path in untracked.split(b"\0")
        if path and os.fsdecode(path) not in known_paths
    )
    return tuple(changes)


def select_changed(
    changes: Iterable[ChangedPath], index: SelectionIndex = EMPTY_SELECTION_INDEX
) -> tuple[Selection, ...]:
    selections: list[Selection] = []
    routed: set[tuple[str, Capability, str | None]] = set()
    for change in changes:
        routes = [
            IndexedRoute(change.path, target, SelectionReason.PROMOTED_CAPABILITY)
            for target in _promoted_targets(change.path)
        ]
        if change.kind is not GitChangeKind.DELETED:
            direct = _direct_test_target(change.path)
            if direct is not None:
                routes.append(IndexedRoute(change.path, direct, SelectionReason.CHANGED_TEST))
        routes.extend(index.for_path(change.path))
        if not routes:
            routes.append(
                IndexedRoute(
                    change.path,
                    SelectionTarget(_conservative_capability(change.path)),
                    SelectionReason.PROMOTED_CAPABILITY,
                )
            )
        for route in routes:
            target = route.target
            identity = (change.path, target.capability, target.proof)
            if identity in routed:
                continue
            routed.add(identity)
            selections.append(
                Selection(
                    change.path,
                    target.capability,
                    route.reason,
                    target.proof,
                    sensitivity_required=(
                        route.reason is SelectionReason.CHANGED_TEST
                        and change.requires_sensitivity
                        and _pr_sensitivity_eligible(change.path)
                    ),
                )
            )
    return tuple(selections)


def _pr_sensitivity_eligible(path: str) -> bool:
    return not path.startswith(
        (
            "python/tests/hosted/",
            "apps/android/app/src/androidTest/",
        )
    )


def _promoted_targets(path: str) -> tuple[SelectionTarget, ...]:
    if path.startswith("python/nexus_test_control/") or path in {
        "python/pyproject.toml",
        "python/uv.lock",
        "testdata/proofs.json",
        "testdata/manifest.json",
        "testdata/policy-exceptions.json",
        "testdata/faults/manifest.json",
    }:
        return tuple(
            SelectionTarget(capability)
            for capability in (
                Capability.POLICY,
                Capability.POLICY_SELF_TESTS,
                Capability.KERNEL_PYTHON,
            )
        )
    if path in {
        "apps/web/package.json",
        "apps/web/bun.lock",
        "apps/web/vitest.config.ts",
        "apps/web/eslint.config.mjs",
    }:
        return tuple(
            SelectionTarget(capability)
            for capability in (
                Capability.POLICY,
                Capability.STATIC_WEB,
                Capability.KERNEL_WEB,
                Capability.COMPONENT,
            )
        )
    if path == "apps/web/next.config.ts" or (
        path.startswith("apps/web/e2e/")
        and not path.endswith((".journey.spec.ts", ".extension.spec.ts"))
    ):
        return tuple(
            SelectionTarget(capability)
            for capability in (
                Capability.POLICY,
                Capability.BUNDLE,
                Capability.JOURNEYS_ALL,
            )
        )
    if path.startswith("migrations/"):
        return (SelectionTarget(Capability.MIGRATIONS),)
    if path.startswith("docker/"):
        return tuple(
            SelectionTarget(capability)
            for capability in (
                Capability.POLICY,
                Capability.MIGRATIONS,
                Capability.SERVICE,
                Capability.COMPONENT,
                Capability.JOURNEYS_ALL,
            )
        )
    if path.startswith("testdata/faults/"):
        return (
            SelectionTarget(Capability.POLICY),
            SelectionTarget(Capability.POLICY_SELF_TESTS),
            SelectionTarget(Capability.SENSITIVITY),
        )
    if path.startswith("testdata/"):
        return (
            SelectionTarget(Capability.POLICY),
            SelectionTarget(Capability.CORPUS),
        )
    if path.startswith(".github/"):
        return (
            SelectionTarget(Capability.POLICY),
            SelectionTarget(Capability.STATIC_WORKFLOWS),
        )
    return ()


def _direct_test_target(path: str) -> SelectionTarget | None:
    python_direct = (
        ("python/tests/kernel/", Capability.KERNEL_PYTHON),
        ("python/tests/service/", Capability.SERVICE),
        ("python/tests/migrations/", Capability.MIGRATIONS),
        ("python/tests/evals/", Capability.LLM_EVAL),
        ("python/tests/audit/", Capability.AUDIT),
        ("python/tests/contract/", Capability.PROVIDER_RUNTIME),
        ("python/tests/hosted/release/", Capability.PROVIDER_CERTIFICATION),
        ("python/tests/hosted/nightly/", Capability.HOSTED),
    )
    for prefix, capability in python_direct:
        if path.startswith(prefix) and path.endswith(".py"):
            return SelectionTarget(capability, f"pytest:{path}")
    if path.endswith((".unit.test.ts", ".unit.test.tsx")):
        return SelectionTarget(Capability.KERNEL_WEB, f"vitest:{path}")
    if path.endswith((".browser.test.ts", ".browser.test.tsx")):
        return SelectionTarget(Capability.COMPONENT, f"vitest:{path}")
    if path.endswith(".journey.spec.ts"):
        return SelectionTarget(Capability.JOURNEYS_ALL, f"playwright:{path}")
    if path.endswith(".extension.spec.ts"):
        return SelectionTarget(Capability.EXTENSION, f"playwright:{path}")
    if path.startswith("apps/android/app/src/androidTest/") and path.endswith(".kt"):
        return SelectionTarget(Capability.ANDROID_DEVICE, f"gradle:{path}")
    if path.startswith("apps/android/app/src/test/") and path.endswith(".kt"):
        return SelectionTarget(Capability.ANDROID_HOST, f"gradle:{path}")
    return None


def _conservative_capability(path: str) -> Capability:
    if path.startswith("python/nexus/"):
        return Capability.SERVICE
    if path.startswith("apps/web/src/"):
        return Capability.COMPONENT
    if path.startswith("migrations/"):
        return Capability.MIGRATIONS
    if path.startswith("apps/android/"):
        return Capability.ANDROID_HOST
    return Capability.POLICY


def select_explicit_focus(
    focus: Iterable[str], resolve: SelectionResolver
) -> tuple[Selection, ...]:
    selections: list[Selection] = []
    for path_or_node in focus:
        if not path_or_node.strip():
            raise ValueError("explicit focus must not be blank")
        targets = tuple(resolve(path_or_node))
        if not targets:
            raise ValueError(f"explicit focus did not resolve: {path_or_node}")
        selections.extend(
            Selection(
                path_or_node,
                target.capability,
                SelectionReason.EXPLICIT_FOCUS,
                target.proof,
            )
            for target in targets
        )
    return tuple(selections)
