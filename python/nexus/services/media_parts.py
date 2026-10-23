"""piece definitions, candidate decisions and source lifetime admission.

creates replay the original normalized accepted selector before current navigation
admission; mutable labels never define identity. updates set absolute values and
accept an already-desired result before version refusal. candidate bindings never
change identity. commands own retry/commit; publication helpers compose in the
caller's existing transaction. every writer takes the complete source barrier,
then publication/definition/set rows. no provider work runs under these locks.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import (
    ContentIndexState,
    Media,
    MediaPart,
    MediaPartCandidate,
    MediaPartSet,
    ProcessingStatus,
    ReaderPublication,
)
from nexus.db.retries import retry_read_committed
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.ids import new_uuid7
from nexus.schemas.media_parts import (
    CandidateReceipt,
    CandidateRow,
    PartAction,
    PartCandidateDecision,
    PartCapabilities,
    PartCreate,
    PartDefinition,
    PartFinding,
    PartForm,
    PartListRow,
    PartPage,
    PartPreview,
    PartReceipt,
    PartRow,
    PartSectionChoice,
    PartUpdate,
    SectionSelection,
)
from nexus.schemas.reader import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.reader_document import ReaderPartDocumentOut
from nexus.services import library_entries, users
from nexus.services.reader_navigation import read_media_navigation_proof
from nexus.services.reader_structure import DocumentPoint, DomCut, NavigationProof
from nexus.services.reader_text_slice import (
    clip_reader_fragment,
    dom_cuts_equivalent,
    section_witness_key,
)
from nexus.services.suggestion_changes import record_input_change


@dataclass(frozen=True, slots=True)
class ProvedPartSelection:
    source_media_id: UUID
    source_generation: int
    selection: SectionSelection
    start: DocumentPoint
    end: DocumentPoint
    start_cut: DomCut
    end_cut: DomCut
    word_count: int

    @property
    def range_key(self) -> str:
        return _range_key(self.source_generation, self.start, self.end)


def _range_key(generation: int, start: DocumentPoint, end: DocumentPoint) -> str:
    return hashlib.sha256(
        json.dumps(
            [generation, start.fragment_idx, start.offset, end.fragment_idx, end.offset],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _conflict(reason: str, message: str) -> ConflictError:
    return ConflictError(ApiErrorCode.E_PART_CONFLICT, message, details={"reason": reason})


def _invalid(reason: str, message: str) -> InvalidRequestError:
    error = InvalidRequestError(ApiErrorCode.E_PART_SELECTION_INVALID, message)
    error.details = {"reason": reason}
    return error


def normalized_selection(selection: SectionSelection) -> SectionSelection:
    """section ordering is creation-insensitive; current catalogue proves actual order."""
    return selection.model_copy(update={"section_ids": sorted(selection.section_ids)})


def require_unpinned_source(db: Session, *, media_id: UUID) -> None:
    """call under the source barrier before body/composition replacement or supersession."""
    if (
        db.scalar(select(MediaPart.media_id).where(MediaPart.source_media_id == media_id).limit(1))
        is not None
    ):
        raise ConflictError(
            ApiErrorCode.E_PART_SOURCE_PINNED,
            "pieces refer to this saved text, so it can’t be replaced",
            details={"reason": "source_pinned"},
        )


def _source(db: Session, viewer_id: UUID, source_id: UUID, *, creator: bool) -> Media:
    if not can_read_media(db, viewer_id, source_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    media = db.get(Media, source_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    if creator and media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_OWNER_REQUIRED, "only the source creator can choose pieces"
        )
    reason = part_source_block_reason(db, media=media)
    if reason == "unsupported_source":
        raise _invalid("unsupported_source", "this source cannot be read as separate pieces")
    if reason == "not_ready":
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "media is not ready for reading")
    return media


def part_source_block_reason(
    db: Session, *, media: Media
) -> Literal["unsupported_source", "not_ready"] | None:
    """the same concrete source eligibility governs catalogue reads and writes."""
    if (
        media.kind not in ("epub", "web_article")
        or media.provider == "x"
        or db.scalar(
            text("""
        SELECT 1 FROM document_embeds WHERE media_id=:id AND provider='x'
        AND embed_kind='post' AND canonical_end_offset IS NOT NULL LIMIT 1
    """),
            {"id": media.id},
        )
        is not None
    ):
        return "unsupported_source"
    if media.processing_status != ProcessingStatus.ready_for_reading:
        return "not_ready"
    return None


def lock_source_parts(db: Session, source_id: UUID) -> MediaPartSet:
    library_entries.lock_media_for_reference(db, source_id)
    family = library_entries.media_family_ids(db, [source_id])
    db.execute(
        select(ReaderPublication)
        .where(ReaderPublication.media_id.in_(family))
        .order_by(ReaderPublication.media_id)
        .with_for_update()
    ).all()
    db.execute(
        select(MediaPart)
        .where(MediaPart.source_media_id == source_id)
        .order_by(MediaPart.media_id)
        .with_for_update()
    ).all()
    part_set = db.scalar(
        select(MediaPartSet).where(MediaPartSet.source_media_id == source_id).with_for_update()
    )
    if part_set is None:
        part_set = MediaPartSet(source_media_id=source_id, revision=0)
        db.add(part_set)
        db.flush()
    return part_set


def _proof(db: Session, source: Media) -> NavigationProof:
    publication = db.scalar(
        select(ReaderPublication).where(ReaderPublication.media_id == source.id)
    )
    if publication is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "media is not ready for reading")
    return read_media_navigation_proof(
        db,
        media_id=source.id,
        kind=cast(Literal["epub", "web_article"], source.kind),
        generation=publication.generation,
    )


def resolve_part_selection(
    db: Session, *, source: Media, selection: SectionSelection
) -> ProvedPartSelection:
    """prove one finite section or a continuous, nonoverlapping sibling sequence."""
    proof = _proof(db, source)
    if (
        selection.source_generation != proof.navigation.generation
        or selection.navigation_key != proof.key
    ):
        raise _conflict("navigation_changed", "these sections changed; reload them")
    state = db.scalar(
        select(ContentIndexState).where(
            ContentIndexState.owner_kind == "media", ContentIndexState.owner_id == source.id
        )
    )
    if state is None or state.section_witness_key != section_witness_key(
        selection.source_generation, proof.sections
    ):
        raise _conflict("preparing_structure", "prepare sections before choosing a piece")
    offered = {section.section_id: section for section in proof.sections}
    if any(section_id not in offered for section_id in selection.section_ids):
        raise _invalid("unknown_section", "choose sections from the current contents")
    selected = sorted(
        (offered[section_id] for section_id in selection.section_ids),
        key=lambda section: section.start,
    )
    if any(section.end is None for section in selected):
        raise _invalid("unknown_end", "this section’s end hasn’t been identified")
    if any(section.start_cut is None or section.end_cut is None for section in selected):
        raise _invalid(
            "unproved_structure", "this section can’t yet be read separately without losing content"
        )
    if len(selected) > 1 and len({section.parent_section_id for section in selected}) != 1:
        raise _invalid("not_siblings", "choose consecutive sections with the same parent")
    if len(selected) > 1:
        siblings = [
            section.section_id
            for section in sorted(
                (
                    section
                    for section in proof.sections
                    if section.parent_section_id == selected[0].parent_section_id
                ),
                key=lambda section: section.start,
            )
        ]
        positions = sorted(siblings.index(section.section_id) for section in selected)
        if positions != list(range(positions[0], positions[-1] + 1)):
            raise _invalid("nonconsecutive_sections", "choose consecutive sibling sections")
    fragments = db.execute(
        text(
            "SELECT idx,canonical_text,html_sanitized FROM fragments WHERE media_id=:id ORDER BY idx"
        ),
        {"id": source.id},
    ).all()
    by_idx = {row.idx: row for row in fragments}
    spine = {row.idx: idx for idx, row in enumerate(fragments)}
    for previous, current in zip(selected, selected[1:], strict=False):
        end = previous.end
        assert end is not None
        if end == current.start:
            assert previous.end_cut is not None and current.start_cut is not None
            if not dom_cuts_equivalent(
                by_idx[end.fragment_idx].html_sanitized, previous.end_cut, current.start_cut
            ):
                raise _invalid(
                    "unproved_structure", "section boundaries do not prove continuous rich content"
                )
            continue
        if (
            spine[current.start.fragment_idx] == spine[end.fragment_idx] + 1
            and end.offset == len(by_idx[end.fragment_idx].canonical_text)
            and current.start.offset == 0
            and previous.end_cut == DomCut((), "after")
            and current.start_cut == DomCut((), "before")
        ):
            continue
        raise _invalid("noncontiguous_sections", "choose continuous, nonoverlapping sections")
    first, last = selected[0], selected[-1]
    assert first.start_cut is not None and last.end_cut is not None and last.end is not None
    if first.start >= last.end:
        raise _invalid("empty_extent", "the selected piece must contain text")
    words = 0
    for row in fragments:
        if not first.start.fragment_idx <= row.idx <= last.end.fragment_idx:
            continue
        start = first.start.offset if row.idx == first.start.fragment_idx else 0
        end = last.end.offset if row.idx == last.end.fragment_idx else len(row.canonical_text)
        try:
            clipped = clip_reader_fragment(
                html_sanitized=row.html_sanitized,
                canonical_text=row.canonical_text,
                start_offset=start,
                end_offset=end,
                start_cut=first.start_cut
                if row.idx == first.start.fragment_idx
                else DomCut((), "before"),
                end_cut=last.end_cut if row.idx == last.end.fragment_idx else DomCut((), "after"),
            )
        except ValueError as error:
            raise _invalid(
                "unproved_structure",
                "this section can’t yet be read separately without losing content",
            ) from error
        words += len(clipped.canonical_text.split())
    if words == 0:
        raise _invalid("empty_extent", "the selected piece must contain text")
    return ProvedPartSelection(
        source.id,
        selection.source_generation,
        normalized_selection(selection),
        first.start,
        last.end,
        first.start_cut,
        last.end_cut,
        words,
    )


def _receipt(db: Session, part: MediaPart) -> PartReceipt:
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == part.media_id)
    )
    revision = db.scalar(
        select(MediaPartSet.revision).where(MediaPartSet.source_media_id == part.source_media_id)
    )
    assert generation is not None and revision is not None
    return PartReceipt(
        media_id=part.media_id,
        version=part.version,
        body_generation=generation,
        set_revision=revision,
    )


def read_part_receipt(db: Session, *, media_id: UUID) -> PartReceipt:
    part = db.get(MediaPart, media_id)
    assert part is not None
    return _receipt(db, part)


def advance_part_definition(db: Session, *, media_id: UUID) -> None:
    """an actual metadata/credit change, already locked and version-checked by its owner."""
    part = db.get(MediaPart, media_id)
    if part is None:
        return
    part.version += 1
    part_set = db.get(MediaPartSet, part.source_media_id)
    assert part_set is not None
    part_set.revision += 1
    db.flush()
    for changed_id in (media_id, part.source_media_id):
        db.execute(text("SELECT pg_notify('media_events',:id)"), {"id": str(changed_id)})


def part_definition_version(db: Session, *, media_id: UUID) -> int | None:
    return db.scalar(select(MediaPart.version).where(MediaPart.media_id == media_id))


def require_part_definition_version(
    db: Session, *, media_id: UUID, expected_version: int | None
) -> None:
    current = part_definition_version(db, media_id=media_id)
    if current is not None and current != expected_version:
        raise _conflict("definition_changed", "this piece changed; reload before editing")


def _candidate_row(candidate: MediaPartCandidate, *, bound_title: str | None) -> CandidateRow:
    return CandidateRow(
        id=candidate.id,
        version=candidate.version,
        finding=None
        if candidate.finding is None
        else PartFinding.model_validate(candidate.finding),
        user_decision=candidate.user_decision,
        part_id=candidate.part_id,
        bound_title=bound_title,
    )


def _extent_conflict(
    db: Session, extent: ProvedPartSelection, *, except_id: UUID | None = None
) -> None:
    existing = db.scalar(
        select(MediaPart.media_id).where(
            MediaPart.source_media_id == extent.source_media_id,
            MediaPart.source_generation == extent.source_generation,
            MediaPart.start_fragment_idx == extent.start.fragment_idx,
            MediaPart.start_offset == extent.start.offset,
            MediaPart.end_fragment_idx == extent.end.fragment_idx,
            MediaPart.end_offset == extent.end.offset,
            MediaPart.media_id != except_id if except_id is not None else text("TRUE"),
        )
    )
    if existing is not None:
        raise _conflict("existing_piece", "these sections already have a piece")


def _set_extent(part: MediaPart, extent: ProvedPartSelection) -> None:
    part.source_generation = extent.source_generation
    part.start_fragment_idx, part.start_offset = extent.start.fragment_idx, extent.start.offset
    part.end_fragment_idx, part.end_offset = extent.end.fragment_idx, extent.end.offset
    part.start_dom_path, part.start_dom_edge = list(extent.start_cut.path), extent.start_cut.edge
    part.end_dom_path, part.end_dom_edge = list(extent.end_cut.path), extent.end_cut.edge
    part.word_count = extent.word_count


def publish_part(
    db: Session,
    *,
    creator_id: UUID,
    part_id: UUID,
    extent: ProvedPartSelection,
    title: str,
    form: PartForm | None,
    candidate: MediaPartCandidate,
    decision: Literal["accepted"] | None,
) -> PartReceipt:
    """publish under the caller's family/publication/set barrier; never file or enrich."""
    # justify-service-invariant-check: the queue and manual commands share this
    # publication boundary; its bound observation must identify the proved range.
    assert (
        candidate.source_media_id,
        candidate.source_generation,
        candidate.range_key,
        candidate.start_fragment_idx,
        candidate.start_offset,
        candidate.end_fragment_idx,
        candidate.end_offset,
    ) == (
        extent.source_media_id,
        extent.source_generation,
        extent.range_key,
        extent.start.fragment_idx,
        extent.start.offset,
        extent.end.fragment_idx,
        extent.end.offset,
    )
    if candidate.part_id is not None:
        raise _conflict("existing_piece", "this proposal already has a piece")
    if part_id == extent.source_media_id or db.get(Media, part_id) is not None:
        raise _conflict("identity_conflict", "this piece id is already in use")
    _extent_conflict(db, extent)
    inserted = db.scalar(
        insert(Media)
        .values(
            id=part_id,
            kind="text_part",
            title=title,
            created_by_user_id=creator_id,
            processing_status=ProcessingStatus.ready_for_reading,
        )
        .on_conflict_do_nothing(index_elements=["id"])
        .returning(Media.id)
    )
    if inserted is None:
        raise _conflict("identity_conflict", "this piece id is already in use")
    part = MediaPart(media_id=part_id, source_media_id=extent.source_media_id, version=1, form=form)
    _set_extent(part, extent)
    db.add(part)
    db.add(ReaderPublication(id=new_uuid7(), media_id=part_id, generation=1, source_issues=[]))
    if candidate.finding is not None:
        finding = PartFinding.model_validate(candidate.finding)
        if finding.contributors is not None:
            from nexus.services.contributor_taxonomy import (
                ContributorObservation,
                ObservedRoleSlices,
                parse_contributor_handle,
            )
            from nexus.services.contributors import (
                apply_prepared_role_slices_in_current_transaction,
                prepare_contained_work_role_slices_in_current_transaction,
            )

            observation = ObservedRoleSlices(
                managed_roles=frozenset(role_slice.role for role_slice in finding.contributors),
                credits=tuple(
                    ContributorObservation(
                        credit.credited_name,
                        role_slice.role,
                        credit.raw_role,
                        None,
                        None
                        if credit.contributor_handle is None
                        else parse_contributor_handle(credit.contributor_handle),
                    )
                    for role_slice in finding.contributors
                    for credit in role_slice.credits
                ),
            )
            prepared = prepare_contained_work_role_slices_in_current_transaction(
                db,
                source_media_id=extent.source_media_id,
                part_media_id=part_id,
                observation=observation,
            )
            apply_prepared_role_slices_in_current_transaction(db, prepared=prepared)
    candidate.part_id = part_id
    candidate.accepted_selection = extent.selection.model_dump(mode="json")
    candidate.user_decision = decision
    candidate.version += 1
    part_set = db.get(MediaPartSet, extent.source_media_id)
    assert part_set is not None
    part_set.revision += 1
    db.flush()
    from nexus.services.content_indexing import reconcile_media_section_bounds

    reconcile_media_section_bounds(db, media_id=extent.source_media_id)
    for changed_id in (part_id, extent.source_media_id):
        db.execute(text("SELECT pg_notify('media_events',:id)"), {"id": str(changed_id)})
    record_input_change(db)
    return _receipt(db, part)


