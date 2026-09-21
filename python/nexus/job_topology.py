"""Static worker-lane ownership without application-runtime imports."""

INTERACTIVE_WORKER_JOB_KINDS: tuple[str, ...] = (
    "chat_run",
    "dossier_build",
    "enrich_metadata",
    "podcast_sync_subscription_job",
    "oracle_reading_generate",
)
BACKGROUND_WORKER_JOB_KINDS: tuple[str, ...] = (
    "ingest_media_source",
    "media_content_reindex_job",
    "media_unit_build",
    "note_reindex_job",
    "podcast_backfill_subscription",
    "podcast_refresh_due_job",
    "podcast_reindex_semantic_job",
    "synapse_scan",
    "atlas_project_job",
    "media_teardown",
    "storage_object_cleanup",
    "storage_orphan_sweep",
    "reconcile_stale_ingest_media_job",
    "prune_background_jobs_job",
    "purge_expired_auth_handoff_codes",
)
PRODUCTION_ENABLED_JOB_KINDS: tuple[str, ...] = (
    INTERACTIVE_WORKER_JOB_KINDS + BACKGROUND_WORKER_JOB_KINDS
)
MAINTENANCE_JOB_KINDS: tuple[str, ...] = ("sync_gutenberg_catalog_job",)
ORACLE_RECONCILE_JOB_KINDS: tuple[str, ...] = (
    "ingest_media_source",
    "media_content_reindex_job",
)
