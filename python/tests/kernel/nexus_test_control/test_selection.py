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
    proof_target,
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


def test_release_artifact_python_proof_routes_to_its_protected_capability(
    tmp_path: Path,
) -> None:
    proof = "python/tests/release_artifact/test_image_binding.py"
    node = "test_worker_uses_the_baked_entrypoint"
    path = tmp_path / proof
    path.parent.mkdir(parents=True)
    path.write_text(f"def {node}():\n    pass\n")

    target = proof_target(tmp_path, f"pytest:{proof}::{node}")

    assert target == SelectionTarget(Capability.RELEASE_ARTIFACT, f"pytest:{proof}::{node}")


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
    "path",
    [
        "apps/web/androidPlayerProtocolCorpus.ts",
        "apps/web/src/app/android/page.tsx",
        "apps/web/src/lib/player/androidPlayerProtocol.ts",
        "apps/web/src/lib/player/nativeOperationPump.ts",
        "apps/android/app/src/main/java/app/nexus/android/playback/PlayerProtocol.kt",
        "deploy/hetzner/release.py",
        "python/nexus/release_artifact.py",
        "testdata/android/player-protocol.json",
    ],
)
def test_android_player_protocol_sources_route_the_cross_release_skew_proofs(
    path: str,
) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )
    owned = {
        (selection.capability, selection.proof)
        for selection in selections
        if selection.reason is SelectionReason.PRIORITY_RISK
    }

    assert owned.issuperset(
        {
            (
                Capability.KERNEL_WEB,
                "vitest:apps/web/src/lib/androidReleaseLinks.unit.test.ts",
            ),
            (
                Capability.COMPONENT,
                "vitest:apps/web/src/app/android/AndroidPage.browser.test.tsx",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/test_android_player_protocol_release_gate.py",
            ),
            (
                Capability.ANDROID_HOST,
                "gradle:apps/android/app/src/test/java/app/nexus/android/playback/PlayerProtocolTest.kt",
            ),
        }
    )


@pytest.mark.parametrize(
    "path",
    [
        "deploy/hetzner/docker-compose.yml",
        "python/tests/testkit/host_release.py",
        "python/tests/testkit/production_deploy.py",
    ],
)
def test_release_controller_sources_keep_routing_the_immutable_release_suites(
    path: str,
) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )
    proofs = {
        selection.proof
        for selection in selections
        if selection.reason is SelectionReason.PRIORITY_RISK
    }

    assert proofs.issuperset(
        {
            "pytest:python/tests/kernel/test_production_deploy_behavior.py",
            "pytest:python/tests/kernel/test_production_release.py",
        }
    )


@pytest.mark.parametrize("path", ["python/pyproject.toml", "python/uv.lock"])
def test_codex_dependency_changes_route_release_proofs_without_duplicate_host_ownership(
    path: str,
) -> None:
    selections = select_changed(
        parse_git_name_status(f"M\0{path}\0".encode()),
        load_selection_index(REPO_ROOT),
    )
    proofs = {selection.proof for selection in selections}

    assert "pytest:python/tests/kernel/test_production_release.py" in proofs
    assert (
        "pytest:python/tests/kernel/test_production_release.py::"
        "test_capacity_qualification_rejects_a_credentialed_or_networked_client_container"
        not in proofs
    )


