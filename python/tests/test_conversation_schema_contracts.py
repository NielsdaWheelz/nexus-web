from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.conversation import (
    ChatRunCreateRequest,
    MessageContextRef,
    MessageContextSnapshot,
)

pytestmark = pytest.mark.unit


def test_chat_run_create_request_rejects_duplicate_context_evidence_span_ids():
    chunk_id = uuid4()
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        ChatRunCreateRequest.model_validate(
            {
                "conversation_id": str(uuid4()),
                "content": "Summarize this context.",
                "model_id": str(uuid4()),
                "reasoning": "none",
                "key_mode": "auto",
                "contexts": [
                    {
                        "kind": "object_ref",
                        "type": "content_chunk",
                        "id": str(chunk_id),
                        "evidence_span_ids": [
                            str(first_span_id),
                            str(second_span_id),
                            str(first_span_id),
                        ],
                    }
                ],
            }
        )


def test_message_context_snapshot_requires_canonical_object_ref_identity():
    context_id = uuid4()
    MessageContextSnapshot.model_validate(
        {
            "kind": "object_ref",
            "type": "content_chunk",
            "id": str(context_id),
            "title": "Chapter 1",
        }
    )

    with pytest.raises(
        ValidationError,
        match="object_ref message context snapshots require type, id, title",
    ):
        MessageContextSnapshot.model_validate({"kind": "object_ref"})

    with pytest.raises(
        ValidationError,
        match="object_ref message context snapshots require title",
    ):
        MessageContextSnapshot.model_validate(
            {
                "kind": "object_ref",
                "type": "content_chunk",
                "id": str(context_id),
                "title": " ",
            }
        )


def test_message_context_snapshot_requires_canonical_reader_selection_fields():
    media_id = uuid4()
    locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(uuid4()),
        "start_offset": 0,
        "end_offset": 10,
    }
    payload = {
        "kind": "reader_selection",
        "client_context_id": str(uuid4()),
        "media_id": str(media_id),
        "source_media_id": str(media_id),
        "media_title": "Reader Source",
        "media_kind": "web",
        "exact": "selected text",
        "locator": locator,
        "source_version": "content-index:test:v1",
    }
    MessageContextSnapshot.model_validate(payload)

    with pytest.raises(
        ValidationError,
        match=(
            "reader_selection message context snapshots require "
            "client_context_id, media_id, source_media_id, media_title, "
            "media_kind, exact, locator, source_version"
        ),
    ):
        MessageContextSnapshot.model_validate({"kind": "reader_selection"})


def test_message_context_ref_rejects_duplicate_evidence_span_ids():
    chunk_id = uuid4()
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        MessageContextRef(
            type="content_chunk",
            id=chunk_id,
            evidence_span_ids=[first_span_id, second_span_id, first_span_id],
        )
