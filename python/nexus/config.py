"""Application settings loaded from environment variables.

Environment Configuration:
    NEXUS_ENV: Deployment environment (local | test | staging | prod)
    DATABASE_URL: PostgreSQL connection string (required)
    DATABASE_URL must not point at Supabase Database in any environment
    NEXUS_INTERNAL_SECRET: Internal API secret (required in staging/prod)

Auth Configuration (required in all environments):
    SUPABASE_JWKS_URL: Full URL to Supabase JWKS endpoint
    SUPABASE_ISSUER: Expected JWT issuer (trailing slash stripped)
    SUPABASE_AUDIENCES: Comma-separated list of allowed audiences

Note: All environments use Supabase JWKS for JWT verification.
Local/test environments use Supabase local, staging/prod use cloud.
Supabase service-role keys are not application runtime settings.
"""

import base64
import binascii
import os
from datetime import datetime
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings

from nexus.job_topology import MAINTENANCE_JOB_KINDS

TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS = 256
# Cross-runtime upload safety contract. Keep this equal to
# `DIRECT_UPLOAD_PUT_TIMEOUT_MS` in `apps/web/src/lib/media/ingestionClient.ts`.
DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS = 240
# The one background-worker memory limit. It is deployment shape, not per-environment
# configuration, so it is a constant here and `mem_limit: 448m` in
# `deploy/hetzner/docker-compose.yml`; the cgroup readiness check proves at startup
# that the deployed limit is exactly this value.
BACKGROUND_WORKER_MEMORY_LIMIT_BYTES = 448 * 1024 * 1024


def parse_agent_tools_mcp_listen(value: str) -> tuple[str, int]:
    """Parse the dedicated worker MCP listener as one strict host:port pair."""
    if not isinstance(value, str) or value.count(":") != 1:
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_LISTEN must be host:port")
    host, port_text = value.rsplit(":", 1)
    if not host or "/" in host or any(char.isspace() for char in host):
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_LISTEN has an invalid host")
    try:
        port = int(port_text)
    except ValueError as exc:
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_LISTEN has an invalid port") from exc
    if not 1 <= port <= 65_535:
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_LISTEN port must be 1..65535")
    return host, port


def parse_agent_tools_mcp_origin(value: str) -> tuple[str, str]:
    """Return the exact Host and Origin admitted by the MCP transport."""

    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_ORIGIN has an invalid port") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/internal/agent-tools/mcp"
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_ORIGIN must be one exact MCP endpoint")
    default_port = 80 if parsed.scheme == "http" else 443
    authority = parsed.hostname if port in {None, default_port} else f"{parsed.hostname}:{port}"
    if parsed.netloc != authority:
        raise ValueError("NEXUS_AGENT_TOOLS_MCP_ORIGIN must use a canonical authority")
    return authority, f"{parsed.scheme}://{authority}"


def validate_agent_tools_mcp_runtime_origin(
    value: str,
    *,
    nexus_env: "Environment",
    worker_lane: Literal["interactive", "background", "maintenance"] | None,
) -> tuple[str, str]:
    """Validate the MCP origin only for the lane that owns that transport."""

    authority, origin = parse_agent_tools_mcp_origin(value)
    if (
        worker_lane == "interactive"
        and nexus_env in {Environment.STAGING, Environment.PROD}
        and not origin.startswith("https://")
    ):
        raise ValueError(
            "NEXUS_AGENT_TOOLS_MCP_ORIGIN must use HTTPS for a deployed interactive worker"
        )
    return authority, origin


def _database_url_looks_like_supabase(database_url: str) -> bool:
    parsed = urlparse(database_url)
    hostname = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError:
        port = None
    return (
        hostname == "supabase.co"
        or hostname.endswith(".supabase.co")
        or hostname == "supabase.com"
        or hostname.endswith(".supabase.com")
        or (
            hostname in {"localhost", "127.0.0.1", "::1"}
            and str(port or "") == os.environ.get("SUPABASE_DB_PORT", "54322")
        )
    )


class Environment(str, Enum):
    """Valid deployment environments."""

    LOCAL = "local"
    TEST = "test"
    STAGING = "staging"
    PROD = "prod"


type GenerationApiProvider = Literal[
    "openai",
    "anthropic",
    "gemini",
    "moonshot",
    "openrouter",
    "deepseek",
    "xai",
]


