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
from collections import Counter
from dataclasses import dataclass, replace
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Library,
    LibraryEntry,
    Media,
    Membership,
    OracleCorpusPublication,
    OracleCorpusSource,
    OraclePassageAnchor,
    OraclePlate,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.oracle.manifest import (
    OracleCorpusManifestAnchor,
    OracleCorpusManifestWork,
    OracleManifest,
    OraclePlateManifestEntry,
    oracle_plate_storage_slug,
)
from nexus.services import library_entries, library_governance, oracle_plates
from nexus.services.content_indexing import request_media_content_reindex
from nexus.services.image_validation import MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION
from nexus.services.media_source_ingest import (
    accept_system_url_source,
    repair_source_for_system_media,
)
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.storage.client import StorageClientBase
from nexus.storage.paths import build_oracle_plate_storage_path, ext_for_content_type

ORACLE_CORPUS_KEY = "oracle"
ORACLE_CORPUS_SYSTEM_KEY = "oracle_corpus"
ORACLE_CORPUS_LIBRARY_NAME = "Oracle Corpus"
ORACLE_PUBLICATION_KEY = "current"
_ORACLE_MANIFEST_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
# Length of the text-quote prefix used to locate a passage's chunk during anchor resolution.
_ANCHOR_NEEDLE_CHARS = 80
_ANCHOR_TOKEN_PREFIX_TOKENS = 18
_ANCHOR_MIN_TOKEN_WINDOW_TOKENS = 6
_ANCHOR_TOKEN_WINDOW_MATCH_RATIO = 0.78
_ANCHOR_TOKEN_WINDOW_EXTRA_TOKENS = 4
_ANCHOR_TOKEN_WINDOW_MISSING_TOKENS = 2
_ANCHOR_TOKEN_ALIASES: dict[str, str] = {
    "thro": "through",
    "tho": "though",
    "neer": "never",
    "oer": "over",
    "eer": "ever",
}


@dataclass(frozen=True)
class AnchorNeedle:
    normalized_prefix: str
    token_prefix: tuple[str, ...]


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


@dataclass(frozen=True)
class OracleCorpusRemovalPlan:
    """Unsupported destructive differences between published support and a manifest."""

    work_keys: tuple[str, ...]
    anchor_keys: tuple[tuple[str, str], ...]
    plate_source_urls: tuple[str, ...]

    @property
    def has_removals(self) -> bool:
        return bool(self.work_keys or self.anchor_keys or self.plate_source_urls)


@dataclass(frozen=True)
class OraclePublicationMarker:
    corpus_key: str
    manifest_digest: str
    embedding_provider: str
    embedding_model: str


@dataclass(frozen=True)
class OracleCorpusDatabaseInspection:
    """Closed PostgreSQL proof safe to carry across the R2 read boundary."""

    manifest_digest: str
    embedding_provider: str
    embedding_model: str
    readiness: OracleCorpusReadiness
    removals: OracleCorpusRemovalPlan
    errors: tuple[str, ...]
    published: bool
    publication: OraclePublicationMarker | None
    plate_storage_metadata: tuple[oracle_plates.OraclePlateMetadata, ...]


