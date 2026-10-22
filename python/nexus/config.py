"""One validated settings snapshot per process, read from the environment and ./.env.

A field's env name is its upper-cased name: renaming a field renames its env key. Validation
runs once, at the first ``get_settings()``: a running process has valid config, and bad config
is a boot failure that names the keys, never a request failure.
"""

import base64
import binascii
import json
import os
import ssl
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, get_args
from urllib.parse import urlparse

from provider_runtime.endpoints import normalize_endpoint_overrides
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS = 256
# Deployment shape, not configuration: `mem_limit: 448m` in deploy/hetzner/docker-compose.yml,
# which the background lane proves at start.
BACKGROUND_WORKER_MEMORY_LIMIT_BYTES = 448 * 1024 * 1024
_MIB = 1024 * 1024
_LOCAL_HANDLE_KEY = b"test-stream-token-signing-key-32bytes"


class Environment(str, Enum):
    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PROD = "prod"


type GenerationApiProvider = Literal["openai", "anthropic", "gemini", "deepseek", "xai"]
_PROVIDERS: tuple[GenerationApiProvider, ...] = get_args(GenerationApiProvider.__value__)
_CREDENTIALS = ("openai_api_key", "brave_search_api_key") + tuple(
    f"{provider}_generation_api_key" for provider in _PROVIDERS
)
_Secret = Annotated[SecretStr | None, Field(repr=False)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    nexus_env: Environment = Environment.LOCAL
    nexus_internal_secret: str | None = None
    nexus_handle_key: _Secret = None  # the sealed-handle HMAC root: base64 of 32+ bytes
    nexus_runtime_identity_file: Path | None = None  # local/test; deployed images bake theirs
    app_public_url: str = "http://localhost:3000"
    supabase_jwks_url: str | None = None
    supabase_issuer: str | None = None
    supabase_audiences: Annotated[tuple[str, ...], NoDecode] = ()

    database_url: str
    database_pool_size: int = Field(10, ge=1)
    database_max_overflow: int = Field(20, ge=0)
    database_pool_timeout_seconds: float = Field(30.0, gt=0)
    database_statement_timeout_ms: int = Field(30_000, ge=0)
    # Leaves long transactions room and reaps leaked ones (the pool deadlock idled 180 s+).
    database_idle_in_tx_timeout_ms: int = Field(60_000, ge=0)

    r2_s3_api_origin: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: _Secret = None
    r2_bucket: str | None = None
    r2_region: str = "auto"  # seaweedfs local storage uses us-east-1
    signed_url_expiry_s: int = Field(300, gt=0, le=604_800)
    max_pdf_bytes: int = Field(100 * _MIB, gt=0)
    max_epub_bytes: int = Field(50 * _MIB, gt=0)
    # The floor refuses only mistakes. A deployed value must outlast the longest store-then-commit
    # window (the 900 s background wall) and a reading copy's url (SIGNED_URL_EXPIRY_S).
    storage_orphan_sweep_min_age_seconds: int = Field(86_400, ge=30)

    podcast_index_api_key: str | None = None  # without key and secret PodcastIndex calls 503
    podcast_index_api_secret: str | None = None
    podcast_index_base_url: str = "https://api.podcastindex.org/api/1.0"
    youtube_data_api_key: str | None = None
    youtube_data_base_url: str = "https://www.googleapis.com/youtube/v3"
    youtube_transcript_timeout_seconds: float = Field(30.0, gt=0)
    youtube_transcript_proxy_url: str | None = Field(None, exclude=True, repr=False)
    youtube_transcript_proxy_retries_when_blocked: int = Field(0, ge=0)
    x_api_bearer_token: str | None = None
    x_api_base_url: str = "https://api.x.com/2"
    x_api_timeout_seconds: float = Field(10.0, gt=0)
    x_api_author_thread_max_posts: int = Field(1000, ge=1)
    x_api_acquisition_max_operations: int = Field(32, ge=1)
    deepgram_api_key: str | None = None
    deepgram_base_url: str = "https://api.deepgram.com"
    deepgram_model: str = "nova-3"
    podcast_transcription_timeout_seconds: float = Field(90.0, gt=0)
    # Optional in chat; metadata research still requires search.
    brave_search_api_key: str | None = None
    brave_search_base_url: str = "https://api.search.brave.com/res/v1"
    brave_search_timeout_seconds: float = Field(8.0, gt=0)

    # The unqualified key is embeddings only; generation keys are per provider, so no
    # provider secret reaches the codex host.
    openai_api_key: str | None = None
    provider_endpoint_overrides: Annotated[dict[GenerationApiProvider, str], NoDecode] = Field(
        default_factory=dict
    )
    provider_ca_pem: str | None = None
    transcript_embedding_model_openai: str = "text-embedding-3-small"
    generation_api_providers: Annotated[tuple[GenerationApiProvider, ...], NoDecode] = ()
    openai_generation_api_key: _Secret = None
    anthropic_generation_api_key: _Secret = None
    gemini_generation_api_key: _Secret = None
    deepseek_generation_api_key: _Secret = None
    xai_generation_api_key: _Secret = None
    codex_native_socket: Path = Field(
        Path("/tmp/codex-daemon-10001/app-server.sock"), alias="NEXUS_CODEX_NATIVE_SOCKET"
    )
    memory_client_config_path: Path | None = None
    metadata_enrichment_max_content_words: int = Field(1000, ge=1, le=1000)
    connection_discovery_enabled: bool = True
    atlas_project_schedule_seconds: int = Field(0, ge=0)  # 0: not periodic (prod: 86400)

    worker_lane: Literal["interactive", "background"] | None = None
    parser_temp_root: Path = Path("/tmp/nexus-parser-tmp")
    node_ingest_script: Path = Path(__file__).resolve().parents[2] / "node/ingest/ingest.mjs"
    background_process_cgroup_root: Path = Path("/sys/fs/cgroup")
    background_process_wall_timeout_seconds: float = Field(900.0, gt=0, le=900)
    background_process_term_grace_seconds: float = Field(5.0, gt=0, le=30)
    background_process_result_max_bytes: int = Field(_MIB, ge=1024, le=4 * _MIB)
    background_process_oom_score_adj: int = Field(750, ge=1, le=1000)
    background_job_prune_succeeded_after_days: int = Field(7, ge=1)
    background_job_prune_dead_after_days: int = Field(30, ge=1)
    background_job_prune_batch_size: int = Field(100, ge=1)
    podcast_refresh_due_schedule_seconds: int = Field(900, ge=1)
    podcast_refresh_due_limit: int = Field(100, ge=1)

    # Post Room: unless secret, slug, domain and owner are all set, /ingest/email answers 503.
    email_ingest_hmac_secret: str | None = None
    email_ingest_address_slug: str | None = None
    email_ingest_domain: str | None = None
    email_ingest_owner_user_id: str | None = None
    email_ingest_max_bytes: int = Field(2 * _MIB, gt=0)

    @field_validator("supabase_audiences", "generation_api_providers", mode="before")
    @classmethod
    def _comma_list(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return tuple(part.strip() for part in value.split(",") if part.strip())

    @field_validator(*_CREDENTIALS, "provider_ca_pem", mode="before")
    @classmethod
    def _blank_is_absent(cls, value: object) -> object:
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator("provider_endpoint_overrides", mode="before")
    @classmethod
    def _endpoint_json(cls, value: object) -> object:
        if isinstance(value, str):
            return json.loads(value) if value.strip() else {}
        return value

    @field_validator("provider_endpoint_overrides")
    @classmethod
    def _endpoint_origins(
        cls, value: dict[GenerationApiProvider, str]
    ) -> dict[GenerationApiProvider, str]:
        return dict(normalize_endpoint_overrides(value))

    @field_validator("provider_ca_pem")
    @classmethod
    def _provider_ca(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=value)
            except (OSError, TypeError) as exc:
                raise ValueError("PROVIDER_CA_PEM must contain valid PEM certificates") from exc
        return value

    @field_validator("supabase_issuer")
    @classmethod
    def _issuer(cls, value: str | None) -> str | None:
        return value.rstrip("/") if value else value

    @model_validator(mode="after")
    def _validate(self) -> "Settings":
        host = (urlparse(self.database_url).hostname or "").lower()
        if any(host == d or host.endswith(f".{d}") for d in ("supabase.co", "supabase.com")):
            raise ValueError("DATABASE_URL must be standalone Postgres, not Supabase Database.")
        if self.nexus_handle_key is not None:
            try:
                key = base64.b64decode(self.nexus_handle_key.get_secret_value(), validate=True)
            except binascii.Error as exc:
                raise ValueError("NEXUS_HANDLE_KEY must be strict base64") from exc
            if len(key) < 32:
                raise ValueError("NEXUS_HANDLE_KEY must decode to at least 32 bytes")
        configured = self.generation_api_providers
        if len(set(configured)) != len(configured):
            raise ValueError("GENERATION_API_PROVIDERS contains a duplicate provider")
        if missing := [p for p in configured if self.generation_api_key(p) is None]:
            keys = ", ".join(f"{p.upper()}_GENERATION_API_KEY" for p in missing)
            raise ValueError(f"Configured generation providers lack keys: {keys}")
        stale = [p for p in _PROVIDERS if p not in configured and self.generation_api_key(p)]
        if stale:
            keys = ", ".join(f"{p.upper()}_GENERATION_API_KEY" for p in stale)
            raise ValueError(f"Generation keys set for unconfigured providers: {keys}")
        paths = {
            "NODE_INGEST_SCRIPT": self.node_ingest_script,
            "PARSER_TEMP_ROOT": self.parser_temp_root,
            "BACKGROUND_PROCESS_CGROUP_ROOT": self.background_process_cgroup_root,
            "NEXUS_CODEX_NATIVE_SOCKET": self.codex_native_socket,
            "NEXUS_RUNTIME_IDENTITY_FILE": self.nexus_runtime_identity_file,
        }
        for name, path in paths.items():
            if path is not None and (
                not path.is_absolute() or Path(os.path.normpath(path)) != path
            ):
                raise ValueError(f"{name} must be a normalized absolute path")
        if not self.deployed:
            return self
        required = {
            "NEXUS_INTERNAL_SECRET": self.nexus_internal_secret,
            "NEXUS_HANDLE_KEY": self.nexus_handle_key,
            "R2_S3_API_ORIGIN": self.r2_s3_api_origin,
            "R2_ACCESS_KEY_ID": self.r2_access_key_id,
            "R2_SECRET_ACCESS_KEY": self.r2_secret_access_key,
            "R2_BUCKET": self.r2_bucket,
            "YOUTUBE_DATA_API_KEY": self.youtube_data_api_key,
            "GENERATION_API_PROVIDERS": configured,
            "OPENAI_API_KEY": self.openai_api_key,
        }
        env = self.nexus_env.value
        if missing := [name for name, value in required.items() if not value]:
            raise ValueError(f"Required for NEXUS_ENV={env}: {', '.join(missing)}")
        origin = urlparse(self.r2_s3_api_origin or "")
        if (
            origin.scheme != "https"
            or origin.username
            or origin.password
            or origin.path not in ("", "/")
            or origin.query
            or origin.fragment
            or not (origin.hostname or "").endswith(".r2.cloudflarestorage.com")
        ):
            raise ValueError(f"R2_S3_API_ORIGIN must be the Cloudflare R2 S3 API origin in {env}")
        if self.nexus_runtime_identity_file is not None:
            raise ValueError(f"NEXUS_RUNTIME_IDENTITY_FILE is not permitted in {env}")
        if self.worker_lane is not None and self.database_statement_timeout_ms == 0:
            raise ValueError("DATABASE_STATEMENT_TIMEOUT_MS must be bounded for deployed workers")
        return self

    @property
    def deployed(self) -> bool:
        """staging or prod: strict config, internal header, hidden docs, baked identity."""
        return self.nexus_env in (Environment.STAGING, Environment.PROD)

    @property
    def handle_key(self) -> bytes:
        if self.nexus_handle_key is None:
            return _LOCAL_HANDLE_KEY
        return base64.b64decode(self.nexus_handle_key.get_secret_value(), validate=True)

    def generation_api_key(self, provider: GenerationApiProvider) -> SecretStr | None:
        return getattr(self, f"{provider}_generation_api_key")


@lru_cache
def get_settings() -> Settings:
    """The process's settings; the first call validates (ValidationError names the keys)."""
    return Settings()  # pyright: ignore[reportCallIssue] - BaseSettings reads env.
