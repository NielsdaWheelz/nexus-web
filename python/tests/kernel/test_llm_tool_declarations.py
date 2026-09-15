from __future__ import annotations

import copy
import hashlib
import importlib.util
import math
import re
from dataclasses import replace
from pathlib import Path
from typing import Annotated, Any, Literal, get_args

from llm_tools import (
    WEB_READ_SPEC,
    WEB_SEARCH_SPEC,
    CapabilityProfile,
    HostTable,
    Native,
    ProfileId,
    PromptDocument,
    RunLimits,
    ToolEffect,
    ToolGrant,
    ToolId,
    ToolLimits,
    ToolPlan,
    ToolSpec,
    canonical_json_bytes,
)
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

REPO_ROOT = Path(__file__).resolve().parents[3]
PROJECTION_PATH = Path("apps/web/src/lib/conversations/toolContractProjection.ts")

COMMON_ERRORS = {
    "BudgetExceeded",
    "DeadlineExceeded",
    "InvalidInput",
    "ToolUnavailable",
}

# Logical result/context caps remain schema or binding-policy inputs. Portable
# ToolLimits/RunLimits are byte budgets; this proof measures their strict executor
# envelopes from the compiled schemas below instead of trusting copied byte counts.
EXPECTED_DECLARATIONS: dict[str, dict[str, Any]] = {
    "web.search": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Searching the web",
        "input_keys": ("freshness_days", "query"),
        "success_keys": (
            "evidence",
            "observed_at",
            "provider",
            "provider_request_id",
            "results",
        ),
        "errors": COMMON_ERRORS | {"InvalidUpstreamResponse", "RateLimited", "UpstreamUnavailable"},
        "limits": ToolLimits(4096, 32768, 2, 15.0),
    },
    "web.read": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Reading a web page",
        "input_keys": ("url",),
        "success_keys": ("evidence", "final_url", "media_type", "text", "title"),
        "errors": COMMON_ERRORS
        | {
            "InvalidUpstreamResponse",
            "InvalidUrl",
            "RateLimited",
            "TooLarge",
            "UnsafeDestination",
            "UnsupportedContent",
            "UpstreamUnavailable",
        },
        "limits": ToolLimits(24616, 524288, 8, 20.0),
    },
    "nexus.search": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Searching Nexus",
        "input_keys": ("authors", "formats", "kinds", "limit", "query", "roles", "scopes"),
        "success_keys": ("matches", "total_candidates"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable"},
        "evidence_path": ("matches", "items", "evidence"),
        "limits": ToolLimits(20480, 106496, 0, 30.0),
    },
    "nexus.resource.read": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Reading a resource",
        "input_keys": ("uri",),
        "success_keys": ("evidence", "kind", "text", "uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "TooLarge", "Unreadable"},
        "evidence_path": ("evidence",),
        "limits": ToolLimits(4096, 348160, 0, 30.0),
    },
    "nexus.document.search": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Searching this document",
        "input_keys": ("limit", "query", "uri"),
        "success_keys": ("matches", "uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "Unreadable"},
        "evidence_path": ("matches", "items", "evidence"),
        "limits": ToolLimits(4096, 217088, 0, 30.0),
    },
    "nexus.resource.inspect": {
        "effect": ToolEffect.Read,
        "result_kind": "navigation",
        "activity_label": "Mapping this document",
        "input_keys": ("uri",),
        "success_keys": ("evidence", "media_kind", "sections", "title", "total_sections", "uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "Uninspectable"},
        "evidence_path": ("evidence",),
        "limits": ToolLimits(4096, 1720320, 0, 30.0),
    },
    "nexus.relations.list": {
        "effect": ToolEffect.Read,
        "result_kind": "retrieval",
        "activity_label": "Reading connections",
        "input_keys": ("direction", "kinds", "limit", "uri"),
        "success_keys": ("evidence", "relations", "uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable"},
        "evidence_path": ("evidence",),
        "limits": ToolLimits(4096, 544768, 0, 30.0),
    },
    "nexus.library.add": {
        "effect": ToolEffect.Write,
        "result_kind": "mutation",
        "activity_label": "Adding to a library",
        "input_keys": ("library_id", "library_name", "resource_uri"),
        "success_keys": ("already_present", "library_name", "library_uri", "resource_uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "TargetAmbiguous", "WriteCapReached"},
        "limits": ToolLimits(4096, 4096, 0, 30.0),
    },
    "nexus.note.create": {
        "effect": ToolEffect.Write,
        "result_kind": "mutation",
        "activity_label": "Creating a note",
        "input_keys": ("markdown", "page_uri"),
        "success_keys": ("note_uri", "page_uri"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "WriteCapReached"},
        "limits": ToolLimits(139264, 4096, 0, 30.0),
    },
    "nexus.highlight.create": {
        "effect": ToolEffect.Write,
        "result_kind": "mutation",
        "activity_label": "Creating a highlight",
        "input_keys": ("color", "exact", "media_uri", "note", "prefix", "suffix"),
        "success_keys": ("exact", "highlight_uri", "note_uri"),
        "errors": COMMON_ERRORS
        | {
            "Conflict",
            "QuoteAmbiguous",
            "QuoteNotFound",
            "ResourceUnavailable",
            "WriteCapReached",
        },
        "limits": ToolLimits(286720, 139264, 0, 30.0),
    },
    "nexus.edge.create": {
        "effect": ToolEffect.Write,
        "result_kind": "mutation",
        "activity_label": "Creating a connection",
        "input_keys": ("kind", "rationale", "source_uri", "target_uri"),
        "success_keys": ("edge_id", "kind", "rationale", "source_uri", "target_uri"),
        "errors": COMMON_ERRORS | {"Conflict", "ResourceUnavailable", "WriteCapReached"},
        "limits": ToolLimits(8192, 8192, 0, 30.0),
    },
    "nexus.queue.add": {
        "effect": ToolEffect.Write,
        "result_kind": "mutation",
        "activity_label": "Adding to the queue",
        "input_keys": ("media_uri",),
        "success_keys": ("already_present", "media_uri", "queue_entry_id", "title"),
        "errors": COMMON_ERRORS | {"ResourceUnavailable", "WriteCapReached"},
        "limits": ToolLimits(4096, 8192, 0, 30.0),
    },
}

EXPECTED_BROWSER_CONTRACT = {
    "fields": (
        "activity_label",
        "canonical_tool_id",
        "effect",
        "error_type",
        "provider_wire_name",
        "record_kind",
        "result_kind",
    ),
    "effects": ("Pure", "Read", "Write"),
    "result_kinds": (
        "attached_context",
        "mutation",
        "navigation",
        "rejected_provider_call",
        "retrieval",
    ),
    "error_types": tuple(
        sorted(set().union(*(row["errors"] for row in EXPECTED_DECLARATIONS.values())))
    ),
    "record_kinds": (
        "attached_context",
        "current_execution",
        "historical_execution",
        "rejected_provider_call",
    ),
    "record_shapes": {
        "attached_context": {
            "non_null_fields": ("activity_label", "record_kind", "result_kind"),
            "null_fields": (
                "canonical_tool_id",
                "effect",
                "error_type",
                "provider_wire_name",
            ),
            "nullable_fields": (),
        },
        "current_execution": {
            "non_null_fields": (
                "activity_label",
                "canonical_tool_id",
                "effect",
                "record_kind",
                "result_kind",
            ),
            "null_fields": (),
            "nullable_fields": ("error_type", "provider_wire_name"),
        },
        "historical_execution": {
            "non_null_fields": (
                "activity_label",
                "canonical_tool_id",
                "effect",
                "record_kind",
                "result_kind",
            ),
            "null_fields": ("error_type", "provider_wire_name"),
            "nullable_fields": (),
        },
        "rejected_provider_call": {
            "non_null_fields": (
                "activity_label",
                "provider_wire_name",
                "record_kind",
                "result_kind",
            ),
            "null_fields": ("canonical_tool_id", "effect", "error_type"),
            "nullable_fields": (),
        },
    },
}
EXPECTED_RESULT_KIND_PROJECTION = tuple(
    row["result_kind"] for row in EXPECTED_DECLARATIONS.values()
)

CHAT_RUN_LIMITS = RunLimits(
    max_calls=64,
    max_external_attempts=128,
    max_input_bytes=4194304,
    max_output_bytes=16777216,
    max_in_flight=1,
    max_elapsed_seconds=900.0,
)
IDEA_DOSSIER_RESEARCH_RUN_LIMITS = RunLimits(
    max_calls=3,
    max_external_attempts=6,
    max_input_bytes=12288,
    max_output_bytes=98304,
    max_in_flight=1,
    max_elapsed_seconds=60.0,
)

EXPECTED_EVIDENCE_KEYS = (
    "admission_scope",
    "citation_target",
    "content_sha256",
    "context_ref",
    "excerpt_id",
    "locator",
    "machine_authorship",
    "observed_at",
    "resource_uri",
    "snapshot_revision",
)

_FINITE_STRING_FORMAT_VALUES = {
    "date": "9999-12-31",
    "date-time": "9999-12-31T23:59:59.999999+23:59",
    "uuid": "ffffffff-ffff-4fff-bfff-ffffffffffff",
}
_MAXIMAL_PATTERN_STRING_VALUES = {
    r"^generation/[1-9][0-9]*/tool/[1-9][0-9]*$": ("generation/2147483647/tool/2147483647"),
}


def _object_keys(schema: dict[str, Any]) -> tuple[str, ...]:
    assert schema.get("type") == "object"
    properties = schema.get("properties")
    assert isinstance(properties, dict)
    return tuple(sorted(properties))


def _assert_recursively_closed_required_and_bounded(schema: object, *, path: str) -> None:
    if isinstance(schema, list):
        for index, item in enumerate(schema):
            _assert_recursively_closed_required_and_bounded(item, path=f"{path}[{index}]")
        return
    if not isinstance(schema, dict):
        return
    if "const" in schema or "enum" in schema:
        return
    if schema.get("type") == "object":
        properties = schema.get("properties")
        assert isinstance(properties, dict), f"{path} has no properties"
        assert schema.get("additionalProperties") is False, f"{path} is open"
        assert set(schema.get("required", ())) == set(properties), f"{path} has optional JSON keys"
    elif schema.get("type") == "array":
        assert "maxItems" in schema, f"{path} has no logical item cap"
    elif schema.get("type") == "string":
        string_format = schema.get("format")
        assert "maxLength" in schema or string_format in _FINITE_STRING_FORMAT_VALUES, (
            f"{path} has no logical character cap"
        )
    elif schema.get("type") in {"integer", "number"}:
        assert "minimum" in schema and "maximum" in schema, f"{path} has no numeric range"
    for key in ("anyOf", "oneOf", "items", "properties"):
        value = schema.get(key)
        if key == "properties" and isinstance(value, dict):
            for name, child in value.items():
                _assert_recursively_closed_required_and_bounded(child, path=f"{path}.{name}")
        elif value is not None:
            _assert_recursively_closed_required_and_bounded(value, path=f"{path}.{key}")


def _non_null_schema(schema: dict[str, Any]) -> dict[str, Any]:
    branches = schema.get("anyOf") or schema.get("oneOf")
    if branches is None:
        return schema
    candidates = [branch for branch in branches if branch.get("type") != "null"]
    assert len(candidates) == 1
    return candidates[0]


def _schema_at(schema: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any]:
    current = schema
    for part in path:
        current = _non_null_schema(current)
        if part == "items":
            child = current.get("items")
        else:
            properties = current.get("properties")
            assert isinstance(properties, dict), f"{path!r} does not cross an object at {part!r}"
            child = properties.get(part)
        assert isinstance(child, dict), f"{path!r} has no schema at {part!r}"
        current = child
    return _non_null_schema(current)


def _error_contract(schema: dict[str, Any]) -> dict[str, dict[str, Any]]:
    branches = schema.get("anyOf")
    assert isinstance(branches, list)
    contract: dict[str, dict[str, Any]] = {}
    for branch in branches:
        assert _object_keys(branch) == ("type",)
        tag = branch["properties"]["type"]
        assert tag == {"const": tag["const"], "type": "string"}
        contract[tag["const"]] = branch
    return contract


def _largest(values: list[Any]) -> Any:
    assert values
    return max(values, key=lambda value: len(canonical_json_bytes(value)))


def _maximal_schema_value(schema: dict[str, Any], *, path: str) -> Any:
    if "const" in schema:
        return schema["const"]
    enum = schema.get("enum")
    if isinstance(enum, list):
        return _largest(enum)
    for union_key in ("anyOf", "oneOf"):
        branches = schema.get(union_key)
        if isinstance(branches, list):
            return _largest(
                [
                    _maximal_schema_value(branch, path=f"{path}.{union_key}[{index}]")
                    for index, branch in enumerate(branches)
                ]
            )
    schema_type = schema.get("type")
    if schema_type == "object":
        properties = schema.get("properties")
        assert isinstance(properties, dict)
        return {
            name: _maximal_schema_value(child, path=f"{path}.{name}")
            for name, child in properties.items()
        }
    if schema_type == "array":
        item = schema.get("items")
        count = schema.get("maxItems")
        assert isinstance(item, dict) and isinstance(count, int), f"{path} is not bounded"
        value = _maximal_schema_value(item, path=f"{path}.items")
        return [value for _ in range(count)]
    if schema_type == "string":
        max_length = schema.get("maxLength")
        if isinstance(max_length, int):
            pattern = schema.get("pattern")
            if isinstance(pattern, str):
                value = _MAXIMAL_PATTERN_STRING_VALUES.get(pattern)
                assert isinstance(value, str) and len(value) == max_length, (
                    f"{path} patterned example does not exercise its length bound"
                )
                assert re.search(pattern, value) is not None, (
                    f"{path} patterned example is not valid"
                )
                return value
            # A control character consumes six canonical JSON bytes per code point.
            return "\u0001" * max_length
        string_format = schema.get("format")
        assert string_format in _FINITE_STRING_FORMAT_VALUES, f"{path} is not bounded"
        return _FINITE_STRING_FORMAT_VALUES[string_format]
    if schema_type in {"integer", "number"}:
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        assert isinstance(minimum, (int, float)) and isinstance(maximum, (int, float))
        return _largest([minimum, maximum])
    if schema_type == "boolean":
        return False
    if schema_type == "null":
        return None
    raise AssertionError(f"{path} has unsupported schema shape: {schema!r}")


def _rounded_budget(measured_bytes: int) -> int:
    with_headroom = math.ceil(measured_bytes * 1.125)
    return max(4096, math.ceil(with_headroom / 4096) * 4096)


def _measured_envelope_limits(spec: ToolSpec[Any, Any, Any]) -> tuple[int, int]:
    maximal_input = _maximal_schema_value(spec.input_schema.semantic, path=f"{spec.id}.input")
    maximal_success = _maximal_schema_value(spec.success_schema.semantic, path=f"{spec.id}.success")
    maximal_error = _maximal_schema_value(spec.error_schema.semantic, path=f"{spec.id}.error")
    TypeAdapter(spec.input_type).validate_json(canonical_json_bytes(maximal_input), strict=True)
    TypeAdapter(spec.success_type).validate_json(canonical_json_bytes(maximal_success), strict=True)
    input_bytes = len(canonical_json_bytes({"type": "ParsedJson", "value": maximal_input}))
    output_bytes = max(
        len(canonical_json_bytes({"type": "Success", "value": maximal_success})),
        len(canonical_json_bytes({"type": "Failure", "error": maximal_error})),
    )
    return _rounded_budget(input_bytes), _rounded_budget(output_bytes)


def _reverse_sequences(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _reverse_sequences(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return tuple(_reverse_sequences(child) for child in reversed(value))
    return value


def _field_description(schema: dict[str, Any], field: str) -> str:
    properties = schema["properties"]
    value = properties[field]
    description = value.get("description")
    assert isinstance(description, str) and description.strip(), f"{field} needs model-visible help"
    return description


def _sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _load_projection_generator() -> Any:
    path = REPO_ROOT / "python/scripts/generate_tool_contract_projection.py"
    module_spec = importlib.util.spec_from_file_location("generate_tool_contract_projection", path)
    assert module_spec is not None and module_spec.loader is not None
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


class _RevisionSuccess(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Whether the synthetic operation succeeded.")


class _EnumInputA(BaseModel):
    model_config = ConfigDict(extra="forbid", title="EnumInput")

    kind: Annotated[
        Literal["context", "supports", "contradicts"],
        Field(description="Synthetic owner vocabulary."),
    ]


class _EnumInputReordered(BaseModel):
    model_config = ConfigDict(extra="forbid", title="EnumInput")

    kind: Annotated[
        Literal["contradicts", "context", "supports"],
        Field(description="Synthetic owner vocabulary."),
    ]


class _EnumInputRedocumented(BaseModel):
    model_config = ConfigDict(extra="forbid", title="EnumInput")

    kind: Annotated[
        Literal["context", "supports", "contradicts"],
        Field(description="Documentation changed, membership did not."),
    ]


class _EnumInputWidened(BaseModel):
    model_config = ConfigDict(extra="forbid", title="EnumInput")

    kind: Annotated[
        Literal["context", "supports", "contradicts", "refutes"],
        Field(description="Synthetic owner vocabulary."),
    ]


def _revision_probe(input_type: type[BaseModel]) -> ToolSpec[Any, Any, Any]:
    return ToolSpec(
        id=ToolId("test.revision"),
        summary="Exercise the semantic revision oracle.",
        documentation=PromptDocument("Only a test contract."),
        input_type=input_type,
        success_type=_RevisionSuccess,
        error_type=WEB_SEARCH_SPEC.error_type,
        effect=ToolEffect.Pure,
        limits=ToolLimits(4096, 4096, 0, 1.0),
    )


def test_nexus_declarations_and_browser_projection_are_one_closed_semantic_contract() -> None:
    from nexus.schemas.highlights import HIGHLIGHT_COLORS
    from nexus.schemas.library import CreateLibraryRequest
    from nexus.schemas.resource_graph import ConnectionQueryRequest
    from nexus.services.agent_tools.app_search import APP_SEARCH_LIMIT
    from nexus.services.contributor_taxonomy import (
        CONTRIBUTOR_ROLES_ORDERED,
        MAX_CONTRIBUTOR_HANDLE_LENGTH,
    )
    from nexus.services.media_read_map import _MAX_MAP_SECTIONS, READ_DOCUMENT_MAX_CHARS
    from nexus.services.resource_graph.schemas import (
        EDGE_KINDS,
        ConnectionDirection,
    )
    from nexus.services.resource_items.capabilities import app_search_scope_hint
    from nexus.services.search.kinds import SEARCH_FORMATS, SEARCH_KINDS
    from nexus.services.tool_runtime.declarations import (
        BROWSER_TOOL_PROJECTION_CONTRACT,
        BROWSER_TOOL_PROJECTION_REVISION,
        CHAT_TOOL_DECLARATIONS,
        NEXUS_TOOL_DECLARATIONS,
        browser_tool_projection_revision,
        tool_surface_documentation_revision,
    )
    from nexus.services.tool_runtime.profiles import (
        CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION,
        CHAT_READ_ADDITIVE_WRITE_TOOL_PLAN,
        CHAT_READ_ADDITIVE_WRITE_TOOL_PROFILE,
        CHAT_READ_TOOL_PLAN,
        CHAT_READ_TOOL_PROFILE,
        IDEA_DOSSIER_READ_TOOL_PLAN,
        IDEA_DOSSIER_READ_TOOL_PROFILE,
        IDEA_DOSSIER_RESEARCH_TOOL_PLAN,
        IDEA_DOSSIER_RESEARCH_TOOL_PROFILE,
        LIBRARY_DOSSIER_READ_TOOL_PLAN,
        LIBRARY_DOSSIER_READ_TOOL_PROFILE,
    )

    nexus_ids = tuple(key for key in EXPECTED_DECLARATIONS if key.startswith("nexus."))
    assert tuple(str(entry.spec.id) for entry in NEXUS_TOOL_DECLARATIONS) == nexus_ids
    assert tuple(str(entry.spec.id) for entry in CHAT_TOOL_DECLARATIONS) == tuple(
        EXPECTED_DECLARATIONS
    )
    assert CHAT_TOOL_DECLARATIONS[0].spec is WEB_SEARCH_SPEC
    assert CHAT_TOOL_DECLARATIONS[1].spec is WEB_READ_SPEC

    for entry in CHAT_TOOL_DECLARATIONS:
        tool_id = str(entry.spec.id)
        expected = EXPECTED_DECLARATIONS[tool_id]
        spec = entry.spec
        assert spec.effect is expected["effect"], f"{tool_id} declaration effect drifted"
        assert entry.result_kind == expected["result_kind"]
        assert entry.activity_label == expected["activity_label"]
        assert spec.limits == expected["limits"]
        assert _object_keys(spec.input_schema.semantic) == expected["input_keys"]
        assert _object_keys(spec.success_schema.semantic) == expected["success_keys"]
        assert set(_error_contract(spec.error_schema.semantic)) == expected["errors"]
        if tool_id.startswith("nexus."):
            _assert_recursively_closed_required_and_bounded(
                spec.input_schema.semantic, path=f"{tool_id}.input"
            )
            _assert_recursively_closed_required_and_bounded(
                spec.success_schema.semantic, path=f"{tool_id}.success"
            )
            _assert_recursively_closed_required_and_bounded(
                spec.error_schema.semantic, path=f"{tool_id}.error"
            )
            assert _measured_envelope_limits(spec) == (
                spec.limits.max_input_bytes,
                spec.limits.max_output_bytes,
            )
        evidence_path = expected.get("evidence_path")
        if evidence_path is not None:
            evidence_schema = _schema_at(spec.success_schema.semantic, evidence_path)
            assert _object_keys(evidence_schema) == EXPECTED_EVIDENCE_KEYS

        assert 0 < len(spec.summary) <= 90 and spec.summary.endswith(".")
        assert "\n" not in spec.summary
        assert 40 <= len(spec.documentation.text) <= 800
        assert re.fullmatch(r"[A-Z][^.!?]{2,48}", entry.activity_label)
        for field in expected["input_keys"]:
            _field_description(spec.input_schema.presentation, field)
        if spec.effect is ToolEffect.Read:
            assert "untrusted" in spec.documentation.text.casefold()
        if spec.effect is ToolEffect.Write:
            assert "user" in spec.documentation.text.casefold()

    # The strict semantic contract is owner-derived, while scope admission is a
    # binding-policy input. Search vocabularies are enums; scope schemes are not.
    search_spec = NEXUS_TOOL_DECLARATIONS[0].spec
    search_input = search_spec.input_schema.semantic
    search_success = search_spec.success_schema.semantic
    assert set(_schema_at(search_input, ("kinds", "items"))["enum"]) == set(SEARCH_KINDS)
    assert set(_schema_at(search_input, ("formats", "items"))["enum"]) == set(SEARCH_FORMATS)
    assert set(_schema_at(search_input, ("roles", "items"))["enum"]) == set(
        CONTRIBUTOR_ROLES_ORDERED
    )
    assert (
        _schema_at(search_input, ("authors", "items"))["maxLength"] == MAX_CONTRIBUTOR_HANDLE_LENGTH
    )
    assert _schema_at(search_input, ("limit",))["maximum"] == APP_SEARCH_LIMIT
    assert _schema_at(search_success, ("matches",))["maxItems"] == APP_SEARCH_LIMIT
    assert "enum" not in _schema_at(search_input, ("scopes", "items"))
    assert app_search_scope_hint() in _field_description(
        search_spec.input_schema.presentation, "scopes"
    )
    highlight_input = NEXUS_TOOL_DECLARATIONS[7].spec.input_schema.semantic
    assert set(_schema_at(highlight_input, ("color",))["enum"]) == set(get_args(HIGHLIGHT_COLORS))
    edge_input = NEXUS_TOOL_DECLARATIONS[8].spec.input_schema.semantic
    assert set(_schema_at(edge_input, ("kind",))["enum"]) == set(EDGE_KINDS)
    relations_spec = NEXUS_TOOL_DECLARATIONS[4].spec
    relations_input = relations_spec.input_schema.semantic
    relation_limit = ConnectionQueryRequest.model_json_schema()["properties"]["limit"]["maximum"]
    assert set(_schema_at(relations_input, ("direction",))["enum"]) == set(
        get_args(ConnectionDirection)
    )
    assert set(_schema_at(relations_input, ("kinds", "items"))["enum"]) == set(EDGE_KINDS)
    assert _schema_at(relations_input, ("limit",))["maximum"] == relation_limit
    assert (
        _schema_at(relations_spec.success_schema.semantic, ("relations",))["maxItems"]
        == relation_limit
    )
    assert (
        _schema_at(
            NEXUS_TOOL_DECLARATIONS[1].spec.success_schema.semantic,
            ("text",),
        )["maxLength"]
        == READ_DOCUMENT_MAX_CHARS
    )
    assert (
        _schema_at(
            NEXUS_TOOL_DECLARATIONS[3].spec.success_schema.semantic,
            ("sections",),
        )["maxItems"]
        == _MAX_MAP_SECTIONS
    )
    library_name_max = CreateLibraryRequest.model_json_schema()["properties"]["name"]["maxLength"]
    library_spec = NEXUS_TOOL_DECLARATIONS[5].spec
    assert _schema_at(library_spec.input_schema.semantic, ("library_name",))["maxLength"] == (
        library_name_max
    )
    assert _schema_at(library_spec.success_schema.semantic, ("library_name",))["maxLength"] == (
        library_name_max
    )

    read_tool_ids = ("web.search", *nexus_ids[:5])
    nexus_read_tool_ids = nexus_ids[:5]
    assert CHAT_READ_TOOL_PROFILE == CapabilityProfile(
        id=ProfileId("chat_read"),
        grants=tuple(ToolGrant(id=ToolId(tool_id), limits=None) for tool_id in read_tool_ids),
        run_limits=CHAT_RUN_LIMITS,
    )
    assert CHAT_READ_TOOL_PLAN == ToolPlan(profile=ProfileId("chat_read"), exposure=Native())
    assert CHAT_READ_ADDITIVE_WRITE_TOOL_PROFILE == CapabilityProfile(
        id=ProfileId("chat_read_additive_write"),
        grants=tuple(
            ToolGrant(id=ToolId(tool_id), limits=None) for tool_id in ("web.search", *nexus_ids)
        ),
        run_limits=CHAT_RUN_LIMITS,
    )
    assert CHAT_READ_ADDITIVE_WRITE_TOOL_PLAN == ToolPlan(
        profile=ProfileId("chat_read_additive_write"), exposure=Native()
    )
    assert CHAT_READ_ADDITIVE_WRITE_TOOL_DEFINITION.max_live_writes == 8
    assert LIBRARY_DOSSIER_READ_TOOL_PROFILE == CapabilityProfile(
        id=ProfileId("library_dossier_read"),
        grants=tuple(ToolGrant(id=ToolId(tool_id), limits=None) for tool_id in nexus_read_tool_ids),
        run_limits=RunLimits(16, 0, 262_144, 4_194_304, 1, 120.0),
    )
    assert LIBRARY_DOSSIER_READ_TOOL_PLAN == ToolPlan(
        profile=ProfileId("library_dossier_read"), exposure=Native()
    )
    assert IDEA_DOSSIER_READ_TOOL_PROFILE == CapabilityProfile(
        id=ProfileId("idea_dossier_read"),
        grants=tuple(ToolGrant(id=ToolId(tool_id), limits=None) for tool_id in nexus_read_tool_ids),
        run_limits=RunLimits(12, 0, 131_072, 2_097_152, 1, 120.0),
    )
    assert IDEA_DOSSIER_READ_TOOL_PLAN == ToolPlan(
        profile=ProfileId("idea_dossier_read"), exposure=Native()
    )
    assert IDEA_DOSSIER_RESEARCH_TOOL_PROFILE == CapabilityProfile(
        id=ProfileId("idea_dossier_research"),
        grants=(ToolGrant(id=ToolId("web.search"), limits=None),),
        run_limits=IDEA_DOSSIER_RESEARCH_RUN_LIMITS,
    )
    assert IDEA_DOSSIER_RESEARCH_TOOL_PLAN == ToolPlan(
        profile=ProfileId("idea_dossier_research"), exposure=HostTable()
    )

    # Schema descriptions, declaration prose, and activity labels are
    # presentation. Enum order is not semantic; enum membership is.
    original = NEXUS_TOOL_DECLARATIONS[0]
    prose_changed = replace(
        original,
        spec=replace(original.spec, summary="Search the admitted Nexus corpus."),
    )
    help_changed = replace(
        original,
        spec=replace(
            original.spec,
            documentation=PromptDocument("Changed model-facing usage guidance."),
        ),
    )
    label_changed = replace(original, activity_label="Searching the Nexus corpus")
    assert prose_changed.spec.tool_contract_revision == original.spec.tool_contract_revision
    assert prose_changed.spec.documentation_revision != original.spec.documentation_revision
    assert tool_surface_documentation_revision((prose_changed,)) != (
        tool_surface_documentation_revision((original,))
    )
    assert tool_surface_documentation_revision((help_changed,)) != (
        tool_surface_documentation_revision((original,))
    )
    assert tool_surface_documentation_revision((label_changed,)) != (
        tool_surface_documentation_revision((original,))
    )
    ordered = _revision_probe(_EnumInputA)
    reordered = _revision_probe(_EnumInputReordered)
    redocumented = _revision_probe(_EnumInputRedocumented)
    widened = _revision_probe(_EnumInputWidened)
    assert ordered.tool_contract_revision == reordered.tool_contract_revision
    assert ordered.documentation_revision == reordered.documentation_revision
    assert ordered.tool_contract_revision == redocumented.tool_contract_revision
    assert ordered.documentation_revision != redocumented.documentation_revision
    assert ordered.tool_contract_revision != widened.tool_contract_revision
    assert tool_surface_documentation_revision((replace(original, spec=ordered),)) != (
        tool_surface_documentation_revision((replace(original, spec=redocumented),))
    )

    assert BROWSER_TOOL_PROJECTION_CONTRACT == EXPECTED_BROWSER_CONTRACT
    expected_projection_revision = _sha256(
        {
            "declaration_result_kinds": EXPECTED_RESULT_KIND_PROJECTION,
            "wire_contract": EXPECTED_BROWSER_CONTRACT,
        }
    )
    assert BROWSER_TOOL_PROJECTION_REVISION == expected_projection_revision
    assert (
        browser_tool_projection_revision(
            EXPECTED_BROWSER_CONTRACT,
            EXPECTED_RESULT_KIND_PROJECTION,
        )
        == expected_projection_revision
    )
    reordered_projection = _reverse_sequences(EXPECTED_BROWSER_CONTRACT)
    assert (
        browser_tool_projection_revision(
            reordered_projection,
            EXPECTED_RESULT_KIND_PROJECTION,
        )
        == expected_projection_revision
    )
    for field in ("effects", "error_types", "fields", "record_kinds", "result_kinds"):
        widened_projection = copy.deepcopy(EXPECTED_BROWSER_CONTRACT)
        widened_projection[field] += ("NewValue",)
        assert (
            browser_tool_projection_revision(
                widened_projection,
                EXPECTED_RESULT_KIND_PROJECTION,
            )
            != expected_projection_revision
        )
    widened_projection = copy.deepcopy(EXPECTED_BROWSER_CONTRACT)
    widened_projection["record_shapes"]["current_execution"]["nullable_fields"] += (
        "provider_wire_name",
    )
    assert (
        browser_tool_projection_revision(
            widened_projection,
            EXPECTED_RESULT_KIND_PROJECTION,
        )
        != expected_projection_revision
    )
    changed_result_kinds = list(EXPECTED_RESULT_KIND_PROJECTION)
    changed_result_kinds[1] = "navigation"
    assert (
        browser_tool_projection_revision(
            EXPECTED_BROWSER_CONTRACT,
            tuple(changed_result_kinds),
        )
        != expected_projection_revision
    )

    # The committed browser artifact contains only the same-system projection
    # shape. Tool ids, descriptions, search vocabulary, profiles, and binding
    # policy remain server-owned and cannot drift into a second registry.
    generator = _load_projection_generator()
    assert Path(generator.PROJECTION_RELATIVE_PATH) == PROJECTION_PATH
    rendered = generator.render_projection()
    assert (REPO_ROOT / PROJECTION_PATH).read_text(encoding="utf-8") == rendered
    contract_json = canonical_json_bytes(EXPECTED_BROWSER_CONTRACT).decode("utf-8")
    assert re.search(
        rf"export const TOOL_CONTRACT_PROJECTION\s*=\s*{re.escape(contract_json)}\s+as const;",
        rendered,
    )
    assert re.search(
        rf'export const TOOL_PROJECTION_REVISION\s*=\s*"{BROWSER_TOOL_PROJECTION_REVISION}"\s+as const;',
        rendered,
    )
    for entry in CHAT_TOOL_DECLARATIONS:
        assert str(entry.spec.id) not in rendered
        assert entry.activity_label not in rendered
    assert "documents" not in rendered
    assert "idea_dossier_research" not in rendered
