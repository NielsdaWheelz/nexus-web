"""Tests for chat-owned source boundary policy."""

import pytest
from pydantic import ValidationError

from nexus.schemas.conversation import SourceBoundaryPolicyOut
from nexus.services.chat_retrieval_plan import (
    SOURCE_BOUNDARY_POLICY_VERSION,
    evaluate_source_boundary_policy,
    explicit_saved_web_mix_requested,
    plan_chat_retrieval,
    source_domain_for_tool,
    validate_source_boundary_policy,
)
from nexus.services.chat_tool_source_policy import validate_tool_source_policy

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("tool_name", "source_domain"),
    [
        ("app_search", "private_app"),
        ("read_resource", "private_app"),
        ("inspect_resource", "private_app"),
        ("attached_resources", "private_app"),
        ("web_search", "public_web"),
        ("future_tool", "provider_control"),
    ],
)
def test_tool_source_domain_mapping(tool_name: str, source_domain: str) -> None:
    assert source_domain_for_tool(tool_name) == source_domain


@pytest.mark.parametrize(
    "user_text",
    [
        "compare my saved sources with the web",
        "compare my saved sources with online sources",
        "compare my saved notes against internet news",
        "check this against current web sources",
        "use my notes and current public sources",
        "what do my sources say, and what does the web say now?",
    ],
)
def test_explicit_saved_web_mix_requested(user_text: str) -> None:
    assert explicit_saved_web_mix_requested(user_text, has_private_anchor=True)


@pytest.mark.parametrize(
    "user_text",
    [
        "research this",
        "look up this topic",
        "find my saved notes",
        "search the web for news",
        "compare my saved notes about public health",
    ],
)
def test_generic_research_is_not_explicit_saved_web_mix(user_text: str) -> None:
    assert not explicit_saved_web_mix_requested(user_text, has_private_anchor=False)


def test_source_policy_blocks_same_batch_private_public_mix() -> None:
    plan = plan_chat_retrieval(
        user_text="What do my saved sources say?",
        context_ref_uris=[],
        subject_ref=None,
        reader_selection_present=False,
        web_search_available=True,
    )

    policy = evaluate_source_boundary_policy(
        plan=plan,
        pending_tool_names=("app_search", "web_search"),
        domains_seen=(),
    )

    assert policy.as_json() == {
        "version": SOURCE_BOUNDARY_POLICY_VERSION,
        "decision": "blocked",
        "source_domain": "public_web",
        "mixing_allowed": False,
        "reason": "would_mix_private_app_with_public_web",
        "domains_seen": [],
        "requested_domains": ["private_app", "public_web"],
    }


def test_source_policy_allows_explicit_private_public_mix() -> None:
    user_text = "Compare my saved notes against web news."
    plan = plan_chat_retrieval(
        user_text=user_text,
        context_ref_uris=[],
        subject_ref=None,
        reader_selection_present=False,
        web_search_available=True,
    )

    policy = evaluate_source_boundary_policy(
        plan=plan,
        pending_tool_names=("app_search", "web_search"),
        domains_seen=(),
    )

    assert policy.decision == "allowed"
    assert policy.mixing_allowed
    assert policy.reason == "explicit_saved_source_web_comparison"


def test_source_policy_allows_explicit_mix_from_reader_selection_anchor() -> None:
    # A reader selection is a private anchor the planner sees, but it never appears
    # in the persisted context_ref_count/search_scope_count projection. The gate
    # must honor the planner's persisted explicit-mix verdict instead of re-deriving
    # it from that lossy projection, otherwise it would block a mix the planner
    # already authorized for the same turn (fail-closed divergence).
    user_text = "Compare this against the web."
    plan = plan_chat_retrieval(
        user_text=user_text,
        context_ref_uris=[],
        subject_ref=None,
        reader_selection_present=True,
        web_search_available=True,
    )
    assert plan.route_intent == "explicit_private_public_comparison"
    assert plan.mixing_policy == "explicit_mixed"
    assert plan.context_ref_count == 0
    assert plan.search_scope_count == 0

    policy = evaluate_source_boundary_policy(
        plan=plan,
        pending_tool_names=("app_search", "web_search"),
        domains_seen=(),
    )

    assert policy.decision == "allowed"
    assert policy.mixing_allowed
    assert policy.reason == "explicit_saved_source_web_comparison"


