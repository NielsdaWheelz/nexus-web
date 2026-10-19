"""The stored work as each viewer sees it: one visibility-joined row, projected four ways.

Summaries feed every list, facts the action menu and Imports, the detail the media pane and
overlay, the processing snapshot the live stream; a media the viewer cannot read is in none
(I1). The displayed processing status is ``suspended`` while the latest source attempt is
repairable and no publication is readable (``publication_readable``), whatever the source:
a readable document stays ready, and downloadable, beside its source remedy. The displayed
retrieval status is ``suspended`` while the current index revision's job is dead (I2);
capabilities and metadata eligibility read the persisted status, and a document reads from
its ready reader publication.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session

from nexus.auth.permissions import non_system_media_ref_exists_sql, visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.media import (
    CapabilitiesOut,
    ListeningStateOut,
    MediaOut,
    MediaProcessingSnapshotOut,
    PodcastEpisodeChapterOut,
)
from nexus.schemas.media_summary import (
    ConsumptionOut,
    MediaDurationOut,
    MediaProcessingStatus,
    MediaSummaryOut,
)
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.x_source import XArticleContent
from nexus.services.capabilities import (
    SearchRecoveryAnswer,
    SourceRecoveryAnswer,
    SourceRecoveryRestriction,
    media_file_exists_sql,
    publication_readable,
    reading_capabilities,
)
from nexus.services.consumption import projection
from nexus.services.content_indexing import SearchRecoveryFacts, search_recovery
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.metadata_operations import metadata_enrichment_views
from nexus.services.pdf_readiness import batch_pdf_quote_text_ready
from nexus.services.playback_source import derive_playback_source
from nexus.services.reader_publication import ready_publication_rows_sql
from nexus.services.reading_time import load_reading_time_estimates
from nexus.services.resource_grants import media_grant_path_exists_sql
from nexus.services.source_attempts import (
    SourceRecoveryFacts,
    source_recovery,
    source_refreshable,
    source_repairable_sql,
)
from nexus.services.source_types import LATEST_ORDER_SQL
from nexus.services.x_identity import native_x_article_id
from nexus.services.x_source import x_article_content_facts, x_source_contexts

_DOCUMENT_KINDS = ("web_article", "epub", "pdf")
_TRANSCRIPT_KINDS = ("video", "podcast_episode")

# Every fact a projection decides on; the detail's prose and stamps are _DETAIL_SQL's.
_ROWS_SQL = f"""
    WITH visible_media AS ({visible_media_ids_cte_sql()})
    SELECT m.id, m.kind, m.title, m.original_published_date,
        m.processing_status::text AS persisted_status, m.last_error_code,
        m.canonical_source_url, m.external_playback_url, m.provider, m.provider_id,
        m.created_by_user_id = :viewer_id AS is_creator, rp.generation AS reader_generation,
        {media_file_exists_sql("m.id")} AS has_file,
        EXISTS (SELECT 1 FROM ({ready_publication_rows_sql()}) publication
                WHERE publication.media_id = m.id) AS publication_ready,
        ({non_system_media_ref_exists_sql("m.id")} OR {media_grant_path_exists_sql("m.id")})
            AS can_delete,
        {source_repairable_sql("m")} AS repairable,
        attempt.id AS attempt_id, attempt.status AS attempt_status,
        attempt.error_code AS attempt_error_code, attempt.source_type,
        attempt.job_id AS attempt_job_id,
        mcis.revision AS index_revision, mcis.status AS index_status,
        mcis.status_reason AS index_reason,
        (SELECT dead.id FROM background_jobs dead
         WHERE dead.kind = 'media_content_reindex_job' AND dead.status = 'dead'
           AND dead.payload @> jsonb_build_object('media_id', m.id::text, 'revision', mcis.revision)
         ORDER BY dead.id LIMIT 1) AS dead_index_job_id,
        mts.transcript_state, mts.transcript_coverage, mts.transcript_origin,
        pls.position_ms, pls.duration_ms AS listened_ms, pe.duration_seconds AS feed_seconds
    FROM media m
    JOIN visible_media vm ON vm.media_id = m.id
    LEFT JOIN LATERAL (
        SELECT id, status, error_code, source_type, job_id FROM media_source_attempts
        WHERE media_id = m.id ORDER BY {LATEST_ORDER_SQL} LIMIT 1
    ) attempt ON true
    LEFT JOIN media_transcript_states mts ON mts.media_id = m.id
    LEFT JOIN reader_publications rp ON rp.media_id = m.id
    LEFT JOIN content_index_states mcis ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
    LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
    LEFT JOIN podcast_listening_states pls ON pls.media_id = m.id AND pls.user_id = :viewer_id
    WHERE m.id = ANY(:media_ids)
