from uuid import uuid4

import pytest

from nexus.services.message_context_snapshots import (
    artifact_context_snapshot_fields,
    artifact_part_context_snapshot_fields,
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


def test_artifact_context_snapshot_fields_preserves_identity_fields():
    artifact_id = uuid4()
    provenance = {
        "type": "artifact",
        "artifact_id": str(artifact_id),
        "artifact_key": "summary",
        "artifact_version": 3,
    }

    fields = artifact_context_snapshot_fields(
        {
            "id": str(artifact_id),
            "artifact_id": str(artifact_id),
            "artifact_key": "summary",
            "artifact_version": 3,
            "artifact_part_provenance": provenance,
        }
    )

    assert fields == {
        "artifact_id": str(artifact_id),
        "artifact_key": "summary",
        "artifact_version": 3,
        "artifact_part_provenance": provenance,
    }


def test_artifact_context_snapshot_fields_ignores_absent_artifact_metadata():
    artifact_id = uuid4()

    assert (
        artifact_context_snapshot_fields(
            {
                "kind": "object_ref",
                "type": "artifact",
                "id": str(artifact_id),
                "title": "Artifact",
            }
        )
        == {}
    )


def test_artifact_context_snapshot_fields_rejects_provenance_drift():
    artifact_id = uuid4()

    with pytest.raises(
        ValueError,
        match="artifact_part_provenance artifact_version must match artifact_version",
    ):
        artifact_context_snapshot_fields(
            {
                "id": str(artifact_id),
                "artifact_id": str(artifact_id),
                "artifact_key": "summary",
                "artifact_version": 3,
                "artifact_part_provenance": {
                    "type": "artifact",
                    "artifact_id": str(artifact_id),
                    "artifact_key": "summary",
                    "artifact_version": 4,
                },
            }
        )


def test_artifact_part_context_snapshot_fields_preserves_top_level_fields():
    artifact_id = uuid4()
    part_id = uuid4()
    locator = {
        "type": "artifact_part_ref",
        "artifact_id": str(artifact_id),
        "artifact_part_id": str(part_id),
    }
    provenance = {
        "type": "artifact_part",
        "artifact_id": str(artifact_id),
        "artifact_version": 2,
        "artifact_part_id": str(part_id),
        "source_version": "artifact_part:part-1:v1",
        "locator": locator,
    }

    fields = artifact_part_context_snapshot_fields(
        {
            "id": str(part_id),
            "artifact_id": str(artifact_id),
            "artifact_key": "summary",
            "artifact_version": 2,
            "source_version": "artifact_part:part-1:v1",
            "locator": locator,
            "artifact_part_provenance": provenance,
        }
    )

    assert fields == {
        "artifact_id": str(artifact_id),
        "artifact_key": "summary",
        "artifact_version": 2,
        "source_version": "artifact_part:part-1:v1",
        "locator": locator,
        "artifact_part_provenance": provenance,
    }


def test_artifact_part_context_snapshot_fields_requires_top_level_source_fields():
    part_id = uuid4()

    with pytest.raises(ValueError, match="context snapshot artifact_id is required"):
        artifact_id = uuid4()
        artifact_part_context_snapshot_fields(
            {
                "id": str(part_id),
                "artifact_part_provenance": {
                    "type": "artifact_part",
                    "artifact_id": str(artifact_id),
                    "artifact_part_id": str(part_id),
                    "source_version": "artifact_part:part-1:v1",
                    "locator": {
                        "type": "artifact_part_ref",
                        "artifact_id": str(artifact_id),
                        "artifact_part_id": str(part_id),
                    },
                },
            }
        )


def test_artifact_part_context_snapshot_fields_rejects_provenance_drift():
    artifact_id = uuid4()
    part_id = uuid4()

    with pytest.raises(
        ValueError,
        match="artifact_part_provenance source_version must match source_version",
    ):
        artifact_part_context_snapshot_fields(
            {
                "id": str(part_id),
                "artifact_id": str(artifact_id),
                "source_version": "artifact_part:part-1:v1",
                "locator": {
                    "type": "artifact_part_ref",
                    "artifact_id": str(artifact_id),
                    "artifact_part_id": str(part_id),
                },
                "artifact_part_provenance": {
                    "type": "artifact_part",
                    "artifact_id": str(artifact_id),
                    "artifact_part_id": str(part_id),
                    "source_version": "artifact_part:other:v1",
                    "locator": {
                        "type": "artifact_part_ref",
                        "artifact_id": str(artifact_id),
                        "artifact_part_id": str(part_id),
                    },
                },
            }
        )


def test_artifact_part_context_snapshot_fields_rejects_artifact_version_drift():
    artifact_id = uuid4()
    part_id = uuid4()
    locator = {
        "type": "artifact_part_ref",
        "artifact_id": str(artifact_id),
        "artifact_part_id": str(part_id),
    }

    with pytest.raises(
        ValueError,
        match="artifact_part_provenance artifact_version must match artifact_version",
    ):
        artifact_part_context_snapshot_fields(
            {
                "id": str(part_id),
                "artifact_id": str(artifact_id),
                "artifact_version": 2,
                "source_version": "artifact_part:part-1:v1",
                "locator": locator,
                "artifact_part_provenance": {
                    "type": "artifact_part",
                    "artifact_id": str(artifact_id),
                    "artifact_version": 3,
                    "artifact_part_id": str(part_id),
                    "source_version": "artifact_part:part-1:v1",
                    "locator": locator,
                },
            }
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
