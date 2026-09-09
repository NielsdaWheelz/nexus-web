"""Immutable generation presentation facts, without executable tool authority."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict

from nexus.schemas.llm import SelectionPresentation
from nexus.schemas.presence import Presence
from nexus.services.generation_selection import GenerationSelectionSpec
from nexus.services.generation_spec import ResolvedDispatchTargetSnapshot
from nexus.services.llm_ledger import generation_spec_document


class ToolPlanIdentity(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True, strict=True)

    plan_id: str
    plan_revision: str


class GenerationHistory(BaseModel):
    """A read projection of stable facts, never an admission or dispatch input."""

    model_config = ConfigDict(extra="ignore", frozen=True, strict=True)

    operation: str
    selection_source: Literal["ChatRun", "BackgroundPolicy"]
    selection: GenerationSelectionSpec
    resolved_dispatch_target: ResolvedDispatchTargetSnapshot
    catalog_definition_revision: str
    source_catalog_definition_revision: str
    display_at_dispatch: SelectionPresentation
    tool_effect_mode: Presence[Literal["ReadOnly", "AdditiveWrites"]]
    model_tool_plan_snapshot: Presence[ToolPlanIdentity]


def read_generation_history(value: dict[str, object]) -> GenerationHistory:
    # Retain full-document integrity verification, without reconstructing a
    # tool implementation or accepting historical grants for execution.
    document = generation_spec_document(value)
    return GenerationHistory.model_validate_json(json.dumps(document.value))
