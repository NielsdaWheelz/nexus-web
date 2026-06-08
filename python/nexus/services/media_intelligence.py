"""Per-media intelligence units: the sole writer of media_summaries/media_claims.

A *media unit* is a reusable per-document summary plus a set of grounded claims,
each claim bound to an existing ``evidence_span``. Units are produced once per
content version (keyed on a content fingerprint), cached, and reused by the
library-intelligence reduce, ``app_search`` result cards, the reader, and the
library list.

**Grounding by construction (AC-2).** The build offers the model an ordered list
of candidate units (each content chunk plus its ``primary_evidence_span_id``) and
instructs it to cite a candidate only by integer index. After the call each
returned claim's ``candidate_index`` maps back to that candidate's
``evidence_span_id``; out-of-range indices are dropped. ``media_claims`` has a
NOT NULL ``evidence_span_id``, so an ungrounded claim is physically
unpersistable.

This service is permission-free; the on-demand route enforces ``can_read_media``
before calling ``ensure_media_unit``.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal, assert_never, cast
from uuid import UUID

from llm_calling.errors import LLMError
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, Turn
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.errors import is_serialization_failure
from nexus.db.session import use_serializable_if_available
from nexus.errors import NotFoundError
from nexus.jobs.queue import enqueue_unique_job
from nexus.logging import get_logger
from nexus.schemas.media import MediaSummarizeOut, MediaUnitStatus
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    SynthesisRequest,
    run_structured_synthesis,
)

logger = get_logger(__name__)

MEDIA_UNIT_MODEL_NAME = "claude-haiku-4-5-20251001"
MEDIA_UNIT_PROVIDER = "anthropic"
MEDIA_UNIT_MAX_OUTPUT_TOKENS = 2000
MEDIA_UNIT_LLM_TIMEOUT_SECONDS = 45
# Budget the candidate context to leave output headroom inside the model window.
# Approximated in characters (~4 chars/token); chunks past the budget are dropped
# with a warning rather than silently capped.
MEDIA_UNIT_INPUT_CHAR_BUDGET = 60_000

_SERIALIZABLE_RETRIES = 3


# ---------- public contract -------------------------------------------------


@dataclass(frozen=True)
class MediaUnitRef:
    """The find-or-create outcome of ``ensure_media_unit``."""

    media_id: UUID
    summary_id: UUID
    status: MediaUnitStatus
    content_fingerprint: str
    enqueued: bool


@dataclass(frozen=True)
class MediaClaimView:
    """One grounded claim in a ready unit."""

    claim_text: str
    evidence_span_id: UUID
    ordinal: int


@dataclass(frozen=True)
class MediaUnit:
    """A ready per-media unit: summary prose plus its grounded claims."""

    media_id: UUID
    summary_md: str
    model_name: str
    content_fingerprint: str
    claims: list[MediaClaimView]


class NotReady(Enum):
    """Why a unit cannot be returned as a :class:`MediaUnit`."""

    Missing = "missing"
    Building = "building"
    Failed = "failed"
    Stale = "stale"


def ensure_media_unit(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the current unit head and enqueue a build when needed.

    Standalone entry (the on-demand route): owns the SERIALIZABLE transaction +
    commit + bounded serialization retry. Idempotent on ``content_fingerprint``:
    a head already at the current fingerprint and in ('ready', 'building') is
    returned untouched (``enqueued=False``). Otherwise the head is (re)set to
    ``building`` at the new fingerprint, prior claims are cleared, and a deduped
    build job is enqueued.
    """
    for attempt in range(_SERIALIZABLE_RETRIES):
        use_serializable_if_available(db)
        try:
            ref = _ensure_media_unit_core(db, media_id=media_id)
            db.commit()
            return ref
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == _SERIALIZABLE_RETRIES - 1:
                raise
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError("ensure_media_unit retry loop exhausted")


def ensure_media_unit_in_tx(db: Session, *, media_id: UUID) -> MediaUnitRef:
    """Find-or-create the unit head inside the caller's open transaction.

    The ingest hook: flushes but does not commit and does not switch isolation,
    so the unit (re)build enqueue is committed atomically with the caller's
    content-index writes (per concurrency.md, do not widen/split a caller-owned
    transaction). The enqueue is a DB-only insert + ``pg_notify``.
    """
    return _ensure_media_unit_core(db, media_id=media_id)