@dataclass(frozen=True)
class OracleCorpusInspection:
    """Exact PostgreSQL/R2 proof consumed by the short publication transaction."""

    manifest_digest: str
    embedding_provider: str
    embedding_model: str
    readiness: OracleCorpusReadiness
    removals: OracleCorpusRemovalPlan
    errors: tuple[str, ...]
    published: bool
    publication: OraclePublicationMarker | None

    @property
    def support_ready(self) -> bool:
        return (
            self.readiness.status == "ready" and not self.removals.has_removals and not self.errors
        )


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
        source.updated_at = db.execute(select(func.now())).scalar_one()
        if source_changed and previous_media_id != source.media_id:
            media_ids = sorted({previous_media_id, source.media_id})
            if library_entries.lock_media_rows_in_order(db, media_ids) != media_ids:
                # justify-service-invariant-check: both ids come from durable Oracle
                # source acceptance/mapping rows and must still name media here.
                # justify-defect: a retained Oracle source may not point at missing media.
                raise AssertionError("Oracle source replacement media is missing")
            if library_governance.lock_library_rows_in_order(db, [library_id]) != [library_id]:
                # justify-service-invariant-check: the caller supplies the durable Oracle
                # system library selected for this source mutation.
                # justify-defect: replacement cannot continue without its owning library.
                raise AssertionError("Oracle corpus library is missing")
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
        created = accepted.idempotency_outcome == "created"

    # System attach: corpus media live only in the corpus library (not the user's
    # default). Routed through the narrow trusted system command (spec S4.3) rather
    # than the raw insertion primitive directly, so seeding is inseparable from the
    # system-library-destination guard even if a future corpus_key stops routing
    # through ensure_oracle_corpus_library.
    library_entries.seed_media_into_system_library(db, library_id, source.media_id)
    if not created:
        _repair_reused_corpus_media(db, owner_user_id=owner_user_id, source=source)

    for manifest_anchor in work.passage_anchors:
        desired_selector = _manifest_anchor_selector(manifest_anchor)
        anchor = db.execute(
            select(OraclePassageAnchor).where(
                OraclePassageAnchor.corpus_source_id == source.id,
                OraclePassageAnchor.passage_key == manifest_anchor.passage_key,
            )
        ).scalar_one_or_none()
        if anchor is not None:
            if anchor.selector != desired_selector:
                anchor.selector = desired_selector
                anchor.current_evidence_span_id = None
                anchor.current_content_chunk_id = None
                anchor.resolution_status = "pending"
                anchor.resolution_error = None
                anchor.resolved_at = None
            anchor.display_label = manifest_anchor.display_label
            anchor.tags = list(manifest_anchor.tags)
            anchor.phase_hints = list(manifest_anchor.phase_hints)
            anchor.updated_at = db.execute(select(func.now())).scalar_one()
        else:
            db.add(
                OraclePassageAnchor(
                    corpus_source_id=source.id,
                    passage_key=manifest_anchor.passage_key,
                    display_label=manifest_anchor.display_label,
                    selector=desired_selector,
                    tags=list(manifest_anchor.tags),
                    phase_hints=list(manifest_anchor.phase_hints),
                )
            )
    db.flush()
    return OracleCorpusSeedResult(
        work_key=work.work_key,
        media_id=source.media_id,
        created_media=created,
        anchor_count=len(work.passage_anchors),
    )


