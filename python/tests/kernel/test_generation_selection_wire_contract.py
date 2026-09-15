"""Closed generation selection-state and readiness wire contract.

The browser decoder in ``apps/web/src/lib/conversations/generationCatalog.ts``
mirrors every literal pinned here, and
``apps/web/src/lib/api/sse/events.selection.unit.test.ts`` pins the same
reviewed lists, so a code added or removed on one side fails one of the two
proofs instead of making a historical run undecodable in the browser.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import get_args

import pytest
from pydantic import ValidationError

from nexus.config import GenerationApiProvider
from nexus.schemas.llm import (
    GenerationModelRow,
    Ineligible,
    Lifecycle,
    OperatorActionRequired,
    PrivacyDisclosure,
    ProcessorChain,
    QualifiedCapability,
    ReadinessCode,
    RunSelectionOut,
    SelectionPresentation,
    SubscriptionBilling,
    TemporarilyUnavailable,
)
from nexus.services.generation_selection import CodexPersonalSelection, ProviderReasoningLevel

READINESS_CODES = (
    "catalog_refresh_failed",
    "codex_host_unavailable",
    "credential_unavailable",
    "provider_unavailable",
    "quota_unavailable",
)
INELIGIBLE_CODES = (
    "missing_target_qualification",
    "missing_reasoning_qualification",
    "missing_chat_tool_qualification",
    "unsupported_capability",
    "selection_not_configured",
)
RETIRED_CODES = ("qualification_missing", "retired")
_OBSERVED_AT = datetime(2026, 8, 31, 20, tzinfo=UTC)
_REVISION = "a" * 64


def _run_selection(current_state: Ineligible | OperatorActionRequired | TemporarilyUnavailable):
    return RunSelectionOut(
        selection=CodexPersonalSelection(
            route="CodexPersonal", model="gpt-5.6-terra", reasoning="medium"
        ),
        catalog_definition_revision=_REVISION,
        source_catalog_definition_revision=_REVISION,
        display_at_dispatch=SelectionPresentation(
            route_label="Codex Personal",
            model_label="GPT-5.6 Terra",
            reasoning_label="Medium",
            billing=SubscriptionBilling(),
            privacy=PrivacyDisclosure(
                summary="Private account request",
                retention="Provider retention applies",
                training="Not used for training",
            ),
            processor_chain=ProcessorChain(processors=("Codex Personal",)),
        ),
        tool_authority="ReadOnly",
        current_state=current_state,
        current_state_observed_at=_OBSERVED_AT,
        rerun_eligibility=False,
    )


def test_selection_state_and_readiness_codes_are_exactly_the_reviewed_lists() -> None:
    assert get_args(ReadinessCode) == READINESS_CODES
    assert get_args(Ineligible.model_fields["code"].annotation) == INELIGIBLE_CODES
    assert get_args(Lifecycle) == ("Active", "Retiring", "Retired")
    assert get_args(QualifiedCapability) == ("Text", "StrictStructured", "ToolsContinuation")
    assert get_args(
        get_args(GenerationModelRow.model_fields["input_modalities"].annotation)[0]
    ) == ("text", "image")
    assert get_args(RunSelectionOut.model_fields["tool_authority"].annotation) == (
        "ReadOnly",
        "AdditiveWrites",
    )
    assert get_args(ProviderReasoningLevel) == (
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    )
    assert get_args(GenerationApiProvider.__value__) == (
        "openai",
        "anthropic",
        "gemini",
        "moonshot",
        "openrouter",
        "deepseek",
        "xai",
    )


def test_every_reviewed_code_projects_through_run_selection_and_retired_codes_refuse() -> None:
    for code in INELIGIBLE_CODES:
        projected = _run_selection(Ineligible(code=code, explanation=f"{code} explanation"))
        replayed = RunSelectionOut.model_validate_json(projected.model_dump_json())
        assert replayed.current_state == Ineligible(code=code, explanation=f"{code} explanation")
    for code in READINESS_CODES:
        for variant in (OperatorActionRequired, TemporarilyUnavailable):
            state = variant(
                code=code,
                explanation=f"{code} explanation",
                action=f"{code} action",
                last_checked=_OBSERVED_AT,
            )
            replayed = RunSelectionOut.model_validate_json(_run_selection(state).model_dump_json())
            assert replayed.current_state == state, f"{variant.__name__} {code}"

    for code in RETIRED_CODES:
        with pytest.raises(ValidationError):
            Ineligible(code=code, explanation="retired")  # type: ignore[arg-type]
        with pytest.raises(ValidationError):
            OperatorActionRequired(
                code=code,  # type: ignore[arg-type]
                explanation="retired",
                action="retired",
                last_checked=_OBSERVED_AT,
            )
