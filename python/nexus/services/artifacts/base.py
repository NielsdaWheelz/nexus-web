"""The per-kind reducer contract for the artifact engine.

An :class:`ArtifactReducer` is the only thing that differs between artifact kinds
(a library dossier, a conversation distillate, …): inputs, prompt/schema, and
freshness fingerprint. The reduce *loop* — collect → synth → ground → materialize →
promote — is kind-agnostic and owned by ``services.artifacts.engine`` (D-1), which
also owns the profile lookup (``llm_profiles.operation_profile(llm_operation)``) and
the ``GenerateIntent``/``GenerationRequest`` assembly — a reducer supplies only its
system prompt and the per-call user-turn text.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy.orm import Session

from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput

# The reducer's ``collect`` output is opaque to the engine (candidates + coverage);
# it is threaded back into ``build_user_content``/``materialize``/``fingerprint``.
ReduceInputs = Any


@dataclass(frozen=True)
class ArtifactReducer:
    kind: str
    llm_operation: BackgroundLlmOperation
    max_output_tokens: int
    system_prompt: str
    # candidates + coverage; ``viewer_id`` is resolved by the engine (D-13). Async +
    # ``runtime`` because the dossier builds any not-yet-ready media unit inline.
    collect: Callable[
        [Session, ResourceRef, UUID | None, ExecutionRuntime], Awaitable[ReduceInputs]
    ]
    is_empty: Callable[[ReduceInputs], bool]
    empty_error: tuple[str, str]
    build_user_content: Callable[[ReduceInputs, str | None], str]
    schema: type[BaseModel]
    # ground_indices('drop') → (content_md, citations); one CitationInput per
    # grounded item (AC-8). The engine promotes the returned content_md verbatim.
    materialize: Callable[
        [Session, UUID, ResourceRef, ReduceInputs, BaseModel], tuple[str, list[CitationInput]]
    ]
    # covered_targets written at promote (from the inputs the reduce actually saw).
    fingerprint: Callable[[Session, ReduceInputs], list[dict[str, object]]]
    # covered_targets recomputed cheaply at read for freshness (no LLM, D-12).
    live_fingerprint: Callable[[Session, ResourceRef, UUID | None], list[dict[str, object]]]
    # The comparable core of a covered_targets list; freshness = signature(stored) !=
    # signature(live). Kind-specific (dossier: media fingerprints; distillate: leaf+count).
    freshness_signature: Callable[[object], object]
