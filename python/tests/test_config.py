"""Tests for application configuration."""

import pytest
from pydantic import ValidationError

from nexus.config import Settings

pytestmark = pytest.mark.unit

_REQUIRED_R2_SETTINGS = {
    "R2_S3_API_ORIGIN": "https://abc123.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "r2-access",
    "R2_SECRET_ACCESS_KEY": "r2-secret",
    "R2_BUCKET": "media",
    "R2_REGION": "auto",
}


def _make_settings(**overrides) -> Settings:
    """Build a Settings instance with test defaults + overrides."""
    defaults = {
        "DATABASE_URL": "postgresql+psycopg://localhost/test",
        "NEXUS_ENV": "test",
        "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
        "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
        "SUPABASE_AUDIENCES": "authenticated",
        "APP_PUBLIC_URL": "http://localhost:3000",
        "STRIPE_SECRET_KEY": "sk_test",
        "STRIPE_WEBHOOK_SECRET": "whsec_test",
        "STRIPE_PLUS_PRICE_ID": "price_plus",
        "STRIPE_AI_PLUS_PRICE_ID": "price_ai_plus",
        "STRIPE_AI_PRO_PRICE_ID": "price_ai_pro",
        "PODCASTS_ENABLED": True,
        "PODCAST_INDEX_API_KEY": "test-key",
        "PODCAST_INDEX_API_SECRET": "test-secret",
        "YOUTUBE_DATA_API_KEY": "test-youtube-key",
        "X_API_BEARER_TOKEN": "test-x-token",
    }
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults)


def _make_deploy_settings(**overrides) -> Settings:
    values = {
        "NEXUS_ENV": "staging",
        "NEXUS_INTERNAL_SECRET": "secret",
        **_REQUIRED_R2_SETTINGS,
    }
    values.update(overrides)
    return _make_settings(**values)


class TestEpubArchiveSafetyConfigGuardrails:
    def test_defaults_match_archive_safety_ceilings(self):
        s = _make_settings()
        assert s.max_epub_archive_entries == 10_000
        assert s.max_epub_archive_total_uncompressed_bytes == 536_870_912
        assert s.max_epub_archive_single_entry_uncompressed_bytes == 67_108_864
        assert s.max_epub_archive_compression_ratio == 100
        assert s.max_epub_archive_parse_time_ms == 30_000

    def test_stricter_overrides_accepted(self):
        s = _make_settings(
            MAX_EPUB_ARCHIVE_ENTRIES=5000,
            MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES=268_435_456,
            MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES=33_554_432,
            MAX_EPUB_ARCHIVE_COMPRESSION_RATIO=50,
            MAX_EPUB_ARCHIVE_PARSE_TIME_MS=15_000,
        )
        assert s.max_epub_archive_entries == 5000
        assert s.max_epub_archive_total_uncompressed_bytes == 268_435_456
        assert s.max_epub_archive_single_entry_uncompressed_bytes == 33_554_432
        assert s.max_epub_archive_compression_ratio == 50
        assert s.max_epub_archive_parse_time_ms == 15_000

    def test_weaker_entries_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_ENTRIES"):
            _make_settings(MAX_EPUB_ARCHIVE_ENTRIES=20_000)

    def test_weaker_total_bytes_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES"):
            _make_settings(MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES=1_000_000_000)

    def test_weaker_single_entry_rejected(self):
        with pytest.raises(
            ValidationError, match="MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES"
        ):
            _make_settings(MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES=100_000_000)

    def test_weaker_compression_ratio_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_COMPRESSION_RATIO"):
            _make_settings(MAX_EPUB_ARCHIVE_COMPRESSION_RATIO=200)

    def test_weaker_parse_time_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_PARSE_TIME_MS"):
            _make_settings(MAX_EPUB_ARCHIVE_PARSE_TIME_MS=60_000)

    def test_zero_value_rejected(self):
        with pytest.raises(ValidationError, match="must be >= 1"):
            _make_settings(MAX_EPUB_ARCHIVE_ENTRIES=0)


