"""A chat run's selection as admitted, from its stored generation spec."""

from __future__ import annotations

import json
from uuid import UUID

from nexus.db.models import ChatRun
from nexus.schemas.llm import RunSelectionOut
from nexus.services.generation.contract import GenerationSpec


def run_selection_out(run: ChatRun) -> RunSelectionOut:
    """Project the admitted selection without consulting current availability."""

    spec = GenerationSpec.model_validate_json(json.dumps(run.generation_spec))
    if spec.display_at_dispatch is None or spec.effect_mode is None:
        raise AssertionError(f"chat run {run.id} lacks its admitted presentation or tools")
    return RunSelectionOut(
        selection=spec.selection,
        display_at_dispatch=spec.display_at_dispatch,
        tool_authority=spec.effect_mode,
    )


def run_selections_out(runs: list[ChatRun]) -> dict[UUID, RunSelectionOut]:
    return {run.id: run_selection_out(run) for run in runs}
