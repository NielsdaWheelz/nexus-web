"""Closed non-chat generation adapter portfolio."""

from __future__ import annotations

import ast
from collections.abc import Callable
from importlib import import_module
from importlib.util import find_spec
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING
from uuid import UUID

import pytest

if TYPE_CHECKING:
    from nexus.services.codex_generation_contract import GenerationTerminal
    from nexus.services.generation_intent import GenerationIntent

_GENERATION_ID = UUID("13825d92-5b95-5e1c-8d0f-a4176006b41d")
_REPO_ROOT = Path(__file__).resolve().parents[3]
_FORBIDDEN_POLICY_KEYS = frozenset(
    {
        "backend",
        "max_output_tokens",
        "model",
        "model_name",
        "provider",
        "reasoning",
        "reasoning_effort",
        "retry",
    }
)

_BACKGROUND_TASK_ADAPTERS = (
    (
        "python/nexus/tasks/dawn_write.py",
        "dawn_write_sweep",
        "nexus.services.dawn_write",
        "generate_dawn_write",
        "dawn_write",
    ),
    (
        "python/nexus/tasks/media_unit_build.py",
        "media_unit_build",
        "nexus.services.media_intelligence",
        "run_media_unit_build",
        "media_summary",
    ),
    (
        "python/nexus/tasks/oracle_reading.py",
        "oracle_reading_generate",
        "nexus.services.oracle",
        "execute_reading",
        "oracle",
    ),
    (
        "python/nexus/tasks/synapse_scan.py",
        "synapse_scan",
        "nexus.services.synapse",
        "run_synapse_scan",
        "synapse",
    ),
)
_DIRECT_ROUTE_MODULE_PARTS = (
    "codex_generation_client",
    "codex_generation_host",
    "provider_generation",
    "llm_profiles",
)


def _require_cutover_adapters() -> None:
    assert find_spec("nexus.services.generation_backend") is not None, (
        "route-neutral generation adapters are absent"
    )


def _module_tree(relative_path: str) -> ast.Module:
    path = _REPO_ROOT / relative_path
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function(tree: ast.Module, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
    ]
    assert len(functions) == 1, f"expected exactly one public adapter {name!r}"
    return functions[0]


def _calls(node: ast.AST, name: str) -> list[ast.Call]:
    return [
        candidate
        for candidate in ast.walk(node)
        if isinstance(candidate, ast.Call)
        and (
            (isinstance(candidate.func, ast.Name) and candidate.func.id == name)
            or (isinstance(candidate.func, ast.Attribute) and candidate.func.attr == name)
        )
    ]


def _keyword(call: ast.Call, name: str) -> ast.expr:
    values = [keyword.value for keyword in call.keywords if keyword.arg == name]
    assert len(values) == 1, f"{getattr(call.func, 'id', name)} must freeze one {name!r} fact"
    return values[0]


def _operation_revision(expr: ast.expr, module: ModuleType) -> str:
    assert isinstance(expr, ast.Call)
    assert isinstance(expr.func, ast.Attribute)
    assert isinstance(expr.func.value, ast.Name)
    assert (expr.func.value.id, expr.func.attr) == ("generation_policy", "operation_revision")
    assert len(expr.args) == 1 and not expr.keywords
    operation = expr.args[0]
    if isinstance(operation, ast.Constant) and isinstance(operation.value, str):
        return operation.value
    assert isinstance(operation, ast.Name)
    value = getattr(module, operation.id)
    assert isinstance(value, str)
    return value


def _metadata_intent() -> GenerationIntent:
    from nexus.tasks import enrich_metadata

    return enrich_metadata._metadata_generation_intent(input="A bounded metadata source.")


def _media_intent() -> GenerationIntent:
    from nexus.services import media_intelligence

    return media_intelligence._media_unit_intent(user_content="A bounded media evidence packet.")


def _synapse_intent() -> GenerationIntent:
    from nexus.services import synapse

    return synapse._synapse_intent(
        user_content="A bounded resonance candidate packet.",
    )


def _dawn_intent() -> GenerationIntent:
    from nexus.services import dawn_write

    return dawn_write._dawn_write_intent(
        user_content="A bounded morning signal packet.",
    )


def _oracle_intent() -> GenerationIntent:
    from nexus.services import oracle

    return oracle._oracle_intent(
        user_content="A bounded grounded oracle packet.",
    )


def _dossier_intent(operation: str) -> GenerationIntent:
    from nexus.services.artifacts.generation_step import build_artifact_generation_step
    from nexus.services.artifacts.registry import dossier_registration

    subject_scheme = operation.removeprefix("dossier_")
    if subject_scheme == "note":
        subject_scheme = "note_block"
    registration = dossier_registration(subject_scheme)
    assert registration is not None
    binding = registration.binding
    assert binding.llm_operation == operation
    return build_artifact_generation_step(
        path="synthesis",
        build_id=_GENERATION_ID,
        binding=binding,
        collected=object(),
        witness=object(),
        system_prompt=binding.system_prompt,
        user_content="A bounded dossier evidence packet.",
    ).intent