class TestPodcastProviderConfiguration:
    def test_staging_requires_podcast_index_credentials(self):
        with pytest.raises(ValidationError, match="PODCAST_INDEX_API_KEY"):
            _make_deploy_settings(
                PODCASTS_ENABLED=True,
                PODCAST_INDEX_API_KEY="",
                PODCAST_INDEX_API_SECRET="",
            )

    def test_local_auto_disables_without_credentials(self):
        settings = _make_settings(
            NEXUS_ENV="local",
            PODCASTS_ENABLED=True,
            PODCAST_INDEX_API_KEY="",
            PODCAST_INDEX_API_SECRET="",
        )
        assert settings.podcasts_enabled is False

    def test_fixture_mode_allows_missing_podcast_index_credentials(self):
        settings = _make_settings(
            PODCASTS_ENABLED=True,
            REAL_MEDIA_PROVIDER_FIXTURES=True,
            REAL_MEDIA_FIXTURE_DIR="/tmp/nexus-fixtures",
            PODCAST_INDEX_API_KEY="",
            PODCAST_INDEX_API_SECRET="",
        )
        assert settings.podcasts_enabled is True

    def test_podcasts_enabled_accepts_valid_podcast_index_credentials(self):
        settings = _make_settings(
            PODCASTS_ENABLED=True,
            PODCAST_INDEX_API_KEY="key",
            PODCAST_INDEX_API_SECRET="secret",
        )
        assert settings.podcasts_enabled is True
        assert settings.podcast_index_api_key == "key"
        assert settings.podcast_index_api_secret == "secret"

    def test_podcasts_disabled_allows_missing_podcast_index_credentials(self):
        settings = _make_settings(
            PODCASTS_ENABLED=False,
            PODCAST_INDEX_API_KEY=None,
            PODCAST_INDEX_API_SECRET=None,
        )
        assert settings.podcasts_enabled is False
        assert settings.podcast_index_api_key is None
        assert settings.podcast_index_api_secret is None


class TestDatabasePoolConfiguration:
    def test_defaults_are_bounded_for_small_databases(self):
        settings = _make_settings()
        assert settings.database_pool_size == 10
        assert settings.database_max_overflow == 20
        assert settings.database_pool_timeout_seconds == 30.0

    def test_pool_can_be_capped_for_small_databases(self):
        settings = _make_settings(
            DATABASE_POOL_SIZE=2,
            DATABASE_MAX_OVERFLOW=0,
            DATABASE_POOL_TIMEOUT_SECONDS=10,
        )
        assert settings.database_pool_size == 2
        assert settings.database_max_overflow == 0
        assert settings.database_pool_timeout_seconds == 10.0

    def test_invalid_pool_values_rejected(self):
        with pytest.raises(ValidationError, match="DATABASE_POOL_SIZE"):
            _make_settings(DATABASE_POOL_SIZE=0)
        with pytest.raises(ValidationError, match="DATABASE_MAX_OVERFLOW"):
            _make_settings(DATABASE_MAX_OVERFLOW=-1)
        with pytest.raises(ValidationError, match="DATABASE_POOL_TIMEOUT_SECONDS"):
            _make_settings(DATABASE_POOL_TIMEOUT_SECONDS=0)


