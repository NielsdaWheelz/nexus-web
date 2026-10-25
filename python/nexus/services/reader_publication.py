"""reader publication generations and source pin fences; titles remain metadata.

pieces own ordinary readable generations but cannot own source replacement. an
accepted definition pins its root generation until final source-family teardown.
source replacement/composition refuses while pinned; index and metadata work do
not advance this clock. publishers share the complete root/child media barrier.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from lxml.html import fragment_fromstring
from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from nexus.db.models import Media, MediaFile, ProcessingStatus, ReaderPublication
from nexus.errors import (
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
    ResourceLimitError,
)
from nexus.ids import new_uuid7
from nexus.schemas.source_issues import (
    MAX_SOURCE_ISSUES,
    SOURCE_ISSUES,
    MissingImage,
    SourceIssue,
    TooManyNotes,
    UnresolvedNavigationTarget,
    source_issues_payload,
)

ReaderDocumentKind = Literal["pdf", "epub", "web_article"]
_SOURCE_KINDS = frozenset({"pdf", "epub", "web_article"})
_READABLE_KINDS = _SOURCE_KINDS | {"text_part"}


@dataclass(frozen=True)
class ReaderPublicationSourceFile:
    storage_path: str
    content_type: str
    size_bytes: int
    source_sha256: str


def read_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == media_id)
    )
    return None if generation is None else int(generation)


def advance_reader_publications(db: Session, *, media_ids: Sequence[UUID]) -> None:
    """Publish an atomic composition change after bodies and cursors are reconciled.

    The source publisher already holds every affected media in ascending order.
    A canonical source and every rendering parent advance once in the same commit;
    the existing media stream observes even an otherwise idle parent's new generation.
    """
    from nexus.services.media_parts import require_unpinned_source
    from nexus.services.search import projection

    for media_id in sorted(set(media_ids)):
        require_unpinned_source(db, media_id=media_id)
        publication = db.scalar(
            select(ReaderPublication)
            .where(ReaderPublication.media_id == media_id)
            .with_for_update()
        )
        if publication is None:
            db.add(
                ReaderPublication(id=new_uuid7(), media_id=media_id, generation=1, source_issues=[])
            )
        else:
            publication.generation += 1
            publication.changed_at = db.scalar(text("SELECT now()"))
        db.execute(text("SELECT pg_notify('media_events', :media_id)"), {"media_id": str(media_id)})
    db.flush()
    projection.refresh(db, "media", sorted(set(media_ids)))


def read_publication_source_issues(
    db: Session, *, media_id: UUID, generation: int
) -> list[SourceIssue]:
    payload = db.scalar(
        select(ReaderPublication.source_issues).where(
            ReaderPublication.media_id == media_id, ReaderPublication.generation == generation
        )
    )
    if payload is None:
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Reader publication changed")
    return SOURCE_ISSUES.validate_python(payload)


def ready_publication_rows_sql() -> str:
    """Eligible, currently readable publications shared by readers and capabilities."""
    kinds = ", ".join(f"'{kind}'" for kind in sorted(_READABLE_KINDS))
    return f"""
        SELECT rp.media_id, rp.generation
        FROM reader_publications rp JOIN media m ON m.id = rp.media_id
        WHERE m.kind IN ({kinds})
          AND m.processing_status = '{ProcessingStatus.ready_for_reading.value}'
    """


def read_ready_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """The generation of one eligible, currently readable publication."""
    generation = db.scalar(
        text(f"""
            SELECT publication.generation FROM ({ready_publication_rows_sql()}) publication
            WHERE publication.media_id = :media_id
        """),
        {"media_id": media_id},
    )
    return None if generation is None else int(generation)


def lock_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """Lock the publication row so a republication cannot interleave."""
    generation = db.scalar(
        select(ReaderPublication.generation)
        .where(ReaderPublication.media_id == media_id)
        .with_for_update()
    )
    return None if generation is None else int(generation)


def superseded_reader_source_paths(
    db: Session, *, media_id: UUID, source_file: ReaderPublicationSourceFile | None
) -> list[str]:
    """Objects a pending source replacement supersedes; delete them only after commit."""
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is None or str(current) == source_file.storage_path:
        return []
    return [str(current)]


def replace_reader_publication[T](
    db: Session,
    *,
    media_id: UUID,
    expected_kind: ReaderDocumentKind,
    replace_projection: Callable[[Media], T],
    issues: tuple[SourceIssue, ...],
    source_file: ReaderPublicationSourceFile | None = None,
) -> T:
    """Lock media, then the publication row, then install the source pointer and bump."""
    from nexus.services import library_entries
    from nexus.services.media_parts import require_unpinned_source
    from nexus.services.search import projection

    library_entries.lock_media_rows_in_order(db, [media_id])
    require_unpinned_source(db, media_id=media_id)
    if expected_kind not in _SOURCE_KINDS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Reader publication requires PDF, EPUB, or web article media.",
        )
    media = db.scalar(
        select(Media)
        .options(defer(Media.plain_text))
        .where(Media.id == media_id)
        .with_for_update(key_share=True)
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND, "Reader publication kind does not match its media."
        )
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if expected_kind == "epub" and publication is not None:
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Published EPUB content cannot be replaced."
        )
    if source_file is not None:
        media_file = db.get(MediaFile, media_id)
        if media_file is None:
            media_file = MediaFile(media_id=media_id)
            db.add(media_file)
        media_file.storage_path = source_file.storage_path
        media_file.content_type = source_file.content_type
        media_file.size_bytes = source_file.size_bytes
        media_file.source_sha256 = source_file.source_sha256
    result = replace_projection(media)
    db.flush()
    if len(issues) > MAX_SOURCE_ISSUES:
        raise ResourceLimitError("Source diagnostics exceed the output limit", dimension="Output")
    _validate_source_issues(db, media_id=media_id, issues=issues)
    payload = source_issues_payload(issues)
    if publication is None:
        db.add(
            ReaderPublication(
                id=new_uuid7(), media_id=media_id, generation=1, source_issues=payload
            )
        )
    else:
        publication.generation = int(publication.generation) + 1
        publication.changed_at = db.scalar(text("SELECT now()"))
        publication.source_issues = payload
    db.flush()
    db.execute(text("SELECT pg_notify('media_events', :media_id)"), {"media_id": str(media_id)})
    projection.refresh(db, "media", [media_id])
    projection.refresh_source_highlights(db, media_id)
    return result


def replace_reader_document_title(db: Session, *, media: Media, title: str) -> bool:
    """Update the label without changing content identity; false without a publication."""
    from nexus.services.search import projection

    kind = str(media.kind)
    if kind not in _SOURCE_KINDS:
        return False
    locked_id = db.scalar(
        select(Media.id).where(Media.id == media.id).with_for_update(key_share=True)
    )
    if locked_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if lock_publication_generation(db, media_id=locked_id) is None:
        return False
    media.title = title
    db.flush()
    projection.refresh(db, "media", [media.id])
    return True


def ensure_reader_publication(db: Session, *, media_id: UUID) -> bool:
    """Publish one eligible ready document at generation 1; an existing row is left as is."""
    from nexus.services.search import projection

    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None or str(media.kind) not in _SOURCE_KINDS:
        return False
    if media.processing_status != ProcessingStatus.ready_for_reading:
        return False
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        return False
    db.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=1, source_issues=[]))
    db.flush()
    db.execute(text("SELECT pg_notify('media_events', :media_id)"), {"media_id": str(media_id)})
    projection.refresh(db, "media", [media_id])
    return True


def delete_reader_publication(db: Session, *, media_id: UUID) -> None:
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        db.delete(publication)
        db.flush()


def _validate_source_issues(
    db: Session, *, media_id: UUID, issues: tuple[SourceIssue, ...]
) -> None:
    fragments = {
        row.id: row.html_sanitized
        for row in db.execute(
            text(
                "SELECT id, html_sanitized FROM fragments WHERE media_id = :media_id"
                " AND html_sanitized LIKE '%data-reader-source-warning%'"
            ),
            {"media_id": media_id},
        )
    }
    nodes = {
        row.node_id: row
        for row in db.execute(
            text(
                "SELECT node_id, href, fragment_idx, target_offset FROM epub_toc_nodes WHERE media_id = :media_id"
            ),
            {"media_id": media_id},
        )
    }
    markers: set[tuple[UUID, int]] = set()
    for fragment_id, html in fragments.items():
        root = fragment_fromstring(html, create_parent=True)
        for target in root.xpath(".//*[@data-reader-source-warning]"):
            raw = target.get("data-reader-source-warning")
            if raw is None or not raw.isdecimal() or str(int(raw)) != raw:
                raise ValueError("source-warning marker is not a canonical ordinal")
            if target.tag != "img" and not (target.tag == "span" and target.get("role") == "img"):
                raise ValueError("source-warning marker is not on an image")
            marker = (fragment_id, int(raw))
            if marker in markers:
                raise ValueError("source-warning marker is duplicated in one fragment")
            markers.add(marker)
    issue_markers: set[tuple[UUID, int]] = set()
    issue_nodes: set[tuple[str, str]] = set()
    seen: set[tuple[object, ...]] = set()
    for issue in issues:
        if isinstance(issue, MissingImage):
            key = (issue.kind, issue.fragment_id, issue.marker_ordinal, issue.resource_path)
            marker = (issue.fragment_id, issue.marker_ordinal)
            if marker not in markers:
                raise ValueError("missing-image issue has no source-warning marker")
            issue_markers.add(marker)
        elif isinstance(issue, UnresolvedNavigationTarget):
            key = (issue.kind, issue.node_id)
            node = nodes.get(issue.node_id)
            if node is None or node.href != issue.href or node.target_offset is not None:
                raise ValueError("unresolved-navigation issue does not match an untargeted node")
            issue_nodes.add((issue.node_id, issue.href))
        elif isinstance(issue, TooManyNotes):
            key = (issue.kind,)
        else:
            raise AssertionError("unknown source issue")
        if key in seen:
            raise ValueError("source issue is duplicated")
        seen.add(key)
    if issue_markers != markers:
        raise ValueError("source-warning marker has no missing-image issue")
    unresolved_nodes = {
        (node.node_id, node.href)
        for node in nodes.values()
        if node.href is not None
        and node.target_offset is None
        and not (urlsplit(node.href).scheme or urlsplit(node.href).netloc)
    }
    if issue_nodes != unresolved_nodes:
        raise ValueError("unresolved navigation target has no source issue")
