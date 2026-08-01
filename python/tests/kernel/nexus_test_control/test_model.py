from dataclasses import FrozenInstanceError

import pytest

from nexus_test_control.model import (
    DEFERRED_CAPABILITY_OWNER,
    PRIORITY_RISK_FLOOR,
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    Selection,
    SelectionReason,
    SelectionScope,
    Workflow,
    aggregate_status,
)


def test_registry_is_exhaustive_and_keeps_specialized_cadence_out_of_pr() -> None:
    assert set(WORKFLOW_REGISTRY) == set(Workflow)
    assert set(PriorityRisk.value for PriorityRisk in PRIORITY_RISK_FLOOR) == {
        "test-environment-isolation",
        "auth-privacy-secrets",
        "destructive-side-effects",
        "migration-compatibility",
        "costly-effects",
        "reading-progress",
        "citation-provenance-identity",
        "durable-job-replay",
        "database-object-convergence",
        "llm-tool-safety",
        "native-release-auth-handoff",
        "native-system-insets",
    }
    pr_capabilities = {
        requirement.capability for requirement in WORKFLOW_REGISTRY[Workflow.PR].requirements
    }
    assert Capability.HOSTED not in pr_capabilities
    assert Capability.ANDROID_DEVICE not in pr_capabilities
    assert Capability.PROVIDER_CERTIFICATION not in pr_capabilities
    assert Capability.JOURNEYS_CRITICAL in pr_capabilities
    assert Capability.JOURNEYS_ALL not in pr_capabilities


def test_confidence_keeps_real_stack_affected_and_skips_build_and_journeys() -> None:
    requirements = WORKFLOW_REGISTRY[Workflow.CONFIDENCE].requirements
    by_capability = {requirement.capability: requirement.scope for requirement in requirements}

    assert by_capability[Capability.SERVICE] is SelectionScope.AFFECTED
    assert by_capability[Capability.COMPONENT] is SelectionScope.AFFECTED
    assert Capability.BUNDLE not in by_capability
    assert Capability.JOURNEYS_CRITICAL not in by_capability
    assert Capability.JOURNEYS_ALL not in by_capability


def test_changed_owns_only_directly_affected_edit_loop_proofs() -> None:
    requirements = WORKFLOW_REGISTRY[Workflow.CHANGED].requirements
    by_capability = {requirement.capability: requirement.scope for requirement in requirements}

    assert {
        capability
        for capability, scope in by_capability.items()
        if scope is SelectionScope.AFFECTED
    } == {
        Capability.POLICY_SELF_TESTS,
        Capability.KERNEL_PYTHON,
        Capability.KERNEL_WEB,
        Capability.SERVICE,
        Capability.COMPONENT,
        Capability.MIGRATIONS,
        Capability.JOURNEYS_ALL,
    }


def test_deferred_capability_owners_exist_in_their_authoritative_workflow() -> None:
    for capability, workflow in DEFERRED_CAPABILITY_OWNER.items():
        assert capability in {
            requirement.capability for requirement in WORKFLOW_REGISTRY[workflow].requirements
        }


def test_persistent_browser_processes_are_the_final_contiguous_heavy_block() -> None:
    for workflow in (Workflow.FULL, Workflow.NIGHTLY, Workflow.RELEASE):
        capabilities = tuple(
            requirement.capability for requirement in WORKFLOW_REGISTRY[workflow].requirements
        )
        assert capabilities[-2:] == (Capability.JOURNEYS_ALL, Capability.EXTENSION)


def test_run_status_never_turns_not_run_or_empty_into_pass() -> None:
    assert aggregate_status(()) is RunStatus.NOT_RUN
    assert aggregate_status((RunStatus.PASS, RunStatus.NOT_RUN)) is RunStatus.NOT_RUN
    assert aggregate_status((RunStatus.NOT_RUN, RunStatus.FAIL)) is RunStatus.FAIL
    assert aggregate_status((RunStatus.PASS, RunStatus.PASS)) is RunStatus.PASS


def test_registry_definitions_are_frozen() -> None:
    definition = WORKFLOW_REGISTRY[Workflow.PR]
    with pytest.raises(FrozenInstanceError):
        definition.workflow = Workflow.FULL  # type: ignore[misc]  # justify-type-assertion: runtime immutability is the behavior under proof.
    with pytest.raises(TypeError):
        WORKFLOW_REGISTRY[Workflow.PR] = definition  # type: ignore[index]  # justify-type-assertion: runtime mapping immutability is the behavior under proof.


def test_selection_rejects_parent_traversal() -> None:
    with pytest.raises(ValueError, match="repository-relative"):
        Selection("../outside.py", Capability.KERNEL_PYTHON, SelectionReason.EXPLICIT_FOCUS)
