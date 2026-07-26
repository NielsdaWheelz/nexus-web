"""Unit wire contracts for chat publication warnings and terminal events."""

import pytest
from pydantic import ValidationError

from nexus.schemas.conversation import (
    ChatRunDoneEventPayload,
    chat_publication_warning_from_nullable,
)
from nexus.schemas.presence import Absent, Present

pytestmark = pytest.mark.unit


def test_publication_warning_projection_is_closed() -> None:
    assert chat_publication_warning_from_nullable(None) == Absent()

    warning = chat_publication_warning_from_nullable("CitationsUnavailable")
    assert isinstance(warning, Present)
    assert warning.value.code == "CitationsUnavailable"

    with pytest.raises(ValueError, match="unknown chat publication warning code"):
        chat_publication_warning_from_nullable("OtherWarning")


def test_done_payload_carries_run_occurrence_and_publication_facts() -> None:
    payload = ChatRunDoneEventPayload.model_validate(
        {
            "status": "complete",
            "error_code": {"kind": "Absent"},
            "support_id": {"kind": "Present", "value": "abc123def456"},
            "publication_warning": {
                "kind": "Present",
                "value": {"code": "CitationsUnavailable"},
            },
            "usage": {"output_tokens": 12},
            "final_chars": 42,
            "last_provider_event_seq": 8,
            "cancelled": False,
        }
    )

    assert payload.model_dump(mode="json") == {
        "status": "complete",
        "error_code": {"kind": "Absent"},
        "support_id": {"kind": "Present", "value": "abc123def456"},
        "publication_warning": {
            "kind": "Present",
            "value": {"code": "CitationsUnavailable"},
        },
        "usage": {"output_tokens": 12},
        "final_chars": 42,
        "last_provider_event_seq": 8,
        "cancelled": False,
    }


@pytest.mark.parametrize("missing", ["error_code", "support_id", "publication_warning"])
def test_done_payload_rejects_missing_owned_presence_fields(missing: str) -> None:
    payload = {
        "status": "error",
        "error_code": {"kind": "Absent"},
        "support_id": {"kind": "Absent"},
        "publication_warning": {"kind": "Absent"},
        "usage": None,
        "final_chars": None,
        "last_provider_event_seq": None,
        "cancelled": False,
    }
    payload.pop(missing)

    with pytest.raises(ValidationError):
        ChatRunDoneEventPayload.model_validate(payload)


@pytest.mark.parametrize("field", ["error_code", "support_id", "publication_warning"])
def test_done_payload_rejects_raw_null_for_owned_presence(field: str) -> None:
    payload = {
        "status": "error",
        "error_code": {"kind": "Absent"},
        "support_id": {"kind": "Absent"},
        "publication_warning": {"kind": "Absent"},
        "usage": None,
        "final_chars": None,
        "last_provider_event_seq": None,
        "cancelled": False,
    }
    payload[field] = None

    with pytest.raises(ValidationError):
        ChatRunDoneEventPayload.model_validate(payload)
