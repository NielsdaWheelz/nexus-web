"""Current inline-embed artifact owner for readable web articles."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, assert_never, cast
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    DocumentEmbed,
    DocumentEmbedArtifactState,
    Media,
    ProcessingStatus,
    ResourceEdge,
)
from nexus.errors import InvalidRequestError
from nexus.schemas.media import (
    DocumentEmbedAggregateStatus,
    DocumentEmbedDisplayActionOut,
    DocumentEmbedDisplayOut,
    DocumentEmbedKind,
    DocumentEmbedLocatorOut,
    DocumentEmbedOut,
    DocumentEmbedProvider,
    DocumentEmbedProviderRefOut,
    DocumentEmbedResolutionStatus,
    DocumentEmbedSource,
    DocumentEmbedSourceFields,
    DocumentEmbedSourceShape,
    DocumentEmbedSummaryOut,
    DocumentEmbedTargetMaterialized,
    DocumentEmbedTargetOut,
    DocumentEmbedTargetTerminal,
    DocumentEmbedTextOut,
    DocumentEmbedUrlOut,
)
from nexus.services import library_entries
from nexus.services.playback_source import derive_playback_source
from nexus.services.resource_graph.edges import replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase


@dataclass(frozen=True, slots=True)
class DocumentEmbedTargetAcceptSource:
    canonical_url: str
    kind: Literal["accept_source"] = field(default="accept_source", init=False)


type DocumentEmbedTargetOutcome = (
    DocumentEmbedTargetAcceptSource | DocumentEmbedTargetMaterialized | DocumentEmbedTargetTerminal
)


class DocumentEmbedArtifactOccurrence(DocumentEmbedSourceFields):
    fragment_id: UUID
    target: DocumentEmbedTargetOutcome


class _EmbedProjection(DocumentEmbedSourceFields):
    media_id: UUID
    fragment_id: UUID | None
    resolution_status: DocumentEmbedResolutionStatus
    target_media_id: UUID | None
    error_code: str | None
    error_message: str | None
    description: str | None
    thumbnail_url: str | None
    document_order_key: str


class DocumentEmbedLockSetChanged(Exception):
    """A concurrent reusable child appeared outside the planned media lock set."""

    def __init__(self, media_id: UUID) -> None:
        super().__init__(str(media_id))
        self.media_id = media_id


def prepare_document_embed_sources(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    owner_user_id: UUID,
    fence: SourcePublicationFence,
    occurrences: Sequence[DocumentEmbedArtifactOccurrence],
    request_id: str | None,
) -> tuple[tuple[DocumentEmbedArtifactOccurrence, ...], frozenset[UUID]]:
    """Commit child acceptance and dispatch before freezing the parent members.

    A valid child can survive failed parent preparation. Its existing durable
    source attempt remains the sole retry owner; no publication read fetches it.
    """
    from nexus.services.media_source_ingest import (
        accept_embedded_source,
        enqueue_accepted_source_attempt_in_transaction,
        reusable_embedded_source_media_ids,
    )

    if not occurrences:
        return (), frozenset()
    urls = [
        occurrence.target.canonical_url
        for occurrence in occurrences
        if isinstance(occurrence.target, DocumentEmbedTargetAcceptSource)
    ]
    locked_ids: set[UUID] = {
        occurrence.target.media_id
        for occurrence in occurrences
        if isinstance(occurrence.target, DocumentEmbedTargetMaterialized)
    }
    for _lock_set_attempt in range(3):
        with session_factory() as db:
            locked_ids.update(
                reusable_embedded_source_media_ids(db, viewer_id=owner_user_id, urls=urls)
            )

        def accept(db: Session, _attempt: object) -> tuple[DocumentEmbedArtifactOccurrence, ...]:
            library_ids = library_entries.admin_non_default_library_ids_for_media(
                db, viewer_id=owner_user_id, media_id=media_id
            )
            accepted_ids: set[UUID] = set()
            sources: list[DocumentEmbedArtifactOccurrence] = []
            for occurrence in occurrences:
                if not isinstance(occurrence.target, DocumentEmbedTargetAcceptSource):
                    sources.append(occurrence)
                    continue
                try:
                    accepted = accept_embedded_source(
                        db=db,
                        viewer_id=owner_user_id,
                        url=occurrence.target.canonical_url,
                        parent_media_id=media_id,
                        document_embed_key=occurrence.occurrence_key,
                        library_ids=library_ids,
                        request_id=request_id,
                    )
                except InvalidRequestError as exc:
                    target = DocumentEmbedTargetTerminal(
                        status="failed", error_code=exc.code.value, error_message=exc.message
                    )
                else:
                    if (
                        not accepted.needs_enqueue
                        and accepted.media_id not in accepted_ids
                        and accepted.media_id not in locked_ids
                    ):
                        raise DocumentEmbedLockSetChanged(accepted.media_id)
                    if accepted.needs_enqueue:
                        enqueue_accepted_source_attempt_in_transaction(
                            db,
                            media_id=accepted.media_id,
                            attempt_id=accepted.source_attempt_id,
                            actor_user_id=owner_user_id,
                            request_id=request_id,
                        )
                    accepted_ids.add(accepted.media_id)
                    target = DocumentEmbedTargetMaterialized(media_id=accepted.media_id)
                sources.append(occurrence.model_copy(update={"target": target}))
            return tuple(sources)

        try:
            sources = run_source_publication_phase(
                session_factory=session_factory,
                label="accept_document_embed_sources",
                fence=fence,
                media_ids=(media_id, *locked_ids),
                mutate=accept,
            )
            locked_ids.update(
                source.target.media_id
                for source in sources
                if isinstance(source.target, DocumentEmbedTargetMaterialized)
            )
            return sources, frozenset(locked_ids)
        except DocumentEmbedLockSetChanged as exc:
            locked_ids.add(exc.media_id)
    raise AssertionError("document embed source lock set did not stabilize")


def delete_document_embed_artifacts(db: Session, *, owner_user_id: UUID, media_id: UUID) -> None:
    viewer_ids = {*_document_embed_edge_viewer_ids(db, media_id=media_id), owner_user_id}
    for viewer_id in sorted(viewer_ids):
        _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=[])
    db.execute(delete(DocumentEmbed).where(DocumentEmbed.media_id == media_id))
    db.execute(
        delete(DocumentEmbedArtifactState).where(DocumentEmbedArtifactState.media_id == media_id)
    )
    db.flush()


def prepare_document_embed_artifacts_for_fragment_replacement(
    db: Session,
    *,
    media_id: UUID,
) -> None:
    """Release old fragment FKs while preserving the artifact and its audience.

    A web-article refresh must complete this preparation and the subsequent
    document-embed replace or delete in the same transaction.
    """
    db.execute(
        update(DocumentEmbed).where(DocumentEmbed.media_id == media_id).values(fragment_id=None)
    )
    db.flush()


def replace_document_embed_artifact(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    source_attempt_id: UUID,
    occurrences: Sequence[DocumentEmbedArtifactOccurrence],
    extraction_error_code: str | None,
    extraction_error_message: str | None,
    request_id: str | None,
    locked_existing_target_media_ids: frozenset[UUID],
) -> None:
    edge_viewer_ids = {*_document_embed_edge_viewer_ids(db, media_id=media_id), owner_user_id}
    delete_document_embed_artifacts(db, owner_user_id=owner_user_id, media_id=media_id)
    rows: list[DocumentEmbed] = []
    for occurrence in occurrences:
        target_media_id: UUID | None = None
        error_code: str | None = None
        error_message: str | None = None
        diagnostics: dict[str, object] = {}
        target = occurrence.target
        if isinstance(target, DocumentEmbedTargetAcceptSource):
            raise AssertionError("Parent publication requires already accepted embed sources")
        elif isinstance(target, DocumentEmbedTargetMaterialized):
            target_media_id = target.media_id
            if target_media_id not in locked_existing_target_media_ids:
                raise AssertionError("Parent publication lacks its accepted child media fence")
            child = db.get(Media, target_media_id)
            if child is None:
                from nexus.services.reader_publication import ReaderPublicationBusy

                raise ReaderPublicationBusy()
            resolution_status = (
                "resolved"
                if child.processing_status == ProcessingStatus.ready_for_reading
                else "failed"
                if child.processing_status == ProcessingStatus.failed
                else "resolving"
            )
            error_code = child.last_error_code if resolution_status == "failed" else None
            error_message = child.last_error_message if resolution_status == "failed" else None
        elif isinstance(target, DocumentEmbedTargetTerminal):
            resolution_status = target.status
            error_code = target.error_code
            error_message = target.error_message
        else:
            assert_never(target)

        rows.append(
            DocumentEmbed(
                id=occurrence.id,
                media_id=media_id,
                fragment_id=occurrence.fragment_id,
                source_attempt_id=source_attempt_id,
                ordinal=occurrence.ordinal,
                occurrence_key=occurrence.occurrence_key,
                provider=occurrence.provider,
                embed_kind=occurrence.embed_kind,
                source_shape=occurrence.source_shape,
                resolution_status=resolution_status,
                source_url=occurrence.source_url,
                canonical_source_url=occurrence.canonical_source_url,
                provider_target_ref=occurrence.provider_target_ref,
                target_media_id=target_media_id,
                title=occurrence.title,
                authored_text=occurrence.authored_text,
                placeholder_text=occurrence.placeholder_text,
                canonical_start_offset=occurrence.canonical_start_offset,
                canonical_end_offset=occurrence.canonical_end_offset,
                document_order_key=f"{occurrence.ordinal:06d}",
                error_code=error_code,
                error_message=error_message,
                diagnostics=diagnostics,
            )
        )
    db.add_all(rows)
    db.flush()
    _write_state(
        db,
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        rows=rows,
        extraction_error_code=extraction_error_code,
        extraction_error_message=extraction_error_message,
    )
    for viewer_id in sorted(edge_viewer_ids):
        _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)


def document_embed_summaries_for_media(
    db: Session, media_ids: Sequence[UUID]
) -> dict[UUID, DocumentEmbedSummaryOut]:
    if not media_ids:
        return {}
    rows = (
        db.execute(
            select(DocumentEmbedArtifactState).where(
                DocumentEmbedArtifactState.media_id.in_(list(media_ids))
            )
        )
        .scalars()
        .all()
    )
    return {row.media_id: _summary_out(row) for row in rows}


def document_embed_summary_for_media(
    db: Session, *, media_id: UUID
) -> DocumentEmbedSummaryOut | None:
    row = db.execute(
        select(DocumentEmbedArtifactState).where(DocumentEmbedArtifactState.media_id == media_id)
    ).scalar_one_or_none()
    return _summary_out(row) if row is not None else None


def reconcile_document_embed_parent_edges_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    target_media_id: UUID,
) -> bool:
    """Reproject parents after one viewer loses access to an embed target."""
    parent_media_ids = set(
        db.scalars(
            select(DocumentEmbed.media_id)
            .where(DocumentEmbed.target_media_id == target_media_id)
            .distinct()
            .order_by(DocumentEmbed.media_id)
        )
    )
    if not parent_media_ids:
        return False
    for media_id in parent_media_ids:
        reconcile_document_embed_edges_for_viewer(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
        )
    db.flush()
    return True


def list_document_embeds_for_fragments(
    db: Session, *, viewer_id: UUID, fragment_ids: Sequence[UUID]
) -> dict[UUID, list[DocumentEmbedOut]]:
    if not fragment_ids:
        return {}
    rows = (
        db.execute(
            select(DocumentEmbed)
            .where(DocumentEmbed.fragment_id.in_(list(fragment_ids)))
            .order_by(
                DocumentEmbed.fragment_id.asc(),
                DocumentEmbed.ordinal.asc(),
                DocumentEmbed.id.asc(),
            )
        )
        .scalars()
        .all()
    )
    out: dict[UUID, list[DocumentEmbedOut]] = {fragment_id: [] for fragment_id in fragment_ids}
    for row in rows:
        if row.fragment_id is None:
            continue
        out.setdefault(row.fragment_id, []).append(_embed_out(db, viewer_id=viewer_id, row=row))
    return out


def capture_document_embed_sources(
    db: Session, *, media_id: UUID
) -> dict[UUID, tuple[DocumentEmbedSource, ...]]:
    """Worker-only source capture in the same snapshot as the canonical fragments."""
    fragments: dict[UUID, list[DocumentEmbedSource]] = {}
    for row in db.scalars(
        select(DocumentEmbed)
        .where(DocumentEmbed.media_id == media_id, DocumentEmbed.fragment_id.is_not(None))
        .order_by(DocumentEmbed.fragment_id, DocumentEmbed.ordinal, DocumentEmbed.id)
    ):
        if row.fragment_id is None:
            continue
        target = (
            DocumentEmbedTargetMaterialized(media_id=row.target_media_id)
            if row.target_media_id is not None
            else DocumentEmbedTargetTerminal(
                status="unsupported" if row.resolution_status == "unsupported" else "failed",
                error_code=row.error_code,
                error_message=row.error_message,
            )
        )
        fields = DocumentEmbedSourceFields.model_validate(row, from_attributes=True)
        fragments.setdefault(row.fragment_id, []).append(
            DocumentEmbedSource(**fields.model_dump(), target=target)
        )
    return {key: tuple(sources) for key, sources in fragments.items()}


def list_document_embeds_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[DocumentEmbedOut]:
    rows = (
        db.execute(
            select(DocumentEmbed)
            .where(DocumentEmbed.media_id == media_id)
            .order_by(DocumentEmbed.ordinal.asc(), DocumentEmbed.id.asc())
        )
        .scalars()
        .all()
    )
    return [_embed_out(db, viewer_id=viewer_id, row=row) for row in rows]


def resolved_document_embed_target_media_ids(db: Session, *, media_id: UUID) -> list[UUID]:
    return [
        target_media_id
        for target_media_id in db.scalars(
            select(DocumentEmbed.target_media_id)
            .where(
                DocumentEmbed.media_id == media_id,
                DocumentEmbed.resolution_status == "resolved",
                DocumentEmbed.target_media_id.is_not(None),
            )
            .distinct()
            .order_by(DocumentEmbed.target_media_id)
        )
        if target_media_id is not None
    ]


def reconcile_document_embed_edges_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> None:
    """Project the current document-embed targets visible to one viewer."""
    rows = (
        db.execute(
            select(DocumentEmbed)
            .where(DocumentEmbed.media_id == media_id)
            .order_by(DocumentEmbed.ordinal.asc(), DocumentEmbed.id.asc())
        )
        .scalars()
        .all()
    )
    _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)


def sync_document_embed_targets_for_media(db: Session, *, target_media_id: UUID) -> bool:
    rows = (
        db.execute(
            select(DocumentEmbed)
            .where(DocumentEmbed.target_media_id == target_media_id)
            .order_by(DocumentEmbed.media_id.asc(), DocumentEmbed.ordinal.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return False
    status: Literal["resolving", "resolved", "failed"]
    target = db.get(Media, target_media_id)
    if target is None:
        status = "failed"
        error_code = "E_MEDIA_NOT_FOUND"
        error_message = "Embedded media target was removed."
    else:
        target_status = getattr(target.processing_status, "value", target.processing_status)
        if target_status == ProcessingStatus.ready_for_reading.value:
            status = "resolved"
            error_code = None
            error_message = None
        elif target_status == ProcessingStatus.failed.value:
            status = "failed"
            error_code = target.last_error_code
            error_message = target.last_error_message
        else:
            status = "resolving"
            error_code = None
            error_message = None
    media_ids = {row.media_id for row in rows}
    for row in rows:
        row.resolution_status = status
        row.error_code = error_code
        row.error_message = error_message
    db.flush()
    for media_id in media_ids:
        current = (
            db.execute(
                select(DocumentEmbed)
                .where(DocumentEmbed.media_id == media_id)
                .order_by(DocumentEmbed.ordinal.asc(), DocumentEmbed.id.asc())
            )
            .scalars()
            .all()
        )
        state = db.execute(
            select(DocumentEmbedArtifactState).where(
                DocumentEmbedArtifactState.media_id == media_id
            )
        ).scalar_one_or_none()
        if state is not None:
            _set_state_counts(state, current)
    db.flush()
    return True


def _write_state(
    db: Session,
    *,
    media_id: UUID,
    source_attempt_id: UUID | None,
    rows: Sequence[DocumentEmbed],
    extraction_error_code: str | None,
    extraction_error_message: str | None,
) -> None:
    state = DocumentEmbedArtifactState(
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        status="empty",
        extraction_error_code=extraction_error_code,
        extraction_error_message=extraction_error_message,
        diagnostics={},
    )
    if extraction_error_code is not None:
        state.total_count = 0
        state.resolved_count = 0
        state.unsupported_count = 0
        state.failed_count = 0
        state.status = "failed"
    else:
        _set_state_counts(state, rows)
    db.add(state)
    db.flush()


def _set_state_counts(state: DocumentEmbedArtifactState, rows: Sequence[DocumentEmbed]) -> None:
    state.total_count = len(rows)
    state.resolved_count = sum(1 for row in rows if row.resolution_status == "resolved")
    state.unsupported_count = sum(1 for row in rows if row.resolution_status == "unsupported")
    state.failed_count = sum(1 for row in rows if row.resolution_status == "failed")
    state.status = _aggregate_status(
        state.total_count,
        state.resolved_count,
        state.unsupported_count,
        state.failed_count,
    )


def _aggregate_status(
    total: int, resolved: int, unsupported: int, failed: int
) -> DocumentEmbedAggregateStatus:
    if total == 0:
        return "empty"
    terminal = resolved + unsupported + failed
    if unsupported == total:
        return "unsupported"
    if resolved + unsupported == total:
        return "ready"
    if failed == total:
        return "failed"
    if terminal == 0:
        return "resolving"
    return "partial"


def _replace_graph_edges(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    rows: Sequence[DocumentEmbed],
) -> None:
    source = ResourceRef(scheme="media", id=media_id)
    target_media_ids: list[UUID] = []
    if can_read_media(db, viewer_id, media_id):
        target_media_ids = sorted(
            {
                row.target_media_id
                for row in rows
                if row.target_media_id is not None
                and can_read_media(db, viewer_id, row.target_media_id)
            }
        )
    replace_edges_for_origin(
        db,
        viewer_id=viewer_id,
        source=source,
        origin="document_embed",
        edges=[
            EdgeCreate(
                source=source,
                target=ResourceRef(scheme="media", id=target_media_id),
                kind="context",
                origin="document_embed",
            )
            for target_media_id in target_media_ids
        ],
    )


def _document_embed_edge_viewer_ids(db: Session, *, media_id: UUID) -> set[UUID]:
    return set(
        db.scalars(
            select(ResourceEdge.user_id)
            .where(
                ResourceEdge.source_scheme == "media",
                ResourceEdge.source_id == media_id,
                ResourceEdge.origin == "document_embed",
            )
            .distinct()
            .order_by(ResourceEdge.user_id)
        )
    )


def _summary_out(row: DocumentEmbedArtifactState) -> DocumentEmbedSummaryOut:
    return DocumentEmbedSummaryOut(
        status=cast(DocumentEmbedAggregateStatus, row.status),
        total_count=row.total_count,
        resolved_count=row.resolved_count,
        unsupported_count=row.unsupported_count,
        failed_count=row.failed_count,
    )


def _embed_out(db: Session, *, viewer_id: UUID, row: DocumentEmbed) -> DocumentEmbedOut:
    return _project_embed(
        db, viewer_id=viewer_id, row=_EmbedProjection.model_validate(row, from_attributes=True)
    )


def project_document_embed_source(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    fragment_id: UUID,
    source: DocumentEmbedSource,
) -> DocumentEmbedOut:
    """Project a retained occurrence against current access and child state.

    The retained occurrence id is descriptive, not a live retry command owner.
    Current cards expose no enabled occurrence retry; adding one requires an
    explicit command that can address retained source occurrences.
    """
    target_id = None
    error_code = error_message = None
    if isinstance(source.target, DocumentEmbedTargetTerminal):
        status = source.target.status
        error_code, error_message = source.target.error_code, source.target.error_message
    else:
        target_id = source.target.media_id
        child = db.get(Media, target_id) if can_read_media(db, viewer_id, target_id) else None
        if child is None:
            status = "resolved"
        elif child.processing_status == ProcessingStatus.ready_for_reading:
            status = "resolved"
        elif child.processing_status == ProcessingStatus.failed:
            status = "failed"
            error_code, error_message = child.last_error_code, child.last_error_message
        else:
            status = "resolving"
    return _project_embed(
        db,
        viewer_id=viewer_id,
        row=_EmbedProjection(
            **source.model_dump(exclude={"target"}),
            media_id=media_id,
            fragment_id=fragment_id,
            resolution_status=status,
            target_media_id=target_id,
            error_code=error_code,
            error_message=error_message,
            description=None,
            thumbnail_url=None,
            document_order_key=f"{source.ordinal:06d}",
        ),
    )


def _project_embed(db: Session, *, viewer_id: UUID, row: _EmbedProjection) -> DocumentEmbedOut:
    target = _target_out(db, viewer_id=viewer_id, row=row)
    return DocumentEmbedOut(
        id=row.id,
        media_id=row.media_id,
        fragment_id=row.fragment_id,
        occurrence_key=row.occurrence_key,
        ordinal=row.ordinal,
        provider=cast(DocumentEmbedProvider, row.provider),
        kind=cast(DocumentEmbedKind, row.embed_kind),
        source_shape=cast(DocumentEmbedSourceShape, row.source_shape),
        resolution_status=cast(DocumentEmbedResolutionStatus, row.resolution_status),
        source_url=_url(
            row.source_url,
            malformed=row.error_code in {"missing_src", "unsafe_url"},
            error_code=row.error_code,
        ),
        canonical_url=_url(row.canonical_source_url),
        provider_target_ref=_provider_ref(row),
        title=_text(row.title),
        description=_text(row.description),
        thumbnail_url=_url(row.thumbnail_url),
        authored_text=_text(row.authored_text),
        locator=DocumentEmbedLocatorOut(
            kind=(
                "anchored"
                if row.fragment_id and row.canonical_start_offset is not None
                else "unanchored"
            ),
            fragment_id=row.fragment_id,
            canonical_start_offset=row.canonical_start_offset,
            canonical_end_offset=row.canonical_end_offset,
            document_order_key=row.document_order_key,
            placeholder_text=row.placeholder_text,
        ),
        target=target,
        error_code=_text(row.error_code),
        display=_display(row, target),
    )


def _target_out(db: Session, *, viewer_id: UUID, row: _EmbedProjection) -> DocumentEmbedTargetOut:
    if row.target_media_id is None:
        if row.resolution_status == "unsupported":
            return DocumentEmbedTargetOut(status="unsupported")
        if row.resolution_status in {"pending", "resolving"}:
            return DocumentEmbedTargetOut(status="partial")
        return DocumentEmbedTargetOut(status="missing")
    resource_ref = f"media:{row.target_media_id}"
    if not can_read_media(db, viewer_id, row.target_media_id):
        return DocumentEmbedTargetOut(status="forbidden", resource_ref=resource_ref)
    media = db.get(Media, row.target_media_id)
    if media is None:
        return DocumentEmbedTargetOut(status="missing", resource_ref=resource_ref)
    return DocumentEmbedTargetOut(
        status="exact",
        media_id=row.target_media_id,
        resource_ref=resource_ref,
        href=f"/media/{row.target_media_id}",
        kind=media.kind,
        title=media.title,
        thumbnail_url=None,
        playback=derive_playback_source(
            kind=media.kind,
            external_playback_url=media.external_playback_url,
            canonical_source_url=media.canonical_source_url,
            provider=media.provider,
            provider_id=media.provider_id,
        ),
    )


def _text(value: str | None) -> DocumentEmbedTextOut:
    if value:
        return DocumentEmbedTextOut(kind="present", value=value)
    return DocumentEmbedTextOut(kind="absent", reason="not_in_source")


def _url(
    value: str | None, *, malformed: bool = False, error_code: str | None = None
) -> DocumentEmbedUrlOut:
    if malformed:
        return DocumentEmbedUrlOut(status="malformed", value=None, error_code=error_code)
    if value:
        return DocumentEmbedUrlOut(status="present", value=value)
    return DocumentEmbedUrlOut(status="absent", value=None, reason="not_in_source")


def _provider_ref(row: _EmbedProjection) -> DocumentEmbedProviderRefOut:
    if row.provider_target_ref:
        return DocumentEmbedProviderRefOut(kind="present", value=row.provider_target_ref)
    reason = "unsupported_provider" if row.resolution_status == "unsupported" else "unparseable"
    return DocumentEmbedProviderRefOut(kind="absent", reason=reason)


def _display(row: _EmbedProjection, target: DocumentEmbedTargetOut) -> DocumentEmbedDisplayOut:
    if row.resolution_status == "resolved":
        if target.href:
            mode = "resolved"
            description = target.title or "Saved in Nexus"
        elif target.status == "forbidden":
            mode = "forbidden"
            description = "You do not have access to this item"
        else:
            mode = "missing"
            description = "This item is no longer available"
    elif row.resolution_status in {"pending", "resolving"}:
        mode = "pending"
        description = "Resolving embedded media"
    elif row.resolution_status == "failed":
        mode = "failed"
        description = row.error_message or "Embedded media could not be saved"
    else:
        mode = "unsupported"
        description = "Unsupported embedded provider"
    actions: list[DocumentEmbedDisplayActionOut] = []
    if target.href:
        actions.append(
            DocumentEmbedDisplayActionOut(kind="open_child_media", label="Open", href=target.href)
        )
    if row.canonical_source_url or row.source_url:
        actions.append(
            DocumentEmbedDisplayActionOut(
                kind="open_original",
                label="Original",
                href=row.canonical_source_url or row.source_url,
            )
        )
    if row.resolution_status == "failed" and target.media_id is not None:
        actions.append(
            DocumentEmbedDisplayActionOut(kind="retry_child", label="Retry", disabled=True)
        )
    return DocumentEmbedDisplayOut(
        mode=mode,
        label=row.title or row.placeholder_text,
        description=row.authored_text or description,
        actions=actions,
    )
