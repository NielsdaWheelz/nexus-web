"""Dawn write generation service.

Assembles three content signals (yesterday's highlights, overnight Synapse
resonances, stale library dossiers) and generates a two-paragraph machine
morning brief for the user's daily note page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from provider_runtime import (
    Dynamic,
    GenerateIntent,
    GlobalScope,
    PromptBlock,
    ProviderTarget,
    ReasoningLevel,
    Stable,
    Succeeded,
    SystemMessage,
    TextContent,
    TextOutput,
    UserMessage,
)
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import DawnWrite
from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.logging import get_logger
from nexus.services.artifacts.engine import is_artifact_stale
from nexus.services.llm_execution import ExecutionRuntime, GenerationRequest, execute_generation
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.structured_synthesis import outcome_failure_facts

logger = get_logger(__name__)

DAWN_WRITE_OPERATION = "dawn_write"
DAWN_WRITE_MAX_TOKENS = 300

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
            "SELECT lib.name, art.id AS artifact_id, art.subject_id AS library_id,"
            " rev.id AS revision_id"
            " FROM artifacts art"
            " JOIN libraries lib ON lib.id = art.subject_id"
            " JOIN artifact_revisions rev"
            "   ON rev.id = art.current_revision_id"
            " WHERE art.user_id = :uid"
            "   AND art.subject_scheme = 'library'"
            "   AND art.kind = 'library_dossier'"
            "   AND rev.status = 'ready'"
            "   AND rev.promoted_at IS NOT NULL"
        ),
        {"uid": str(user_id)},
    ).fetchall()

    stale_libraries = [
        _StaleLibrarySignal(name=row.name)
        for row in stale_rows
        if is_artifact_stale(
            db,
            subject_scheme="library",
            subject_id=row.library_id,
            kind="library_dossier",
            current_revision_id=row.revision_id,
        )
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


def _build_intent(
    *, target: ProviderTarget, reasoning: ReasoningLevel, user_content: str
) -> GenerateIntent:
    return GenerateIntent(
        target=target,
        messages=(
            SystemMessage(
                blocks=(PromptBlock(text=_SYSTEM_PROMPT, stability=Stable(GlobalScope())),)
            ),
            UserMessage(blocks=(PromptBlock(text=user_content, stability=Dynamic()),)),
        ),
        max_output_tokens=DAWN_WRITE_MAX_TOKENS,
        reasoning=reasoning,
        tools=(),
        tool_choice="none",
        output=TextOutput(),
    )


async def generate_dawn_write(
    db: Session,
    *,
    user_id: UUID,
    local_date: date,
    tz: str,
    runtime: ExecutionRuntime,
) -> DawnWrite | None:
    """Generate and persist a dawn write for *user_id* on *local_date*.

    Returns None when signals are empty (nothing to say), the platform
    entitlement/rate-limit rejects the call, or the provider call does not
    succeed. Callers must check for an existing row before calling.
    """
    settings = get_settings()
    if not settings.dawn_write_enabled:
        logger.info("dawn_write_skipped", reason="disabled", user_id=str(user_id))
        return None

    signals = collect_signals(db, user_id=user_id, local_date=local_date, tz=tz)
    if signals is None:
        logger.info("dawn_write_skipped", reason="no_signals", user_id=str(user_id))
        return None

    user_content = _render_signals(signals)

    # Pre-generate the row id so the ledger owner can reference it before the
    # row is inserted. llm_calls.owner_id has no FK so the forward reference
    # is safe.
    row_id = uuid4()
    profile = operation_profile(DAWN_WRITE_OPERATION)
    intent = _build_intent(
        target=profile.target,
        reasoning=profile.default_reasoning_option_id,
        user_content=user_content,
    )

    try:
        call = await execute_generation(
            GenerationRequest(
                owner=LlmCallOwner(kind="dawn_write", id=row_id, user_id=user_id),
                operation=DAWN_WRITE_OPERATION,
                profile=profile,
                reasoning=profile.default_reasoning_option_id,
                intent=intent,
            ),
            session_factory=get_session_factory(),
            runtime=runtime,
            settings=settings,
        )
    except ApiError as exc:
        logger.info(
            "dawn_write_skipped", reason="llm_rejected", user_id=str(user_id), error=str(exc)
        )
        return None

    if not isinstance(call.outcome, Succeeded):
        code, _detail = outcome_failure_facts(call.outcome)
        logger.warning("dawn_write_llm_failure", user_id=str(user_id), error_code=code)
        return None

    content = call.outcome.response.content
    if not isinstance(content, TextContent):
        # justify-defect: output=TextOutput plans output_kind="text", which the
        # runtime never promotes to StructuredContent.
        raise AssertionError("dawn write TextOutput outcome decoded as StructuredContent")
    body = content.text.strip()
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
