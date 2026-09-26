"""Historical selection facts from the frozen Chat generation specification."""

from __future__ import annotations

from uuid import UUID

from nexus.db.models import ChatRun
from nexus.schemas.llm import RunSelectionOut
from nexus.schemas.presence import Present
from nexus.services.generation_spec import (
    GenerationSpec,
    decode_generation_spec_document,
    read_generation_history,
)


def chat_generation_spec(run: ChatRun) -> GenerationSpec:
    """Decode the sole frozen Chat dispatch document at its storage boundary."""

    try:
        spec = decode_generation_spec_document(run.generation_spec)
    except (TypeError, ValueError) as error:
        raise AssertionError(f"Chat run {run.id} carries an invalid generation spec") from error
    if spec.operation != "chat" or spec.selection_source != "ChatRun":
        raise AssertionError(f"Chat run {run.id} carries a non-Chat generation spec")
    return spec


def run_selection_out(run: ChatRun) -> RunSelectionOut:
    """Project only dispatch facts; current eligibility belongs to admission."""

    try:
        spec = read_generation_history(run.generation_spec)
    except (TypeError, ValueError) as error:
        raise AssertionError(f"Chat run {run.id} carries an invalid generation spec") from error
    if not isinstance(spec.tool_effect_mode, Present):
        raise AssertionError(f"Chat run {run.id} lacks frozen tool authority")

    return RunSelectionOut(
        selection=spec.selection,
        catalog_definition_revision=spec.catalog_definition_revision,
        source_catalog_definition_revision=spec.source_catalog_definition_revision,
        display_at_dispatch=spec.display_at_dispatch,
        tool_authority=spec.tool_effect_mode.value,
    )


def run_selections_out(runs: list[ChatRun]) -> dict[UUID, RunSelectionOut]:
    return {run.id: run_selection_out(run) for run in runs}
