"""The read wire for a Media: one SQL projection hydrated into the media DTOs."""

from __future__ import annotations

import base64
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    non_system_media_ref_exists_sql,
    visible_media_ids_cte_sql,
)
from nexus.db.models import MediaKind
from nexus.db.sql_patterns import escape_ilike_pattern
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.media import (
    FragmentOut,
    ListeningStateOut,
    MediaOut,
    MediaProcessingStatus,
    MediaReadState,
    OfflineDownloadSpecOut,
    PodcastEpisodeChapterOut,
    SourceCountedProgress,
    SourceProgress,
    SourceStageProgress,
)
from nexus.schemas.presence import (
    Absent,
    Presence,
    Present,
    absent,
    presence_from_nullable,
    present,
)
from nexus.schemas.publication_dates import PublicationDate
from nexus.services.capabilities import (
    SearchRecoveryAnswer,
    SourceRecoveryAnswer,
    derive_capabilities,
    is_text_document_ready,
)
from nexus.services.consumption import projection
from nexus.services.content_indexing import SearchRecoveryFacts, search_recovery
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.document_embeds import (
    document_embed_summaries_for_media,
    list_document_embeds_for_fragments,
)
from nexus.services.media_source_ingest import (
    SourceRecoveryFacts,
    source_recovery,
    source_repairable_sql,
)
from nexus.services.offline_download_source import (
    derive_offline_download_source,
    derive_offline_download_title,
    offline_download_eligible,
)
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.resource_grants import media_grant_path_exists_sql
from nexus.services.source_publication import (
    SourceCountedProgress as PublishedSourceCountedProgress,
)
from nexus.services.source_publication import SourceProgress as PublishedSourceProgress
from nexus.services.source_publication import load_source_progress

_LIST_LIMIT_MAX = 200
_TERMINAL_PROCESSING_STATUSES = ("ready_for_reading", "failed", "suspended")

_LATEST_SOURCE_ATTEMPT_SQL = """(
    SELECT jsonb_build_object(
        'id', latest.id,
        'status', latest.status,
        'error_code', latest.error_code,
        'source_type', latest.source_type,
        'job_id', latest.job_id
    )
    FROM media_source_attempts latest
    WHERE latest.media_id = m.id
    ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
    LIMIT 1
)"""
_DEAD_REINDEX_JOB_ID_SQL = """(
    SELECT dead_job.id
    FROM background_jobs dead_job
    WHERE dead_job.kind = 'media_content_reindex_job'
      AND dead_job.status = 'dead'
      AND dead_job.payload @> jsonb_build_object(
          'media_id', m.id::text,
          'revision', mcis.revision
      )
    ORDER BY dead_job.id
    LIMIT 1
)"""
_SOURCE_ATTEMPT_TYPES_SQL = """
    'generic_web_url',
    'x_author_thread',
    'x_post',
    'youtube_video',
    'remote_pdf_url',
    'remote_epub_url',
    'uploaded_pdf_file',
    'uploaded_epub_file',
    'browser_article_capture',
    'browser_pdf_capture',
    'browser_epub_capture',
    'podcast_episode_transcript',
    'video_transcript'
"""
_SOURCE_ATTEMPT_FILE_TYPES_SQL = """
    'uploaded_pdf_file',
    'uploaded_epub_file',
    'browser_article_capture',
    'browser_pdf_capture',
    'browser_epub_capture'
"""
_SOURCE_ATTEMPT_STORAGE_ERROR_CODES_SQL = """
    'E_SIGN_UPLOAD_FAILED',
    'E_STORAGE_MISSING',
    'E_STORAGE_ERROR'
"""
# A healthy source has no last_error_code; collapse that NULL to false so
# file-backed attempts stay refreshable unless a storage error exists.
_SOURCE_REFRESH_AVAILABLE_SQL = f"""EXISTS(
        SELECT 1
        FROM media_source_attempts msa
        WHERE msa.media_id = m.id
          AND msa.source_type IN ({_SOURCE_ATTEMPT_TYPES_SQL})
          AND NOT (
              msa.source_type IN ({_SOURCE_ATTEMPT_FILE_TYPES_SQL})
              AND COALESCE(
                  m.last_error_code IN ({_SOURCE_ATTEMPT_STORAGE_ERROR_CODES_SQL}),
                  FALSE
              )
          )
          AND msa.id = (
              SELECT latest.id
              FROM media_source_attempts latest
              WHERE latest.media_id = m.id
              ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
              LIMIT 1
          )
    )"""

