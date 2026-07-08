"""The per-kind reducer contract for the artifact engine.

An :class:`ArtifactReducer` is the only thing that differs between artifact kinds
(a library dossier, a conversation distillate, …): inputs, prompt/schema, model,
citations, and freshness fingerprint. The reduce *loop* — collect → synth →
ground → materialize → promote — is kind-agnostic and owned by
``services.artifacts.engine`` (D-1).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.types import ModelCall
from pydantic import BaseModel
from sqlalchemy.orm import Session

from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput

# The reducer's ``collect`` output is opaque to the engine (candidates + coverage);
# it is threaded back into ``build_request``/``materialize``/``fingerprint``.
ReduceInputs = Any


@dataclass(frozen=True)
class ArtifactReducer:
    kind: str
    provider: str
    model_name: str
    llm_operation: str
    max_output_tokens: int
    timeout_s: int
    # candidates + coverage; ``viewer_id`` is resolved by the engine (D-13). Async +
    # ``llm`` because the dossier builds any not-yet-ready media unit inline.
    collect: Callable[[Session, ResourceRef, UUID | None, ModelRuntime], Awaitable[ReduceInputs]]
    is_empty: Callable[[ReduceInputs], bool]
    empty_error: tuple[str, str]
    build_request: Callable[[ReduceInputs, str | None], ModelCall]
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
