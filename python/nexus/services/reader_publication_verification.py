"""Release verification of exact retained bytes and their query projections."""

from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    Media,
    ReaderPublication,
    ReaderPublicationAnchor,
    ReaderPublicationArtifact,
    ReaderPublicationTarget,
    ReaderPublicationUnit,
)
from nexus.schemas.reader_publication import (
    PUBLICATION_DESCRIPTOR,
    ReaderPublicationIndexPage,
    ReaderPublicationPdfDescriptor,
    ReaderPublicationUnitBody,
)
from nexus.services.offline_reading_delivery import stage_reader_publication_members
from nexus.services.offline_reading_packages import verify_offline_reading_package_files
from nexus.services.reader_publication_anchors import (
    normalize_epub_lookup_paths,
    reader_publication_anchor_key,
)
from nexus.services.reader_publication_search import (
    ReaderSearchPreparation,
    prepare_pdf_reader_search,
    verify_reader_search,
)


def verify_retained_reader_publication(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    generation: int,
    limits: ReaderPublicationLimits,
) -> None:
    """Read one member at a time; neither create an archive nor change publication."""
    with TemporaryDirectory(prefix="reader-preflight-") as directory:
        with stage_reader_publication_members(
            session_factory,
            media_id=media_id,
            generation=generation,
            limits=limits,
            parent_directory=Path(directory),
        ) as staged:
            verify_offline_reading_package_files(
                staged.manifest, staged.members, publication_limits=limits
            )
            raw_paths: set[str] = set()
            for entry in staged.manifest.entries:
                if entry.path.startswith("index/"):
                    index = ReaderPublicationIndexPage.model_validate_json(
                        staged.members[entry.path].read_bytes()
                    )
                    raw_paths.update(
                        section.href_path
                        for section in index.sections
                        if section.href_path is not None
                    )
            pathnames = normalize_epub_lookup_paths(raw_paths)
            member_unit_keys: set[str] = set()
            indexed_unit_refs: list[str] = []
            target_ids: set[str] = set()
            anchor_count = 0
            index_count = 0
            with session_factory() as db:
                descriptor = PUBLICATION_DESCRIPTOR.validate_json(
                    staged.members["descriptor.json"].read_bytes()
                )
                projected_count = db.scalar(
                    select(ReaderPublicationArtifact.pdf_page_count).where(
                        ReaderPublicationArtifact.media_id == media_id,
                        ReaderPublicationArtifact.generation == generation,
                        ReaderPublicationArtifact.path == "descriptor.json",
                    )
                )
                if projected_count != (
                    descriptor.page_count
                    if isinstance(descriptor, ReaderPublicationPdfDescriptor)
                    else None
                ):
                    raise ValueError("Retained PDF page count differs from descriptor bytes")
                for entry in staged.manifest.entries:
                    if entry.path.startswith("units/"):
                        unit = ReaderPublicationUnitBody.model_validate_json(
                            staged.members[entry.path].read_bytes()
                        )
                        if unit.word_boundaries is None:
                            raise ValueError(
                                "Hosted reader publication requires computed word boundaries"
                            )
                        row = db.get(ReaderPublicationUnit, (media_id, generation, entry.path))
                        if row is None or (
                            str(row.fragment_id),
                            row.fragment_idx,
                            row.start_cp,
                            row.end_cp,
                            row.canonical_text,
                            tuple(row.word_boundaries),
                            row.embed_markers,
                        ) != (
                            unit.fragment_id,
                            unit.fragment_idx,
                            unit.start_cp,
                            unit.end_cp,
                            unit.canonical_text,
                            unit.word_boundaries,
                            [
                                embed.model_dump(
                                    mode="json",
                                    include={
                                        "id",
                                        "ordinal",
                                        "occurrence_key",
                                        "canonical_start_offset",
                                        "canonical_end_offset",
                                    },
                                )
                                for embed in unit.document_embeds
                            ],
                        ):
                            raise ValueError(
                                "retained unit query projection differs from its source"
                            )
                        member_unit_keys.add(entry.path)
                        db.expunge(row)
                    elif entry.path.startswith("index/"):
                        index_count += 1
                        index = ReaderPublicationIndexPage.model_validate_json(
                            staged.members[entry.path].read_bytes()
                        )
                        for position in index.units:
                            indexed_unit_refs.append(position.member.key)
                            stored = db.execute(
                                select(
                                    ReaderPublicationUnit.ordinal,
                                    ReaderPublicationUnit.fragment_id,
                                    ReaderPublicationUnit.fragment_idx,
                                    ReaderPublicationUnit.start_cp,
                                    ReaderPublicationUnit.end_cp,
                                ).where(
                                    ReaderPublicationUnit.media_id == media_id,
                                    ReaderPublicationUnit.generation == generation,
                                    ReaderPublicationUnit.unit_key == position.member.key,
                                )
                            ).one_or_none()
                            if stored is None or (
                                stored.ordinal,
                                str(stored.fragment_id),
                                stored.fragment_idx,
                                stored.start_cp,
                                stored.end_cp,
                            ) != (
                                position.ordinal,
                                position.fragment_id,
                                position.fragment_idx,
                                position.start_cp,
                                position.end_cp,
                            ):
                                raise ValueError(
                                    "retained unit index differs from its query projection"
                                )
                        for anchor in index.anchors:
                            row = db.get(
                                ReaderPublicationAnchor,
                                (
                                    media_id,
                                    generation,
                                    reader_publication_anchor_key(
                                        anchor.href_path, anchor.anchor_id
                                    ),
                                ),
                            )
                            if row is None or (
                                row.href_path,
                                row.anchor_id,
                                row.unit_key,
                                row.offset_cp,
                            ) != (
                                anchor.href_path,
                                anchor.anchor_id,
                                anchor.unit_key,
                                anchor.offset_cp,
                            ):
                                raise ValueError(
                                    "retained authored anchor query projection differs from its source"
                                )
                            anchor_count += 1
                            db.expunge(row)
                        for section in index.sections:
                            row = db.get(
                                ReaderPublicationTarget, (media_id, generation, section.section_id)
                            )
                            if row is None or (
                                row.ordinal,
                                row.label,
                                row.unit_key,
                                row.offset_cp,
                                row.end_cp,
                                row.href_path,
                                row.href_pathname,
                                row.anchor_id,
                            ) != (
                                section.ordinal,
                                section.label,
                                section.unit_key,
                                section.start_offset,
                                section.end_offset,
                                section.href_path,
                                pathnames.get(section.href_path)
                                if section.href_path is not None
                                else None,
                                section.anchor_id or section.href_fragment,
                            ):
                                raise ValueError(
                                    "retained navigation query projection differs from its source"
                                )
                            target_ids.add(section.section_id)
                            db.expunge(row)
                counts = (
                    db.scalar(
                        select(func.count())
                        .select_from(ReaderPublicationTarget)
                        .where(
                            ReaderPublicationTarget.media_id == media_id,
                            ReaderPublicationTarget.generation == generation,
                        )
                    ),
                    db.scalar(
                        select(func.count())
                        .select_from(ReaderPublicationArtifact)
                        .where(
                            ReaderPublicationArtifact.media_id == media_id,
                            ReaderPublicationArtifact.generation == generation,
                            ReaderPublicationArtifact.role == "index",
                        )
                    ),
                )
                stored_anchors = db.scalar(
                    select(func.count())
                    .select_from(ReaderPublicationAnchor)
                    .where(
                        ReaderPublicationAnchor.media_id == media_id,
                        ReaderPublicationAnchor.generation == generation,
                    )
                )
                stored_unit_keys = set(
                    db.scalars(
                        select(ReaderPublicationUnit.unit_key).where(
                            ReaderPublicationUnit.media_id == media_id,
                            ReaderPublicationUnit.generation == generation,
                        )
                    )
                )
                if stored_anchors != anchor_count:
                    raise ValueError("retained authored anchor query projections are incomplete")
                if stored_unit_keys != member_unit_keys:
                    raise ValueError("retained unit query projections differ from their members")
                # The index chain partitions the document, so it must address every
                # published unit exactly once: sorting catches an omitted ref and a
                # ref repeated across two pages, which a set comparison would not.
                if sorted(indexed_unit_refs) != sorted(member_unit_keys):
                    raise ValueError("retained index chain does not address every unit once")
                if counts != (len(target_ids), index_count):
                    raise ValueError("retained publication query projections are incomplete")
                with TemporaryFile(mode="w+b") as search_file:
                    if member_unit_keys:
                        search = ReaderSearchPreparation(
                            search_file, chunk_codepoints=limits.unit_codepoints
                        )
                        for key in db.scalars(
                            select(ReaderPublicationUnit.unit_key)
                            .where(
                                ReaderPublicationUnit.media_id == media_id,
                                ReaderPublicationUnit.generation == generation,
                            )
                            .order_by(ReaderPublicationUnit.ordinal)
                            .execution_options(yield_per=1)
                        ):
                            unit = ReaderPublicationUnitBody.model_validate_json(
                                staged.members[key].read_bytes()
                            )
                            search.append(
                                source_ordinal=unit.fragment_idx,
                                fragment_id=UUID(unit.fragment_id),
                                raw_start=unit.start_cp,
                                text=unit.canonical_text,
                            )
                        prepared_search = search.finish()
                    else:
                        current = db.scalar(
                            select(ReaderPublication.generation).where(
                                ReaderPublication.media_id == media_id
                            )
                        )
                        if current != generation:
                            raise ValueError(
                                "PDF canonical search verification requires its current generation"
                            )
                        plain_text = (
                            db.scalar(select(Media.plain_text).where(Media.id == media_id)) or ""
                        )
                        page_count = db.scalar(select(Media.page_count).where(Media.id == media_id))
                        if page_count is None:
                            raise ValueError("Published PDF has no canonical page count")
                        pdf_pages = db.execute(
                            text(
                                "SELECT page_number, start_offset, end_offset, page_height FROM pdf_page_text_spans "
                                "WHERE media_id = :media ORDER BY page_number"
                            ),
                            {"media": media_id},
                        ).all()
                        pages = tuple(
                            (row.page_number, row.start_offset, row.end_offset) for row in pdf_pages
                        )
                        prepared_search = prepare_pdf_reader_search(
                            search_file,
                            plain_text=plain_text,
                            page_count=page_count,
                            page_spans=pages,
                            page_heights=tuple(
                                (row.page_number, row.page_height) for row in pdf_pages
                            ),
                            chunk_codepoints=limits.unit_codepoints,
                        )
                    verify_reader_search(
                        db, media_id=media_id, generation=generation, prepared=prepared_search
                    )