class TestWorkerMaintenanceConfiguration:
    def test_periodic_maintenance_schedules_default_disabled(self):
        settings = _make_settings()
        assert settings.podcast_active_poll_schedule_seconds == 0
        assert settings.ingest_reconcile_schedule_seconds == 0
        assert settings.sync_gutenberg_catalog_schedule_seconds == 0
        assert settings.background_job_prune_schedule_seconds == 0
        assert settings.worker_allowed_job_kinds == (
            "ingest_media_source,enrich_metadata,chat_run,"
            "library_intelligence_artifact_generate,media_unit_build,"
            "podcast_sync_subscription_job,podcast_reindex_semantic_job,"
            "backfill_default_library_closure_job,oracle_reading_generate"
        )

    def test_zero_schedule_values_are_valid_disabled_state(self):
        settings = _make_settings(
            PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS=0,
            INGEST_RECONCILE_SCHEDULE_SECONDS=0,
            SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS=0,
            BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS=0,
        )
        assert settings.podcast_active_poll_schedule_seconds == 0
        assert settings.ingest_reconcile_schedule_seconds == 0
        assert settings.sync_gutenberg_catalog_schedule_seconds == 0
        assert settings.background_job_prune_schedule_seconds == 0

    def test_negative_schedule_values_are_rejected(self):
        with pytest.raises(ValidationError, match="PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS"):
            _make_settings(PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS=-1)
        with pytest.raises(ValidationError, match="INGEST_RECONCILE_SCHEDULE_SECONDS"):
            _make_settings(INGEST_RECONCILE_SCHEDULE_SECONDS=-1)
        with pytest.raises(ValidationError, match="SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS"):
            _make_settings(SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS=-1)
        with pytest.raises(ValidationError, match="BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS"):
            _make_settings(BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS=-1)

    def test_worker_backoff_settings_are_validated(self):
        with pytest.raises(ValidationError, match="WORKER_ALLOWED_JOB_KINDS"):
            _make_settings(WORKER_ALLOWED_JOB_KINDS="")
        with pytest.raises(ValidationError, match="WORKER_IDLE_BACKOFF_MAX_SECONDS"):
            _make_settings(WORKER_POLL_INTERVAL_SECONDS=10, WORKER_IDLE_BACKOFF_MAX_SECONDS=5)
        with pytest.raises(ValidationError, match="WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS"):
            _make_settings(
                WORKER_DB_FAILURE_BACKOFF_SECONDS=60,
                WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS=30,
            )

    @pytest.mark.parametrize(
        ("setting_name", "invalid_value"),
        [
            ("WORKER_SCHEDULER_INTERVAL_SECONDS", 0),
            ("WORKER_HEARTBEAT_INTERVAL_SECONDS", 0),
            ("WORKER_LEASE_SECONDS", 0),
            ("BACKGROUND_JOB_PRUNE_SUCCEEDED_AFTER_DAYS", 0),
            ("BACKGROUND_JOB_PRUNE_DEAD_AFTER_DAYS", 0),
            ("BACKGROUND_JOB_PRUNE_BATCH_SIZE", 0),
        ],
    )
    def test_worker_runtime_numeric_guardrails_are_validated(
        self,
        setting_name: str,
        invalid_value: int,
    ):
        with pytest.raises(ValidationError, match=setting_name):
            _make_settings(**{setting_name: invalid_value})


class TestBrowseProviderConfiguration:
    def test_staging_requires_youtube_data_credentials(self):
        with pytest.raises(ValidationError, match="YOUTUBE_DATA_API_KEY"):
            _make_deploy_settings(
                YOUTUBE_DATA_API_KEY="",
            )

    def test_staging_requires_x_api_bearer_token(self):
        with pytest.raises(ValidationError, match="X_API_BEARER_TOKEN"):
            _make_deploy_settings(
                X_API_BEARER_TOKEN="",
            )

    def test_youtube_transcript_timeout_must_be_positive(self):
        with pytest.raises(ValidationError, match="YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS"):
            _make_settings(YOUTUBE_TRANSCRIPT_TIMEOUT_SECONDS=0)

    def test_x_api_timeout_must_be_positive(self):
        with pytest.raises(ValidationError, match="X_API_TIMEOUT_SECONDS"):
            _make_settings(X_API_TIMEOUT_SECONDS=0)

    def test_x_author_thread_max_posts_must_be_positive(self):
        with pytest.raises(ValidationError, match="X_API_AUTHOR_THREAD_MAX_POSTS"):
            _make_settings(X_API_AUTHOR_THREAD_MAX_POSTS=0)


class TestTranscriptEmbeddingConfiguration:
    def test_transcript_embedding_dimensions_must_match_schema_dimension(self):
        with pytest.raises(ValidationError, match="TRANSCRIPT_EMBEDDING_DIMENSIONS must equal 256"):
            _make_settings(TRANSCRIPT_EMBEDDING_DIMENSIONS=384)


class TestBillingConfiguration:
    def test_defaults_include_billing_limits(self):
        settings = _make_settings()
        assert settings.billing_enabled is True
        assert settings.app_public_url == "http://localhost:3000"
        assert settings.billing_ai_plus_platform_token_limit_monthly == 1_000_000
        assert settings.billing_ai_pro_platform_token_limit_monthly == 3_000_000
        assert settings.billing_ai_plus_transcription_minutes_monthly == 300
        assert settings.billing_ai_pro_transcription_minutes_monthly == 1200

    def test_staging_requires_stripe_settings(self):
        with pytest.raises(ValidationError, match="STRIPE_SECRET_KEY"):
            _make_deploy_settings(
                STRIPE_SECRET_KEY="",
                STRIPE_WEBHOOK_SECRET="",
                STRIPE_PLUS_PRICE_ID="",
                STRIPE_AI_PLUS_PRICE_ID="",
                STRIPE_AI_PRO_PRICE_ID="",
            )

    def test_staging_allows_missing_stripe_settings_when_billing_disabled(self):
        settings = _make_deploy_settings(
            BILLING_ENABLED=False,
            STRIPE_SECRET_KEY="",
            STRIPE_WEBHOOK_SECRET="",
            STRIPE_PLUS_PRICE_ID="",
            STRIPE_AI_PLUS_PRICE_ID="",
            STRIPE_AI_PRO_PRICE_ID="",
        )
        assert settings.billing_enabled is False


