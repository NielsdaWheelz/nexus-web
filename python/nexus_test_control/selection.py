import os
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
    path: str
    target: SelectionTarget
    reason: SelectionReason


@dataclass(frozen=True, slots=True)
class SelectionIndex:
    routes: tuple[IndexedRoute, ...] = ()

    def for_path(self, path: str) -> tuple[IndexedRoute, ...]:
        return tuple(route for route in self.routes if route.path == path)


EMPTY_SELECTION_INDEX = SelectionIndex()


SelectionResolver = Callable[[str], Iterable[SelectionTarget]]


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
                        route.reason is SelectionReason.CHANGED_TEST and change.requires_sensitivity
                    ),
                )
            )
    return tuple(selections)


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
        ("python/tests/hosted/", Capability.HOSTED),
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
