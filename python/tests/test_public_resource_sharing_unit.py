from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

import pytest

from nexus.errors import NotFoundError
from nexus.schemas.presence import absent
from nexus.schemas.public_resource_sharing import (
    PublicArticleFragmentOut,
    PublicArticleFragmentPageOut,
    PublicPageInfo,
    PublicSectionOut,
)
from nexus.services import public_resource_sharing
from nexus.services.epub_assets import EpubAssetSource
from nexus.services.epub_read import EpubSectionSource, list_epub_section_sources
from nexus.services.media_file_access import MediaFileSource, parse_single_byte_range
from nexus.services.public_share_handles import (
    PublicHandleContext,
    seal_public_handle,
    unseal_public_handle,
)
from nexus.services.resource_graph.refs import ResourceRef
from tests.support.storage import FakeStorageClient

_ROOT_KEY = b"public-sharing-unit-test-root-key"
_HANDLE = "nxps1_" + ("A" * 48)
_CURSOR = "nxpc1_" + ("A" * 48)


class _Rows:
    def __init__(self, rows):
        self._rows = rows
        self.statement = None

    def mappings(self):
        return self

    def all(self):
        return self._rows

    def scalars(self):
        return self._rows


class _Db:
    def __init__(self, rows):
        self.rows = rows
        self.statement = ""

    def execute(self, statement, _params):
        self.statement = str(statement)
        return _Rows(self.rows)


def _media(
    *,
    kind: str,
    transcript_last_request_reason: str | None = None,
) -> public_resource_sharing._MediaFacts:
    return public_resource_sharing._MediaFacts(
        media_id=uuid4(),
        kind=kind,
        title="Public document",
        processing_status="ready",
        transcript_state="ready" if kind in {"video", "podcast_episode"} else None,
        transcript_coverage="full" if kind in {"video", "podcast_episode"} else None,
        transcript_last_request_reason=transcript_last_request_reason,
        source_attempt_id=uuid4(),
        source_attempt_no=1,
        source_type=(
            "youtube_video"
            if kind == "video"
            else "podcast_episode_transcript"
            if kind == "podcast_episode"
            else "uploaded_epub_file"
            if kind == "epub"
            else "generic_web_url"
        ),
        duration_ms=1_000,
        page_count=1,
    )


def _projection(kind: str) -> public_resource_sharing._Projection:
    media = _media(kind=kind)
    grant_id = uuid4()
    return public_resource_sharing._Projection(
        grant_id=grant_id,
        subject=ResourceRef(scheme="media", id=media.media_id),
        media=media,
        handle_context=PublicHandleContext(
            grant_id=grant_id,
            parent_media_id=media.media_id,
            source_revision_bytes=b"revision",
        ),
        highlight=None,
    )


def test_epub_section_sources_preserve_toc_depth() -> None:
    db = _Db(
        [
            {
                "ordinal": 3,
                "label": "Nested",
                "depth": 2,
                "html_sanitized": "<p>Text</p>",
                "canonical_text": "Text",
            }
        ]
    )

    sections = list_epub_section_sources(
        db,
        media_id=uuid4(),
        limit=10,
    )

    assert sections[0].depth == 2
    assert "COALESCE(toc.depth, 0)" in db.statement
    assert "toc.nav_type = 'toc'" in db.statement