# One expression per output alias. Both projections name their aliases from here,
# so no SQL expression exists twice.
_SELECT_EXPRESSIONS: dict[str, str] = {
    "id": "m.id",
    "kind": "m.kind",
    "title": "m.title",
    "canonical_source_url": "m.canonical_source_url",
    "external_playback_url": "m.external_playback_url",
    "persisted_processing_status": "m.processing_status",
    # A repairable latest source attempt displays as suspended whatever the row says.
    "processing_status": (
        f"CASE WHEN {source_repairable_sql('m')} THEN 'suspended'"
        " ELSE m.processing_status::text END"
    ),
    "latest_source_attempt": _LATEST_SOURCE_ATTEMPT_SQL,
    "source_repairable": source_repairable_sql("m"),
    "retrieval_revision": "mcis.revision",
    "dead_reindex_job_id": _DEAD_REINDEX_JOB_ID_SQL,
    "retrieval_status": "COALESCE(mcis.status, 'pending')",
    "retrieval_status_reason": "mcis.status_reason",
    "failure_stage": "m.failure_stage",
    "last_error_code": "m.last_error_code",
    "provider": "m.provider",
    "provider_id": "m.provider_id",
    "created_at": "m.created_at",
    "updated_at": "m.updated_at",
    "has_file": "EXISTS(SELECT 1 FROM media_file mf WHERE mf.media_id = m.id)",
    "is_creator": "m.created_by_user_id = :viewer_id",
    "source_refresh_available": _SOURCE_REFRESH_AVAILABLE_SQL,
    "original_published_date": "m.original_published_date",
    "edition_published_date": "m.edition_published_date",
    "publisher": "m.publisher",
    "language": "m.language",
    "description": "m.description",
    "authors_manually_managed": "m.authors_manually_managed",
    "metadata_enriched_at": "m.metadata_enriched_at",
    "podcast_description_html": "pe.description_html",
    "podcast_description_text": "pe.description_text",
    "transcript_state": "mts.transcript_state",
    "transcript_coverage": "mts.transcript_coverage",
    "transcript_origin": "mts.transcript_origin",
    "can_delete": (
        f"({non_system_media_ref_exists_sql('m.id')} OR {media_grant_path_exists_sql('m.id')})"
    ),
    "listening_position_ms": "pls.position_ms",
    "listening_duration_ms": "pls.duration_ms",
    "listening_is_completed": "pls.is_completed",
}

_MEDIA_OUT_ALIASES = tuple(_SELECT_EXPRESSIONS)
# Collection rows render no descriptions, retrieval metadata or episode prose.
_COLLECTION_ALIASES = tuple(
    alias
    for alias in _SELECT_EXPRESSIONS
    if alias
    not in {
        "retrieval_status",
        "retrieval_status_reason",
        "failure_stage",
        "provider",
        "provider_id",
        "updated_at",
        "edition_published_date",
        "publisher",
        "language",
        "description",
        "metadata_enriched_at",
        "podcast_description_html",
        "podcast_description_text",
    }
)

# podcast_episodes has media_id as its primary key, so this join never fans out.
_FROM_SQL = """
    FROM media m
    JOIN visible_media vm ON vm.media_id = m.id
    LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    LEFT JOIN content_index_states mcis ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
    LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
    LEFT JOIN podcast_listening_states pls ON pls.media_id = m.id AND pls.user_id = :viewer_id
"""


def _projection_sql(aliases: Sequence[str]) -> str:
    return ",\n    ".join(f"{_SELECT_EXPRESSIONS[alias]} AS {alias}" for alias in aliases)


