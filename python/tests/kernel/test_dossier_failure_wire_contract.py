"""Closed current-write and migration-tagged Dossier failure contracts."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from nexus.schemas.artifact import ArtifactBuildEventOut, DossierBuildSummary

_ABSENT = {"kind": "Absent"}


def _failure_payload(code: str) -> dict[str, object]:
    return {
        "failure_code": code,
        "detail": _ABSENT,
        "support": _ABSENT,
    }


def _event(event_type: str, failure_code: str) -> ArtifactBuildEventOut:
    return ArtifactBuildEventOut.model_validate(
        {
            "seq": 1,
            "event_type": event_type,
            "payload": _failure_payload(failure_code),
        }
    )


def _snapshot(failure_code: str) -> DossierBuildSummary:
    return DossierBuildSummary.model_validate(
        {
            "handle": "artifact-build-handle",
            "requester_user_id": _ABSENT,
            "instruction": _ABSENT,
            "created_at": "2026-08-25T12:00:00Z",
            "execution": _ABSENT,
            "failure": {
                "kind": "Present",
                "value": _failure_payload(failure_code),
            },
            "cancellation": _ABSENT,
        }
    )


def test_current_and_historical_failure_events_have_disjoint_vocabularies() -> None:
    assert _event("Failed", "Timeout").payload.failure_code == "Timeout"
    assert _event("HistoricalFailed", "ProviderRefused").payload.failure_code == "ProviderRefused"

    with pytest.raises(ValidationError):
        _event("Failed", "ProviderRefused")
    with pytest.raises(ValidationError):
        _event("HistoricalFailed", "Timeout")


def test_head_snapshot_reads_preserved_current_and_historical_failure_rows() -> None:
    assert _snapshot("Timeout").failure.value.failure_code == "Timeout"
    assert _snapshot("ProviderRefused").failure.value.failure_code == "ProviderRefused"

    with pytest.raises(ValidationError):
        _snapshot("UnknownFailure")
