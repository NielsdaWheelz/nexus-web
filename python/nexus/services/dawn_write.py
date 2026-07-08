"""Dawn write generation service.

Assembles three content signals (yesterday's highlights, overnight Synapse
resonances, stale library dossiers) and generates a two-paragraph machine
morning brief for the user's daily note page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from provider_runtime.types import ModelCall, ModelMessage, ModelRef, ProviderName, ReasoningConfig
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import DawnWrite
from nexus.errors import ApiError
from nexus.llm_catalog import require_catalog_model
from nexus.logging import get_logger
from nexus.services.api_key_resolver import resolve_api_key
from nexus.services.library_intelligence import is_artifact_stale
from nexus.services.llm_ledger import LedgeredLLM, LlmCallOwner

logger = get_logger(__name__)

DAWN_WRITE_PROVIDER = "anthropic"
DAWN_WRITE_MODEL_NAME = "claude-haiku-4-5-20251001"
DAWN_WRITE_MAX_TOKENS = 300
DAWN_WRITE_TIMEOUT_SECONDS = 45

require_catalog_model(DAWN_WRITE_PROVIDER, DAWN_WRITE_MODEL_NAME)

_SYSTEM_PROMPT = """\
You are the dawn writer for a reading system. You have access to one user's
reading activity from yesterday. Write exactly two short paragraphs — no
headers, no lists, no markdown except paragraph breaks. Total ≤200 words.

Paragraph 1: what the reader engaged with yesterday — highlights made, their
text, the source titles. Be specific and concrete; quote brief phrases.

Paragraph 2: what the system noticed overnight — Synapse resonances (new
connections with rationales), stale library dossiers that need refresh.
If either category is empty, fold it into a single paragraph.