def _candidate(
    db: Session,
    *,
    source_media_id: UUID,
    source_generation: int,
    start: DocumentPoint,
    end: DocumentPoint,
) -> MediaPartCandidate:
    range_key = _range_key(source_generation, start, end)
    candidate = db.scalar(
        select(MediaPartCandidate)
        .where(
            MediaPartCandidate.source_media_id == source_media_id,
            MediaPartCandidate.source_generation == source_generation,
            MediaPartCandidate.range_key == range_key,
        )
        .with_for_update()
    )
    if candidate is None:
        candidate = MediaPartCandidate(
            id=new_uuid7(),
            source_media_id=source_media_id,
            source_generation=source_generation,
            range_key=range_key,
            start_fragment_idx=start.fragment_idx,
            start_offset=start.offset,
            end_fragment_idx=end.fragment_idx,
            end_offset=end.offset,
            finding=None,
            user_decision=None,
            part_id=None,
            accepted_selection=None,
            version=1,
        )
        db.add(candidate)
        db.flush()
    return candidate


def create_part(
    db: Session, *, viewer_id: UUID, source_media_id: UUID, request: PartCreate
) -> PartReceipt:
    def create() -> PartReceipt:
        library_entries.lock_media_rows_in_order(db, [source_media_id])
        existing = db.get(Media, request.id)
        if existing is not None:
            part = db.get(MediaPart, request.id)
            original = db.scalar(
                select(MediaPartCandidate).where(MediaPartCandidate.part_id == request.id)
            )
            if (
                part is None
                or existing.created_by_user_id != viewer_id
                or existing.kind != "text_part"
                or part.source_media_id != source_media_id
                or original is None
                or original.accepted_selection
                != normalized_selection(request.selection).model_dump(mode="json")
            ):
                raise _conflict("identity_conflict", "this piece id names a different creation")
            receipt = _receipt(db, part)
            db.commit()
            return receipt
        source = _source(db, viewer_id, source_media_id, creator=True)
        lock_source_parts(db, source_media_id)
        extent = resolve_part_selection(db, source=source, selection=request.selection)
        receipt = publish_part(
            db,
            creator_id=viewer_id,
            part_id=request.id,
            extent=extent,
            title=request.title,
            form=request.form,
            candidate=_candidate(
                db,
                source_media_id=extent.source_media_id,
                source_generation=extent.source_generation,
                start=extent.start,
                end=extent.end,
            ),
            decision="accepted",
        )
        db.commit()
        return receipt

    return retry_read_committed(db, "create_part", create)