def clear_media_claims_for_reindex(db: Session, *, media_id: UUID) -> None:
    """Delete this media's unit claims so its evidence spans can be re-extracted.

    Called by the content-index teardown (sole owner of the chunk/span lifecycle)
    inside its transaction, before it deletes the ``evidence_spans`` the claims
    reference (the FK is non-cascading). The summary head is left in place; the
    re-ingest hook re-points it to ``building`` at the new fingerprint.
    """
    db.execute(
        text(
            """
            DELETE FROM media_claims
            WHERE summary_id IN (
                SELECT id FROM media_summaries WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """Tear down this media's whole unit (claims then head) inside the caller's tx.

    The canonical unit teardown for media deletion: claims (child, FK the head and
    ``evidence_spans``) are deleted before the ``media_summaries`` head, and both
    must run before the ``media`` row and the media's ``evidence_spans`` go (both
    FKs are non-cascading per database.md). Idempotent: a no-op when no unit
    exists. The sole writer of these tables; media_deletion calls this rather than
    deleting the owned tables directly (cleanliness.md).
    """
    db.execute(
        text("DELETE FROM media_claims WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM media_summaries WHERE media_id = :media_id"),
        {"media_id": media_id},
    )


def _ensure_media_unit_core(db: Session, *, media_id: UUID) -> MediaUnitRef:
    fingerprint = _compute_content_fingerprint(db, media_id=media_id)
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )

    if summary is not None:
        summary_id = UUID(str(summary["id"]))
        if summary["content_fingerprint"] == fingerprint and summary["status"] in (
            "ready",
            "building",
        ):
            return MediaUnitRef(
                media_id=media_id,
                summary_id=summary_id,
                status=cast("MediaUnitStatus", summary["status"]),
                content_fingerprint=fingerprint,
                enqueued=False,
            )
        db.execute(
            text(
                """
                UPDATE media_summaries
                SET content_fingerprint = :fingerprint,
                    summary_md = '',
                    model_name = :model_name,
                    status = 'building',
                    updated_at = now()
                WHERE id = :summary_id
                """
            ),
            {
                "fingerprint": fingerprint,
                "model_name": MEDIA_UNIT_MODEL_NAME,
                "summary_id": summary_id,
            },
        )
        db.execute(
            text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
            {"summary_id": summary_id},
        )
    else:
        summary_id = db.execute(
            text(
                """
                INSERT INTO media_summaries (
                    media_id, content_fingerprint, summary_md, model_name, status
                )
                VALUES (:media_id, :fingerprint, '', :model_name, 'building')
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "fingerprint": fingerprint,
                "model_name": MEDIA_UNIT_MODEL_NAME,
            },
        ).scalar_one()
        summary_id = UUID(str(summary_id))

    dedupe_key = f"media_unit_build:{media_id}:{fingerprint}"
    # Drop any terminal/stale build row holding this dedupe_key so enqueue_unique_job
    # inserts a fresh runnable row. A unit failure completes its background_jobs row
    # as SUCCEEDED (or FAILED/DEAD), which would otherwise own the partial-unique key
    # and make enqueue_unique_job no-op, leaving the re-set 'building' head stuck.
    # No-op for the new-head branch (no prior row) and the changed-fingerprint case
    # (the old row's key differs). An in-flight build never reaches here: a head in
    # ('ready', 'building') at the current fingerprint short-circuits above.
    db.execute(
        text("DELETE FROM background_jobs WHERE dedupe_key = :k"),
        {"k": dedupe_key},
    )
    _, inserted = enqueue_unique_job(
        db,
        kind="media_unit_build",
        dedupe_key=dedupe_key,
        payload={"media_id": str(media_id)},
    )
    db.flush()
    return MediaUnitRef(
        media_id=media_id,
        summary_id=summary_id,
        status="building",
        content_fingerprint=fingerprint,
        enqueued=inserted,
    )


