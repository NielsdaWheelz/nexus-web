"""Final-owner proof for the generation-backend hard cutover."""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import inspect
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PR_SOURCE_SHA = "38df77279bd67a438db637677857f7f47a2f1d51"
PRODUCTION_SNAPSHOT_SHA = "42f33dc4fc896d0e01287f68ef1d300d47440db1"

_FINAL_OWNER_PATHS = (
    "python/nexus/services/generation_service.py",
    "python/nexus/services/generation_catalog.py",
    "python/nexus/services/generation_selection.py",
    "python/nexus/services/generation_spec.py",
    "python/nexus/services/generation_backend.py",
    "python/nexus/services/metadata_dispatch.py",
    "python/nexus/services/provider_generation_backend.py",
    "python/nexus/api/routes/llm.py",
    "apps/web/src/app/api/llm-catalog/route.ts",
    "apps/web/src/lib/conversations/generationCatalog.ts",
    "apps/web/src/components/chat/GenerationSelectionPicker.tsx",
    "apps/web/src/components/chat/useGenerationCatalog.ts",
    "python/tests/evals/cases/generation_plans.v2.json",
    "python/tests/evals/cases/tool_safety.v4.json",
    "python/tests/migrations/test_generation_backends_cutover.py",
    "docs/cutovers/generation-backends-hard-cutover.md",
)

_FINAL_PYTHON_MODULES = (
    "nexus.services.generation_service",
    "nexus.services.generation_catalog",
    "nexus.services.generation_selection",
    "nexus.services.generation_spec",
    "nexus.services.generation_backend",
    "nexus.services.provider_generation_backend",
    "nexus.api.routes.llm",
)

_LEGACY_PYTHON_MODULES = (
    "nexus.api.routes.llm_profiles",
    "nexus.services.agent_turn_ledger",
    "nexus.services.llm_profiles",
    "nexus.services.llm_intent_state",
    "nexus.services.llm_outcomes",
    "nexus.services.native_agent_client",
    "nexus.services.native_agent_contract",
    "nexus.services.native_agent_operations",
)

# Every row names the historical object that proves this was a real owner, not a
# tombstone invented after the cutover. Rows present in both source states name
# both immutable revisions.
_LEGACY_PATHS_BY_SOURCE: dict[str, tuple[str, ...]] = {
    "apps/web/src/app/api/llm-profiles/route.ts": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "apps/web/src/components/chat/ChatProfilePicker.module.css": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "apps/web/src/components/chat/ChatProfilePicker.tsx": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "apps/web/src/components/chat/useChatProfiles.ts": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "apps/web/src/lib/api/sse/events.profile.unit.test.ts": (PR_SOURCE_SHA,),
    "apps/web/src/lib/conversations/chatProfileContract.ts": (PR_SOURCE_SHA,),
    "apps/web/src/lib/conversations/chatProfileContract.unit.test.ts": (PR_SOURCE_SHA,),
    "apps/web/src/lib/conversations/chatProfileSelection.ts": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "docs/cutovers/chat-continuation-selection-hard-cutover.md": (PRODUCTION_SNAPSHOT_SHA,),
    "docs/cutovers/codex-personal-generation-hard-cutover.md": (PR_SOURCE_SHA,),
    "docs/cutovers/llm-provider-runtime-hard-cutover.md": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/api/routes/llm_profiles.py": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "python/nexus/services/agent_turn_ledger.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/llm_intent_state.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/llm_outcomes.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/llm_profiles.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/native_agent_client.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/native_agent_contract.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/nexus/services/native_agent_operations.py": (PRODUCTION_SNAPSHOT_SHA,),
    "python/tests/evals/cases/generation_plans.v1.json": (PR_SOURCE_SHA,),
    "python/tests/evals/cases/tool_safety.v3.json": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "python/tests/migrations/test_codex_generation_cutover.py": (PR_SOURCE_SHA,),
    "python/tests/service/test_agent_tools_mcp.py": (PR_SOURCE_SHA,),
    "python/tests/service/test_durable_chat_reconciliation.py": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "python/tests/service/test_llm_ledger.py": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "python/tests/service/test_llm_profiles.py": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
    "testdata/faults/codex-generation-capability-lowering-bypass.patch": (PR_SOURCE_SHA,),
    "testdata/faults/durable-chat-uncertain-checkpoint-bypass.patch": (
        PR_SOURCE_SHA,
        PRODUCTION_SNAPSHOT_SHA,
    ),
}