def update_part(
    db: Session, *, viewer_id: UUID, media_id: UUID, request: PartUpdate
) -> PartReceipt:
    def update() -> PartReceipt:
        library_entries.lock_media_rows_in_order(db, [media_id])
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
        media = db.get(Media, media_id)
        part = db.get(MediaPart, media_id)
        if media is None or part is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "piece not found")
        if media.created_by_user_id != viewer_id:
            raise ForbiddenError(
                ApiErrorCode.E_OWNER_REQUIRED, "only the piece creator can edit it"
            )
        lock_source_parts(db, part.source_media_id)
        extent = (
            None
            if request.selection is None
            else resolve_part_selection(
                db,
                source=_source(db, viewer_id, part.source_media_id, creator=True),
                selection=request.selection,
            )
        )
        body_changed = extent is not None and (
            part.start_fragment_idx,
            part.start_offset,
            part.end_fragment_idx,
            part.end_offset,
            tuple(part.start_dom_path),
            part.start_dom_edge,
            tuple(part.end_dom_path),
            part.end_dom_edge,
        ) != (
            extent.start.fragment_idx,
            extent.start.offset,
            extent.end.fragment_idx,
            extent.end.offset,
            extent.start_cut.path,
            extent.start_cut.edge,
            extent.end_cut.path,
            extent.end_cut.edge,
        )
        changed = media.title != request.title or part.form != request.form or body_changed
        if changed:
            require_part_definition_version(
                db, media_id=media_id, expected_version=request.expected_version
            )
            if extent is not None:
                _extent_conflict(db, extent, except_id=media_id)
                _set_extent(part, extent)
            media.title, part.form = request.title, request.form
            if body_changed:
                publication = db.scalar(
                    select(ReaderPublication)
                    .where(ReaderPublication.media_id == media_id)
                    .with_for_update()
                )
                assert publication is not None
                publication.generation += 1
                publication.changed_at = db.scalar(text("SELECT now()"))
                db.flush()
                from nexus.services.consumption.reader_cursor import reconcile_part_bounds
                from nexus.services.content_indexing import reconcile_media_section_bounds

                reconcile_part_bounds(db, media_id=media_id)
                reconcile_media_section_bounds(db, media_id=part.source_media_id)
            advance_part_definition(db, media_id=media_id)
            record_input_change(db)
        receipt = _receipt(db, part)
        db.commit()
        return receipt

    return retry_read_committed(db, "update_part", update)