def _visible_query(aliases: Sequence[str], tail: str) -> str:
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT
        {_projection_sql(aliases)}
        {_FROM_SQL}
        {tail}
    """


def _status_to_str(value: object) -> str:
    return value if isinstance(value, str) else str(getattr(value, "value", value))


def _nullable_str(value: object) -> str | None:
    return None if value is None else _status_to_str(value)


def _dedupe_uuid_order(values: Iterable[UUID]) -> list[UUID]:
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        normalized = UUID(str(value))
        if normalized not in seen:
            seen.add(normalized)
            ordered.append(normalized)
    return ordered


@dataclass(frozen=True, slots=True)
class CompactMediaTarget:
    media_id: UUID
    media_kind: MediaKind
    title: str
    subtitle: Absent | Present[str]
    image_url: Absent | Present[str]
    href: str


type MediaRecoveryOffer = RetrySourceOffer | RepairSourceOffer | RepairSearchOffer
"""The offers a media subject can carry; upload recovery belongs to sessions."""


@dataclass(frozen=True, slots=True)
class CollectionMediaCapabilities:
    can_quote: bool
    can_retry: bool
    can_refresh_source: bool
    can_retry_metadata: bool
    can_edit_authors: bool
    can_delete: bool
    refresh_source_applicable: bool
    retry_metadata_applicable: bool
    edit_authors_applicable: bool


@dataclass(frozen=True, slots=True)
class CollectionMedia:
    """Compact viewer-scoped media facts shared by finite collection owners."""

    id: UUID
    kind: Literal["web_article", "epub", "pdf", "podcast_episode", "video"]
    title: str
    canonical_source_url: str | None
    offline_download_eligible: bool
    processing_status: MediaProcessingStatus
    transcript_state: str | None
    transcript_coverage: str | None
    listening_state: ListeningStateOut | None
    contributors: list[ContributorCreditOut]
    author_mode: Literal["automatic", "manual"]
    original_published_date: Presence[PublicationDate]
    read_state: MediaReadState
    progress_fraction: float | None
    progress_resettable: bool
    audio_playable: bool
    has_original_file: bool
    capabilities: CollectionMediaCapabilities
    recovery: Presence[MediaRecoveryOffer]
    """The offer the viewer's own authority yields."""
    applicable_recovery: Presence[MediaRecoveryOffer]
    """The offer a creator or admin would be given: discoverable, permission-blocked."""
    created_at: datetime


def media_candidate_rows_sql() -> str:
    """Policy-neutral media candidate facts.

    Columns: ``media_id``, ``media_kind``, canonical ``created_at``, and the raw
    partial-date ``original_published_date``. Visibility, teardown, destination
    eligibility and exact-date interpretation belong to the composing query.
    """
    return """
        SELECT
            m.id AS media_id,
            m.kind AS media_kind,
            m.created_at,
            m.original_published_date
        FROM media m
    """


def hydrate_compact_media_targets(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, CompactMediaTarget]:
    """Batch-hydrate visible media into compact target facts.

    Podcast episodes borrow the parent podcast's title and artwork; every other
    kind uses its publisher as subtitle and has no image.
    """
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    ordered_ids = _dedupe_uuid_order(media_ids)
    if not ordered_ids:
        return {}
    rows = db.execute(
        text(f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT
                m.id AS media_id,
                m.kind AS media_kind,
                m.title,
                CASE WHEN m.kind = 'podcast_episode' THEN p.title ELSE m.publisher END AS subtitle,
                CASE WHEN m.kind = 'podcast_episode' THEN p.image_url ELSE NULL END AS image_url
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
            LEFT JOIN podcasts p ON p.id = pe.podcast_id
            WHERE m.id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": ordered_ids},
    ).mappings()
    by_id = {UUID(str(row["media_id"])): row for row in rows}

    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=[
            ResourceRef(scheme="media", id=media_id)
            for media_id in ordered_ids
            if media_id in by_id
        ],
    )
    hydrated: dict[UUID, CompactMediaTarget] = {}
    for media_id, row in ((media_id, by_id.get(media_id)) for media_id in ordered_ids):
        if row is None:
            continue
        hydrated[media_id] = CompactMediaTarget(
            media_id=media_id,
            media_kind=MediaKind(_status_to_str(row["media_kind"])),
            title=str(row["title"]),
            subtitle=presence_from_nullable(_nullable_str(row["subtitle"])),
            image_url=presence_from_nullable(_nullable_str(row["image_url"])),
            href=cast(str, activations[ResourceRef(scheme="media", id=media_id).uri].href),
        )
    return hydrated


