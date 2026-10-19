"""Inline-embed artifact ownership for readable web articles.

One media's embeds are replaced as a set: rows, the aggregate state row, and the
per-viewer `resource_edges` projection that decides who can see each target.
Authorized native article previews read the saved body's provenance, source
credits and first prose paragraph. They never enter the parent's canonical text.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, assert_never, cast
from urllib.parse import urlencode
from uuid import UUID

import regex
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    ContributorCredit,
    DocumentEmbed,
    DocumentEmbedArtifactState,
    Fragment,
    Media,
    ProcessingStatus,
    ResourceEdge,
    XPostSource,
)
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.document_embeds import (
    DocumentEmbedDisplayActionOut,
    DocumentEmbedDisplayOut,
    DocumentEmbedKind,
    DocumentEmbedLocatorOut,
    DocumentEmbedOut,
    DocumentEmbedProvider,
    DocumentEmbedProviderRefOut,
    DocumentEmbedResolutionStatus,
    DocumentEmbedSourceShape,
    DocumentEmbedTargetOut,
    DocumentEmbedTextOut,
    DocumentEmbedUrlOut,
)
from nexus.schemas.x_source import XArticleContent
from nexus.services import library_entries
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.playback_source import derive_playback_source
from nexus.services.resource_graph.edges import EdgeCreate, replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.items import excerpt
from nexus.services.x_source import x_article_content_facts


@dataclass(frozen=True, slots=True)
class DocumentEmbedTargetAcceptSource:
    canonical_url: str
    kind: Literal["accept_source"] = field(default="accept_source", init=False)


@dataclass(frozen=True, slots=True)
class DocumentEmbedTargetMaterialized:
    media_id: UUID
    kind: Literal["materialized"] = field(default="materialized", init=False)


@dataclass(frozen=True, slots=True)
class DocumentEmbedTargetTerminal:
    status: Literal["unsupported", "failed"]
    error_code: str | None
    error_message: str | None
    kind: Literal["terminal"] = field(default="terminal", init=False)


type DocumentEmbedTargetOutcome = (
    DocumentEmbedTargetAcceptSource | DocumentEmbedTargetMaterialized | DocumentEmbedTargetTerminal
)


@dataclass(frozen=True, slots=True)
class DocumentEmbedArtifactOccurrence:
    fragment_id: UUID
    ordinal: int
    occurrence_key: str
    provider: DocumentEmbedProvider
    embed_kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    source_url: str | None
    canonical_source_url: str | None
    provider_target_ref: str | None
    title: str | None
    authored_text: str | None
    placeholder_text: str
    canonical_start_offset: int | None
    canonical_end_offset: int | None
    target: DocumentEmbedTargetOutcome


class DocumentEmbedLockSetChanged(Exception):
    """A concurrent reusable child appeared outside the planned media lock set."""

    def __init__(self, media_id: UUID) -> None:
        super().__init__(str(media_id))
        self.media_id = media_id


def delete_document_embed_artifacts(db: Session, *, owner_user_id: UUID, media_id: UUID) -> None:
    for viewer_id in sorted({*_edge_viewer_ids(db, media_id=media_id), owner_user_id}):
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
    extraction_failed: bool,
    locked_existing_target_media_ids: frozenset[UUID],
) -> list[tuple[UUID, UUID]]:
    """Replace one media's embed rows, accepting each pending child source.

    Returns the (media_id, attempt_id) pairs the caller must enqueue.
    """
    edge_viewer_ids = {*_edge_viewer_ids(db, media_id=media_id), owner_user_id}
    delete_document_embed_artifacts(db, owner_user_id=owner_user_id, media_id=media_id)
    library_ids = library_entries.admin_non_default_library_ids_for_media(
        db, viewer_id=owner_user_id, media_id=media_id
    )
    queued_children: list[tuple[UUID, UUID]] = []
    accepted_target_media_ids: set[UUID] = set()
    rows: list[DocumentEmbed] = []
    for occurrence in occurrences:
        target_media_id: UUID | None = None
        error_code: str | None = None
        error_message: str | None = None
        diagnostics: dict[str, object] = {}
        target = occurrence.target
        if isinstance(target, DocumentEmbedTargetAcceptSource):
            from nexus.services.media_source_ingest import accept_embedded_source

            try:
                accepted = accept_embedded_source(
                    db=db,
                    viewer_id=owner_user_id,
                    url=target.canonical_url,
                    library_ids=library_ids,
                )
            except InvalidRequestError as exc:
                resolution_status = "failed"
                error_code = exc.code.value
                error_message = exc.message
            else:
                target_media_id = accepted.media_id
                if (
                    not accepted.needs_enqueue
                    and target_media_id not in accepted_target_media_ids
                    and target_media_id not in locked_existing_target_media_ids
                ):
                    raise DocumentEmbedLockSetChanged(target_media_id)
                diagnostics["child_source_attempt_id"] = str(accepted.source_attempt_id)
                resolution_status = _child_resolution(
                    accepted.processing_status, accepted.source_attempt_status
                )
                if accepted.needs_enqueue:
                    accepted_target_media_ids.add(accepted.media_id)
                    queued_children.append((accepted.media_id, accepted.source_attempt_id))
        elif isinstance(target, DocumentEmbedTargetMaterialized):
            target_media_id = target.media_id
            library_entries.lock_media_for_reference(db, target_media_id)
            resolution_status, error_code, error_message = _target_resolution(
                db.get(Media, target_media_id)
            )
        elif isinstance(target, DocumentEmbedTargetTerminal):
            resolution_status = target.status
            error_code = target.error_code
            error_message = target.error_message
        else:
            assert_never(target)

        rows.append(
            DocumentEmbed(
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
                provider_target_ref=(
                    occurrence.provider_target_ref.removeprefix("post:")
                    if occurrence.provider == "x" and occurrence.provider_target_ref is not None
                    else occurrence.provider_target_ref
                ),
                target_media_id=target_media_id,
                title=occurrence.title,
                authored_text=None if occurrence.provider == "x" else occurrence.authored_text,
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

    state = DocumentEmbedArtifactState(
        media_id=media_id, source_attempt_id=source_attempt_id, status="empty", diagnostics={}
    )
    if extraction_failed:
        state.total_count = 0
        state.resolved_count = 0
        state.unsupported_count = 0
        state.failed_count = 0
        state.status = "failed"
    else:
        _set_state_counts(state, rows)
    db.add(state)
    db.flush()

    for viewer_id in sorted(edge_viewer_ids):
        _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)
    return queued_children


def resolve_x_document_embed_aliases(
    db: Session,
    *,
    aliases: Mapping[str, UUID],
    unavailable_revision_ids: set[str],
) -> set[UUID]:
    """Resolve existing reference slots from newly proved exact aliases.

    Caller holds the referenced alias locks and all containing media. A missing
    target has no synthetic body; explicit unavailable evidence only changes its
    reference outcome. A retained canonical body always remains the target.
    """
    revisions = set(aliases) | unavailable_revision_ids
    if not revisions:
        return set()
    sources = set(
        db.scalars(
            select(XPostSource.media_id).where(XPostSource.media_id.in_(set(aliases.values())))
        )
    )
    changed: set[UUID] = set()
    for row in db.scalars(
        select(DocumentEmbed).where(
            DocumentEmbed.provider == "x",
            DocumentEmbed.provider_target_ref.in_(revisions),
            DocumentEmbed.canonical_end_offset.is_not(None),
        )
    ):
        target = aliases.get(row.provider_target_ref or "")
        if target in sources:
            desired = (target, "resolved", None, None)
        elif row.provider_target_ref in unavailable_revision_ids:
            desired = (
                None,
                "failed",
                ApiErrorCode.E_X_POST_UNAVAILABLE.value,
                "post unavailable on x",
            )
        else:
            continue
        if (
            row.target_media_id,
            row.resolution_status,
            row.error_code,
            row.error_message,
        ) == desired:
            continue
        if desired[0] is not None:
            library_entries.lock_media_for_reference(db, desired[0])
        row.target_media_id, row.resolution_status, row.error_code, row.error_message = desired
        if row.canonical_end_offset is not None:
            changed.add(row.media_id)
    db.flush()
    for media_id in sorted(changed):
        rows = _embed_rows(db, media_id=media_id)
        state = db.scalar(
            select(DocumentEmbedArtifactState).where(
                DocumentEmbedArtifactState.media_id == media_id
            )
        )
        if state is not None:
            _set_state_counts(state, rows)
        for viewer_id in _edge_viewer_ids(db, media_id=media_id):
            _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)
    db.flush()
    return changed


def sync_document_embed_targets_for_media(db: Session, *, target_media_id: UUID) -> bool:
    """Rewrite every row referring to one child media, then its parents' aggregates."""
    rows = list(
        db.scalars(
            select(DocumentEmbed)
            .where(DocumentEmbed.target_media_id == target_media_id)
            .order_by(DocumentEmbed.media_id.asc(), DocumentEmbed.ordinal.asc())
        )
    )
    if not rows:
        return False
    status, error_code, error_message = _target_resolution(db.get(Media, target_media_id))

    media_ids = {row.media_id for row in rows}
    for row in rows:
        row.resolution_status = status
        row.error_code = error_code
        row.error_message = error_message
    db.flush()
    for media_id in media_ids:
        state = db.execute(
            select(DocumentEmbedArtifactState).where(
                DocumentEmbedArtifactState.media_id == media_id
            )
        ).scalar_one_or_none()
        if state is not None:
            _set_state_counts(state, _embed_rows(db, media_id=media_id))
    db.flush()
    return True


