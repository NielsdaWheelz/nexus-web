"""Closed Oracle event/failure wire contract."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from nexus.schemas.oracle import (
    OracleReadingEventOut,
    oracle_done_payload,
    oracle_event_payload,
    oracle_read_failure_code,
    oracle_reading_failure_code,
)


def test_oracle_done_contract_accepts_only_expected_product_failures() -> None:
    assert oracle_done_payload(status="failed", error_code="cancelled") == {
        "status": "failed",
        "error_code": "cancelled",
    }
    assert oracle_done_payload(status="complete", error_code=None) == {
        "status": "complete",
        "error_code": None,
    }

    for retired in ("defect", "E_INTERNAL", "budget_exceeded", "provider_unavailable"):
        with pytest.raises(ValidationError):
            oracle_reading_failure_code(retired)

    with pytest.raises(ValidationError):
        oracle_done_payload(status="complete", error_code="timeout")
    with pytest.raises(ValidationError):
        oracle_done_payload(status="failed", error_code=None)


def test_historical_oracle_failures_require_migration_tagged_replay() -> None:
    assert oracle_read_failure_code("provider_unavailable") == "provider_unavailable"
    assert oracle_read_failure_code("E_INTERNAL") == "E_INTERNAL"
    historical = OracleReadingEventOut.model_validate(
        {
            "seq": 1,
            "event_type": "historical_done",
            "payload": {
                "status": "failed",
                "error_code": "provider_unavailable",
            },
        }
    )
    assert historical.event_type == "historical_done"

    with pytest.raises(ValidationError):
        OracleReadingEventOut.model_validate(
            {
                "seq": 1,
                "event_type": "done",
                "payload": {
                    "status": "failed",
                    "error_code": "provider_unavailable",
                },
            }
        )
    with pytest.raises(ValidationError):
        OracleReadingEventOut.model_validate(
            {
                "seq": 1,
                "event_type": "historical_done",
                "payload": {"status": "failed", "error_code": "timeout"},
            }
        )


def test_oracle_event_contract_rejects_unknown_fields_and_payloads() -> None:
    assert oracle_event_payload("argument", {"text": "Read the signs."}) == {
        "text": "Read the signs."
    }
    with pytest.raises(ValidationError):
        oracle_event_payload("argument", {"text": "Read the signs.", "legacy": True})
    with pytest.raises(ValidationError):
        OracleReadingEventOut(seq=1, event_type="done", payload={"status": "complete"})
    with pytest.raises(ValidationError):
        OracleReadingEventOut(seq=1, event_type="done", payload={"error_code": None})
    with pytest.raises(ValidationError):
        OracleReadingEventOut(
            seq=1,
            event_type="historical_done",
            payload={"error_code": "provider_unavailable"},
        )
    with pytest.raises(ValidationError):
        OracleReadingEventOut(
            seq=0,
            event_type="done",
            payload={
                "status": "complete",
                "error_code": None,
            },
        )
