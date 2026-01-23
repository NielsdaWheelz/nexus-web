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

from nexus.tasks.ingest_web_article import ingest_web_article

__all__ = ["ingest_web_article"]