def _target_resolution(
    target: Media | None,
) -> tuple[Literal["resolving", "resolved", "failed"], str | None, str | None]:
    """A child identity may exist before it has a readable publication."""
    if target is None:
        return (
            "failed",
            "E_MEDIA_NOT_FOUND",
            "Embedded media target was removed.",
        )
    if target.processing_status is ProcessingStatus.ready_for_reading:
        return "resolved", None, None
    if target.processing_status is ProcessingStatus.failed:
        return (
            "failed",
            target.last_error_code,
            target.last_error_message,
        )
    return "resolving", None, None


def reconcile_document_embed_edges_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> None:
    """Project the current document-embed targets visible to one viewer."""
    _replace_graph_edges(
        db, viewer_id=viewer_id, media_id=media_id, rows=_embed_rows(db, media_id=media_id)
    )


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
        reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=media_id)
    db.flush()
    return True


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


def list_document_embeds_for_media(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> list[DocumentEmbedOut]:
    return _embeds_out(db, viewer_id=viewer_id, rows=_embed_rows(db, media_id=media_id))


def list_document_embeds_for_fragments(
    db: Session, *, viewer_id: UUID | None, fragment_ids: Sequence[UUID]
) -> dict[UUID, list[DocumentEmbedOut]]:
    if not fragment_ids:
        return {}
    rows = db.scalars(
        select(DocumentEmbed)
        .where(DocumentEmbed.fragment_id.in_(list(fragment_ids)))
        .order_by(
            DocumentEmbed.fragment_id.asc(),
            DocumentEmbed.ordinal.asc(),
            DocumentEmbed.id.asc(),
        )
    ).all()
    out: dict[UUID, list[DocumentEmbedOut]] = {fragment_id: [] for fragment_id in fragment_ids}
    for row, projected in zip(rows, _embeds_out(db, viewer_id=viewer_id, rows=rows), strict=True):
        if row.fragment_id is None:
            continue
        out.setdefault(row.fragment_id, []).append(projected)
    return out


def _embed_rows(db: Session, *, media_id: UUID) -> list[DocumentEmbed]:
    return list(
        db.scalars(
            select(DocumentEmbed)
            .where(DocumentEmbed.media_id == media_id)
            .order_by(DocumentEmbed.ordinal.asc(), DocumentEmbed.id.asc())
        )
    )


def _edge_viewer_ids(db: Session, *, media_id: UUID) -> set[UUID]:
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


def _replace_graph_edges(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    rows: Sequence[DocumentEmbed],
) -> None:
    """Per-viewer visibility: both endpoints must be readable by that viewer."""
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


def _child_resolution(
    processing_status: str, source_attempt_status: str
) -> Literal["resolving", "resolved", "failed"]:
    if processing_status == "ready_for_reading":
        return "resolved"
    if processing_status == "failed" or source_attempt_status == "failed":
        return "failed"
    return "resolving"


def _set_state_counts(state: DocumentEmbedArtifactState, rows: Sequence[DocumentEmbed]) -> None:
    state.total_count = len(rows)
    state.resolved_count = sum(1 for row in rows if row.resolution_status == "resolved")
    state.unsupported_count = sum(1 for row in rows if row.resolution_status == "unsupported")
    state.failed_count = sum(1 for row in rows if row.resolution_status == "failed")
    terminal = state.resolved_count + state.unsupported_count + state.failed_count
    if state.total_count == 0:
        state.status = "empty"
    elif state.unsupported_count == state.total_count:
        state.status = "unsupported"
    elif state.resolved_count + state.unsupported_count == state.total_count:
        state.status = "ready"
    elif state.failed_count == state.total_count:
        state.status = "failed"
    elif terminal == 0:
        state.status = "resolving"
    else:
        state.status = "partial"


# ---------------------------------------------------------------------------
# Wire projection: the nullable shapes `schemas/media.py` declares
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _ArticlePreview:
    byline: str | None
    opening: str | None
    content: XArticleContent


def _embeds_out(
    db: Session, *, viewer_id: UUID | None, rows: Sequence[DocumentEmbed]
) -> list[DocumentEmbedOut]:
    targets = {row.id: _target_out(db, viewer_id=viewer_id, row=row) for row in rows}
    article_ids = list(
        {
            target.media_id
            for row in rows
            if row.provider == "x"
            and row.embed_kind == "link_preview"
            and (target := targets[row.id]).status == "exact"
            and target.media_id is not None
        }
    )
    previews = _article_previews(db, media_ids=article_ids)
    return [
        _embed_out(
            db,
            row=row,
            target=targets[row.id],
            preview=previews.get(target_id)
            if row.provider == "x"
            and row.embed_kind == "link_preview"
            and (target_id := targets[row.id].media_id) is not None
            else None,
        )
        for row in rows
    ]


def _article_previews(db: Session, *, media_ids: Sequence[UUID]) -> dict[UUID, _ArticlePreview]:
    """Current saved facts for already-authorized, readable article targets."""
    if not media_ids:
        return {}
    facts = x_article_content_facts(db, media_ids=media_ids)
    if not facts:
        return {}
    authors: dict[UUID, list[str]] = {}
    for media_id, name in db.execute(
        select(ContributorCredit.media_id, ContributorCredit.credited_name)
        .where(
            ContributorCredit.media_id.in_(list(facts)),
            ContributorCredit.role == "author",
            ContributorCredit.source == "x_article",
        )
        .order_by(ContributorCredit.ordinal)
    ):
        authors.setdefault(media_id, []).append(name)
    openings: dict[UUID, str] = {}
    for media_id, html in db.execute(
        select(Fragment.media_id, Fragment.html_sanitized)
        .where(Fragment.media_id.in_(list(facts)))
        .distinct(Fragment.media_id)
        .order_by(Fragment.media_id, Fragment.idx)
    ):
        assert html is not None  # a current native publication owns a readable fragment
        for paragraph in parse_html_document(html).iter("p"):
            if any(ancestor.tag == "figcaption" for ancestor in paragraph.iterancestors()):
                continue
            opening = generate_canonical_text(inner_html(paragraph)).split("\n\n", 1)[0].strip()
            if not opening:
                continue
            selected = excerpt(opening, 299 if len(opening) > 300 else 300)
            if selected.truncated_after:
                graphemes = {match.end() for match in regex.finditer(r"\X", selected.text)}
                end = max(
                    (
                        match.start()
                        for match in regex.finditer(r"\b", opening, regex.WORD)
                        if match.start() in graphemes
                    ),
                    default=0,
                )
                openings[media_id] = opening[:end].rstrip() + "…"
            else:
                openings[media_id] = selected.text
            break
    return {
        media_id: _ArticlePreview(
            byline=", ".join(authors.get(media_id, [])) or None,
            opening=openings.get(media_id),
            content=content,
        )
        for media_id, content in facts.items()
    }


def _embed_out(
    db: Session,
    *,
    row: DocumentEmbed,
    target: DocumentEmbedTargetOut,
    preview: _ArticlePreview | None,
) -> DocumentEmbedOut:
    article = row.provider == "x" and row.embed_kind == "link_preview"
    hidden_article = article and target.status in {"forbidden", "missing"}
    resolution_status = cast(DocumentEmbedResolutionStatus, row.resolution_status)
    error_code, error_message = row.error_code, row.error_message
    if article and target.media_id is not None:
        resolution_status, error_code, error_message = _target_resolution(
            db.get(Media, target.media_id)
        )
    if preview is not None:
        target = target.model_copy(
            update={"byline": preview.byline, "x_article_content": preview.content}
        )
    return DocumentEmbedOut(
        id=row.id,
        media_id=row.media_id,
        fragment_id=row.fragment_id,
        occurrence_key=row.occurrence_key,
        ordinal=row.ordinal,
        provider=cast(DocumentEmbedProvider, row.provider),
        kind=cast(DocumentEmbedKind, row.embed_kind),
        source_shape=cast(DocumentEmbedSourceShape, row.source_shape),
        resolution_status=None if hidden_article else resolution_status,
        source_url=_url(
            row.source_url,
            malformed=row.error_code in {"missing_src", "unsafe_url"},
            error_code=row.error_code,
        ),
        canonical_url=_url(row.canonical_source_url),
        provider_target_ref=_provider_ref(row),
        title=_text(None if hidden_article else target.title if preview is not None else row.title),
        description=_text(
            None if hidden_article else preview.opening if preview is not None else row.description
        ),
        thumbnail_url=_url(None if hidden_article else row.thumbnail_url),
        authored_text=_text(None if hidden_article else row.authored_text),
        locator=DocumentEmbedLocatorOut(
            unit_id=None,
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
        error_code=_text(None if hidden_article else error_code),
        display=_display(
            row,
            target,
            resolution_status=resolution_status,
            error_code=error_code,
            error_message=error_message,
            preview=preview,
        ),
    )


def _target_out(
    db: Session, *, viewer_id: UUID | None, row: DocumentEmbed
) -> DocumentEmbedTargetOut:
    if row.target_media_id is None:
        if row.resolution_status == "unsupported":
            return DocumentEmbedTargetOut(
                status="unsupported",
                media_id=None,
                resource_ref=None,
                href=None,
                kind=None,
                title=None,
                byline=None,
                x_article_content=None,
                thumbnail_url=None,
                playback=None,
            )
        if row.resolution_status == "resolving":
            return DocumentEmbedTargetOut(
                status="partial",
                media_id=None,
                resource_ref=None,
                href=None,
                kind=None,
                title=None,
                byline=None,
                x_article_content=None,
                thumbnail_url=None,
                playback=None,
            )
        return DocumentEmbedTargetOut(
            status="missing",
            media_id=None,
            resource_ref=None,
            href=None,
            kind=None,
            title=None,
            byline=None,
            x_article_content=None,
            thumbnail_url=None,
            playback=None,
        )
    resource_ref = f"media:{row.target_media_id}"
    article = row.provider == "x" and row.embed_kind == "link_preview"
    if viewer_id is None or not can_read_media(db, viewer_id, row.target_media_id):
        return DocumentEmbedTargetOut(
            status="forbidden",
            media_id=None,
            resource_ref=None if article else resource_ref,
            href=None,
            kind=None,
            title=None,
            byline=None,
            x_article_content=None,
            thumbnail_url=None,
            playback=None,
        )
    media = db.get(Media, row.target_media_id)
    if media is None:
        return DocumentEmbedTargetOut(
            status="missing",
            media_id=None,
            resource_ref=None if article else resource_ref,
            href=None,
            kind=None,
            title=None,
            byline=None,
            x_article_content=None,
            thumbnail_url=None,
            playback=None,
        )
    if article and media.processing_status is not ProcessingStatus.ready_for_reading:
        return DocumentEmbedTargetOut(
            status="partial",
            media_id=row.target_media_id,
            resource_ref=resource_ref,
            href=None,
            kind=media.kind,
            title=None,
            byline=None,
            x_article_content=None,
            thumbnail_url=None,
            playback=None,
        )
    return DocumentEmbedTargetOut(
        status="exact",
        media_id=row.target_media_id,
        resource_ref=resource_ref,
        href=f"/media/{row.target_media_id}",
        kind=media.kind,
        title=media.title,
        byline=None,
        x_article_content=None,
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
        return DocumentEmbedTextOut(kind="present", value=value, reason=None)
    return DocumentEmbedTextOut(kind="absent", value=None, reason="not_in_source")


def _url(
    value: str | None, *, malformed: bool = False, error_code: str | None = None
) -> DocumentEmbedUrlOut:
    if malformed:
        return DocumentEmbedUrlOut(
            status="malformed", value=None, error_code=error_code, reason=None
        )
    if value:
        return DocumentEmbedUrlOut(status="present", value=value, error_code=None, reason=None)
    return DocumentEmbedUrlOut(status="absent", value=None, error_code=None, reason="not_in_source")


def _provider_ref(row: DocumentEmbed) -> DocumentEmbedProviderRefOut:
    if row.provider_target_ref:
        return DocumentEmbedProviderRefOut(
            kind="present", value=row.provider_target_ref, reason=None
        )
    reason = "unsupported_provider" if row.resolution_status == "unsupported" else "unparseable"
    return DocumentEmbedProviderRefOut(kind="absent", value=None, reason=reason)


def _display(
    row: DocumentEmbed,
    target: DocumentEmbedTargetOut,
    *,
    resolution_status: DocumentEmbedResolutionStatus,
    error_code: str | None,
    error_message: str | None,
    preview: _ArticlePreview | None,
) -> DocumentEmbedDisplayOut:
    article = row.provider == "x" and row.embed_kind == "link_preview"
    if article and target.status in {"forbidden", "missing"}:
        source_url = row.canonical_source_url or row.source_url
        return DocumentEmbedDisplayOut(
            mode=None,
            label=row.placeholder_text,
            description=None,
            actions=[
                DocumentEmbedDisplayActionOut(
                    kind="open_original", label="open on x", href=source_url
                )
            ]
            if source_url is not None
            else [],
        )
    if resolution_status == "resolved" and target.href:
        mode = "resolved"
        description = target.title or "Saved in Nexus"
    elif resolution_status == "failed":
        mode = "failed"
        description = (
            "article unavailable through x’s api"
            if article and error_code == "E_X_ARTICLE_BODY_UNAVAILABLE"
            else error_message or "Embedded media could not be saved"
        )
    elif resolution_status == "unsupported":
        mode = "unsupported"
        description = "Unsupported embedded provider"
    else:
        mode = "pending"
        description = "saving article" if article else "Resolving embedded media"
    actions: list[DocumentEmbedDisplayActionOut] = []
    if target.href and (not article or resolution_status == "resolved"):
        actions.append(
            DocumentEmbedDisplayActionOut(kind="open_child_media", label="Open", href=target.href)
        )
    if row.canonical_source_url or row.source_url:
        actions.append(
            DocumentEmbedDisplayActionOut(
                kind="open_original",
                label="open on x" if article else "Original",
                href=row.canonical_source_url or row.source_url,
            )
        )
    if resolution_status == "failed" and target.media_id is not None:
        actions.append(
            DocumentEmbedDisplayActionOut(
                kind="view_import",
                label="view import",
                href="/imports?" + urlencode({"selected": f"media:{target.media_id}"}),
            )
            if article
            else DocumentEmbedDisplayActionOut(
                kind="retry_child", label="Retry", href=None, disabled=True
            )
        )
    return DocumentEmbedDisplayOut(
        mode=mode,
        label=(target.title or row.placeholder_text)
        if preview is not None
        else row.title or row.placeholder_text,
        description=preview.opening
        if preview is not None
        else description
        if article and mode == "failed"
        else row.authored_text or description,
        actions=actions,
    )