@pytest.mark.parametrize(
    "path",
    [
        "python/pyproject.toml",
        "python/uv.lock",
        "python/tests/evals/cases/tool_safety.v3.json",
    ],
)
def test_provider_runtime_pin_and_tool_safety_corpus_route_to_deterministic_eval(
    path: str,
) -> None:
    proof = (
        "pytest:python/tests/evals/test_tool_safety_eval.py::"
        "test_injected_requests_cannot_authorize_a_foreign_mutating_tool_call"
    )

    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )

    assert any(
        selection.capability is Capability.LLM_EVAL
        and selection.proof == proof
        and selection.reason is SelectionReason.PRIORITY_RISK
        for selection in selections
    ), f"{path} did not select the deterministic llm-tool-safety proof"


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/codex-personal-nightly.yml",
        "apps/codex_agent/host.py",
        "apps/codex_agent/nested/future.py",
        "python/pyproject.toml",
        "python/nexus/services/native_agent_contract.py",
        "python/nexus/services/native_agent_client.py",
        "python/nexus/services/native_agent_operations.py",
        "python/nexus/ops/codex_hosted_evidence.py",
        "python/uv.lock",
    ],
)
def test_native_agent_sources_route_to_the_exact_contract_and_host_proofs(path: str) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )
    owned = {
        (selection.capability, selection.proof)
        for selection in selections
        if selection.reason is SelectionReason.PRIORITY_RISK
    }

    assert owned.issuperset(
        {
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/nexus_test_control/"
                "test_runner.py::"
                "test_codex_hosted_canary_evidence_accepts_only_its_bounded_canonical_shape",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/nexus_test_control/"
                "test_hosted_canary_semantics.py::"
                "test_hosted_canary_parser_rejects_green_cost_evidence_without_safe_semantics",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/nexus_test_control/"
                "test_provider_runtime_pin.py::"
                "test_provider_runtime_is_materialized_from_the_pin_without_retargeting_source",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/nexus_test_control/"
                "test_android_device_method_scope.py::"
                "test_exact_android_device_proof_uses_one_instrumentation_method",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/test_codex_hosted_canary_content_privacy.py::"
                "test_hosted_canary_rendered_failure_drops_provider_sentinels",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/test_codex_nightly_workflow_artifact_contract.py::"
                "test_codex_nightly_stages_only_one_run_bound_bounded_json_artifact",
            ),
            (
                Capability.KERNEL_PYTHON,
                "pytest:python/tests/kernel/test_native_agent_contract.py",
            ),
            (
                Capability.SERVICE,
                "pytest:python/tests/service/test_codex_agent_host.py",
            ),
            (
                Capability.SERVICE,
                "pytest:python/tests/service/test_codex_agent_content_privacy.py::"
                "test_provider_diagnostic_content_neither_crosses_the_host_nor_reaches_persistence",
            ),
            (
                Capability.SERVICE,
                "pytest:python/tests/service/test_codex_capacity_canary_contract.py::"
                "test_capacity_canary_rejects_succeeded_terminal_without_metadata_object",
            ),
            (
                Capability.CODEX_HOSTED,
                "pytest:python/tests/hosted/nightly/test_codex_personal_metadata.py",
            ),
        }
    )


def test_durable_metadata_sources_route_all_high_risk_boundary_proofs() -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, "python/nexus/errors.py"),),
        load_selection_index(REPO_ROOT),
    )
    proofs = {
        selection.proof
        for selection in selections
        if selection.reason is SelectionReason.PRIORITY_RISK
    }

    assert proofs.issuperset(
        {
            "pytest:python/tests/service/test_codex_metadata_failure_mapping.py::"
            "test_native_timeout_persists_as_a_distinct_metadata_failure",
            "pytest:python/tests/service/test_codex_metadata_enrichment.py",
            "pytest:python/tests/service/test_heavy_job_capacity.py",
            "pytest:python/tests/service/test_metadata_content_contract.py::"
            "test_metadata_contract_exposes_quality_bounds_and_all_media_kind_targets",
            "pytest:python/tests/service/test_metadata_prompt_framing.py",
            "pytest:python/tests/service/test_metadata_prompt_framing.py::"
            "test_metadata_prompt_preserves_envelope_and_delimiter_at_utf8_input_ceiling",
        }
    )


