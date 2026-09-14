"""Prepare file-source reader artifacts before their existing publication transaction."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from tempfile import TemporaryFile
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media, ReaderPublication
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.reader_publication import (
    ReaderPublicationAssetRef,
    ReaderPublicationCapturedAsset,
)
from nexus.services.epub_ingest import EpubExtractionPlan, read_epub_fragment
from nexus.services.epub_read import build_epub_navigation_projection, epub_fragment_resume_targets
from nexus.services.media_document_metrics import canonical_word_boundary_ordinal
from nexus.services.pdf_ingest import PdfExtractionPlan
from nexus.services.pdf_metadata import pdf_publication_title
from nexus.services.reader_publication_artifacts import (
    PreparedReaderPublication,
    prepare_pdf_reader_publication,
    prepare_text_reader_publication,
    verify_reader_publication_asset,
)
from nexus.services.reader_publication_units import split_reader_publication_fragment
from nexus.storage.client import get_storage_client
from nexus.web_paths import media_asset_url


@dataclass(frozen=True)
class PreparedFileReaderSource:
    plan: PdfExtractionPlan | EpubExtractionPlan
    publication: PreparedReaderPublication


@contextmanager
def prepare_file_reader_publication(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    plan: PdfExtractionPlan | EpubExtractionPlan,
    limits: ReaderPublicationLimits,
) -> Iterator[PreparedFileReaderSource]:
    with session_factory() as db:
        current_title = db.scalar(select(Media.title).where(Media.id == media_id))
        if current_title is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        generation = db.scalar(
            select(ReaderPublication.generation).where(
                ReaderPublication.media_id == media_id,
            )
        )
    storage = get_storage_client()
    source = verify_reader_publication_asset(
        storage,
        key="assets/source.pdf" if isinstance(plan, PdfExtractionPlan) else "assets/source.epub",
        storage_path=plan.storage_path,
        media_type="application/pdf"
        if isinstance(plan, PdfExtractionPlan)
        else "application/epub+zip",
        expected_size_bytes=plan.source_size_bytes,
        expected_sha256=plan.source_sha256_hex,
    )
    if isinstance(plan, PdfExtractionPlan):
        with TemporaryFile(mode="w+b") as search_file:
            publication = prepare_pdf_reader_publication(
                session_factory,
                storage,
                media_id=media_id,
                expected_generation=generation,
                generation=(generation or 0) + 1,
                title=pdf_publication_title(current_title, plan.result),
                page_count=plan.result.page_count,
                plain_text=plan.result.plain_text,
                page_spans=tuple(
                    (page.page_number, page.start_offset, page.end_offset)
                    for page in plan.result.page_spans
                ),
                page_heights=tuple(
                    (page.page_number, page.page_height) for page in plan.result.page_spans
                ),
                search_projection_file=search_file,
                document=source,
                limits=limits,
            )
            yield PreparedFileReaderSource(plan, publication)
        return

    sections = [asdict(section) for section in plan.nav_locations]
    first_section_by_fragment: dict[int, str] = {}
    for section in plan.nav_locations:
        first_section_by_fragment.setdefault(section.fragment_idx, section.location_id)

    def locations(nav_type: str) -> list[tuple]:
        return [
            (
                node.label,
                node.href,
                node.fragment_idx,
                first_section_by_fragment.get(node.fragment_idx)
                if node.fragment_idx is not None
                else None,
            )
            for node in sorted(plan.toc_nodes, key=lambda node: node.order_key)
            if node.nav_type == nav_type
        ]

    navigation = build_epub_navigation_projection(
        media_id=media_id,
        fragment_rows=[
            {"id": fragment.id, "idx": fragment.idx, "char_count": fragment.char_count}
            for fragment in plan.fragments
        ],
        section_rows=sections,
        toc_rows=[
            (
                node.node_id,
                node.parent_node_id,
                node.label,
                node.href,
                node.fragment_idx,
                node.depth,
                node.order_key,
            )
            for node in sorted(plan.toc_nodes, key=lambda node: node.order_key)
            if node.nav_type == "toc"
        ],
        landmark_rows=locations("landmarks"),
        page_rows=locations("page_list"),
    )
    fragment_starts: dict[UUID, int] = {}
    epub_targets = epub_fragment_resume_targets(navigation)
    document_length = 0
    for fragment in navigation.fragments:
        fragment_starts[fragment.fragment_id] = document_length
        document_length += fragment.char_count
    members = [source]
    assets_by_url: dict[str, ReaderPublicationAssetRef] = {}
    for asset in plan.asset_entries:
        member = verify_reader_publication_asset(
            storage,
            key=f"assets/{asset.asset_key}",
            storage_path=plan.asset_storage_paths[asset.asset_key],
            media_type=asset.content_type,
            expected_size_bytes=asset.size_bytes,
        )
        members.append(member)
        assets_by_url[media_asset_url(media_id, asset.asset_key)] = ReaderPublicationCapturedAsset(
            member=member.ref,
            media_type=asset.content_type,
            package_href=asset.epub_path,
        )

    def source_parts():
        document_word_start = 0
        for fragment in plan.fragments:
            html_sanitized, canonical_text = read_epub_fragment(fragment)
            yield from split_reader_publication_fragment(
                fragment_id=fragment.id,
                fragment_idx=fragment.idx,
                fragment_document_start_cp=fragment_starts[fragment.id],
                fragment_document_word_start=document_word_start,
                epub_target=epub_targets[fragment.id],
                document_embeds=(),
                html_sanitized=html_sanitized,
                canonical_text=canonical_text,
                assets_by_url=assets_by_url,
                limits=limits,
            )
            document_word_start += canonical_word_boundary_ordinal(
                canonical_text, len(canonical_text)
            )
            del html_sanitized, canonical_text

    with (
        TemporaryFile(mode="w+b") as unit_projection_file,
        TemporaryFile(mode="w+b") as search_file,
    ):
        publication = prepare_text_reader_publication(
            session_factory,
            storage,
            media_id=media_id,
            expected_generation=generation,
            generation=(generation or 0) + 1,
            title=plan.result.title or current_title,
            navigation=navigation,
            source_parts=source_parts(),
            unit_projection_file=unit_projection_file,
            search_projection_file=search_file,
            assets=tuple(members),
            limits=limits,
        )
        yield PreparedFileReaderSource(plan, publication)