def decide_candidate(
    db: Session,
    *,
    viewer_id: UUID,
    source_media_id: UUID,
    candidate_id: UUID,
    request: PartCandidateDecision,
) -> CandidateReceipt:
    def decide() -> CandidateReceipt:
        users.lock_viewer(db, viewer_id)
        library_entries.lock_media_rows_in_order(db, [source_media_id])
        source = _source(db, viewer_id, source_media_id, creator=True)
        part_set = lock_source_parts(db, source_media_id)
        candidate = db.scalar(
            select(MediaPartCandidate)
            .where(
                MediaPartCandidate.id == candidate_id,
                MediaPartCandidate.source_media_id == source_media_id,
            )
            .with_for_update()
        )
        if candidate is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "proposal not found")
        receipt = None
        desired = candidate.user_decision == request.decision and (
            request.decision == "rejected" or candidate.part_id == request.part_id
        )
        tombstone = (
            candidate.part_id is not None
            and db.scalar(
                text("SELECT 1 FROM user_media_deletions WHERE user_id=:viewer AND media_id=:id"),
                {"viewer": viewer_id, "id": candidate.part_id},
            )
            is not None
        )
        if not desired or (request.decision == "accepted" and tombstone):
            if candidate.version != request.expected_version:
                raise _conflict("candidate_changed", "this proposal changed; reload it")
            if request.decision == "rejected":
                if candidate.part_id is not None:
                    raise _conflict(
                        "published_piece", "remove the published piece from your workspace"
                    )
                candidate.user_decision = "rejected"
                candidate.version += 1
                part_set.revision += 1
            elif candidate.part_id is not None:
                if request.part_id != candidate.part_id:
                    raise _conflict(
                        "identity_conflict", "this proposal already names another piece"
                    )
                from nexus.services.media_deletion import clear_user_media_deletion

                clear_user_media_deletion(db, viewer_id, candidate.part_id)
                candidate.user_decision = "accepted"
                candidate.version += 1
                part_set.revision += 1
                receipt = read_part_receipt(db, media_id=candidate.part_id)
            else:
                if (
                    candidate.source_generation != _proof(db, source).navigation.generation
                    or candidate.finding is None
                ):
                    raise _conflict(
                        "source_changed", "this proposal no longer names the current source"
                    )
                finding = PartFinding.model_validate(candidate.finding)
                proof = _proof(db, source)
                extent = resolve_part_selection(
                    db,
                    source=source,
                    selection=SectionSelection(
                        source_generation=candidate.source_generation,
                        navigation_key=proof.key,
                        section_ids=finding.section_ids,
                    ),
                )
                if extent.range_key != candidate.range_key:
                    raise _conflict("navigation_changed", "this proposal’s sections changed")
                if finding.title is None or not finding.title.strip():
                    raise _invalid("missing_title", "choose a title before publishing this piece")
                assert request.part_id is not None
                receipt = publish_part(
                    db,
                    creator_id=viewer_id,
                    part_id=request.part_id,
                    extent=extent,
                    title=finding.title,
                    form=finding.form,
                    candidate=candidate,
                    decision="accepted",
                )
            db.flush()
            record_input_change(db)
        if receipt is None and request.decision == "accepted" and candidate.part_id is not None:
            receipt = read_part_receipt(db, media_id=candidate.part_id)
        result = CandidateReceipt(
            candidate=_candidate_row(
                candidate,
                bound_title=None
                if candidate.part_id is None
                else db.scalar(select(Media.title).where(Media.id == candidate.part_id)),
            ),
            part=receipt,
            set_revision=part_set.revision,
        )
        db.commit()
        return result

    return retry_read_committed(db, "decide_part_candidate", decide)


