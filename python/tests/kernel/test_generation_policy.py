"""Red contract for the Codex-personal generation policy catalog.

The cutover document is the oracle for this table.  These assertions deliberately
spell out the complete expected catalog so a plan or bound cannot silently drift
by changing the implementation's own defaults.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from nexus.services import generation_policy

_MODEL_BOUNDS = {
    "gpt-5.6-luna": (1_050_000, 128_000, 64 * 1024 * 1024),
    "gpt-5.6-terra": (1_050_000, 128_000, 64 * 1024 * 1024),
    "gpt-5.6-sol": (1_050_000, 128_000, 64 * 1024 * 1024),
}

_OPERATION_EXPECTATIONS = {
    "metadata_enrichment": ("routine", "gpt-5.6-luna", "low", 120, 32 * 1024),
    "media_summary": ("routine", "gpt-5.6-luna", "low", 120, 256 * 1024),
    "synapse": ("routine", "gpt-5.6-luna", "low", 120, 256 * 1024),
    "dawn_write": ("standard", "gpt-5.6-terra", "medium", 180, 256 * 1024),
    "oracle": ("standard", "gpt-5.6-terra", "medium", 180, 256 * 1024),
    "dossier_page": ("routine", "gpt-5.6-luna", "low", 120, 1024 * 1024),
    "dossier_note": ("routine", "gpt-5.6-luna", "low", 120, 1024 * 1024),
    "dossier_media": ("standard", "gpt-5.6-terra", "medium", 180, 1024 * 1024),
    "dossier_conversation": ("standard", "gpt-5.6-terra", "medium", 180, 1024 * 1024),
    "dossier_library": ("thorough", "gpt-5.6-terra", "high", 300, 1024 * 1024),
    "dossier_podcast": ("thorough", "gpt-5.6-terra", "high", 300, 1024 * 1024),
    "dossier_contributor": ("thorough", "gpt-5.6-terra", "high", 300, 1024 * 1024),
    "dossier_idea": ("thorough", "gpt-5.6-terra", "high", 300, 1024 * 1024),
    "dossier_idea_resolve": ("routine", "gpt-5.6-luna", "low", 60, 256 * 1024),
}


def _facts(entry: object) -> tuple[object, ...]:
    return (
        entry.plan_id,
        entry.model,
        entry.effort,
        entry.turn_timeout_seconds,
        entry.input_max_bytes,
    )


def test_fixed_plans_have_one_complete_model_effort_pair() -> None:
    generation_policy.validate_policy()

    assert set(generation_policy.PLANS) == {"routine", "standard", "thorough", "deep"}
    assert generation_policy.PLAN_EVAL_PIN["policy_revision"] == generation_policy.POLICY_REVISION
    assert generation_policy.PLAN_EVAL_PIN["corpus_revision"] == "generation-plans.v1"
    assert {
        plan_id: (plan.model, plan.effort) for plan_id, plan in generation_policy.PLANS.items()
    } == {
        "routine": ("gpt-5.6-luna", "low"),
        "standard": ("gpt-5.6-terra", "medium"),
        "thorough": ("gpt-5.6-terra", "high"),
        "deep": ("gpt-5.6-sol", "high"),
    }


def test_policy_facts_pin_rejects_a_plan_table_edit(monkeypatch: pytest.MonkeyPatch) -> None:
    changed = dict(generation_policy.PLANS)
    changed["routine"] = replace(changed["routine"], model="gpt-5.6-terra")
    monkeypatch.setattr(generation_policy, "PLANS", changed)

    with pytest.raises(AssertionError, match="facts fingerprint"):
        generation_policy.validate_policy()


def test_policy_facts_pin_is_not_self_derived(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generation_policy, "_policy_facts_digest", lambda: "0" * 64)

    with pytest.raises(AssertionError, match="facts fingerprint"):
        generation_policy.validate_policy()


def test_model_bounds_are_shared_and_fixed_for_all_codex_targets() -> None:
    assert {
        model: (
            bounds.context_tokens,
            bounds.model_output_tokens,
            bounds.runtime_output_bytes,
        )
        for model, bounds in generation_policy.MODEL_BOUNDS.items()
    } == _MODEL_BOUNDS
    assert generation_policy.policy_fingerprint() == generation_policy.POLICY_FINGERPRINT


def test_operation_catalog_has_exact_plans_capabilities_timeouts_and_input_bounds() -> None:
    assert set(generation_policy.OPERATIONS) == set(_OPERATION_EXPECTATIONS)
    for operation, expected in _OPERATION_EXPECTATIONS.items():
        entry = generation_policy.operation_policy(operation)
        assert _facts(entry) == expected
        assert entry.instructions_max_bytes == 32 * 1024
        assert entry.capability == "Synthesis"
        assert entry.stream.max_frames == 1_024
        assert entry.stream.max_frame_bytes == 256 * 1024
        assert entry.stream.max_stream_bytes == 1024 * 1024
        assert entry.transport_deadline_seconds == 90 + expected[3] + 30 + 15


def test_chat_is_three_typed_profiles_with_chat_tools_limits() -> None:
    assert set(generation_policy.CHAT_PROFILES) == {"fast", "balanced", "deep"}
    assert {
        profile_id: generation_policy.chat_policy(profile_id).plan_id
        for profile_id in generation_policy.CHAT_PROFILES
    } == {
        "fast": "routine",
        "balanced": "standard",
        "deep": "deep",
    }
    for profile_id in generation_policy.CHAT_PROFILES:
        entry = generation_policy.chat_policy(profile_id)
        assert entry.capability == "ChatTools"
        assert entry.instructions_max_bytes == 32 * 1024
        assert entry.input_max_bytes == 512 * 1024
        assert entry.turn_timeout_seconds == 900
        assert entry.stream.max_frames == 16_384
        assert entry.stream.max_frame_bytes == 256 * 1024
        assert entry.stream.max_stream_bytes == 512 * 1024 * 1024
        assert entry.stream.text_flush_interval_ms == 100
        assert entry.stream.text_flush_bytes == 8 * 1024
        assert entry.transport_deadline_seconds == 90 + 900 + 30 + 15


def test_policy_catalog_rejects_a_wrong_plan_instead_of_accepting_catalog_drift() -> None:
    """Sensitivity fault: moving oracle to routine must be observable as red."""

    oracle = generation_policy.operation_policy("oracle")
    wrong = replace(oracle, plan_id="routine", model="gpt-5.6-luna", effort="low")
    assert _facts(wrong) != _OPERATION_EXPECTATIONS["oracle"]
    with pytest.raises(AssertionError, match="oracle"):
        generation_policy.assert_operation_facts("oracle", wrong)
