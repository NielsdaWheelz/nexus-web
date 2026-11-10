"""reader publication generations and source pin fences; titles remain metadata.

pieces own ordinary readable generations but cannot own source replacement. an
accepted definition pins its root generation until final source-family teardown.
source replacement/composition refuses while pinned; index and metadata work do
not advance this clock. publishers share the complete root/child media barrier.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
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


@dataclass(frozen=True)
class ReaderPublicationSource:
    attempt_id: UUID
    extent: Literal["complete", "excerpt", "unknown"]
    published_at: datetime | None
    published_on: date | None


def read_publication_generation(db: Session, *, media_id: UUID) -> int | None:
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == media_id)
    )
    return None if generation is None else int(generation)


def advance_reader_publications(db: Session, *, media_ids: Sequence[UUID]) -> None:
    """Publish an atomic composition change after bodies and cursors are reconciled.

    The source publisher already holds every affected media in ascending order.
    A canonical source and every rendering parent advance once in the same commit;
    finite media observations include even an otherwise idle parent's new generation.
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
    source: ReaderPublicationSource | None = None,
) -> T:
    """Lock media, then the publication row, then install the source pointer and bump."""
    from nexus.services import media_locks
    from nexus.services.media_parts import require_unpinned_source
    from nexus.services.search import projection

    media_locks.lock_media_rows_in_order(db, [media_id])
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
        publication = ReaderPublication(
            id=new_uuid7(),
            media_id=media_id,
            generation=1,
            source_issues=payload,
            content_extent="complete",
        )
        db.add(publication)
    else:
        publication.generation = int(publication.generation) + 1
        publication.changed_at = db.scalar(text("SELECT now()"))
        publication.source_issues = payload
    if source is not None:
        assert source.published_at is None or source.published_on is None
        publication.source_attempt_id = source.attempt_id
        publication.content_extent = source.extent
        publication.publisher_published_at = source.published_at
        publication.publisher_published_on = source.published_on
    db.flush()
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


