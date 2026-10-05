"""Reader-visible document publication and generation fencing."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

from lxml.html import Element, HtmlElement, fragment_fromstring
from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from nexus.db.models import Media, MediaFile, ProcessingStatus, ReaderPublication
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.source_issues import (
    MAX_SOURCE_ISSUES,
    SOURCE_ISSUES,
    MissingImage,
    SourceIssue,
    UnresolvedNavigationTarget,
    source_issues_payload,
)

ReaderDocumentKind = Literal["pdf", "epub", "web_article"]
_ELIGIBLE_KINDS = frozenset({"pdf", "epub", "web_article"})


@dataclass(frozen=True)
class ReaderPublicationSourceFile:
    storage_path: str
    content_type: str
    size_bytes: int
    source_sha256: str


@dataclass(frozen=True)
class PreserveSourceIssues:
    pass


@dataclass(frozen=True)
class ReplaceSourceIssues:
    issues: tuple[SourceIssue, ...]


@dataclass(frozen=True)
class ReconcileNavigationSourceIssues:
    """Refresh navigation diagnostics while retaining an EPUB's published content."""


type SourceIssueIntent = (
    PreserveSourceIssues | ReplaceSourceIssues | ReconcileNavigationSourceIssues
)


def read_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == media_id)
    )
    return None if generation is None else int(generation)


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


def reconcile_navigation_source_issues(
    existing: Sequence[SourceIssue],
    navigation_issues: Sequence[UnresolvedNavigationTarget],
) -> tuple[SourceIssue, ...]:
    """Preserve image facts and unchanged ordering while replacing navigation facts."""
    remaining = {issue.node_id: issue for issue in navigation_issues}
    if len(remaining) != len(navigation_issues):
        raise ValueError("navigation source issues repeat a node identity")
    reconciled: list[SourceIssue] = []
    for issue in existing:
        if isinstance(issue, MissingImage):
            reconciled.append(issue)
        elif remaining.get(issue.node_id) == issue:
            reconciled.append(issue)
            del remaining[issue.node_id]
    reconciled.extend(remaining[node_id] for node_id in sorted(remaining))
    return tuple(reconciled)


def read_ready_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    """The generation of one eligible, currently readable publication."""
    generation = db.scalar(
        text(
            "SELECT rp.generation FROM reader_publications rp JOIN media m ON m.id = rp.media_id"
            " WHERE rp.media_id = :media_id AND m.kind = ANY(:kinds)"
            " AND m.processing_status = 'ready_for_reading'"
        ),
        {"media_id": media_id, "kinds": list(_ELIGIBLE_KINDS)},
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


def unpublished_reader_source_paths(
    db: Session, *, media_id: UUID, source_file: ReaderPublicationSourceFile | None
) -> list[str]:
    """Prepared source objects left unreferenced because the publication was refused."""
    if source_file is None:
        return []
    current = db.scalar(select(MediaFile.storage_path).where(MediaFile.media_id == media_id))
    if current is not None and str(current) == source_file.storage_path:
        return []
    return [source_file.storage_path]


def replace_reader_publication[T](
    db: Session,
    *,
    media_id: UUID,
    expected_kind: ReaderDocumentKind,
    replace_projection: Callable[[Media], T],
    issues: SourceIssueIntent,
    source_file: ReaderPublicationSourceFile | None = None,
) -> T:
    """Lock media, then the publication row, then install the source pointer and bump."""
    if expected_kind not in _ELIGIBLE_KINDS:
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
    if (
        expected_kind == "epub"
        and publication is not None
        and (isinstance(issues, ReplaceSourceIssues) or source_file is not None)
    ):
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Published EPUB content cannot be replaced."
        )
    if isinstance(issues, ReconcileNavigationSourceIssues) and (
        expected_kind != "epub" or publication is None or source_file is not None
    ):
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED,
            "Navigation diagnostics require an existing EPUB without source replacement.",
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
    replacement_issues: tuple[SourceIssue, ...] | None = None
    if isinstance(issues, ReconcileNavigationSourceIssues):
        assert publication is not None
        navigation_issues = tuple(
            UnresolvedNavigationTarget(node_id=row.node_id, href=row.href)
            for row in db.execute(
                text(
                    "SELECT node_id, href FROM epub_toc_nodes WHERE media_id = :media_id"
                    " AND resolution = 'Unresolved' AND href IS NOT NULL ORDER BY node_id"
                ),
                {"media_id": media_id},
            )
            if not (urlsplit(row.href).scheme or urlsplit(row.href).netloc)
        )
        replacement_issues = reconcile_navigation_source_issues(
            SOURCE_ISSUES.validate_python(publication.source_issues), navigation_issues
        )
    elif isinstance(issues, ReplaceSourceIssues):
        replacement_issues = issues.issues
    if replacement_issues is not None:
        if len(replacement_issues) > MAX_SOURCE_ISSUES:
            raise ApiError(
                ApiErrorCode.E_RESOURCE_LIMIT, "Source diagnostics exceed the output limit"
            )
        _validate_source_issues(db, media_id=media_id, issues=replacement_issues)
        payload = source_issues_payload(replacement_issues)
    else:
        payload = None
    if publication is None:
        if payload is None:
            raise AssertionError("a new publication must replace source issues explicitly")
        db.add(
            ReaderPublication(
                id=new_uuid7(), media_id=media_id, generation=1, source_issues=payload
            )
        )
    else:
        publication.generation = int(publication.generation) + 1
        publication.changed_at = db.scalar(text("SELECT now()"))
        if payload is not None:
            publication.source_issues = payload
    db.flush()
    return result


