from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.conversation import (
    ChatRunCreateRequest,
    MessageArtifactContextSnapshot,
    MessageArtifactCreateRequest,
    MessageArtifactPartProvenance,
    MessageContextRef,
    MessageContextSnapshot,
    chat_run_event_payload_json,
)

pytestmark = pytest.mark.unit


def _artifact_part_context_payload(
    *,
    artifact_version: int,
    provenance_artifact_version: int,
) -> dict[str, object]:
    artifact_id = uuid4()
    artifact_part_id = uuid4()
    source_version = f"artifact_part:{artifact_part_id}:v1"
    locator = {
        "type": "artifact_part_ref",
        "artifact_id": str(artifact_id),
        "artifact_part_id": str(artifact_part_id),
        "message_id": str(uuid4()),
        "conversation_id": str(uuid4()),
    }
    return {
        "kind": "object_ref",
        "type": "artifact_part",
        "id": str(artifact_part_id),
        "artifact_id": str(artifact_id),
        "artifact_version": artifact_version,
        "source_version": source_version,
        "locator": locator,
        "artifact_part_provenance": {
            "type": "artifact_part",
            "artifact_id": str(artifact_id),
            "artifact_version": provenance_artifact_version,
            "artifact_part_id": str(artifact_part_id),
            "source_version": source_version,
            "locator": locator,
        },
    }


def _artifact_context_payload(
    *,
    context_id,
    artifact_id=None,
    artifact_key: str = "artifact-1",
    artifact_version: int = 2,
    provenance_type: str = "artifact",
    provenance_artifact_id=None,
    provenance_artifact_key: str = "artifact-1",
    provenance_artifact_version: int = 2,
) -> dict[str, object]:
    payload = {
        "kind": "object_ref",
        "type": "artifact",
        "id": str(context_id),
        "artifact_id": str(artifact_id or context_id),
        "artifact_key": artifact_key,
        "artifact_version": artifact_version,
        "artifact_part_provenance": {
            "type": provenance_type,
            "artifact_id": str(provenance_artifact_id or context_id),
            "artifact_key": provenance_artifact_key,
            "artifact_version": provenance_artifact_version,
        },
    }
    if provenance_type == "artifact_part":
        artifact_part_id = uuid4()
        locator = {
            "type": "artifact_part_ref",
            "artifact_id": str(context_id),
            "artifact_part_id": str(artifact_part_id),
            "message_id": str(uuid4()),
            "conversation_id": str(uuid4()),
        }
        payload["artifact_part_provenance"].update(
            {
                "artifact_part_id": str(artifact_part_id),
                "source_version": f"artifact_part:{artifact_part_id}:v1",
                "locator": locator,
            }
        )
    return payload


