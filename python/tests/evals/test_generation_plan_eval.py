"""Zero-hosted-call review of the complete source-owned generation policy."""

from __future__ import annotations

import json
import tomllib
from importlib.util import find_spec
from pathlib import Path

_CASES_PATH = Path(__file__).parent / "cases" / "generation_plans.v2.json"
_PYPROJECT_PATH = Path(__file__).parents[2] / "pyproject.toml"
_LOCK_PATH = Path(__file__).parents[2] / "uv.lock"
_CUTOVER_PRESENT = find_spec("nexus.services.generation_backend") is not None


def _locked_package_version(lock: dict[str, object], name: str) -> str | None:
    packages = lock.get("package")
    if not isinstance(packages, list):
        return None
    for package in packages:
        if isinstance(package, dict) and package.get("name") == name:
            version = package.get("version")
            return version if isinstance(version, str) else None
    return None


def test_reviewed_generation_plan_corpus_replays_the_shipped_policy_without_a_live_model() -> None:
    """The reviewed corpus is an exact policy pin, never a quality claim."""

    assert _CUTOVER_PRESENT, "the generation-policy owner is absent"

    from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION

    from nexus.services import generation_policy
    from nexus.services.generation_policy import ChatPerRunTools, ExactModelTools
    from nexus.services.tool_runtime.profiles import TOOL_PLAN_DEFINITIONS_BY_ID

    corpus = json.loads(_CASES_PATH.read_text(encoding="utf-8"))
    assert corpus["version"] == 2
    assert corpus["corpus_revision"] == "generation-plans.v2"
    assert corpus["reviewed_rubric_revision"] == "generation-plan-rubric.v2"
    assert corpus["max_hosted_calls"] == 0
    assert corpus["live_qualification"] == ("model_effort_runtime_wire_required_before_production")

    pins = corpus["consumer_pins"]
    assert pins["policy_revision"] == generation_policy.POLICY_REVISION
    assert pins["policy_facts_fingerprint"] == generation_policy.POLICY_FINGERPRINT
    assert pins["agent_backend_contract_revision"] == AGENT_BACKEND_CONTRACT_REVISION
    assert pins["mcp_wire_revision"] == "2025-06-18"

    project = tomllib.loads(_PYPROJECT_PATH.read_text(encoding="utf-8"))
    sources = project["tool"]["uv"]["sources"]
    assert sources["provider-runtime"]["rev"] == pins["provider_runtime_revision"]
    assert sources["llm-tools"]["rev"] == pins["llm_tools_revision"]
    assert f"mcp=={pins['mcp_version']}" in project["project"]["dependencies"]
    lock = tomllib.loads(_LOCK_PATH.read_text(encoding="utf-8"))
    assert _locked_package_version(lock, "openai-codex") == pins["codex_sdk_version"]
    assert _locked_package_version(lock, "openai-codex-cli-bin") == pins["codex_sdk_version"]

    policy = generation_policy.GENERATION_POLICY
    chat_tools = policy.chat.workflow.model_tool_policy
    assert isinstance(chat_tools, ChatPerRunTools)
    assert corpus["chat"] == {
        "selection": policy.chat.seed.model_dump(mode="json"),
        "model_tool_plans": [
            chat_tools.read_plan_id,
            chat_tools.additive_write_plan_id,
        ],
    }

    actual_background: dict[str, object] = {}
    for operation, row in policy.background_operations.items():
        tool_policy = row.workflow.model_tool_policy
        actual_background[operation] = {
            "selection": row.selection.model_dump(mode="json"),
            "model_tool_plan": (
                tool_policy.plan_id if isinstance(tool_policy, ExactModelTools) else None
            ),
        }
    assert corpus["background_operations"] == actual_background
    assert len(actual_background) == 14

    assert corpus["tool_plans"] == {
        plan_id: {
            "authority_revision": TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].authority_revision,
            "effect_mode": effect_mode,
        }
        for plan_id, effect_mode in (
            ("ChatRead", "ReadOnly"),
            ("ChatReadAdditiveWrite", "AdditiveWrites"),
            ("LibraryDossierRead", "ReadOnly"),
            ("IdeaDossierRead", "ReadOnly"),
            ("MetadataRead", "ReadOnly"),
        )
    }
