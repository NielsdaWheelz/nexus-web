"""LLM model-registry Pydantic schemas.

Response shapes for the models endpoint. Models are global registry entries
filtered by per-user key availability.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.llm_catalog import ModelAvailableVia, ModelTier, ReasoningMode


class ModelOut(BaseModel):
    """Response schema for an LLM model.

    Models are global registry entries. The models returned are filtered
    by availability to the current user based on key status.
    """

    id: UUID
    provider: str
    provider_display_name: str
    model_name: str
    model_display_name: str
    model_tier: ModelTier
    reasoning_modes: list[ReasoningMode]
    max_context_tokens: int
    available_via: ModelAvailableVia

    model_config = ConfigDict(from_attributes=True)
