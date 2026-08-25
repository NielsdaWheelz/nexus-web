"""Closed operation-to-ledger-owner contract for Codex generation."""

from __future__ import annotations

from typing import cast
from uuid import UUID

import pytest

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import GenerationCommand
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.llm_ledger import GenerationStart, LlmCallOwner, LlmCallOwnerKind

_GENERATION_ID = UUID("7da06b58-7d99-5e8d-916b-98c36fe6b48c")


def _command(operation: str) -> GenerationCommand:
    return GenerationCommand.model_validate(
        {
            "request_id": _GENERATION_ID,
            "operation": {
                "kind": operation,
                "revision": generation_policy.operation_revision(
                    operation,
                    profile="balanced" if operation == "chat" else None,
                ),
                **({"profile": "balanced"} if operation == "chat" else {}),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": GenerationIntent(
                instructions="Return one bounded result.",
                input="ledger ownership proof",
                output=TextOutput(),
            ),
            **(
                {
                    "tool_grant": {
                        "kind": "Bearer",
                        "token": "opaque-proof-token",
                    }
                }
                if operation == "chat"
                else {}
            ),
        }
    )


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
    operation: str,
    owner_kind: str,
) -> None:
    command = _command(operation)

    GenerationStart(
        owner=LlmCallOwner(kind=cast(LlmCallOwnerKind, owner_kind), id=_GENERATION_ID),
        command=command,
        streaming=operation == "chat",
    )
    wrong_owner = "media_enrichment" if owner_kind == "chat_run" else "chat_run"
    with pytest.raises(ValueError, match="requires owner kind"):
        GenerationStart(
            owner=LlmCallOwner(
                kind=cast(LlmCallOwnerKind, wrong_owner),
                id=_GENERATION_ID,
            ),
            command=command,
            streaming=operation == "chat",
        )


def test_generation_owner_rejects_values_outside_the_closed_vocabulary() -> None:
    with pytest.raises(ValueError, match="unknown generation owner kind"):
        LlmCallOwner(
            kind=cast(LlmCallOwnerKind, "legacy_provider_call"),
            id=_GENERATION_ID,
        )
