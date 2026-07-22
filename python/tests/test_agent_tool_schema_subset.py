"""Every chat agent-tool parameter schema satisfies the canonical JSON-Schema subset.

Structural rules from the llm-provider-runtime hard cutover (§5): object nodes are
closed (``additionalProperties: false``, ``required`` lists exactly every property),
optional values are required-nullable ``anyOf [X, {"type": "null"}]`` unions,
arrays have one homogeneous ``items`` schema, scalars may carry only a non-empty
type-compatible ``enum``, ``title``/``description`` are the only annotations, and
range/length/format/composition keywords are forbidden (rich constraints live in
each tool's domain validator).

NOTE: this local checker is a stopgap. It is replaced by
``provider_runtime.parse_canonical_schema`` when the new runtime is pinned
(Phase C of the cutover); at that point these schemas validate at planning time
and this module can assert through the runtime parser instead.
"""

from __future__ import annotations

import pytest

from nexus.services.agent_tools.app_search import APP_SEARCH_TOOL_DEFINITION
from nexus.services.agent_tools.inspect_resource import INSPECT_RESOURCE_TOOL_DEFINITION
from nexus.services.agent_tools.read_resource import READ_RESOURCE_TOOL_DEFINITION
from nexus.services.agent_tools.web_search import WEB_SEARCH_TOOL_DEFINITION
from nexus.services.agent_tools.writes import ASSISTANT_WRITE_TOOL_DEFINITIONS

pytestmark = pytest.mark.unit

ALL_AGENT_TOOL_DEFINITIONS: tuple[dict, ...] = (
    APP_SEARCH_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_DEFINITION,
    READ_RESOURCE_TOOL_DEFINITION,
    INSPECT_RESOURCE_TOOL_DEFINITION,
    *ASSISTANT_WRITE_TOOL_DEFINITIONS,
)

_ANNOTATIONS = {"title", "description"}
_SCALAR_TYPES = {"string": str, "number": (int, float), "integer": int, "boolean": bool}
_FORBIDDEN = {
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
    "format",
    "oneOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "patternProperties",
    "nullable",
    "definitions",
    "$defs",
    "$ref",
}  # $defs/$ref are subset-legal at the root but unused by agent tools; kept forbidden here.


def _check_node(node: object, path: str) -> None:
    assert isinstance(node, dict), f"{path}: schema node must be a dict"
    keys = set(node)
    assert not keys & _FORBIDDEN, f"{path}: forbidden keywords {sorted(keys & _FORBIDDEN)}"
    if "anyOf" in node:
        assert keys <= {"anyOf"} | _ANNOTATIONS, f"{path}: anyOf node has extra keys {keys}"
        branches = node["anyOf"]
        assert isinstance(branches, list) and len(branches) == 2, (
            f"{path}: unions must be exactly [non-null, null]"
        )
        assert branches[1] == {"type": "null"}, f"{path}: second union arm must be the null node"
        assert isinstance(branches[0], dict) and branches[0].get("type") != "null", (
            f"{path}: first union arm must be a non-null node"
        )
        _check_node(branches[0], f"{path}.anyOf[0]")
        return
    node_type = node.get("type")
    assert isinstance(node_type, str), f"{path}: type must be one string (no type arrays)"
    if node_type == "object":
        assert keys <= {"type", "properties", "required", "additionalProperties"} | _ANNOTATIONS
        properties = node.get("properties")
        assert isinstance(properties, dict) and properties, f"{path}: finite properties required"
        assert node.get("additionalProperties") is False, (
            f"{path}: additionalProperties must be exactly false"
        )
        assert sorted(node.get("required") or []) == sorted(properties), (
            f"{path}: required must list exactly every property"
        )
        for name, sub in properties.items():
            _check_node(sub, f"{path}.properties.{name}")
    elif node_type == "array":
        assert keys <= {"type", "items"} | _ANNOTATIONS, f"{path}: array node has extra keys"
        assert isinstance(node.get("items"), dict), f"{path}: one homogeneous items schema required"
        _check_node(node["items"], f"{path}.items")
    elif node_type in _SCALAR_TYPES:
        assert keys <= {"type", "enum"} | _ANNOTATIONS, f"{path}: scalar node has extra keys"
        if "enum" in node:
            enum = node["enum"]
            assert isinstance(enum, list) and enum, f"{path}: enum must be non-empty"
            expected = _SCALAR_TYPES[node_type]
            assert all(
                isinstance(value, expected)
                and (node_type == "boolean" or not isinstance(value, bool))
                for value in enum
            ), f"{path}: enum values must match type {node_type}"
    else:
        pytest.fail(f"{path}: type {node_type!r} is outside the canonical subset")


def test_all_nine_agent_tools_are_covered():
    names = [definition["name"] for definition in ALL_AGENT_TOOL_DEFINITIONS]
    assert len(names) == len(set(names)) == 9, f"expected the 9 agent tools, got {names}"


@pytest.mark.parametrize(
    "definition",
    ALL_AGENT_TOOL_DEFINITIONS,
    ids=[definition["name"] for definition in ALL_AGENT_TOOL_DEFINITIONS],
)
def test_agent_tool_schema_satisfies_canonical_subset(definition):
    parameters = definition["parameters"]
    assert parameters.get("type") == "object", "schema root must be an object node"
    _check_node(parameters, f"$({definition['name']})")