def _row_recovery(
    row: RowMapping, *, is_creator: bool
) -> tuple[SourceRecoveryAnswer, SearchRecoveryAnswer]:
    """Both owners' recovery answers for one projected media row."""
    latest = row["latest_source_attempt"]
    source: SourceRecoveryAnswer = None
    if latest is not None:
        source = source_recovery(
            SourceRecoveryFacts(
                attempt_id=UUID(str(latest["id"])),
                attempt_status=str(latest["status"]),
                error_code=latest["error_code"],
                source_type=str(latest["source_type"]),
                processing_status=_status_to_str(row["persisted_processing_status"]),
                job_id=None if latest["job_id"] is None else UUID(str(latest["job_id"])),
                repairable=bool(row["source_repairable"]),
                is_creator=is_creator,
                is_operator=False,
            )
        )
    search: SearchRecoveryAnswer = None
    if row["retrieval_revision"] is not None:
        search = search_recovery(
            SearchRecoveryFacts(
                revision=int(row["retrieval_revision"]),
                dead_job_id=(
                    None
                    if row["dead_reindex_job_id"] is None
                    else UUID(str(row["dead_reindex_job_id"]))
                ),
                is_creator=is_creator,
                is_operator=False,
            )
        )
    return source, search


def _recovery_offer(
    source: SourceRecoveryAnswer, search: SearchRecoveryAnswer
) -> Presence[MediaRecoveryOffer]:
    """The one offer a media subject carries: source recovery first, then search."""
    if isinstance(source, RetrySourceOffer | RepairSourceOffer):
        return present(source)
    if isinstance(search, RepairSearchOffer):
        return present(search)
    return absent()


def _listening_state(row: RowMapping) -> ListeningStateOut | None:
    position_ms = row["listening_position_ms"]
    if position_ms is None:
        return None
    duration_ms = row["listening_duration_ms"]
    return ListeningStateOut(
        position_ms=int(position_ms),
        duration_ms=int(duration_ms) if duration_ms is not None else None,
        is_completed=bool(row["listening_is_completed"]),
    )