def get_media_unit(db: Session, *, media_id: UUID) -> MediaUnit | NotReady:
    """Return the ready unit, or a :class:`NotReady` reason. Permission-free."""
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if summary is None:
        return NotReady.Missing
    status = cast("MediaUnitStatus", summary["status"])
    if status == "building":
        return NotReady.Building
    if status == "failed":
        return NotReady.Failed
    if status != "ready":
        # The ck_media_summaries_status CHECK constrains status to these three.
        assert_never(status)
    current_fingerprint = _compute_content_fingerprint(db, media_id=media_id)
    if summary["content_fingerprint"] != current_fingerprint:
        return NotReady.Stale

    claim_rows = (
        db.execute(
            text(
                """
            SELECT claim_text, evidence_span_id, ordinal
            FROM media_claims
            WHERE summary_id = :summary_id
            ORDER BY ordinal
            """
            ),
            {"summary_id": summary["id"]},
        )
        .mappings()
        .all()
    )
    return MediaUnit(
        media_id=media_id,
        summary_md=str(summary["summary_md"]),
        model_name=str(summary["model_name"]),
        content_fingerprint=str(summary["content_fingerprint"]),
        claims=[
            MediaClaimView(
                claim_text=str(row["claim_text"]),
                evidence_span_id=UUID(str(row["evidence_span_id"])),
                ordinal=int(row["ordinal"]),
            )
            for row in claim_rows
        ],
    )


def get_ready_summaries(db: Session, *, media_ids: list[UUID]) -> dict[UUID, str]:
    """Batch read of fresh ready unit summaries, keyed by media id.

    The set-based read model for result-card enrichment: returns ``summary_md``
    only for media whose ``status='ready'`` head still matches the freshly
    recomputed content fingerprint, applying the same staleness gate as
    :func:`get_media_unit` so a re-ingested-but-not-yet-rebuilt unit is withheld.
    """
    if not media_ids:
        return {}
    rows = (
        db.execute(
            text(
                """
                SELECT media_id, summary_md, content_fingerprint
                FROM media_summaries
                WHERE media_id = ANY(:media_ids) AND status = 'ready'
                """
            ),
            {"media_ids": media_ids},
        )
        .mappings()
        .all()
    )
    summaries: dict[UUID, str] = {}
    for row in rows:
        media_id = UUID(str(row["media_id"]))
        if row["content_fingerprint"] == _compute_content_fingerprint(db, media_id=media_id):
            summaries[media_id] = str(row["summary_md"])
    return summaries