"""


def _rows(db: Session, viewer_id: UUID, media_ids: Sequence[UUID]) -> dict[UUID, Row[Any]]:
    """The visible ones among ``media_ids``, in input order."""
    ids = list(dict.fromkeys(media_ids))
    if not ids:
        return {}
    found = {
        row.id: row
        for row in db.execute(text(_ROWS_SQL), {"viewer_id": viewer_id, "media_ids": ids})
    }
    return {media_id: found[media_id] for media_id in ids if media_id in found}


def _status(row: Row[Any]) -> MediaProcessingStatus:
    # Dead source work suspends only a media with nothing readable; a readable publication,
    # an x article's retained copy included, keeps its stored status.
    readable = publication_readable(
        row.kind, has_file=row.has_file, publication_ready=row.publication_ready
    )
    return "suspended" if row.repairable and not readable else row.persisted_status


def _retrieval_status(row: Row[Any]) -> str:
    return "suspended" if row.dead_index_job_id is not None else (row.index_status or "pending")


def _summaries(
    db: Session,
    viewer_id: UUID,
    rows: dict[UUID, Row[Any]],
    states: dict[UUID, projection.ReadState],
) -> dict[UUID, MediaSummaryOut]:
    credits = load_contributor_credits_for_media(db, list(rows))
    documents = [media_id for media_id, row in rows.items() if row.kind in _DOCUMENT_KINDS]
    estimates = load_reading_time_estimates(db, viewer_id=viewer_id, media_ids=documents)
    articles = x_article_content_facts(db, media_ids=list(rows))
    summaries: dict[UUID, MediaSummaryOut] = {}
    for media_id, row in rows.items():
        kind = MediaKind(row.kind)
        duration: MediaDurationOut | None = None
        if kind == MediaKind.podcast_episode:
            duration = projection.listening_duration(
                position_ms=row.position_ms or 0,
                listening_duration_ms=row.listened_ms,
                feed_duration_seconds=row.feed_seconds,
            )
        elif media_id in estimates:
            duration = MediaDurationOut(modality="Read", estimate=estimates[media_id])
        state = states[media_id]
        summaries[media_id] = MediaSummaryOut(
            media_id=media_id,
            media_kind=kind,
            title=row.title,
            contributors=credits[media_id],
            original_published_date=row.original_published_date,
            processing_status=_status(row),
            consumption=ConsumptionOut(state=state.state, progress=state.progress),
            duration=duration,
            x_article_content=articles.get(media_id),
        )
    return summaries


def media_summaries(
    db: Session, *, viewer_id: UUID, media_ids: Sequence[UUID]
) -> dict[UUID, MediaSummaryOut]:
    """The summary every list renders, for the visible ones among ``media_ids``, in order."""
    rows = _rows(db, viewer_id, media_ids)
    if not rows:
        return {}
    states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=list(rows))
    return _summaries(db, viewer_id, rows, states)


@dataclass(frozen=True, slots=True)
class CompactMediaTarget:
    summary: MediaSummaryOut
    image_url: str | None
    href: str


def hydrate_compact_media_targets(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, CompactMediaTarget]:
    """Summaries with their episode's artwork and their activation href (suggestions)."""
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.routing import resource_activations_for_refs

    summaries = media_summaries(db, viewer_id=viewer_id, media_ids=media_ids)
    if not summaries:
        return {}
    artwork = {
        row.media_id: row.image_url
        for row in db.execute(
            text("""
                SELECT pe.media_id, p.image_url FROM podcast_episodes pe
                JOIN podcasts p ON p.id = pe.podcast_id WHERE pe.media_id = ANY(:ids)
            """),
            {"ids": list(summaries)},
        )
    }
    refs = {media_id: ResourceRef(scheme="media", id=media_id) for media_id in summaries}
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=list(refs.values()))
    return {
        media_id: CompactMediaTarget(
            summary=summary,
            image_url=artwork.get(media_id),
            href=str(activations[refs[media_id].uri].href),
        )
        for media_id, summary in summaries.items()
    }