def list_collection_media_for_viewer_by_ids(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> list[CollectionMedia]:
    """The exact media facts finite collection rows consume, in input order.

    Deliberately narrower than ``MediaOut``: no descriptions, chapters, embeds or
    retrieval metadata. Each row also carries the *applicable* capability — what a
    creator would be offered — so a blocked action stays discoverable.
    """
    ordered_media_ids = _dedupe_uuid_order(media_ids)
    if not ordered_media_ids:
        return []
    rows = (
        db.execute(
            text(_visible_query(_COLLECTION_ALIASES, "WHERE m.id = ANY(:media_ids)")),
            {"viewer_id": viewer_id, "media_ids": ordered_media_ids},
        )
        .mappings()
        .all()
    )
    row_by_media_id: dict[UUID, RowMapping] = {UUID(str(row["id"])): row for row in rows}
    visible_ids = [media_id for media_id in ordered_media_ids if media_id in row_by_media_id]
    if not visible_ids:
        return []

    pdf_ids = [
        media_id
        for media_id in visible_ids
        if _status_to_str(row_by_media_id[media_id]["kind"]) == MediaKind.pdf.value
    ]
    pdf_readiness = batch_pdf_quote_text_ready(db, pdf_ids) if pdf_ids else {}
    contributors_by_media = load_contributor_credits_for_media(db, visible_ids)
    read_states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=visible_ids)

    collection: list[CollectionMedia] = []
    for media_id in visible_ids:
        row = row_by_media_id[media_id]
        kind_value = _status_to_str(row["kind"])
        is_creator = bool(row["is_creator"])
        transcript_state = _nullable_str(row["transcript_state"])
        transcript_coverage = _nullable_str(row["transcript_coverage"])
        answers = [_row_recovery(row, is_creator=actor) for actor in (is_creator, True)]
        # The broad can_play value is not exposed here; compact podcast
        # playability is derived from the playback source below.
        viewer_caps, applicable_caps = [
            derive_capabilities(
                kind=kind_value,
                processing_status=_status_to_str(row["persisted_processing_status"]),
                last_error_code=cast(str | None, row["last_error_code"]),
                media_file_exists=bool(row["has_file"]),
                external_playback_url_exists=False,
                pdf_quote_text_ready=pdf_readiness.get(media_id, False),
                transcript_state=transcript_state,
                transcript_coverage=transcript_coverage,
                can_delete=bool(row["can_delete"]),
                is_creator=actor,
                source_refresh_available=bool(row["source_refresh_available"]),
                source_recovery=source,
                search_recovery=search,
            )
            for actor, (source, search) in zip((is_creator, True), answers, strict=True)
        ]
        playback_source = (
            derive_playback_source(
                kind=kind_value,
                external_playback_url=cast(str | None, row["external_playback_url"]),
                canonical_source_url=cast(str | None, row["canonical_source_url"]),
            )
            if kind_value == MediaKind.podcast_episode.value
            else None
        )
        collection.append(
            CollectionMedia(
                id=media_id,
                kind=cast(
                    "Literal['web_article', 'epub', 'pdf', 'podcast_episode', 'video']", kind_value
                ),
                title=str(row["title"]),
                canonical_source_url=cast(str | None, row["canonical_source_url"]),
                offline_download_eligible=offline_download_eligible(
                    kind=kind_value,
                    title=str(row["title"]),
                    external_playback_url=cast(str | None, row["external_playback_url"]),
                ),
                processing_status=cast(
                    "MediaProcessingStatus", _status_to_str(row["processing_status"])
                ),
                transcript_state=transcript_state,
                transcript_coverage=transcript_coverage,
                listening_state=_listening_state(row),
                contributors=contributors_by_media.get(media_id, []),
                author_mode="manual" if bool(row["authors_manually_managed"]) else "automatic",
                original_published_date=presence_from_nullable(row["original_published_date"]),
                read_state=read_states[media_id].state,
                progress_fraction=read_states[media_id].progress_fraction,
                progress_resettable=read_states[media_id].progress_resettable,
                audio_playable=playback_source is not None and bool(playback_source.stream_url),
                has_original_file=bool(row["has_file"]),
                capabilities=CollectionMediaCapabilities(
                    can_quote=viewer_caps.can_quote,
                    can_retry=viewer_caps.can_retry,
                    can_refresh_source=viewer_caps.can_refresh_source,
                    can_retry_metadata=viewer_caps.can_retry_metadata,
                    can_edit_authors=viewer_caps.can_edit_authors,
                    can_delete=viewer_caps.can_delete,
                    refresh_source_applicable=applicable_caps.can_refresh_source,
                    retry_metadata_applicable=applicable_caps.can_retry_metadata,
                    edit_authors_applicable=applicable_caps.can_edit_authors,
                ),
                recovery=_recovery_offer(*answers[0]),
                applicable_recovery=_recovery_offer(*answers[1]),
                created_at=cast(datetime, row["created_at"]),
            )
        )
    return collection


def _source_progress(progress: PublishedSourceProgress | None) -> Presence[SourceProgress]:
    """In-flight source progress in the field's own parametrization.

    ``present()`` would stamp the concrete variant, which serializes with a
    Pydantic field mismatch against the declared union.
    """
    if progress is None:
        return absent()
    if isinstance(progress, PublishedSourceCountedProgress):
        return Present[SourceProgress](
            value=SourceCountedProgress(
                completed=progress.completed,
                total=progress.total,
                unit=progress.unit,
                run_count=progress.run_count,
                updated_at=progress.updated_at,
            )
        )
    return Present[SourceProgress](
        value=SourceStageProgress(
            stage=progress.stage, run_count=progress.run_count, updated_at=progress.updated_at
        )
    )


def _load_chapters(
    db: Session, media_ids: list[UUID]
) -> dict[UUID, list[PodcastEpisodeChapterOut]]:
    chapters: dict[UUID, list[PodcastEpisodeChapterOut]] = {}
    for row in (
        db.execute(
            text("""
                SELECT media_id, chapter_idx, title, t_start_ms, t_end_ms, url, image_url
                FROM podcast_episode_chapters
                WHERE media_id = ANY(:ids)
                ORDER BY media_id ASC, chapter_idx ASC
            """),
            {"ids": media_ids},
        )
        .mappings()
        .all()
    ):
        chapters.setdefault(UUID(str(row["media_id"])), []).append(
            PodcastEpisodeChapterOut.model_validate(dict(row))
        )
    return chapters


