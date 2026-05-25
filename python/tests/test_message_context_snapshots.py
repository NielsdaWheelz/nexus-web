from uuid import uuid4

import pytest

from nexus.services.message_context_snapshots import (
    context_evidence_span_ids,
    object_ref_context_snapshot,
    trusted_content_chunk_context_snapshot_fields,
    trusted_context_snapshot,
)

pytestmark = pytest.mark.unit


def test_object_ref_context_snapshot_writes_canonical_evidence_span_ids():
    evidence_span_id = uuid4()

    snapshot = object_ref_context_snapshot(
        object_type="content_chunk",
        object_id=uuid4(),
        title="Chunk",
        evidence_span_ids=[evidence_span_id],
    )

    assert snapshot["evidence_span_ids"] == [str(evidence_span_id)]


def test_object_ref_context_snapshot_rejects_duplicate_evidence_span_ids():
    evidence_span_id = uuid4()

    with pytest.raises(ValueError, match="evidence_span_ids must not contain duplicates"):
        object_ref_context_snapshot(
            object_type="content_chunk",
            object_id=uuid4(),
            title="Chunk",
            evidence_span_ids=[str(evidence_span_id), evidence_span_id],
        )


def test_object_ref_context_snapshot_rejects_invalid_evidence_span_ids():
    with pytest.raises(ValueError, match="evidence_span_ids must be UUIDs"):
        object_ref_context_snapshot(
            object_type="content_chunk",
            object_id=uuid4(),
            title="Chunk",
            evidence_span_ids=["not-a-uuid"],
        )


def test_context_evidence_span_ids_rejects_duplicate_trusted_values():
    evidence_span_id = uuid4()

    with pytest.raises(ValueError, match="evidence_span_ids must not contain duplicates"):
        context_evidence_span_ids(
            {"evidence_span_ids": [str(evidence_span_id), str(evidence_span_id)]}
        )


def test_trusted_context_snapshot_requires_object_payload():
    snapshot = {"kind": "object_ref", "title": "Chunk"}

    assert trusted_context_snapshot(snapshot) is snapshot

    with pytest.raises(ValueError, match="context snapshot must be an object"):
        trusted_context_snapshot([])


def test_context_evidence_span_ids_requires_context_snapshot_object():
    with pytest.raises(ValueError, match="context snapshot must be an object"):
        context_evidence_span_ids(None)  # type: ignore[arg-type]  # justify-python-override: invalid None input verifies runtime guard.


def test_trusted_content_chunk_context_snapshot_fields_requires_canonical_snapshot():
    chunk_id = uuid4()

    with pytest.raises(ValueError, match="context snapshot kind is required"):
        trusted_content_chunk_context_snapshot_fields(
            object_type="content_chunk",
            object_id=chunk_id,
            payload={},
        )


def test_trusted_content_chunk_context_snapshot_fields_requires_source_provenance():
    chunk_id = uuid4()

    with pytest.raises(ValueError, match="context snapshot source_version is required"):
        trusted_content_chunk_context_snapshot_fields(
            object_type="content_chunk",
            object_id=chunk_id,
            payload={
                "kind": "object_ref",
                "type": "content_chunk",
                "id": str(chunk_id),
                "title": "Chunk",
                "locator": {"type": "web_text_offsets"},
            },
        )


def test_context_evidence_span_ids_requires_canonical_uuid_array():
    evidence_span_id = uuid4()

    assert context_evidence_span_ids({"evidence_span_ids": [str(evidence_span_id)]}) == [
        evidence_span_id
    ]

    with pytest.raises(ValueError, match="evidence_span_ids must be an array"):
        context_evidence_span_ids({"evidence_span_ids": str(evidence_span_id)})

    with pytest.raises(ValueError, match="evidence_span_ids must be an array"):
        context_evidence_span_ids({"evidence_span_ids": (str(evidence_span_id),)})

    with pytest.raises(ValueError, match="evidence_span_ids must be UUIDs"):
        context_evidence_span_ids({"evidence_span_ids": [str(evidence_span_id), "not-a-uuid"]})