Rules:
1. Only state what the data contains. Do not invent, extrapolate, or recommend.
2. No "You highlighted…" preamble. Begin mid-sentence, as apparatus, not address.
3. No score, no rating, no count of items. Name things, not numbers.\
"""


@dataclass
class _HighlightSignal:
    exact: str
    media_title: str
    created_at: datetime


@dataclass
class _SynapseSignal:
    excerpt: str | None
    source_scheme: str
    target_scheme: str
    created_at: datetime


@dataclass
class _StaleLibrarySignal:
    name: str


@dataclass
class DawnWriteSignals:
    highlights: list[_HighlightSignal] = field(default_factory=list)
    synapse_edges: list[_SynapseSignal] = field(default_factory=list)
    stale_libraries: list[_StaleLibrarySignal] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.highlights and not self.synapse_edges and not self.stale_libraries


def _tz_midnight_utc(local_date: date, tz_name: str) -> datetime:
    """Return the UTC instant corresponding to midnight on *local_date* in *tz_name*.

    Falls back to UTC when the timezone name is unknown to the system.
    """
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
    local_midnight = datetime(local_date.year, local_date.month, local_date.day, tzinfo=tz)
    return local_midnight.astimezone(UTC)


def collect_signals(
    db: Session, *, user_id: UUID, local_date: date, tz: str
) -> DawnWriteSignals | None:
    """Query the three content signals for *user_id* relative to *local_date*.

    Returns None when all signals are empty (skip-generation sentinel).
    """
    today_utc = _tz_midnight_utc(local_date, tz)
    yesterday_utc = today_utc - timedelta(days=1)

    # Signal A — yesterday's highlights.
    highlight_rows = db.execute(
        text(
            "SELECT h.exact, m.title AS media_title, h.created_at"
            " FROM highlights h"
            " JOIN media m ON m.id = h.anchor_media_id"
            " WHERE h.user_id = :uid"
            "   AND h.anchor_media_id IS NOT NULL"
            "   AND h.created_at >= :yesterday_start_utc"
            "   AND h.created_at <  :today_start_utc"
            " ORDER BY h.created_at"
            " LIMIT 10"
        ),
        {"uid": str(user_id), "yesterday_start_utc": yesterday_utc, "today_start_utc": today_utc},
    ).fetchall()

    highlights = [
        _HighlightSignal(exact=row.exact, media_title=row.media_title, created_at=row.created_at)
        for row in highlight_rows
    ]

    # Signal B — overnight Synapse resonances (last 24 h).
    synapse_rows = db.execute(
        text(
            "SELECT re.snapshot, re.source_scheme, re.target_scheme, re.created_at"
            " FROM resource_edges re"
            " WHERE re.user_id = :uid"
            "   AND re.origin = 'synapse'"
            "   AND re.created_at >= :yesterday_start_utc"
            " ORDER BY re.created_at DESC"
            " LIMIT 5"
        ),
        {"uid": str(user_id), "yesterday_start_utc": yesterday_utc},
    ).fetchall()

    synapse_edges = [
        _SynapseSignal(
            excerpt=(row.snapshot or {}).get("excerpt") if row.snapshot else None,
            source_scheme=row.source_scheme,
            target_scheme=row.target_scheme,
            created_at=row.created_at,
        )
        for row in synapse_rows
    ]

    # Signal C — stale library dossiers.
    stale_rows = db.execute(
        text(
            "SELECT lib.name, art.id AS artifact_id, art.library_id, rev.id AS revision_id"
            " FROM library_intelligence_artifacts art"
            " JOIN libraries lib ON lib.id = art.library_id"
            " JOIN library_intelligence_artifact_revisions rev"
            "   ON rev.id = art.current_revision_id"
            " WHERE art.user_id = :uid"
            "   AND rev.status = 'ready'"
            "   AND rev.promoted_at IS NOT NULL"
        ),
        {"uid": str(user_id)},
    ).fetchall()

    stale_libraries = [
        _StaleLibrarySignal(name=row.name)
        for row in stale_rows
        if is_artifact_stale(db, library_id=row.library_id, current_revision_id=row.revision_id)
    ]

    signals = DawnWriteSignals(
        highlights=highlights,
        synapse_edges=synapse_edges,
        stale_libraries=stale_libraries,
    )
    return None if signals.is_empty else signals


def _render_signals(signals: DawnWriteSignals) -> str:
    """Render the three signal categories as plain text for the model user turn."""
    parts: list[str] = []

    if signals.highlights:
        lines = ["HIGHLIGHTS FROM YESTERDAY:"]
        for h in signals.highlights:
            lines.append(f'  "{h.exact}" — {h.media_title}')
        parts.append("\n".join(lines))

    if signals.synapse_edges:
        lines = ["SYNAPSE RESONANCES (overnight):"]
        for e in signals.synapse_edges:
            excerpt = e.excerpt or "(no rationale)"
            lines.append(f"  {e.source_scheme} ↔ {e.target_scheme}: {excerpt}")
        parts.append("\n".join(lines))

    if signals.stale_libraries:
        lines = ["STALE LIBRARY DOSSIERS:"]
        for lib in signals.stale_libraries:
            lines.append(f"  {lib.name}")
        parts.append("\n".join(lines))

    return "\n\n".join(parts)


def _build_request(user_content: str) -> ModelCall:
    return ModelCall(
        model=ModelRef(
            provider=cast(ProviderName, DAWN_WRITE_PROVIDER),
            model=DAWN_WRITE_MODEL_NAME,
        ),
        messages=[
            ModelMessage(role="system", content=_SYSTEM_PROMPT, cache_ttl="5m"),
            ModelMessage(role="user", content=user_content, cache_ttl="none"),
        ],
        max_output_tokens=DAWN_WRITE_MAX_TOKENS,
        reasoning=ReasoningConfig(effort="none"),
    )


async def generate_dawn_write(
    db: Session,
    *,
    user_id: UUID,
    local_date: date,
    tz: str,
    llm: ModelRuntime,
) -> DawnWrite | None:
    """Generate and persist a dawn write for *user_id* on *local_date*.

    Returns None when signals are empty (nothing to say) or when no API key
    is available. Callers must check for an existing row before calling.
    """
    settings = get_settings()
    if not settings.dawn_write_enabled:
        logger.info("dawn_write_skipped", reason="disabled", user_id=str(user_id))
        return None

    signals = collect_signals(db, user_id=user_id, local_date=local_date, tz=tz)
    if signals is None:
        logger.info("dawn_write_skipped", reason="no_signals", user_id=str(user_id))
        return None

    try:
        resolved_key = resolve_api_key(db, user_id, DAWN_WRITE_PROVIDER, "auto")
    except (ApiError, ModelCallError) as exc:
        logger.info(
            "dawn_write_skipped",
            reason="no_api_key",
            user_id=str(user_id),
            error=str(exc),
        )
        return None

    user_content = _render_signals(signals)
    request = _build_request(user_content)

    # Pre-generate the row id so the ledger owner can reference it before the
    # row is inserted.  llm_calls.owner_id has no FK so the forward reference
    # is safe.
    row_id = uuid4()

    try:
        response = await LedgeredLLM(
            db=db,
            owner=LlmCallOwner(kind="dawn_write", id=row_id),
            router=llm,
            llm_operation="dawn_write",
            key_mode_requested="auto",
            key_mode_used=resolved_key.mode,
        ).generate(request, key=resolved_key.api_key, timeout_s=DAWN_WRITE_TIMEOUT_SECONDS)
    except (ApiError, ModelCallError) as exc:
        logger.warning("dawn_write_llm_failure", user_id=str(user_id), error=str(exc))
        return None

    body = response.text.strip()
    if not body:
        logger.warning("dawn_write_empty_response", user_id=str(user_id))
        return None

    row = DawnWrite(id=row_id, user_id=user_id, local_date=local_date, body_md=body)
    db.add(row)
    db.commit()
    logger.info(
        "dawn_write_generated",
        user_id=str(user_id),
        local_date=str(local_date),
        write_id=str(row.id),
    )
    return row
