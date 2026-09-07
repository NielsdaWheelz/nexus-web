"""Dependency-light contracts for the shared generation admission boundary.

Domain workers depend on this module without importing the model-tool runtime.
The concrete ``GenerationService`` remains the sole catalog/policy/tool
composition owner and structurally implements ``GenerationAdmissionPort``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationSpec,
    ImmutablePromptPayloadRef,
)

if TYPE_CHECKING:
    from nexus.services.tool_runtime.composition import FrozenToolOperation


@dataclass(frozen=True, slots=True)
class FrozenHostEvidence:
    plan: FrozenHostToolPlanSnapshot
    evidence_revision: str


class GenerationOperationUnavailable(RuntimeError):
    """Current route or required tool readiness blocks work without fallback."""

    def __init__(self, operation: str, reason: object) -> None:
        super().__init__(f"generation operation {operation!r} is currently unavailable")
        self.operation = operation
        self.reason = reason


class GenerationConfigurationDefect(AssertionError):
    """Reviewed policy/catalog/tool facts cannot compose one exact admission."""


class GenerationAdmissionPort(Protocol):
    """Narrow runtime waist consumed by durable domain execution."""

    async def freeze_background(
        self,
        *,
        operation: BackgroundOperationKey,
        intent: GenerationIntent,
        prompt_template_revision: str,
        prompt_payload_ref: ImmutablePromptPayloadRef,
        scope: FrozenToolScope | None = None,
        host: FrozenHostEvidence | None = None,
    ) -> GenerationSpec: ...

    async def require_dispatch_ready(self, spec: GenerationSpec) -> None: ...

    def model_tool_operation(self, spec: GenerationSpec) -> FrozenToolOperation | None: ...


__all__ = [
    "FrozenHostEvidence",
    "GenerationAdmissionPort",
    "GenerationConfigurationDefect",
    "GenerationOperationUnavailable",
]