class Settings(BaseSettings):
    """Application configuration.

    Settings are loaded from environment variables.
    Validation rules:
    - DATABASE_URL is always required
    - DATABASE_URL must not point at Supabase Database in any environment
    - SUPABASE_JWKS_URL, SUPABASE_ISSUER, SUPABASE_AUDIENCES are required in all environments
    - NEXUS_INTERNAL_SECRET is required in staging and prod only
    """

    nexus_env: Environment = Field(default=Environment.LOCAL, alias="NEXUS_ENV")
    database_url: Annotated[str, Field(alias="DATABASE_URL")]
    database_pool_size: int = Field(default=10, alias="DATABASE_POOL_SIZE", ge=1)
    database_max_overflow: int = Field(default=20, alias="DATABASE_MAX_OVERFLOW", ge=0)
    database_pool_timeout_seconds: float = Field(
        default=30.0, alias="DATABASE_POOL_TIMEOUT_SECONDS", gt=0
    )
    database_statement_timeout_ms: int = Field(
        default=30000, alias="DATABASE_STATEMENT_TIMEOUT_MS", ge=0
    )
    database_lock_timeout_ms: int = Field(default=10000, alias="DATABASE_LOCK_TIMEOUT_MS", ge=0)
    # 60s leaves legitimate long transactions room to finish while still
    # reaping leaked transactions (the observed pool-exhaustion deadlock idled
    # for 180s+).
    database_idle_in_tx_timeout_ms: int = Field(
        default=60000, alias="DATABASE_IDLE_IN_TX_TIMEOUT_MS", ge=0
    )
    nexus_internal_secret: str | None = Field(default=None, alias="NEXUS_INTERNAL_SECRET")

    # Supabase auth settings (required in all environments)
    supabase_jwks_url: str | None = Field(default=None, alias="SUPABASE_JWKS_URL")
    supabase_issuer: str | None = Field(default=None, alias="SUPABASE_ISSUER")
    supabase_audiences: str | None = Field(default=None, alias="SUPABASE_AUDIENCES")

    # Cloudflare R2 object storage settings.
    r2_s3_api_origin: str | None = Field(default=None, alias="R2_S3_API_ORIGIN")
    r2_access_key_id: str | None = Field(default=None, alias="R2_ACCESS_KEY_ID")
    r2_secret_access_key: str | None = Field(default=None, alias="R2_SECRET_ACCESS_KEY")
    r2_bucket: str | None = Field(default=None, alias="R2_BUCKET")
    r2_region: str = Field(default="auto", alias="R2_REGION")
    # Explicit botocore timeouts for the R2 S3-compatible client. Bounded low so a
    # stalled object-store call fails fast instead of holding a worker/request open.
    r2_connect_timeout_seconds: float = Field(
        default=5.0, alias="R2_CONNECT_TIMEOUT_SECONDS", gt=0, le=10
    )
    r2_read_timeout_seconds: float = Field(
        default=30.0, alias="R2_READ_TIMEOUT_SECONDS", gt=0, le=60
    )

    # Media teardown: durable cleanup timing for the media-deletion job family
    # (media_teardown, storage_object_cleanup, storage_orphan_sweep).
    media_teardown_cleanup_grace_seconds: int = Field(
        default=60, alias="MEDIA_TEARDOWN_CLEANUP_GRACE_SECONDS", ge=0
    )
    # writeMayLandUntil horizon for a durable final-sweep record. Must exceed
    # both bounded server writes and the browser's direct-upload PUT deadline.
    storage_object_cleanup_write_window_seconds: int = Field(
        default=300, alias="STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS", gt=0
    )
    storage_orphan_sweep_interval_seconds: int = Field(
        default=21600, alias="STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS", gt=0
    )
    storage_orphan_sweep_min_age_seconds: int = Field(
        default=86400, alias="STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS", ge=0
    )

    # Storage limits
    max_pdf_bytes: int = Field(default=100 * 1024 * 1024, alias="MAX_PDF_BYTES")  # 100 MB
    max_epub_bytes: int = Field(default=50 * 1024 * 1024, alias="MAX_EPUB_BYTES")  # 50 MB
    max_arxiv_source_bytes: int = Field(
        default=50 * 1024 * 1024,
        alias="MAX_ARXIV_SOURCE_BYTES",
    )
    signed_url_expiry_s: int = Field(default=300, alias="SIGNED_URL_EXPIRY_S")  # 5 minutes

    # Podcast discovery and subscription ingestion policy.
    podcasts_enabled: bool = Field(default=False, alias="PODCASTS_ENABLED")
    podcast_index_api_key: str | None = Field(default=None, alias="PODCAST_INDEX_API_KEY")
    podcast_index_api_secret: str | None = Field(default=None, alias="PODCAST_INDEX_API_SECRET")
    podcast_index_base_url: str = Field(
        default="https://api.podcastindex.org/api/1.0",
        alias="PODCAST_INDEX_BASE_URL",
    )
    youtube_data_api_key: str | None = Field(default=None, alias="YOUTUBE_DATA_API_KEY")
    youtube_data_base_url: str = Field(
        default="https://www.googleapis.com/youtube/v3",
        alias="YOUTUBE_DATA_BASE_URL",
    )
    x_api_bearer_token: str | None = Field(default=None, alias="X_API_BEARER_TOKEN")
    x_api_base_url: str = Field(default="https://api.x.com/2", alias="X_API_BASE_URL")
    x_api_timeout_seconds: float = Field(default=10.0, alias="X_API_TIMEOUT_SECONDS", gt=0)
    x_api_author_thread_max_posts: int = Field(
        default=1000,
        alias="X_API_AUTHOR_THREAD_MAX_POSTS",
        ge=1,
    )
    youtube_transcript_timeout_seconds: float = Field(
        default=30.0,
        alias="YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS",
        gt=0,
    )
    youtube_transcript_proxy_url: str | None = Field(
        default=None,
        alias="YOUTUBE_TRANSCRIPT_PROXY_URL",
        exclude=True,
        repr=False,
    )
    youtube_transcript_proxy_retries_when_blocked: int = Field(
        default=0,
        alias="YOUTUBE_TRANSCRIPT_PROXY_RETRIES_WHEN_BLOCKED",
        ge=0,
    )
    deepgram_api_key: str | None = Field(default=None, alias="DEEPGRAM_API_KEY")
    deepgram_base_url: str = Field(default="https://api.deepgram.com", alias="DEEPGRAM_BASE_URL")
    deepgram_model: str = Field(default="nova-3", alias="DEEPGRAM_MODEL")
    podcast_transcription_timeout_seconds: float = Field(
        default=90.0, alias="PODCAST_TRANSCRIPTION_TIMEOUT_SECONDS", gt=0
    )
    podcast_refresh_due_schedule_seconds: int = Field(
        default=900, alias="PODCAST_REFRESH_DUE_SCHEDULE_SECONDS", ge=1
    )
    podcast_refresh_due_limit: int = Field(default=100, alias="PODCAST_REFRESH_DUE_LIMIT", ge=1)

    # Billing / Stripe settings
    app_public_url: str = Field(default="http://localhost:3000", alias="APP_PUBLIC_URL")
    billing_enabled: bool = Field(default=True, alias="BILLING_ENABLED")
    stripe_secret_key: str | None = Field(default=None, alias="STRIPE_SECRET_KEY")
    stripe_webhook_secret: str | None = Field(default=None, alias="STRIPE_WEBHOOK_SECRET")
    stripe_plus_price_id: str | None = Field(default=None, alias="STRIPE_PLUS_PRICE_ID")
    stripe_ai_plus_price_id: str | None = Field(default=None, alias="STRIPE_AI_PLUS_PRICE_ID")
    stripe_ai_pro_price_id: str | None = Field(default=None, alias="STRIPE_AI_PRO_PRICE_ID")
    billing_ai_plus_transcription_minutes_monthly: int = Field(
        default=300,
        alias="BILLING_AI_PLUS_TRANSCRIPTION_MINUTES_MONTHLY",
        ge=0,
    )
    billing_ai_pro_transcription_minutes_monthly: int = Field(
        default=1200,
        alias="BILLING_AI_PRO_TRANSCRIPTION_MINUTES_MONTHLY",
        ge=0,
    )

    # Ingest recovery guardrails
    ingest_reconcile_schedule_seconds: int = Field(
        default=600, alias="INGEST_RECONCILE_SCHEDULE_SECONDS", ge=0
    )
    ingest_stale_extracting_seconds: int = Field(
        default=1800, alias="INGEST_STALE_EXTRACTING_SECONDS", ge=1
    )
    parser_temp_root: Path = Field(default=Path("/tmp/nexus-parser-tmp"), alias="PARSER_TEMP_ROOT")

    # Worker runtime. Normal workers use one fixed lane. A raw allowlist is
    # accepted only for a gated, bounded maintenance invocation.
    worker_lane: Literal["interactive", "background", "maintenance"] | None = Field(
        default=None,
        alias="WORKER_LANE",
    )
    worker_allowed_job_kinds: str | None = Field(
        default=None,
        alias="WORKER_ALLOWED_JOB_KINDS",
    )
    nexus_allow_worker_maintenance: bool = Field(
        default=False,
        alias="NEXUS_ALLOW_WORKER_MAINTENANCE",
    )
    worker_poll_interval_seconds: float = Field(
        default=5.0, alias="WORKER_POLL_INTERVAL_SECONDS", gt=0
    )
    worker_idle_backoff_max_seconds: float = Field(
        default=300.0, alias="WORKER_IDLE_BACKOFF_MAX_SECONDS"
    )
    worker_scheduler_interval_seconds: float = Field(
        default=300.0, alias="WORKER_SCHEDULER_INTERVAL_SECONDS", gt=0
    )
    worker_heartbeat_interval_seconds: float = Field(
        default=60.0, alias="WORKER_HEARTBEAT_INTERVAL_SECONDS", gt=0
    )
    worker_lease_seconds: int = Field(default=300, alias="WORKER_LEASE_SECONDS", ge=1)
    worker_db_failure_backoff_seconds: float = Field(
        default=60.0, alias="WORKER_DB_FAILURE_BACKOFF_SECONDS", gt=0
    )
    worker_db_failure_backoff_max_seconds: float = Field(
        default=900.0, alias="WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS"
    )
    background_process_cgroup_root: Path = Field(
        default=Path("/sys/fs/cgroup"), alias="BACKGROUND_PROCESS_CGROUP_ROOT"
    )
    background_process_wall_timeout_seconds: float = Field(
        default=900.0,
        alias="BACKGROUND_PROCESS_WALL_TIMEOUT_SECONDS",
        gt=0,
        le=900,
    )
    background_process_term_grace_seconds: float = Field(
        default=5.0,
        alias="BACKGROUND_PROCESS_TERM_GRACE_SECONDS",
        gt=0,
        le=30,
    )
    background_process_result_max_bytes: int = Field(
        default=1024 * 1024,
        alias="BACKGROUND_PROCESS_RESULT_MAX_BYTES",
        ge=1024,
        le=4 * 1024 * 1024,
    )
    background_process_oom_score_adj: int = Field(
        default=750,
        alias="BACKGROUND_PROCESS_OOM_SCORE_ADJ",
        ge=1,
        le=1000,
    )
    sync_gutenberg_catalog_schedule_seconds: int = Field(
        default=0, alias="SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS", ge=0
    )
    background_job_prune_schedule_seconds: int = Field(
        default=0, alias="BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS", ge=0
    )
    background_job_prune_succeeded_after_days: int = Field(
        default=7, alias="BACKGROUND_JOB_PRUNE_SUCCEEDED_AFTER_DAYS", ge=1
    )
    background_job_prune_dead_after_days: int = Field(
        default=30, alias="BACKGROUND_JOB_PRUNE_DEAD_AFTER_DAYS", ge=1
    )
    background_job_prune_batch_size: int = Field(
        default=100, alias="BACKGROUND_JOB_PRUNE_BATCH_SIZE", ge=1
    )

    # EPUB archive safety limits. Runtime values may be stricter, never weaker.
    max_epub_archive_entries: int = Field(
        default=10_000, alias="MAX_EPUB_ARCHIVE_ENTRIES", ge=1, le=10_000
    )
    max_epub_archive_total_uncompressed_bytes: int = Field(
        default=536_870_912, alias="MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES", ge=1, le=536_870_912
    )  # 512 MB
    max_epub_archive_single_entry_uncompressed_bytes: int = Field(
        default=67_108_864,
        alias="MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES",
        ge=1,
        le=67_108_864,
    )  # 64 MB
    max_epub_archive_compression_ratio: int = Field(
        default=100, alias="MAX_EPUB_ARCHIVE_COMPRESSION_RATIO", ge=1, le=100
    )
    max_epub_archive_parse_time_ms: int = Field(
        default=30_000, alias="MAX_EPUB_ARCHIVE_PARSE_TIME_MS", ge=1, le=30_000
    )
    max_latex_source_archive_entries: int = Field(
        default=10_000,
        alias="MAX_LATEX_SOURCE_ARCHIVE_ENTRIES",
        ge=1,
        le=10_000,
    )
    max_latex_source_archive_total_uncompressed_bytes: int = Field(
        default=536_870_912,
        alias="MAX_LATEX_SOURCE_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES",
        ge=1,
        le=536_870_912,
    )  # 512 MB
    max_latex_source_archive_single_entry_uncompressed_bytes: int = Field(
        default=134_217_728,
        alias="MAX_LATEX_SOURCE_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES",
        ge=1,
        le=134_217_728,
    )  # 128 MB
    max_latex_source_archive_compression_ratio: int = Field(
        default=100,
        alias="MAX_LATEX_SOURCE_ARCHIVE_COMPRESSION_RATIO",
        ge=1,
        le=100,
    )

    # OpenAI's unqualified key remains embedding-only. Generation credentials
    # are route-specific so no provider secret can cross into the Codex host.
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    generation_api_providers_raw: str = Field(default="", alias="GENERATION_API_PROVIDERS")
    openai_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="OPENAI_GENERATION_API_KEY",
        repr=False,
    )
    anthropic_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="ANTHROPIC_GENERATION_API_KEY",
        repr=False,
    )
    gemini_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="GEMINI_GENERATION_API_KEY",
        repr=False,
    )
    moonshot_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="MOONSHOT_GENERATION_API_KEY",
        repr=False,
    )
    openrouter_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="OPENROUTER_GENERATION_API_KEY",
        repr=False,
    )
    deepseek_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="DEEPSEEK_GENERATION_API_KEY",
        repr=False,
    )
    xai_generation_api_key: SecretStr | None = Field(
        default=None,
        alias="XAI_GENERATION_API_KEY",
        repr=False,
    )
    generation_continuation_encryption_key: SecretStr | None = Field(
        default=None,
        alias="GENERATION_CONTINUATION_ENCRYPTION_KEY",
        repr=False,
    )
    fable_retention_accepted_at: datetime | None = Field(
        default=None,
        alias="NEXUS_FABLE_RETENTION_ACCEPTED_AT",
    )
    agent_tool_grant_signing_key: SecretStr | None = Field(
        default=None,
        alias="AGENT_TOOL_GRANT_SIGNING_KEY",
        repr=False,
    )

    # Public web search provider settings.
    # Brave is the first production web-search provider. If no API key is
    # configured, required web-search turns fail closed with a typed tool error.
    brave_search_api_key: str | None = Field(default=None, alias="BRAVE_SEARCH_API_KEY")
    brave_search_base_url: str = Field(
        default="https://api.search.brave.com/res/v1",
        alias="BRAVE_SEARCH_BASE_URL",
    )
    brave_search_timeout_seconds: float = Field(
        default=8.0,
        alias="BRAVE_SEARCH_TIMEOUT_SECONDS",
    )
    outbound_http_proxy_url: str | None = Field(
        default=None,
        alias="OUTBOUND_HTTP_PROXY_URL",
    )

    # Rate limiting settings.
    rate_limit_rpm: int = Field(default=20, alias="RATE_LIMIT_RPM")  # Requests per minute

    # Transcript semantic embedding settings
    transcript_embedding_model_openai: str = Field(
        default="text-embedding-3-small",
        alias="TRANSCRIPT_EMBEDDING_MODEL_OPENAI",
    )
    transcript_embedding_dimensions: int = Field(
        default=256,
        alias="TRANSCRIPT_EMBEDDING_DIMENSIONS",
    )

    # Metadata enrichment settings. The generation-host wire input-byte invariant
    # is owned solely by build_enrichment_user_content's byte clamp; this cap
    # only sizes the sampled text.
    metadata_enrichment_max_content_chars: int = Field(
        default=2000, alias="METADATA_ENRICHMENT_MAX_CONTENT_CHARS", ge=1
    )
    codex_agent_socket: Path = Field(
        default=Path("/run/nexus-codex/agent.sock"),
        alias="NEXUS_CODEX_AGENT_SOCKET",
    )
    agent_tools_mcp_listen: str = Field(
        default="0.0.0.0:8001",
        alias="NEXUS_AGENT_TOOLS_MCP_LISTEN",
    )
    agent_tools_mcp_origin: str = Field(
        default="http://127.0.0.1:8001/internal/agent-tools/mcp",
        alias="NEXUS_AGENT_TOOLS_MCP_ORIGIN",
    )

    # Synapse resonance engine: SYNAPSE_ENABLED=false turns every scan trigger
    # into a no-op (synapse spec G6).
    synapse_enabled: bool = Field(default=True, alias="SYNAPSE_ENABLED")

    # Dawn write: DAWN_WRITE_ENABLED=false makes the sweep job a no-op.
    dawn_write_enabled: bool = Field(default=True, alias="DAWN_WRITE_ENABLED")
    dawn_write_schedule_seconds: int = Field(default=3600, alias="DAWN_WRITE_SCHEDULE_SECONDS")

    # Grand atlas projection: the nightly PCA re-projection cadence. 0 (default)
    # leaves atlas_project_job unregistered as periodic; the deploy env sets a
    # positive cadence (prod: 86400). The on-demand trigger still fires on ingest.
    atlas_project_schedule_seconds: int = Field(
        default=0, alias="ATLAS_PROJECT_SCHEDULE_SECONDS", ge=0
    )

    # Post Room: private email ingest address (Cloudflare Email Worker → HMAC-signed POST).
    # EMAIL_INGEST_ENABLED gates route registration; when false the endpoint is absent
    # entirely (no live public POST target in CI/local). Required keys are validated
    # only in staging/prod when the flag is true (mirrors the billing block).
    email_ingest_enabled: bool = Field(default=False, alias="EMAIL_INGEST_ENABLED")
    email_ingest_hmac_secret: str | None = Field(default=None, alias="EMAIL_INGEST_HMAC_SECRET")
    email_ingest_address_slug: str | None = Field(default=None, alias="EMAIL_INGEST_ADDRESS_SLUG")
    email_ingest_domain: str | None = Field(default=None, alias="EMAIL_INGEST_DOMAIN")
    email_ingest_owner_user_id: str | None = Field(default=None, alias="EMAIL_INGEST_OWNER_USER_ID")
    email_ingest_max_bytes: int = Field(default=2_097_152, alias="EMAIL_INGEST_MAX_BYTES")

    # Stream token auth.
    # HS256 signing key for short-lived stream tokens (base64-encoded 32+ bytes)
    # Required in staging/prod; auto-generated deterministic key in local/test
    stream_token_signing_key: str | None = Field(default=None, alias="STREAM_TOKEN_SIGNING_KEY")
    # Public URL browsers use for direct stream endpoints.
    stream_base_url: str | None = Field(default=None, alias="STREAM_BASE_URL")
    # Comma-separated list of allowed CORS origins for direct stream endpoints.
    stream_cors_origins: str | None = Field(default=None, alias="STREAM_CORS_ORIGINS")
    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def validate_required_settings(self) -> "Settings":
        """Ensure required settings are set for all environments."""
        self._validate_supabase_auth()
        self._validate_database_origin()
        self._validate_deployed_ingest_reconcile()
        self._validate_deployed_storage()
        self._validate_storage_lifecycle()
        self._validate_transcript_embedding_dimensions()
        self._validate_billing_credentials()
        self._validate_email_credentials()
        self._validate_podcast_credentials()
        self._validate_deployed_browse_provider()
        self._validate_deployed_generation_runtime()
        self._validate_ingest_runtime_and_paths()
        self._validate_worker_lane()
        self._validate_worker_intervals()
        self._validate_background_process_cgroup_root()
        return self

    def _validate_supabase_auth(self) -> None:
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

    def _validate_database_origin(self) -> None:
        if _database_url_looks_like_supabase(self.database_url):
            raise ValueError(
                "DATABASE_URL must point at standalone Postgres, not Supabase Database."
            )
        parse_agent_tools_mcp_listen(self.agent_tools_mcp_listen)
        validate_agent_tools_mcp_runtime_origin(
            self.agent_tools_mcp_origin,
            nexus_env=self.nexus_env,
            worker_lane=self.worker_lane,
        )

    def _validate_deployed_ingest_reconcile(self) -> None:
        if (
            self.nexus_env in (Environment.STAGING, Environment.PROD)
            and self.ingest_reconcile_schedule_seconds == 0
        ):
            raise ValueError("INGEST_RECONCILE_SCHEDULE_SECONDS must be > 0 in staging and prod.")

    def _validate_deployed_storage(self) -> None:
        if self.nexus_env not in (Environment.STAGING, Environment.PROD):
            return
        if not self.nexus_internal_secret:
            raise ValueError(
                f"NEXUS_INTERNAL_SECRET is required for NEXUS_ENV={self.nexus_env.value}"
            )
        missing_r2 = []
        if not self.r2_s3_api_origin:
            missing_r2.append("R2_S3_API_ORIGIN")
        if not self.r2_access_key_id:
            missing_r2.append("R2_ACCESS_KEY_ID")
        if not self.r2_secret_access_key:
            missing_r2.append("R2_SECRET_ACCESS_KEY")
        if not self.r2_bucket:
            missing_r2.append("R2_BUCKET")
        if missing_r2:
            raise ValueError(
                "Cloudflare R2 storage settings are required in staging/prod: "
                f"{', '.join(missing_r2)}"
            )
        parsed_r2_origin = urlparse(self.r2_s3_api_origin or "")
        r2_host = parsed_r2_origin.hostname or ""
        if (
            parsed_r2_origin.scheme != "https"
            or parsed_r2_origin.username
            or parsed_r2_origin.password
            or parsed_r2_origin.path not in ("", "/")
            or parsed_r2_origin.query
            or parsed_r2_origin.fragment
            or not r2_host.endswith(".r2.cloudflarestorage.com")
        ):
            raise ValueError(
                "R2_S3_API_ORIGIN must be the Cloudflare R2 S3 API origin for staging/prod."
            )

    def _validate_storage_lifecycle(self) -> None:
        if self.storage_object_cleanup_write_window_seconds <= self.r2_read_timeout_seconds:
            raise ValueError(
                "STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS must be greater than "
                "R2_READ_TIMEOUT_SECONDS so a delayed writer can be aborted before "
                "its reservation lapses."
            )
        if self.storage_object_cleanup_write_window_seconds <= DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS:
            raise ValueError(
                "STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS must be greater than the "
                f"{DIRECT_UPLOAD_PUT_TIMEOUT_SECONDS}-second browser direct-upload PUT timeout."
            )

    def _validate_transcript_embedding_dimensions(self) -> None:
        if self.transcript_embedding_dimensions != TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS:
            raise ValueError(
                "TRANSCRIPT_EMBEDDING_DIMENSIONS must equal "
                f"{TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS} to match the pgvector schema."
            )

    def _validate_billing_credentials(self) -> None:
        if self.nexus_env not in (Environment.STAGING, Environment.PROD):
            return
        if not self.billing_enabled:
            return
        missing_billing: list[str] = []
        if not self.stripe_secret_key:
            missing_billing.append("STRIPE_SECRET_KEY")
        if not self.stripe_webhook_secret:
            missing_billing.append("STRIPE_WEBHOOK_SECRET")
        if not self.stripe_plus_price_id:
            missing_billing.append("STRIPE_PLUS_PRICE_ID")
        if not self.stripe_ai_plus_price_id:
            missing_billing.append("STRIPE_AI_PLUS_PRICE_ID")
        if not self.stripe_ai_pro_price_id:
            missing_billing.append("STRIPE_AI_PRO_PRICE_ID")
        if missing_billing:
            raise ValueError(
                "Billing is enabled but required Stripe settings are missing: "
                f"{', '.join(missing_billing)}"
            )

    def _validate_email_credentials(self) -> None:
        if self.nexus_env not in (Environment.STAGING, Environment.PROD):
            return
        if not self.email_ingest_enabled:
            return
        missing_email: list[str] = []
        if not self.email_ingest_hmac_secret:
            missing_email.append("EMAIL_INGEST_HMAC_SECRET")
        if not self.email_ingest_address_slug:
            missing_email.append("EMAIL_INGEST_ADDRESS_SLUG")
        if not self.email_ingest_domain:
            missing_email.append("EMAIL_INGEST_DOMAIN")
        if not self.email_ingest_owner_user_id:
            missing_email.append("EMAIL_INGEST_OWNER_USER_ID")
        if missing_email:
            raise ValueError(
                "Email ingest is enabled but required settings are missing: "
                f"{', '.join(missing_email)}"
            )

    def _validate_podcast_credentials(self) -> None:
        if not self.podcasts_enabled:
            return
        missing_podcast_provider_settings: list[str] = []
        if not self.podcast_index_api_key:
            missing_podcast_provider_settings.append("PODCAST_INDEX_API_KEY")
        if not self.podcast_index_api_secret:
            missing_podcast_provider_settings.append("PODCAST_INDEX_API_SECRET")
        if missing_podcast_provider_settings:
            raise ValueError(
                "Podcast features are enabled but provider credentials are missing: "
                f"{', '.join(missing_podcast_provider_settings)}"
            )

    def _validate_deployed_browse_provider(self) -> None:
        if self.nexus_env not in (Environment.STAGING, Environment.PROD):
            return
        if not self.youtube_data_api_key:
            raise ValueError(
                "Browse providers are missing required credentials: YOUTUBE_DATA_API_KEY"
            )

    def _validate_deployed_generation_runtime(self) -> None:
        configured = self.generation_api_provider_list
        credential_by_provider: dict[GenerationApiProvider, tuple[str, SecretStr | None]] = {
            "openai": ("OPENAI_GENERATION_API_KEY", self.openai_generation_api_key),
            "anthropic": (
                "ANTHROPIC_GENERATION_API_KEY",
                self.anthropic_generation_api_key,
            ),
            "gemini": ("GEMINI_GENERATION_API_KEY", self.gemini_generation_api_key),
            "moonshot": (
                "MOONSHOT_GENERATION_API_KEY",
                self.moonshot_generation_api_key,
            ),
            "openrouter": (
                "OPENROUTER_GENERATION_API_KEY",
                self.openrouter_generation_api_key,
            ),
            "deepseek": (
                "DEEPSEEK_GENERATION_API_KEY",
                self.deepseek_generation_api_key,
            ),
            "xai": ("XAI_GENERATION_API_KEY", self.xai_generation_api_key),
        }
        missing: list[str] = []
        for provider in configured:
            name, credential = credential_by_provider[provider]
            if credential is None or not credential.get_secret_value().strip():
                missing.append(name)
        if missing:
            raise ValueError(
                "Configured generation providers are missing credentials: " + ", ".join(missing)
            )
        stale = [
            name
            for provider, (name, credential) in credential_by_provider.items()
            if provider not in configured
            and credential is not None
            and credential.get_secret_value() != ""
        ]
        if stale:
            raise ValueError(
                "Generation credentials are forbidden for unconfigured provider "
                + ", ".join(name.removesuffix("_GENERATION_API_KEY").lower() for name in stale)
            )
        if configured:
            if self.generation_continuation_encryption_key is None:
                raise ValueError(
                    "GENERATION_CONTINUATION_ENCRYPTION_KEY is required when an API provider "
                    "is configured"
                )
            encoded_key = self.generation_continuation_encryption_key.get_secret_value()
            try:
                decoded_key = base64.b64decode(encoded_key, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError(
                    "GENERATION_CONTINUATION_ENCRYPTION_KEY must be canonical base64 for a "
                    "32-byte key"
                ) from exc
            if len(decoded_key) != 32 or base64.b64encode(decoded_key).decode() != encoded_key:
                raise ValueError(
                    "GENERATION_CONTINUATION_ENCRYPTION_KEY must be canonical base64 for a "
                    "32-byte key"
                )
        if "anthropic" in configured:
            if self.fable_retention_accepted_at is None:
                raise ValueError(
                    "NEXUS_FABLE_RETENTION_ACCEPTED_AT is required when Anthropic is configured"
                )
            if self.fable_retention_accepted_at.utcoffset() is None:
                raise ValueError("NEXUS_FABLE_RETENTION_ACCEPTED_AT must include a timezone")
        elif self.fable_retention_accepted_at is not None:
            raise ValueError(
                "NEXUS_FABLE_RETENTION_ACCEPTED_AT is forbidden while Anthropic is unconfigured"
            )

        if self.nexus_env not in (Environment.STAGING, Environment.PROD):
            return
        if not configured:
            raise ValueError("GENERATION_API_PROVIDERS must be nonempty in staging/prod")
        if not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for transcript embeddings")
        if not self.agent_tool_grant_signing_key:
            raise ValueError("AGENT_TOOL_GRANT_SIGNING_KEY is required in staging/prod")
        from nexus.services.agent_tool_grants import validate_agent_tool_grant_signing_key

        try:
            validate_agent_tool_grant_signing_key(self.agent_tool_grant_signing_key)
        except ValueError as exc:
            raise ValueError("AGENT_TOOL_GRANT_SIGNING_KEY is invalid") from exc

    def _validate_ingest_runtime_and_paths(self) -> None:
        if (
            not self.codex_agent_socket.is_absolute()
            or Path(os.path.normpath(str(self.codex_agent_socket))) != self.codex_agent_socket
        ):
            raise ValueError("NEXUS_CODEX_AGENT_SOCKET must be a normalized absolute path.")
        if not self.parser_temp_root.is_absolute():
            raise ValueError("PARSER_TEMP_ROOT must be an absolute path.")

    def _validate_worker_lane(self) -> None:
        if self.worker_lane == "maintenance":
            if not self.nexus_allow_worker_maintenance:
                raise ValueError(
                    "WORKER_LANE=maintenance requires NEXUS_ALLOW_WORKER_MAINTENANCE=1."
                )
            allowed_kinds = tuple(
                value.strip()
                for value in (self.worker_allowed_job_kinds or "").split(",")
                if value.strip()
            )
            if not allowed_kinds:
                raise ValueError("WORKER_LANE=maintenance requires WORKER_ALLOWED_JOB_KINDS.")
            if len(set(allowed_kinds)) != len(allowed_kinds):
                raise ValueError("WORKER_ALLOWED_JOB_KINDS must not contain duplicates.")
            unknown_maintenance_kinds = set(allowed_kinds) - set(MAINTENANCE_JOB_KINDS)
            if unknown_maintenance_kinds:
                raise ValueError(
                    "WORKER_ALLOWED_JOB_KINDS must be a subset of MAINTENANCE_JOB_KINDS; "
                    f"invalid kinds: {', '.join(sorted(unknown_maintenance_kinds))}."
                )
        else:
            if self.worker_allowed_job_kinds is not None:
                raise ValueError(
                    "WORKER_ALLOWED_JOB_KINDS is valid only with WORKER_LANE=maintenance."
                )
            if self.nexus_allow_worker_maintenance:
                raise ValueError(
                    "NEXUS_ALLOW_WORKER_MAINTENANCE is valid only with WORKER_LANE=maintenance."
                )
        if (
            self.worker_lane is not None
            and self.nexus_env in (Environment.STAGING, Environment.PROD)
            and self.database_statement_timeout_ms == 0
        ):
            raise ValueError("DATABASE_STATEMENT_TIMEOUT_MS must be bounded for deployed workers.")

    def _validate_worker_intervals(self) -> None:
        if self.worker_idle_backoff_max_seconds < self.worker_poll_interval_seconds:
            raise ValueError(
                "WORKER_IDLE_BACKOFF_MAX_SECONDS must be >= WORKER_POLL_INTERVAL_SECONDS."
            )
        if self.worker_db_failure_backoff_max_seconds < self.worker_db_failure_backoff_seconds:
            raise ValueError(
                "WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS must be >= "
                "WORKER_DB_FAILURE_BACKOFF_SECONDS."
            )

    def _validate_background_process_cgroup_root(self) -> None:
        if not self.background_process_cgroup_root.is_absolute():
            raise ValueError("BACKGROUND_PROCESS_CGROUP_ROOT must be an absolute path.")

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
    def stream_cors_origin_list(self) -> list[str]:
        """Parse comma-separated CORS origins into a list."""
        if self.stream_cors_origins:
            return [o.strip() for o in self.stream_cors_origins.split(",") if o.strip()]
        return []

    @property
    def effective_stream_base_url(self) -> str:
        """Return stream base URL, falling back to FASTAPI_BASE_URL-style default."""
        return self.stream_base_url or "http://localhost:8000"

    @property
    def effective_stream_token_signing_key(self) -> str:
        """Return stream token signing key, using deterministic test key for local/test."""
        if self.stream_token_signing_key:
            return self.stream_token_signing_key
        if self.nexus_env in (Environment.LOCAL, Environment.TEST):
            return "dGVzdC1zdHJlYW0tdG9rZW4tc2lnbmluZy1rZXktMzJieXRlcw=="  # test key
        raise ValueError("STREAM_TOKEN_SIGNING_KEY is required in staging/prod")

    @property
    def effective_agent_tool_grant_signing_key(self) -> SecretStr:
        """Return the dedicated grant key, with a non-production test key only."""
        if self.agent_tool_grant_signing_key is not None:
            return self.agent_tool_grant_signing_key
        if self.nexus_env in (Environment.LOCAL, Environment.TEST):
            return SecretStr("test-agent-tools-grant-signing-key-32-bytes!")
        raise ValueError("AGENT_TOOL_GRANT_SIGNING_KEY is required in staging/prod")

    @property
    def effective_generation_continuation_encryption_key(self) -> SecretStr:
        """Return the deployment key, or an unused deterministic local/test key."""

        if self.generation_continuation_encryption_key is not None:
            return self.generation_continuation_encryption_key
        if self.nexus_env in (Environment.LOCAL, Environment.TEST) and not (
            self.generation_api_provider_list
        ):
            return SecretStr(base64.b64encode(b"nexus-local-continuation-key-v1!").decode("ascii"))
        raise ValueError("GENERATION_CONTINUATION_ENCRYPTION_KEY is required")

    @property
    def generation_api_provider_list(self) -> tuple[GenerationApiProvider, ...]:
        """Parse the required deployment-owned provider list once at ingress."""

        if self.generation_api_providers_raw == "":
            return ()
        providers: list[GenerationApiProvider] = []
        for raw_provider in self.generation_api_providers_raw.split(","):
            provider = raw_provider.strip()
            match provider:
                case (
                    "openai"
                    | "anthropic"
                    | "gemini"
                    | "moonshot"
                    | "openrouter"
                    | "deepseek"
                    | "xai"
                ):
                    providers.append(provider)
                case "":
                    raise ValueError("GENERATION_API_PROVIDERS contains an empty provider")
                case _:
                    raise ValueError(
                        f"GENERATION_API_PROVIDERS contains unknown provider {provider!r}"
                    )
        if len(set(providers)) != len(providers):
            raise ValueError("GENERATION_API_PROVIDERS contains a duplicate provider")
        return tuple(providers)


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings.

    Returns:
        Settings instance loaded from environment.

    Raises:
        ValidationError: If required settings are missing or invalid.
    """
    return Settings()  # pyright: ignore[reportCallIssue] - BaseSettings reads env.
