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

import os
from datetime import datetime
from enum import Enum
from functools import lru_cache
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings

TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS = 256
DEFAULT_WORKER_ALLOWED_JOB_KINDS = (
    "ingest_media_source,enrich_metadata,chat_run,"
    "library_dossier_generate,media_unit_build,note_reindex_job,"
    "podcast_sync_subscription_job,podcast_reindex_semantic_job,"
    "oracle_reading_generate,synapse_scan,"
    "dawn_write_job,"
    "conversation_distill,conversation_distill_sweep,atlas_project_job,"
    # Media teardown + its durable storage sweeps (spec §3.1). The default worker
    # must claim these so a user delete actually physically deletes, the Armed
    # write-reservation deadlines fire, and the recurring orphan sweep is scheduled.
    "media_teardown,storage_object_cleanup,storage_orphan_sweep"
)


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


class Settings(BaseSettings):
    """Application configuration.

    Settings are loaded from environment variables.
    Validation rules:
    - DATABASE_URL is always required
    - DATABASE_URL must not point at Supabase Database in any environment
    - SUPABASE_JWKS_URL, SUPABASE_ISSUER, SUPABASE_AUDIENCES are required in all environments
    - NEXUS_INTERNAL_SECRET is required in staging and prod only
    - Supabase service-role keys are rejected as app runtime settings
    """

    nexus_env: Environment = Field(default=Environment.LOCAL, alias="NEXUS_ENV")
    database_url: Annotated[str, Field(alias="DATABASE_URL")]
    database_pool_size: int = Field(default=10, alias="DATABASE_POOL_SIZE")
    database_max_overflow: int = Field(default=20, alias="DATABASE_MAX_OVERFLOW")
    database_pool_timeout_seconds: float = Field(
        default=30.0, alias="DATABASE_POOL_TIMEOUT_SECONDS"
    )
    database_statement_timeout_ms: int = Field(default=30000, alias="DATABASE_STATEMENT_TIMEOUT_MS")
    database_lock_timeout_ms: int = Field(default=10000, alias="DATABASE_LOCK_TIMEOUT_MS")
    # 60s, not aggressive: create_chat_run holds a transaction open across a
    # BYOK key probe (an external call), so this must clear the slowest legit
    # in-transaction wait while still reaping a leaked transaction (the recent
    # pool-exhaustion deadlock idled for 180s+).
    database_idle_in_tx_timeout_ms: int = Field(
        default=60000, alias="DATABASE_IDLE_IN_TX_TIMEOUT_MS"
    )
    nexus_internal_secret: str | None = Field(default=None, alias="NEXUS_INTERNAL_SECRET")

    # Supabase auth settings (required in all environments)
    supabase_jwks_url: str | None = Field(default=None, alias="SUPABASE_JWKS_URL")
    supabase_issuer: str | None = Field(default=None, alias="SUPABASE_ISSUER")
    supabase_audiences: str | None = Field(default=None, alias="SUPABASE_AUDIENCES")

    # Rejected Supabase Auth admin settings. Seed scripts must read service-role
    # keys from script-local env, not the application runtime Settings object.
    supabase_service_key_rejected: str | None = Field(
        default=None,
        alias="SUPABASE_SERVICE_KEY",
        exclude=True,
        repr=False,
    )
    supabase_service_role_key_rejected: str | None = Field(
        default=None,
        alias="SUPABASE_SERVICE_ROLE_KEY",
        exclude=True,
        repr=False,
    )
    supabase_auth_admin_key_rejected: str | None = Field(
        default=None,
        alias="SUPABASE_AUTH_ADMIN_KEY",
        exclude=True,
        repr=False,
    )
    supabase_database_url_rejected: str | None = Field(
        default=None,
        alias="SUPABASE_DATABASE_URL",
        exclude=True,
        repr=False,
    )
    service_role_key_rejected: str | None = Field(
        default=None,
        alias="SERVICE_ROLE_KEY",
        exclude=True,
        repr=False,
    )

    # Cloudflare R2 object storage settings.
    r2_s3_api_origin: str | None = Field(default=None, alias="R2_S3_API_ORIGIN")
    r2_access_key_id: str | None = Field(default=None, alias="R2_ACCESS_KEY_ID")
    r2_secret_access_key: str | None = Field(default=None, alias="R2_SECRET_ACCESS_KEY")
    r2_bucket: str | None = Field(default=None, alias="R2_BUCKET")
    r2_region: str = Field(default="auto", alias="R2_REGION")
    r2_endpoint_url_rejected: str | None = Field(
        default=None,
        alias="R2_ENDPOINT_URL",
        exclude=True,
        repr=False,
    )
    csp_extra_connect_origins_rejected: str | None = Field(
        default=None,
        alias="CSP_EXTRA_CONNECT_ORIGINS",
        exclude=True,
        repr=False,
    )
    # Explicit botocore timeouts for the R2 S3-compatible client. Bounded low so a
    # stalled object-store call fails fast instead of holding a worker/request open.
    r2_connect_timeout_seconds: float = Field(default=5.0, alias="R2_CONNECT_TIMEOUT_SECONDS")
    r2_read_timeout_seconds: float = Field(default=30.0, alias="R2_READ_TIMEOUT_SECONDS")

    # Media teardown: durable cleanup timing for the media-deletion job family
    # (media_teardown, storage_object_cleanup, storage_orphan_sweep).
    media_teardown_cleanup_grace_seconds: int = Field(
        default=60, alias="MEDIA_TEARDOWN_CLEANUP_GRACE_SECONDS"
    )
    # writeMayLandUntil horizon for an in-process write's durable final-sweep
    # record. Must exceed r2_read_timeout_seconds so a delayed writer can be
    # aborted (or must renew under the media lock) before its reservation lapses.
    storage_object_cleanup_write_window_seconds: int = Field(
        default=300, alias="STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS"
    )
    storage_orphan_sweep_interval_seconds: int = Field(
        default=21600, alias="STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS"
    )
    storage_orphan_sweep_min_age_seconds: int = Field(
        default=86400, alias="STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS"
    )

    # Storage limits
    max_pdf_bytes: int = Field(default=100 * 1024 * 1024, alias="MAX_PDF_BYTES")  # 100 MB
    max_epub_bytes: int = Field(default=50 * 1024 * 1024, alias="MAX_EPUB_BYTES")  # 50 MB
    max_arxiv_source_bytes: int = Field(
        default=50 * 1024 * 1024,
        alias="MAX_ARXIV_SOURCE_BYTES",
    )
    ingest_stream_timeout_s: int = Field(default=60, alias="INGEST_STREAM_TIMEOUT_S")
    signed_url_expiry_s: int = Field(default=300, alias="SIGNED_URL_EXPIRY_S")  # 5 minutes

    # Podcast discovery and subscription ingestion policy.
    podcasts_enabled: bool = Field(default=True, alias="PODCASTS_ENABLED")
    podcast_index_api_key: str | None = Field(default=None, alias="PODCAST_INDEX_API_KEY")
    podcast_index_api_secret: str | None = Field(default=None, alias="PODCAST_INDEX_API_SECRET")
    podcast_index_base_url: str = Field(
        default="https://api.podcastindex.org/api/1.0",
        alias="PODCAST_INDEX_BASE_URL",
    )
    real_media_provider_fixtures: bool = Field(
        default=False,
        alias="REAL_MEDIA_PROVIDER_FIXTURES",
    )
    real_media_fixture_dir: str | None = Field(default=None, alias="REAL_MEDIA_FIXTURE_DIR")
    youtube_data_api_key: str | None = Field(default=None, alias="YOUTUBE_DATA_API_KEY")
    youtube_data_base_url: str = Field(
        default="https://www.googleapis.com/youtube/v3",
        alias="YOUTUBE_DATA_BASE_URL",
    )
    x_api_bearer_token: str | None = Field(default=None, alias="X_API_BEARER_TOKEN")
    x_api_base_url: str = Field(default="https://api.x.com/2", alias="X_API_BASE_URL")
    x_api_timeout_seconds: float = Field(default=10.0, alias="X_API_TIMEOUT_SECONDS")
    x_api_author_thread_max_posts: int = Field(
        default=1000,
        alias="X_API_AUTHOR_THREAD_MAX_POSTS",
    )
    youtube_transcript_timeout_seconds: float = Field(
        default=30.0,
        alias="YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS",
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
    )
    deepgram_api_key: str | None = Field(default=None, alias="DEEPGRAM_API_KEY")
    deepgram_base_url: str = Field(default="https://api.deepgram.com", alias="DEEPGRAM_BASE_URL")
    deepgram_model: str = Field(default="nova-3", alias="DEEPGRAM_MODEL")
    podcast_transcription_timeout_seconds: float = Field(
        default=90.0, alias="PODCAST_TRANSCRIPTION_TIMEOUT_SECONDS"
    )
    podcast_initial_episode_window: int = Field(default=3, alias="PODCAST_INITIAL_EPISODE_WINDOW")
    podcast_ingest_prefetch_limit: int = Field(default=50, alias="PODCAST_INGEST_PREFETCH_LIMIT")
    podcast_active_poll_schedule_seconds: int = Field(
        default=0, alias="PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS"
    )
    podcast_active_poll_limit: int = Field(default=100, alias="PODCAST_ACTIVE_POLL_LIMIT")
    podcast_active_poll_run_lease_seconds: int = Field(
        default=900, alias="PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS"
    )
    podcast_sync_running_lease_seconds: int = Field(
        default=1800, alias="PODCAST_SYNC_RUNNING_LEASE_SECONDS"
    )

    # Billing / Stripe settings
    app_public_url: str = Field(default="http://localhost:3000", alias="APP_PUBLIC_URL")
    billing_enabled: bool = Field(default=True, alias="BILLING_ENABLED")
    stripe_secret_key: str | None = Field(default=None, alias="STRIPE_SECRET_KEY")
    stripe_webhook_secret: str | None = Field(default=None, alias="STRIPE_WEBHOOK_SECRET")
    stripe_plus_price_id: str | None = Field(default=None, alias="STRIPE_PLUS_PRICE_ID")
    stripe_ai_plus_price_id: str | None = Field(default=None, alias="STRIPE_AI_PLUS_PRICE_ID")
    stripe_ai_pro_price_id: str | None = Field(default=None, alias="STRIPE_AI_PRO_PRICE_ID")
    billing_ai_plus_platform_token_limit_monthly: int = Field(
        default=1_000_000,
        alias="BILLING_AI_PLUS_PLATFORM_TOKEN_LIMIT_MONTHLY",
    )
    billing_ai_pro_platform_token_limit_monthly: int = Field(
        default=3_000_000,
        alias="BILLING_AI_PRO_PLATFORM_TOKEN_LIMIT_MONTHLY",
    )
    billing_ai_plus_transcription_minutes_monthly: int = Field(
        default=300,
        alias="BILLING_AI_PLUS_TRANSCRIPTION_MINUTES_MONTHLY",
    )
    billing_ai_pro_transcription_minutes_monthly: int = Field(
        default=1200,
        alias="BILLING_AI_PRO_TRANSCRIPTION_MINUTES_MONTHLY",
    )

    # Ingest recovery guardrails
    ingest_reconcile_schedule_seconds: int = Field(
        default=0, alias="INGEST_RECONCILE_SCHEDULE_SECONDS"
    )
    ingest_stale_extracting_seconds: int = Field(
        default=1800, alias="INGEST_STALE_EXTRACTING_SECONDS"
    )
    ingest_stale_requeue_max_attempts: int = Field(
        default=3, alias="INGEST_STALE_REQUEUE_MAX_ATTEMPTS"
    )
    ingest_semantic_repair_batch_limit: int = Field(
        default=50, alias="INGEST_SEMANTIC_REPAIR_BATCH_LIMIT"
    )
    ingest_semantic_failed_retry_seconds: int = Field(
        default=1800, alias="INGEST_SEMANTIC_FAILED_RETRY_SECONDS"
    )

    # Worker runtime. Production defaults are safe for a small VPS Postgres:
    # explicit domain jobs only, no maintenance jobs, and bounded idle/backoff loops.
    worker_allowed_job_kinds: str = Field(
        default=DEFAULT_WORKER_ALLOWED_JOB_KINDS,
        alias="WORKER_ALLOWED_JOB_KINDS",
    )
    worker_poll_interval_seconds: float = Field(default=5.0, alias="WORKER_POLL_INTERVAL_SECONDS")
    worker_idle_backoff_max_seconds: float = Field(
        default=300.0, alias="WORKER_IDLE_BACKOFF_MAX_SECONDS"
    )
    worker_scheduler_interval_seconds: float = Field(
        default=300.0, alias="WORKER_SCHEDULER_INTERVAL_SECONDS"
    )
    worker_heartbeat_interval_seconds: float = Field(
        default=60.0, alias="WORKER_HEARTBEAT_INTERVAL_SECONDS"
    )
    worker_lease_seconds: int = Field(default=300, alias="WORKER_LEASE_SECONDS")
    worker_db_failure_backoff_seconds: float = Field(
        default=60.0, alias="WORKER_DB_FAILURE_BACKOFF_SECONDS"
    )
    worker_db_failure_backoff_max_seconds: float = Field(
        default=900.0, alias="WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS"
    )
    sync_gutenberg_catalog_schedule_seconds: int = Field(
        default=0, alias="SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS"
    )
    background_job_prune_schedule_seconds: int = Field(
        default=0, alias="BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS"
    )
    background_job_prune_succeeded_after_days: int = Field(
        default=7, alias="BACKGROUND_JOB_PRUNE_SUCCEEDED_AFTER_DAYS"
    )
    background_job_prune_dead_after_days: int = Field(
        default=30, alias="BACKGROUND_JOB_PRUNE_DEAD_AFTER_DAYS"
    )
    background_job_prune_batch_size: int = Field(
        default=100, alias="BACKGROUND_JOB_PRUNE_BATCH_SIZE"
    )

    # EPUB archive safety limits. Runtime values may be stricter, never weaker.
    max_epub_archive_entries: int = Field(default=10_000, alias="MAX_EPUB_ARCHIVE_ENTRIES")
    max_epub_archive_total_uncompressed_bytes: int = Field(
        default=536_870_912, alias="MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES"
    )  # 512 MB
    max_epub_archive_single_entry_uncompressed_bytes: int = Field(
        default=67_108_864, alias="MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES"
    )  # 64 MB
    max_epub_archive_compression_ratio: int = Field(
        default=100, alias="MAX_EPUB_ARCHIVE_COMPRESSION_RATIO"
    )
    max_epub_archive_parse_time_ms: int = Field(
        default=30_000, alias="MAX_EPUB_ARCHIVE_PARSE_TIME_MS"
    )
    max_latex_source_archive_entries: int = Field(
        default=10_000,
        alias="MAX_LATEX_SOURCE_ARCHIVE_ENTRIES",
    )
    max_latex_source_archive_total_uncompressed_bytes: int = Field(
        default=536_870_912,
        alias="MAX_LATEX_SOURCE_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES",
    )  # 512 MB
    max_latex_source_archive_single_entry_uncompressed_bytes: int = Field(
        default=134_217_728,
        alias="MAX_LATEX_SOURCE_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES",
    )  # 128 MB
    max_latex_source_archive_compression_ratio: int = Field(
        default=100,
        alias="MAX_LATEX_SOURCE_ARCHIVE_COMPRESSION_RATIO",
    )

    # Platform API keys for LLM providers.
    # If set, models from that provider are available to all users
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")
    moonshot_api_key: str | None = Field(default=None, alias="MOONSHOT_API_KEY")

    # Explicit RFC 3339 deployment assertion: Fable (the platform LLM runtime)
    # requires 30-day retention and is not ZDR-eligible, so a human operator
    # must record when that tradeoff was accepted. Required in staging/prod.
    nexus_fable_retention_accepted_at: str | None = Field(
        default=None, alias="NEXUS_FABLE_RETENTION_ACCEPTED_AT"
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
    brave_search_country: str = Field(default="US", alias="BRAVE_SEARCH_COUNTRY")
    brave_search_language: str = Field(default="en", alias="BRAVE_SEARCH_LANGUAGE")
    brave_search_safe_search: Literal["off", "moderate", "strict"] = Field(
        default="moderate",
        alias="BRAVE_SEARCH_SAFE_SEARCH",
    )

    # LLM provider feature flags.
    # Rate limiting settings.
    rate_limit_rpm: int = Field(default=20, alias="RATE_LIMIT_RPM")  # Requests per minute
    rate_limit_concurrent: int = Field(default=3, alias="RATE_LIMIT_CONCURRENT")  # Max concurrent

    # Transcript semantic embedding settings
    transcript_embedding_model_openai: str = Field(
        default="text-embedding-3-small",
        alias="TRANSCRIPT_EMBEDDING_MODEL_OPENAI",
    )
    transcript_embedding_dimensions: int = Field(
        default=256,
        alias="TRANSCRIPT_EMBEDDING_DIMENSIONS",
    )
    transcript_embedding_timeout_seconds: float = Field(
        default=20.0,
        alias="TRANSCRIPT_EMBEDDING_TIMEOUT_SECONDS",
    )

    # Metadata enrichment settings
    metadata_enrichment_enabled: bool = Field(default=True, alias="METADATA_ENRICHMENT_ENABLED")
    metadata_enrichment_provider: Literal["openai", "anthropic", "gemini"] = Field(
        default="openai", alias="METADATA_ENRICHMENT_PROVIDER"
    )
    # The default is a catalog "light" tier model; select_enrichment_model asserts
    # catalog membership for the configured provider at task use.
    metadata_enrichment_model: str = Field(
        default="gpt-5.4-mini", alias="METADATA_ENRICHMENT_MODEL"
    )
    metadata_enrichment_max_content_chars: int = Field(
        default=2000, alias="METADATA_ENRICHMENT_MAX_CONTENT_CHARS"
    )
    metadata_enrichment_max_output_tokens: int = Field(
        default=1200, alias="METADATA_ENRICHMENT_MAX_OUTPUT_TOKENS"
    )

    # Synapse resonance engine: SYNAPSE_ENABLED=false turns every scan trigger
    # into a no-op (synapse spec G6).
    synapse_enabled: bool = Field(default=True, alias="SYNAPSE_ENABLED")

    # Dawn write: DAWN_WRITE_ENABLED=false makes the sweep job a no-op.
    dawn_write_enabled: bool = Field(default=True, alias="DAWN_WRITE_ENABLED")
    dawn_write_schedule_seconds: int = Field(default=3600, alias="DAWN_WRITE_SCHEDULE_SECONDS")

    # Conversation distillate sweep: DISTILL_ENABLED=false makes the sweep + the
    # on-demand distill enqueue no-ops (one deploy safety valve, D-14). The sweep
    # is an opt-in periodic job: 0 (default) leaves conversation_distill_sweep
    # unregistered as periodic; the deploy env sets a positive cadence (prod: 3600).
    distill_enabled: bool = Field(default=True, alias="DISTILL_ENABLED")
    conversation_distill_schedule_seconds: int = Field(
        default=0, alias="CONVERSATION_DISTILL_SCHEDULE_SECONDS"
    )

    # Grand atlas projection: the nightly PCA re-projection cadence. 0 (default)
    # leaves atlas_project_job unregistered as periodic; the deploy env sets a
    # positive cadence (prod: 86400). The on-demand trigger still fires on ingest.
    atlas_project_schedule_seconds: int = Field(default=0, alias="ATLAS_PROJECT_SCHEDULE_SECONDS")

    # Amanuensis: ASSISTANT_WRITE_TOOLS_ENABLED=false omits the five write
    # ToolSpecs from the chat tool loop, leaving a read-only agent (amanuensis
    # D-6, AC-6).
    assistant_write_tools_enabled: bool = Field(default=True, alias="ASSISTANT_WRITE_TOOLS_ENABLED")

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
    # Default max output tokens for budget reservation
    stream_max_output_tokens_default: int = Field(
        default=1024, alias="STREAM_MAX_OUTPUT_TOKENS_DEFAULT"
    )

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    # Maximum accepted EPUB archive safety values.
    _EPUB_ARCHIVE_CEILINGS = {
        "max_epub_archive_entries": 10_000,
        "max_epub_archive_total_uncompressed_bytes": 536_870_912,
        "max_epub_archive_single_entry_uncompressed_bytes": 67_108_864,
        "max_epub_archive_compression_ratio": 100,
        "max_epub_archive_parse_time_ms": 30_000,
    }
    _LATEX_SOURCE_ARCHIVE_CEILINGS = {
        "max_latex_source_archive_entries": 10_000,
        "max_latex_source_archive_total_uncompressed_bytes": 536_870_912,
        "max_latex_source_archive_single_entry_uncompressed_bytes": 134_217_728,
        "max_latex_source_archive_compression_ratio": 100,
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

        rejected_supabase_service_role_settings = [
            alias
            for alias, value in (
                ("SUPABASE_SERVICE_KEY", self.supabase_service_key_rejected),
                ("SUPABASE_SERVICE_ROLE_KEY", self.supabase_service_role_key_rejected),
                ("SUPABASE_AUTH_ADMIN_KEY", self.supabase_auth_admin_key_rejected),
                ("SUPABASE_DATABASE_URL", self.supabase_database_url_rejected),
                ("SERVICE_ROLE_KEY", self.service_role_key_rejected),
            )
            if value
        ]
        if rejected_supabase_service_role_settings:
            raise ValueError(
                "Supabase admin/database settings are not application runtime settings: "
                f"{', '.join(rejected_supabase_service_role_settings)}. "
                "Use script-local environment for seed scripts instead."
            )

        if _database_url_looks_like_supabase(self.database_url):
            raise ValueError(
                "DATABASE_URL must point at standalone Postgres, not Supabase Database."
            )

        rejected_storage_origin_settings = [
            alias
            for alias, value in (
                ("R2_ENDPOINT_URL", self.r2_endpoint_url_rejected),
                (
                    "CSP_EXTRA_CONNECT_ORIGINS",
                    self.csp_extra_connect_origins_rejected,
                ),
            )
            if value
        ]
        if rejected_storage_origin_settings:
            raise ValueError(
                "Removed storage-origin env settings are not supported: "
                f"{', '.join(rejected_storage_origin_settings)}. "
                "Use R2_S3_API_ORIGIN."
            )

        if self.database_pool_size < 1:
            raise ValueError("DATABASE_POOL_SIZE must be >= 1.")
        if self.database_max_overflow < 0:
            raise ValueError("DATABASE_MAX_OVERFLOW must be >= 0.")
        if self.database_pool_timeout_seconds <= 0:
            raise ValueError("DATABASE_POOL_TIMEOUT_SECONDS must be > 0.")
        if self.database_statement_timeout_ms < 0:
            raise ValueError("DATABASE_STATEMENT_TIMEOUT_MS must be >= 0.")
        if self.database_lock_timeout_ms < 0:
            raise ValueError("DATABASE_LOCK_TIMEOUT_MS must be >= 0.")
        if self.database_idle_in_tx_timeout_ms < 0:
            raise ValueError("DATABASE_IDLE_IN_TX_TIMEOUT_MS must be >= 0.")

        # NEXUS_INTERNAL_SECRET is required only in staging/prod
        if self.nexus_env in (Environment.STAGING, Environment.PROD):
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

        if self.r2_connect_timeout_seconds <= 0 or self.r2_connect_timeout_seconds > 10:
            raise ValueError("R2_CONNECT_TIMEOUT_SECONDS must be > 0 and <= 10.")
        if self.r2_read_timeout_seconds <= 0 or self.r2_read_timeout_seconds > 60:
            raise ValueError("R2_READ_TIMEOUT_SECONDS must be > 0 and <= 60.")
        if self.media_teardown_cleanup_grace_seconds < 0:
            raise ValueError("MEDIA_TEARDOWN_CLEANUP_GRACE_SECONDS must be >= 0.")
        if self.storage_object_cleanup_write_window_seconds <= 0:
            raise ValueError("STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS must be > 0.")
        if self.storage_object_cleanup_write_window_seconds <= self.r2_read_timeout_seconds:
            raise ValueError(
                "STORAGE_OBJECT_CLEANUP_WRITE_WINDOW_SECONDS must be greater than "
                "R2_READ_TIMEOUT_SECONDS so a delayed writer can be aborted before "
                "its reservation lapses."
            )
        if self.storage_orphan_sweep_interval_seconds <= 0:
            raise ValueError("STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS must be > 0.")
        if self.storage_orphan_sweep_min_age_seconds < 0:
            raise ValueError("STORAGE_ORPHAN_SWEEP_MIN_AGE_SECONDS must be >= 0.")

        for field_name, ceiling in self._EPUB_ARCHIVE_CEILINGS.items():
            value = getattr(self, field_name)
            if value > ceiling:
                raise ValueError(
                    f"{field_name.upper()}={value} exceeds archive safety ceiling {ceiling}. "
                    "Runtime values may be stricter (lower) but never weaker."
                )
            if value < 1:
                raise ValueError(f"{field_name.upper()}={value} must be >= 1.")

        for field_name, ceiling in self._LATEX_SOURCE_ARCHIVE_CEILINGS.items():
            value = getattr(self, field_name)
            if value > ceiling:
                raise ValueError(
                    f"{field_name.upper()}={value} exceeds archive safety ceiling {ceiling}. "
                    "Runtime values may be stricter (lower) but never weaker."
                )
            if value < 1:
                raise ValueError(f"{field_name.upper()}={value} must be >= 1.")

        if self.podcast_initial_episode_window < 1:
            raise ValueError("PODCAST_INITIAL_EPISODE_WINDOW must be >= 1.")
        if self.billing_ai_plus_platform_token_limit_monthly < 0:
            raise ValueError("BILLING_AI_PLUS_PLATFORM_TOKEN_LIMIT_MONTHLY must be >= 0.")
        if self.billing_ai_pro_platform_token_limit_monthly < 0:
            raise ValueError("BILLING_AI_PRO_PLATFORM_TOKEN_LIMIT_MONTHLY must be >= 0.")
        if self.billing_ai_plus_transcription_minutes_monthly < 0:
            raise ValueError("BILLING_AI_PLUS_TRANSCRIPTION_MINUTES_MONTHLY must be >= 0.")
        if self.billing_ai_pro_transcription_minutes_monthly < 0:
            raise ValueError("BILLING_AI_PRO_TRANSCRIPTION_MINUTES_MONTHLY must be >= 0.")
        if self.transcript_embedding_dimensions != TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS:
            raise ValueError(
                "TRANSCRIPT_EMBEDDING_DIMENSIONS must equal "
                f"{TRANSCRIPT_EMBEDDING_SCHEMA_DIMENSIONS} to match the pgvector schema."
            )
        if self.transcript_embedding_timeout_seconds <= 0:
            raise ValueError("TRANSCRIPT_EMBEDDING_TIMEOUT_SECONDS must be > 0.")
        if self.podcast_ingest_prefetch_limit < 1:
            raise ValueError("PODCAST_INGEST_PREFETCH_LIMIT must be >= 1.")
        if self.podcast_active_poll_schedule_seconds < 0:
            raise ValueError("PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS must be >= 0.")
        if self.podcast_active_poll_limit < 1:
            raise ValueError("PODCAST_ACTIVE_POLL_LIMIT must be >= 1.")
        if self.podcast_active_poll_run_lease_seconds < 1:
            raise ValueError("PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS must be >= 1.")
        if self.podcast_sync_running_lease_seconds < 1:
            raise ValueError("PODCAST_SYNC_RUNNING_LEASE_SECONDS must be >= 1.")
        if self.podcast_transcription_timeout_seconds <= 0:
            raise ValueError("PODCAST_TRANSCRIPTION_TIMEOUT_SECONDS must be > 0.")
        if self.youtube_transcript_timeout_seconds <= 0:
            raise ValueError("YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS must be > 0.")
        if self.youtube_transcript_proxy_retries_when_blocked < 0:
            raise ValueError("YOUTUBE_TRANSCRIPT_PROXY_RETRIES_WHEN_BLOCKED must be >= 0.")
        if self.x_api_timeout_seconds <= 0:
            raise ValueError("X_API_TIMEOUT_SECONDS must be > 0.")
        if self.x_api_author_thread_max_posts < 1:
            raise ValueError("X_API_AUTHOR_THREAD_MAX_POSTS must be >= 1.")
        if self.real_media_provider_fixtures:
            if self.nexus_env in (Environment.STAGING, Environment.PROD):
                raise ValueError("REAL_MEDIA_PROVIDER_FIXTURES is not allowed in staging or prod.")
            if not self.real_media_fixture_dir:
                raise ValueError("REAL_MEDIA_FIXTURE_DIR is required when fixtures are enabled.")
        if self.nexus_env in (Environment.STAGING, Environment.PROD) and self.billing_enabled:
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
        if self.nexus_env in (Environment.STAGING, Environment.PROD) and self.email_ingest_enabled:
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
        if self.podcasts_enabled:
            missing_podcast_provider_settings: list[str] = []
            if not self.podcast_index_api_key:
                missing_podcast_provider_settings.append("PODCAST_INDEX_API_KEY")
            if not self.podcast_index_api_secret:
                missing_podcast_provider_settings.append("PODCAST_INDEX_API_SECRET")
            if missing_podcast_provider_settings and not self.real_media_provider_fixtures:
                if self.nexus_env in (Environment.STAGING, Environment.PROD):
                    raise ValueError(
                        "Podcast features are enabled but provider credentials are missing: "
                        f"{', '.join(missing_podcast_provider_settings)}"
                    )
                else:
                    import logging

                    logging.getLogger(__name__).warning(
                        "Podcast features auto-disabled: missing %s. "
                        "Set PODCASTS_ENABLED=false or provide credentials to silence this warning.",
                        ", ".join(missing_podcast_provider_settings),
                    )
                    self.podcasts_enabled = False
        if self.nexus_env in (Environment.STAGING, Environment.PROD):
            if not self.youtube_data_api_key:
                raise ValueError(
                    "Browse providers are missing required credentials: YOUTUBE_DATA_API_KEY"
                )

        if self.nexus_env in (Environment.STAGING, Environment.PROD):
            missing_llm_keys: list[str] = []
            if not self.openai_api_key:
                missing_llm_keys.append("OPENAI_API_KEY")
            if not self.anthropic_api_key:
                missing_llm_keys.append("ANTHROPIC_API_KEY")
            if not self.gemini_api_key:
                missing_llm_keys.append("GEMINI_API_KEY")
            if not self.moonshot_api_key:
                missing_llm_keys.append("MOONSHOT_API_KEY")
            if missing_llm_keys:
                raise ValueError(
                    "Platform LLM provider keys are required in staging/prod: "
                    f"{', '.join(missing_llm_keys)}"
                )
            if not self.nexus_fable_retention_accepted_at:
                raise ValueError(
                    "NEXUS_FABLE_RETENTION_ACCEPTED_AT is required for "
                    f"NEXUS_ENV={self.nexus_env.value}: Fable requires 30-day retention "
                    "and is not ZDR-eligible, so a deploy must explicitly record (RFC "
                    "3339) when that tradeoff was accepted."
                )
            try:
                datetime.fromisoformat(self.nexus_fable_retention_accepted_at)
            except ValueError as exc:
                raise ValueError(
                    "NEXUS_FABLE_RETENTION_ACCEPTED_AT must be an RFC 3339 timestamp, "
                    f"got {self.nexus_fable_retention_accepted_at!r}"
                ) from exc
        if self.ingest_reconcile_schedule_seconds < 0:
            raise ValueError("INGEST_RECONCILE_SCHEDULE_SECONDS must be >= 0.")
        if self.ingest_stale_extracting_seconds < 1:
            raise ValueError("INGEST_STALE_EXTRACTING_SECONDS must be >= 1.")
        if self.ingest_stale_requeue_max_attempts < 1:
            raise ValueError("INGEST_STALE_REQUEUE_MAX_ATTEMPTS must be >= 1.")
        if self.ingest_semantic_repair_batch_limit < 1:
            raise ValueError("INGEST_SEMANTIC_REPAIR_BATCH_LIMIT must be >= 1.")
        if self.ingest_semantic_failed_retry_seconds < 1:
            raise ValueError("INGEST_SEMANTIC_FAILED_RETRY_SECONDS must be >= 1.")
        if not any(value.strip() for value in self.worker_allowed_job_kinds.split(",")):
            raise ValueError("WORKER_ALLOWED_JOB_KINDS must contain at least one job kind.")
        if self.worker_poll_interval_seconds <= 0:
            raise ValueError("WORKER_POLL_INTERVAL_SECONDS must be > 0.")
        if self.worker_idle_backoff_max_seconds < self.worker_poll_interval_seconds:
            raise ValueError(
                "WORKER_IDLE_BACKOFF_MAX_SECONDS must be >= WORKER_POLL_INTERVAL_SECONDS."
            )
        if self.worker_scheduler_interval_seconds <= 0:
            raise ValueError("WORKER_SCHEDULER_INTERVAL_SECONDS must be > 0.")
        if self.worker_heartbeat_interval_seconds <= 0:
            raise ValueError("WORKER_HEARTBEAT_INTERVAL_SECONDS must be > 0.")
        if self.worker_lease_seconds < 1:
            raise ValueError("WORKER_LEASE_SECONDS must be >= 1.")
        if self.worker_db_failure_backoff_seconds <= 0:
            raise ValueError("WORKER_DB_FAILURE_BACKOFF_SECONDS must be > 0.")
        if self.worker_db_failure_backoff_max_seconds < self.worker_db_failure_backoff_seconds:
            raise ValueError(
                "WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS must be >= "
                "WORKER_DB_FAILURE_BACKOFF_SECONDS."
            )
        if self.sync_gutenberg_catalog_schedule_seconds < 0:
            raise ValueError("SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS must be >= 0.")
        if self.background_job_prune_schedule_seconds < 0:
            raise ValueError("BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS must be >= 0.")
        if self.atlas_project_schedule_seconds < 0:
            raise ValueError("ATLAS_PROJECT_SCHEDULE_SECONDS must be >= 0.")
        if self.background_job_prune_succeeded_after_days < 1:
            raise ValueError("BACKGROUND_JOB_PRUNE_SUCCEEDED_AFTER_DAYS must be >= 1.")
        if self.background_job_prune_dead_after_days < 1:
            raise ValueError("BACKGROUND_JOB_PRUNE_DEAD_AFTER_DAYS must be >= 1.")
        if self.background_job_prune_batch_size < 1:
            raise ValueError("BACKGROUND_JOB_PRUNE_BATCH_SIZE must be >= 1.")

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


@lru_cache
def get_settings() -> Settings:
    """Get cached application settings.

    Returns:
        Settings instance loaded from environment.

    Raises:
        ValidationError: If required settings are missing or invalid.
    """
    return Settings()  # pyright: ignore[reportCallIssue] - BaseSettings reads env.


def real_media_provider_fixtures_requested() -> bool:
    return os.environ.get("REAL_MEDIA_PROVIDER_FIXTURES") in {"1", "true", "True"}


def clear_settings_cache() -> None:
    """Clear the settings cache. Useful for testing."""
    get_settings.cache_clear()