_RUNTIME_ROOTS = (
    "apps/api",
    "apps/codex_agent",
    "apps/web/src",
    "apps/worker",
    "python/nexus",
)
_RUNTIME_SUFFIXES = frozenset({".css", ".js", ".mjs", ".py", ".ts", ".tsx"})
_LEGACY_RUNTIME_PATTERNS = (
    re.compile(r"\b(?:PlanId|PLANS|_BACKGROUND_PLAN|MODEL_BOUNDS)\b"),
    re.compile(r"\b(?:ChatProfile|CHAT_PROFILES|_CHAT_PLAN|_CHAT_POLICIES|chat_policy)\b"),
    re.compile(
        r"\b(?:LlmProfilesOut|LlmProfileOut|ChatProfileId|ChatProfilePicker|"
        r"useChatProfiles|UnavailableReplacement)\b"
    ),
    re.compile(
        r"\b(?:profile_selection_active|active_profile_run_ids|"
        r"profile_catalog_revision|default_profile_id|capability_kind|ChatTools)\b"
    ),
    re.compile(r"(?:/api)?/llm-profiles\b"),
    re.compile(r"chatProfile(?:Contract|Selection)"),
    re.compile(r"nexus\.(?:api\.routes|services)\.llm_profiles\b"),
    re.compile(r"nexus\.services\.(?:llm_intent_state|llm_outcomes)\b"),
    re.compile(r"\b(?:agent_turn_ledger|native_agent_(?:client|contract|operations))\b"),
    re.compile(r"\bcapacity_wait_index\b"),
)
_LEGACY_DOC_PATTERN = re.compile(
    r"\b(?:ChatProfile|ChatProfileId|ChatProfileSelection|ChatTools)\b|"
    r"(?:/api)?/llm-profiles\b|\b(?:default_profile_id|profile_id)\b"
)
_FINAL_SPEC_NAME = "generation-backends-hard-cutover.md"
_HISTORICAL_DOC_SUFFIXES = (
    "-adversarial-review.md",
    "-change-report.md",
)

_GENERATION_BILLING_SOURCE_CLUSTER = (
    "python/nexus/config.py",
    "python/nexus/db/models.py",
    "python/nexus/schemas/billing.py",
    "python/nexus/services/billing.py",
    "python/nexus/services/billing_entitlements.py",
    "python/nexus/services/rate_limit.py",
    "python/nexus/services/llm_execution.py",
    "python/nexus/ops/entitlement_overrides.py",
    "python/nexus/api/routes/billing.py",
    "python/nexus/schemas/llm.py",
    "python/nexus/services/generation_catalog.py",
    "apps/web/src/lib/billing/useBillingAccount.ts",
    "apps/web/src/app/api/billing/account/route.ts",
    "apps/web/src/lib/conversations/generationCatalog.ts",
    "apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx",
)
_RETIRED_GENERATION_BILLING_PATTERNS = (
    re.compile(
        r"(?:platform_token_(?:quota_mode|limit_monthly)|\bcan_use_platform_llm|"
        r"\bai_token_usage|\bget_platform_token_usage)\b"
    ),
    re.compile(r"\bBILLING_AI_(?:PLUS|PRO)_PLATFORM_TOKEN_LIMIT_MONTHLY\b"),
    re.compile(r"--platform-tokens\b"),
)
_GENERATION_CONTROL_SOURCE_CLUSTER = (
    "python/nexus/schemas/conversation.py",
    "python/nexus/schemas/llm.py",
    "python/nexus/services/generation_catalog.py",
    "python/nexus/services/generation_selection.py",
    "python/nexus/api/routes/llm.py",
    "apps/web/src/lib/conversations/generationCatalog.ts",
    "apps/web/src/components/chat/GenerationSelectionPicker.tsx",
    "apps/web/src/components/chat/CandidateGenerationPicker.tsx",
    "apps/web/src/components/chat/useGenerationCatalog.ts",
    "apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx",
)
_RETIRED_GENERATION_CONTROL_PATTERNS = (
    re.compile(r"(?i)\b(?:fast|balanced|deep|profile)\b"),
    re.compile(
        r"\b(?:default_profile_id|profile_catalog_revision|profile_id|"
        r"default_generation_selection|generation_selection_default|chat_default)\b"
    ),
    re.compile(r"(?:/api)?/llm-profiles\b"),
)