def _idea_resolve_intent() -> GenerationIntent:
    from nexus.services.artifacts import engine

    return engine._idea_resolution_intent(
        user_content="A bounded Idea candidate packet.",
    )


_INTENTS: dict[str, Callable[[], GenerationIntent]] = {
    "metadata_enrichment": _metadata_intent,
    "media_summary": _media_intent,
    "synapse": _synapse_intent,
    "dawn_write": _dawn_intent,
    "oracle": _oracle_intent,
    **{
        operation: lambda operation=operation: _dossier_intent(operation)
        for operation in (
            "dossier_page",
            "dossier_note",
            "dossier_media",
            "dossier_conversation",
            "dossier_library",
            "dossier_podcast",
            "dossier_contributor",
            "dossier_idea",
        )
    },
    "dossier_idea_resolve": _idea_resolve_intent,
}


@pytest.mark.parametrize("operation", sorted(_INTENTS))
def test_non_chat_operation_owns_content_but_cannot_choose_runtime_policy(operation: str) -> None:
    _require_cutover_adapters()
    from nexus.services import generation_policy
    from nexus.services.generation_intent import (
        JsonSchemaOutput,
        TextOutput,
        validate_intent_bounds,
    )

    intent = _INTENTS[operation]()
    policy = generation_policy.background_operation_policy(operation)
    validate_intent_bounds(
        intent,
        instructions_max_bytes=policy.workflow.bounds.instructions_max_bytes,
        input_max_bytes=policy.workflow.bounds.input_max_bytes,
    )

    assert intent == _INTENTS[operation](), "domain prompt construction is not deterministic"
    payload = intent.model_dump(mode="json", by_alias=True)
    assert set(payload) == {"instructions", "input", "output"}
    output_facts = payload["output"]
    assert isinstance(output_facts, dict)
    assert not ((set(payload) | (set(output_facts) - {"schema"})) & _FORBIDDEN_POLICY_KEYS)
    if isinstance(intent.output, TextOutput):
        assert policy.workflow.output_contract.kind == "Text"
    else:
        assert isinstance(intent.output, JsonSchemaOutput)
        assert intent.output.strict
        assert policy.workflow.output_contract.kind == "StrictJson"


def test_non_chat_operation_portfolio_is_exactly_the_policy_catalog() -> None:
    _require_cutover_adapters()
    from nexus.services import generation_policy
    from nexus.services.generation_policy import ExactModelTools, NoModelTools

    assert set(_INTENTS) == set(generation_policy.GENERATION_POLICY.background_operations)
    tool_operations = {
        operation
        for operation, policy in generation_policy.GENERATION_POLICY.background_operations.items()
        if isinstance(policy.workflow.model_tool_policy, ExactModelTools)
    }
    no_tool_operations = {
        operation
        for operation, policy in generation_policy.GENERATION_POLICY.background_operations.items()
        if isinstance(policy.workflow.model_tool_policy, NoModelTools)
    }
    assert tool_operations == {"dossier_library", "dossier_idea"}
    assert no_tool_operations == set(_INTENTS) - tool_operations


