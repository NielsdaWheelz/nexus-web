"""Canonical persisted message-context snapshot builders."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from uuid import UUID

from pydantic import BaseModel

from nexus.errors import ApiError, ApiErrorCode
from nexus.evidence_span_ids import canonical_evidence_span_ids, trusted_evidence_span_ids
from nexus.schemas.conversation import MessageArtifactPartProvenance, MessageContextRef
from nexus.schemas.notes import HydratedObjectRef
from nexus.schemas.retrieval import retrieval_locator_json

HIGHLIGHT_COLOR_VALUES = frozenset({"yellow", "green", "blue", "pink", "purple"})


def trusted_context_snapshot(payload: object) -> Mapping[str, object]:
    if not isinstance(payload, Mapping):
        raise ValueError("context snapshot must be an object")
    return payload


def trusted_object_ref_context_snapshot_payload(
    *,
    object_type: str | None,
    object_id: UUID | None,
    payload: object,
) -> dict[str, object]:
    if object_type is None or object_id is None:
        raise ValueError("object_ref snapshot row identity is missing")

    snapshot = trusted_context_snapshot(payload)
    kind = context_snapshot_required_string(snapshot, "kind")
    if kind != "object_ref":
        raise ValueError("context snapshot kind must be object_ref")
    snapshot_type = context_snapshot_required_string(snapshot, "type")
    if snapshot_type != object_type:
        raise ValueError("context snapshot type must match row object_type")
    snapshot_id = context_snapshot_required_uuid(snapshot, "id")
    if snapshot_id != object_id:
        raise ValueError("context snapshot id must match row object_id")

    return {
        "kind": "object_ref",
        "type": object_type,
        "id": object_id,
        "evidence_span_ids": context_evidence_span_ids(snapshot),
        "color": context_snapshot_optional_highlight_color(snapshot, "color"),
        "preview": context_snapshot_optional_string(
            snapshot,
            "preview",
            allow_blank=True,
        ),
        "exact": context_snapshot_optional_string(snapshot, "exact"),
        "prefix": context_snapshot_optional_string(snapshot, "prefix", allow_blank=True),
        "suffix": context_snapshot_optional_string(snapshot, "suffix", allow_blank=True),
        "media_id": context_snapshot_optional_uuid(snapshot, "media_id"),
        "media_title": context_snapshot_optional_string(snapshot, "media_title"),
        "media_kind": context_snapshot_optional_string(snapshot, "media_kind"),
        "locator": context_snapshot_optional_mapping(snapshot, "locator"),
        "source_version": context_snapshot_optional_string(snapshot, "source_version"),
        "title": context_snapshot_required_string(snapshot, "title"),
        "route": context_snapshot_optional_string(snapshot, "route"),
    }


def context_snapshot_required_string(
    snapshot: Mapping[str, object],
    key: str,
) -> str:
    value = context_snapshot_optional_string(snapshot, key)
    if value is None:
        raise ValueError(f"context snapshot {key} is required")
    return value


def context_snapshot_required_uuid(
    snapshot: Mapping[str, object],
    key: str,
) -> UUID:
    value = context_snapshot_optional_uuid(snapshot, key)
    if value is None:
        raise ValueError(f"context snapshot {key} is required")
    return value


def context_snapshot_required_mapping(
    snapshot: Mapping[str, object],
    key: str,
) -> dict[str, object]:
    value = context_snapshot_optional_mapping(snapshot, key)
    if value is None:
        raise ValueError(f"context snapshot {key} is required")
    return value


def context_snapshot_optional_string(
    snapshot: Mapping[str, object],
    key: str,
    *,
    allow_blank: bool = False,
) -> str | None:
    value = _optional_snapshot_value(snapshot, key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"context snapshot {key} must be a string")
    if not allow_blank and not value.strip():
        raise ValueError(f"context snapshot {key} must be a non-empty string")
    return value


def context_snapshot_optional_uuid(
    snapshot: Mapping[str, object],
    key: str,
) -> UUID | None:
    value = _optional_snapshot_value(snapshot, key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"context snapshot {key} must be a UUID string")
    try:
        return UUID(value)
    except ValueError:
        raise ValueError(f"context snapshot {key} must be a UUID string") from None


def context_snapshot_optional_positive_int(
    snapshot: Mapping[str, object],
    key: str,
) -> int | None:
    value = _optional_snapshot_value(snapshot, key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"context snapshot {key} must be a positive integer")
    return value


def context_snapshot_optional_mapping(
    snapshot: Mapping[str, object],
    key: str,
) -> dict[str, object] | None:
    value = _optional_snapshot_value(snapshot, key)
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError(f"context snapshot {key} must be an object")
    return dict(value)


def context_snapshot_optional_highlight_color(
    snapshot: Mapping[str, object],
    key: str,
) -> str | None:
    value = _optional_snapshot_value(snapshot, key)
    if value is None:
        return None
    if not isinstance(value, str) or value not in HIGHLIGHT_COLOR_VALUES:
        raise ValueError(f"context snapshot {key} must be a highlight color")
    return value


def _optional_snapshot_value(snapshot: Mapping[str, object], key: str) -> object | None:
    if key not in snapshot:
        return None
    value = snapshot[key]
    if value is None:
        return None
    return value


def context_evidence_span_ids(
    payload: Mapping[str, object],
) -> list[UUID]:
    payload = trusted_context_snapshot(payload)
    raw_values = payload.get("evidence_span_ids")
    if raw_values is None:
        return []
    return trusted_evidence_span_ids(raw_values)


def artifact_part_context_ref(
    *,
    artifact_part_id: UUID,
    artifact_id: UUID,
    source_version: str,
    locator: BaseModel | Mapping[str, object],
    evidence_span_id: UUID | None = None,
    evidence_span_ids: Sequence[UUID | str] = (),
    artifact_kind: str | None = None,
    message_id: UUID | None = None,
    conversation_id: UUID | None = None,
    artifact_key: str | None = None,
    artifact_version: int | None = None,
    artifact_title: str | None = None,
    ordinal: int | None = None,
    part_key: str | None = None,
    part_type: str | None = None,
    text: str | None = None,
    source_ref: BaseModel | Mapping[str, object] | None = None,
    context_ref: BaseModel | Mapping[str, object] | None = None,
    result_ref: BaseModel | Mapping[str, object] | None = None,
    source_refs: Sequence[BaseModel | Mapping[str, object]] = (),
    metadata: Mapping[str, object] | None = None,
) -> MessageContextRef:
    raw_locator = (
        locator.model_dump(mode="json") if isinstance(locator, BaseModel) else dict(locator)
    )
    stored_locator = retrieval_locator_json(raw_locator)
    if stored_locator is None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Artifact part context provenance cannot be verified",
        )
    context_evidence_span_ids = canonical_evidence_span_ids(
        [
            *evidence_span_ids,
            *([evidence_span_id] if evidence_span_id is not None else []),
        ]
    )
    provenance_evidence_span_ids = (
        [
            value
            for value in context_evidence_span_ids
            if evidence_span_id is None or value != evidence_span_id
        ]
        if context_evidence_span_ids
        else []
    )
    provenance = MessageArtifactPartProvenance.model_validate(
        {
            "type": "artifact_part",
            "artifact_id": artifact_id,
            "artifact_kind": artifact_kind,
            "message_id": message_id,
            "conversation_id": conversation_id,
            "artifact_key": artifact_key,
            "artifact_version": artifact_version,
            "artifact_title": artifact_title,
            "artifact_part_id": artifact_part_id,
            "ordinal": ordinal,
            "part_key": part_key,
            "part_type": part_type,
            "text": text,
            "source_version": source_version,
            "locator": stored_locator,
            "source_ref": _model_or_mapping_payload(source_ref),
            "context_ref": _model_or_mapping_payload(context_ref),
            "result_ref": _model_or_mapping_payload(result_ref),
            "evidence_span_id": evidence_span_id,
            "evidence_span_ids": provenance_evidence_span_ids,
            "source_refs": [
                payload
                for source in source_refs
                if (payload := _model_or_mapping_payload(source)) is not None
            ],
            "metadata": dict(metadata or {}),
        }
    )
    return MessageContextRef.model_validate(
        {
            "type": "artifact_part",
            "id": artifact_part_id,
            "evidence_span_ids": context_evidence_span_ids,
            "artifact_id": artifact_id,
            "artifact_key": artifact_key,
            "artifact_version": artifact_version,
            "source_version": source_version,
            "locator": stored_locator,
            "artifact_part_provenance": provenance.model_dump(mode="json", exclude_none=True),
        }
    )


def _model_or_mapping_payload(
    value: BaseModel | Mapping[str, object] | None,
) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=True)
    return dict(value)


def trusted_content_chunk_context_snapshot_fields(
    *,
    object_type: str | None,
    object_id: UUID | None,
    payload: object,
) -> dict[str, object]:
    snapshot = trusted_context_snapshot(payload)
    object_payload = trusted_object_ref_context_snapshot_payload(
        object_type=object_type,
        object_id=object_id,
        payload=snapshot,
    )
    if object_payload["type"] != "content_chunk":
        raise ValueError("context snapshot type must be content_chunk")
    return {
        "evidence_span_ids": object_payload["evidence_span_ids"],
        "source_version": context_snapshot_required_string(snapshot, "source_version"),
        "locator": context_snapshot_required_mapping(snapshot, "locator"),
    }


def artifact_context_snapshot_fields(
    snapshot: Mapping[str, object],
) -> dict[str, object]:
    artifact_id = context_snapshot_required_uuid(snapshot, "id")
    fields: dict[str, object] = {}

    stored_artifact_id = context_snapshot_optional_uuid(snapshot, "artifact_id")
    if stored_artifact_id is not None:
        if stored_artifact_id != artifact_id:
            raise ValueError("context snapshot artifact_id must match id")
        fields["artifact_id"] = str(stored_artifact_id)

    artifact_key = context_snapshot_optional_string(snapshot, "artifact_key")
    if artifact_key is not None:
        fields["artifact_key"] = artifact_key
    artifact_version = context_snapshot_optional_positive_int(snapshot, "artifact_version")
    if artifact_version is not None:
        fields["artifact_version"] = artifact_version

    provenance = context_snapshot_optional_mapping(snapshot, "artifact_part_provenance")
    if provenance is None:
        return fields
    provenance_type = context_snapshot_required_string(provenance, "type")
    if provenance_type != "artifact":
        raise ValueError("artifact_part_provenance type must be artifact")
    if context_snapshot_required_uuid(provenance, "artifact_id") != artifact_id:
        raise ValueError("artifact_part_provenance artifact_id must match id")
    provenance_artifact_key = context_snapshot_optional_string(provenance, "artifact_key")
    if (
        artifact_key is not None
        and provenance_artifact_key is not None
        and provenance_artifact_key != artifact_key
    ):
        raise ValueError("artifact_part_provenance artifact_key must match artifact_key")
    provenance_artifact_version = context_snapshot_optional_positive_int(
        provenance,
        "artifact_version",
    )
    if (
        artifact_version is not None
        and provenance_artifact_version is not None
        and provenance_artifact_version != artifact_version
    ):
        raise ValueError("artifact_part_provenance artifact_version must match artifact_version")
    fields["artifact_part_provenance"] = provenance
    return fields


def artifact_part_context_snapshot_fields(
    snapshot: Mapping[str, object],
) -> dict[str, object]:
    artifact_part_id = context_snapshot_required_uuid(snapshot, "id")
    artifact_id = context_snapshot_required_uuid(snapshot, "artifact_id")
    source_version = context_snapshot_required_string(snapshot, "source_version")
    locator = context_snapshot_required_mapping(snapshot, "locator")
    if locator.get("type") != "artifact_part_ref":
        raise ValueError("context snapshot locator must be artifact_part_ref")
    if context_snapshot_required_uuid(locator, "artifact_id") != artifact_id:
        raise ValueError("context snapshot locator artifact_id must match artifact_id")
    if context_snapshot_required_uuid(locator, "artifact_part_id") != artifact_part_id:
        raise ValueError("context snapshot locator artifact_part_id must match id")
    provenance = context_snapshot_required_mapping(snapshot, "artifact_part_provenance")
    provenance_type = context_snapshot_required_string(provenance, "type")
    if provenance_type != "artifact_part":
        raise ValueError("artifact_part_provenance type must be artifact_part")
    if context_snapshot_required_uuid(provenance, "artifact_id") != artifact_id:
        raise ValueError("artifact_part_provenance artifact_id must match artifact_id")
    if context_snapshot_required_uuid(provenance, "artifact_part_id") != artifact_part_id:
        raise ValueError("artifact_part_provenance artifact_part_id must match id")
    artifact_version = context_snapshot_optional_positive_int(snapshot, "artifact_version")
    provenance_artifact_version = context_snapshot_optional_positive_int(
        provenance,
        "artifact_version",
    )
    if (
        artifact_version is not None
        and provenance_artifact_version is not None
        and provenance_artifact_version != artifact_version
    ):
        raise ValueError("artifact_part_provenance artifact_version must match artifact_version")
    if context_snapshot_required_string(provenance, "source_version") != source_version:
        raise ValueError("artifact_part_provenance source_version must match source_version")
    if context_snapshot_required_mapping(provenance, "locator") != locator:
        raise ValueError("artifact_part_provenance locator must match locator")

    fields: dict[str, object] = {
        "artifact_id": str(artifact_id),
        "source_version": source_version,
        "locator": locator,
        "artifact_part_provenance": provenance,
    }
    artifact_key = context_snapshot_optional_string(snapshot, "artifact_key")
    if artifact_key is not None:
        fields["artifact_key"] = artifact_key
    if artifact_version is not None:
        fields["artifact_version"] = artifact_version
    return fields


def object_ref_context_snapshot(
    *,
    object_type: str,
    object_id: UUID | str,
    title: str,
    preview: str | None = None,
    route: str | None = None,
    evidence_span_ids: Sequence[UUID | str] = (),
    media_id: UUID | str | None = None,
    media_kind: str | None = None,
    media_title: str | None = None,
    locator: Mapping[str, object] | None = None,
    source_version: str | None = None,
) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "kind": "object_ref",
        "type": object_type,
        "id": str(object_id),
        "title": title,
    }
    if preview is not None:
        snapshot["preview"] = preview
    if route is not None:
        snapshot["route"] = route
    trusted_span_ids = trusted_evidence_span_ids(list(evidence_span_ids))
    if trusted_span_ids:
        snapshot["evidence_span_ids"] = [
            str(evidence_span_id) for evidence_span_id in trusted_span_ids
        ]
    if media_id is not None:
        snapshot["media_id"] = str(media_id)
    if media_kind is not None:
        snapshot["media_kind"] = media_kind
    if media_title is not None:
        snapshot["media_title"] = media_title
    if locator is not None:
        snapshot["locator"] = dict(locator)
    if source_version is not None:
        snapshot["source_version"] = source_version
    return snapshot


def object_ref_context_snapshot_from_hydrated(
    hydrated: HydratedObjectRef,
    *,
    evidence_span_ids: Sequence[UUID | str] = (),
    media_id: UUID | str | None = None,
    media_kind: str | None = None,
    media_title: str | None = None,
    locator: Mapping[str, object] | None = None,
    source_version: str | None = None,
) -> dict[str, object]:
    return object_ref_context_snapshot(
        object_type=hydrated.object_type,
        object_id=hydrated.object_id,
        title=hydrated.label,
        preview=hydrated.snippet,
        route=hydrated.route,
        evidence_span_ids=evidence_span_ids,
        media_id=media_id,
        media_kind=media_kind,
        media_title=media_title,
        locator=locator,
        source_version=source_version,
    )
