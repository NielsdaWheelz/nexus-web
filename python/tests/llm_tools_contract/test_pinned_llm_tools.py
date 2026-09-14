from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import tomllib
from importlib.metadata import distribution, distributions
from pathlib import Path

import httpx
import pytest

LLM_TOOLS_SHA = "9e6d155f3b64f03495911435b7cae8b8d131f9a2"


def _provider_runtime_sha() -> str:
    python_root = Path(__file__).resolve().parents[2]
    project = tomllib.loads((python_root / "pyproject.toml").read_text(encoding="utf-8"))
    revision = project["tool"]["uv"]["sources"]["provider-runtime"]["rev"]
    assert isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision)
    return revision


def _vcs_source(name: str) -> tuple[str, dict[str, str]]:
    installed = distribution(name)
    raw = installed.read_text("direct_url.json")
    assert raw is not None, f"{name} is not an immutable VCS installation"
    direct_url = json.loads(raw)
    return direct_url["url"], direct_url["vcs_info"]


def test_exact_pins_round_trip_one_canonical_native_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_runtime_sha = _provider_runtime_sha()
    installed_names = {
        value for item in distributions() if (value := item.metadata.get("Name")) is not None
    }
    assert "llm-tools" in installed_names, "exact llm-tools distribution is absent"
    assert "web-search-tool" not in installed_names
    assert importlib.util.find_spec("web_search_tool") is None

    llm_tools_url, llm_tools_vcs = _vcs_source("llm-tools")
    provider_url, provider_vcs = _vcs_source("provider-runtime")
    assert (llm_tools_url, llm_tools_vcs) == (
        "https://github.com/NielsdaWheelz/llm-tools.git",
        {
            "vcs": "git",
            "requested_revision": LLM_TOOLS_SHA,
            "commit_id": LLM_TOOLS_SHA,
        },
    )
    assert (provider_url, provider_vcs) == (
        "https://github.com/NielsdaWheelz/llm-calling.git",
        {
            "vcs": "git",
            "requested_revision": provider_runtime_sha,
            "commit_id": provider_runtime_sha,
        },
    )

    from llm_tools import (
        WEB_SEARCH_SPEC,
        BraveSearchProvider,
        CapabilityProfile,
        Native,
        ProfileId,
        RunLimits,
        ToolCatalog,
        ToolGrant,
        ToolPlan,
        web_family,
    )
    from provider_runtime.tool_adapter import CanonicalToolCall, ToolPublication, lower_tools
    from provider_runtime.types import ToolCall

    catalog = ToolCatalog.compose((web_family(),))
    profile = CapabilityProfile(
        id=ProfileId("nexus-pin-proof"),
        grants=(ToolGrant(id=WEB_SEARCH_SPEC.id, limits=None),),
        run_limits=RunLimits(
            max_calls=1,
            max_external_attempts=2,
            max_input_bytes=4_096,
            max_output_bytes=32_768,
            max_in_flight=1,
            max_elapsed_seconds=15.0,
        ),
    ).freeze(catalog)
    plan = ToolPlan(profile=profile.id, exposure=Native()).freeze(catalog, profile)
    publication = lower_tools(ToolPublication(plan=plan, revealed_targets=()))
    assert tuple(tool.name for tool in publication.tools) == ("web__search",)
    assert publication.decode_tool_call(
        ToolCall(id="provider-call-1", name="web__search", arguments={"query": "x"})
    ) == CanonicalToolCall(
        provider_call_id="provider-call-1",
        tool_id=WEB_SEARCH_SPEC.id,
        arguments={"query": "x"},
    )

    from nexus.config import clear_settings_cache
    from nexus.schemas.browse import BrowseCandidate
    from nexus.services.browse.models import (
        BrowseKind,
        BrowseQuery,
        BrowseSource,
    )

    try:
        from nexus.services.browse.brave import search
    except ModuleNotFoundError as exc:
        assert exc.name != "web_search_tool", "Nexus Browse still imports web_search_tool"
        raise

    async def brave_fixture(request: httpx.Request) -> httpx.Response:
        assert request.url.params["q"] == "x", (
            "browse changed the canonical query before provider dispatch"
        )
        assert request.url.params["count"] == "20"
        return httpx.Response(
            200,
            headers={"x-request-id": "nexus-pin-proof"},
            json={
                "web": {
                    "results": [
                        {
                            "title": "Exact pinned result",
                            "url": "https://example.com/evidence",
                            "description": "Portable provider contract",
                        }
                    ]
                }
            },
        )

    async def exercise_browse() -> tuple[list[BrowseCandidate], str | None]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(brave_fixture)) as client:
            return await search(
                BraveSearchProvider(
                    client,
                    api_key="test-key",
                    base_url="https://brave.fixture/res/v1",
                ),
                query=BrowseQuery(
                    query="x",
                    kind=BrowseKind.WebArticle,
                    source=BrowseSource.Brave,
                    sort=None,
                    limit=20,
                    cursor=None,
                ),
            )

    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://127.0.0.1:54320/nexus")
    monkeypatch.setenv("NEXUS_ENV", "test")
    monkeypatch.setenv(
        "SUPABASE_JWKS_URL",
        "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
    )
    monkeypatch.setenv("SUPABASE_ISSUER", "http://127.0.0.1:54321/auth/v1")
    monkeypatch.setenv("SUPABASE_AUDIENCES", "authenticated")
    clear_settings_cache()
    try:
        candidates, cursor = asyncio.run(exercise_browse())
    finally:
        clear_settings_cache()

    assert cursor is None
    assert len(candidates) == 1
    assert candidates[0].source is BrowseSource.Brave
    assert candidates[0].title == "Exact pinned result"
