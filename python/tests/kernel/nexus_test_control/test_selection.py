import pytest

from nexus_test_control.model import Capability, SelectionReason
from nexus_test_control.selection import (
    IndexedRoute,
    SelectionIndex,
    SelectionTarget,
    parse_git_name_status,
    select_changed,
    select_explicit_focus,
)


def test_pure_rename_routes_new_path_and_deletion_routes_owner_not_missing_test() -> None:
    changes = parse_git_name_status(
        b"R100\0python/tests/kernel/old.py\0python/tests/kernel/new.py\0"
        b"D\0python/tests/kernel/deleted.py\0"
        b"R087\0python/tests/kernel/edited_old.py\0python/tests/kernel/edited_new.py\0"
    )
    selections = select_changed(
        changes,
        SelectionIndex(
            routes=(
                IndexedRoute(
                    "python/tests/kernel/deleted.py",
                    SelectionTarget(Capability.SERVICE, "owner"),
                    SelectionReason.PYTHON_OWNER,
                ),
            )
        ),
    )

    assert [selection.path for selection in selections] == [
        "python/tests/kernel/new.py",
        "python/tests/kernel/deleted.py",
        "python/tests/kernel/edited_new.py",
    ]
    assert changes[0].requires_sensitivity is False
    assert changes[1].requires_sensitivity is False
    assert changes[2].requires_sensitivity is True
    assert selections[0].sensitivity_required is False
    assert selections[2].sensitivity_required is True


def test_lazy_pane_index_maps_dynamic_source_when_static_related_has_no_edge() -> None:
    path = "apps/web/src/panes/reader/ReaderPane.tsx"
    selections = select_changed(
        parse_git_name_status(f"M\0{path}\0".encode()),
        SelectionIndex(
            routes=(
                IndexedRoute(
                    path,
                    SelectionTarget(
                        Capability.JOURNEYS_CRITICAL,
                        "apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts",
                    ),
                    SelectionReason.LAZY_PANE,
                ),
            )
        ),
    )

    assert len(selections) == 1
    assert selections[0].reason is SelectionReason.LAZY_PANE


def test_explicit_focus_fails_closed_when_target_does_not_resolve() -> None:
    with pytest.raises(ValueError, match="did not resolve"):
        select_explicit_focus(("unknown::proof",), lambda _focus: ())


def test_git_parser_rejects_unknown_status() -> None:
    with pytest.raises(ValueError, match="unsupported git change status"):
        parse_git_name_status(b"X\0mystery.py\0")


def test_unmapped_product_change_routes_conservatively() -> None:
    selections = select_changed(parse_git_name_status(b"M\0python/nexus/new_owner.py\0"))
    assert [(item.capability, item.reason) for item in selections] == [
        (Capability.SERVICE, SelectionReason.PROMOTED_CAPABILITY)
    ]


def test_control_plane_change_promotes_complete_policy_and_kernel() -> None:
    selections = select_changed(parse_git_name_status(b"M\0python/nexus_test_control/policy.py\0"))
    assert {item.capability for item in selections} == {
        Capability.POLICY,
        Capability.POLICY_SELF_TESTS,
        Capability.KERNEL_PYTHON,
    }


def test_direct_extension_does_not_also_select_all_journeys() -> None:
    selections = select_changed(
        parse_git_name_status(b"M\0apps/web/e2e/extension/reader.extension.spec.ts\0")
    )
    assert [item.capability for item in selections] == [Capability.EXTENSION]
