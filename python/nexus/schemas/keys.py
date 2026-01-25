"""User API Key and Model Pydantic schemas.

Contains request and response models for the models and keys endpoints.
These schemas are introduced in Slice 3 PR-03 (Models Registry + User API Keys).

Per PR-03 spec:
- No secrets ever leave the backend
- Keys are encrypted at rest
- Response never includes encrypted_key, key_nonce, master_key_version
- Fingerprint is the last 4 chars of the original key
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Valid providers - must match DB constraint
VALID_PROVIDERS = {"openai", "anthropic", "gemini"}
LLMProvider = Literal["openai", "anthropic", "gemini"]

# Valid key statuses - must match DB constraint
KeyStatus = Literal["untested", "valid", "invalid", "revoked"]


# =============================================================================
# Model Registry Schemas
# =============================================================================


class ModelOut(BaseModel):
    """Response schema for an LLM model.

    Models are global registry entries. The models returned are filtered
    by availability to the current user based on key status.
    """

    id: UUID
    provider: str
    model_name: str
    max_context_tokens: int

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# User API Key Schemas
# =============================================================================


class UserApiKeyOut(BaseModel):
    """Response schema for a user API key.

    SECURITY: This schema explicitly excludes sensitive fields.
    Only safe fields for display are included.

    Excluded fields (never present in response):
    - encrypted_key
    - key_nonce
    - master_key_version
    """

    id: UUID
    provider: str
    key_fingerprint: str
    status: str  # untested | valid | invalid | revoked
    created_at: datetime
    last_tested_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UserApiKeyCreate(BaseModel):
    """Request schema for adding/updating an API key.

    This is an upsert operation: if a key already exists for the
    (user_id, provider) pair, it is overwritten.
    """

    provider: LLMProvider = Field(
        ...,
        description="LLM provider (openai, anthropic, gemini)",
    )
    api_key: str = Field(
        ...,
        description="The plaintext API key to store",
        min_length=1,  # Basic validation, detailed validation in service
    )

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        """Ensure provider is valid and lowercase."""
        v_lower = v.lower()
        if v_lower not in VALID_PROVIDERS:
            raise ValueError(f"Provider must be one of: {', '.join(sorted(VALID_PROVIDERS))}")
        return v_lower

    @field_validator("api_key")
    @classmethod
    def validate_api_key_format(cls, v: str) -> str:
        """Validate API key format per spec.

        Per PR-03 spec:
        - Strip whitespace from ends
        - Reject if < 20 chars after stripping
        - Reject if contains any whitespace characters
        """
        # Strip whitespace from ends
        v = v.strip()

        # Check minimum length
        if len(v) < 20:
            raise ValueError("API key too short")

        # Check for internal whitespace
        if any(c.isspace() for c in v):
            raise ValueError("API key contains whitespace")

        return v