def test_unreachable_state_testkit_routes_to_the_durable_replay_proofs() -> None:
    """Risk: edits to the raw-SQL unreachable-state owner run no durability proof."""

    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, "python/tests/testkit/unreachable_state.py"),),
        load_selection_index(REPO_ROOT),
    )
    proofs = {
        selection.proof
        for selection in selections
        if selection.reason is SelectionReason.PRIORITY_RISK
    }

    assert proofs.issuperset(
        {
            "pytest:python/tests/service/test_codex_metadata_enrichment.py",
            "pytest:python/tests/service/test_durable_job_replay.py",
            "pytest:python/tests/service/test_heavy_job_capacity.py",
        }
    )


@pytest.mark.parametrize(
    ("path", "expected_proof"),
    [
        (
            "python/nexus/services/podcasts/ingest.py",
            "pytest:python/tests/service/test_codex_metadata_enrichment.py",
        ),
        (
            "deploy/hetzner/prove-codex-capacity.sh",
            "pytest:python/tests/kernel/test_production_release.py",
        ),
        (
            "docs/cutovers/codex-personal-metadata-hard-cutover.md",
            "pytest:python/tests/kernel/test_production_delivery_contract.py",
        ),
        (
            "docs/runbooks/codex-personal-agent-host.md",
            "pytest:python/tests/kernel/test_production_delivery_contract.py",
        ),
    ],
)
def test_capacity_enqueue_and_release_sources_keep_their_priority_owner(
    path: str,
    expected_proof: str,
) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )

    assert any(
        selection.proof == expected_proof and selection.reason is SelectionReason.PRIORITY_RISK
        for selection in selections
    )