def repair_reader_html(
    db: Session,
    *,
    media_id: UUID,
    expected_generation: int,
    fragment_sha256: dict[UUID, str],
) -> int:
    """Repair reviewed web HTML without changing any canonical coordinate or capture.

    The caller owns one serializable transaction. Exact input hashes fence the
    reviewed repair. Pins or structural navigation require their owner's explicit
    conversion instead. Offset references are preserved by complete text/identity
    equality; the ordinary resolver additionally proves retained quote locations.
    """
    import hashlib

    from nexus.services import locator_resolver, media_locks
    from nexus.services.canonicalize import CanonicalStructure, canonicalize_structure
    from nexus.services.content_indexing import reconcile_media_section_bounds
    from nexus.services.fragment_tables import insert_fragment_tables
    from nexus.services.html_tree import inner_html, normalize_html5_shape
    from nexus.services.media_parts import require_unpinned_source
    from nexus.services.text_quote import normalize_for_match

    def named_bounds(
        structure: CanonicalStructure, names: dict[str, int]
    ) -> dict[str, tuple[int, int]]:
        # Named targets contain element indices, which change when wrappers are added.
        return {
            name: (structure.elements[index].start_offset, structure.elements[index].end_offset)
            for name, index in names.items()
        }

    media_locks.lock_media_rows_in_order(db, [media_id])
    require_unpinned_source(db, media_id=media_id)
    if lock_publication_generation(db, media_id=media_id) != expected_generation:
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Repair publication changed")
    if (
        db.scalar(text("SELECT kind::text FROM media WHERE id=:id"), {"id": media_id})
        != "web_article"
    ):
        raise InvalidRequestError(message="HTML repair requires a reviewed web article")
    if db.scalar(
        text("""SELECT EXISTS (SELECT 1 FROM epub_nav_locations WHERE media_id=:id
        AND (start_dom_path IS NOT NULL OR end_dom_path IS NOT NULL))"""),
        {"id": media_id},
    ):
        raise ConflictError(
            ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Structural navigation needs its own repair"
        )
    fragments = db.execute(
        text("""SELECT id, idx, canonical_text, html_sanitized
        FROM fragments WHERE media_id=:id ORDER BY idx FOR UPDATE"""),
        {"id": media_id},
    ).all()
    if {row.id for row in fragments} != set(fragment_sha256):
        raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Repair fragment set changed")
    replacements = []
    for fragment in fragments:
        if (
            hashlib.sha256(fragment.html_sanitized.encode()).hexdigest()
            != fragment_sha256[fragment.id]
        ):
            raise ConflictError(ApiErrorCode.E_READER_CONTENT_CHANGED, "Repair source changed")
        before = canonicalize_structure(fragment.html_sanitized)
        root = fragment_fromstring(fragment.html_sanitized, create_parent=True)
        serialized = inner_html(root)
        normalize_html5_shape(root)
        repaired = inner_html(root)
        after = canonicalize_structure(repaired)
        # justify-defect: these complete equalities are the repair's admission proof.
        if (
            before.text != fragment.canonical_text
            or after.text != before.text
            or named_bounds(after, after.anchors) != named_bounds(before, before.anchors)
            or named_bounds(after, after.apparatus_items)
            != named_bounds(before, before.apparatus_items)
            or after.x_embed_slots != before.x_embed_slots
        ):
            raise ValueError(f"HTML repair changed source coordinates: {fragment.id}")
        if repaired != serialized:
            replacements.append((fragment.id, repaired, after.tables))
    if not replacements:
        return expected_generation

    from pydantic import TypeAdapter

    from nexus.auth.permissions import can_read_media
    from nexus.schemas.reader import (
        StoredReaderCursor,
        StoredReaderCursorPositioned,
        WebReaderResumeState,
        XReaderResumeState,
    )
    from nexus.schemas.reader_document import ReaderTextDocumentOut
    from nexus.schemas.resource_evidence import CapturedEvidence
    from nexus.schemas.resource_items import (
        CitationSourceTargetKey,
        LocatedSourceLocationOut,
        ReaderQuoteSourceTargetKey,
        ResourceSourceTargetKey,
        RetrievalSourceTargetKey,
        SourceTargetKey,
        UnavailableSourceLocationOut,
    )
    from nexus.schemas.retrieval import EpubFragmentOffsetsLocator, WebTextOffsetsLocator
    from nexus.services.consumption import reader_cursor
    from nexus.services.reader_document import read_reader_document
    from nexus.services.resource_items.evidence import resolve_source_target

    owner_ref = f"media:{media_id}"
    selectors = []
    targets: list[tuple[UUID, SourceTargetKey]] = []
    for row in db.execute(
        text("""SELECT user_id,id,selector,'passage_anchor' AS scheme FROM passage_anchors
            WHERE owner_scheme='media' AND owner_id=:id
            UNION ALL SELECT user_id,id,jsonb_build_object('exact',exact,'prefix',prefix,'suffix',suffix),'highlight'
            FROM highlights WHERE anchor_media_id=:id"""),
        {"id": media_id},
    ):
        quote = row.selector.get("quote", row.selector.get("text_quote", row.selector))
        if not isinstance(quote, dict) or not isinstance(quote.get("exact"), str):
            raise ValueError("Repair cannot prove a retained quote's shape")
        selectors.append(
            tuple(
                normalize_for_match(quote.get(key) or "").text.strip()
                for key in ("exact", "prefix", "suffix")
            )
        )
        targets.append(
            (
                row.user_id,
                ResourceSourceTargetKey(resource_ref=f"{row.scheme}:{row.id}", field=None),
            )
        )

    captures = db.execute(
        text("""SELECT 'retrieval' AS kind,r.id,c.owner_user_id AS viewer,r.captured_evidence AS evidence
            FROM message_retrievals r JOIN messages m ON m.id=r.assistant_message_id
            JOIN conversations c ON c.id=m.conversation_id
            WHERE r.media_id=:id OR r.captured_evidence #>> '{target,owner_ref}'=:ref
               OR r.captured_evidence #>> '{target,locator,media_id}'=CAST(:id AS text)
            UNION ALL
            SELECT 'reader_quote',m.id,c.owner_user_id,m.reader_selection_snapshot->'evidence'
            FROM messages m JOIN conversations c ON c.id=m.conversation_id
            WHERE m.reader_selection_snapshot #>> '{evidence,target,owner_ref}'=:ref
               OR m.reader_selection_snapshot #>> '{evidence,target,locator,media_id}'=CAST(:id AS text)
            UNION ALL
            SELECT 'citation',e.id,COALESCE(e.user_id,c.owner_user_id,source.created_by_user_id,target.created_by_user_id),e.snapshot->'evidence'
            FROM resource_edges e
            LEFT JOIN messages m ON e.source_scheme='message' AND m.id=e.source_id
            LEFT JOIN conversations c ON c.id=m.conversation_id
            LEFT JOIN media source ON e.source_scheme='media' AND source.id=e.source_id
            JOIN media target ON target.id=:id
            WHERE e.origin='citation' AND e.snapshot->'evidence' IS NOT NULL AND (
                e.snapshot #>> '{evidence,target,owner_ref}'=:ref
                OR e.snapshot #>> '{evidence,target,locator,media_id}'=CAST(:id AS text))"""),
        {"id": media_id, "ref": owner_ref},
    ).all()
    for row in captures:
        evidence = CapturedEvidence.model_validate(row.evidence)
        if evidence.quote is not None:
            quote = evidence.quote
            selectors.append(
                tuple(
                    normalize_for_match(value or "").text.strip()
                    for value in (quote.exact, quote.prefix, quote.suffix)
                )
            )
        if row.viewer is None:
            continue
        match row.kind:
            case "retrieval":
                key = RetrievalSourceTargetKey(retrieval_id=row.id)
            case "reader_quote":
                key = ReaderQuoteSourceTargetKey(message_id=row.id)
            case "citation":
                key = CitationSourceTargetKey(edge_id=row.id, side="target")
            case _:
                raise AssertionError(
                    "Unknown retained reader reference"
                )  # justify-defect: the closed SQL union above owns these tags.
        targets.append((row.viewer, key))

    def reference_locations():
        results = []
        for viewer, key in targets:
            try:
                results.append(resolve_source_target(db, viewer_id=viewer, target=key))
            except NotFoundError:
                # justify-ignore-error: an already hidden/deleted reference is not a previously valid location.
                results.append(None)
        return results

    previous_locations = reference_locations()
    cursor_type = TypeAdapter(StoredReaderCursor)
    cursors = []
    for row in db.execute(
        text(
            "SELECT user_id,cursor FROM reader_media_state WHERE media_id=:id AND cursor IS NOT NULL ORDER BY user_id FOR UPDATE"
        ),
        {"id": media_id},
    ):
        stored = cursor_type.validate_python(row.cursor)
        if not isinstance(stored, StoredReaderCursorPositioned) or not can_read_media(
            db, row.user_id, media_id
        ):
            continue
        locator = stored.locator
        if not isinstance(locator, (WebReaderResumeState, XReaderResumeState)):
            raise ValueError("HTML repair cannot prove this saved reader point")
        document = read_reader_document(db, row.user_id, media_id)
        if not isinstance(document, ReaderTextDocumentOut):
            raise ValueError("HTML repair has no text reader")
        unit_id = (
            locator.occurrence_id
            if isinstance(locator, XReaderResumeState)
            else locator.target.fragment_id
        )
        unit = next((unit for unit in document.units if unit.id == unit_id), None)
        offset = locator.locations.text_offset
        valid = unit is not None and offset is not None and 0 <= offset <= unit.char_count
        cursors.append(
            (
                row.user_id,
                reader_cursor.load(db, viewer_id=row.user_id, media_id=media_id),
                unit_id,
                offset,
                valid,
            )
        )

    reads = locator_resolver.read_passage_sources(db, [("media", media_id)])
    resolved = [
        locator_resolver.resolve_passage_selector(
            db,
            owner_scheme="media",
            owner_id=media_id,
            exact=exact,
            prefix=prefix,
            suffix=suffix,
            source_reads=reads,
        )
        for exact, prefix, suffix in selectors
    ]
    for fragment_id, repaired, tables in replacements:
        db.execute(
            text("UPDATE fragments SET html_sanitized=:html WHERE id=:id"),
            {"id": fragment_id, "html": repaired},
        )
        db.execute(text("DELETE FROM fragment_tables WHERE fragment_id=:id"), {"id": fragment_id})
        insert_fragment_tables(db, fragment_id, tables)
    db.flush()
    advance_reader_publications(db, media_ids=[media_id])
    reconcile_media_section_bounds(db, media_id=media_id)
    db.flush()
    generation = read_publication_generation(db, media_id=media_id)
    assert generation is not None and generation == expected_generation + 1
    reads = locator_resolver.read_passage_sources(db, [("media", media_id)])
    for (exact, prefix, suffix), previous in zip(selectors, resolved, strict=True):
        current = locator_resolver.resolve_passage_selector(
            db,
            owner_scheme="media",
            owner_id=media_id,
            exact=exact,
            prefix=prefix,
            suffix=suffix,
            source_reads=reads,
        )
        if previous.locator is not None and current.locator != previous.locator:
            raise ValueError("HTML repair changed a retained quote's resolution")
    for previous, current in zip(previous_locations, reference_locations(), strict=True):
        if previous is None or isinstance(previous.location, UnavailableSourceLocationOut):
            continue
        if current is None or previous.source_activation != current.source_activation:
            raise ValueError("HTML repair changed a retained reference's activation")
        if isinstance(previous.location, LocatedSourceLocationOut):
            if (
                not isinstance(current.location, LocatedSourceLocationOut)
                or previous.location.model_dump(exclude={"source_identity"})
                != current.location.model_dump(exclude={"source_identity"})
                or current.location.source_identity
                != (
                    f"g{generation}"
                    if isinstance(
                        previous.location.locator,
                        (WebTextOffsetsLocator, EpubFragmentOffsetsLocator),
                    )
                    and str(previous.location.locator.media_id) == str(media_id)
                    else previous.location.source_identity
                )
            ):
                raise ValueError("HTML repair invalidated a retained captured location")
        elif current.location != previous.location:
            raise ValueError("HTML repair changed a retained reference's location")
    for viewer, previous, unit_id, offset, valid in cursors:
        if reader_cursor.load(db, viewer_id=viewer, media_id=media_id) != previous:
            raise ValueError("HTML repair changed a saved reader cursor")
        if valid:
            document = read_reader_document(db, viewer, media_id)
            if not isinstance(document, ReaderTextDocumentOut) or not any(
                unit.id == unit_id and offset is not None and 0 <= offset <= unit.char_count
                for unit in document.units
            ):
                raise ValueError("HTML repair invalidated a saved reader point")
    return generation
