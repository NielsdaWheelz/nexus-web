"""The single product-owned policy catalog for Codex generation.

This module contains no provider credentials or provider-registry lookup.  A
plan is only a model/effort pair; capability is selected by the resolved
operation (or typed chat profile) and is therefore part of that policy entry.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Literal

PlanId = Literal["routine", "standard", "thorough", "deep"]
Capability = Literal["Synthesis", "ChatTools"]
ChatProfile = Literal["fast", "balanced", "deep"]

POLICY_REVISION = "codex-generation.2026-08-24.2"
# Exact frozen `llm_tools` Chat plan revision. The MCP composition boundary
# independently proves its generated plan retains this pin.
TOOL_PLAN_REVISION = "122bae501ba24887bacd88ba79f6e8108b2c91ca97bb6495747d347ec5a5ac53"
PLAN_EVAL_PIN = {
    "corpus_revision": "generation-plans.v1",
    "policy_revision": POLICY_REVISION,
    "policy_facts_fingerprint": "08179b82769191a0d0ebc5871f3e15f16fea5c01fd86db5dd6e1d1e3fd879273",
    "provider_runtime_revision": "a5d9c8e0c1c851daee0731554e0a4a326d3c2819",
    "codex_sdk_version": "0.144.4",
}
_PINNED_PLAN_EVAL_PIN = {
    "corpus_revision": "generation-plans.v1",
    "policy_revision": "codex-generation.2026-08-24.2",
    "policy_facts_fingerprint": "08179b82769191a0d0ebc5871f3e15f16fea5c01fd86db5dd6e1d1e3fd879273",
    "provider_runtime_revision": "a5d9c8e0c1c851daee0731554e0a4a326d3c2819",
    "codex_sdk_version": "0.144.4",
}
_PINNED_POLICY_FACTS_FINGERPRINT = (
    "08179b82769191a0d0ebc5871f3e15f16fea5c01fd86db5dd6e1d1e3fd879273"
)


@dataclass(frozen=True, slots=True)
class Plan:
    id: PlanId
    model: str
    effort: str


@dataclass(frozen=True, slots=True)
class ModelBounds:
    context_tokens: int
    model_output_tokens: int
    runtime_output_bytes: int


@dataclass(frozen=True, slots=True)
class StreamBounds:
    max_frames: int
    max_frame_bytes: int
    max_stream_bytes: int
    text_flush_interval_ms: int | None = None
    text_flush_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class OperationPolicy:
    operation: str
    revision: str
    plan_id: PlanId
    model: str
    effort: str
    capability: Capability
    instructions_max_bytes: int
    input_max_bytes: int
    turn_timeout_seconds: int
    stream: StreamBounds
    tool_plan_revision: str | None = None
    session_open_timeout_seconds: int = 90
    runtime_close_timeout_seconds: int = 30
    transport_margin_seconds: int = 15
    transport_deadline_seconds: int = 0


PLANS: dict[PlanId, Plan] = {
    "routine": Plan("routine", "gpt-5.6-luna", "low"),
    "standard": Plan("standard", "gpt-5.6-terra", "medium"),
    "thorough": Plan("thorough", "gpt-5.6-terra", "high"),
    "deep": Plan("deep", "gpt-5.6-sol", "high"),
}

MODEL_BOUNDS: dict[str, ModelBounds] = {
    model: ModelBounds(
        context_tokens=1_050_000,
        model_output_tokens=128_000,
        runtime_output_bytes=64 * 1024 * 1024,
    )
    for model in ("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol")
}

_SYNTHESIS_STREAM = StreamBounds(
    max_frames=1_024,
    max_frame_bytes=256 * 1024,
    max_stream_bytes=1024 * 1024,
)
_CHAT_STREAM = StreamBounds(
    max_frames=16_384,
    # Chat text is streamed in small frames, while the terminal repeats the
    # final fold. Reserving one 8 MiB terminal inside a 16 MiB stream bounds
    # user-visible text below the worker/host cgroup headroom.
    max_frame_bytes=8 * 1024 * 1024,
    max_stream_bytes=16 * 1024 * 1024,
    text_flush_interval_ms=100,
    text_flush_bytes=8 * 1024,
)

_REVISION_BY_OPERATION = {
    "metadata_enrichment": "metadata-enrichment.2026-08-12.4",
    "media_summary": "media-summary.2026-08-24.1",
    "synapse": "synapse.2026-08-24.1",
    "dawn_write": "dawn-write.2026-08-24.1",
    "oracle": "oracle.2026-08-24.1",
    "dossier_page": "dossier-page.2026-08-24.1",
    "dossier_note": "dossier-note.2026-08-24.1",
    "dossier_media": "dossier-media.2026-08-24.1",
    "dossier_conversation": "dossier-conversation.2026-08-24.1",
    "dossier_library": "dossier-library.2026-08-24.1",
    "dossier_podcast": "dossier-podcast.2026-08-24.1",
    "dossier_contributor": "dossier-contributor.2026-08-24.1",
    "dossier_idea": "dossier-idea.2026-08-24.1",
    "dossier_idea_resolve": "dossier-idea-resolve.2026-08-24.1",
}

_BACKGROUND_PLAN: dict[str, tuple[PlanId, int, int]] = {
    "metadata_enrichment": ("routine", 120, 32 * 1024),
    "media_summary": ("routine", 120, 256 * 1024),
    "synapse": ("routine", 120, 256 * 1024),
    "dawn_write": ("standard", 180, 256 * 1024),
    "oracle": ("standard", 180, 256 * 1024),
    "dossier_page": ("routine", 120, 1024 * 1024),
    "dossier_note": ("routine", 120, 1024 * 1024),
    "dossier_media": ("standard", 180, 1024 * 1024),
    "dossier_conversation": ("standard", 180, 1024 * 1024),
    "dossier_library": ("thorough", 300, 1024 * 1024),
    "dossier_podcast": ("thorough", 300, 1024 * 1024),
    "dossier_contributor": ("thorough", 300, 1024 * 1024),
    "dossier_idea": ("thorough", 300, 1024 * 1024),
    "dossier_idea_resolve": ("routine", 60, 256 * 1024),
}


def _synthesis_policy(
    operation: str, plan_id: PlanId, timeout: int, input_bytes: int
) -> OperationPolicy:
    plan = PLANS[plan_id]
    return OperationPolicy(
        operation=operation,
        revision=_REVISION_BY_OPERATION[operation],
        plan_id=plan_id,
        model=plan.model,
        effort=plan.effort,
        capability="Synthesis",
        instructions_max_bytes=32 * 1024,
        input_max_bytes=input_bytes,
        turn_timeout_seconds=timeout,
        stream=_SYNTHESIS_STREAM,
        transport_deadline_seconds=90 + timeout + 30 + 15,
    )


OPERATIONS: dict[str, OperationPolicy] = {
    operation: _synthesis_policy(operation, plan_id, timeout, input_bytes)
    for operation, (plan_id, timeout, input_bytes) in _BACKGROUND_PLAN.items()
}

CHAT_PROFILES: tuple[ChatProfile, ...] = ("fast", "balanced", "deep")
_CHAT_PLAN: dict[ChatProfile, PlanId] = {
    "fast": "routine",
    "balanced": "standard",
    "deep": "deep",
}
_CHAT_POLICIES: dict[ChatProfile, OperationPolicy] = {
    profile: OperationPolicy(
        operation="chat",
        revision=f"chat.{profile}.2026-08-24.2",
        plan_id=plan_id,
        model=PLANS[plan_id].model,
        effort=PLANS[plan_id].effort,
        capability="ChatTools",
        instructions_max_bytes=32 * 1024,
        input_max_bytes=512 * 1024,
        turn_timeout_seconds=900,
        stream=_CHAT_STREAM,
        tool_plan_revision=TOOL_PLAN_REVISION,
        transport_deadline_seconds=90 + 900 + 30 + 15,
    )
    for profile, plan_id in _CHAT_PLAN.items()
}

OPERATION_REVISIONS: dict[str, str] = {
    **_REVISION_BY_OPERATION,
}


def operation_policy(operation: str) -> OperationPolicy:
    try:
        return OPERATIONS[operation]
    except KeyError as error:
        raise ValueError(f"unknown synthesis operation {operation!r}") from error


def chat_policy(profile: str) -> OperationPolicy:
    try:
        return _CHAT_POLICIES[profile]  # type: ignore[index]
    except KeyError as error:
        raise ValueError(f"unknown chat profile {profile!r}") from error


def resolve_policy(operation: str, *, profile: str | None = None) -> OperationPolicy:
    """Resolve the complete host policy from the typed operation identity."""

    if operation == "chat":
        if profile is None:
            raise ValueError("chat operation requires profile")
        return chat_policy(profile)
    if profile is not None:
        raise ValueError("non-chat operation cannot carry profile")
    return operation_policy(operation)


def operation_revision(operation: str, *, profile: str | None = None) -> str:
    if operation == "chat":
        if profile is None:
            raise ValueError("chat operation requires profile")
        return chat_policy(profile).revision
    if profile is not None:
        raise ValueError("non-chat operation cannot carry profile")
    return operation_policy(operation).revision


def assert_operation_facts(operation: str, observed: OperationPolicy) -> None:
    expected = operation_policy(operation)
    if observed != expected:
        raise AssertionError(
            f"{operation} policy facts drifted: expected {expected}, got {observed}"
        )


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode()


def _policy_facts_payload() -> dict[str, object]:
    return {
        "plans": {key: asdict(value) for key, value in sorted(PLANS.items())},
        "model_bounds": {key: asdict(value) for key, value in sorted(MODEL_BOUNDS.items())},
        "operations": {key: asdict(value) for key, value in sorted(OPERATIONS.items())},
        "chat_profiles": {key: asdict(value) for key, value in sorted(_CHAT_POLICIES.items())},
        "tool_plan_revision": TOOL_PLAN_REVISION,
    }


def _policy_facts_digest() -> str:
    return hashlib.sha256(_canonical(_policy_facts_payload())).hexdigest()


POLICY_FACTS_FINGERPRINT = _PINNED_POLICY_FACTS_FINGERPRINT


def _policy_payload() -> dict[str, object]:
    return {
        "revision": POLICY_REVISION,
        "policy_facts_fingerprint": POLICY_FACTS_FINGERPRINT,
        "plan_eval_pin": dict(PLAN_EVAL_PIN),
    }


POLICY_FINGERPRINT = hashlib.sha256(_canonical(_policy_payload())).hexdigest()


def policy_fingerprint() -> str:
    return POLICY_FINGERPRINT


def policy_facts_fingerprint() -> str:
    return POLICY_FACTS_FINGERPRINT


def validate_policy() -> None:
    if _policy_facts_digest() != _PINNED_POLICY_FACTS_FINGERPRINT:
        raise AssertionError("policy facts fingerprint does not match the pinned catalog")
    if PLAN_EVAL_PIN != _PINNED_PLAN_EVAL_PIN:
        raise AssertionError("plan eval pin drifted")
    if set(PLANS) != {"routine", "standard", "thorough", "deep"}:
        raise AssertionError("policy plan set drifted")
    if set(OPERATIONS) != set(_BACKGROUND_PLAN):
        raise AssertionError("background operation catalog drifted")
    if set(CHAT_PROFILES) != {"fast", "balanced", "deep"}:
        raise AssertionError("chat profile catalog drifted")
    if PLAN_EVAL_PIN["policy_revision"] != POLICY_REVISION:
        raise AssertionError("plan eval pin does not qualify this policy revision")
    for operation, (plan_id, timeout, input_bytes) in _BACKGROUND_PLAN.items():
        expected = _synthesis_policy(operation, plan_id, timeout, input_bytes)
        if OPERATIONS[operation] != expected:
            raise AssertionError(f"{operation} policy facts drifted")
    for profile, plan_id in _CHAT_PLAN.items():
        entry = _CHAT_POLICIES[profile]
        if entry.plan_id != plan_id or entry.capability != "ChatTools":
            raise AssertionError(f"chat profile {profile} policy facts drifted")
        if entry.stream.max_stream_bytes > MODEL_BOUNDS[entry.model].runtime_output_bytes:
            raise AssertionError(f"chat profile {profile} exceeds its model runtime bound")
    for model, bounds in MODEL_BOUNDS.items():
        if bounds != ModelBounds(1_050_000, 128_000, 64 * 1024 * 1024):
            raise AssertionError(f"model bounds drifted for {model}")


__all__ = [
    "CHAT_PROFILES",
    "MODEL_BOUNDS",
    "OPERATIONS",
    "OPERATION_REVISIONS",
    "PLAN_EVAL_PIN",
    "POLICY_FACTS_FINGERPRINT",
    "POLICY_FINGERPRINT",
    "POLICY_REVISION",
    "PLANS",
    "TOOL_PLAN_REVISION",
    "ModelBounds",
    "OperationPolicy",
    "Plan",
    "StreamBounds",
    "assert_operation_facts",
    "chat_policy",
    "operation_policy",
    "operation_revision",
    "policy_fingerprint",
    "policy_facts_fingerprint",
    "resolve_policy",
    "validate_policy",
]
