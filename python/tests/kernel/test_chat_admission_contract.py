"""Admission wire proof: the reviewed corpus is the independent protocol oracle."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from nexus.schemas import conversation


def test_chat_admission_receipts_accept_only_the_closed_reviewed_wire_contract() -> None:
    assert hasattr(conversation, "ChatAdmissionReceipt"), (
        "the conversation schema must own chat admission receipts"
    )
    corpus = json.loads(
        (Path(__file__).parents[3] / "testdata/contracts/chat-admission-receipts.json").read_text()
    )
    for case in corpus["valid"]:
        receipt = conversation.ChatAdmissionReceipt.model_validate(case["value"])
        assert receipt.model_dump(mode="json") == case["value"], case["name"]
    for case in corpus["invalid"]:
        with pytest.raises(ValidationError, match=".+"):
            conversation.ChatAdmissionReceipt.model_validate(case["value"])
