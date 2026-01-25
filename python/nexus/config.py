"""Application settings loaded from environment variables.

Environment Configuration:
    NEXUS_ENV: Deployment environment (local | test | staging | prod)
    DATABASE_URL: PostgreSQL connection string (required)
    NEXUS_INTERNAL_SECRET: Internal API secret (required in staging/prod)

Redis / Celery Configuration:
    REDIS_URL: Redis connection string (required for worker)
    CELERY_BROKER_URL: Celery broker URL (defaults to REDIS_URL)
    CELERY_RESULT_BACKEND: Celery result backend URL (defaults to REDIS_URL)

Auth Configuration (required in all environments):
    SUPABASE_JWKS_URL: Full URL to Supabase JWKS endpoint
    SUPABASE_ISSUER: Expected JWT issuer (trailing slash stripped)
    SUPABASE_AUDIENCES: Comma-separated list of allowed audiences

Note: All environments use Supabase JWKS for JWT verification.
Local/test environments use Supabase local, staging/prod use cloud.
"""

from enum import Enum
from functools import lru_cache
from typing import Annotated

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Environment(str, Enum):
    """Valid deployment environments."""

    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PROD = "prod"


class Settings(BaseSettings):
    """Application configuration.

    Settings are loaded from environment variables.
    Validation rules:
    - DATABASE_URL is always required
    - SUPABASE_JWKS_URL, SUPABASE_ISSUER, SUPABASE_AUDIENCES are required in all environments
    - NEXUS_INTERNAL_SECRET is required in staging and prod only
    """

    nexus_env: Environment = Field(default=Environment.LOCAL, alias="NEXUS_ENV")
    database_url: Annotated[str, Field(alias="DATABASE_URL")]
    nexus_internal_secret: str | None = Field(default=None, alias="NEXUS_INTERNAL_SECRET")

    # Redis / Celery settings
    redis_url: str | None = Field(default=None, alias="REDIS_URL")
    celery_broker_url: str | None = Field(default=None, alias="CELERY_BROKER_URL")
    celery_result_backend: str | None = Field(default=None, alias="CELERY_RESULT_BACKEND")

    # Supabase auth settings (required in all environments)
    supabase_jwks_url: str | None = Field(default=None, alias="SUPABASE_JWKS_URL")
    supabase_issuer: str | None = Field(default=None, alias="SUPABASE_ISSUER")
    supabase_audiences: str | None = Field(default=None, alias="SUPABASE_AUDIENCES")

    # Test auth settings (optional, with defaults)
    test_token_issuer: str = Field(default="test-issuer", alias="TEST_TOKEN_ISSUER")
    test_token_audiences: str = Field(default="test-audience", alias="TEST_TOKEN_AUDIENCES")

    # Supabase Storage settings
    supabase_url: str | None = Field(default=None, alias="SUPABASE_URL")
    supabase_service_key: str | None = Field(default=None, alias="SUPABASE_SERVICE_KEY")
    storage_bucket: str = Field(default="media", alias="STORAGE_BUCKET")

    # Storage limits
    max_pdf_bytes: int = Field(default=100 * 1024 * 1024, alias="MAX_PDF_BYTES")  # 100 MB
    max_epub_bytes: int = Field(default=50 * 1024 * 1024, alias="MAX_EPUB_BYTES")  # 50 MB
    ingest_stream_timeout_s: int = Field(default=60, alias="INGEST_STREAM_TIMEOUT_S")
    signed_url_expiry_s: int = Field(default=300, alias="SIGNED_URL_EXPIRY_S")  # 5 minutes

    # S3: Key encryption for BYOK API keys
    # Base64-encoded 32-byte key for XChaCha20-Poly1305 encryption
    # Required in staging/prod, optional in local/test (uses deterministic test key)
    nexus_key_encryption_key: str | None = Field(default=None, alias="NEXUS_KEY_ENCRYPTION_KEY")

    # S3: Platform API keys for LLM providers (optional)
    # If set, models from that provider are available to all users
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def validate_required_settings(self) -> "Settings":
        """Ensure required settings are set for all environments."""
        # Supabase auth settings are required in all environments
        missing_auth = []
        if not self.supabase_jwks_url:
            missing_auth.append("SUPABASE_JWKS_URL")
        if not self.supabase_issuer:
            missing_auth.append("SUPABASE_ISSUER")
        if not self.supabase_audiences:
            missing_auth.append("SUPABASE_AUDIENCES")

        if missing_auth:
            raise ValueError(
                f"Missing required Supabase auth settings: {', '.join(missing_auth)}. "
                "Run 'make setup' to configure Supabase local, or set these environment variables."
            )

        # NEXUS_INTERNAL_SECRET is required only in staging/prod
        if self.nexus_env in (Environment.STAGING, Environment.PROD):
            if not self.nexus_internal_secret:
                raise ValueError(
                    f"NEXUS_INTERNAL_SECRET is required for NEXUS_ENV={self.nexus_env.value}"
                )

        return self

    @property
    def requires_internal_header(self) -> bool:
        """Whether requests must include the internal secret header."""
        return self.nexus_env in (Environment.STAGING, Environment.PROD)

    @property
    def audience_list(self) -> list[str]:
        """Parse comma-separated audiences into a list."""
        if self.supabase_audiences:
            return [a.strip() for a in self.supabase_audiences.split(",") if a.strip()]
        return []

    @property
    def normalized_issuer(self) -> str | None:
        """Return issuer with trailing slash stripped."""
        if self.supabase_issuer:
            return self.supabase_issuer.rstrip("/")
        return None

    @property
    def effective_celery_broker_url(self) -> str | None:
        """Return Celery broker URL, falling back to REDIS_URL if not set."""
        return self.celery_broker_url or self.redis_url

    @property
    def effective_celery_result_backend(self) -> str | None:
        """Return Celery result backend URL, falling back to REDIS_URL if not set."""
        return self.celery_result_backend or self.redis_url


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings.

    Returns:
        Settings instance loaded from environment.

    Raises:
        ValidationError: If required settings are missing or invalid.
    """
    return Settings()


def clear_settings_cache() -> None:
    """Clear the settings cache. Useful for testing."""
    get_settings.cache_clear()