def _recovery(
    row: Row[Any], *, is_creator: bool, article_content: XArticleContent | None
) -> tuple[SourceRecoveryAnswer, SearchRecoveryAnswer, bool]:
    """The source and search owners' answers to this viewer (an offer, why none, or
    nothing), and whether the source refreshes."""
    source: SourceRecoveryAnswer = None
    search: SearchRecoveryAnswer = None
    refreshable = False
    if row.attempt_id is not None:
        facts = SourceRecoveryFacts(
            attempt_id=row.attempt_id,
            attempt_status=row.attempt_status,
            error_code=row.attempt_error_code,
            source_type=row.source_type,
            processing_status=row.persisted_status,
            job_id=row.attempt_job_id,
            repairable=row.repairable,
            is_creator=is_creator,
            native_article_id=native_x_article_id(
                kind=row.kind, provider=row.provider, provider_id=row.provider_id
            ),
            article_content=article_content,
        )
        source = source_recovery(facts)
        refreshable = source_refreshable(facts)
    if row.index_revision is not None:
        search = search_recovery(
            SearchRecoveryFacts(
                revision=row.index_revision,
                dead_job_id=row.dead_index_job_id,
                is_creator=is_creator,
                ready_for_reading=row.persisted_status == "ready_for_reading",
            )
        )
    return source, search, refreshable


def _pdf_readiness(db: Session, rows: dict[UUID, Row[Any]]) -> dict[UUID, bool]:
    pdfs = [media_id for media_id, row in rows.items() if row.kind == "pdf"]
    return batch_pdf_quote_text_ready(db, pdfs) if pdfs else {}


def _reading(row: Row[Any], pdf_ready: dict[UUID, bool]) -> tuple[bool, bool, bool]:
    return reading_capabilities(
        row.kind,
        has_file=row.has_file,
        publication_ready=row.publication_ready,
        pdf_quote_text_ready=pdf_ready.get(row.id, False),
        transcript_state=row.transcript_state,
        transcript_coverage=row.transcript_coverage,
    )


def _capabilities(
    row: Row[Any], pdf_ready: dict[UUID, bool], article_content: XArticleContent | None
) -> CapabilitiesOut:
    can_read, can_highlight, can_quote = _reading(row, pdf_ready)
    source, _, _ = _recovery(row, is_creator=row.is_creator, article_content=article_content)
    return CapabilitiesOut(
        can_read=can_read,
        can_highlight=can_highlight,
        can_quote=can_quote,
        can_retry=isinstance(source, RetrySourceOffer),
        can_replace_x_article=row.is_creator
        and native_x_article_id(kind=row.kind, provider=row.provider, provider_id=row.provider_id)
        is not None,
    )


