import json
from pathlib import Path

import pytest

from nexus_test_control.model import Capability, SelectionReason
from nexus_test_control.selection import (
    ChangedPath,
    GitChangeKind,
    IndexedRoute,
    SelectionIndex,
    SelectionTarget,
    load_selection_index,
    parse_git_name_status,
    select_changed,
    select_explicit_focus,
)

REPO_ROOT = Path(__file__).parents[4]


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
                    "python/tests/kernel/old.py",
                    SelectionTarget(Capability.SERVICE, "old-owner"),
                    SelectionReason.PYTHON_OWNER,
                ),
                IndexedRoute(
                    "python/tests/kernel/deleted.py",
                    SelectionTarget(Capability.SERVICE, "owner"),
                    SelectionReason.PYTHON_OWNER,
                ),
            )
        ),
    )

    assert [selection.path for selection in selections] == [
        "python/tests/kernel/old.py",
        "python/tests/kernel/new.py",
        "python/tests/kernel/deleted.py",
        "python/tests/kernel/edited_old.py",
        "python/tests/kernel/edited_new.py",
    ]
    assert changes[0].requires_sensitivity is False
    assert changes[1].requires_sensitivity is False
    assert changes[2].requires_sensitivity is True
    assert selections[1].sensitivity_required is False
    assert selections[4].sensitivity_required is True


def test_test_looking_web_source_always_selects_repository_discovery_policy() -> None:
    path = "apps/web/src/lib/reader/not-discoverable.test.tsx"

    selections = select_changed(parse_git_name_status(f"M\0{path}\0".encode()))

    assert any(selection.capability is Capability.POLICY for selection in selections)


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


def test_frontend_source_selects_static_related_component_and_manifest_journey() -> None:
    path = "apps/web/src/components/nexus/Nexus.tsx"
    selections = select_changed(
        parse_git_name_status(f"M\0{path}\0".encode()),
        SelectionIndex(
            routes=(
                IndexedRoute(
                    "apps/web/src/components/nexus/**/*",
                    SelectionTarget(
                        Capability.JOURNEYS_ALL,
                        "playwright:apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts",
                    ),
                    SelectionReason.JOURNEY_OWNER,
                ),
            )
        ),
    )

    assert [(selection.capability, selection.reason) for selection in selections] == [
        (Capability.JOURNEYS_ALL, SelectionReason.JOURNEY_OWNER),
        (Capability.COMPONENT, SelectionReason.FRONTEND_RELATED),
    ]


def test_deleted_frontend_source_promotes_complete_component_proof() -> None:
    path = "apps/web/src/components/nexus/Removed.tsx"
    selections = select_changed(parse_git_name_status(f"D\0{path}\0".encode()))

    assert [(selection.capability, selection.reason) for selection in selections] == [
        (Capability.COMPONENT, SelectionReason.PROMOTED_CAPABILITY)
    ]


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


def test_direct_test_selects_discovery_policy_without_product_source_routes() -> None:
    path = "apps/web/src/lib/player/playerSession.unit.test.ts"
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        SelectionIndex(
            routes=(
                IndexedRoute(
                    "apps/web/src/lib/player/**/*.ts",
                    SelectionTarget(
                        Capability.JOURNEYS_ALL,
                        "playwright:apps/web/e2e/journeys/podcast.journey.spec.ts",
                    ),
                    SelectionReason.JOURNEY_OWNER,
                ),
            )
        ),
    )

    assert [(selection.capability, selection.proof) for selection in selections] == [
        (Capability.POLICY, None),
        (Capability.KERNEL_WEB, f"vitest:{path}"),
    ]


@pytest.mark.parametrize(
    "path",
    [
        "python/tests/hosted/nightly/test_openai_canary.py",
        "python/tests/hosted/release/test_provider_certification.py",
        "apps/android/app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt",
    ],
)
def test_paid_and_device_proof_never_enters_pr_sensitivity(path: str) -> None:
    selection = select_changed(parse_git_name_status(f"M\0{path}\0".encode()))
    assert len(selection) == 1
    assert selection[0].sensitivity_required is False


def test_priority_manifest_globs_route_root_and_nested_sources_to_exact_proof(
    tmp_path: Path,
) -> None:
    proof = tmp_path / "python/tests/service/test_auth_privacy.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_privacy():\n    pass\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [
                    {
                        "id": "auth-privacy-secrets",
                        "source_globs": ["python/nexus/auth/**/*.py"],
                        "proofs": [
                            "pytest:python/tests/service/test_auth_privacy.py::test_privacy"
                        ],
                        "capabilities": ["service"],
                    }
                ],
                "journeys": [],
            }
        )
    )
    index = load_selection_index(tmp_path)

    selections = select_changed(
        parse_git_name_status(
            b"M\0python/nexus/auth/verifier.py\0M\0python/nexus/auth/oauth/callback.py\0"
        ),
        index,
    )

    assert [selection.proof for selection in selections] == [
        "pytest:python/tests/service/test_auth_privacy.py::test_privacy",
        "pytest:python/tests/service/test_auth_privacy.py::test_privacy",
    ]
    assert {selection.reason for selection in selections} == {SelectionReason.PRIORITY_RISK}