def _hydrate_media_out(
    db: Session, *, viewer_id: UUID, rows: Sequence[RowMapping]
) -> list[MediaOut]:
    """Build one fully-populated ``MediaOut`` per row, batching every loader once."""
    if not rows:
        return []
    media_ids = [UUID(str(row["id"])) for row in rows]
    kinds = [_status_to_str(row["kind"]) for row in rows]
    has_audio = [row["listening_position_ms"] is not None for row in rows]

    def pick(flags: list[bool]) -> list[UUID]:
        return [media_id for media_id, flag in zip(media_ids, flags, strict=True) if flag]

    pdf_ids = pick([kind == MediaKind.pdf.value for kind in kinds])
    episode_ids = pick([kind == MediaKind.podcast_episode.value for kind in kinds])
    audio_ids = pick(has_audio)
    document_ids = pick([not audio for audio in has_audio])

    pdf_readiness = batch_pdf_quote_text_ready(db, pdf_ids) if pdf_ids else {}
    contributors_by_media = load_contributor_credits_for_media(db, media_ids)
    chapters_by_media = _load_chapters(db, media_ids)
    embed_summaries = document_embed_summaries_for_media(db, media_ids)
    progress_by_media = load_source_progress(db, tuple(media_ids))
    read_states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=media_ids)
    # Recency: audio rows through the listening owner, documents through the
    # reader-engagement owner; both are the consumption projection.
    engaged_at: dict[UUID, datetime] = {}
    if audio_ids:
        engaged_at |= projection.listening_recency(db, viewer_id=viewer_id, media_ids=audio_ids)
    if document_ids:
        engaged_at |= projection.reader_engagement_recency(
            db, viewer_id=viewer_id, media_ids=document_ids
        )
    descriptors = (
        projection.player_descriptors(db, viewer_id=viewer_id, media_ids=episode_ids)
        if episode_ids
        else {}
    )

    media_list: list[MediaOut] = []
    for media_id, row in zip(media_ids, rows, strict=True):
        kind_value = _status_to_str(row["kind"])
        source_answer, search_answer = _row_recovery(row, is_creator=bool(row["is_creator"]))
        # A dead reindex job for the current revision displays as suspended.
        retrieval_status = (
            "suspended" if row["dead_reindex_job_id"] is not None else row["retrieval_status"]
        )
        read_state = read_states[media_id]
        descriptor = descriptors.get(media_id)
        media_list.append(
            MediaOut(
                id=media_id,
                kind=kind_value,
                title=str(row["title"]),
                canonical_source_url=row["canonical_source_url"],
                processing_status=cast(
                    "MediaProcessingStatus", _status_to_str(row["processing_status"])
                ),
                source_progress=_source_progress(progress_by_media.get(media_id)),
                transcript_state=_nullable_str(row["transcript_state"]),
                transcript_coverage=_nullable_str(row["transcript_coverage"]),
                transcript_origin=presence_from_nullable(row["transcript_origin"]),
                retrieval_status=retrieval_status,
                retrieval_status_reason=row["retrieval_status_reason"],
                failure_stage=_nullable_str(row["failure_stage"]),
                last_error_code=row["last_error_code"],
                playback_source=derive_playback_source(
                    kind=kind_value,
                    external_playback_url=row["external_playback_url"],
                    canonical_source_url=row["canonical_source_url"],
                    provider=row["provider"],
                    provider_id=row["provider_id"],
                ),
                listening_state=_listening_state(row),
                chapters=chapters_by_media.get(media_id, []),
                capabilities=derive_capabilities(
                    kind=kind_value,
                    processing_status=_status_to_str(row["persisted_processing_status"]),
                    last_error_code=row["last_error_code"],
                    media_file_exists=bool(row["has_file"]),
                    external_playback_url_exists=row["external_playback_url"] is not None,
                    pdf_quote_text_ready=pdf_readiness.get(media_id, False),
                    transcript_state=_nullable_str(row["transcript_state"]),
                    transcript_coverage=_nullable_str(row["transcript_coverage"]),
                    retrieval_status=retrieval_status,
                    can_delete=bool(row["can_delete"]),
                    is_creator=bool(row["is_creator"]),
                    source_refresh_available=bool(row["source_refresh_available"]),
                    source_recovery=source_answer,
                    search_recovery=search_answer,
                ),
                document_embed_summary=embed_summaries.get(media_id),
                contributors=contributors_by_media.get(media_id, []),
                author_mode="manual" if row["authors_manually_managed"] else "automatic",
                original_published_date=presence_from_nullable(row["original_published_date"]),
                edition_published_date=presence_from_nullable(row["edition_published_date"]),
                publisher=row["publisher"],
                language=row["language"],
                description=row["description"],
                description_html=row["podcast_description_html"],
                description_text=row["podcast_description_text"],
                metadata_enriched_at=row["metadata_enriched_at"],
                read_state=read_state.state,
                progress_fraction=read_state.progress_fraction,
                progress_resettable=read_state.progress_resettable,
                last_engaged_at=engaged_at.get(media_id),
                playerDescriptor=(
                    absent() if descriptor is None else Present[PlayerDescriptor](value=descriptor)
                ),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        )
    return media_list


def list_media_for_viewer_by_ids(
    db: Session, viewer_id: UUID, media_ids: list[UUID]
) -> list[MediaOut]:
    """Batch-hydrate viewer-visible media by id, preserving input order."""
    ordered_media_ids = _dedupe_uuid_order(media_ids)
    if not ordered_media_ids:
        return []
    rows = (
        db.execute(
            text(_visible_query(_MEDIA_OUT_ALIASES, "WHERE m.id = ANY(:media_ids)")),
            {"viewer_id": viewer_id, "media_ids": ordered_media_ids},
        )
        .mappings()
        .all()
    )
    row_by_media_id = {UUID(str(row["id"])): row for row in rows}
    ordered_rows = [
        row_by_media_id[media_id] for media_id in ordered_media_ids if media_id in row_by_media_id
    ]
    return _hydrate_media_out(db, viewer_id=viewer_id, rows=ordered_rows)


def get_media_for_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> MediaOut:
    """One media by id, 404-masking anything the viewer cannot read."""
    rows = list_media_for_viewer_by_ids(db, viewer_id, [media_id])
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return rows[0]


def _encode_cursor(updated_at: datetime, media_id: UUID) -> str:
    payload = json.dumps(
        {"updated_at": updated_at.isoformat(), "id": str(media_id)}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        updated_at = datetime.fromisoformat(payload["updated_at"])
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=UTC)
        return updated_at, UUID(payload["id"])
    except (KeyError, ValueError) as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from exc


def _parse_kind_filter(kind: str | None) -> list[str]:
    """Validate a comma-separated kind filter against the closed vocabulary."""
    parsed = sorted({token.strip() for token in (kind or "").split(",") if token.strip()})
    invalid = [value for value in parsed if value not in {member.value for member in MediaKind}]
    if invalid:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid media kind filter: {', '.join(invalid)}"
        )
    return parsed


