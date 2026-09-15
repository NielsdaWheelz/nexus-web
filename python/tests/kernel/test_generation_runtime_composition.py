"""Production composition proof for the route-neutral generation runtime."""

from __future__ import annotations

import asyncio
import base64
from importlib.util import find_spec
from typing import TYPE_CHECKING

import httpx

_CUTOVER_PRESENT = find_spec("nexus.services.generation_runtime") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.config import Settings
    from nexus.schemas.presence import Present
    from nexus.services.generation_intent import GenerationIntent, TextOutput
    from nexus.services.generation_runtime import compose_generation_execution_runtime
    from nexus.services.generation_spec import (
        FrozenToolScope,
        ImmutablePromptPayloadRef,
        generation_fact_digest,
    )
    from nexus.services.llm_execution import ComposedExecutionRuntime
    from tests.testkit.generation_catalog import (
        CHAT_TEST_SELECTION,
        configured_chat_catalog_service,
    )
    from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime


def _require_cutover() -> None:
    assert _CUTOVER_PRESENT, "the composed route-neutral generation runtime is absent"


def _settings() -> Settings:
    return Settings(
        DATABASE_URL="postgresql+psycopg://127.0.0.1:54320/nexus",
        SUPABASE_JWKS_URL="https://auth.example.invalid/.well-known/jwks.json",
        SUPABASE_ISSUER="https://auth.example.invalid",
        SUPABASE_AUDIENCES="authenticated",
        GENERATION_API_PROVIDERS="openai",
        OPENAI_GENERATION_API_KEY="test-openai-key",
        GENERATION_CONTINUATION_ENCRYPTION_KEY=base64.b64encode(b"k" * 32).decode(),
        _env_file=None,
    )  # pyright: ignore[reportCallIssue]


def test_runtime_composes_one_catalog_tool_and_transport_authority() -> None:
    """Risk: API/provider dispatch recomposes tools or bypasses frozen admission."""

    _require_cutover()

    async def prove() -> None:
        catalog = configured_chat_catalog_service()
        tools = compose_available_product_tool_runtime()
        async with httpx.AsyncClient(trust_env=False) as client:
            runtime = compose_generation_execution_runtime(
                _settings(),
                http_client=client,
                catalog=catalog,
                tools=tools,
            )
            assert isinstance(runtime, ComposedExecutionRuntime)
            snapshot = await catalog.read_chat()
            pair = snapshot.pair(CHAT_TEST_SELECTION)
            assert pair is not None
            intent = GenerationIntent(
                instructions="Return one bounded composition proof.",
                input="Prove the frozen runtime boundary.",
                output=TextOutput(),
            )
            spec = runtime.admission.freeze_chat_from_pair(
                catalog_definition_revision=snapshot.catalog.definition_revision,
                pair=pair,
                tool_authority="ReadOnly",
                scope=FrozenToolScope(admitted_refs=(), predicates=()),
                intent=intent,
                prompt_template_revision="chat.runtime-composition.v1",
                prompt_payload_ref=ImmutablePromptPayloadRef(
                    owner_kind="runtime_composition",
                    owner_id="provider-chat",
                    revision="chat.runtime-composition.v1",
                    payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
                ),
            )
            operation = runtime.admission.model_tool_operation(spec)
            assert operation is tools.operations["ChatRead"]
            assert isinstance(spec.model_tool_plan_snapshot, Present)
            assert spec.model_tool_plan_snapshot.value.plan_id == "ChatRead"

    asyncio.run(prove())
