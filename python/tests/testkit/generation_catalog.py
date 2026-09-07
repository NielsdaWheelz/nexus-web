"""Deterministic configured Chat catalog boundary for service proofs."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from provider_runtime.agent_runtime import (
    AGENT_BACKEND_CONTRACT_REVISION,
    AgentModelCatalog,
    AgentModelFacts,
    AgentReasoningFacts,
)
from provider_runtime.registry import api_model_catalog
from provider_runtime.types import Absent as RuntimeAbsent
from provider_runtime.types import Present as RuntimePresent

from nexus.config import GenerationApiProvider
from nexus.schemas.llm import Ready
from nexus.services import generation_policy
from nexus.services.generation_catalog import (
    GenerationCatalogService,
    readiness_snapshot,
    source_controlled_qualification_snapshot,
)
from nexus.services.generation_selection import ProviderApiSelection

CHAT_CATALOG_NOW = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
CHAT_TEST_SELECTION = ProviderApiSelection(
    route="ProviderApi",
    model_ref="openai:gpt-5.6-terra",
    reasoning="medium",
)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def policy_complete_codex_catalog() -> AgentModelCatalog:
    """Minimal policy-complete Codex catalog; provider Chat is under proof.

    Dispatch readiness deliberately validates the complete developer policy,
    even when the selected run uses a provider route.  The fixture therefore
    carries the three exact source rows selected by that policy instead of a
    Chat-only partial catalog.
    """

    rows = (
        (
            "gpt-5.6-sol",
            "high",
            ("low", "medium", "high", "xhigh", "max", "ultra"),
            "03e6ecd4b90f505dfbf91d423721d3f8809acb333ba8d511033383952fc3eed2",
        ),
        (
            "gpt-5.6-terra",
            "medium",
            ("low", "medium", "high", "xhigh", "max", "ultra"),
            "183cd530500586e7c806cb098e719b2bfa495cb1f6322c20536640f107602e4f",
        ),
        (
            "gpt-5.6-luna",
            "low",
            ("low", "medium", "high", "xhigh", "max"),
            "9b3458184f127976f3d9b47a3a7860db7142cd66173f05197d63de37a129b7c6",
        ),
    )
    return AgentModelCatalog(
        backend_contract_revision=AGENT_BACKEND_CONTRACT_REVISION,
        definition_revision=_digest("chat-test-agent-definition"),
        native_revision=RuntimeAbsent(),
        observed_at=CHAT_CATALOG_NOW,
        models=tuple(
            AgentModelFacts(
                key=key,
                dispatch_model=key,
                label=" ".join(
                    part.upper() if part == "gpt" else part.title() for part in key.split("-")
                ),
                source_context_window=RuntimeAbsent(),
                source_max_output_tokens=RuntimeAbsent(),
                input_modalities=("text",),
                reasoning=tuple(
                    AgentReasoningFacts(
                        key=reasoning,
                        label=reasoning.title(),
                        native_wire_value=reasoning,
                    )
                    for reasoning in reasoning_values
                ),
                source_default_reasoning=RuntimePresent(default_reasoning),
                upgrade=RuntimeAbsent(),
                retirement=RuntimeAbsent(),
                row_fingerprint=row_fingerprint,
            )
            for key, default_reasoning, reasoning_values, row_fingerprint in rows
        ),
        diagnostics=(),
    )


def configured_chat_catalog_service(
    *,
    configured_api_providers: tuple[GenerationApiProvider, ...] = ("openai",),
) -> GenerationCatalogService:
    """Compose one real catalog service with a controlled external source adapter."""

    agent = policy_complete_codex_catalog()
    ready = Ready(last_checked=CHAT_CATALOG_NOW)

    async def load_agent_catalog() -> AgentModelCatalog:
        return agent

    async def load_readiness():
        return readiness_snapshot(
            observed_at=CHAT_CATALOG_NOW,
            routes={
                "CodexPersonal": ready,
                **{f"ProviderApi:{provider}": ready for provider in configured_api_providers},
            },
        )

    return GenerationCatalogService(
        configured_api_providers=configured_api_providers,
        policy=generation_policy.GENERATION_POLICY,
        load_agent_catalog=load_agent_catalog,
        load_api_catalog=api_model_catalog,
        load_qualifications=source_controlled_qualification_snapshot,
        load_readiness=load_readiness,
        clock=lambda: CHAT_CATALOG_NOW,
    )


__all__ = [
    "CHAT_CATALOG_NOW",
    "CHAT_TEST_SELECTION",
    "configured_chat_catalog_service",
    "policy_complete_codex_catalog",
]