def test_saved_web_result_via_app_search_remains_private_app() -> None:
    policy = evaluate_source_boundary_policy(
        plan=plan_chat_retrieval(
            user_text="Find my saved web articles.",
            context_ref_uris=[],
            subject_ref=None,
            reader_selection_present=False,
            web_search_available=True,
        ),
        pending_tool_names=("app_search",),
        domains_seen=(),
    )

    assert policy.decision == "allowed"
    assert policy.source_domain == "private_app"
    assert policy.requested_domains == ("private_app",)


def test_source_boundary_policy_validation_rejects_mismatched_domain() -> None:
    with pytest.raises(AssertionError, match="domain mismatch"):
        validate_source_boundary_policy(
            source_domain="public_web",
            source_policy={
                "version": SOURCE_BOUNDARY_POLICY_VERSION,
                "decision": "allowed",
                "source_domain": "private_app",
                "mixing_allowed": False,
                "reason": "single_domain_private_app",
                "domains_seen": [],
                "requested_domains": ["private_app"],
            },
        )


def test_source_boundary_policy_validation_rejects_extra_keys() -> None:
    with pytest.raises(AssertionError, match="keys mismatch"):
        validate_source_boundary_policy(
            source_domain="private_app",
            source_policy={
                "version": SOURCE_BOUNDARY_POLICY_VERSION,
                "decision": "allowed",
                "source_domain": "private_app",
                "mixing_allowed": False,
                "reason": "single_domain_private_app",
                "domains_seen": [],
                "requested_domains": ["private_app"],
                "debug": "not part of the contract",
            },
        )


def test_source_boundary_policy_validation_rejects_missing_keys() -> None:
    policy = {
        "version": SOURCE_BOUNDARY_POLICY_VERSION,
        "decision": "allowed",
        "source_domain": "private_app",
        "mixing_allowed": False,
        "reason": "single_domain_private_app",
        "domains_seen": [],
        "requested_domains": ["private_app"],
    }
    del policy["version"]

    with pytest.raises(AssertionError, match="keys mismatch"):
        validate_source_boundary_policy(source_domain="private_app", source_policy=policy)


def test_source_boundary_policy_validation_rejects_non_object_json() -> None:
    with pytest.raises(AssertionError, match="must be an object"):
        validate_source_boundary_policy(
            source_domain="private_app",
            source_policy=[
                ("version", SOURCE_BOUNDARY_POLICY_VERSION),
                ("decision", "allowed"),
                ("source_domain", "private_app"),
                ("mixing_allowed", False),
                ("reason", "single_domain_private_app"),
                ("domains_seen", []),
                ("requested_domains", ["private_app"]),
            ],
        )


@pytest.mark.parametrize(
    ("policy_patch", "message"),
    [
        ({"version": "source_boundary_policy.v0"}, "version mismatch"),
        ({"decision": "maybe"}, "decision mismatch"),
        ({"mixing_allowed": "false"}, "mixing_allowed must be boolean"),
        ({"domains_seen": "private_app"}, "domains_seen must be a list"),
        ({"requested_domains": "private_app"}, "requested_domains must be a list"),
        (
            {"domains_seen": ["private_app", "provider_control"]},
            "domains_seen contains unsupported domain",
        ),
        (
            {"requested_domains": ["provider_control"]},
            "requested_domains contains unsupported domain",
        ),
    ],
)
def test_source_boundary_policy_validation_rejects_malformed_policy_shapes(
    policy_patch: dict[str, object],
    message: str,
) -> None:
    policy = {
        "version": SOURCE_BOUNDARY_POLICY_VERSION,
        "decision": "allowed",
        "source_domain": "private_app",
        "mixing_allowed": False,
        "reason": "single_domain_private_app",
        "domains_seen": [],
        "requested_domains": ["private_app"],
        **policy_patch,
    }

    with pytest.raises(AssertionError, match=message):
        validate_source_boundary_policy(source_domain="private_app", source_policy=policy)


