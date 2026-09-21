"""The durable three-phase document content reindex job."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext
from nexus.services.content_indexing import (
    MEDIA_CONTENT_REINDEX_JOB_KIND,
    MEDIA_CONTENT_REINDEX_REASONS,
    IndexOwner,
    build_spooled_content_index_plan,
    prepare_media_content_reindex,
    publish_media_content_reindex,
)
from nexus.services.parser_temp import parser_attempt_directory
from nexus.services.semantic_chunks import build_text_embeddings


def media_content_reindex_job(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> dict[str, object]:
    """Fence and snapshot, embed through a local spool, then fence and publish."""
    from nexus.jobs.registry import get_default_registry

    media_id, revision, reason = _parse_payload(payload)
    lease_seconds = get_default_registry()[MEDIA_CONTENT_REINDEX_JOB_KIND].lease_seconds
    superseded = {"status": "superseded", "media_id": str(media_id), "revision": revision}

    prepare_db = get_session_factory()()
    try:

        def prepare():
            work = prepare_media_content_reindex(
                prepare_db,
                media_id=media_id,
                revision=revision,
                reason=reason,
                context=context,
                lease_seconds=lease_seconds,
            )
            prepare_db.commit()
            return work

        work = retry_serializable(prepare_db, "prepare_media_content_reindex", prepare)
    finally:
        prepare_db.close()
    if work is None:
        return superseded

    with parser_attempt_directory(context.job_id) as attempt_directory:
        plan = build_spooled_content_index_plan(
            owner=work.blocks[0].owner if work.blocks else IndexOwner("media", media_id),
            source_kind=work.source_kind,
            blocks=work.blocks,
            spool_path=attempt_directory / "content-index.jsonl",
            embed_texts=build_text_embeddings,
        )
        publish_db = get_session_factory()()
        try:

            def publish():
                published = publish_media_content_reindex(
                    publish_db,
                    work=work,
                    plan=plan,
                    context=context,
                    lease_seconds=lease_seconds,
                )
                publish_db.commit()
                return published

            result = retry_serializable(publish_db, "publish_media_content_reindex", publish)
        finally:
            publish_db.close()

    if result is None:
        return superseded
    return {**superseded, "status": result.status, "chunk_count": result.chunk_count}


def _parse_payload(payload: Mapping[str, Any]) -> tuple[UUID, int, str]:
    """The payload is the durable resume point: exactly four keys, all checked."""
    if set(payload) != {"media_id", "revision", "reason", "request_id"}:
        raise ValueError("media content-reindex payload keys are invalid")
    try:
        media_id = UUID(str(payload["media_id"]))
    except (TypeError, ValueError):
        raise ValueError("media content-reindex media_id is invalid") from None

    revision = payload["revision"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError("media content-reindex revision is invalid")
    reason = payload["reason"]
    if not isinstance(reason, str) or reason not in MEDIA_CONTENT_REINDEX_REASONS:
        raise ValueError("media content-reindex reason is invalid")

    request_id = payload["request_id"]
    if not isinstance(request_id, Mapping):
        raise ValueError("media content-reindex request_id Presence is invalid")
    if request_id.get("kind") == "Absent":
        if set(request_id) != {"kind"}:
            raise ValueError("Absent request_id Presence is invalid")
    elif request_id.get("kind") == "Present":
        if (
            set(request_id) != {"kind", "value"}
            or not isinstance(request_id.get("value"), str)
            or not request_id["value"]
        ):
            raise ValueError("Present request_id Presence is invalid")
    else:
        raise ValueError("media content-reindex request_id Presence tag is invalid")
    return media_id, revision, reason
