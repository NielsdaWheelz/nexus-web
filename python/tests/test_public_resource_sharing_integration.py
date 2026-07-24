from __future__ import annotations

from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Media,
    MediaFile,
    MediaSourceAttempt,
    MediaTranscriptState,
    PdfPageTextSpan,
    Podcast,
    PodcastEpisode,
    ProcessingStatus,
)
from nexus.services import locator_resolver, public_resource_sharing
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient

pytestmark = pytest.mark.integration


def _source_attempt(
    *,
    media_id: UUID,
    user_id: UUID,
    source_type: str,
    canonical_source_url: str | None = None,
    requested_url: str | None = None,
    provider: str | None = None,
    provider_target_ref: str | None = None,
    attempt_no: int = 1,
) -> MediaSourceAttempt:
    return MediaSourceAttempt(
        id=uuid4(),
        media_id=media_id,
        created_by_user_id=user_id,
        source_type=source_type,
        attempt_no=attempt_no,
        status="succeeded",
        intent_key=f"public-sharing-matrix:{media_id}:{attempt_no}",
        canonical_source_url=canonical_source_url,
        requested_url=requested_url,
        provider=provider,
        provider_target_ref=provider_target_ref,
        source_payload={},
    )


def _fragment_highlight(
    *,
    user_id: UUID,
    media_id: UUID,
    fragment_id: UUID,
    exact: str,
) -> tuple[Highlight, HighlightFragmentAnchor]:
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    return (
        highlight,
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment_id,
            start_offset=0,
            end_offset=len(exact),
        ),
    )


def _create_link(auth_client, headers: dict[str, str], resource_ref: str) -> tuple[str, str]:
    response = auth_client.post(
        f"/resource-items/{resource_ref}/shares",
        headers=headers,
        json={"audience": {"kind": "Link"}},
    )
    assert response.status_code == 200, (resource_ref, response.json())
    share = response.json()["data"]["share"]
    assert share["kind"] == "Link"
    token = share["publicHref"].split("#share=", 1)[1]
    return token, share["handle"]


def _public_headers(token: str) -> dict[str, str]:
    return {"X-Nexus-Share-Token": token}