def list_visible_media(
    db: Session,
    viewer_id: UUID,
    *,
    kind: str | None = None,
    search: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[MediaOut], str | None]:
    """Viewer-visible media newest-first, keyset-paginated on (updated_at, id)."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, _LIST_LIMIT_MAX)

    where_clauses = ["1=1"]
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit + 1}
    parsed_kinds = _parse_kind_filter(kind)
    if parsed_kinds:
        params.update({f"kind_{index}": value for index, value in enumerate(parsed_kinds)})
        placeholders = ", ".join(f":kind_{index}" for index in range(len(parsed_kinds)))
        where_clauses.append(f"m.kind IN ({placeholders})")
    normalized_search = (search or "").strip()
    if normalized_search:
        where_clauses.append(r"m.title ILIKE :search_pattern ESCAPE '\'")
        params["search_pattern"] = f"%{escape_ilike_pattern(normalized_search)}%"
    if cursor:
        params["cursor_updated_at"], params["cursor_id"] = _decode_cursor(cursor)
        where_clauses.append("(m.updated_at, m.id) < (:cursor_updated_at, :cursor_id)")

    # Over-fetch by one to decide whether a next page exists.
    rows = (
        db.execute(
            text(
                _visible_query(
                    _MEDIA_OUT_ALIASES,
                    f"""
                    WHERE {" AND ".join(where_clauses)}
                    ORDER BY m.updated_at DESC, m.id DESC
                    LIMIT :limit
                    """,
                )
            ),
            params,
        )
        .mappings()
        .all()
    )
    has_more = len(rows) > limit
    media_list = _hydrate_media_out(db, viewer_id=viewer_id, rows=rows[:limit])
    next_cursor = (
        _encode_cursor(media_list[-1].updated_at, media_list[-1].id)
        if has_more and media_list
        else None
    )
    return media_list, next_cursor


def get_offline_download_spec_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> OfflineDownloadSpecOut:
    """The bounded title plus progressive-audio source URL of a visible media."""
    row = (
        db.execute(
            text(f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT m.kind, m.title, m.external_playback_url
                FROM media m
                JOIN visible_media vm ON vm.media_id = m.id
                WHERE m.id = :media_id
            """),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return OfflineDownloadSpecOut(
        media_id=media_id,
        title=derive_offline_download_title(title=str(row["title"])),
        source_url=derive_offline_download_source(
            kind=_status_to_str(row["kind"]),
            external_playback_url=cast(str | None, row["external_playback_url"]),
        ),
    )


