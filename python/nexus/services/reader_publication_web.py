"""Freeze web text and authored image dependencies in the existing ingest worker."""

import hashlib
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from tempfile import TemporaryFile
from urllib.parse import unquote, urldefrag
from uuid import UUID

from lxml import html
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import Media, ReaderPublication
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.media import DocumentEmbedSource, ReaderNavigationFragmentOut
from nexus.schemas.reader_publication import (
    ReaderPublicationAssetRef,
    ReaderPublicationCapturedAsset,
    ReaderPublicationUnavailableAsset,
)
from nexus.services.html_tree import inner_html
from nexus.services.image_validation import (
    ImageHttpError,
    create_http_client,
    fetch_validated_image,
)
from nexus.services.media_document_metrics import canonical_word_boundary_ordinal
from nexus.services.reader_navigation import build_web_navigation_projection
from nexus.services.reader_publication_artifacts import (
    PreparedReaderPublication,
    PreparedReaderPublicationMember,
    prepare_reader_publication_member,
    prepare_text_reader_publication,
)
from nexus.services.reader_publication_units import split_reader_publication_fragment
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.storage.client import get_storage_client
from nexus.web_paths import media_image_url


def capture_web_reader_images(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    html_sanitized: str,
    assets_by_url: dict[str, ReaderPublicationAssetRef],
) -> tuple[str, tuple[PreparedReaderPublicationMember, ...]]:
    """Freeze img.src once per publication, sharing already captured image refs."""
    storage = get_storage_client()
    members: list[PreparedReaderPublicationMember] = []
    root = html.fragment_fromstring(html_sanitized, create_parent=True)
    proxy_prefix = media_image_url("")
    with create_http_client() as client:
        for image in root.iter("img"):
            value = image.get("src")
            if not value:
                continue
            authored = (
                unquote(value[len(proxy_prefix) :]) if value.startswith(proxy_prefix) else value
            )
            source_url, _fragment = urldefrag(authored)
            # Unwrap the old proxy before unit rewriting so authored #fragment
            # suffixes survive as suffixes of the immutable member marker.
            image.set("src", authored)
            if source_url in assets_by_url:
                continue
            try:
                fetched = fetch_validated_image(source_url, client)
            except ImageHttpError as exc:
                if exc.upstream_status not in {404, 410}:
                    raise
                assets_by_url[source_url] = ReaderPublicationUnavailableAsset(
                    source_url=source_url,
                    reason="NotFound",
                )
                continue
            except ApiError as exc:
                if exc.code not in {
                    ApiErrorCode.E_INVALID_REQUEST,
                    ApiErrorCode.E_SSRF_BLOCKED,
                    ApiErrorCode.E_IMAGE_TOO_LARGE,
                }:
                    raise
                assets_by_url[source_url] = ReaderPublicationUnavailableAsset(
                    source_url=source_url,
                    reason="InvalidImage",
                )
                continue
            member = prepare_reader_publication_member(
                session_factory,
                storage,
                media_id=media_id,
                key=f"assets/web/{hashlib.sha256(source_url.encode('utf-8')).hexdigest()}",
                role="asset",
                body=fetched.data,
                media_type=fetched.content_type,
            )
            members.append(member)
            assets_by_url[source_url] = ReaderPublicationCapturedAsset(
                member=member.ref,
                media_type=fetched.content_type,
                package_href=None,
            )
    unit_html = inner_html(root)
    return unit_html, tuple(members)


@dataclass(frozen=True)
class WebReaderFragment:
    fragment_id: UUID
    fragment_idx: int
    prepared: WebArticlePreparedFragment
    document_embeds: tuple[DocumentEmbedSource, ...]


@contextmanager
def prepare_web_reader_publication(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    fragments: Sequence[WebReaderFragment],
    source_html: str,
    title: str | None,
    limits: ReaderPublicationLimits,
) -> Iterator[PreparedReaderPublication]:
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
    source = prepare_reader_publication_member(
        session_factory,
        storage,
        media_id=media_id,
        key="assets/source.html",
        role="asset",
        body=source_html.encode("utf-8"),
        media_type="text/html",
    )
    assets_by_url: dict[str, ReaderPublicationAssetRef] = {}
    members = [source]
    navigation = build_web_navigation_projection(
        media_id=media_id,
        fragments=[
            ReaderNavigationFragmentOut(
                fragment_id=fragment.fragment_id,
                fragment_idx=fragment.fragment_idx,
                char_count=len(fragment.prepared.canonical_text),
            )
            for fragment in fragments
        ],
        rows=[
            (
                fragment.prepared.canonical_text[block.start_offset : block.end_offset],
                block.block_idx,
                {
                    "section_id": block.section_id,
                    "fragment_id": str(fragment.fragment_id),
                    "fragment_idx": fragment.fragment_idx,
                    "heading_level": block.heading_level,
                    "start_offset": block.start_offset,
                    "end_offset": block.end_offset,
                    "anchor_id": block.anchor_id,
                },
                {"ordinal": block.ordinal, "depth": block.depth},
            )
            for fragment in fragments
            for block in fragment.prepared.index_blocks
            if block.section_id is not None
        ],
    )
    with (
        TemporaryFile(mode="w+b") as html_file,
        TemporaryFile(mode="w+b") as unit_projection_file,
        TemporaryFile(mode="w+b") as search_file,
    ):
        staged_html: list[tuple[int, int]] = []
        for fragment in fragments:
            markup, images = capture_web_reader_images(
                session_factory,
                media_id=media_id,
                html_sanitized=fragment.prepared.html_sanitized,
                assets_by_url=assets_by_url,
            )
            members.extend(images)
            body = markup.encode("utf-8")
            staged_html.append((html_file.tell(), len(body)))
            html_file.write(body)
            del body, markup

        def source_parts():
            document_start = 0
            document_word_start = 0
            for fragment, (offset, size) in zip(fragments, staged_html, strict=True):
                html_file.seek(offset)
                yield from split_reader_publication_fragment(
                    fragment_id=fragment.fragment_id,
                    fragment_idx=fragment.fragment_idx,
                    fragment_document_start_cp=document_start,
                    fragment_document_word_start=document_word_start,
                    epub_target=None,
                    document_embeds=fragment.document_embeds,
                    html_sanitized=html_file.read(size).decode("utf-8"),
                    canonical_text=fragment.prepared.canonical_text,
                    assets_by_url=assets_by_url,
                    limits=limits,
                )
                document_start += len(fragment.prepared.canonical_text)
                document_word_start += canonical_word_boundary_ordinal(
                    fragment.prepared.canonical_text, len(fragment.prepared.canonical_text)
                )

        yield prepare_text_reader_publication(
            session_factory,
            storage,
            media_id=media_id,
            expected_generation=generation,
            generation=(generation or 0) + 1,
            title=title if title is not None else current_title,
            navigation=navigation,
            source_parts=source_parts(),
            unit_projection_file=unit_projection_file,
            search_projection_file=search_file,
            assets=tuple(members),
            limits=limits,
        )
