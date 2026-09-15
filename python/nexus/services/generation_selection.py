"""Exact route-tagged generation selections shared by policy, API, and ledger."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ModelKey = Annotated[
    str,
    StringConstraints(min_length=1, max_length=256, pattern=r"^[^\s]+$"),
]
AgentReasoningKey = Annotated[
    str,
    StringConstraints(min_length=1, max_length=64, pattern=r"^[^\s]+$"),
]
ProviderReasoningLevel = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]


class _Selection(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CodexPersonalSelection(_Selection):
    route: Literal["CodexPersonal"]
    model: ModelKey
    reasoning: AgentReasoningKey


class ProviderApiSelection(_Selection):
    route: Literal["ProviderApi"]
    model_ref: ModelKey
    reasoning: ProviderReasoningLevel


GenerationSelectionSpec = Annotated[
    CodexPersonalSelection | ProviderApiSelection,
    Field(discriminator="route"),
]


def selection_fingerprint(selection: CodexPersonalSelection | ProviderApiSelection) -> str:
    """Return the domain-separated identity of one exact selection."""

    payload = json.dumps(
        selection.model_dump(mode="json"),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(b"nexus.generation-selection.v1\0" + payload).hexdigest()


__all__ = [
    "AgentReasoningKey",
    "CodexPersonalSelection",
    "GenerationSelectionSpec",
    "ModelKey",
    "ProviderApiSelection",
    "ProviderReasoningLevel",
    "selection_fingerprint",
]