def test_db_backed_public_projection_matrix_and_bearer_reauthorization(
    auth_client,
    direct_db,
    monkeypatch,
) -> None:
    owner_id = create_test_user_id()
    headers = auth_headers(owner_id, email=f"public-matrix-{owner_id}@example.com")
    profile = auth_client.get("/me", headers=headers)
    assert profile.status_code == 200
    library_id = UUID(profile.json()["data"]["default_library_id"])

    direct_db.register_cleanup("users", "id", owner_id)
    storage = FakeStorageClient()
    monkeypatch.setattr(public_resource_sharing, "get_storage_client", lambda: storage)

    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO billing_entitlement_overrides
                    (id, user_id, plan_tier, reason)
                VALUES (:id, :user_id, 'plus', 'public sharing matrix')
                """
            ),
            {"id": uuid4(), "user_id": owner_id},
        )

        article = Media(
            id=uuid4(),
            kind="web_article",
            title="Public article",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        article_fragments = [
            Fragment(
                id=uuid4(),
                media_id=article.id,
                idx=ordinal,
                canonical_text=text_value,
                html_sanitized=f"<p>{text_value}</p>",
            )
            for ordinal, text_value in enumerate(("Article exact text", "Article continuation"))
        ]

        epub = Media(
            id=uuid4(),
            kind="epub",
            title="Public EPUB",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        epub_fragments = [
            Fragment(
                id=uuid4(),
                media_id=epub.id,
                idx=ordinal,
                canonical_text=text_value,
                html_sanitized=(
                    f"<p>{text_value}</p><img "
                    f'src="/api/media/{epub.id}/assets/images/cover.png" alt="cover">'
                    if ordinal == 0
                    else f"<p>{text_value}</p>"
                ),
            )
            for ordinal, text_value in enumerate(("EPUB exact text", "EPUB continuation"))
        ]

        pdf_bytes = b"%PDF-1.7\npublic sharing matrix\n%%EOF\n"
        pdf_path = f"media/{uuid4()}/original.pdf"
        storage.put_object(pdf_path, pdf_bytes, "application/pdf")
        pdf = Media(
            id=uuid4(),
            kind="pdf",
            title="Public PDF",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
            plain_text="PDF exact text",
            page_count=1,
        )

        youtube_id = "dQw4w9WgXcQ"
        youtube_url = f"https://www.youtube.com/watch?v={youtube_id}"
        video = Media(
            id=uuid4(),
            kind="video",
            title="Public video",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        video_fragment = Fragment(
            id=uuid4(),
            media_id=video.id,
            idx=0,
            canonical_text="Video exact text",
            html_sanitized="<p>Video exact text</p>",
            t_start_ms=1_000,
            t_end_ms=2_000,
            speaker_label="Speaker",
        )

        podcast = Podcast(
            id=uuid4(),
            provider="test",
            provider_podcast_id=f"podcast-{uuid4()}",
            title="Public podcast",
            feed_url=f"https://feeds.example.org/{uuid4()}.xml",
        )
        episode = Media(
            id=uuid4(),
            kind="podcast_episode",
            title="Public podcast episode",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=owner_id,
        )
        episode_fragment = Fragment(
            id=uuid4(),
            media_id=episode.id,
            idx=0,
            canonical_text="Podcast exact text",
            html_sanitized="<p>Podcast exact text</p>",
            t_start_ms=2_000,
            t_end_ms=3_000,
            speaker_label="Host",
        )

        media_rows = (article, epub, pdf, video, episode)
        media_ids = {
            "article": article.id,
            "epub": epub.id,
            "pdf": pdf.id,
            "video": video.id,
            "podcast": episode.id,
        }
        db.add_all([*media_rows, *article_fragments, *epub_fragments, video_fragment])
        db.add_all([podcast, episode_fragment])
        db.flush()
        for media in media_rows:
            direct_db.register_cleanup("media", "id", media.id)
            add_media_to_library(db, library_id, media.id)

        db.add_all(
            [
                _source_attempt(
                    media_id=article.id,
                    user_id=owner_id,
                    source_type="generic_web_url",
                    canonical_source_url="https://example.org/article",
                    requested_url="https://example.org/article?private=removed",
                ),
                _source_attempt(
                    media_id=epub.id,
                    user_id=owner_id,
                    source_type="uploaded_epub_file",
                ),
                _source_attempt(
                    media_id=pdf.id,
                    user_id=owner_id,
                    source_type="uploaded_pdf_file",
                ),
                _source_attempt(
                    media_id=video.id,
                    user_id=owner_id,
                    source_type="youtube_video",
                    canonical_source_url=youtube_url,
                    requested_url=youtube_url,
                    provider="youtube",
                    provider_target_ref=youtube_id,
                ),
                _source_attempt(
                    media_id=episode.id,
                    user_id=owner_id,
                    source_type="podcast_episode_transcript",
                ),
                MediaTranscriptState(
                    media_id=video.id,
                    transcript_state="ready",
                    transcript_coverage="full",
                    semantic_status="none",
                ),
                MediaTranscriptState(
                    media_id=episode.id,
                    transcript_state="ready",
                    transcript_coverage="full",
                    semantic_status="none",
                    last_request_reason="rss_feed",
                ),
                PodcastEpisode(
                    media_id=episode.id,
                    podcast_id=podcast.id,
                    provider_episode_id=f"episode-{uuid4()}",
                    fallback_identity=f"fallback-{uuid4()}",
                    duration_seconds=3,
                ),
                MediaFile(
                    media_id=pdf.id,
                    storage_path=pdf_path,
                    content_type="application/pdf",
                    size_bytes=len(pdf_bytes),
                ),
                PdfPageTextSpan(
                    media_id=pdf.id,
                    page_number=1,
                    start_offset=0,
                    end_offset=len(pdf.plain_text or ""),
                    page_width=600,
                    page_height=800,
                    page_rotation_degrees=0,
                ),
            ]
        )
        direct_db.register_cleanup("podcasts", "id", podcast.id)
        direct_db.register_cleanup("epub_fragment_sources", "media_id", epub.id)
        direct_db.register_cleanup("epub_resources", "media_id", epub.id)
        direct_db.register_cleanup("resource_grants", "created_by_user_id", owner_id)

        for ordinal, fragment in enumerate(epub_fragments):
            node_id = f"chapter-{ordinal}"
            package_href = f"text/chapter-{ordinal}.xhtml"
            db.add(
                EpubTocNode(
                    media_id=epub.id,
                    node_id=node_id,
                    nav_type="toc",
                    label=f"Chapter {ordinal + 1}",
                    href=package_href,
                    fragment_idx=ordinal,
                    depth=ordinal,
                    order_key=f"{ordinal + 1:04d}",
                )
            )
            db.flush()
            db.add_all(
                [
                    EpubNavLocation(
                        media_id=epub.id,
                        location_id=package_href,
                        ordinal=ordinal,
                        source_node_id=node_id,
                        label=f"Chapter {ordinal + 1}",
                        fragment_idx=ordinal,
                        href_path=package_href,
                        source="toc",
                    ),
                    EpubFragmentSource(
                        id=uuid4(),
                        media_id=epub.id,
                        fragment_id=fragment.id,
                        package_href=package_href,
                        manifest_item_id=node_id,
                        spine_itemref_id=f"spine-{ordinal}",
                        media_type="application/xhtml+xml",
                        linear=True,
                        reading_order=ordinal,
                    ),
                ]
            )
        asset_path = f"media/{epub.id}/epub/images/cover.png"
        asset_bytes = b"\x89PNG\r\n\x1a\npublic"
        storage.put_object(asset_path, asset_bytes, "image/png")
        db.add(
            EpubResource(
                id=uuid4(),
                media_id=epub.id,
                manifest_item_id="cover",
                package_href="images/cover.png",
                asset_key="images/cover.png",
                storage_path=asset_path,
                content_type="image/png",
                size_bytes=len(asset_bytes),
            )
        )

        fragment_highlights: dict[str, Highlight] = {}
        for kind, media, fragment, exact in (
            ("article", article, article_fragments[0], "Article exact text"),
            ("epub", epub, epub_fragments[0], "EPUB exact text"),
            ("video", video, video_fragment, "Video exact text"),
            ("podcast", episode, episode_fragment, "Podcast exact text"),
        ):
            highlight, anchor = _fragment_highlight(
                user_id=owner_id,
                media_id=media.id,
                fragment_id=fragment.id,
                exact=exact,
            )
            fragment_highlights[kind] = highlight
            db.add_all([highlight, anchor])

        pdf_highlight = Highlight(
            id=uuid4(),
            user_id=owner_id,
            anchor_kind="pdf_page_geometry",
            anchor_media_id=pdf.id,
            color="blue",
            exact="PDF exact text",
            prefix="",
            suffix="",
        )
        db.add_all(
            [
                pdf_highlight,
                HighlightPdfAnchor(
                    highlight_id=pdf_highlight.id,
                    media_id=pdf.id,
                    page_number=1,
                    sort_top=Decimal("20"),
                    sort_left=Decimal("10"),
                    plain_text_match_status="unique",
                    plain_text_start_offset=0,
                    plain_text_end_offset=len("PDF exact text"),
                    rect_count=1,
                ),
                HighlightPdfQuad(
                    highlight_id=pdf_highlight.id,
                    quad_idx=0,
                    x1=Decimal("10"),
                    y1=Decimal("20"),
                    x2=Decimal("110"),
                    y2=Decimal("20"),
                    x3=Decimal("10"),
                    y3=Decimal("40"),
                    x4=Decimal("110"),
                    y4=Decimal("40"),
                ),
            ]
        )
        highlight_ids = {
            **{name: highlight.id for name, highlight in fragment_highlights.items()},
            "pdf": pdf_highlight.id,
        }
        db.commit()

    media_by_name = {
        "article": (media_ids["article"], "Article"),
        "epub": (media_ids["epub"], "Epub"),
        "pdf": (media_ids["pdf"], "Pdf"),
        "video": (media_ids["video"], "Transcript"),
        "podcast": (media_ids["podcast"], "Transcript"),
    }
    with direct_db.session() as db:
        for name, highlight_id in highlight_ids.items():
            assert (
                locator_resolver.resolve_highlight_reader_target(
                    db,
                    highlight_id=highlight_id,
                )
                is not None
            ), f"{name} highlight must resolve from current DB source rows"
            availability = public_resource_sharing.link_projection_availability(
                db,
                subject=public_resource_sharing.ResourceRef(
                    scheme="highlight",
                    id=highlight_id,
                ),
            )
            assert isinstance(
                availability,
                public_resource_sharing.Available,
            ), (name, availability)
    media_shares: dict[str, tuple[str, str]] = {}
    highlight_shares: dict[str, tuple[str, str]] = {}
    for name, (media_id, expected_reader) in media_by_name.items():
        media_shares[name] = _create_link(auth_client, headers, f"media:{media_id}")
        token, _handle = media_shares[name]
        response = auth_client.get(
            "/public/resource-share",
            headers=_public_headers(token),
        )
        assert response.status_code == 200, response.json()
        assert response.json()["data"]["subject"] == {"kind": "Media"}
        assert response.json()["data"]["reader"]["kind"] == expected_reader

        highlight_shares[name] = _create_link(
            auth_client,
            headers,
            f"highlight:{highlight_ids[name]}",
        )
        highlight_token, _highlight_handle = highlight_shares[name]
        highlighted = auth_client.get(
            "/public/resource-share",
            headers=_public_headers(highlight_token),
        )
        assert highlighted.status_code == 200, highlighted.json()
        subject = highlighted.json()["data"]["subject"]
        assert subject["kind"] == "Highlight"
        assert subject["highlight"]["quote"]["kind"] == "Present"
        expected_anchor = {
            "article": "ArticleText",
            "epub": "EpubText",
            "pdf": "PdfGeometry",
            "video": "TranscriptText",
            "podcast": "TranscriptText",
        }[name]
        assert subject["highlight"]["anchor"]["kind"] == expected_anchor
        assert "note" not in str(subject).lower()

    article_token = media_shares["article"][0]
    article_highlight_token = highlight_shares["article"][0]
    article_page = auth_client.get(
        "/public/resource-share/fragments?limit=1",
        headers=_public_headers(article_token),
    )
    assert article_page.status_code == 200
    cursor = article_page.json()["data"]["page_info"]["next_cursor"]["value"]
    resumed = auth_client.get(
        f"/public/resource-share/fragments?cursor={cursor}&limit=1",
        headers=_public_headers(article_token),
    )
    assert resumed.status_code == 200
    assert resumed.json()["data"]["items"][0]["ordinal"] == 1
    cross_cursor = auth_client.get(
        f"/public/resource-share/fragments?cursor={cursor}&limit=1",
        headers=_public_headers(article_highlight_token),
    )
    assert cross_cursor.status_code == 404

    epub_token = media_shares["epub"][0]
    epub_highlight_token = highlight_shares["epub"][0]
    navigation = auth_client.get(
        "/public/resource-share/navigation?limit=1",
        headers=_public_headers(epub_token),
    )
    assert navigation.status_code == 200, navigation.json()
    nav_data = navigation.json()["data"]
    section_handle = nav_data["items"][0]["section_handle"]
    nav_cursor = nav_data["page_info"]["next_cursor"]["value"]
    section = auth_client.get(
        f"/public/resource-share/sections/{section_handle}",
        headers=_public_headers(epub_token),
    )
    assert section.status_code == 200, section.json()
    html = section.json()["data"]["html_sanitized"]
    marker = 'data-nexus-public-asset-handle="'
    asset_handle = html.split(marker, 1)[1].split('"', 1)[0]
    asset = auth_client.get(
        f"/public/resource-share/assets/{asset_handle}",
        headers=_public_headers(epub_token),
    )
    assert asset.status_code == 200
    assert asset.content == asset_bytes
    for path in (
        f"/public/resource-share/navigation?cursor={nav_cursor}&limit=1",
        f"/public/resource-share/sections/{section_handle}",
        f"/public/resource-share/assets/{asset_handle}",
    ):
        cross = auth_client.get(path, headers=_public_headers(epub_highlight_token))
        assert cross.status_code == 404

    pdf_token = media_shares["pdf"][0]
    whole_pdf = auth_client.get(
        "/public/resource-share/file",
        headers=_public_headers(pdf_token),
    )
    assert whole_pdf.status_code == 200
    assert whole_pdf.content == pdf_bytes
    ranged_pdf = auth_client.get(
        "/public/resource-share/file",
        headers={**_public_headers(pdf_token), "Range": "bytes=0-0"},
    )
    assert ranged_pdf.status_code == 206
    assert ranged_pdf.content == pdf_bytes[:1]
    malformed_range = auth_client.get(
        "/public/resource-share/file",
        headers={**_public_headers(pdf_token), "Range": "bytes=0-0,2-3"},
    )
    assert malformed_range.status_code == 416

    revoked_token, revoked_handle = media_shares["article"]
    revoked = auth_client.delete(f"/resource-shares/{revoked_handle}", headers=headers)
    assert revoked.status_code == 204
    unavailable = auth_client.get(
        "/public/resource-share",
        headers=_public_headers(revoked_token),
    )
    assert unavailable.status_code == 404
    assert unavailable.json()["error"]["message"] == "Share unavailable"