def test_epub_navigation_revision_invalidates_old_section_handle(monkeypatch) -> None:
    media = _media(kind="epub")
    owner = public_resource_sharing._EpubSourceOwner(
        attempt_id=uuid4(),
        attempt_no=1,
        source_type="uploaded_epub_file",
    )
    sections = [
        EpubSectionSource(
            ordinal=0,
            label="Chapter",
            depth=0,
            html_sanitized="<p>Hello</p>",
            canonical_text="Hello",
        )
    ]
    monkeypatch.setattr(
        public_resource_sharing,
        "list_epub_section_sources",
        lambda *_args, **_kwargs: sections,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "list_public_epub_asset_sources",
        lambda *_args, **_kwargs: [],
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "_load_epub_source_owner",
        lambda *_args, **_kwargs: owner,
    )
    old_revision = public_resource_sharing._source_revision_bytes(object(), media=media)
    old_context = PublicHandleContext(
        grant_id=uuid4(),
        parent_media_id=media.media_id,
        source_revision_bytes=old_revision,
    )
    handle = seal_public_handle("section", ordinal=0, context=old_context, root_key=_ROOT_KEY)

    sections[0] = EpubSectionSource(
        ordinal=0,
        label="Renamed chapter",
        depth=1,
        html_sanitized="<p>Hello</p>",
        canonical_text="Hello",
    )
    new_revision = public_resource_sharing._source_revision_bytes(object(), media=media)
    new_context = PublicHandleContext(
        grant_id=old_context.grant_id,
        parent_media_id=media.media_id,
        source_revision_bytes=new_revision,
    )

    assert new_revision != old_revision
    assert unseal_public_handle("section", handle, context=new_context, root_key=_ROOT_KEY) is None


def test_public_epub_section_rejects_aggregate_wire_body_over_8_mib(monkeypatch) -> None:
    projection = _projection("epub")
    source = EpubSectionSource(
        ordinal=0,
        label="Chapter",
        depth=0,
        html_sanitized="h" * (4 * 1024 * 1024),
        canonical_text="t" * (4 * 1024 * 1024),
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "_resolve_public_projection",
        lambda *_args, **_kwargs: projection,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "unseal_public_handle",
        lambda *_args, **_kwargs: 0,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "get_epub_section_source",
        lambda *_args, **_kwargs: source,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "list_public_epub_asset_sources",
        lambda *_args, **_kwargs: [],
    )

    model = PublicSectionOut(
        ordinal=0,
        section_handle=_HANDLE,
        html_sanitized=source.html_sanitized,
        canonical_text=source.canonical_text,
    )
    assert (
        public_resource_sharing._serialized_envelope_size(model)
        > public_resource_sharing._MAX_PAGE_BYTES
    )
    with pytest.raises(NotFoundError):
        public_resource_sharing.get_public_section(
            object(),
            raw_token="opaque",
            raw_section_handle=_HANDLE,
        )


def test_article_page_cap_uses_serialized_envelope_and_emits_resume_cursor(
    monkeypatch,
) -> None:
    projection = _projection("web_article")
    field = "x" * (2 * 1024 * 1024)
    rows = [
        {
            "idx": ordinal,
            "html_sanitized": field,
            "canonical_text": field,
            "t_start_ms": None,
            "t_end_ms": None,
            "speaker_label": None,
        }
        for ordinal in (0, 1)
    ]
    monkeypatch.setattr(
        public_resource_sharing,
        "_resolve_public_projection",
        lambda *_args, **_kwargs: projection,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "seal_public_handle",
        lambda *_args, **_kwargs: _CURSOR,
    )

    result = public_resource_sharing.get_public_fragments(
        _Db(rows),
        raw_token="opaque",
        query_items=[],
    )

    assert len(result.items) == 1
    assert result.page_info.next_cursor.kind == "Present"
    assert (
        public_resource_sharing._serialized_envelope_size(result)
        <= public_resource_sharing._MAX_PAGE_BYTES
    )
    oversized = PublicArticleFragmentPageOut(
        items=[
            PublicArticleFragmentOut(
                ordinal=ordinal,
                html_sanitized=field,
                canonical_text=field,
            )
            for ordinal in (0, 1)
        ],
        page_info=PublicPageInfo(next_cursor=absent()),
    )
    assert (
        public_resource_sharing._serialized_envelope_size(oversized)
        > public_resource_sharing._MAX_PAGE_BYTES
    )