def _manifest_anchor_selector(anchor: OracleCorpusManifestAnchor) -> dict[str, object]:
    return anchor.selector.model_dump(mode="json")


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
            request_media_content_reindex(
                db,
                media_id=media.id,
                reason="oracle_corpus_seed",
                request_id=request_id,
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
    chunk_cache: dict[UUID, list[tuple[UUID, UUID | None, str, tuple[str, ...], Counter[str]]]] = {}
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


def _get_oracle_corpus_support_readiness(db: Session) -> OracleCorpusReadiness:
    """Derive unpublished support readiness from the shared corpus substrate.

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


def inspect_oracle_corpus_database(
    db: Session,
    *,
    manifest: OracleManifest,
    owner_user_id: UUID,
) -> OracleCorpusDatabaseInspection:
    """Read exact desired PostgreSQL state without touching HTTP or R2."""
    provider = current_transcript_embedding_provider()
    model = current_transcript_embedding_model()
    readiness = _get_oracle_corpus_support_readiness(db)
    removals = plan_oracle_manifest_removals(db, manifest=manifest)
    errors: list[str] = []

    library = db.execute(
        select(Library).where(Library.system_key == ORACLE_CORPUS_SYSTEM_KEY)
    ).scalar_one_or_none()
    if library is None:
        errors.append("Oracle system library is missing")
    else:
        if (
            library.owner_user_id != owner_user_id
            or library.name != ORACLE_CORPUS_LIBRARY_NAME
            or library.is_default
        ):
            errors.append("Oracle system library identity does not match")
        memberships = list(
            db.execute(
                select(Membership.user_id, Membership.role)
                .where(Membership.library_id == library.id)
                .order_by(Membership.user_id.asc())
            ).tuples()
        )
        if memberships != [(owner_user_id, "admin")]:
            errors.append("Oracle system library membership does not match")

    sources = list(
        db.execute(
            select(OracleCorpusSource)
            .where(OracleCorpusSource.corpus_key == ORACLE_CORPUS_KEY)
            .order_by(OracleCorpusSource.work_key.asc())
        ).scalars()
    )
    sources_by_key = {source.work_key: source for source in sources}
    for work in manifest.works:
        source = sources_by_key.get(work.work_key)
        if source is None:
            errors.append(f"Oracle work {work.work_key!r} is missing")
            continue
        media = db.get(Media, source.media_id)
        if not _oracle_source_matches_manifest(
            source,
            media,
            work,
            library_id=readiness.library_id,
            owner_user_id=owner_user_id,
        ):
            errors.append(f"Oracle work {work.work_key!r} metadata does not match")

    desired_media_ids = {
        source.media_id
        for work in manifest.works
        if (source := sources_by_key.get(work.work_key)) is not None
    }
    if library is not None:
        entries = list(
            db.execute(
                select(LibraryEntry.media_id, LibraryEntry.podcast_id)
                .where(LibraryEntry.library_id == library.id)
                .order_by(LibraryEntry.position.asc(), LibraryEntry.id.asc())
            ).tuples()
        )
        actual_media_ids = {media_id for media_id, _podcast_id in entries if media_id is not None}
        if (
            actual_media_ids != desired_media_ids
            or len(entries) != len(desired_media_ids)
            or any(podcast_id is not None for _media_id, podcast_id in entries)
        ):
            errors.append("Oracle system library entries do not match")

    anchors = list(
        db.execute(
            select(OracleCorpusSource.work_key, OraclePassageAnchor)
            .join(
                OraclePassageAnchor,
                OraclePassageAnchor.corpus_source_id == OracleCorpusSource.id,
            )
            .where(OracleCorpusSource.corpus_key == ORACLE_CORPUS_KEY)
            .order_by(OracleCorpusSource.work_key.asc(), OraclePassageAnchor.passage_key.asc())
        ).all()
    )
    anchors_by_key = {(work_key, anchor.passage_key): anchor for work_key, anchor in anchors}
    for work in manifest.works:
        for desired_anchor in work.passage_anchors:
            anchor_key = (work.work_key, desired_anchor.passage_key)
            anchor = anchors_by_key.get(anchor_key)
            if anchor is None:
                errors.append(
                    f"Oracle anchor {work.work_key!r}/{desired_anchor.passage_key!r} is missing"
                )
                continue
            if not _oracle_anchor_matches_manifest(anchor, desired_anchor):
                errors.append(
                    f"Oracle anchor {work.work_key!r}/{desired_anchor.passage_key!r} "
                    "metadata does not match"
                )

    plates = list(db.execute(select(OraclePlate).order_by(OraclePlate.source_url.asc())).scalars())
    plates_by_source_url = {plate.source_url: plate for plate in plates}
    for desired_plate in manifest.plates:
        plate = plates_by_source_url.get(desired_plate.resolved_source_url)
        if plate is None:
            errors.append(f"Oracle plate {desired_plate.resolved_source_url!r} is missing")
            continue
        if not _oracle_plate_matches_manifest(plate, desired_plate):
            errors.append(
                f"Oracle plate {desired_plate.resolved_source_url!r} metadata does not match"
            )

    publication = read_oracle_publication(db)
    return OracleCorpusDatabaseInspection(
        manifest_digest=manifest.manifest_digest,
        embedding_provider=provider,
        embedding_model=model,
        readiness=readiness,
        removals=removals,
        errors=tuple(errors),
        published=_publication_marker_matches(
            publication,
            expected_manifest_digest=manifest.manifest_digest,
            embedding_provider=provider,
            embedding_model=model,
        ),
        publication=publication,
        plate_storage_metadata=oracle_plates.oracle_plate_storage_metadata(db),
    )


def complete_oracle_corpus_inspection(
    database: OracleCorpusDatabaseInspection,
    *,
    storage_client: StorageClientBase,
) -> OracleCorpusInspection:
    """Add pure R2 proof only after the caller has closed the PostgreSQL transaction."""
    plate_storage = oracle_plates.validate_oracle_plate_storage_metadata(
        database.plate_storage_metadata,
        storage_client=storage_client,
    )
    return OracleCorpusInspection(
        manifest_digest=database.manifest_digest,
        embedding_provider=database.embedding_provider,
        embedding_model=database.embedding_model,
        readiness=database.readiness,
        removals=database.removals,
        errors=database.errors
        + tuple(f"Oracle plate object is invalid: {reason}" for reason in plate_storage.invalid),
        published=database.published,
        publication=database.publication,
    )


def plan_oracle_manifest_removals(
    db: Session, *, manifest: OracleManifest
) -> OracleCorpusRemovalPlan:
    """Compute unsupported removals by stable business key; never mutate."""
    desired_work_keys = {work.work_key for work in manifest.works}
    actual_work_keys = set(
        db.execute(
            select(OracleCorpusSource.work_key).where(
                OracleCorpusSource.corpus_key == ORACLE_CORPUS_KEY
            )
        ).scalars()
    )
    desired_anchor_keys = {
        (work.work_key, anchor.passage_key)
        for work in manifest.works
        for anchor in work.passage_anchors
    }
    actual_anchor_keys = set(
        db.execute(
            select(OracleCorpusSource.work_key, OraclePassageAnchor.passage_key)
            .join(
                OraclePassageAnchor,
                OraclePassageAnchor.corpus_source_id == OracleCorpusSource.id,
            )
            .where(OracleCorpusSource.corpus_key == ORACLE_CORPUS_KEY)
        ).tuples()
    )
    desired_plate_urls = {plate.resolved_source_url for plate in manifest.plates}
    actual_plate_urls = set(db.execute(select(OraclePlate.source_url)).scalars())
    return OracleCorpusRemovalPlan(
        work_keys=tuple(sorted(actual_work_keys - desired_work_keys)),
        anchor_keys=tuple(sorted(actual_anchor_keys - desired_anchor_keys)),
        plate_source_urls=tuple(sorted(actual_plate_urls - desired_plate_urls)),
    )


def reject_oracle_manifest_removals(
    db: Session, *, manifest: OracleManifest
) -> OracleCorpusRemovalPlan:
    """Reject the 80/20 boundary before any support or publication mutation."""
    plan = plan_oracle_manifest_removals(db, manifest=manifest)
    if plan.has_removals:
        raise ValueError(
            "Oracle manifest would remove active support: "
            f"works={list(plan.work_keys)!r}, anchors={list(plan.anchor_keys)!r}, "
            f"plates={list(plan.plate_source_urls)!r}"
        )
    return plan


def oracle_publication_matches(
    db: Session,
    *,
    expected_manifest_digest: str,
    embedding_provider: str,
    embedding_model: str,
) -> bool:
    """Fail closed unless the sole marker is valid and exactly matches runtime identity."""
    if not _valid_publication_values(expected_manifest_digest, embedding_provider, embedding_model):
        return False
    try:
        marker = read_oracle_publication(db)
    except ValueError:
        return False
    return _publication_marker_matches(
        marker,
        expected_manifest_digest=expected_manifest_digest,
        embedding_provider=embedding_provider,
        embedding_model=embedding_model,
    )


def read_oracle_publication(db: Session) -> OraclePublicationMarker | None:
    """Read and validate the only publication domain value accepted by code."""
    rows = list(db.execute(select(OracleCorpusPublication)).scalars())
    if not rows:
        return None
    if len(rows) != 1 or rows[0].corpus_key != ORACLE_PUBLICATION_KEY:
        raise ValueError("Oracle publication table contains unsupported marker keys")
    row = rows[0]
    if not _valid_publication_values(
        row.manifest_digest,
        row.embedding_provider,
        row.embedding_model,
    ):
        raise ValueError("Oracle publication marker contains malformed values")
    return OraclePublicationMarker(
        corpus_key=row.corpus_key,
        manifest_digest=row.manifest_digest,
        embedding_provider=row.embedding_provider,
        embedding_model=row.embedding_model,
    )


def publish_oracle_corpus(db: Session, *, inspection: OracleCorpusInspection) -> None:
    """Insert the singleton marker last; caller owns the short commit."""
    if inspection.removals.has_removals:
        raise ValueError("Oracle corpus cannot publish because the manifest would remove support")
    if not inspection.support_ready:
        raise ValueError("Oracle corpus support is not ready")
    if not _valid_publication_values(
        inspection.manifest_digest,
        inspection.embedding_provider,
        inspection.embedding_model,
    ):
        raise ValueError("Oracle publication values are malformed")
    marker = read_oracle_publication(db)
    if marker is not None:
        if _publication_marker_matches(
            marker,
            expected_manifest_digest=inspection.manifest_digest,
            embedding_provider=inspection.embedding_provider,
            embedding_model=inspection.embedding_model,
        ):
            return
        raise ValueError("Existing Oracle publication must be explicitly unpublished first")
    db.add(
        OracleCorpusPublication(
            corpus_key=ORACLE_PUBLICATION_KEY,
            manifest_digest=inspection.manifest_digest,
            embedding_provider=inspection.embedding_provider,
            embedding_model=inspection.embedding_model,
        )
    )
    db.flush()


def unpublish_oracle_corpus(db: Session) -> bool:
    """Delete only the valid current marker; caller owns the short commit."""
    marker = read_oracle_publication(db)
    if marker is None:
        return False
    row = db.get(OracleCorpusPublication, marker.corpus_key)
    if row is None:
        raise AssertionError("Oracle publication marker disappeared while unpublishing")
    db.delete(row)
    db.flush()
    return True


def require_oracle_corpus_unpublished(db: Session) -> None:
    """Guard every support mutator behind the host's committed unpublish phase."""
    if read_oracle_publication(db) is not None:
        raise ValueError("Oracle corpus must be unpublished before support reconciliation")


def get_oracle_corpus_readiness(
    db: Session, *, expected_manifest_digest: str | None = None
) -> OracleCorpusReadiness:
    """Fail closed unless support and the baked current publication marker are ready."""
    support = _get_oracle_corpus_support_readiness(db)
    if expected_manifest_digest is None:
        from nexus.runtime_health import get_runtime_identity

        expected_manifest_digest = get_runtime_identity().expected_oracle_manifest_digest
    published = oracle_publication_matches(
        db,
        expected_manifest_digest=expected_manifest_digest,
        embedding_provider=current_transcript_embedding_provider(),
        embedding_model=current_transcript_embedding_model(),
    )
    if support.status == "ready" and published:
        return support
    return replace(support, status="not_ready")


def _oracle_source_matches_manifest(
    source: OracleCorpusSource,
    media: Media | None,
    work: OracleCorpusManifestWork,
    *,
    library_id: UUID | None,
    owner_user_id: UUID,
) -> bool:
    return (
        media is not None
        and media.kind == work.source_media_kind
        and media.created_by_user_id == owner_user_id
        and source.library_id == library_id
        and source.title == work.title
        and source.author_text == work.author_text
        and source.source_repository == work.source_repository
        and source.source_url == work.source_url
        and source.source_download_url == work.source_download_url
        and source.source_media_kind == work.source_media_kind
        and source.display_order == work.display_order
    )


def _oracle_anchor_matches_manifest(
    anchor: OraclePassageAnchor, desired: OracleCorpusManifestAnchor
) -> bool:
    return (
        anchor.display_label == desired.display_label
        and anchor.selector == _manifest_anchor_selector(desired)
        and anchor.tags == list(desired.tags)
        and anchor.phase_hints == list(desired.phase_hints)
    )


def _oracle_plate_matches_manifest(plate: OraclePlate, desired: OraclePlateManifestEntry) -> bool:
    try:
        expected_storage_key = build_oracle_plate_storage_path(
            oracle_plate_storage_slug(desired),
            ext_for_content_type(plate.content_type),
        )
    except ValueError:
        return False
    return (
        plate.source_repository == desired.source_repository
        and plate.source_page_url == desired.source_url
        and plate.source_url == desired.resolved_source_url
        and plate.license_text == desired.license_text
        and plate.artist == desired.artist
        and plate.work_title == desired.work_title
        and plate.year == desired.year
        and plate.attribution_text == desired.attribution_text
        and plate.storage_key == expected_storage_key
        and plate.tags == list(desired.tags)
    )


def _valid_publication_values(
    manifest_digest: str, embedding_provider: str, embedding_model: str
) -> bool:
    return (
        _ORACLE_MANIFEST_DIGEST.fullmatch(manifest_digest) is not None
        and bool(embedding_provider.strip())
        and bool(embedding_model.strip())
    )


def _publication_marker_matches(
    marker: OraclePublicationMarker | None,
    *,
    expected_manifest_digest: str,
    embedding_provider: str,
    embedding_model: str,
) -> bool:
    return (
        marker is not None
        and marker.manifest_digest == expected_manifest_digest
        and marker.embedding_provider == embedding_provider
        and marker.embedding_model == embedding_model
    )


def _find_anchor_chunk_match(
    db: Session,
    *,
    media_id: UUID,
    needle: AnchorNeedle,
    cache: dict[UUID, list[tuple[UUID, UUID | None, str, tuple[str, ...], Counter[str]]]],
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
        media_chunks: list[tuple[UUID, UUID | None, str, tuple[str, ...], Counter[str]]] = []
        for row in rows:
            chunk_tokens = tuple(_anchor_match_tokens(row["chunk_text"] or ""))
            media_chunks.append(
                (
                    row["chunk_id"],
                    row["span_id"],
                    _normalize_anchor_match_text(row["chunk_text"] or ""),
                    chunk_tokens,
                    Counter(chunk_tokens),
                )
            )
        cache[media_id] = media_chunks
    for chunk_id, span_id, normalized_text, _chunk_tokens, _chunk_token_counts in cache[media_id]:
        if needle.normalized_prefix and needle.normalized_prefix in normalized_text:
            return (chunk_id, span_id)
    selector_window_size = min(len(needle.token_prefix), _ANCHOR_TOKEN_PREFIX_TOKENS)
    selector_window = needle.token_prefix[:selector_window_size]
    min_match_count = _anchor_min_token_matches(selector_window_size)
    for chunk_id, span_id, _normalized_text, chunk_tokens, chunk_token_counts in cache[media_id]:
        if _anchor_token_multiset_overlap(selector_window, chunk_token_counts) < min_match_count:
            continue
        if _anchor_token_window_matches(needle.token_prefix, chunk_tokens):
            return (chunk_id, span_id)
    return None


def _anchor_needle(selector: dict[str, object]) -> AnchorNeedle | None:
    """The source-local text-quote needles used to locate a passage's chunk.

    Public-domain editions differ in line breaks, punctuation style, apostrophes, and
    Unicode dashes. The resolver still requires same-media ready chunks, but quote
    comparison first normalizes presentation differences, then allows a small token
    window edit budget for source editions that spell the same passage slightly
    differently (for example ``Tyger`` vs ``Tiger`` or apostrophe expansions).
    """
    exact = selector.get("exact")
    if not isinstance(exact, str) or not exact.strip():
        return None
    return AnchorNeedle(
        normalized_prefix=_normalize_anchor_match_text(exact)[:_ANCHOR_NEEDLE_CHARS],
        token_prefix=tuple(_anchor_match_tokens(exact)[:_ANCHOR_TOKEN_PREFIX_TOKENS]),
    )


def _normalize_anchor_match_text(value: str) -> str:
    value = _normalize_anchor_source_text(value)
    value = unicodedata.normalize("NFKD", value).lower()
    return re.sub(r"[^a-z0-9]+", "", value)


def _anchor_match_tokens(value: str) -> list[str]:
    value = _normalize_anchor_source_text(value)
    value = unicodedata.normalize("NFKD", value).lower()
    tokens = re.findall(r"[a-z0-9]+", value)
    return [(_ANCHOR_TOKEN_ALIASES.get(token) or token) for token in tokens if not token.isdigit()]


def _normalize_anchor_source_text(value: str) -> str:
    value = (
        value.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
    )
    value = re.sub(r"\bthro'\b", "through", value, flags=re.IGNORECASE)
    value = re.sub(r"\btho'\b", "though", value, flags=re.IGNORECASE)
    value = re.sub(r"\bne'er\b", "never", value, flags=re.IGNORECASE)
    value = re.sub(r"\bo'er\b", "over", value, flags=re.IGNORECASE)
    value = re.sub(r"\be'er\b", "ever", value, flags=re.IGNORECASE)
    return re.sub(r"\b([a-zA-Z]+)'d\b", r"\1ed", value)


def _anchor_token_window_matches(
    selector_tokens: tuple[str, ...], chunk_tokens: tuple[str, ...]
) -> bool:
    if (
        len(selector_tokens) < _ANCHOR_MIN_TOKEN_WINDOW_TOKENS
        or len(chunk_tokens) < _ANCHOR_MIN_TOKEN_WINDOW_TOKENS
    ):
        return False
    selector_window_size = min(len(selector_tokens), _ANCHOR_TOKEN_PREFIX_TOKENS)
    selector_window = selector_tokens[:selector_window_size]
    if len(chunk_tokens) < _ANCHOR_MIN_TOKEN_WINDOW_TOKENS:
        return False
    min_match_count = _anchor_min_token_matches(selector_window_size)
    min_window_size = max(
        _ANCHOR_MIN_TOKEN_WINDOW_TOKENS,
        selector_window_size - _ANCHOR_TOKEN_WINDOW_MISSING_TOKENS,
    )
    max_window_size = min(
        len(chunk_tokens),
        selector_window_size + _ANCHOR_TOKEN_WINDOW_EXTRA_TOKENS,
    )
    for start in range(0, len(chunk_tokens) - min_window_size + 1):
        for window_size in range(min_window_size, max_window_size + 1):
            if start + window_size > len(chunk_tokens):
                break
            chunk_window = chunk_tokens[start : start + window_size]
            matches = _anchor_token_lcs_length(selector_window, chunk_window)
            match_ratio = matches / max(selector_window_size, window_size)
            if matches >= min_match_count and match_ratio >= _ANCHOR_TOKEN_WINDOW_MATCH_RATIO:
                return True
    return False


def _anchor_min_token_matches(window_size: int) -> int:
    return max(
        _ANCHOR_MIN_TOKEN_WINDOW_TOKENS,
        int(window_size * _ANCHOR_TOKEN_WINDOW_MATCH_RATIO + 0.999),
    )


def _anchor_token_multiset_overlap(
    selector_window: tuple[str, ...], chunk_token_counts: Counter[str]
) -> int:
    selector_counts = Counter(selector_window)
    return sum(
        min(selector_count, chunk_token_counts.get(token, 0))
        for token, selector_count in selector_counts.items()
    )


def _anchor_token_lcs_length(
    selector_tokens: tuple[str, ...], chunk_tokens: tuple[str, ...]
) -> int:
    previous = [0] * (len(chunk_tokens) + 1)
    for selector_token in selector_tokens:
        current = [0]
        for index, chunk_token in enumerate(chunk_tokens, start=1):
            current.append(
                previous[index - 1] + 1
                if selector_token == chunk_token
                else max(previous[index], current[index - 1])
            )
        previous = current
    return previous[-1]
