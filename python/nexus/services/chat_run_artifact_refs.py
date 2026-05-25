"""Reference parsers and readability checks for artifact_delta parts."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.coerce import parse_uuid
from nexus.db.models import EvidenceSpan
from nexus.evidence_span_ids import (
    EvidenceSpanIdError,
    EvidenceSpanIdsDuplicateError,
    trusted_evidence_span_ids,
)
from nexus.schemas.context_memory import SourceRef
from nexus.schemas.retrieval import retrieval_context_ref_json, retrieval_result_ref_json
from nexus.services.context_lookup import hydrate_context_ref, hydrate_source_ref


def _artifact_ref_or_die(
    value: object,
    field_name: str,
    validator: Callable[[dict[str, Any]], dict[str, Any] | None],
) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"artifact_delta {field_name} must be an object")
    try:
        return validator(value)
    except ValidationError as exc:
        raise ValueError(f"artifact_delta {field_name} is invalid") from exc


def artifact_source_ref_json(value: object, field_name: str) -> dict[str, Any] | None:
    return _artifact_ref_or_die(
        value,
        field_name,
        lambda v: SourceRef.model_validate(v).model_dump(
            mode="json", exclude_none=True, exclude_defaults=True
        ),
    )


def artifact_context_ref_json(value: object) -> dict[str, Any] | None:
    return _artifact_ref_or_die(value, "context_ref", retrieval_context_ref_json)


def artifact_result_ref_json(value: object) -> dict[str, Any] | None:
    return _artifact_ref_or_die(value, "result_ref", retrieval_result_ref_json)


def artifact_part_has_evidence(
    *,
    source_ref: dict[str, Any] | None,
    context_ref: dict[str, Any] | None,
    result_ref: dict[str, Any] | None,
    evidence_span_id: UUID | None,
    evidence_span_ids: list[str],
    source_refs: list[dict[str, Any]],
    metadata: object,
) -> bool:
    if (
        source_ref is not None
        or context_ref is not None
        or result_ref is not None
        or evidence_span_id is not None
        or evidence_span_ids
        or source_refs
    ):
        return True
    return isinstance(metadata, dict) and metadata.get("support_state") == "not_source_grounded"


def validate_artifact_part_refs_readable(
    db: Session,
    *,
    viewer_id: UUID,
    source_ref: dict[str, Any] | None,
    context_ref: dict[str, Any] | None,
    result_ref: dict[str, Any] | None,
    evidence_span_ids: list[str],
    source_refs: list[dict[str, Any]],
) -> None:
    for ref in ([source_ref] if source_ref is not None else []) + source_refs:
        result = hydrate_source_ref(db, viewer_id=viewer_id, source_ref=ref)
        if not result.resolved:
            raise ValueError("artifact_delta source_ref is not readable")

    if context_ref is not None:
        result = hydrate_context_ref(db, viewer_id=viewer_id, context_ref=context_ref)
        if not result.resolved:
            raise ValueError("artifact_delta context_ref is not readable")

    if result_ref is not None:
        nested_context_ref = result_ref.get("context_ref")
        if isinstance(nested_context_ref, dict) and nested_context_ref.get("type") != "web_result":
            result = hydrate_context_ref(db, viewer_id=viewer_id, context_ref=nested_context_ref)
            if not result.resolved:
                raise ValueError("artifact_delta result_ref context is not readable")

    for raw_id in evidence_span_ids:
        parsed = parse_uuid(raw_id)
        if parsed is None:
            raise ValueError("artifact_delta evidence_span_ids must be UUID strings")
        media_id = db.scalar(select(EvidenceSpan.media_id).where(EvidenceSpan.id == parsed))
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise ValueError("artifact_delta evidence_span_id is not readable")


def artifact_delta_evidence_span_ids(
    *,
    evidence_span_id: UUID | None,
    raw_evidence_span_ids: object,
) -> list[str]:
    if raw_evidence_span_ids is None:
        raw_evidence_span_ids = []
    if not isinstance(raw_evidence_span_ids, list):
        raise ValueError("artifact_delta evidence_span_ids must be an array")
    values: list[UUID | str] = []
    for value in raw_evidence_span_ids:
        if not isinstance(value, str) or not value:
            raise ValueError("artifact_delta evidence_span_ids must be UUID strings")
        values.append(value)
    try:
        evidence_span_ids = trusted_evidence_span_ids(values)
    except EvidenceSpanIdsDuplicateError as exc:
        raise ValueError("artifact_delta evidence_span_ids must not contain duplicates") from exc
    except EvidenceSpanIdError as exc:
        raise ValueError("artifact_delta evidence_span_ids must be UUID strings") from exc
    if evidence_span_id is not None:
        if evidence_span_id in evidence_span_ids:
            raise ValueError("artifact_delta evidence_span_id must not duplicate evidence_span_ids")
        evidence_span_ids.append(evidence_span_id)
    return [str(evidence_span_id) for evidence_span_id in evidence_span_ids]
