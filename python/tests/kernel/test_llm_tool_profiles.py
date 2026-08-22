from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any, cast

import pytest
from llm_tools import (
    WEB_SEARCH_SPEC,
    Available,
    FrozenCapabilityProfile,
    HostTable,
    Native,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolCatalog,
    ToolFamily,
    ToolId,
    ToolPlan,
    Unavailable,
    WebSearchRequest,
    WebSearchResponse,
    bind_brave_web_search,
    canonical_json_bytes,
    web_family,
)
from provider_runtime import CanonicalTool
from provider_runtime.registry import resolve_target
from provider_runtime.tool_adapter import ToolPublication, lower_tools

from nexus.services import llm_profiles
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_CONTEXT_CHARS,
    APP_SEARCH_LIMIT,
    APP_SEARCH_SELECTED_LIMIT,
)
from nexus.services.resource_items.capabilities import (
    RESOURCE_ITEM_CAPABILITIES,
    app_search_scope_schemes,
)
from nexus.services.tool_runtime.declarations import NEXUS_TOOL_DECLARATIONS
from nexus.services.tool_runtime.profiles import CHAT_TOOL_PROFILE

CHAT_TOOL_IDS = (
    "web.search",
    "nexus.search",
    "nexus.resource.read",
    "nexus.document.search",
    "nexus.resource.inspect",
    "nexus.relations.list",
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)
LEGACY_NINE_CANONICAL_IDS = (
    "web.search",
    "nexus.search",
    "nexus.resource.read",
    "nexus.resource.inspect",
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)
EXPECTED_WIRE_NAMES = tuple(tool_id.replace(".", "__") for tool_id in CHAT_TOOL_IDS)
EXPECTED_CHAT_TARGET_ENGINES = {
    "fast": "openai_responses",
    "balanced": "openai_responses",
    "deep": "openai_responses",
    "claude": "anthropic_messages",
    "fable": "anthropic_messages",
    "gemini": "gemini_generate",
    "kimi": "openai_chat",
    "deepseek-flash": "openai_chat",
    "deepseek-pro": "openai_chat",
}
WEB_SEARCH_POLICY_INPUTS = {
    "context_chars": 12_000,
    "locale": "US/en",
    "max_results": 6,
    "safe_search": "moderate",
    "selected_results": 5,
}


def _resource_modes(field: str, absent: str) -> dict[str, object]:
    return {
        scheme: value
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if (value := getattr(capability, field)) != absent
    }


def _link_policy() -> dict[str, object]:
    return {
        scheme: {
            "source": capability.user_relation.user_link_source,
            "target": capability.user_relation.user_link_target,
        }
        for scheme, capability in RESOURCE_ITEM_CAPABILITIES.items()
        if capability.user_relation.user_link_source
        or capability.user_relation.user_link_target != "none"
    }


# Policy facts are deliberately independent of declaration schemas. A change to
# owner admission or result behavior must roll the binding/profile/plan chain,
# while descriptions remain presentation-only.
EXPECTED_NEXUS_POLICY_INPUTS: dict[str, dict[str, object]] = {
    "nexus.search": {
        "authorization": "ConversationAdmission+ViewerRead",
        "result_policy": {
            "context_chars": APP_SEARCH_CONTEXT_CHARS,
            "max_results": APP_SEARCH_LIMIT,
            "selected_results": APP_SEARCH_SELECTED_LIMIT,
        },
        "scope_schemes": list(app_search_scope_schemes()),
        "semantic_owner": "AppSearch",
    },
    "nexus.resource.read": {
        "authorization": "ConversationAdmission+ViewerRead",
        "read_modes": _resource_modes("readable", "none"),
        "result_policy": "BoundedCitableText",
        "semantic_owner": "ResourceReadPolicy",
    },
    "nexus.document.search": {
        "authorization": "ConversationAdmission+ViewerRead",
        "read_modes": _resource_modes("readable", "none"),
        "result_policy": "BoundedCitablePassages",
        "semantic_owner": "ScopedDocumentSearch",
    },
    "nexus.resource.inspect": {
        "authorization": "ConversationAdmission+ViewerRead",
        "inspect_modes": _resource_modes("inspectable", "none"),
        "result_policy": "OrderedDocumentMap",
        "semantic_owner": "MediaReadMap",
    },
    "nexus.relations.list": {
        "authorization": "ConversationAdmission+ViewerRead",
        "link_policy": _link_policy(),
        "relation_filtering": "ViewerVisibleOneHop",
        "result_policy": "CitableRelations",
        "semantic_owner": "ResourceGraphConnections",
    },
    "nexus.library.add": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "placement_modes": _resource_modes("library_placement", "None"),
        "result_policy": "ConvergentMembership+Trust+Undo",
        "semantic_owner": "LibraryEntries",
    },
    "nexus.note.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "AdditiveNote+Trust+Undo",
        "semantic_owner": "DailyNotes",
        "target_schemes": ["page"],
    },
    "nexus.highlight.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "ExactQuote+Trust+Undo",
        "semantic_owner": "Highlights",
        "target_schemes": ["media"],
    },
    "nexus.edge.create": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "link_policy": _link_policy(),
        "result_policy": "AdditiveEdge+Trust+Undo",
        "semantic_owner": "ResourceGraphEdges",
    },
    "nexus.queue.add": {
        "authorization": "ViewerOwnedFirstPartyWrite",
        "result_policy": "ConvergentQueueEntry+Trust+Undo",
        "semantic_owner": "ConsumptionQueue",
        "target_schemes": ["media"],
    },
}