def replace_reader_document_title(db: Session, *, media: Media, title: str) -> bool:
    """Publish a new title, bumping the generation; ``False`` if there is no publication."""
    kind = str(media.kind)
    if kind not in _ELIGIBLE_KINDS:
        return False
    locked_id = db.scalar(
        select(Media.id).where(Media.id == media.id).with_for_update(key_share=True)
    )
    if locked_id is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if read_publication_generation(db, media_id=locked_id) is None:
        return False

    def replace_projection(published: Media) -> None:
        published.title = title

    replace_reader_publication(
        db,
        media_id=locked_id,
        expected_kind=cast(ReaderDocumentKind, kind),
        replace_projection=replace_projection,
        issues=PreserveSourceIssues(),
    )
    return True


def ensure_reader_publication(db: Session, *, media_id: UUID) -> bool:
    """Publish one eligible ready document at generation 1; an existing row is left as is."""
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None or str(media.kind) not in _ELIGIBLE_KINDS:
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
    return True


def delete_reader_publication(db: Session, *, media_id: UUID) -> None:
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == media_id).with_for_update()
    )
    if publication is not None:
        db.delete(publication)
        db.flush()


def normalize_stored_web_publication(
    db: Session, *, media_id: UUID, expected_generation: int, expected_index_revision: int
) -> int:
    """Repair stored heading ids without changing canonical coordinates or issue facts.

    The caller requests reindex in this transaction after the returned generation.
    """
    from nexus.services.canonicalize import generate_canonical_text
    from nexus.services.html_tree import inner_html
    from nexus.services.web_article_structure import add_heading_anchors

    def replace_projection(_media: Media) -> None:
        current_generation = read_publication_generation(db, media_id=media_id)
        if current_generation != expected_generation:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Reader publication changed")
        revision = db.scalar(
            text(
                "SELECT revision FROM content_index_states WHERE owner_kind = 'media' AND owner_id = :media_id"
            ),
            {"media_id": media_id},
        )
        if revision is None or int(revision) != expected_index_revision:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Content index revision changed")
        rows = (
            db.execute(
                text(
                    "SELECT id, idx, canonical_text, html_sanitized FROM fragments WHERE media_id = :media_id ORDER BY idx"
                ),
                {"media_id": media_id},
            )
            .mappings()
            .all()
        )
        if not rows:
            raise ConflictError(ApiErrorCode.E_REPAIR_NOT_ALLOWED, "No stored web fragments")
        for row in rows:
            old_html = str(row["html_sanitized"])
            root = fragment_fromstring(old_html, create_parent=True)
            for heading in root.iter():
                if not isinstance(heading, HtmlElement) or heading.tag not in {
                    "h1",
                    "h2",
                    "h3",
                    "h4",
                    "h5",
                    "h6",
                }:
                    continue
                authored_id = heading.get("id")
                if authored_id and not authored_id.startswith(
                    f"nexus-web-heading-{int(row['idx'])}-"
                ):
                    anchor = Element("span")
                    anchor.set("id", authored_id)
                    heading.addprevious(anchor)
                    del heading.attrib["id"]
            new_html = add_heading_anchors(inner_html(root), fragment_idx=int(row["idx"]))
            if add_heading_anchors(new_html, fragment_idx=int(row["idx"])) != new_html:
                raise ConflictError(
                    ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Normalization is not stable"
                )
            if generate_canonical_text(new_html) != row["canonical_text"]:
                raise ConflictError(
                    ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Normalization changed canonical text"
                )
            old_root = fragment_fromstring(old_html, create_parent=True)
            new_root = fragment_fromstring(new_html, create_parent=True)
            for attribute in ("id", "name"):
                old_values = [
                    value
                    for value in old_root.xpath(f".//*[@{attribute}]/@{attribute}")
                    if isinstance(value, str)
                ]
                new_values = [
                    value
                    for value in new_root.xpath(f".//*[@{attribute}]/@{attribute}")
                    if isinstance(value, str)
                ]
                if not Counter(old_values) <= Counter(new_values):
                    raise ConflictError(
                        ApiErrorCode.E_REPAIR_NOT_ALLOWED,
                        "Normalization removed an authored target",
                    )
            if new_html != old_html:
                db.execute(
                    text("UPDATE fragments SET html_sanitized = :html WHERE id = :fragment_id"),
                    {"html": new_html, "fragment_id": row["id"]},
                )

    replace_reader_publication(
        db,
        media_id=media_id,
        expected_kind="web_article",
        replace_projection=replace_projection,
        issues=PreserveSourceIssues(),
    )
    return expected_generation + 1


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
