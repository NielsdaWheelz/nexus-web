"""Single read projection for one frozen Chat generation selection.

The durable ``ChatRun.generation_spec`` is the sole dispatch truth. Read paths
must combine it with one explicit catalog observation; they never infer a
selection from mutable policy, provider fields, browser state, or a default.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from nexus.db.models import ChatRun
from nexus.schemas.llm import Ineligible, RunSelectionOut, Selectable
from nexus.schemas.presence import Present
from nexus.services.chat_failure import rerun_eligibility
from nexus.services.generation_catalog import (
    GenerationCatalogSnapshot,
    ResolvedCatalogPair,
)
from nexus.services.generation_history import read_generation_history
from nexus.services.generation_spec import GenerationSpec, decode_generation_spec_document


def chat_generation_spec(run: ChatRun) -> GenerationSpec:
    """Decode the sole frozen Chat dispatch document at its storage boundary."""

    try:
        spec = decode_generation_spec_document(run.generation_spec)
    except (TypeError, ValueError) as error:
        raise AssertionError(f"Chat run {run.id} carries an invalid generation spec") from error
    if spec.operation != "chat" or spec.selection_source != "ChatRun":
        raise AssertionError(f"Chat run {run.id} carries a non-Chat generation spec")
    return spec


def run_selection_out(
    run: ChatRun,
    *,
    catalog_snapshot: GenerationCatalogSnapshot | None = None,
    pair: ResolvedCatalogPair | None = None,
    observed_at: datetime | None = None,
) -> RunSelectionOut:
    """Project immutable dispatch facts plus exactly one current observation."""

    # justify-defect: malformed durable Chat facts are storage corruption.
    try:
        spec = read_generation_history(run.generation_spec)
    except (TypeError, ValueError) as error:
        raise AssertionError(f"Chat run {run.id} carries an invalid generation spec") from error
    # justify-service-invariant-check: generic history also represents background work.
    # justify-defect: a Chat row must retain its original Chat admission identity.
    if spec.operation != "chat" or spec.selection_source != "ChatRun":
        raise AssertionError(f"Chat run {run.id} carries a non-Chat generation spec")
    if (catalog_snapshot is None) == (pair is None):
        raise ValueError("run selection projection requires exactly one catalog observation")
    if catalog_snapshot is not None:
        pair = catalog_snapshot.pair(spec.selection)
        observed_at = catalog_snapshot.catalog.observed_at
    if observed_at is None or observed_at.tzinfo is None or observed_at.utcoffset() is None:
        raise ValueError("run selection projection requires an aware observation timestamp")

    if pair is None:
        current_state = Ineligible(
            code="selection_not_configured",
            explanation="This run's exact selection is no longer in the configured catalog.",
        )
    else:
        if pair.selection.model_dump(mode="json") != spec.selection.model_dump(mode="json"):
            raise AssertionError("catalog observation does not match the frozen Chat selection")
        current_state = pair.state

    if not isinstance(spec.tool_effect_mode, Present):
        raise AssertionError(f"Chat run {run.id} lacks frozen tool authority")
    selection_selectable = isinstance(current_state, Selectable)
    if run.status == "complete":
        rerun_allowed = selection_selectable
    else:
        error_code = "cancelled" if run.status == "cancelled" else run.error_code
        rerun_allowed = bool(
            error_code is not None
            and rerun_eligibility(
                error_code=error_code,
                run_status=run.status,
                selection_selectable=selection_selectable,
            )
        )

    return RunSelectionOut(
        selection=spec.selection,
        catalog_definition_revision=spec.catalog_definition_revision,
        source_catalog_definition_revision=spec.source_catalog_definition_revision,
        display_at_dispatch=spec.display_at_dispatch,
        tool_authority=spec.tool_effect_mode.value,
        current_state=current_state,
        current_state_observed_at=observed_at,
        rerun_eligibility=rerun_allowed,
    )


def run_selections_out(
    runs: list[ChatRun],
    *,
    catalog_snapshot: GenerationCatalogSnapshot,
) -> dict[UUID, RunSelectionOut]:
    """Project a loaded run set against one coherent catalog observation."""

    return {run.id: run_selection_out(run, catalog_snapshot=catalog_snapshot) for run in runs}
