"""Closed operation-to-ledger-owner contract for Codex generation."""

from __future__ import annotations

from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import UUID

import pytest

_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.services.generation_spec import GenerationOperation
    from nexus.services.llm_ledger import (
        GenerationSpecDocument,
        GenerationStart,
        LlmCallOwner,
        LlmCallOwnerKind,
        generation_spec_document,
    )
    from tests.testkit.codex_generation import codex_generation_draft

_GENERATION_ID = UUID("7da06b58-7d99-5e8d-916b-98c36fe6b48c")


def _require_cutover() -> None:
    assert _CUTOVER_PRESENT, "the closed generation operation ledger is absent"


def _spec(operation: GenerationOperation) -> GenerationSpecDocument:
    draft = codex_generation_draft(
        request_id=_GENERATION_ID,
        operation=operation,
        instructions="Return one bounded result.",
        input_text="ledger ownership proof",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=120,
    )
    return generation_spec_document(draft.spec)


@pytest.mark.parametrize(
    ("operation", "owner_kind"),
    [
        ("metadata_enrichment", "media_enrichment"),
        ("media_summary", "media_summary"),
        ("synapse", "synapse_scan"),
        ("dawn_write", "dawn_write"),
        ("oracle", "oracle_reading"),
        ("dossier_page", "artifact_build"),
        ("dossier_note", "artifact_build"),
        ("dossier_media", "artifact_build"),
        ("dossier_conversation", "artifact_build"),
        ("dossier_library", "artifact_build"),
        ("dossier_podcast", "artifact_build"),
        ("dossier_contributor", "artifact_build"),
        ("dossier_idea", "artifact_build"),
        ("dossier_idea_resolve", "artifact_learn_request"),
        ("chat", "chat_run"),
    ],
)
def test_generation_start_accepts_only_the_catalog_owner(
    operation: GenerationOperation,
    owner_kind: str,
) -> None:
    _require_cutover()
    spec = _spec(operation)

    GenerationStart(
        generation_id=_GENERATION_ID,
        owner=LlmCallOwner(kind=cast(LlmCallOwnerKind, owner_kind), id=_GENERATION_ID),
        spec=spec,
    )
    wrong_owner = "media_enrichment" if owner_kind == "chat_run" else "chat_run"
    with pytest.raises(ValueError, match="requires owner kind"):
        GenerationStart(
            generation_id=_GENERATION_ID,
            owner=LlmCallOwner(
                kind=cast(LlmCallOwnerKind, wrong_owner),
                id=_GENERATION_ID,
            ),
            spec=spec,
        )


def test_generation_owner_rejects_values_outside_the_closed_vocabulary() -> None:
    _require_cutover()
    with pytest.raises(ValueError, match="unknown generation owner kind"):
        LlmCallOwner(
            kind=cast(LlmCallOwnerKind, "legacy_provider_call"),
            id=_GENERATION_ID,
        )