class TestR2StorageConfiguration:
    @pytest.mark.parametrize("env", ["staging", "prod"])
    @pytest.mark.parametrize(
        "setting_name",
        ["R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
    )
    def test_staging_and_prod_require_r2_settings(self, env: str, setting_name: str):
        values = {
            "NEXUS_ENV": env,
            "NEXUS_INTERNAL_SECRET": "secret",
            **_REQUIRED_R2_SETTINGS,
        }
        values[setting_name] = ""

        with pytest.raises(ValidationError, match=setting_name):
            _make_settings(**values)

    @pytest.mark.parametrize("env", ["staging", "prod"])
    def test_staging_and_prod_accept_complete_r2_settings(self, env: str):
        settings = _make_deploy_settings(NEXUS_ENV=env)

        assert settings.r2_s3_api_origin == "https://abc123.r2.cloudflarestorage.com"
        assert settings.r2_access_key_id == "r2-access"
        assert settings.r2_secret_access_key == "r2-secret"
        assert settings.r2_bucket == "media"
        assert settings.r2_region == "auto"

    @pytest.mark.parametrize(
        "database_url",
        [
            "postgresql+psycopg://postgres:secret@aws-1-us-west-1.pooler.supabase.com:6543/postgres",
            "postgresql+psycopg://postgres:secret@db.example.supabase.co:5432/postgres",
            "postgresql+psycopg://postgres:postgres@localhost:54322/postgres",
            "postgresql+psycopg://postgres:postgres@127.0.0.1:54322/postgres",
        ],
    )
    @pytest.mark.parametrize("env", ["local", "test", "staging", "prod"])
    def test_all_envs_reject_supabase_database_urls(self, database_url: str, env: str):
        values = {"NEXUS_ENV": env, "DATABASE_URL": database_url}
        if env in {"staging", "prod"}:
            values.update({"NEXUS_INTERNAL_SECRET": "secret", **_REQUIRED_R2_SETTINGS})

        with pytest.raises(ValidationError, match="Supabase Database"):
            _make_settings(**values)

    @pytest.mark.parametrize("env", ["staging", "prod"])
    @pytest.mark.parametrize(
        "endpoint",
        [
            "https://s3.example.com",
            "http://abc123.r2.cloudflarestorage.com",
            "https://abc123.r2.cloudflarestorage.com/prefix",
            "https://user:pass@abc123.r2.cloudflarestorage.com",
            "https://abc123.r2.cloudflarestorage.com?x=1",
            "https://abc123.r2.cloudflarestorage.com/#fragment",
        ],
    )
    def test_staging_and_prod_reject_invalid_r2_s3_api_origin(self, env: str, endpoint: str):
        with pytest.raises(ValidationError, match="Cloudflare R2 S3 API origin"):
            _make_deploy_settings(NEXUS_ENV=env, R2_S3_API_ORIGIN=endpoint)

    def test_rejects_removed_r2_endpoint_url_env(self):
        with pytest.raises(ValidationError, match="R2_ENDPOINT_URL"):
            _make_settings(R2_ENDPOINT_URL="https://abc123.r2.cloudflarestorage.com")

    def test_rejects_removed_csp_extra_connect_origins_env(self):
        with pytest.raises(ValidationError, match="CSP_EXTRA_CONNECT_ORIGINS"):
            _make_settings(CSP_EXTRA_CONNECT_ORIGINS="https://abc123.r2.cloudflarestorage.com")


class TestSupabaseServiceRoleConfiguration:
    @pytest.mark.parametrize(
        "setting_name",
        [
            "SUPABASE_SERVICE_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_AUTH_ADMIN_KEY",
            "SUPABASE_DATABASE_URL",
            "SERVICE_ROLE_KEY",
        ],
    )
    def test_service_role_keys_are_rejected_as_runtime_settings(self, setting_name: str):
        with pytest.raises(ValidationError, match="admin/database settings are not application"):
            _make_settings(**{setting_name: "service-role-secret"})

    def test_service_role_key_is_not_exposed_on_settings(self):
        settings = _make_settings()

        assert not hasattr(settings, "supabase_service_key")
