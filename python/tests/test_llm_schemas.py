"""Unit tests for `nexus.schemas.llm`: `LlmProfilesOut` and the closed
`ExpectedChatFailure` union. See `docs/cutovers/llm-provider-runtime-hard-
cutover.md` §10."""

import pytest
from pydantic import TypeAdapter, ValidationError

from nexus.schemas.llm import (
    BudgetExceededChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    ExpectedChatFailure,
    IncompleteChatFailure,
    InvalidToolArgumentsChatFailure,
    LlmProfileOut,
    LlmProfilesOut,
    ProviderUnavailableChatFailure,
    RateLimitedChatFailure,
    RefusedChatFailure,
    StreamInterruptedChatFailure,
    TimeoutChatFailure,
)
from nexus.services.llm_profiles import DEFAULT_PROFILE_ID, PROFILES

pytestmark = pytest.mark.unit

_UNION_ADAPTER = TypeAdapter(ExpectedChatFailure)


# =============================================================================
# LlmProfilesOut
# =============================================================================


def test_from_profiles_yields_all_seven_profiles_in_order():
    out = LlmProfilesOut.from_profiles()

    assert out.default_profile_id == DEFAULT_PROFILE_ID == "balanced"
    assert [entry.id for entry in out.profiles] == [
        "fast",
        "balanced",
        "deep",
        "claude",
        "fable",
        "gemini",
        "kimi",
    ]
    assert len(out.profiles) == len(PROFILES) == 7


def test_from_profiles_projects_product_facing_fields_and_omits_target():
    entry = PROFILES[0]
    projected = LlmProfileOut.from_profile(entry)

    assert projected.id == entry.id
    assert projected.label == entry.label
    assert projected.description == entry.description
    assert projected.provider_label == entry.provider_label
    assert projected.model_label == entry.model_label
    assert projected.default_reasoning_option_id == entry.default_reasoning_option_id
    assert projected.privacy_notice == entry.privacy_notice
    assert [(o.id, o.label) for o in projected.reasoning_options] == [
        (o.id, o.label) for o in entry.reasoning_options
    ]
    assert not hasattr(projected, "target")


def test_llm_profiles_out_round_trips_through_model_dump():
    out = LlmProfilesOut.from_profiles()

    dumped = out.model_dump()
    restored = LlmProfilesOut.model_validate(dumped)

    assert restored == out


# =============================================================================
# ExpectedChatFailure: per-variant origin narrowing
# =============================================================================


@pytest.mark.parametrize(
    ("variant_type", "code", "allowed_origins"),
    [
        (RefusedChatFailure, "refused", ("provider_http", "provider_stream")),
        (IncompleteChatFailure, "incomplete", ("provider_response",)),
        (ContextTooLargeChatFailure, "context_too_large", ("intent", "provider_http")),
        (InvalidToolArgumentsChatFailure, "invalid_tool_arguments", ("tool_arguments",)),
        (BudgetExceededChatFailure, "budget_exceeded", ("budget",)),
    ],
)
def test_non_transient_variant_accepts_only_its_allowed_origins(
    variant_type, code, allowed_origins
):
    for origin in allowed_origins:
        instance = variant_type(
            code=code, origin=origin, support_id={"kind": "Absent"}, can_rerun=False
        )
        assert instance.origin == origin

    with pytest.raises(ValidationError):
        variant_type(
            code=code, origin="not-a-real-origin", support_id={"kind": "Absent"}, can_rerun=False
        )


@pytest.mark.parametrize(
    ("variant_type", "code", "allowed_origins"),
    [
        (RateLimitedChatFailure, "rate_limited", ("provider_http",)),
        (TimeoutChatFailure, "timeout", ("transport",)),
        (ProviderUnavailableChatFailure, "provider_unavailable", ("provider_http", "transport")),
        (StreamInterruptedChatFailure, "stream_interrupted", ("provider_stream",)),
    ],
)
def test_transient_variant_accepts_only_its_allowed_origins_and_requires_attempts(
    variant_type, code, allowed_origins
):
    for origin in allowed_origins:
        instance = variant_type(
            code=code,
            origin=origin,
            attempts=3,
            support_id={"kind": "Absent"},
            can_rerun=True,
        )
        assert instance.origin == origin
        assert instance.attempts == 3

    with pytest.raises(ValidationError):
        variant_type(
            code=code,
            origin="not-a-real-origin",
            attempts=3,
            support_id={"kind": "Absent"},
            can_rerun=True,
        )

    with pytest.raises(ValidationError):
        variant_type(
            code=code, origin=allowed_origins[0], support_id={"kind": "Absent"}, can_rerun=True
        )