def reject_removed_part(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """creator workspace removal records rejection without withdrawing other holders."""
    media = db.get(Media, media_id)
    part = db.get(MediaPart, media_id)
    if media is None or part is None or media.created_by_user_id != viewer_id:
        return
    candidate = db.scalar(
        select(MediaPartCandidate).where(MediaPartCandidate.part_id == media_id).with_for_update()
    )
    assert candidate is not None
    if candidate.user_decision != "rejected":
        candidate.user_decision = "rejected"
        candidate.version += 1
        part_set = db.get(MediaPartSet, part.source_media_id)
        assert part_set is not None
        part_set.revision += 1
        db.flush()


def _capabilities(
    *, creator: bool, prepared: bool, root: bool, source_context: bool
) -> PartCapabilities:
    def action(
        allowed: bool, reason: Literal["not_creator", "unsupported_source", "preparing_structure"]
    ) -> PartAction:
        return PartAction(allowed=allowed, reason=None if allowed else reason)

    source_authority = source_context and root
    return PartCapabilities(
        create=action(
            source_authority and prepared,
            "unsupported_source"
            if not source_context
            else "not_creator"
            if not root
            else "preparing_structure",
        ),
        discover=action(
            source_authority, "unsupported_source" if not source_context else "not_creator"
        ),
        edit_bounds=action(
            not source_context and root and prepared,
            "unsupported_source"
            if source_context
            else "not_creator"
            if not root
            else "preparing_structure",
        ),
        edit_metadata=action(
            not source_context and creator,
            "unsupported_source" if source_context else "not_creator",
        ),
    )


def get_part_definition(db: Session, *, viewer_id: UUID, media_id: UUID) -> PartDefinition:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    part = db.get(MediaPart, media_id)
    media = db.get(Media, media_id)
    if part is None or media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "piece not found")
    source = db.get(Media, part.source_media_id)
    assert source is not None
    fragments = dict(
        db.execute(text("SELECT idx,id FROM fragments WHERE media_id=:id"), {"id": source.id})
        .tuples()
        .all()
    )
    root = can_read_media(db, viewer_id, source.id) and source.created_by_user_id == viewer_id
    selection = None
    prepared = False
    if root:
        proof = _proof(db, source)
        state = db.scalar(
            select(ContentIndexState).where(
                ContentIndexState.owner_kind == "media", ContentIndexState.owner_id == source.id
            )
        )
        prepared = state is not None and state.section_witness_key == section_witness_key(
            proof.navigation.generation, proof.sections
        )
        start, end = (
            DocumentPoint(part.start_fragment_idx, part.start_offset),
            DocumentPoint(part.end_fragment_idx, part.end_offset),
        )
        exact = next(
            (
                section
                for section in proof.sections
                if section.start == start and section.end == end
            ),
            None,
        )
        recovered = None if exact is None else [exact.section_id]
        if recovered is None:
            for first in proof.sections:
                if first.start != start:
                    continue
                siblings = sorted(
                    (
                        section
                        for section in proof.sections
                        if section.parent_section_id == first.parent_section_id
                        and start <= section.start < end
                    ),
                    key=lambda section: section.start,
                )
                if not siblings or siblings[-1].end != end:
                    continue
                proposed = SectionSelection(
                    source_generation=part.source_generation,
                    navigation_key=proof.key,
                    section_ids=[section.section_id for section in siblings],
                )
                try:
                    extent = resolve_part_selection(db, source=source, selection=proposed)
                except ApiError:
                    continue
                if extent.start == start and extent.end == end:
                    recovered = proposed.section_ids
                    break
        if recovered is not None:
            selection = SectionSelection(
                source_generation=part.source_generation,
                navigation_key=proof.key,
                section_ids=recovered,
            )
    return PartDefinition(
        media_id=media_id,
        source_media_id=source.id,
        source_title=source.title,
        source_format=cast(Literal["epub", "web_article"], source.kind),
        source_generation=part.source_generation,
        extent=NavigationTextRangeOut(
            start=NavigationTextPointOut(
                fragment_id=fragments[part.start_fragment_idx], offset=part.start_offset
            ),
            end=NavigationTextPointOut(
                fragment_id=fragments[part.end_fragment_idx], offset=part.end_offset
            ),
        ),
        title=media.title,
        form=part.form,
        version=part.version,
        body_generation=_receipt(db, part).body_generation,
        selection=selection,
        capabilities=_capabilities(
            creator=media.created_by_user_id == viewer_id,
            prepared=prepared,
            root=root,
            source_context=False,
        ),
    )


