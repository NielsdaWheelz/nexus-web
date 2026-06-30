"""Current inline-embed artifact owner for readable web articles."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import DocumentEmbed, DocumentEmbedArtifactState, Media, ProcessingStatus
from nexus.schemas.media import (
    DocumentEmbedDisplayActionOut,
    DocumentEmbedDisplayOut,
    DocumentEmbedLocatorOut,
    DocumentEmbedOut,
    DocumentEmbedProviderRefOut,
    DocumentEmbedSummaryOut,
    DocumentEmbedTargetOut,
    DocumentEmbedTextOut,
    DocumentEmbedUrlOut,
)
from nexus.services import library_entries
from nexus.services.playback_source import derive_playback_source
from nexus.services.resource_graph.edges import replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.web_article_structure import WebArticleDocumentEmbed


def delete_document_embed_artifacts(db: Session, *, owner_user_id: UUID, media_id: UUID) -> None:
    replace_edges_for_origin(
        db,
        viewer_id=owner_user_id,
        source=ResourceRef(scheme="media", id=media_id),
        origin="document_embed",
        edges=[],
    )
    db.execute(delete(DocumentEmbed).where(DocumentEmbed.media_id == media_id))
    db.execute(
        delete(DocumentEmbedArtifactState).where(DocumentEmbedArtifactState.media_id == media_id)
    )
    db.flush()


def replace_document_embed_artifact(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    source_attempt_id: UUID | None,
    fragment_id: UUID,
    document_embeds: Sequence[WebArticleDocumentEmbed],
    extraction_error_code: str | None,
    extraction_error_message: str | None,
    request_id: str | None,
) -> list[tuple[UUID, UUID]]:
    delete_document_embed_artifacts(db, owner_user_id=owner_user_id, media_id=media_id)
    queued_children: list[tuple[UUID, UUID]] = []
    library_ids = library_entries.admin_non_default_library_ids_for_media(
        db, viewer_id=owner_user_id, media_id=media_id
    )
    rows: list[DocumentEmbed] = []
    for prepared_embed in document_embeds:
        detected = prepared_embed.detected
        target_media_id: UUID | None = None
        resolution_status = detected.resolution_status
        error_code = detected.error_code
        error_message = detected.error_message
        diagnostics: dict[str, object] = {}
        if detected.resolution_status == "pending" and detected.canonical_source_url:
            try:
                from nexus.services.media_source_ingest import accept_embedded_source

                accepted = accept_embedded_source(
                    db=db,
                    viewer_id=owner_user_id,
                    url=detected.canonical_source_url,
                    parent_media_id=media_id,
                    document_embed_key=detected.occurrence_key,
                    library_ids=library_ids,
                    request_id=request_id,
                )
                target_media_id = accepted.media_id
                diagnostics["child_source_attempt_id"] = str(accepted.source_attempt_id)
                resolution_status = _resolution_from_child(
                    accepted.processing_status, accepted.source_attempt_status
                )
                if accepted.needs_enqueue:
                    queued_children.append((accepted.media_id, accepted.source_attempt_id))
            except Exception as exc:  # child source failure must not fail parent publication
                error_code = getattr(getattr(exc, "code", None), "value", None) or "E_INGEST_FAILED"
                error_message = str(getattr(exc, "message", None) or exc)[:1000]
                resolution_status = "failed"

        rows.append(
            DocumentEmbed(
                media_id=media_id,
                fragment_id=fragment_id,
                source_attempt_id=source_attempt_id,
                ordinal=detected.ordinal,
                occurrence_key=detected.occurrence_key,
                provider=detected.provider,
                embed_kind=detected.embed_kind,
                source_shape=detected.source_shape,
                resolution_status=resolution_status,
                source_url=detected.source_url,
                canonical_source_url=detected.canonical_source_url,
                provider_target_ref=detected.provider_target_ref,
                target_media_id=target_media_id,
                title=detected.title,
                authored_text=detected.authored_text,
                placeholder_text=detected.placeholder_text,
                canonical_start_offset=prepared_embed.canonical_start_offset,
                canonical_end_offset=prepared_embed.canonical_end_offset,
                document_order_key=f"{detected.ordinal:06d}",
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
    _replace_graph_edges(db, owner_user_id=owner_user_id, media_id=media_id, rows=rows)
    return queued_children


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


def detach_document_embed_targets_for_owner(
    db: Session, *, owner_user_id: UUID, target_media_id: UUID
) -> bool:
    rows = (
        db.execute(
            select(DocumentEmbed)
            .join(Media, Media.id == DocumentEmbed.media_id)
            .where(
                Media.created_by_user_id == owner_user_id,
                DocumentEmbed.target_media_id == target_media_id,
            )
            .order_by(DocumentEmbed.media_id.asc(), DocumentEmbed.ordinal.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return False
    media_ids = {row.media_id for row in rows}
    for row in rows:
        row.target_media_id = None
        row.resolution_status = "failed"
        row.error_code = "E_MEDIA_HIDDEN"
        row.error_message = "Embedded media target is no longer in this workspace."
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
        _replace_graph_edges(db, owner_user_id=owner_user_id, media_id=media_id, rows=current)
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
    target = db.get(Media, target_media_id)
    if target is None:
        status = "failed"
        error_code = "E_MEDIA_NOT_FOUND"
        error_message = "Embedded media target was removed."
    else:
        target_status = getattr(target.processing_status, "value", target.processing_status)
    if target is not None and target_status == ProcessingStatus.ready_for_reading.value:
        status = "resolved"
        error_code = None
        error_message = None
    elif target is not None and target_status == ProcessingStatus.failed.value:
        status = "failed"
        error_code = target.last_error_code
        error_message = target.last_error_message
    elif target is not None:
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


def _aggregate_status(total: int, resolved: int, unsupported: int, failed: int) -> str:
    if total == 0:
        return "empty"
    terminal = resolved + unsupported + failed
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
    owner_user_id: UUID,
    media_id: UUID,
    rows: Sequence[DocumentEmbed],
) -> None:
    source = ResourceRef(scheme="media", id=media_id)
    replace_edges_for_origin(
        db,
        viewer_id=owner_user_id,
        source=source,
        origin="document_embed",
        edges=[
            EdgeCreate(
                source=source,
                target=ResourceRef(scheme="media", id=row.target_media_id),
                kind="context",
                origin="document_embed",
            )
            for row in rows
            if row.target_media_id is not None
        ],
    )


def _resolution_from_child(processing_status: str, source_attempt_status: str) -> str:
    if processing_status == "ready_for_reading":
        return "resolved"
    if processing_status == "failed" or source_attempt_status == "failed":
        return "failed"
    return "resolving"


def _summary_out(row: DocumentEmbedArtifactState) -> DocumentEmbedSummaryOut:
    return DocumentEmbedSummaryOut(
        status=row.status,
        total_count=row.total_count,
        resolved_count=row.resolved_count,
        unsupported_count=row.unsupported_count,
        failed_count=row.failed_count,
    )


def _embed_out(db: Session, *, viewer_id: UUID, row: DocumentEmbed) -> DocumentEmbedOut:
    target = _target_out(db, viewer_id=viewer_id, row=row)
    return DocumentEmbedOut(
        id=row.id,
        media_id=row.media_id,
        fragment_id=row.fragment_id,
        occurrence_key=row.occurrence_key,
        ordinal=row.ordinal,
        provider=row.provider,
        kind=row.embed_kind,
        source_shape=row.source_shape,
        resolution_status=row.resolution_status,
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


def _target_out(db: Session, *, viewer_id: UUID, row: DocumentEmbed) -> DocumentEmbedTargetOut:
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


def _provider_ref(row: DocumentEmbed) -> DocumentEmbedProviderRefOut:
    if row.provider_target_ref:
        return DocumentEmbedProviderRefOut(kind="present", value=row.provider_target_ref)
    reason = "unsupported_provider" if row.resolution_status == "unsupported" else "unparseable"
    return DocumentEmbedProviderRefOut(kind="absent", reason=reason)


def _display(row: DocumentEmbed, target: DocumentEmbedTargetOut) -> DocumentEmbedDisplayOut:
    if row.resolution_status == "resolved" and target.href:
        mode = "resolved"
        description = target.title or "Saved in Nexus"
    elif row.resolution_status in {"pending", "resolving"}:
        mode = "pending"
        description = "Resolving embedded media"
    elif row.resolution_status == "failed":
        mode = "failed"
        description = row.error_message or "Embedded media could not be saved"
    elif row.resolution_status == "unsupported":
        mode = "unsupported"
        description = "Unsupported embedded provider"
    else:
        mode = "pending"
        description = "Resolving embedded media"
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
