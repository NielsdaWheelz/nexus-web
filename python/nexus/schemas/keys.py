"""User API Key and Model Pydantic schemas.

Contains request and response models for the models and keys endpoints.

Security contract:
- No secrets ever leave the backend
- Keys are encrypted at rest
- Response never includes encrypted_key, key_nonce, master_key_version
- Fingerprint is the last 4 chars of the original key
"""

from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from nexus.llm_catalog import VALID_KEY_PROVIDERS, LLMKeyProvider

# Valid key statuses - must match DB constraint
KeyStatus = Literal["untested", "valid", "invalid", "revoked"]
KeyProviderStateStatus = Literal["missing", "untested", "valid", "invalid", "revoked"]


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

    id: UUID | None = None
    provider: str
    provider_display_name: str
    key_fingerprint: str | None = None
    status: KeyProviderStateStatus
    created_at: datetime | None = None
    last_tested_at: datetime | None = None
    last_used_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UserApiKeyCreate(BaseModel):
    """Request schema for adding/updating an API key.

    This is an upsert operation: if a key already exists for the
    (user_id, provider) pair, it is overwritten.
    """

    provider: LLMKeyProvider = Field(
        ...,
        description="BYOK provider (openai, anthropic, gemini, openrouter)",
    )
    api_key: str = Field(
        ...,
        description="The plaintext API key to store",
        min_length=1,  # Basic validation, detailed validation in service
    )

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, v: str) -> LLMKeyProvider:
        """Ensure provider is valid and lowercase."""
        v_lower = v.lower()
        if v_lower not in VALID_KEY_PROVIDERS:
            raise ValueError(f"Provider must be one of: {', '.join(sorted(VALID_KEY_PROVIDERS))}")
        return cast(LLMKeyProvider, v_lower)

    @field_validator("api_key")
    @classmethod
    def validate_api_key_format(cls, v: str) -> str:
        """Validate API key format.

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