def list_parts(
    db: Session, *, viewer_id: UUID, source_media_id: UUID, limit: int, cursor: str | None
) -> tuple[list[PartListRow], PartPage]:
    if not can_read_media(db, viewer_id, source_media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    source = db.get(Media, source_media_id)
    assert source is not None
    blocked = part_source_block_reason(db, media=source)
    if blocked is not None:
        unavailable = PartAction(allowed=False, reason=blocked)
        return [], PartPage(
            next_cursor=None,
            source_generation=None,
            navigation_key=None,
            set_revision=0,
            operation=None,
            preparation=None,
            section_choices=[] if cursor is None else None,
            capabilities=PartCapabilities(
                create=unavailable,
                discover=unavailable,
                edit_bounds=unavailable,
                edit_metadata=unavailable,
            ),
        )
    proof = _proof(db, source)
    part_set = db.get(MediaPartSet, source_media_id)
    revision = 0 if part_set is None else part_set.revision
    after = None
    if cursor is not None:
        try:
            saved = json.loads(base64.urlsafe_b64decode(cursor.encode()))
            if saved[:4] != [
                str(source_media_id),
                proof.navigation.generation,
                revision,
                proof.key,
            ]:
                raise _conflict("page_changed", "these pieces changed; reload the list")
            after = UUID(saved[4])
        except (ValueError, TypeError, IndexError) as error:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_CURSOR, "invalid piece cursor"
            ) from error
    creator = source.created_by_user_id == viewer_id
    candidates = db.scalars(
        select(MediaPartCandidate)
        .where(
            MediaPartCandidate.source_media_id == source_media_id,
            MediaPartCandidate.source_generation == proof.navigation.generation,
            text(
                "(finding->>'verdict') IS DISTINCT FROM 'not_independent' OR part_id IS NOT NULL OR user_decision IS NOT NULL"
            ),
            text(":creator OR part_id IN (" + visible_media_ids_cte_sql() + ")"),
            MediaPartCandidate.id > after if after is not None else text("TRUE"),
        )
        .order_by(MediaPartCandidate.id)
        .limit(limit + 1),
        {"creator": creator, "viewer_id": viewer_id},
    ).all()
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_items.items import resource_items_out

    page = candidates[:limit]
    visible_ids = set(
        db.scalars(
            text(
                "SELECT media_id FROM ("
                + visible_media_ids_cte_sql()
                + ") visible WHERE media_id=ANY(:ids)"
            ),
            {
                "viewer_id": viewer_id,
                "ids": [candidate.part_id for candidate in page if candidate.part_id is not None],
            },
        )
    )
    items = resource_items_out(
        db, viewer_id=viewer_id, refs=[ResourceRef("media", part_id) for part_id in visible_ids]
    )
    items_by_id = {UUID(item.ref.split(":", 1)[1]): item for item in items}
    versions = dict(
        db.execute(
            select(MediaPart.media_id, MediaPart.version).where(MediaPart.media_id.in_(visible_ids))
        )
        .tuples()
        .all()
    )
    bound_titles = dict(
        db.execute(
            select(Media.id, Media.title).where(
                Media.id.in_(
                    [candidate.part_id for candidate in page if candidate.part_id is not None]
                )
            )
        )
        .tuples()
        .all()
    )
    rows: list[PartListRow] = [
        PartRow(item=items_by_id[candidate.part_id], version=versions[candidate.part_id])
        if candidate.part_id is not None and candidate.part_id in visible_ids
        else _candidate_row(
            candidate,
            bound_title=None if candidate.part_id is None else bound_titles[candidate.part_id],
        )
        for candidate in page
    ]
    next_cursor = (
        base64.urlsafe_b64encode(
            json.dumps(
                [
                    str(source_media_id),
                    proof.navigation.generation,
                    revision,
                    proof.key,
                    str(page[-1].id),
                ]
            ).encode()
        ).decode()
        if len(candidates) > limit
        else None
    )
    state = db.scalar(
        select(ContentIndexState).where(
            ContentIndexState.owner_kind == "media", ContentIndexState.owner_id == source_media_id
        )
    )
    prepared = state is not None and state.section_witness_key == section_witness_key(
        proof.navigation.generation, proof.sections
    )
    choices = (
        None
        if cursor is not None
        else [
            PartSectionChoice(
                section_id=section.section_id,
                eligible=prepared
                and section.end is not None
                and section.start_cut is not None
                and section.end_cut is not None,
                reason="preparing_structure"
                if not prepared
                else "unknown_end"
                if section.end is None
                else "unproved_structure"
                if section.start_cut is None or section.end_cut is None
                else None,
            )
            for section in proof.sections
        ]
    )
    from nexus.services.imports import read_media_search_obligation
    from nexus.services.part_discovery import read_part_operation

    preparation = read_media_search_obligation(db, viewer_id=viewer_id, media_id=source_media_id)
    operation = read_part_operation(db, source_media_id=source_media_id)
    capabilities = _capabilities(
        creator=creator, prepared=prepared, root=creator, source_context=True
    )
    if operation is not None and operation.status in ("pending", "running", "failed"):
        capabilities.discover = PartAction(allowed=False, reason="active")
    return rows, PartPage(
        next_cursor=next_cursor,
        source_generation=proof.navigation.generation,
        navigation_key=proof.key,
        set_revision=revision,
        operation=operation,
        preparation=preparation,
        section_choices=choices,
        capabilities=capabilities,
    )


