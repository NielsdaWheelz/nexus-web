from llm_tools import ToolEffect

from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS


def test_assistant_write_surface_uses_only_closed_additive_canonical_tools() -> None:
    writes = tuple(
        declaration
        for declaration in NEXUS_TOOL_DECLARATIONS
        if declaration.spec.effect is ToolEffect.Write
    )
    tool_ids = tuple(str(declaration.spec.id) for declaration in writes)
    assert tool_ids == (
        "nexus.library.add",
        "nexus.note.create",
        "nexus.highlight.create",
        "nexus.edge.create",
        "nexus.queue.add",
    )
    destructive_tokens = {"delete", "destroy", "overwrite", "remove", "replace"}
    leaked = {
        tool_id: sorted(token for token in destructive_tokens if token in tool_id.casefold())
        for tool_id in tool_ids
    }
    assert not any(leaked.values()), f"destructive assistant tool escaped the allowlist: {leaked}"
    assert all(
        declaration.spec.input_schema.semantic.get("additionalProperties") is False
        for declaration in writes
    ), "assistant write schemas must reject unreviewed arguments"
