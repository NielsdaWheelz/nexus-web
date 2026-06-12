"""LLM model-registry Pydantic schemas.

Response shapes for the models endpoint. Models are global registry entries
filtered by per-user key availability.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.llm_catalog import (
    LLMKeyMode,
    LLMProvider,
    ModelAvailableVia,
    ModelTier,
    PromptCacheMode,
    PromptCacheTTL,
    ReasoningMode,
)


class PromptCacheCapabilityOut(BaseModel):
    mode: PromptCacheMode
    supported: bool
    key_required: bool
    ttl_options: list[PromptCacheTTL]


class ModelCapabilitiesOut(BaseModel):
    prompt_cache: PromptCacheCapabilityOut
    streaming: bool
    tool_calling: bool
    structured_output: bool
    structured_output_streaming: bool
    reasoning_continuation: bool


class ModelOut(BaseModel):
    """Response schema for an LLM model.

    Models are global registry entries. The models returned are filtered
    by availability to the current user based on key status.
    """

    id: UUID
    provider: LLMProvider
    provider_display_name: str
    model_name: str
    model_display_name: str
    model_tier: ModelTier
    reasoning_modes: list[ReasoningMode]
    max_context_tokens: int
    available_via: ModelAvailableVia
    provider_rank: int
    model_rank: int
    is_default: bool
    available_key_modes: list[LLMKeyMode]
    capabilities: ModelCapabilitiesOut

    model_config = ConfigDict(from_attributes=True)
