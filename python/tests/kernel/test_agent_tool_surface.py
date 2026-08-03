from nexus.services.agent_tools.writes import (
    ASSISTANT_WRITE_TOOL_DEFINITIONS,
    WRITE_TOOL_NAMES,
)


def test_assistant_write_surface_is_closed_and_additive_only() -> None:
    names = tuple(definition["name"] for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS)
    assert names == WRITE_TOOL_NAMES
    assert names == (
        "add_to_library",
        "jot_note",
        "create_highlight",
        "mint_edge",
        "queue_add",
    )
    destructive_tokens = {"delete", "destroy", "overwrite", "remove", "replace"}
    leaked = {
        definition["name"]: sorted(
            token for token in destructive_tokens if token in str(definition["name"]).casefold()
        )
        for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS
    }
    assert not any(leaked.values()), f"destructive assistant tool escaped the allowlist: {leaked}"
    assert all(
        definition["parameters"].get("additionalProperties") is False
        for definition in ASSISTANT_WRITE_TOOL_DEFINITIONS
    ), "assistant write schemas must reject unreviewed arguments"