@pytest.mark.parametrize(
    ("path", "expected_capabilities", "expected_proofs"),
    [
        (
            # The release controller mirrors the canary's public exit/phase
            # contract, so release.py is owned by native-agent-host as well as
            # immutable-production-release: its changes must route to the
            # mirror conformance proof and the host proofs beside the release
            # harness proofs.
            "deploy/hetzner/release.py",
            {
                Capability.CODEX_HOSTED,
                Capability.ANDROID_HOST,
                Capability.COMPONENT,
                Capability.JOURNEYS_ALL,
                Capability.KERNEL_PYTHON,
                Capability.KERNEL_WEB,
                Capability.LLM_TOOLS,
                Capability.RELEASE_ARTIFACT,
                Capability.SERVICE,
                Capability.STATIC_PLATFORM,
            },
            {
                "gradle:apps/android/app/src/test/java/app/nexus/android/offline/readingweb/OfflineReadingRequestRouterTest.kt",
                "gradle:apps/android/app/src/test/java/app/nexus/android/playback/PlayerProtocolTest.kt",
                "playwright:apps/web/e2e/journeys/auth-session.journey.spec.ts",
                "pytest:python/tests/hosted/nightly/test_codex_personal_metadata.py",
                "pytest:python/tests/kernel/nexus_test_control/test_android_device_method_scope.py::test_exact_android_device_proof_uses_one_instrumentation_method",
                "pytest:python/tests/kernel/nexus_test_control/test_hosted_canary_semantics.py::test_hosted_canary_parser_rejects_green_cost_evidence_without_safe_semantics",
                "pytest:python/tests/kernel/nexus_test_control/test_provider_runtime_pin.py::test_provider_runtime_is_materialized_from_the_pin_without_retargeting_source",
                "pytest:python/tests/kernel/nexus_test_control/test_runner.py::test_codex_hosted_canary_evidence_accepts_only_its_bounded_canonical_shape",
                "pytest:python/tests/kernel/test_android_player_protocol_release_gate.py",
                "pytest:python/tests/llm_tools_contract/test_pinned_llm_tools.py::"
                "test_exact_pins_round_trip_one_canonical_native_tool",
                "pytest:python/tests/kernel/nexus_test_control/test_llm_tools_capability.py::"
                "test_llm_tools_paths_route_to_exact_full_materialization",
                "pytest:python/tests/kernel/nexus_test_control/test_model.py::"
                "test_registry_is_exhaustive_and_keeps_specialized_cadence_out_of_pr",
                "pytest:python/tests/kernel/nexus_test_control/test_policy.py",
                "pytest:python/tests/kernel/test_backend_artifact.py",
                "pytest:python/tests/kernel/test_codex_hosted_canary_content_privacy.py::test_hosted_canary_rendered_failure_drops_provider_sentinels",
                "pytest:python/tests/kernel/test_codex_nightly_workflow_artifact_contract.py::test_codex_nightly_stages_only_one_run_bound_bounded_json_artifact",
                "pytest:python/tests/kernel/test_native_agent_contract.py",
                "pytest:python/tests/kernel/test_ci_pr_recovery.py",
                "pytest:python/tests/kernel/test_successor_release_contract.py",
                "pytest:python/tests/kernel/test_production_delivery_contract.py",
                "pytest:python/tests/kernel/test_production_deploy_behavior.py",
                "pytest:python/tests/kernel/test_production_release.py",
                "pytest:python/tests/kernel/test_production_release.py::test_codex_capacity_requires_exact_encrypted_state_before_starting_runtime",
                "pytest:python/tests/kernel/test_release_bundle_fetch.py",
                "pytest:python/tests/service/test_codex_agent_content_privacy.py::test_provider_diagnostic_content_neither_crosses_the_host_nor_reaches_persistence",
                "pytest:python/tests/service/test_codex_agent_host.py",
                "pytest:python/tests/service/test_codex_agent_host.py::test_host_refuses_non_admissible_capacity_before_runtime_construction",
                "pytest:python/tests/service/test_codex_capacity_canary_contract.py",
                "pytest:python/tests/service/test_codex_capacity_canary_contract.py::test_capacity_canary_rejects_succeeded_terminal_without_metadata_object",
                "pytest:python/tests/release_artifact/"
                "test_node_ingest_image_binding.py::"
                "test_worker_launches_only_the_image_baked_hardened_ingest_entrypoint",
                "pytest:python/tests/service/test_llm_tool_projection_protocol.py::"
                "test_revision_gates_every_changed_chat_projection_boundary",
                "pytest:python/tests/service/test_llm_tools_availability.py::"
                "test_keyless_boot_preserves_plan_and_refuses_required_web_before_dispatch",
                "vitest:apps/web/src/lib/androidReleaseLinks.unit.test.ts",
                "vitest:apps/web/src/app/android/AndroidPage.browser.test.tsx",
                "vitest:apps/web/src/components/chat/toolProjectionProtocol.browser.test.tsx",
                "pytest:python/tests/service/test_offline_reading_caddy_delivery.py::test_production_caddy_proxy_preserves_exact_package_identity_bytes_without_encoding",
                "vitest:apps/web/src/components/player/GlobalPlayerSurfaces.browser.test.tsx",
                "vitest:apps/web/src/lib/player/androidPlayerProtocol.unit.test.ts",
            },
        ),
        (
            "python/nexus/runtime_health.py",
            {
                Capability.COMPONENT,
                Capability.KERNEL_PYTHON,
                Capability.KERNEL_WEB,
                Capability.MIGRATIONS,
                Capability.SERVICE,
            },
            {
                "pytest:python/tests/kernel/test_bounded_resource_worker_contract.py",
                "pytest:python/tests/kernel/test_runtime_health.py",
                "pytest:python/tests/kernel/test_worker_runtime_health.py",
                "pytest:python/tests/migrations/test_document_import_reliability_migration.py::test_0220_0221_backfill_is_resumable_fail_closed_and_hard_contracts_schema",
                "pytest:python/tests/service/test_background_worker_process_containment.py::test_kernel_oom_and_timeout_are_terminally_fenced_before_next_fresh_child",
                "pytest:python/tests/service/test_bounded_media_extraction.py",
                "pytest:python/tests/service/test_ingest_reconciliation_readiness.py",
                "pytest:python/tests/service/test_media_activity.py::test_activity_projects_only_upload_obligations_with_strict_precedence",
                "pytest:python/tests/service/test_media_upload_sessions.py",
                "pytest:python/tests/service/test_background_worker_supervisor_liveness.py",
                "pytest:python/tests/service/test_epub2_doctype_entities_extraction.py",
                "pytest:python/tests/service/test_media_activity_published_upload_silence.py",
                "pytest:python/tests/service/test_media_activity_upload_badge_bound.py",
                "pytest:python/tests/service/test_upload_confirm_failed_fact.py",
                "pytest:python/tests/service/test_upload_confirm_replay_convergence.py",
                "pytest:python/tests/service/test_upload_verification_lease_renewal.py",
                "pytest:python/tests/service/test_upload_verification_lease_theft.py",
                "pytest:python/tests/service/test_runtime_health.py",
                "vitest:apps/web/src/components/nexus/MediaActivityPage.browser.test.tsx",
                "vitest:apps/web/src/lib/media/ingestionClient.unit.test.ts",
            },
        ),
        (
            "python/nexus/job_topology.py",
            {
                Capability.COMPONENT,
                Capability.KERNEL_PYTHON,
                Capability.KERNEL_WEB,
                Capability.MIGRATIONS,
                Capability.SERVICE,
            },
            {
                "pytest:python/tests/kernel/test_bounded_resource_worker_contract.py",
                "pytest:python/tests/kernel/test_runtime_health.py",
                "pytest:python/tests/kernel/test_worker_runtime_health.py",
                "pytest:python/tests/migrations/test_document_import_reliability_migration.py::test_0220_0221_backfill_is_resumable_fail_closed_and_hard_contracts_schema",
                "pytest:python/tests/service/test_background_worker_process_containment.py::test_kernel_oom_and_timeout_are_terminally_fenced_before_next_fresh_child",
                "pytest:python/tests/service/test_bounded_media_extraction.py",
                "pytest:python/tests/service/test_ingest_reconciliation_readiness.py",
                "pytest:python/tests/service/test_media_activity.py::test_activity_projects_only_upload_obligations_with_strict_precedence",
                "pytest:python/tests/service/test_media_upload_sessions.py",
                "pytest:python/tests/service/test_background_worker_supervisor_liveness.py",
                "pytest:python/tests/service/test_epub2_doctype_entities_extraction.py",
                "pytest:python/tests/service/test_media_activity_published_upload_silence.py",
                "pytest:python/tests/service/test_media_activity_upload_badge_bound.py",
                "pytest:python/tests/service/test_upload_confirm_failed_fact.py",
                "pytest:python/tests/service/test_upload_confirm_replay_convergence.py",
                "pytest:python/tests/service/test_upload_verification_lease_renewal.py",
                "pytest:python/tests/service/test_upload_verification_lease_theft.py",
                "pytest:python/tests/service/test_runtime_health.py",
                "vitest:apps/web/src/components/nexus/MediaActivityPage.browser.test.tsx",
                "vitest:apps/web/src/lib/media/ingestionClient.unit.test.ts",
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
            {
                Capability.CODEX_HOSTED,
                Capability.COMPONENT,
                Capability.KERNEL_PYTHON,
                Capability.LLM_TOOLS,
                Capability.RELEASE_ARTIFACT,
                Capability.SERVICE,
            },
            {
                "pytest:python/tests/llm_tools_contract/test_pinned_llm_tools.py::test_exact_pins_round_trip_one_canonical_native_tool",
                "pytest:python/tests/kernel/nexus_test_control/test_llm_tools_capability.py::test_llm_tools_paths_route_to_exact_full_materialization",
                "pytest:python/tests/kernel/nexus_test_control/test_model.py::test_registry_is_exhaustive_and_keeps_specialized_cadence_out_of_pr",
                "pytest:python/tests/kernel/nexus_test_control/test_policy.py",
                "pytest:python/tests/kernel/nexus_test_control/test_runner.py::test_codex_hosted_canary_evidence_accepts_only_its_bounded_canonical_shape",
                "pytest:python/tests/kernel/nexus_test_control/test_hosted_canary_semantics.py::test_hosted_canary_parser_rejects_green_cost_evidence_without_safe_semantics",
                "pytest:python/tests/kernel/nexus_test_control/test_provider_runtime_pin.py::test_provider_runtime_is_materialized_from_the_pin_without_retargeting_source",
                "pytest:python/tests/kernel/nexus_test_control/test_android_device_method_scope.py::test_exact_android_device_proof_uses_one_instrumentation_method",
                "pytest:python/tests/kernel/test_codex_hosted_canary_content_privacy.py::test_hosted_canary_rendered_failure_drops_provider_sentinels",
                "pytest:python/tests/kernel/test_codex_nightly_workflow_artifact_contract.py::test_codex_nightly_stages_only_one_run_bound_bounded_json_artifact",
                "pytest:python/tests/kernel/test_ci_pr_recovery.py",
                "pytest:python/tests/kernel/test_native_agent_contract.py",
                "pytest:python/tests/release_artifact/"
                "test_node_ingest_image_binding.py::"
                "test_worker_launches_only_the_image_baked_hardened_ingest_entrypoint",
                "pytest:python/tests/service/test_codex_agent_content_privacy.py::test_provider_diagnostic_content_neither_crosses_the_host_nor_reaches_persistence",
                "pytest:python/tests/service/test_codex_agent_host.py",
                "pytest:python/tests/service/test_codex_agent_host.py::test_host_refuses_non_admissible_capacity_before_runtime_construction",
                "pytest:python/tests/service/test_codex_capacity_canary_contract.py",
                "pytest:python/tests/service/test_codex_capacity_canary_contract.py::test_capacity_canary_rejects_succeeded_terminal_without_metadata_object",
                "pytest:python/tests/hosted/nightly/test_codex_personal_metadata.py",
                "pytest:python/tests/service/test_llm_tool_projection_protocol.py::"
                "test_revision_gates_every_changed_chat_projection_boundary",
                "pytest:python/tests/service/test_llm_tools_availability.py::"
                "test_keyless_boot_preserves_plan_and_refuses_required_web_before_dispatch",
                "vitest:apps/web/src/components/chat/toolProjectionProtocol.browser.test.tsx",
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


@pytest.mark.parametrize(
    "path",
    [
        "python/nexus/api/routes/offline_reading.py",
        "python/nexus/services/offline_reading_delivery.py",
        "python/nexus/services/offline_reading_packages.py",
    ],
)
def test_offline_reading_package_sources_route_the_full_service_boundary(path: str) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )

    assert ("pytest:python/tests/service/test_offline_reading_package_delivery.py") in {
        selection.proof for selection in selections
    }


def test_production_caddyfile_routes_the_real_proxy_process_proof() -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, "deploy/hetzner/Caddyfile"),),
        load_selection_index(REPO_ROOT),
    )

    assert (
        "pytest:python/tests/service/test_offline_reading_caddy_delivery.py::"
        "test_production_caddy_proxy_preserves_exact_package_identity_bytes_without_encoding"
    ) in {selection.proof for selection in selections}


@pytest.mark.parametrize(
    "path",
    [
        "python/nexus/schemas/resource_action_snapshots.py",
        "python/nexus/services/resource_items/action_snapshots.py",
    ],
)
def test_resource_action_snapshot_sources_route_the_service_proof(path: str) -> None:
    selections = select_changed(
        (ChangedPath(GitChangeKind.MODIFIED, path),),
        load_selection_index(REPO_ROOT),
    )

    # One exact priority node owns this service file. A single proof path may
    # not be registered under multiple nodes because sensitivity must mutate
    # and execute one canonical owner deterministically.
    assert (
        "pytest:python/tests/service/test_resource_action_snapshots.py::"
        "test_document_media_subtypes_publish_their_exact_action_families"
    ) in {selection.proof for selection in selections}


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