@dataclass(frozen=True, slots=True)
class MediaFacts:
    """What the action menu and Imports decide on, for one visible media. ``creator_*`` is
    what its creator would be offered, so a blocked action stays discoverable."""

    summary: MediaSummaryOut
    canonical_source_url: str | None
    audio_url: str | None
    """A podcast episode's https enclosure: what Android downloads for offline listening."""
    transcript_state: str | None
    has_file: bool
    is_creator: bool
    can_read: bool
    can_search: bool
    can_play: bool
    can_delete: bool
    progress_resettable: bool
    metadata: MetadataEnrichmentView
    source_offer: RetrySourceOffer | RepairSourceOffer | None
    source_restriction: SourceRecoveryRestriction | None
    """Why the source owner offers this viewer nothing, when it says (Imports reads it)."""
    creator_source_offer: RetrySourceOffer | RepairSourceOffer | None
    search_offer: RepairSearchOffer | None
    search_restriction: Literal["NotOwner"] | None
    creator_search_offer: RepairSearchOffer | None
    source_attempt_id: UUID | None
    """The latest source attempt: what a refresh replaces."""
    refreshable: bool


def media_facts(
    db: Session, *, viewer_id: UUID, media_ids: Sequence[UUID]
) -> dict[UUID, MediaFacts]:
    """The facts of the visible ones among ``media_ids``, in order."""
    rows = _rows(db, viewer_id, media_ids)
    if not rows:
        return {}
    states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=list(rows))
    summaries = _summaries(db, viewer_id, rows, states)
    metadata = metadata_enrichment_views(db, viewer_id=viewer_id, media_ids=list(rows))
    pdf_ready = _pdf_readiness(db, rows)
    facts: dict[UUID, MediaFacts] = {}
    for media_id, row in rows.items():
        can_read, _, can_quote = _reading(row, pdf_ready)
        article_content = summaries[media_id].x_article_content
        source, search, refreshable = _recovery(
            row, is_creator=row.is_creator, article_content=article_content
        )
        creator_source, creator_search, _ = _recovery(
            row, is_creator=True, article_content=article_content
        )
        enclosure = row.external_playback_url if row.kind == "podcast_episode" else None
        facts[media_id] = MediaFacts(
            summary=summaries[media_id],
            canonical_source_url=row.canonical_source_url,
            audio_url=enclosure if enclosure and enclosure.startswith("https://") else None,
            transcript_state=row.transcript_state,
            has_file=row.has_file,
            is_creator=row.is_creator,
            can_read=can_read,
            can_search=can_quote and _retrieval_status(row) == "ready",
            can_play=row.external_playback_url is not None
            and (row.kind in _TRANSCRIPT_KINDS or row.persisted_status == "ready_for_reading"),
            can_delete=row.can_delete,
            progress_resettable=states[media_id].resettable,
            metadata=metadata[media_id],
            source_offer=None if isinstance(source, str) else source,
            source_restriction=source if isinstance(source, str) else None,
            creator_source_offer=None if isinstance(creator_source, str) else creator_source,
            search_offer=None if isinstance(search, str) else search,
            search_restriction=search if isinstance(search, str) else None,
            creator_search_offer=None if isinstance(creator_search, str) else creator_search,
            source_attempt_id=row.attempt_id,
            refreshable=refreshable,
        )
    return facts


_DETAIL_SQL = """
    SELECT m.requested_url, m.canonical_url, m.edition_published_date, m.edition_isbn,
        m.publisher, m.language, m.description, m.authors_manually_managed,
        m.metadata_enriched_at, m.created_at, m.updated_at,
        pe.description_html, pe.description_text
    FROM media m LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
    WHERE m.id = :media_id
"""