def test_tool_source_policy_validation_rejects_tool_domain_mismatch() -> None:
    with pytest.raises(AssertionError, match="web_search source_domain must be public_web"):
        validate_tool_source_policy(
            tool_name="web_search",
            source_domain="private_app",
            source_policy={
                "version": SOURCE_BOUNDARY_POLICY_VERSION,
                "decision": "allowed",
                "source_domain": "private_app",
                "mixing_allowed": False,
                "reason": "single_domain_private_app",
                "domains_seen": [],
                "requested_domains": ["private_app"],
            },
        )


def test_source_boundary_policy_transport_rejects_invalid_evidence_domains() -> None:
    policy = {
        "version": SOURCE_BOUNDARY_POLICY_VERSION,
        "decision": "allowed",
        "source_domain": "provider_control",
        "mixing_allowed": False,
        "reason": "provider_control_only",
        "domains_seen": [],
        "requested_domains": [],
    }
    assert SourceBoundaryPolicyOut.model_validate(policy).source_domain == "provider_control"

    with pytest.raises(ValidationError):
        SourceBoundaryPolicyOut.model_validate({**policy, "reason": ""})
    with pytest.raises(ValidationError):
        SourceBoundaryPolicyOut.model_validate({**policy, "reason": "   "})
    with pytest.raises(ValidationError):
        SourceBoundaryPolicyOut.model_validate({**policy, "domains_seen": ["provider_control"]})
    with pytest.raises(ValidationError):
        SourceBoundaryPolicyOut.model_validate(
            {**policy, "requested_domains": ["provider_control"]}
        )


@pytest.mark.parametrize("reason", ["", "   "])
def test_source_boundary_policy_validation_rejects_blank_reason(reason: str) -> None:
    with pytest.raises(AssertionError, match="reason must be non-empty"):
        validate_source_boundary_policy(
            source_domain="private_app",
            source_policy={
                "version": SOURCE_BOUNDARY_POLICY_VERSION,
                "decision": "allowed",
                "source_domain": "private_app",
                "mixing_allowed": False,
                "reason": reason,
                "domains_seen": [],
                "requested_domains": ["private_app"],
            },
        )


@pytest.mark.parametrize("field", ["domains_seen", "requested_domains"])
def test_source_boundary_policy_validation_rejects_provider_control_evidence_domain(
    field: str,
) -> None:
    policy = {
        "version": SOURCE_BOUNDARY_POLICY_VERSION,
        "decision": "allowed",
        "source_domain": "provider_control",
        "mixing_allowed": False,
        "reason": "provider_control_only",
        "domains_seen": [],
        "requested_domains": [],
    }
    policy[field] = ["provider_control"]

    with pytest.raises(AssertionError, match=f"{field} contains unsupported domain"):
        validate_source_boundary_policy(source_domain="provider_control", source_policy=policy)


def test_source_boundary_policy_validation_normalizes_domain_arrays() -> None:
    policy = validate_source_boundary_policy(
        source_domain="private_app",
        source_policy={
            "version": SOURCE_BOUNDARY_POLICY_VERSION,
            "decision": "allowed",
            "source_domain": "private_app",
            "mixing_allowed": False,
            "reason": "single_domain_private_app",
            "domains_seen": ("private_app",),
            "requested_domains": ("private_app",),
        },
    )

    assert policy["domains_seen"] == ["private_app"]
    assert policy["requested_domains"] == ["private_app"]
