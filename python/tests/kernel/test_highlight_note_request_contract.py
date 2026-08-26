"""Strict public request contract for Highlight note persistence."""

from __future__ import annotations

from copy import deepcopy
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.schemas.highlights import SetHighlightNoteRequest

NOTE_BLOCK_ID = "11111111-1111-4111-8111-111111111111"
BODY_PM_JSON = {
    "type": "paragraph",
    "content": [{"type": "text", "text": "Canonical note"}],
}


def _canonical_payload() -> dict[str, object]:
    return {
        "note_block_id": NOTE_BLOCK_ID,
        "client_mutation_id": "highlight-note-contract",
        "body_pm_json": deepcopy(BODY_PM_JSON),
    }


def test_highlight_note_request_accepts_and_emits_only_the_canonical_wire_shape() -> None:
    request = SetHighlightNoteRequest.model_validate(_canonical_payload())

    assert request.note_block_id == UUID(NOTE_BLOCK_ID)
    assert request.client_mutation_id == "highlight-note-contract"
    assert request.body_pm_json == BODY_PM_JSON
    assert request.model_dump(mode="json", by_alias=True) == _canonical_payload()


@pytest.mark.parametrize(
    ("canonical_key", "retired_key"),
    [
        ("note_block_id", "noteBlockId"),
        ("note_block_id", "id"),
        ("client_mutation_id", "clientMutationId"),
        ("body_pm_json", "bodyPmJson"),
    ],
)
def test_highlight_note_request_rejects_every_retired_alias(
    canonical_key: str,
    retired_key: str,
) -> None:
    payload = _canonical_payload()
    payload[retired_key] = payload.pop(canonical_key)

    with pytest.raises(ValidationError):
        SetHighlightNoteRequest.model_validate(payload)