def get_media_for_viewer(db: Session, viewer_id: UUID, media_id: UUID) -> MediaOut:
    """One media's detail; ``E_MEDIA_NOT_FOUND`` for anything the viewer cannot read (I1)."""
    rows = _rows(db, viewer_id, [media_id])
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = rows[media_id]
    detail = db.execute(text(_DETAIL_SQL), {"media_id": media_id}).one()
    states = projection.media_read_states(db, viewer_id=viewer_id, media_ids=[media_id])
    summary = _summaries(db, viewer_id, rows, states)[media_id]
    chapters = db.execute(
        text("""
            SELECT chapter_idx, title, t_start_ms, t_end_ms, url, image_url
            FROM podcast_episode_chapters WHERE media_id = :media_id ORDER BY chapter_idx
        """),
        {"media_id": media_id},
    ).mappings()
    return MediaOut(
        id=media_id,
        kind=summary.media_kind,
        title=row.title,
        canonical_source_url=row.canonical_source_url,
        provider=row.provider,
        provider_id=row.provider_id,
        requested_url=detail.requested_url,
        canonical_url=detail.canonical_url,
        processing_status=summary.processing_status,
        transcript_state=row.transcript_state,
        transcript_coverage=row.transcript_coverage,
        transcript_origin=row.transcript_origin,
        retrieval_status=_retrieval_status(row),
        retrieval_status_reason=row.index_reason,
        last_error_code=row.last_error_code,
        playback_source=derive_playback_source(
            kind=row.kind,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        ),
        listening_state=None
        if row.position_ms is None
        else ListeningStateOut(position_ms=row.position_ms, duration_ms=row.listened_ms),
        chapters=[PodcastEpisodeChapterOut.model_validate(dict(chapter)) for chapter in chapters],
        capabilities=_capabilities(row, _pdf_readiness(db, rows), summary.x_article_content),
        contributors=summary.contributors,
        author_mode="manual" if detail.authors_manually_managed else "automatic",
        original_published_date=row.original_published_date,
        edition_published_date=detail.edition_published_date,
        edition_isbn=detail.edition_isbn,
        duration=summary.duration,
        publisher=detail.publisher,
        language=detail.language,
        description=detail.description,
        description_html=detail.description_html,
        description_text=detail.description_text,
        metadata_enriched_at=detail.metadata_enriched_at,
        metadata_enrichment=metadata_enrichment_views(
            db, viewer_id=viewer_id, media_ids=[media_id]
        )[media_id],
        x_source_context=x_source_contexts(db, media_ids=[media_id]).get(media_id),
        x_article_content=summary.x_article_content,
        reader_generation=row.reader_generation,
        consumption=summary.consumption,
        last_engaged_at=projection.engagement_recency(
            db, viewer_id=viewer_id, media_ids=[media_id]
        ).get(media_id),
        player_descriptor=projection.player_descriptors(
            db, viewer_id=viewer_id, media_ids=[media_id]
        ).get(media_id),
        created_at=detail.created_at,
        updated_at=detail.updated_at,
    )


def _in_flight(row: Row[Any], status: str, retrieval: str) -> bool:
    """Source work, a requested transcript or a readable media's index is running (I15); an
    episode or video waiting on a transcript nobody requested is not. An unsettled latest
    attempt is source work whatever the status: a refresh keeps an x article readable, and
    its end commits the title job the pane follows next."""
    if status == "extracting":
        return True
    if row.attempt_status in ("accepted", "queued", "running") and not row.repairable:
        return True
    if status == "pending":
        return row.kind not in _TRANSCRIPT_KINDS or row.transcript_state in ("queued", "running")
    return (
        status == "ready_for_reading"
        and row.index_status in ("pending", "indexing")
        and retrieval != "suspended"
    )


def read_processing_snapshot(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> MediaProcessingSnapshotOut:
    """The mounted media's current work and publication; unreadable: not found."""
    rows = _rows(db, viewer_id, [media_id])
    if not rows:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = rows[media_id]
    status, retrieval = _status(row), _retrieval_status(row)
    return MediaProcessingSnapshotOut(
        processing_status=status,
        last_error_code=row.last_error_code,
        retrieval_status=retrieval,
        retrieval_status_reason=row.index_reason,
        capabilities=_capabilities(
            row,
            _pdf_readiness(db, rows),
            x_article_content_facts(db, media_ids=[media_id]).get(media_id),
        ),
        transcript_state=row.transcript_state,
        transcript_coverage=row.transcript_coverage,
        reader_generation=row.reader_generation,
        work_in_flight=_in_flight(row, status, retrieval),
    )
