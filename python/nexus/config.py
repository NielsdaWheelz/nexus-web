"""Application settings loaded from environment variables.

Environment Configuration:
    NEXUS_ENV: Deployment environment (local | test | staging | prod)
    DATABASE_URL: PostgreSQL connection string (required)
    NEXUS_INTERNAL_SECRET: Internal API secret (required in staging/prod)

Auth Configuration (required in staging/prod):
    SUPABASE_JWKS_URL: Full URL to Supabase JWKS endpoint
    SUPABASE_ISSUER: Expected JWT issuer (trailing slash stripped)
    SUPABASE_AUDIENCES: Comma-separated list of allowed audiences

Test Auth Configuration (optional, have defaults):
    TEST_TOKEN_ISSUER: Issuer for test tokens (default: test-issuer)
    TEST_TOKEN_AUDIENCES: Comma-separated test audiences (default: test-audience)
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
    - NEXUS_INTERNAL_SECRET is required in staging and prod
    - Supabase auth settings are required in staging and prod
    """

    nexus_env: Environment = Field(default=Environment.LOCAL, alias="NEXUS_ENV")
    database_url: Annotated[str, Field(alias="DATABASE_URL")]
    nexus_internal_secret: str | None = Field(default=None, alias="NEXUS_INTERNAL_SECRET")

    # Supabase auth settings (required in staging/prod)
    supabase_jwks_url: str | None = Field(default=None, alias="SUPABASE_JWKS_URL")
    supabase_issuer: str | None = Field(default=None, alias="SUPABASE_ISSUER")
    supabase_audiences: str | None = Field(default=None, alias="SUPABASE_AUDIENCES")

    # Test auth settings (optional, with defaults)
    test_token_issuer: str = Field(default="test-issuer", alias="TEST_TOKEN_ISSUER")
    test_token_audiences: str = Field(default="test-audience", alias="TEST_TOKEN_AUDIENCES")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def validate_staging_prod_requirements(self) -> "Settings":
        """Ensure required settings are set in staging/prod."""
        if self.nexus_env in (Environment.STAGING, Environment.PROD):
            missing = []
            if not self.nexus_internal_secret:
                missing.append("NEXUS_INTERNAL_SECRET")
            if not self.supabase_jwks_url:
                missing.append("SUPABASE_JWKS_URL")
            if not self.supabase_issuer:
                missing.append("SUPABASE_ISSUER")
            if not self.supabase_audiences:
                missing.append("SUPABASE_AUDIENCES")

            if missing:
                raise ValueError(
                    f"Missing required settings for NEXUS_ENV={self.nexus_env.value}: "
                    f"{', '.join(missing)}"
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
    def test_audience_list(self) -> list[str]:
        """Parse comma-separated test audiences into a list."""
        return [a.strip() for a in self.test_token_audiences.split(",") if a.strip()]

    @property
    def normalized_issuer(self) -> str | None:
        """Return issuer with trailing slash stripped."""
        if self.supabase_issuer:
            return self.supabase_issuer.rstrip("/")
        return None


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