@pytest.mark.parametrize(
    ("task_path", "task_name", "service_module_name", "service_name", "operation"),
    _BACKGROUND_TASK_ADAPTERS,
    ids=("dawn-write", "media-unit", "oracle", "synapse"),
)
def test_background_task_adapters_delegate_one_frozen_route_neutral_generation(
    task_path: str,
    task_name: str,
    service_module_name: str,
    service_name: str,
    operation: str,
) -> None:
    """Risk: a worker adapter bypasses admission or restores a route-specific fallback."""

    _require_cutover_adapters()
    task_tree = _module_tree(task_path)
    imported_modules = {
        node.module
        for node in task_tree.body
        if isinstance(node, ast.ImportFrom) and node.module is not None
    }
    direct_routes = sorted(
        module
        for module in imported_modules
        if any(part in module for part in _DIRECT_ROUTE_MODULE_PARTS)
    )
    assert not direct_routes, (
        f"{task_name} imported route-specific generation owners: {direct_routes!r}"
    )
    service_imports = [
        node
        for node in task_tree.body
        if isinstance(node, ast.ImportFrom) and node.module == service_module_name
    ]
    assert len(service_imports) == 1
    imported_names = [alias.name for alias in service_imports[0].names]
    assert imported_names.count(service_name) == 1

    task = _function(task_tree, task_name)
    delegated = _calls(task, service_name)
    assert len(delegated) == 1, f"{task_name} must delegate exactly one {service_name} call"
    runtime = _keyword(delegated[0], "runtime")
    assert isinstance(runtime, ast.Name) and runtime.id == "runtime"
    envelopes = _calls(task, "run_llm_task")
    assert len(envelopes) == 1
    assert len(envelopes[0].args) == 2
    assert all(isinstance(arg, ast.Name) for arg in envelopes[0].args)
    assert [arg.id for arg in envelopes[0].args if isinstance(arg, ast.Name)] == [
        "_SPEC",
        "_handler",
    ]

    # The task's one domain delegate must in turn freeze an exact operation and
    # prompt revision before entering the sole route-neutral execution owner.
    service_module = import_module(service_module_name)
    service_path = service_module_name.replace(".", "/") + ".py"
    service = _function(_module_tree(f"python/{service_path}"), service_name)
    admissions = _calls(service, "admit_job_generation")
    executions = _calls(service, "execute_generation")
    assert len(admissions) == 1, (
        f"{service_module_name}.{service_name} must have one durable admission"
    )
    assert len(executions) == 1, (
        f"{service_module_name}.{service_name} must have one route-neutral execution"
    )
    admission_assignments = [
        candidate
        for candidate in ast.walk(service)
        if isinstance(candidate, ast.Assign)
        and isinstance(candidate.value, ast.Await)
        and candidate.value.value is admissions[0]
    ]
    assert len(admission_assignments) == 1
    assert len(admission_assignments[0].targets) == 1
    admitted_request = admission_assignments[0].targets[0]
    assert isinstance(admitted_request, ast.Name)
    assert len(executions[0].args) == 1
    executed_request = executions[0].args[0]
    assert isinstance(executed_request, ast.Name)
    assert executed_request.id == admitted_request.id
    admitted_operation = _keyword(admissions[0], "operation")
    assert isinstance(admitted_operation, ast.Constant)
    assert admitted_operation.value == operation
    assert (
        _operation_revision(_keyword(admissions[0], "prompt_template_revision"), service_module)
        == operation
    )
    prompt_ref = _keyword(admissions[0], "prompt_payload_ref")
    assert isinstance(prompt_ref, ast.Call)
    assert (
        isinstance(prompt_ref.func, ast.Name) and prompt_ref.func.id == "ImmutablePromptPayloadRef"
    )
    assert _operation_revision(_keyword(prompt_ref, "revision"), service_module) == operation
    for call in (admissions[0], executions[0]):
        call_runtime = _keyword(call, "runtime")
        assert isinstance(call_runtime, ast.Name) and call_runtime.id == "runtime"


def test_metadata_job_result_does_not_duplicate_generation_policy_facts() -> None:
    _require_cutover_adapters()
    from nexus.tasks import enrich_metadata

    assert enrich_metadata._job_result(enrich_metadata._success_result(["title"])) == {
        "status": "success",
        "fields": ["title"],
    }, "metadata job result duplicated generation policy facts"


def _successful_structured_terminal(payload: dict[str, object]) -> GenerationTerminal:
    from nexus.services.codex_generation_contract import GenerationSessionRef, GenerationTerminal

    return GenerationTerminal.model_validate(
        {
            "status": "succeeded",
            "failure": None,
            "final_text": "structured result",
            "structured_output": payload,
            "session_ref": GenerationSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id="thread-operation-adapter-proof",
                profile_key="codex-personal",
                state_root_fingerprint="1" * 64,
                cwd_fingerprint="2" * 64,
            ),
            "usage": None,
            "diagnostics": [],
            "accepted_at": "2026-08-24T12:34:56.123456Z",
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
        }
    )


def test_grounded_adapters_override_host_success_when_an_index_was_not_offered() -> None:
    _require_cutover_adapters()
    from nexus.services import media_intelligence, synapse
    from nexus.services.resource_graph.refs import ResourceRef

    media_terminal = media_intelligence._encode_media_unit_terminal(
        _successful_structured_terminal(
            {
                "summary_md": "Bounded summary.",
                "claims": [{"claim_text": "Unsupported claim.", "candidate_index": 1}],
            }
        ),
        candidates=[
            media_intelligence._Candidate(
                evidence_span_id=UUID("4db166e8-3b0d-5ce1-b091-890f7ec0e6da"),
                text="Only candidate zero was offered.",
            )
        ],
    )
    synapse_terminal = synapse._encode_synapse_terminal(
        _successful_structured_terminal(
            {
                "connections": [
                    {
                        "candidate_index": 1,
                        "kind": "context",
                        "rationale": "This references an absent candidate.",
                    }
                ]
            }
        ),
        candidates=[
            synapse._SynapseCandidate(
                target=ResourceRef(
                    scheme="note_block",
                    id=UUID("dcf5659b-b854-5f44-b63f-280c6e6e1b2f"),
                ),
                label="Only candidate zero",
                snippet="Only candidate zero was offered.",
            )
        ],
    )

    assert media_terminal.accepted_failure is not None
    assert media_terminal.accepted_failure.code == "invalid_output"
    assert synapse_terminal.accepted_failure is not None
    assert synapse_terminal.accepted_failure.code == "invalid_output"
