"""Every LLM-facing structured-output Pydantic model emits the canonical schema subset.

Compact structural checker for the closed subset in
docs/cutovers/llm-provider-runtime-hard-cutover.md §5: object nodes carry
``required`` == exactly all properties and ``additionalProperties: false``;
the only union is the required-nullable ``anyOf: [non-null, null]``; no value
constraints/defaults/format/const/oneOf/allOf; ``$ref`` only a sibling-free
``#/$defs/<name>`` with acyclic definitions living at the document root.

This checker is replaced by ``provider_runtime.parse_canonical_schema`` at
cutover Phase C.
"""

import pytest
from pydantic import BaseModel

from nexus.services.artifacts.reducers.conversation_distillate import _DistillateSynthesis
from nexus.services.artifacts.reducers.library_dossier import _LiSynthesis
from nexus.services.media_intelligence import MediaUnitSynthesis
from nexus.services.metadata_enrichment import (
    MetadataEnrichmentOutput,
    metadata_structured_output_spec,
)
from nexus.services.oracle import _OracleSynthesisOutput
from nexus.services.synapse import SynapseSynthesis

pytestmark = pytest.mark.unit

LLM_FACING_MODELS: list[type[BaseModel]] = [
    MetadataEnrichmentOutput,  # native structured output (metadata_enrichment)
    _OracleSynthesisOutput,  # structured_synthesis (oracle)
    SynapseSynthesis,  # structured_synthesis (synapse)
    MediaUnitSynthesis,  # structured_synthesis (media_intelligence)
    _LiSynthesis,  # structured_synthesis (library_dossier reducer)
    _DistillateSynthesis,  # structured_synthesis (conversation_distillate reducer)
]

_FORBIDDEN_KEYWORDS = {
    "default", "const", "oneOf", "allOf", "not", "format", "pattern",
    "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems",
    "prefixItems", "patternProperties", "propertyNames", "if", "then", "else",
}  # fmt: skip
_ANNOTATIONS = {"title", "description"}
_SCALAR_TYPES = {"string": str, "number": (int, float), "integer": int, "boolean": bool}


def _check_node(node: dict, *, defs: dict, path: str, ref_stack: tuple[str, ...]) -> None:
    assert isinstance(node, dict), f"{path}: schema node must be an object"
    bad = _FORBIDDEN_KEYWORDS & node.keys()
    assert not bad, f"{path}: forbidden keywords {sorted(bad)}"
    assert "$defs" not in node or path == "#", f"{path}: $defs only at the document root"
    if "$ref" in node:
        assert set(node) == {"$ref"}, f"{path}: $ref must have no siblings"
        name = node["$ref"].removeprefix("#/$defs/")
        assert node["$ref"] == f"#/$defs/{name}" and name in defs, f"{path}: bad ref {node['$ref']}"
        assert name not in ref_stack, f"{path}: recursive ref {node['$ref']}"
        _check_node(defs[name], defs=defs, path=f"#/$defs/{name}", ref_stack=(*ref_stack, name))
        return
    if "anyOf" in node:
        assert set(node) <= {"anyOf", *_ANNOTATIONS}, f"{path}: anyOf with extra keywords"
        arms = node["anyOf"]
        assert len(arms) == 2 and arms[1] == {"type": "null"}, f"{path}: only anyOf [X, null]"
        assert arms[0].get("type") != "null", f"{path}: anyOf non-null arm is null"
        _check_node(arms[0], defs=defs, path=f"{path}/anyOf/0", ref_stack=ref_stack)
        return
    kind = node.get("type")
    if kind == "object":
        allowed = {"type", "properties", "required", "additionalProperties", *_ANNOTATIONS}
        if path == "#":
            allowed = allowed | {"$defs"}
        assert set(node) <= allowed, f"{path}: object node has extra keys {set(node) - allowed}"
        properties = node.get("properties", {})
        assert node.get("additionalProperties") is False, f"{path}: additionalProperties not false"
        required = node.get("required", [])
        assert sorted(required) == sorted(properties), f"{path}: required != all properties"
        for name, sub in properties.items():
            _check_node(sub, defs=defs, path=f"{path}/{name}", ref_stack=ref_stack)
    elif kind == "array":
        assert set(node) <= {"type", "items", *_ANNOTATIONS}, f"{path}: array node has extra keys"
        assert "items" in node, f"{path}: array without items"
        _check_node(node["items"], defs=defs, path=f"{path}/items", ref_stack=ref_stack)
    else:
        assert kind in _SCALAR_TYPES or kind == "null", f"{path}: bad type {kind!r}"
        assert set(node) <= {"type", "enum", *_ANNOTATIONS}, f"{path}: scalar node has extra keys"
        if "enum" in node:
            values = node["enum"]
            expected = _SCALAR_TYPES[kind]
            assert values and all(isinstance(v, expected) for v in values), f"{path}: bad enum"


def _assert_canonical(schema: dict) -> None:
    assert schema.get("type") == "object", "document root must be an object schema"
    _check_node(schema, defs=schema.get("$defs", {}), path="#", ref_stack=())


@pytest.mark.parametrize("model", LLM_FACING_MODELS, ids=lambda m: m.__name__)
def test_llm_facing_model_schema_is_canonical(model: type[BaseModel]) -> None:
    _assert_canonical(model.model_json_schema())


def test_metadata_structured_output_spec_is_the_model_schema() -> None:
    """The one native structured-output wire spec is exactly the model's schema."""
    spec = metadata_structured_output_spec()
    assert spec.schema == MetadataEnrichmentOutput.model_json_schema()
    _assert_canonical(spec.schema)