def test_podcast_public_projection_requires_current_rss_transcript(monkeypatch) -> None:
    rows = [(0, "<p>Transcript</p>", "Transcript", 0, 1_000, "Host")]
    monkeypatch.setattr(
        public_resource_sharing,
        "_bootstrap_shape_supported",
        lambda *_args, **_kwargs: True,
    )
    rss_media = _media(
        kind="podcast_episode",
        transcript_last_request_reason="rss_feed",
    )
    provider_media = _media(
        kind="podcast_episode",
        transcript_last_request_reason="search",
    )

    assert public_resource_sharing._projection_shape_supported(
        _Db(rows),
        media=rss_media,
        highlight_id=None,
    )
    assert not public_resource_sharing._projection_shape_supported(
        _Db(rows),
        media=provider_media,
        highlight_id=None,
    )


def test_video_public_projection_requires_a_successful_source_attempt(monkeypatch) -> None:
    rows = [(0, "", "Transcript", 0, 1_000, None)]
    monkeypatch.setattr(
        public_resource_sharing,
        "_bootstrap_shape_supported",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "current_public_source_url",
        lambda *_args, **_kwargs: "https://www.youtube.com/watch?v=abcdefghijk",
    )
    media = _media(kind="video")

    assert public_resource_sharing._projection_shape_supported(
        _Db(rows),
        media=media,
        highlight_id=None,
    )
    assert not public_resource_sharing._projection_shape_supported(
        _Db(rows),
        media=replace(media, source_attempt_id=None),
        highlight_id=None,
    )
    assert not public_resource_sharing._projection_shape_supported(
        _Db(rows),
        media=replace(media, source_attempt_no=None),
        highlight_id=None,
    )


def test_podcast_transcript_provenance_is_revision_bound() -> None:
    media_id = uuid4()
    rss_media = _media(
        kind="podcast_episode",
        transcript_last_request_reason="rss_feed",
    )
    rss_media = replace(rss_media, media_id=media_id)
    provider_media = replace(rss_media, transcript_last_request_reason="search")
    rows = [(0, "", "Transcript", 0, 1_000, "Host")]

    assert public_resource_sharing._source_revision_bytes(
        _Db(rows),
        media=rss_media,
    ) != public_resource_sharing._source_revision_bytes(
        _Db(rows),
        media=provider_media,
    )


def test_epub_revision_includes_assets(monkeypatch) -> None:
    media = _media(kind="epub")
    owner = public_resource_sharing._EpubSourceOwner(
        attempt_id=uuid4(),
        attempt_no=1,
        source_type="uploaded_epub_file",
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "list_epub_section_sources",
        lambda *_args, **_kwargs: [EpubSectionSource(0, "Chapter", 0, "<p>Hi</p>", "Hi")],
    )
    assets = [EpubAssetSource(0, "image.png", "private/a", "image/png", 4)]
    monkeypatch.setattr(
        public_resource_sharing,
        "list_public_epub_asset_sources",
        lambda *_args, **_kwargs: assets,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "_load_epub_source_owner",
        lambda *_args, **_kwargs: owner,
    )
    first = public_resource_sharing._source_revision_bytes(object(), media=media)
    assets[0] = EpubAssetSource(0, "image.png", "private/b", "image/png", 4)
    second = public_resource_sharing._source_revision_bytes(object(), media=media)

    assert first != second


def test_epub_source_attempt_invalidates_same_path_same_size_asset_handle(
    monkeypatch,
) -> None:
    media = _media(kind="epub")
    owner = [
        public_resource_sharing._EpubSourceOwner(
            attempt_id=uuid4(),
            attempt_no=1,
            source_type="uploaded_epub_file",
        )
    ]
    monkeypatch.setattr(
        public_resource_sharing,
        "_load_epub_source_owner",
        lambda *_args, **_kwargs: owner[0],
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "list_epub_section_sources",
        lambda *_args, **_kwargs: [EpubSectionSource(0, "Chapter", 0, "<p>Hi</p>", "Hi")],
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "list_public_epub_asset_sources",
        lambda *_args, **_kwargs: [
            EpubAssetSource(0, "image.png", "private/stable", "image/png", 4)
        ],
    )
    old_revision = public_resource_sharing._source_revision_bytes(object(), media=media)
    old_context = PublicHandleContext(
        grant_id=uuid4(),
        parent_media_id=media.media_id,
        source_revision_bytes=old_revision,
    )
    handle = seal_public_handle("asset", ordinal=0, context=old_context, root_key=_ROOT_KEY)

    owner[0] = replace(owner[0], attempt_id=uuid4(), attempt_no=2)
    new_revision = public_resource_sharing._source_revision_bytes(object(), media=media)
    new_context = replace(old_context, source_revision_bytes=new_revision)

    assert new_revision != old_revision
    assert unseal_public_handle("asset", handle, context=new_context, root_key=_ROOT_KEY) is None


