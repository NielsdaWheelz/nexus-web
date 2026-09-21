"""Production composition for the route-neutral generation runtime."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from nexus.config import Settings
from nexus.schemas.presence import Absent, Present
from nexus.services.codex_generation_client import CodexGenerationClient
from nexus.services.generation_backend import (
    GenerationBackend,
    GenerationBackendComposition,
    GenerationBackendDefect,
)
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.generation_policy import GENERATION_POLICY
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import GenerationSpec
from nexus.services.llm_credentials import generation_continuation_cipher
from nexus.services.llm_execution import ComposedExecutionRuntime
from nexus.services.provider_generation_backend import build_provider_generation_backend
from nexus.services.provider_generation_contract import ProviderModelTools
from nexus.services.tool_runtime.catalog import (
    ComposedToolRuntime,
    compose_provider_model_tools,
    freeze_tool_plan_snapshot,
)


@dataclass(frozen=True, slots=True)
class _ProviderToolProjection:
    """Resolve only the operation already named by the frozen tool snapshot."""

    tools: ComposedToolRuntime

    def resolve(self, spec: GenerationSpec) -> ProviderModelTools | None:
        snapshot = spec.model_tool_plan_snapshot
        if isinstance(snapshot, Absent):
            return None
        if not isinstance(snapshot, Present):
            raise GenerationBackendDefect("generation has an unknown model-tool presence arm")
        try:
            operation = self.tools.operations[snapshot.value.plan_id]
        except KeyError as error:
            raise GenerationBackendDefect(
                "frozen provider model-tool plan is absent from process composition"
            ) from error
        if freeze_tool_plan_snapshot(operation) != snapshot.value:
            raise GenerationBackendDefect(
                "process provider model-tool authority differs from the frozen generation"
            )
        return compose_provider_model_tools(operation)


def compose_generation_execution_runtime(
    settings: Settings,
    *,
    http_client: httpx.AsyncClient,
    catalog: GenerationCatalogService,
    tools: ComposedToolRuntime,
) -> ComposedExecutionRuntime:
    """Compose one runtime from process-owned dependencies without mutable routing."""

    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=CodexGenerationClient(settings.codex_agent_socket),
            provider=build_provider_generation_backend(settings, http_client),
            provider_tools=_ProviderToolProjection(tools),
        )
    )
    return ComposedExecutionRuntime(
        backend=backend,
        continuation_cipher=generation_continuation_cipher(settings),
        admission=GenerationService(
            catalog=catalog,
            policy=GENERATION_POLICY,
            tools=tools,
        ),
    )


__all__ = ["compose_generation_execution_runtime"]
