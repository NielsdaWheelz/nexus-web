"""Tests for deterministic conversation memory validation."""

from uuid import uuid4

import pytest

from nexus.services.conversation_memory import (
    MemorySource,
    MemoryValidationError,
    collect_memory_source_refs,
    validate_memory_candidate,
    validate_memory_sources,
    validate_source_ref,
)

pytestmark = pytest.mark.unit


def test_source_claim_requires_source_ref():
    with pytest.raises(MemoryValidationError):
        validate_memory_candidate(
            kind="source_claim",
            body="The article says retrieval quality matters.",
            source_required=True,
            source_refs=[],
        )


def test_valid_source_refs_cover_message_retrieval_and_app_context_ref():
    validate_source_ref(
        {
            "type": "message_retrieval",
            "id": str(uuid4()),
            "retrieval_id": str(uuid4()),
        }
    )
    validate_source_ref(
        {
            "type": "app_context_ref",
            "id": str(uuid4()),
            "context_ref": {"type": "content_chunk", "id": str(uuid4())},
        }
    )


def test_invalid_source_ref_is_rejected():
    with pytest.raises(MemoryValidationError):
        validate_source_ref({"type": "message_retrieval"})


def test_memory_sources_validate_evidence_roles():
    with pytest.raises(MemoryValidationError):
        validate_memory_sources(
            [
                MemorySource(
                    source_ref={"type": "message", "id": str(uuid4()), "message_id": str(uuid4())},
                    evidence_role="unknown",  # type: ignore[arg-type]
                )
            ]
        )


def test_collect_memory_source_refs_keeps_prompt_order():
    class Item:
        sources = (
            MemorySource(
                source_ref={"type": "message", "id": "m1", "message_id": "m1"},
                evidence_role="supports",
            ),
        )

    refs = collect_memory_source_refs(memory_items=[Item()], snapshot=None)  # type: ignore[list-item]

    assert refs == [{"type": "message", "id": "m1", "message_id": "m1"}]
