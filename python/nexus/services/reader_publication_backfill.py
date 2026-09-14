"""Prepare immutable members from an existing canonical generation, without replacing it."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from tempfile import TemporaryFile
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.schemas.reader_publication import (
    ReaderPublicationAssetRef,
    ReaderPublicationCapturedAsset,
)
from nexus.services.epub_read import build_epub_navigation_projection, epub_fragment_resume_targets
from nexus.services.media_document_metrics import canonical_word_boundary_ordinal
from nexus.services.reader_publication import (
    ReaderPublicationBusy,
    ReaderPublicationObjectReader,
    ReaderPublicationProjection,
    capture_current,
)
from nexus.services.reader_publication_artifacts import (
    PreparedReaderPublication,
    prepare_pdf_reader_publication,
    prepare_text_reader_publication,
    verify_reader_publication_asset,
)
from nexus.services.reader_publication_units import split_reader_publication_fragment
from nexus.services.reader_publication_web import capture_web_reader_images
from nexus.storage.client import get_storage_client
from nexus.web_paths import media_asset_url


@contextmanager
def prepare_current_reader_publication(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    expected_generation: int,
    limits: ReaderPublicationLimits,
) -> Iterator[PreparedReaderPublication]:
    """Keep temporary projections alive through the caller's final generation fence."""
    storage = get_storage_client()
    with (
        TemporaryFile(mode="w+b") as unit_file,
        TemporaryFile(mode="w+b") as html_file,
        TemporaryFile(mode="w+b") as search_file,
    ):

        def prepare(
            projection: ReaderPublicationProjection, _objects: ReaderPublicationObjectReader
        ) -> PreparedReaderPublication:
            if projection.generation != expected_generation:
                raise ReaderPublicationBusy()
            search_file.seek(0)
            search_file.truncate()
            unit_file.seek(0)
            unit_file.truncate()
            html_file.seek(0)
            html_file.truncate()
            members = []
            assets_by_url: dict[str, ReaderPublicationAssetRef] = {}
            source = None
            for reference in projection.object_references:
                if reference.role == "source":
                    key = "assets/source.pdf" if projection.kind == "pdf" else "assets/source.epub"
                else:
                    if reference.asset_key is None:
                        raise AssertionError("Captured EPUB asset has no immutable member key")
                    key = f"assets/{reference.asset_key}"
                member = verify_reader_publication_asset(
                    storage,
                    key=key,
                    storage_path=reference.storage_path,
                    media_type=reference.content_type,
                    expected_size_bytes=reference.size_bytes,
                    expected_sha256=reference.sha256,
                )
                members.append(member)
                if reference.role == "source":
                    source = member
                else:
                    assets_by_url[media_asset_url(media_id, reference.asset_key)] = (
                        ReaderPublicationCapturedAsset(
                            member=member.ref,
                            media_type=reference.content_type,
                            package_href=reference.package_href,
                        )
                    )
            if projection.kind == "pdf":
                if (
                    source is None
                    or projection.page_count is None
                    or projection.pdf_plain_text is None
                ):
                    raise ValueError("Published PDF lacks its source or page count")
                return prepare_pdf_reader_publication(
                    session_factory,
                    storage,
                    media_id=media_id,
                    expected_generation=projection.generation,
                    generation=projection.generation,
                    title=projection.title,
                    page_count=projection.page_count,
                    plain_text=projection.pdf_plain_text,
                    page_spans=projection.pdf_page_spans,
                    page_heights=projection.pdf_page_heights,
                    search_projection_file=search_file,
                    document=source,
                    limits=limits,
                )
            if projection.kind == "epub":
                first_section_by_fragment: dict[int, str] = {}
                for section in projection.epub_navigation:
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
                        for node in projection.epub_toc
                        if node.nav_type == nav_type
                    ]

                navigation = build_epub_navigation_projection(
                    media_id=media_id,
                    fragment_rows=[
                        {
                            "id": fragment.fragment_id,
                            "idx": fragment.idx,
                            "char_count": len(fragment.canonical_text),
                        }
                        for fragment in projection.fragments
                    ],
                    section_rows=[asdict(section) for section in projection.epub_navigation],
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
                        for node in projection.epub_toc
                        if node.nav_type == "toc"
                    ],
                    landmark_rows=locations("landmarks"),
                    page_rows=locations("page_list"),
                )
            else:
                if projection.web_navigation is None:
                    raise AssertionError("Web publication capture lacks its navigation snapshot")
                navigation = projection.web_navigation

            epub_targets = epub_fragment_resume_targets(navigation)
            staged_html: list[tuple[int, int, dict[str, ReaderPublicationAssetRef]]] = []
            for fragment in projection.fragments:
                if projection.kind == "web_article":
                    markup, images = capture_web_reader_images(
                        session_factory,
                        media_id=media_id,
                        html_sanitized=fragment.html_sanitized,
                        assets_by_url=assets_by_url,
                    )
                    members.extend(images)
                    image_urls = assets_by_url
                else:
                    markup, image_urls = fragment.html_sanitized, assets_by_url
                body = markup.encode("utf-8")
                staged_html.append((html_file.tell(), len(body), image_urls))
                html_file.write(body)
                del body, markup

            def source_parts():
                document_start = 0
                document_word_start = 0
                for fragment, (offset, size, images) in zip(
                    projection.fragments, staged_html, strict=True
                ):
                    html_file.seek(offset)
                    markup = html_file.read(size).decode("utf-8")
                    yield from split_reader_publication_fragment(
                        fragment_id=fragment.fragment_id,
                        fragment_idx=fragment.idx,
                        fragment_document_start_cp=document_start,
                        fragment_document_word_start=document_word_start,
                        epub_target=epub_targets.get(fragment.fragment_id),
                        document_embeds=fragment.document_embeds,
                        html_sanitized=markup,
                        canonical_text=fragment.canonical_text,
                        assets_by_url=images,
                        limits=limits,
                    )
                    document_start += len(fragment.canonical_text)
                    document_word_start += canonical_word_boundary_ordinal(
                        fragment.canonical_text, len(fragment.canonical_text)
                    )

            return prepare_text_reader_publication(
                session_factory,
                storage,
                media_id=media_id,
                expected_generation=projection.generation,
                generation=projection.generation,
                title=projection.title,
                navigation=navigation,
                source_parts=source_parts(),
                unit_projection_file=unit_file,
                search_projection_file=search_file,
                assets=tuple(members),
                limits=limits,
            )

        captured = capture_current(
            session_factory, media_id=media_id, assemble=prepare, storage_client=storage
        )
        yield captured.value