class _NeverCalledWebSearchProvider:
    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        raise AssertionError(f"kernel composition dispatched Web search: {request!r}")


def _thaw(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _thaw(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw(child) for child in value]
    return value


def _sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _definition(tool: CanonicalTool) -> dict[str, Any]:
    return {
        "description": tool.description,
        "name": tool.name,
        "parameters": dict(tool.parameters),
    }


def _profile_revision(profile: FrozenCapabilityProfile) -> str:
    return _sha256(
        {
            "grants": [grant.json() for grant in profile.ordered_grants],
            "id": str(profile.id),
            "run_limits": profile.run_limits.json(),
        }
    )


def _plan_revision(profile_revision: str, exposure: object) -> str:
    if isinstance(exposure, Native):
        encoded_exposure = {"type": "Native"}
    elif isinstance(exposure, HostTable):
        encoded_exposure = {"type": "HostTable"}
    else:
        raise AssertionError(f"unexpected production exposure: {type(exposure).__name__}")
    return _sha256(
        {
            "exposure": encoded_exposure,
            "profile_revision": profile_revision,
        }
    )


def _changed_scope_catalog(
    web_search_binding: ToolBinding[Any, Any, Any],
    nexus_bindings: tuple[ToolBinding[Any, Any, Any], ...],
) -> ToolCatalog:
    original = nexus_bindings[0]
    changed_policy = cast(dict[str, Any], _thaw(original.policy_inputs))
    scope_schemes = cast(list[str], changed_policy["scope_schemes"])
    changed_policy["scope_schemes"] = [*scope_schemes, "proof_scope"]
    changed = ToolBinding(
        spec=original.spec,
        execute=original.execute,
        replay_policy=original.replay_policy,
        policy_epoch=original.policy_epoch,
        policy_inputs=changed_policy,
    )
    return ToolCatalog.compose(
        (
            web_family(search=web_search_binding),
            ToolFamily(
                namespace="nexus",
                declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                bindings=(changed, *nexus_bindings[1:]),
            ),
        )
    )


def test_bound_families_compile_exact_closed_operation_profiles_without_fallback() -> None:
    from nexus.services.tool_runtime.bindings import NEXUS_TOOL_BINDINGS
    from nexus.services.tool_runtime.composition import compose_tool_runtime

    portable_web = bind_brave_web_search(_NeverCalledWebSearchProvider(), max_results=6)
    configured_web = ToolBinding(
        spec=portable_web.spec,
        execute=portable_web.execute,
        replay_policy=portable_web.replay_policy,
        policy_epoch=portable_web.policy_epoch,
        policy_inputs=WEB_SEARCH_POLICY_INPUTS,
    )
    keyless_web = ToolBinding(
        spec=WEB_SEARCH_SPEC,
        execute=Unavailable("Brave credential is absent"),
        replay_policy=ReplayPolicy.BilledOnce,
        policy_epoch=PolicyEpoch("web-search-v1"),
        policy_inputs=WEB_SEARCH_POLICY_INPUTS,
    )
    configured = compose_tool_runtime(configured_web)
    keyless = compose_tool_runtime(keyless_web)

    nexus_search_result_policy = cast(
        dict[str, int], EXPECTED_NEXUS_POLICY_INPUTS["nexus.search"]["result_policy"]
    )
    assert (
        nexus_search_result_policy["max_results"],
        nexus_search_result_policy["selected_results"],
        nexus_search_result_policy["context_chars"],
    ) == (8, 6, 16_000)
    assert (
        WEB_SEARCH_POLICY_INPUTS["max_results"],
        WEB_SEARCH_POLICY_INPUTS["selected_results"],
        WEB_SEARCH_POLICY_INPUTS["context_chars"],
    ) == (6, 5, 12_000)
    assert configured.catalog.family_names == ("nexus", "web")
    assert tuple(configured.operations) == ("chat", "idea_dossier_research")
    assert tuple(keyless.operations) == tuple(configured.operations)
    assert len(NEXUS_TOOL_BINDINGS) == len(NEXUS_TOOL_DECLARATIONS)

    bindings_by_id = {str(binding.spec.id): binding for binding in NEXUS_TOOL_BINDINGS}
    assert tuple(bindings_by_id) == CHAT_TOOL_IDS[1:]
    assert all(isinstance(binding.execute, Available) for binding in NEXUS_TOOL_BINDINGS)
    for tool_id, binding in bindings_by_id.items():
        assert binding.replay_policy is ReplayPolicy.ReDispatchable
        assert binding.policy_epoch == PolicyEpoch("nexus-v1")
        assert _thaw(binding.policy_inputs) == EXPECTED_NEXUS_POLICY_INPUTS[tool_id]

    expected_operations = (
        (
            "chat",
            "chat",
            Native,
            CHAT_TOOL_IDS,
            {
                "max_calls": 64,
                "max_elapsed_seconds": 900.0,
                "max_external_attempts": 128,
                "max_in_flight": 1,
                "max_input_bytes": 4_194_304,
                "max_output_bytes": 16_777_216,
            },
        ),
        (
            "idea_dossier_research",
            "idea_dossier_research",
            HostTable,
            ("web.search",),
            {
                "max_calls": 3,
                "max_elapsed_seconds": 60.0,
                "max_external_attempts": 6,
                "max_in_flight": 1,
                "max_input_bytes": 12_288,
                "max_output_bytes": 98_304,
            },
        ),
    )
    for operation_name, profile_id, exposure_type, grant_ids, run_limits in expected_operations:
        operation = configured.operations[operation_name]
        assert str(operation.profile.id) == profile_id
        assert isinstance(operation.plan.exposure, exposure_type)
        assert tuple(str(grant.id) for grant in operation.profile.ordered_grants) == grant_ids
        assert operation.profile.run_limits.json() == run_limits
        assert operation.profile.profile_revision == _profile_revision(operation.profile)
        assert operation.plan.plan_revision == _plan_revision(
            operation.profile.profile_revision,
            operation.plan.exposure,
        )
        for grant in operation.profile.ordered_grants:
            assert grant.limits == configured.catalog.spec(grant.id).limits
            assert (
                grant.tool_contract_revision
                == configured.catalog.spec(grant.id).tool_contract_revision
            )
            assert grant.policy_revision == configured.catalog.binding(grant.id).policy_revision

    chat = configured.operations["chat"]
    idea = configured.operations["idea_dossier_research"]
    assert chat.profile.profile_revision == keyless.operations["chat"].profile.profile_revision
    assert chat.plan.plan_revision == keyless.operations["chat"].plan.plan_revision
    assert (
        idea.profile.profile_revision
        == keyless.operations["idea_dossier_research"].profile.profile_revision
    )
    assert idea.plan.plan_revision == keyless.operations["idea_dossier_research"].plan.plan_revision
    assert isinstance(configured.catalog.binding(ToolId("web.search")).execute, Available)
    assert isinstance(keyless.catalog.binding(ToolId("web.search")).execute, Unavailable)

    granted = {
        str(grant.id)
        for operation in configured.operations.values()
        for grant in operation.profile.ordered_grants
    }
    assert "web.read" not in granted
    assert "tool.search" not in granted
    assert "tool.read" not in granted

    changed_catalog = _changed_scope_catalog(configured_web, NEXUS_TOOL_BINDINGS)
    changed_profile = CHAT_TOOL_PROFILE.freeze(changed_catalog)
    changed_plan = ToolPlan(profile=changed_profile.id, exposure=Native()).freeze(
        changed_catalog,
        changed_profile,
    )
    original_search = configured.catalog.binding(ToolId("nexus.search"))
    changed_search = changed_catalog.binding(ToolId("nexus.search"))
    assert changed_search.spec.tool_contract_revision == original_search.spec.tool_contract_revision
    assert changed_search.policy_revision != original_search.policy_revision
    assert changed_profile.profile_revision != chat.profile.profile_revision
    assert changed_plan.plan_revision != chat.plan.plan_revision

    with pytest.raises(ValueError, match="unbound declarations: nexus.queue.add"):
        ToolCatalog.compose(
            (
                ToolFamily(
                    namespace="nexus",
                    declarations=tuple(entry.spec for entry in NEXUS_TOOL_DECLARATIONS),
                    bindings=NEXUS_TOOL_BINDINGS[:-1],
                ),
            )
        )

    publications: dict[str, dict[str, object]] = {}
    for product_profile in llm_profiles.PROFILES:
        row = resolve_target(product_profile.target)
        assert row.tools is True
        assert row.engine == EXPECTED_CHAT_TARGET_ENGINES[product_profile.id]
        published = lower_tools(ToolPublication(plan=chat.plan, revealed_targets=()))
        assert tuple(tool.name for tool in published.tools) == EXPECTED_WIRE_NAMES
        definitions = tuple(_definition(tool) for tool in published.tools)
        per_tool = {
            definition["name"]: len(canonical_json_bytes(definition)) for definition in definitions
        }
        total = len(canonical_json_bytes(definitions))
        legacy_total = len(
            canonical_json_bytes(
                tuple(
                    definition
                    for tool_id, definition in zip(CHAT_TOOL_IDS, definitions, strict=True)
                    if tool_id in LEGACY_NINE_CANONICAL_IDS
                )
            )
        )
        report = {
            "engine": row.engine,
            "legacy_nine_bytes": legacy_total,
            "per_tool_bytes": per_tool,
            "profile": product_profile.id,
            "total_bytes": total,
        }
        assert max(per_tool.values()) <= 12_288, report
        assert total <= 12_288, report
        publications[product_profile.id] = report

    assert tuple(publications) == tuple(EXPECTED_CHAT_TARGET_ENGINES)
