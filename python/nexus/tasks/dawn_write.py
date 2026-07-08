"""Worker task: dawn write sweep — generate a morning brief for each user."""

from __future__ import annotations

from datetime import date
from uuid import UUID

import httpx
from provider_runtime import ModelRuntime
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import DawnWrite
from nexus.logging import get_logger
from nexus.services.dawn_write import generate_dawn_write
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task

logger = get_logger(__name__)

_SPEC = LlmTaskSpec(label="dawn_write_sweep", http_timeout_s=60.0)


def dawn_write_sweep() -> dict:
    """Periodic sweep: generate a dawn write for every user who has a timezone record."""

    async def _handler(db: Session, router: ModelRuntime, _client: httpx.AsyncClient) -> dict:
        settings = get_settings()
        if not settings.dawn_write_enabled:
            logger.info("dawn_write_sweep_skipped", reason="disabled")
            return {"skipped": 0, "generated": 0, "already_exists": 0}

        # Collect (user_id, most_recent_time_zone, current_local_date) for all
        # users who have ever opened a daily note page.
        tz_rows = db.execute(
            text(
                "SELECT DISTINCT ON (user_id) user_id, time_zone"
                " FROM daily_note_pages"
                " ORDER BY user_id, created_at DESC"
            )
        ).fetchall()

        skipped = 0
        generated = 0
        already_exists = 0

        for row in tz_rows:
            user_id: UUID = row.user_id
            tz: str = row.time_zone
            try:
                local_date = _local_date_for_tz(tz)
            except Exception:
                logger.warning("dawn_write_tz_parse_error", user_id=str(user_id), tz=tz)
                skipped += 1
                continue

            # Idempotency: skip if a row already exists for this user + date.
            existing = db.scalar(
                select(DawnWrite.id).where(
                    DawnWrite.user_id == user_id,
                    DawnWrite.local_date == local_date,
                )
            )
            if existing is not None:
                already_exists += 1
                continue

            try:
                result = await generate_dawn_write(
                    db,
                    user_id=user_id,
                    local_date=local_date,
                    tz=tz,
                    llm=router,
                )
                if result is not None:
                    generated += 1
                else:
                    skipped += 1
            except Exception:
                logger.exception(
                    "dawn_write_user_generation_failed",
                    user_id=str(user_id),
                    local_date=str(local_date),
                )
                skipped += 1

        logger.info(
            "dawn_write_sweep_complete",
            generated=generated,
            already_exists=already_exists,
            skipped=skipped,
        )
        return {"generated": generated, "already_exists": already_exists, "skipped": skipped}

    return run_llm_task(_SPEC, _handler)


def _local_date_for_tz(tz_name: str) -> date:
    """Return the current local date in *tz_name*."""
    from datetime import datetime
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
    return datetime.now(tz=tz).date()