def _git_object_exists(revision: str, path: str) -> bool:
    result = subprocess.run(
        ["git", "cat-file", "-e", f"{revision}:{path}"],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
    )
    return result.returncode == 0


def _runtime_sources() -> tuple[Path, ...]:
    sources: list[Path] = []
    for relative_root in _RUNTIME_ROOTS:
        root = REPO_ROOT / relative_root
        sources.extend(
            path
            for path in root.rglob("*")
            if path.is_file()
            and path.suffix in _RUNTIME_SUFFIXES
            and ".test." not in path.name
            and "__tests__" not in path.parts
        )
    return tuple(sorted(sources))


def _legacy_runtime_references() -> tuple[str, ...]:
    references: list[str] = []
    for path in _runtime_sources():
        relative = path.relative_to(REPO_ROOT).as_posix()
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if any(pattern.search(line) for pattern in _LEGACY_RUNTIME_PATTERNS):
                references.append(f"{relative}:{line_number}: {line.strip()}")
    return tuple(references)


def _source_cluster_references(
    paths: tuple[str, ...],
    patterns: tuple[re.Pattern[str], ...],
) -> tuple[str, ...]:
    references: list[str] = []
    for relative in paths:
        path = REPO_ROOT / relative
        if not path.is_file():
            references.append(f"{relative}: source owner is absent")
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if any(pattern.search(line) for pattern in patterns):
                references.append(f"{relative}:{line_number}: {line.strip()}")
    return tuple(references)


def _stale_generation_docs() -> tuple[str, ...]:
    stale: list[str] = []
    for path in sorted((REPO_ROOT / "docs/cutovers").glob("*.md")):
        if path.name == _FINAL_SPEC_NAME or path.name.endswith(_HISTORICAL_DOC_SUFFIXES):
            continue
        text = path.read_text(encoding="utf-8")
        if _LEGACY_DOC_PATTERN.search(text) is None:
            continue
        preamble = "\n".join(text.splitlines()[:40])
        is_amended = _FINAL_SPEC_NAME in preamble
        is_explicit_historical_record = (
            "implementation sections below record the superseded design" in preamble
        )
        if not (is_amended or is_explicit_historical_record):
            stale.append(path.relative_to(REPO_ROOT).as_posix())

    for relative in ("docs/modules/chat.md", "docs/modules/llms.md"):
        path = REPO_ROOT / relative
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if _LEGACY_DOC_PATTERN.search(line):
                stale.append(f"{relative}:{line_number}: {line.strip()}")

    deleted_spec_name = "codex-personal-generation-hard-cutover.md"
    for path in sorted((REPO_ROOT / "docs").rglob("*.md")):
        if path.name.endswith(_HISTORICAL_DOC_SUFFIXES):
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if deleted_spec_name in line:
                relative = path.relative_to(REPO_ROOT).as_posix()
                stale.append(f"{relative}:{line_number}: {line.strip()}")
    return tuple(stale)


