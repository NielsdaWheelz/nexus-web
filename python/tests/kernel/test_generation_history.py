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


@pytest.mark.parametrize(
    ("operation", "selection_source", "expected_error"),
    [
        (None, None, "invalid generation spec"),
        ("dossier_library", "ChatRun", "invalid generation spec"),
        ("chat", "BackgroundPolicy", "invalid generation spec"),
        ("dossier_library", "BackgroundPolicy", "non-Chat generation spec"),
        ("chat", "ChatRun", None),
    ],
    ids=("malformed", "wrong-operation", "wrong-source", "non-chat", "historical-chat"),
)
def test_chat_history_projection_enforces_its_stored_document_boundary(
    operation: str | None,
    selection_source: str | None,
    expected_error: str | None,
) -> None:
    import asyncio

    from nexus.db.models import ChatRun
    from nexus.services.chat_run_selection import run_selection_out
    from tests.testkit.generation_catalog import configured_chat_catalog_service

    _registry, tools = codex_model_tool_fixture()
    original = codex_generation_draft(
        request_id=uuid4(),
        operation="chat",
        instructions="Answer with evidence.",
        input_text="A historical Chat request.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
        model_tool_plan=freeze_tool_plan_snapshot(tools.operations["ChatRead"]),
    ).spec
    document = original.model_dump(mode="json", by_alias=True)
    for grant in document["model_tool_plan_snapshot"]["value"]["grants"]:
        del grant["implementation_revision"]
    document["operation"] = operation
    document["selection_source"] = selection_source
    del document["fingerprint"]
    document["fingerprint"] = generation_fact_digest(document)
    if operation is None:
        document = {}
    run = ChatRun(id=uuid4(), status="complete", generation_spec=document)
    snapshot = asyncio.run(configured_chat_catalog_service().read_chat())

    if expected_error is not None:
        with pytest.raises(AssertionError, match=expected_error):
            run_selection_out(run, catalog_snapshot=snapshot)
        return

    selection = run_selection_out(run, catalog_snapshot=snapshot)
    assert selection.selection == original.selection
    assert selection.display_at_dispatch == original.display_at_dispatch
    assert selection.tool_authority == "ReadOnly"
    with pytest.raises(ValidationError, match="implementation_revision"):
        decode_generation_spec_document(document)
