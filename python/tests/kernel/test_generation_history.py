"""Historical presentation must not rehydrate obsolete executable tool grants."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.presence import Present
from nexus.services.generation_history import read_generation_history
from nexus.services.generation_spec import decode_generation_spec_document, generation_fact_digest
from nexus.services.tool_runtime.composition import freeze_tool_plan_snapshot
from tests.testkit.codex_generation import codex_generation_draft, codex_model_tool_fixture


def test_historical_selection_survives_without_accepting_old_tool_authority() -> None:
    _registry, tools = codex_model_tool_fixture()
    original = codex_generation_draft(
        request_id=uuid4(),
        operation="chat",
        instructions="Answer with evidence.",
        input_text="A historical request.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        model_tool_plan=freeze_tool_plan_snapshot(tools.operations["ChatRead"]),
    ).spec
    document = original.model_dump(mode="json", by_alias=True)
    for grant in document["model_tool_plan_snapshot"]["value"]["grants"]:
        del grant["implementation_revision"]
    del document["fingerprint"]
    document["fingerprint"] = generation_fact_digest(document)

    try:
        history = read_generation_history(document)
    except ValidationError:
        pytest.fail("historical selection attempted to reconstruct executable tool authority")

    assert history.selection == original.selection
    assert history.display_at_dispatch == original.display_at_dispatch
    assert history.tool_effect_mode == original.tool_effect_mode
    assert isinstance(history.model_tool_plan_snapshot, Present)
    assert isinstance(original.model_tool_plan_snapshot, Present)
    assert history.model_tool_plan_snapshot.value.plan_revision == (
        original.model_tool_plan_snapshot.value.plan_revision
    )
    with pytest.raises(ValidationError, match="implementation_revision"):
        decode_generation_spec_document(document)