@pytest.mark.parametrize(
    "raw",
    [
        "bytes=00-1",
        "bytes=01-2",
        "bytes=0-02",
        "bytes=-01",
        "bytes=+1-2",
        "bytes= 1-2",
        "bytes=1-2,4-5",
    ],
)
def test_public_range_parser_rejects_noncanonical_or_multiple_ranges(raw: str) -> None:
    with pytest.raises(ValueError):
        parse_single_byte_range(raw, size_bytes=100)


def test_public_range_parser_retains_canonical_open_and_suffix_ranges() -> None:
    full = parse_single_byte_range("bytes=0-", size_bytes=100)
    suffix = parse_single_byte_range("bytes=-1", size_bytes=100)

    assert (full.start, full.end) == (0, 99)
    assert (suffix.start, suffix.end) == (99, 99)


def test_public_byline_query_excludes_manual_and_non_author_credits() -> None:
    db = _Db(["Source Author"])

    assert public_resource_sharing._load_bylines_if_supported(
        db,
        media_id=uuid4(),
    ) == ["Source Author"]
    assert "cc.role = 'author'" in db.statement
    assert "cc.source = 'web_article_byline'" in db.statement
    assert "cc.source = 'user'" not in db.statement


@pytest.mark.parametrize(
    ("content", "content_type"),
    [
        (None, None),
        (b"pdf", "application/pdf"),
        (b"pdf!!", "application/pdf"),
        (b"pdf!", "application/octet-stream"),
    ],
)
def test_public_pdf_masks_missing_or_mismatched_storage_object(
    monkeypatch,
    content: bytes | None,
    content_type: str | None,
) -> None:
    projection = _projection("pdf")
    source = MediaFileSource(
        storage_path="private/document.pdf",
        content_type="application/pdf",
        size_bytes=4,
    )
    storage = FakeStorageClient()
    if content is not None and content_type is not None:
        storage.put_object(source.storage_path, content, content_type)
    monkeypatch.setattr(
        public_resource_sharing,
        "_resolve_public_projection",
        lambda *_args, **_kwargs: projection,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "get_media_file_source",
        lambda *_args, **_kwargs: source,
    )

    with pytest.raises(NotFoundError):
        public_resource_sharing.get_public_pdf_file(
            object(),
            raw_token="opaque",
            raw_range=None,
            storage_client=storage,
        )


def test_public_pdf_validates_object_before_returning_full_or_range_stream(
    monkeypatch,
) -> None:
    projection = _projection("pdf")
    source = MediaFileSource(
        storage_path="private/document.pdf",
        content_type="application/pdf",
        size_bytes=4,
    )
    storage = FakeStorageClient()
    storage.put_object(source.storage_path, b"pdf!", "application/pdf")
    monkeypatch.setattr(
        public_resource_sharing,
        "_resolve_public_projection",
        lambda *_args, **_kwargs: projection,
    )
    monkeypatch.setattr(
        public_resource_sharing,
        "get_media_file_source",
        lambda *_args, **_kwargs: source,
    )

    full = public_resource_sharing.get_public_pdf_file(
        object(),
        raw_token="opaque",
        raw_range=None,
        storage_client=storage,
    )
    partial = public_resource_sharing.get_public_pdf_file(
        object(),
        raw_token="opaque",
        raw_range="bytes=1-2",
        storage_client=storage,
    )

    assert full.status_code == 200
    assert b"".join(full.chunks) == b"pdf!"
    assert partial.status_code == 206
    assert partial.content_range == "bytes 1-2/4"
    assert b"".join(partial.chunks) == b"df"