def preview_part(
    db: Session, *, viewer_id: UUID, source_media_id: UUID, request: PartPreview
) -> ReaderPartDocumentOut:
    """a transient exact document; never publish, file, consume or annotate it."""
    from nexus.services.media_text_scope import read_part_preview_scope
    from nexus.services.reader_document import build_part_document

    source = _source(db, viewer_id, source_media_id, creator=True)
    extent = resolve_part_selection(db, source=source, selection=request.selection)
    scope = read_part_preview_scope(db, selection=extent)
    document = build_part_document(db, scope=scope, title="piece preview")
    identity = hashlib.sha256(
        json.dumps(
            [str(source_media_id), extent.selection.model_dump(mode="json")],
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return document.model_copy(update={"identity": "preview:" + identity})


def observe_part_finding(
    db: Session, *, source: Media, proof: NavigationProof, finding: PartFinding
) -> MediaPartCandidate | None:
    """reconcile one finite machine observation under the source/set barrier.

    unknown ends have no exact candidate identity; their section eligibility
    remains visibly uncertain. published bindings and contrary decisions win.
    """
    offered = {section.section_id: section for section in proof.sections}
    sections = sorted(
        (offered[section_id] for section_id in finding.section_ids),
        key=lambda section: section.start,
    )
    if any(section.end is None for section in sections):
        return None
    first, last = sections[0], sections[-1]
    assert last.end is not None
    if first.start >= last.end:
        return None
    if len(sections) > 1:
        if len({section.parent_section_id for section in sections}) != 1:
            return None
        siblings = [
            section.section_id
            for section in proof.sections
            if section.parent_section_id == first.parent_section_id
        ]
        positions = sorted(siblings.index(section.section_id) for section in sections)
        if positions != list(range(positions[0], positions[-1] + 1)):
            return None
        fragments = {fragment.fragment_idx: fragment for fragment in proof.navigation.fragments}
        spine = {
            fragment.fragment_idx: idx for idx, fragment in enumerate(proof.navigation.fragments)
        }
        for previous, current in zip(sections, sections[1:], strict=False):
            assert previous.end is not None
            if previous.end == current.start:
                continue
            if (
                spine[current.start.fragment_idx] != spine[previous.end.fragment_idx] + 1
                or previous.end.offset != fragments[previous.end.fragment_idx].char_count
                or current.start.offset != 0
            ):
                return None
    candidate = _candidate(
        db,
        source_media_id=source.id,
        source_generation=proof.navigation.generation,
        start=first.start,
        end=last.end,
    )
    if candidate.part_id is not None or candidate.user_decision == "rejected":
        return candidate
    observed = finding.model_dump(mode="json")
    if candidate.finding != observed:
        candidate.finding = observed
        candidate.version += 1
        part_set = db.get(MediaPartSet, source.id)
        assert part_set is not None
        part_set.revision += 1
        db.flush()
    return candidate


def automatic_part_conflict(db: Session, *, candidate: MediaPartCandidate) -> bool:
    """accepted current bounds and original bindings/decisions both bar automatic overlap."""
    if candidate.part_id is not None or candidate.user_decision is not None:
        return True
    start = (candidate.start_fragment_idx, candidate.start_offset)
    end = (candidate.end_fragment_idx, candidate.end_offset)
    for part in db.scalars(
        select(MediaPart).where(MediaPart.source_media_id == candidate.source_media_id)
    ):
        if (part.start_fragment_idx, part.start_offset) < end and start < (
            part.end_fragment_idx,
            part.end_offset,
        ):
            return True
    for other in db.scalars(
        select(MediaPartCandidate).where(
            MediaPartCandidate.source_media_id == candidate.source_media_id,
            MediaPartCandidate.source_generation == candidate.source_generation,
            MediaPartCandidate.id != candidate.id,
        )
    ):
        if (other.part_id is not None or other.user_decision is not None) and (
            (other.start_fragment_idx, other.start_offset) < end
            and start < (other.end_fragment_idx, other.end_offset)
        ):
            return True
    return False


def require_part_source_creator(db: Session, *, viewer_id: UUID, source_media_id: UUID) -> Media:
    """readable source creator authority shared by manual and discovery commands."""
    return _source(db, viewer_id, source_media_id, creator=True)