def test_only_final_generation_owners_remain() -> None:
    """Risk: an old generation owner can revive a stale route or billing path."""

    # This is deliberately the first assertion. The candidate-only proof is
    # overlaid on BASE by the governed controller, so BASE reaches a behavioral
    # RED before any candidate-only module is imported.
    for relative in _FINAL_OWNER_PATHS:
        assert (REPO_ROOT / relative).is_file(), f"final generation owner is absent: {relative}"

    for relative, revisions in _LEGACY_PATHS_BY_SOURCE.items():
        assert not (REPO_ROOT / relative).exists(), f"legacy generation owner survived: {relative}"
        for revision in revisions:
            assert _git_object_exists(revision, relative), (
                "legacy deletion manifest names an owner absent from its source: "
                f"{revision}:{relative}"
            )

    for module_name in _FINAL_PYTHON_MODULES:
        assert importlib.util.find_spec(module_name) is not None, (
            f"final generation module is not importable: {module_name}"
        )
        importlib.import_module(module_name)
    for module_name in _LEGACY_PYTHON_MODULES:
        assert importlib.util.find_spec(module_name) is None, (
            f"legacy generation module remains importable: {module_name}"
        )

    runtime_references = _legacy_runtime_references()
    assert runtime_references == (), (
        "legacy generation symbols or routes remain in runtime owners:\n"
        + "\n".join(runtime_references)
    )

    billing_references = _source_cluster_references(
        _GENERATION_BILLING_SOURCE_CLUSTER,
        _RETIRED_GENERATION_BILLING_PATTERNS,
    )
    assert billing_references == (), (
        "retired platform-token entitlement or API ownership remains:\n"
        + "\n".join(billing_references)
    )

    generation_control_references = _source_cluster_references(
        _GENERATION_CONTROL_SOURCE_CLUSTER,
        _RETIRED_GENERATION_CONTROL_PATTERNS,
    )
    assert generation_control_references == (), (
        "retired generation shortcut, profile, or default controls remain:\n"
        + "\n".join(generation_control_references)
    )

    stale_docs = _stale_generation_docs()
    assert stale_docs == (), (
        "legacy generation statements lack a final-owner amendment:\n" + "\n".join(stale_docs)
    )

    # One representative transport decoder proves old profile fields are
    # rejected rather than ignored. Browser decoder behavior remains owned by
    # its browser proof and the Web build.
    import pytest
    from pydantic import ValidationError

    from nexus.config import Settings
    from nexus.db.models import Base, BillingEntitlementOverride
    from nexus.schemas.billing import BillingAccountOut, BillingEntitlementsOut
    from nexus.schemas.conversation import ChatRunRepeatRequest
    from nexus.services import billing
    from nexus.services.billing_entitlements import grant_entitlement_override
    from nexus.services.rate_limit import RateLimiter
    from tests.testkit.generation_catalog import configured_chat_catalog_service

    request = {
        "catalog_definition_revision": "0" * 64,
        "selection": {
            "route": "CodexPersonal",
            "model": "gpt-5.6-terra",
            "reasoning": "medium",
        },
        "tool_authority": "ReadOnly",
    }
    assert ChatRunRepeatRequest.model_validate(request).tool_authority == "ReadOnly"
    for retired_field in ("profile_id", "profile_catalog_revision"):
        with pytest.raises(ValidationError) as captured:
            ChatRunRepeatRequest.model_validate({**request, retired_field: "retired"})
        assert any(
            tuple(error["loc"]) == (retired_field,) and error["type"] == "extra_forbidden"
            for error in captured.value.errors()
        ), f"retired Chat field was not rejected as extra: {retired_field}"

    retired_billing_fields = {
        "ai_token_usage",
        "billing_ai_plus_platform_token_limit_monthly",
        "billing_ai_pro_platform_token_limit_monthly",
        "can_use_platform_llm",
        "platform_token_limit_monthly",
        "platform_token_quota_mode",
    }
    billing_contract_fields = {
        "Settings": set(Settings.model_fields),
        "BillingEntitlementOverride": set(BillingEntitlementOverride.__table__.columns.keys()),
        "BillingEntitlementsOut": set(BillingEntitlementsOut.model_fields),
        "BillingAccountOut": set(BillingAccountOut.model_fields),
        "grant_entitlement_override": set(inspect.signature(grant_entitlement_override).parameters),
    }
    for owner, fields in billing_contract_fields.items():
        residue = retired_billing_fields.intersection(fields)
        assert residue == set(), f"{owner} still exposes retired billing fields: {residue!r}"
    assert not hasattr(billing, "get_platform_token_usage")
    for method_name in (
        "check_token_budget",
        "reserve_token_budget_in_transaction",
        "commit_token_budget_in_transaction",
        "release_token_budget_in_transaction",
    ):
        assert not hasattr(RateLimiter, method_name), (
            f"RateLimiter still exposes retired platform billing method {method_name}"
        )
    for table_name in (
        "token_budget_charges",
        "token_budget_reservations",
        "token_budget_daily_usage",
    ):
        assert table_name not in Base.metadata.tables, (
            f"retired platform billing table remains in the final ORM: {table_name}"
        )

    catalog = asyncio.run(configured_chat_catalog_service().read_chat()).catalog
    disclosures = tuple(
        (route.route.kind, route.billing.kind, route.billing.label) for route in catalog.routes
    )
    assert disclosures == (
        ("CodexPersonal", "Subscription", "Codex subscription"),
        ("ProviderApi", "MeteredApi", "Metered API"),
    )
