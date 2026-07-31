"""Block ordinary deploys from crossing migrations that require an operator cutover."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


@dataclass(frozen=True)
class ManualReleaseGate:
    revision: str
    workflow: str
    instructions: str


MANUAL_RELEASE_GATES = (
    ManualReleaseGate(
        revision="0199",
        workflow="PaneVisitWorkspaceSession",
        instructions="deployment.md#pane-visit-workspace-session-hard-cut",
    ),
    ManualReleaseGate(
        revision="0201",
        workflow="BrowseAcquisition",
        instructions=(
            "docs/cutovers/"
            "browse-discovery-preview-acquisition-hard-cutover.md#migration-and-deployment"
        ),
    ),
    ManualReleaseGate(
        revision="0202",
        workflow="BrowseAcquisition",
        instructions=(
            "docs/cutovers/"
            "browse-discovery-preview-acquisition-hard-cutover.md#migration-and-deployment"
        ),
    ),
    ManualReleaseGate(
        revision="0203",
        workflow="PodcastFreshness",
        instructions="deployment.md#podcast-freshness-revision-0203-hard-cut",
    ),
)


def load_script_directory(script_location: Path) -> ScriptDirectory:
    config = Config()
    config.set_main_option("script_location", str(script_location))
    return ScriptDirectory.from_config(config)


def pending_manual_release_gates(
    *,
    current_revision: str,
    script_directory: ScriptDirectory,
) -> tuple[ManualReleaseGate, ...]:
    pending_revisions = {
        script.revision
        for script in script_directory.iterate_revisions(
            script_directory.get_current_head(),
            current_revision,
        )
    }
    return tuple(gate for gate in MANUAL_RELEASE_GATES if gate.revision in pending_revisions)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.deployment_migrations")
    parser.add_argument("--current", required=True)
    parser.add_argument(
        "--script-location",
        type=Path,
        default=Path("/app/migrations/alembic"),
    )
    args = parser.parse_args()
    gates = pending_manual_release_gates(
        current_revision=args.current,
        script_directory=load_script_directory(args.script_location),
    )
    if not gates:
        print(f"migration_release_gate=ready current={args.current}")
        return

    details = "\n".join(
        (f"- revision={gate.revision} workflow={gate.workflow} instructions={gate.instructions}")
        for gate in gates
    )
    raise SystemExit(
        "ordinary deploy cannot cross operator-owned migrations; "
        "complete the required stopped-world workflows first:\n"
        f"{details}"
    )


if __name__ == "__main__":
    main()