def test_chat_run_create_request_rejects_duplicate_context_evidence_span_ids():
    chunk_id = uuid4()
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        ChatRunCreateRequest.model_validate(
            {
                "content": "Summarize this context.",
                "model_id": str(uuid4()),
                "reasoning": "none",
                "key_mode": "auto",
                "conversation_scope": {"type": "general"},
                "web_search": {"mode": "off"},
                "artifact_intent": {"kind": "off"},
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


def test_sparse_artifact_input_context_remains_valid():
    MessageContextRef.model_validate(
        {
            "kind": "object_ref",
            "type": "artifact",
            "id": str(uuid4()),
        }
    )


def test_artifact_output_context_requires_canonical_artifact_metadata():
    artifact_id = uuid4()
    payload = {
        **_artifact_context_payload(context_id=artifact_id),
        "title": "Artifact title",
    }
    MessageArtifactContextSnapshot.model_validate(payload)

    with pytest.raises(ValidationError, match="Field required"):
        MessageArtifactContextSnapshot.model_validate(
            {
                "kind": "object_ref",
                "type": "artifact",
                "id": str(artifact_id),
                "title": "Artifact title",
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


def test_artifact_part_context_rejects_provenance_artifact_version_drift():
    with pytest.raises(
        ValidationError,
        match="artifact_part contexts provenance artifact_version must match",
    ):
        MessageContextRef.model_validate(
            _artifact_part_context_payload(
                artifact_version=2,
                provenance_artifact_version=3,
            )
        )


def test_artifact_context_rejects_top_level_artifact_id_drift():
    with pytest.raises(ValidationError, match="artifact contexts artifact_id must match id"):
        MessageContextRef.model_validate(
            _artifact_context_payload(
                context_id=uuid4(),
                artifact_id=uuid4(),
            )
        )


@pytest.mark.parametrize(
    ("payload_update", "error_message"),
    [
        (
            {"provenance_artifact_id": uuid4()},
            "provenance artifact_id must match id",
        ),
        (
            {"provenance_type": "artifact_part"},
            "provenance must be artifact",
        ),
        (
            {"provenance_artifact_version": 3},
            "provenance artifact_version must match",
        ),
    ],
)
def test_artifact_context_rejects_provenance_identity_drift(
    payload_update: dict[str, object],
    error_message: str,
):
    with pytest.raises(ValidationError, match=f"artifact contexts {error_message}"):
        MessageContextRef.model_validate(
            _artifact_context_payload(context_id=uuid4(), **payload_update)
        )


def test_message_context_ref_rejects_duplicate_evidence_span_ids():
    artifact_part_id = uuid4()
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        MessageContextRef(
            type="artifact_part",
            id=artifact_part_id,
            artifact_id=uuid4(),
            source_version="artifact:v1",
            locator={
                "type": "artifact_part_ref",
                "artifact_id": str(uuid4()),
                "artifact_part_id": str(artifact_part_id),
                "message_id": str(uuid4()),
                "conversation_id": str(uuid4()),
            },
            evidence_span_ids=[first_span_id, second_span_id, first_span_id],
        )


def test_chat_run_artifact_delta_part_rejects_duplicate_evidence_span_ids():
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        chat_run_event_payload_json(
            "artifact_delta",
            {
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "status": "streaming",
                "parts": [
                    {
                        "part_key": "part-1",
                        "source_version": "message:test:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(uuid4()),
                            "message_id": str(uuid4()),
                            "message_seq": 1,
                            "start_offset": 0,
                            "end_offset": 10,
                        },
                        "evidence_span_ids": [
                            str(first_span_id),
                            str(second_span_id),
                            str(first_span_id),
                        ],
                    }
                ],
            },
        )


def test_chat_run_artifact_delta_part_rejects_singular_plural_evidence_span_duplicate():
    evidence_span_id = uuid4()

    with pytest.raises(
        ValidationError,
        match="evidence_span_id must not duplicate evidence_span_ids",
    ):
        chat_run_event_payload_json(
            "artifact_delta",
            {
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "status": "streaming",
                "parts": [
                    {
                        "part_key": "part-1",
                        "source_version": "message:test:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(uuid4()),
                            "message_id": str(uuid4()),
                            "message_seq": 1,
                            "start_offset": 0,
                            "end_offset": 10,
                        },
                        "evidence_span_id": str(evidence_span_id),
                        "evidence_span_ids": [str(evidence_span_id)],
                    }
                ],
            },
        )


def test_message_artifact_create_request_rejects_duplicate_part_evidence_span_ids():
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        MessageArtifactCreateRequest.model_validate(
            {
                "message_id": str(uuid4()),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
                "parts": [
                    {
                        "part_key": "part-1",
                        "evidence_span_ids": [
                            str(first_span_id),
                            str(second_span_id),
                            str(first_span_id),
                        ],
                    }
                ],
            }
        )


def test_message_artifact_create_request_rejects_singular_plural_evidence_span_duplicate():
    evidence_span_id = uuid4()

    with pytest.raises(
        ValidationError,
        match="evidence_span_id must not duplicate evidence_span_ids",
    ):
        MessageArtifactCreateRequest.model_validate(
            {
                "message_id": str(uuid4()),
                "artifact_key": "artifact-1",
                "artifact_kind": "timeline",
                "parts": [
                    {
                        "part_key": "part-1",
                        "evidence_span_id": str(evidence_span_id),
                        "evidence_span_ids": [str(evidence_span_id)],
                    }
                ],
            }
        )


def test_message_artifact_part_provenance_rejects_duplicate_evidence_span_ids():
    artifact_id = uuid4()
    artifact_part_id = uuid4()
    first_span_id = uuid4()
    second_span_id = uuid4()

    with pytest.raises(ValidationError, match="evidence_span_ids must not contain duplicates"):
        MessageArtifactPartProvenance(
            type="artifact_part",
            artifact_id=artifact_id,
            artifact_part_id=artifact_part_id,
            source_version=f"artifact_part:{artifact_part_id}:v1",
            locator={
                "type": "artifact_part_ref",
                "artifact_id": str(artifact_id),
                "artifact_part_id": str(artifact_part_id),
                "message_id": str(uuid4()),
                "conversation_id": str(uuid4()),
            },
            evidence_span_ids=[first_span_id, second_span_id, first_span_id],
        )
