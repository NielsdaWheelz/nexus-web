"""Canonical evidence-span ID handling."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID


class EvidenceSpanIdError(ValueError):
    """Base error for evidence-span ID canonicalization defects."""


class EvidenceSpanIdsNotArrayError(EvidenceSpanIdError):
    """Raised when a trusted evidence-span ID container is not an array."""


class EvidenceSpanIdInvalidError(EvidenceSpanIdError):
    """Raised when an evidence-span ID value is not a UUID."""


class EvidenceSpanIdsDuplicateError(EvidenceSpanIdError):
    """Raised when trusted evidence-span IDs contain duplicates."""


def canonical_evidence_span_ids(values: Sequence[UUID | str]) -> list[UUID]:
    evidence_span_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        evidence_span_id = _parse_evidence_span_id(value)
        if evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        evidence_span_ids.append(evidence_span_id)
    return evidence_span_ids


def trusted_evidence_span_ids(values: object) -> list[UUID]:
    if not isinstance(values, list):
        raise EvidenceSpanIdsNotArrayError("evidence_span_ids must be an array of UUIDs")

    evidence_span_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        evidence_span_id = _parse_evidence_span_id(value)
        if evidence_span_id in seen:
            raise EvidenceSpanIdsDuplicateError("evidence_span_ids must not contain duplicates")
        seen.add(evidence_span_id)
        evidence_span_ids.append(evidence_span_id)
    return evidence_span_ids


def _parse_evidence_span_id(value: object) -> UUID:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        raise EvidenceSpanIdInvalidError("evidence_span_ids must be UUIDs") from None