def list_fragments_for_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> list[FragmentOut]:
    """Ordered fragments with their running word offset and resolved embeds.

    404-masks unreadable media; a text media that is not ready is a 409-class
    ``E_MEDIA_NOT_READY``.
    """
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_row = db.execute(
        text("""
            SELECT m.kind, m.processing_status, mts.transcript_state, mts.transcript_coverage
            FROM media m
            LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
            WHERE m.id = :media_id
        """),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_kind = str(media_row[0])
    if media_kind in {
        "web_article",
        "epub",
        "podcast_episode",
        "video",
    } and not is_text_document_ready(
        media_kind, str(media_row[1]), _nullable_str(media_row[2]), _nullable_str(media_row[3])
    ):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    fragments = [
        FragmentOut(**row)
        for row in db.execute(
            text("""
                SELECT
                    f.id,
                    f.media_id,
                    f.idx,
                    f.html_sanitized,
                    f.canonical_text,
                    f.canonical_text_word_count AS word_count,
                    COALESCE(
                        SUM(f.canonical_text_word_count) OVER (
                            PARTITION BY f.media_id
                            ORDER BY f.idx
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                        ),
                        0
                    ) AS document_word_start,
                    f.t_start_ms,
                    f.t_end_ms,
                    f.speaker_label,
                    f.created_at
                FROM fragments f
                WHERE f.media_id = :media_id
                ORDER BY f.t_start_ms ASC NULLS LAST, f.idx ASC
            """),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    ]
    embeds_by_fragment = list_document_embeds_for_fragments(
        db, viewer_id=viewer_id, fragment_ids=[fragment.id for fragment in fragments]
    )
    for fragment in fragments:
        fragment.document_embeds = embeds_by_fragment.get(fragment.id, [])
    return fragments


@dataclass(frozen=True)
class MediaEventSnapshot:
    payload: dict[str, Any]
    terminal: bool


def read_event_snapshot(db: Session, *, viewer_id: UUID, media_id: UUID) -> MediaEventSnapshot:
    """State payload plus terminal flag for the media-processing SSE.

    Raises ``E_MEDIA_NOT_FOUND`` when the media is gone or unreadable; the SSE
    tail treats that as a clean close.
    """
    media = get_media_for_viewer(db, viewer_id, media_id)
    return MediaEventSnapshot(
        payload={
            "processing_status": media.processing_status,
            "source_progress": media.source_progress.model_dump(mode="json"),
            "last_error_code": media.last_error_code,
            "failure_stage": media.failure_stage,
            "retrieval_status": media.retrieval_status,
            "retrieval_status_reason": media.retrieval_status_reason,
            "capabilities": media.capabilities.model_dump(mode="json"),
            "transcript_state": media.transcript_state,
            "transcript_coverage": media.transcript_coverage,
            "updated_at": media.updated_at.isoformat(),
        },
        terminal=media.processing_status in _TERMINAL_PROCESSING_STATUSES,
    )
