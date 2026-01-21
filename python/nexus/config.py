"""Application settings loaded from environment variables.

Environment Configuration:
    NEXUS_ENV: Deployment environment (local | test | staging | prod)
    DATABASE_URL: PostgreSQL connection string (required)
    NEXUS_INTERNAL_SECRET: Internal API secret (required in staging/prod)
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
    """

    nexus_env: Environment = Field(default=Environment.LOCAL, alias="NEXUS_ENV")
    database_url: Annotated[str, Field(alias="DATABASE_URL")]
    nexus_internal_secret: str | None = Field(default=None, alias="NEXUS_INTERNAL_SECRET")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def validate_staging_prod_requirements(self) -> "Settings":
        """Ensure NEXUS_INTERNAL_SECRET is set in staging/prod."""
        if self.nexus_env in (Environment.STAGING, Environment.PROD):
            if not self.nexus_internal_secret:
                raise ValueError(
                    f"NEXUS_INTERNAL_SECRET is required when NEXUS_ENV={self.nexus_env.value}"
                )
        return self

    @property
    def requires_internal_header(self) -> bool:
        """Whether requests must include the internal secret header."""
        return self.nexus_env in (Environment.STAGING, Environment.PROD)


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings.

    Returns:
        Settings instance loaded from environment.

    Raises:
        ValidationError: If required settings are missing or invalid.
    """
    return Settings()