def ensure_media_unit_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> MediaSummarizeOut:
    """Route wrapper: 404-mask via ``can_read_media`` then ``ensure_media_unit``."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(message="Media not found")
    ref = ensure_media_unit(db, media_id=media_id)
    return MediaSummarizeOut(
        media_id=ref.media_id,
        summary_id=ref.summary_id,
        status=ref.status,
    )


# ---------- worker build ----------------------------------------------------


@dataclass(frozen=True)
class _Candidate:
    """One content chunk offered to the model by integer index."""

    evidence_span_id: UUID
    text: str


async def run_media_unit_build(
    db: Session, *, media_id: UUID, llm: LLMRouter
) -> Literal["ok", "failed"]:
    """Worker body: synthesize the summary + grounded claims for one media unit.

    Replay-safe: an ``ok`` no-op when the head is missing, not ``building``, or
    when the recomputed fingerprint no longer matches the head (a fresher
    dedupe_key job owns that version). Expected LLM failures and an empty
    candidate set set the head ``failed`` without raising and return ``failed``
    so the queue records a real failure; the worker boundary handles only
    unexpected exceptions.
    """
    summary = (
        db.execute(
            text("SELECT * FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if summary is None or summary["status"] != "building":
        # A newer ensure/build replaced or terminated this head; nothing to do.
        return "ok"
    summary_id = UUID(str(summary["id"]))

    current_fingerprint = _compute_content_fingerprint(db, media_id=media_id)
    if current_fingerprint != summary["content_fingerprint"]:
        # The content changed after this build was enqueued; the dedupe_key for
        # the new fingerprint enqueues a distinct job that will rebuild. No-op.
        return "ok"

    candidates = _load_candidates(db, media_id=media_id)
    if not candidates:
        _fail_unit(db, summary_id=summary_id)
        return "failed"

    request = _build_llm_request(candidates)
    settings = get_settings()
    api_key = settings.anthropic_api_key or ""
    try:
        result = await run_structured_synthesis(
            llm=llm,
            request=SynthesisRequest(
                provider=MEDIA_UNIT_PROVIDER,
                llm_request=request,
                api_key=api_key,
                timeout_s=MEDIA_UNIT_LLM_TIMEOUT_SECONDS,
            ),
            schema=MediaUnitSynthesis,
        )
    except (LLMError, StructuredSynthesisError) as exc:
        logger.warning(
            "media_unit_build.llm_failure",
            media_id=str(media_id),
            reason=type(exc).__name__,
        )
        _fail_unit(db, summary_id=summary_id)
        return "failed"

    grounded = _map_claims_to_spans(result.value, candidates)
    _persist_unit(
        db,
        media_id=media_id,
        summary_id=summary_id,
        summary_md=result.value.summary_md,
        expected_fingerprint=current_fingerprint,
        grounded=grounded,
    )
    return "ok"


def fail_media_unit_after_worker_exception(db: Session, *, media_id: UUID) -> None:
    """Set a nonterminal unit head to ``failed`` after a worker exception."""
    db.rollback()
    summary = (
        db.execute(
            text("SELECT id, status FROM media_summaries WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if summary is None or summary["status"] in ("ready", "failed"):
        db.commit()
        return
    _fail_unit(db, summary_id=UUID(str(summary["id"])))


# ---------- grounding map (pure, unit-testable) -----------------------------


def _map_claims_to_spans(
    synthesis: MediaUnitSynthesis,
    candidates: list[_Candidate],
) -> list[tuple[str, UUID, int]]:
    """Map each claim's candidate_index to a span, dropping out-of-range claims.

    Survivors keep model order and are reassigned ordinals 0..M. A claim whose
    ``candidate_index`` is not a valid candidate is dropped (AC-2).
    """
    survivors: list[tuple[str, UUID]] = []
    for claim in synthesis.claims:
        if 0 <= claim.candidate_index < len(candidates):
            survivors.append((claim.claim_text, candidates[claim.candidate_index].evidence_span_id))
    return [
        (claim_text, evidence_span_id, ordinal)
        for ordinal, (claim_text, evidence_span_id) in enumerate(survivors)
    ]


# ---------- internal: fingerprint / candidates / persistence ----------------


def _compute_content_fingerprint(db: Session, *, media_id: UUID) -> str:
    """SHA-256 of the active embedding model plus the ordered chunk-text hashes.

    Changes whenever the media is re-extracted (chunk set or active index run
    changes), which is the staleness signal for both units and the artifact.
    Sole reader/definer of this fingerprint.
    """
    index_state = (
        db.execute(
            text(
                """
            SELECT active_embedding_provider, active_embedding_model
            FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    provider = (index_state or {}).get("active_embedding_provider")
    model = (index_state or {}).get("active_embedding_model")

    chunk_rows = (
        db.execute(
            text(
                """
            SELECT chunk_idx, chunk_text
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    canonical = {
        "active_embedding_provider": provider,
        "active_embedding_model": model,
        "chunks": [
            [
                int(row["chunk_idx"]),
                hashlib.sha256(str(row["chunk_text"]).encode("utf-8")).hexdigest(),
            ]
            for row in chunk_rows
        ],
    }
    serialized = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _load_candidates(db: Session, *, media_id: UUID) -> list[_Candidate]:
    rows = (
        db.execute(
            text(
                """
            SELECT cc.chunk_text, es.span_text, cc.primary_evidence_span_id
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
              AND cc.primary_evidence_span_id IS NOT NULL
            ORDER BY cc.chunk_idx
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )

    candidates: list[_Candidate] = []
    used_chars = 0
    for row in rows:
        candidate_text = str(row["span_text"] or row["chunk_text"] or "")
        if used_chars + len(candidate_text) > MEDIA_UNIT_INPUT_CHAR_BUDGET and candidates:
            dropped = len(rows) - len(candidates)
            logger.warning(
                "media_unit_build.candidates_truncated",
                media_id=str(media_id),
                kept=len(candidates),
                dropped=dropped,
                char_budget=MEDIA_UNIT_INPUT_CHAR_BUDGET,
            )
            break
        used_chars += len(candidate_text)
        candidates.append(
            _Candidate(
                evidence_span_id=UUID(str(row["primary_evidence_span_id"])),
                text=candidate_text,
            )
        )
    return candidates


def _persist_unit(
    db: Session,
    *,
    media_id: UUID,
    summary_id: UUID,
    summary_md: str,
    expected_fingerprint: str,
    grounded: list[tuple[str, UUID, int]],
) -> None:
    for attempt in range(_SERIALIZABLE_RETRIES):
        use_serializable_if_available(db)
        try:
            # Gate the promote on the build's generation. A concurrent re-ingest
            # commits a new fingerprint (and replaces evidence_spans) during the
            # LLM window; under READ COMMITTED this UPDATE then matches 0 rows, so
            # the superseded build bails before the FK-violating claim INSERTs and
            # never clobbers the live 'building' head.
            result = cast(
                "Any",
                db.execute(
                    text(
                        """
                        UPDATE media_summaries
                        SET summary_md = :summary_md,
                            status = 'ready',
                            updated_at = now()
                        WHERE id = :summary_id
                          AND status = 'building'
                          AND content_fingerprint = :expected_fingerprint
                        """
                    ),
                    {
                        "summary_md": summary_md,
                        "summary_id": summary_id,
                        "expected_fingerprint": expected_fingerprint,
                    },
                ),
            )
            if result.rowcount == 0:
                db.rollback()
                return
            db.execute(
                text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
                {"summary_id": summary_id},
            )
            for claim_text, evidence_span_id, ordinal in grounded:
                db.execute(
                    text(
                        """
                        INSERT INTO media_claims (
                            media_id, summary_id, claim_text, evidence_span_id, ordinal
                        )
                        VALUES (
                            :media_id, :summary_id, :claim_text, :evidence_span_id, :ordinal
                        )
                        """
                    ),
                    {
                        "media_id": media_id,
                        "summary_id": summary_id,
                        "claim_text": claim_text,
                        "evidence_span_id": evidence_span_id,
                        "ordinal": ordinal,
                    },
                )
            db.commit()
            return
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == _SERIALIZABLE_RETRIES - 1:
                raise
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError("_persist_unit retry loop exhausted")


def _fail_unit(db: Session, *, summary_id: UUID) -> None:
    db.execute(
        text(
            """
            UPDATE media_summaries
            SET status = 'failed', updated_at = now()
            WHERE id = :summary_id
            """
        ),
        {"summary_id": summary_id},
    )
    db.commit()


# ---------- internal: prompt + schema ---------------------------------------


class MediaUnitClaimOut(BaseModel):
    """One claim in the model's strict-JSON output."""

    model_config = ConfigDict(extra="forbid")

    claim_text: str
    candidate_index: int


class MediaUnitSynthesis(BaseModel):
    """The strict-JSON unit synthesis shape."""

    model_config = ConfigDict(extra="forbid")

    summary_md: str
    claims: list[MediaUnitClaimOut]


_MEDIA_UNIT_SYSTEM_PROMPT = (
    "You are a careful research assistant building a reusable unit for one "
    "document: a concise summary plus a set of atomic, grounded claims.\n\n"
    "RULES.\n"
    "1. Refer to candidate passages only by their integer index. Do not invent "
    "passages, indices, sources, or quotations.\n"
    "2. Write summary_md: a faithful markdown abstract of the document "
    "(2-5 sentences), based only on the candidate passages.\n"
    "3. Write claims: each is one atomic, self-contained factual statement the "
    "document makes, paired with the candidate_index of the single passage that "
    "best supports it. Only emit a claim you can ground in a provided candidate.\n"
    "4. Output strict JSON of the form: "
    '{"summary_md": string, "claims": [{"claim_text": string, '
    '"candidate_index": int}]}. No markdown fences, no extra keys, no commentary '
    "outside the JSON."
)


def _build_llm_request(candidates: list[_Candidate]) -> LLMRequest:
    rendered = "\n\n".join(
        f"[{index}] {candidate.text}" for index, candidate in enumerate(candidates)
    )
    user_content = f"CANDIDATES:\n{rendered}\n\nRespond with the strict JSON object as instructed."
    return LLMRequest(
        model_name=MEDIA_UNIT_MODEL_NAME,
        messages=[
            Turn(role="system", content=_MEDIA_UNIT_SYSTEM_PROMPT, cache_ttl="5m"),
            Turn(role="user", content=user_content, cache_ttl="none"),
        ],
        max_tokens=MEDIA_UNIT_MAX_OUTPUT_TOKENS,
        reasoning_effort="none",
        prompt_cache_key=None,
    )
