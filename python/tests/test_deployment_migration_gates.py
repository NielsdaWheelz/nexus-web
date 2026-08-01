"""Release gates for migrations that cannot run inside an ordinary deploy."""

from pathlib import Path

import pytest

from nexus.ops.deployment_migrations import (
    load_script_directory,
    pending_manual_release_gates,
)

pytestmark = pytest.mark.unit

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_DIRECTORY = load_script_directory(_ROOT / "migrations" / "alembic")


@pytest.mark.parametrize(
    ("current_revision", "expected_revisions"),
    [
        ("base", ("0199", "0201", "0202", "0203", "0208")),
        ("0197", ("0199", "0201", "0202", "0203", "0208")),
        ("0200", ("0201", "0202", "0203", "0208")),
        ("0201", ("0202", "0203", "0208")),
        ("0202", ("0203", "0208")),
        ("0203", ("0208",)),
        ("0205", ("0208",)),
        ("0207", ("0208",)),
        ("0208", ()),
    ],
)
def test_pending_manual_release_gates_follow_migration_ancestry(
    current_revision: str,
    expected_revisions: tuple[str, ...],
):
    gates = pending_manual_release_gates(
        current_revision=current_revision,
        script_directory=_SCRIPT_DIRECTORY,
    )

    assert tuple(gate.revision for gate in gates) == expected_revisions


def test_every_manual_release_gate_points_to_owned_instructions():
    gates = pending_manual_release_gates(
        current_revision="0197",
        script_directory=_SCRIPT_DIRECTORY,
    )

    assert all(gate.workflow for gate in gates)
    assert all(
        gate.instructions.endswith(("hard-cut", "migration-and-deployment")) for gate in gates
    )