def test_cancelled_variant_carries_no_origin_field():
    cancelled = CancelledChatFailure(
        code="cancelled", support_id={"kind": "Absent"}, can_rerun=True
    )

    assert not hasattr(cancelled, "origin")
    assert not hasattr(cancelled, "attempts")


def test_refused_and_budget_denial_variants_construct_as_non_rerunnable():
    refused = RefusedChatFailure(
        code="refused",
        origin="provider_stream",
        support_id={"kind": "Present", "value": "abc123def456"},
        can_rerun=False,
    )
    budget = BudgetExceededChatFailure(
        code="budget_exceeded", origin="budget", support_id={"kind": "Absent"}, can_rerun=False
    )

    assert refused.can_rerun is False
    assert refused.support_id.value == "abc123def456"
    assert budget.can_rerun is False


# =============================================================================
# ExpectedChatFailure: discriminated union
# =============================================================================


def _sample_payload(code: str) -> dict:
    payloads = {
        "refused": {"code": "refused", "origin": "provider_http", "can_rerun": False},
        "incomplete": {"code": "incomplete", "origin": "provider_response", "can_rerun": True},
        "cancelled": {"code": "cancelled", "can_rerun": True},
        "context_too_large": {"code": "context_too_large", "origin": "intent", "can_rerun": False},
        "invalid_tool_arguments": {
            "code": "invalid_tool_arguments",
            "origin": "tool_arguments",
            "can_rerun": True,
        },
        "budget_exceeded": {"code": "budget_exceeded", "origin": "budget", "can_rerun": False},
        "rate_limited": {
            "code": "rate_limited",
            "origin": "provider_http",
            "attempts": 2,
            "can_rerun": True,
        },
        "timeout": {"code": "timeout", "origin": "transport", "attempts": 1, "can_rerun": True},
        "provider_unavailable": {
            "code": "provider_unavailable",
            "origin": "transport",
            "attempts": 4,
            "can_rerun": True,
        },
        "stream_interrupted": {
            "code": "stream_interrupted",
            "origin": "provider_stream",
            "attempts": 1,
            "can_rerun": True,
        },
    }
    payload = dict(payloads[code])
    payload["support_id"] = {"kind": "Absent"}
    return payload


@pytest.mark.parametrize(
    ("code", "expected_type"),
    [
        ("refused", RefusedChatFailure),
        ("incomplete", IncompleteChatFailure),
        ("cancelled", CancelledChatFailure),
        ("context_too_large", ContextTooLargeChatFailure),
        ("invalid_tool_arguments", InvalidToolArgumentsChatFailure),
        ("budget_exceeded", BudgetExceededChatFailure),
        ("rate_limited", RateLimitedChatFailure),
        ("timeout", TimeoutChatFailure),
        ("provider_unavailable", ProviderUnavailableChatFailure),
        ("stream_interrupted", StreamInterruptedChatFailure),
    ],
)
def test_union_parses_each_code_into_its_own_variant_type(code, expected_type):
    parsed = _UNION_ADAPTER.validate_python(_sample_payload(code))

    assert isinstance(parsed, expected_type)
    assert parsed.code == code


def test_union_rejects_unknown_code():
    with pytest.raises(ValidationError):
        _UNION_ADAPTER.validate_python({"code": "not_a_real_code", "can_rerun": False})


def test_union_round_trips_every_variant_through_model_dump_and_validate():
    for code in (
        "refused",
        "incomplete",
        "cancelled",
        "context_too_large",
        "invalid_tool_arguments",
        "budget_exceeded",
        "rate_limited",
        "timeout",
        "provider_unavailable",
        "stream_interrupted",
    ):
        parsed = _UNION_ADAPTER.validate_python(_sample_payload(code))
        dumped = _UNION_ADAPTER.dump_python(parsed)
        restored = _UNION_ADAPTER.validate_python(dumped)

        assert restored == parsed