@pytest.mark.parametrize(
    ("path", "expected_capabilities", "expected_proofs"),
    [
        (
            "deploy/hetzner/release.py",
            {
                Capability.JOURNEYS_ALL,
                Capability.KERNEL_PYTHON,
                Capability.STATIC_PLATFORM,
            },
            {
                "playwright:apps/web/e2e/journeys/auth-session.journey.spec.ts",
                "pytest:python/tests/kernel/test_backend_artifact.py",
                "pytest:python/tests/kernel/test_successor_release_contract.py",
                "pytest:python/tests/kernel/test_production_delivery_contract.py",
                "pytest:python/tests/kernel/test_production_deploy_behavior.py",
                "pytest:python/tests/kernel/test_production_release.py",
                "pytest:python/tests/kernel/test_release_bundle_fetch.py",
            },
        ),
        (
            "python/nexus/runtime_health.py",
            {
                Capability.KERNEL_PYTHON,
                Capability.SERVICE,
            },
            {
                "pytest:python/tests/kernel/test_runtime_health.py",
                "pytest:python/tests/kernel/test_worker_runtime_health.py",
                "pytest:python/tests/service/test_runtime_health.py",
            },
        ),
        (
            "python/nexus/ops/oracle_reconcile.py",
            {
                Capability.KERNEL_PYTHON,
                Capability.MIGRATIONS,
                Capability.SERVICE,
                Capability.STATIC_PLATFORM,
            },
            {
                "pytest:python/tests/kernel/test_oracle_host_release.py",
                "pytest:python/tests/kernel/test_oracle_manifest.py",
                "pytest:python/tests/kernel/test_oracle_reconcile_contract.py",
                "pytest:python/tests/migrations/test_oracle_publication_migration.py",
                "pytest:python/tests/service/test_oracle_publication.py",
            },
        ),
        (
            "python/nexus_test_control/runner.py",
            {Capability.KERNEL_PYTHON},
            {
                "pytest:python/tests/kernel/nexus_test_control/test_model.py::test_registry_is_exhaustive_and_keeps_specialized_cadence_out_of_pr",
                "pytest:python/tests/kernel/nexus_test_control/test_policy.py",
                "pytest:python/tests/kernel/test_ci_pr_recovery.py",
            },
        ),
    ],
)
def test_production_risks_route_only_their_owned_proof_partition(
    path: str,
    expected_capabilities: set[Capability],
    expected_proofs: set[str],
) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )
    owned = [
        selection for selection in selections if selection.reason is SelectionReason.PRIORITY_RISK
    ]

    assert {selection.capability for selection in owned} == expected_capabilities
    assert {
        selection.proof for selection in owned if selection.proof is not None
    } == expected_proofs


def test_journey_manifest_routes_lazy_pane_source_to_its_exact_browser_proof(
    tmp_path: Path,
) -> None:
    proof = tmp_path / "apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts"
    proof.parent.mkdir(parents=True)
    proof.write_text("test('open', () => {});\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [],
                "journeys": [
                    {
                        "id": "nexus-search-open-restore",
                        "proof": (
                            "apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts"
                        ),
                        "risks": [],
                        "source_globs": ["apps/web/src/lib/panes/paneRenderRegistry.tsx"],
                    }
                ],
            }
        )
    )

    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, "apps/web/src/lib/panes/paneRenderRegistry.tsx"),),
        load_selection_index(tmp_path),
    )

    assert any(
        selection.capability is Capability.JOURNEYS_ALL
        and selection.proof
        == ("playwright:apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts")
        and selection.reason is SelectionReason.JOURNEY_OWNER
        for selection in selections
    )


def test_priority_manifest_rejects_a_missing_exact_pytest_node(tmp_path: Path) -> None:
    proof = tmp_path / "python/tests/service/test_auth_privacy.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_real():\n    pass\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [
                    {
                        "id": "auth-privacy-secrets",
                        "source_globs": ["python/nexus/auth/**/*.py"],
                        "proofs": [
                            "pytest:python/tests/service/test_auth_privacy.py::test_missing"
                        ],
                        "capabilities": ["service"],
                    }
                ],
                "journeys": [],
            }
        )
    )

    with pytest.raises(ValueError, match="no exact pytest node"):
        load_selection_index(tmp_path)


def test_priority_manifest_rejects_nonstatic_capability_without_a_proof_owner(
    tmp_path: Path,
) -> None:
    proof = tmp_path / "python/tests/service/test_auth_privacy.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_privacy():\n    pass\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [
                    {
                        "id": "auth-privacy-secrets",
                        "source_globs": ["python/nexus/auth/**/*.py"],
                        "proofs": [
                            "pytest:python/tests/service/test_auth_privacy.py::test_privacy"
                        ],
                        "capabilities": ["service", "android-release"],
                    }
                ],
                "journeys": [],
            }
        )
    )

    with pytest.raises(ValueError, match="proof or direct static gate owner"):
        load_selection_index(tmp_path)


def test_priority_manifest_routes_declared_static_platform_with_proof_owners(
    tmp_path: Path,
) -> None:
    proof = tmp_path / "python/tests/service/test_release.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_release():\n    pass\n")
    manifest = tmp_path / "testdata/proofs.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "priority_risks": [
                    {
                        "id": "immutable-production-release",
                        "source_globs": ["deploy/hetzner/**/*"],
                        "proofs": ["pytest:python/tests/service/test_release.py::test_release"],
                        "capabilities": ["service", "static-platform"],
                    }
                ],
                "journeys": [],
            }
        )
    )

    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, "deploy/hetzner/deploy.sh"),),
        load_selection_index(tmp_path),
    )

    assert {(item.capability, item.proof) for item in selections} == {
        (
            Capability.SERVICE,
            "pytest:python/tests/service/test_release.py::test_release",
        ),
        (Capability.STATIC_PLATFORM, None),
    }
