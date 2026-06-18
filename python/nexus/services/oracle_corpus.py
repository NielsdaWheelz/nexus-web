"""Oracle Corpus library: idempotent seed orchestration + readiness over the shared substrate.

This service owns only the curation layer above ordinary media: the system library, the
work→media source mapping (``oracle_corpus_sources``), and the stable passage anchors
(``oracle_passage_anchors``). It accepts media through ``media_source_ingest`` and attaches
them through ``library_entries``; it never inserts content blocks/chunks/embeddings, never
issues ``library_entries`` DML directly, and never embeds corpus text itself (G3–G6).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    OracleCorpusSource,
    OraclePassageAnchor,
    OraclePlate,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import library_entries, library_governance
from nexus.services.content_indexing import repair_ready_media_content_index_now
from nexus.services.image_validation import MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION
from nexus.services.media_source_ingest import (
    accept_system_url_source,
    repair_source_for_system_media,
)
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)

ORACLE_CORPUS_KEY = "oracle"
ORACLE_CORPUS_SYSTEM_KEY = "oracle_corpus"
ORACLE_CORPUS_LIBRARY_NAME = "Oracle Corpus"
# Length of the text-quote prefix used to locate a passage's chunk during anchor resolution.
_ANCHOR_NEEDLE_CHARS = 80


class OracleCorpusManifestAnchor(BaseModel):
    """One curated passage anchor in the corpus manifest (Oracle metadata, not graph tags)."""

    passage_key: str = Field(min_length=1, max_length=160)
    display_label: str = Field(min_length=1)
    selector: dict[str, object]
    tags: list[str] = Field(default_factory=list)
    phase_hints: list[str] = Field(default_factory=list)


class OracleCorpusManifestWork(BaseModel):
    """One corpus work: a directly-ingestable source plus its curated anchors (§9.1)."""

    work_key: str = Field(min_length=1, max_length=160)
    title: str
    author_text: str
    source_repository: str
    source_url: str
    source_download_url: str
    source_media_kind: Literal["epub", "web_article", "pdf"]
    display_order: int
    passage_anchors: list[OracleCorpusManifestAnchor]


@dataclass(frozen=True)
class OracleCorpusSeedResult:
    work_key: str
    media_id: UUID
    created_media: bool
    anchor_count: int


@dataclass(frozen=True)
class AnchorResolutionResult:
    total: int
    resolved: int
    failed: int


@dataclass(frozen=True)
class OracleCorpusReadiness:
    library_id: UUID | None
    status: str  # "ready" | "not_ready"
    work_count: int
    ready_media_count: int
    anchor_count: int
    resolved_anchor_count: int
    plate_count: int
    ready_plate_count: int


def oracle_corpus_library_id(db: Session) -> UUID | None:
    return db.execute(
        text("SELECT id FROM libraries WHERE system_key = :k"),
        {"k": ORACLE_CORPUS_SYSTEM_KEY},
    ).scalar_one_or_none()


def ensure_oracle_corpus_library(db: Session, *, owner_user_id: UUID) -> UUID:
    """Create or return the Oracle Corpus system library (idempotent by system_key)."""
    return library_governance.ensure_system_library(
        db,
        system_key=ORACLE_CORPUS_SYSTEM_KEY,
        name=ORACLE_CORPUS_LIBRARY_NAME,
        owner_user_id=owner_user_id,
    )


def ensure_oracle_corpus_media(
    db: Session,
    *,
    owner_user_id: UUID,
    library_id: UUID,
    work: OracleCorpusManifestWork,
) -> OracleCorpusSeedResult:
    """Accept-or-reuse one work's media, attach it to the corpus library, upsert its anchors.

    Idempotent by ``(corpus_key, work_key)``: an unchanged work reuses its media; a
    manifest source change is an explicit hard cutover to newly accepted system media.
    Acceptance runs through the shared durable source-ingest path, which enqueues
    extraction/indexing for the operator to drain before anchors resolve.
    """
    source = db.execute(
        select(OracleCorpusSource).where(
            OracleCorpusSource.corpus_key == ORACLE_CORPUS_KEY,
            OracleCorpusSource.work_key == work.work_key,
        )
    ).scalar_one_or_none()
    if source is not None:
        previous_media_id = source.media_id
        source_changed = (
            source.source_download_url != work.source_download_url
            or source.source_media_kind != work.source_media_kind
        )
        if source_changed:
            accepted = accept_system_url_source(
                db=db,
                actor_user_id=owner_user_id,
                url=work.source_download_url,
                expected_kind=work.source_media_kind,
                system_source=ORACLE_CORPUS_SYSTEM_KEY,
                idempotency_key=_source_accept_idempotency_key(work),
            )
            source.media_id = accepted.media_id
            created = accepted.idempotency_outcome == "created"
        else:
            created = False
        source.library_id = library_id
        source.title = work.title
        source.author_text = work.author_text
        source.source_repository = work.source_repository
        source.source_url = work.source_url
        source.source_download_url = work.source_download_url
        source.source_media_kind = work.source_media_kind
        source.display_order = work.display_order
        source.updated_at = db.scalar(select(func.now()))
        if source_changed and previous_media_id != source.media_id:
            if library_entries.delete_entry(
                db,
                library_id,
                library_entries.media_target(previous_media_id),
            ):
                library_entries.normalize_positions(db, library_id)
    else:
        accepted = accept_system_url_source(
            db=db,
            actor_user_id=owner_user_id,
            url=work.source_download_url,
            expected_kind=work.source_media_kind,
            system_source=ORACLE_CORPUS_SYSTEM_KEY,
            idempotency_key=_source_accept_idempotency_key(work),
        )
        source = OracleCorpusSource(
            corpus_key=ORACLE_CORPUS_KEY,
            work_key=work.work_key,
            library_id=library_id,
            media_id=accepted.media_id,
            title=work.title,
            author_text=work.author_text,
            source_repository=work.source_repository,
            source_url=work.source_url,
            source_download_url=work.source_download_url,
            source_media_kind=work.source_media_kind,
            display_order=work.display_order,
        )
        db.add(source)
        db.flush()
        created = True

    # System attach: corpus media live only in the corpus library (not the user's default).
    library_entries.ensure_entry(db, library_id, library_entries.media_target(source.media_id))
    if not created:
        _repair_reused_corpus_media(db, owner_user_id=owner_user_id, source=source)

    intended_anchor_keys = {manifest_anchor.passage_key for manifest_anchor in work.passage_anchors}
    for manifest_anchor in work.passage_anchors:
        anchor = db.execute(
            select(OraclePassageAnchor).where(
                OraclePassageAnchor.corpus_source_id == source.id,
                OraclePassageAnchor.passage_key == manifest_anchor.passage_key,
            )
        ).scalar_one_or_none()
        if anchor is not None:
            if anchor.selector != manifest_anchor.selector:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    f"Oracle anchor {manifest_anchor.passage_key!r} already maps to a "
                    "different selector",
                )
            anchor.display_label = manifest_anchor.display_label
            anchor.tags = manifest_anchor.tags
            anchor.phase_hints = manifest_anchor.phase_hints
            anchor.updated_at = db.scalar(select(func.now()))
        else:
            db.add(
                OraclePassageAnchor(
                    corpus_source_id=source.id,
                    passage_key=manifest_anchor.passage_key,
                    display_label=manifest_anchor.display_label,
                    selector=manifest_anchor.selector,
                    tags=manifest_anchor.tags,
                    phase_hints=manifest_anchor.phase_hints,
                )
            )
    stale_anchors = db.execute(
        select(OraclePassageAnchor).where(
            OraclePassageAnchor.corpus_source_id == source.id,
            OraclePassageAnchor.passage_key.not_in(intended_anchor_keys),
        )
    ).scalars()
    for stale_anchor in stale_anchors:
        db.delete(stale_anchor)
    db.flush()
    return OracleCorpusSeedResult(
        work_key=work.work_key,
        media_id=source.media_id,
        created_media=created,
        anchor_count=len(work.passage_anchors),
    )


def _source_accept_idempotency_key(work: OracleCorpusManifestWork) -> str:
    source_digest = hashlib.sha256(work.source_download_url.encode("utf-8")).hexdigest()[:16]
    return f"oracle-corpus-{ORACLE_CORPUS_KEY}-{work.work_key}-{source_digest}"


def _repair_reused_corpus_media(
    db: Session,
    *,
    owner_user_id: UUID,
    source: OracleCorpusSource,
) -> None:
    media = db.get(Media, source.media_id)
    if media is None:
        raise ApiError(
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            f"Oracle work {source.work_key!r} maps to missing media {source.media_id}",
        )
    request_id = f"oracle-corpus-seed:{source.work_key}"
    if media.processing_status == ProcessingStatus.ready_for_reading:
        if not _has_ready_active_content_index(db, media_id=media.id):
            repair_ready_media_content_index_now(
                db,
                media_id=media.id,
                reason="oracle_corpus_seed",
            )
        return
    repair_source_for_system_media(
        db=db,
        actor_user_id=owner_user_id,
        media_id=media.id,
        request_id=request_id,
        reason="oracle_corpus_seed",
    )


def _has_ready_active_content_index(db: Session, *, media_id: UUID) -> bool:
    return (
        db.execute(
            text(
                """
                SELECT 1
                FROM content_index_states
                WHERE owner_kind = 'media'
                  AND owner_id = :media_id
                  AND status = 'ready'
                  AND active_embedding_provider = :provider
                  AND active_embedding_model = :model
                LIMIT 1
                """
            ),
            {
                "media_id": media_id,
                "provider": current_transcript_embedding_provider(),
                "model": current_transcript_embedding_model(),
            },
        ).first()
        is not None
    )


def resolve_oracle_passage_anchors(
    db: Session, *, corpus_key: str = ORACLE_CORPUS_KEY
) -> AnchorResolutionResult:
    """Point each anchor at the current ready chunk in its media that contains its quote.

    Re-runnable: it always re-resolves to the current index generation, so reindexing media
    and re-running keeps the same stable anchor identities pointing at fresh evidence (AC-G10).
    A selector that matches no ready chunk marks the anchor ``failed`` (corpus not ready).
    """
    rows = db.execute(
        select(OraclePassageAnchor, OracleCorpusSource.media_id)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.corpus_key == corpus_key)
    ).all()
    now = db.scalar(select(func.now()))
    resolved = 0
    failed = 0
    chunk_cache: dict[UUID, list[tuple[UUID, UUID | None, str]]] = {}
    for anchor, media_id in rows:
        needle = _anchor_needle(anchor.selector)
        match = None
        if needle:
            match = _find_anchor_chunk_match(
                db, media_id=media_id, needle=needle, cache=chunk_cache
            )
        if match is not None:
            anchor.current_content_chunk_id = match[0]
            anchor.current_evidence_span_id = match[1]
            anchor.resolution_status = "resolved"
            anchor.resolution_error = None
            anchor.resolved_at = now
            resolved += 1
        else:
            anchor.current_content_chunk_id = None
            anchor.current_evidence_span_id = None
            anchor.resolution_status = "failed"
            anchor.resolution_error = "selector did not match a ready chunk in the mapped media"
            anchor.resolved_at = None
            failed += 1
    db.flush()
    return AnchorResolutionResult(total=len(rows), resolved=resolved, failed=failed)


def get_oracle_corpus_readiness(db: Session) -> OracleCorpusReadiness:
    """Derive corpus readiness from library/media/index/anchor/plate state (no old tables).

    Ready iff the library exists, every source's media is readable with a ready content index
    on the active embedding model, every anchor is resolved to a ready chunk in its mapped
    media, every anchor is resolved to an activatable evidence/chunk pointer in its
    mapped media, and every plate row is safe to render.
    """
    library_id = oracle_corpus_library_id(db)
    active_model = current_transcript_embedding_model()
    active_provider = current_transcript_embedding_provider()
    params = {"ck": ORACLE_CORPUS_KEY, "provider": active_provider, "model": active_model}
    work_count = int(
        db.scalar(
            text("SELECT count(*) FROM oracle_corpus_sources WHERE corpus_key = :ck"),
            {"ck": ORACLE_CORPUS_KEY},
        )
        or 0
    )
    ready_media_count = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM oracle_corpus_sources s
                JOIN media m ON m.id = s.media_id AND m.processing_status = 'ready_for_reading'
                JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                    AND mcis.owner_id = s.media_id AND mcis.status = 'ready'
                    AND mcis.active_embedding_provider = :provider
                    AND mcis.active_embedding_model = :model
                WHERE s.corpus_key = :ck
                """
            ),
            params,
        )
        or 0
    )
    anchor_count = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM oracle_passage_anchors a
                JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                WHERE s.corpus_key = :ck
                """
            ),
            {"ck": ORACLE_CORPUS_KEY},
        )
        or 0
    )
    resolved_anchor_count = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM oracle_passage_anchors a
                JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
                    AND es.owner_kind = 'media' AND es.owner_id = s.media_id
                JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
                    AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
                JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                    AND mcis.owner_id = s.media_id AND mcis.status = 'ready'
                    AND mcis.active_embedding_provider = :provider
                    AND mcis.active_embedding_model = :model
                WHERE s.corpus_key = :ck AND a.resolution_status = 'resolved'
                  AND (
                    (a.current_evidence_span_id IS NOT NULL AND es.id IS NOT NULL)
                    OR a.current_evidence_span_id IS NULL
                  )
                """
            ),
            params,
        )
        or 0
    )
    plate_count = int(db.scalar(select(func.count()).select_from(OraclePlate)) or 0)
    ready_plate_count = int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM oracle_plates
                WHERE width BETWEEN 1 AND :max_dimension
                  AND height BETWEEN 1 AND :max_dimension
                  AND byte_size BETWEEN 1 AND :max_bytes
                  AND storage_key ~ '^oracle/plates/[a-z0-9][a-z0-9._-]{0,191}\\.(jpg|png|webp)$'
                  AND content_type IN ('image/jpeg', 'image/png', 'image/webp')
                  AND (
                    (content_type = 'image/jpeg' AND storage_key LIKE '%.jpg')
                    OR (content_type = 'image/png' AND storage_key LIKE '%.png')
                    OR (content_type = 'image/webp' AND storage_key LIKE '%.webp')
                  )
                """
            ),
            {"max_dimension": MAX_IMAGE_DIMENSION, "max_bytes": MAX_IMAGE_BYTES},
        )
        or 0
    )
    ready = (
        library_id is not None
        and work_count > 0
        and ready_media_count == work_count
        and anchor_count > 0
        and resolved_anchor_count == anchor_count
        and plate_count > 0
        and ready_plate_count == plate_count
    )
    return OracleCorpusReadiness(
        library_id=library_id,
        status="ready" if ready else "not_ready",
        work_count=work_count,
        ready_media_count=ready_media_count,
        anchor_count=anchor_count,
        resolved_anchor_count=resolved_anchor_count,
        plate_count=plate_count,
        ready_plate_count=ready_plate_count,
    )


def _find_anchor_chunk_match(
    db: Session,
    *,
    media_id: UUID,
    needle: str,
    cache: dict[UUID, list[tuple[UUID, UUID | None, str]]],
) -> tuple[UUID, UUID | None] | None:
    if media_id not in cache:
        rows = db.execute(
            text(
                """
                SELECT
                    cc.id AS chunk_id,
                    cc.primary_evidence_span_id AS span_id,
                    cc.chunk_text AS chunk_text
                FROM content_chunks cc
                JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                    AND mcis.owner_id = cc.owner_id
                    AND mcis.status = 'ready'
                    AND mcis.active_embedding_provider = :provider
                    AND mcis.active_embedding_model = :model
                WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                ORDER BY cc.chunk_idx ASC
                """
            ),
            {
                "media_id": media_id,
                "provider": current_transcript_embedding_provider(),
                "model": current_transcript_embedding_model(),
            },
        ).mappings()
        cache[media_id] = [
            (row["chunk_id"], row["span_id"], _normalize_anchor_match_text(row["chunk_text"] or ""))
            for row in rows
        ]
    for chunk_id, span_id, normalized_text in cache[media_id]:
        if needle in normalized_text:
            return (chunk_id, span_id)
    return None


def _anchor_needle(selector: dict[str, object]) -> str:
    """The normalized text-quote prefix used to locate a passage's chunk, or ''.

    Public-domain editions differ in line breaks, punctuation style, apostrophes, and
    Unicode dashes. The resolver still requires same-media ready chunks, but quote
    comparison normalizes those presentation differences before matching.
    """
    exact = selector.get("exact")
    if not isinstance(exact, str) or not exact.strip():
        return ""
    return _normalize_anchor_match_text(exact)[:_ANCHOR_NEEDLE_CHARS]


def _normalize_anchor_match_text(value: str) -> str:
    value = (
        value.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
    )
    value = unicodedata.normalize("NFKD", value).lower()
    return re.sub(r"[^a-z0-9]+", "", value)
