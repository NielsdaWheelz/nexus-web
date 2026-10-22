"""Chapter observations and independent bounded sidecar retrieval.

The media lock owns source, freshness and exact queue identity. Changed sources and
inline observations supersede earlier jobs, including a→b→a. Failed retrieval keeps
published rows; an exact dead letter releases ownership for a later observation.
Workers lock queue→media and fetch outside transactions. No permanent queue dedupe.
"""

import json
import math
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urljoin
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import JobExecutionContext, JobResult, enqueue_job, lock_running_job_claim
from nexus.services.net.safe_fetch import safe_get
from nexus.services.suggestion_changes import record_input_change
from nexus.services.url_normalize import validate_requested_url

JOB_KIND = "podcast_chapters"
_MAX_BYTES = 2 * 1024 * 1024
_CLOCK = re.compile(r"^(?:(?P<h>\d+):)?(?P<m>[0-5]?\d):(?P<s>[0-5]?\d(?:\.\d+)?)$")


def parse_rows(entries: list[dict[str, Any]], *, source: str, base: str) -> list[dict[str, Any]]:
    """Accept supported publisher chapter fields; malformed individual rows are omitted."""
    rows = []
    for entry in entries:
        title = str(entry.get("title") or "").strip()
        start = _clock_ms(_first(entry, "startTime", "start_time", "start"))
        if not title or start is None:
            continue
        end = _clock_ms(_first(entry, "endTime", "end_time", "end"))
        rows.append(
            {
                "title": title,
                "t_start_ms": start,
                "t_end_ms": end if end is not None and end >= start else None,
                "url": _link(_first(entry, "url", "href"), base),
                "image_url": _link(_first(entry, "img", "image", "image_url"), base),
                "source": source,
            }
        )
    return sorted(rows, key=lambda row: row["t_start_ms"])


def observe(
    db: Session,
    *,
    media_id: UUID,
    inline: list[dict[str, Any]] | None,
    source_url: str | None,
) -> None:
    """Apply a feed observation under its already-held media lock; absence preserves."""
    if inline is not None:
        replace_rows(db, media_id=media_id, rows=inline)
        db.execute(
            text("""
            UPDATE podcast_episodes SET chapters_source_url=NULL,
                chapters_fetched_at=NULL, chapters_job_id=NULL WHERE media_id=:id
        """),
            {"id": media_id},
        )
        return
    if source_url is None:
        return
    row = db.execute(
        text("""
        SELECT chapters_source_url, chapters_job_id,
            chapters_fetched_at IS NULL OR chapters_fetched_at <= now()-interval '24 hours' AS due
        FROM podcast_episodes WHERE media_id=:id
    """),
        {"id": media_id},
    ).one()
    changed = row.chapters_source_url != source_url
    if changed:
        db.execute(
            text("""
            UPDATE podcast_episodes SET chapters_source_url=:url,
                chapters_fetched_at=NULL, chapters_job_id=NULL WHERE media_id=:id
        """),
            {"id": media_id, "url": source_url},
        )
    if changed or (row.due and row.chapters_job_id is None):
        job = enqueue_job(
            db,
            kind=JOB_KIND,
            payload={"media_id": str(media_id), "expected_source_url": source_url},
        )
        db.execute(
            text("UPDATE podcast_episodes SET chapters_job_id=:job_id WHERE media_id=:id"),
            {"id": media_id, "job_id": job.id},
        )


def replace_rows(db: Session, *, media_id: UUID, rows: list[dict[str, Any]]) -> None:
    """Replace published rows, including a successful empty result, under the media lock."""
    db.execute(text("DELETE FROM podcast_episode_chapters WHERE media_id=:id"), {"id": media_id})
    unique: dict[tuple[int, str], dict[str, Any]] = {}
    for row in rows:
        unique.setdefault((row["t_start_ms"], row["title"].lower()), row)
    if unique:
        db.execute(
            text("""
            INSERT INTO podcast_episode_chapters
                (media_id,chapter_idx,title,t_start_ms,t_end_ms,url,image_url,source)
            VALUES (:media_id,:idx,:title,:t_start_ms,:t_end_ms,:url,:image_url,:source)
        """),
            [row | {"media_id": media_id, "idx": i} for i, row in enumerate(unique.values())],
        )


def _lock_owner(db: Session, *, context: JobExecutionContext, media_id: UUID, url: str) -> bool:
    if lock_running_job_claim(db, context=context) is None:
        return False
    row = db.execute(
        text("""
        SELECT pe.chapters_job_id, pe.chapters_source_url
        FROM media m JOIN podcast_episodes pe ON pe.media_id=m.id
        WHERE m.id=:id FOR UPDATE OF m
    """),
        {"id": media_id},
    ).first()
    return (
        row is not None and row.chapters_job_id == context.job_id and row.chapters_source_url == url
    )


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """Fetch outside transactions, then publish only this execution's exact source/job."""
    media_id, url = UUID(str(payload["media_id"])), str(payload["expected_source_url"])
    with get_session_factory()() as db:
        with transaction(db):
            if not _lock_owner(db, context=context, media_id=media_id, url=url):
                return {"status": "Stale"}
        result = safe_get(url, max_bytes=_MAX_BYTES, timeout_s=15.0)
        try:
            value = json.loads(result.content)
            entries = value.get("chapters") if isinstance(value, dict) else value
            if not isinstance(entries, list):
                raise ValueError("Chapter response must contain an array")
            rows = parse_rows(
                [entry for entry in entries if isinstance(entry, dict)],
                source="rss_podcasting20",
                base=result.final_url,
            )
        except ValueError as exc:
            raise ApiError(
                ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE, "Podcast chapters are unavailable"
            ) from exc
        with transaction(db):
            if not _lock_owner(db, context=context, media_id=media_id, url=url):
                return {"status": "Stale"}
            replace_rows(db, media_id=media_id, rows=rows)
            db.execute(
                text("""
                UPDATE podcast_episodes SET chapters_fetched_at=now(),chapters_job_id=NULL
                WHERE media_id=:id
            """),
                {"id": media_id},
            )
            record_input_change(db)
            return {"status": "Complete"}


def _first(entry: dict[str, Any], *names: str) -> Any:
    return next((entry[name] for name in names if entry.get(name) is not None), None)


def _link(raw: Any, base: str) -> str | None:
    value = str(raw).strip() if raw is not None else ""
    if not value:
        return None
    url = urljoin(base, value)
    try:
        validate_requested_url(url)
    except InvalidRequestError:
        return None
    return url


def _clock_ms(raw: Any) -> int | None:
    value = str(raw).strip() if raw is not None else ""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        match = _CLOCK.match(value)
        if match is None:
            return None
        seconds = int(match["h"] or 0) * 3600 + int(match["m"]) * 60 + float(match["s"])
    # The published chapter offsets are PostgreSQL integer milliseconds.
    return (
        math.floor(seconds * 1000)
        if math.isfinite(seconds) and 0 <= seconds <= 2_147_483.647
        else None
    )
