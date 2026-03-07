"""Celery tasks for Nexus.

Tasks are explicitly imported here to register them with Celery.
No autodiscovery - all tasks must be imported in this module.

Usage in worker:
    from nexus.tasks import ingest_web_article

Usage in API (enqueue):
    from nexus.tasks import ingest_web_article
    ingest_web_article.apply_async(
        args=[media_id, actor_user_id],
        kwargs={"request_id": request_id},
        queue="ingest"
    )
"""

import nexus.tasks.ingest_pdf as ingest_pdf  # noqa: F401
from nexus.tasks.backfill_default_library_closure import backfill_default_library_closure_job
from nexus.tasks.enrich_metadata import enrich_metadata
from nexus.tasks.ingest_epub import ingest_epub
from nexus.tasks.ingest_web_article import ingest_web_article
from nexus.tasks.ingest_youtube_video import ingest_youtube_video
from nexus.tasks.podcast_active_subscription_poll import podcast_active_subscription_poll_job
from nexus.tasks.podcast_sync_subscription import podcast_sync_subscription_job
from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job
from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

__all__ = [
    "ingest_web_article",
    "ingest_epub",
    "ingest_pdf",
    "ingest_youtube_video",
    "enrich_metadata",
    "backfill_default_library_closure_job",
    "podcast_active_subscription_poll_job",
    "podcast_sync_subscription_job",
    "podcast_transcribe_episode_job",
    "reconcile_stale_ingest_media_job",
]
