"""Strict ingest, index, search, and resolver traces for real media."""

from __future__ import annotations

import hashlib

import pytest

from nexus.storage import get_storage_client
from tests.helpers import auth_headers, create_test_user_id
from tests.real_media.assertions import (
    assert_complete_evidence_trace,
    assert_media_ready,
    assert_no_search_results,
    assert_pdf_ocr_required_trace,
    assert_search_and_resolver,
)
from tests.real_media.conftest import (
    FIXTURES_DIR,
    REAL_MEDIA_FIXTURES_DIR,
    capture_nasa_water_article,
    create_nasa_captioned_video,
    create_nasa_podcast_episode,
    ensure_real_media_prerequisites,
    register_background_job_cleanup,
    upload_file_media,
    write_trace,
)
from tests.utils.db import DirectSessionManager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
    pytest.mark.supabase,
    pytest.mark.network,
    pytest.mark.real_media,
]


def test_real_pdf_upload_ingest_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    pdf_bytes = (FIXTURES_DIR / "pdf" / "attention.pdf").read_bytes()
    assert len(pdf_bytes) == 2_215_244
    assert hashlib.sha256(pdf_bytes).hexdigest() == (
        "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697"
    )

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename="attention.pdf",
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        result = ingest_pdf(str(media_id), request_id="real-media-pdf")
        assert result["status"] == "success", result
        assert result["has_text"] is True, result

        register_background_job_cleanup(direct_db, media_id)
        media_trace = assert_media_ready(auth_client, headers, media_id)
        evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "pdf", "pdf")
        search_trace = assert_search_and_resolver(
            auth_client, headers, media_id, "attention", "pdf"
        )
        no_result_trace = assert_no_search_results(
            auth_client, headers, media_id, "zzzz-real-media-no-result"
        )
        write_trace(
            tmp_path,
            "real-pdf-attention-trace.json",
            {
                "fixture_id": "pdf-attention",
                "source_url": "https://arxiv.org/abs/1706.03762",
                "license": "arXiv-hosted paper fixture used by existing repo tests",
                "media": media_trace,
                "evidence": evidence_trace,
                "search": search_trace,
                "no_result": no_result_trace,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_scanned_pdf_upload_ingest_marks_ocr_required_without_index_fallbacks(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    pdf_bytes = (REAL_MEDIA_FIXTURES_DIR / "frz-1784-01-03-scanned.pdf").read_bytes()
    assert len(pdf_bytes) == 827_443
    assert hashlib.sha256(pdf_bytes).hexdigest() == (
        "14b6a1729b9047a3738f23b818eac6faee80ff5a2d82731c208775a3b33a0c75"
    )

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename="frz-1784-01-03-scanned.pdf",
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        result = ingest_pdf(str(media_id), request_id="real-media-scanned-pdf")
        assert result["status"] == "success", result
        assert result["has_text"] is False, result

        register_background_job_cleanup(direct_db, media_id)
        media_response = auth_client.get(f"/media/{media_id}", headers=headers)
        assert media_response.status_code == 200, media_response.text
        media = media_response.json()["data"]
        assert media["processing_status"] == "ready_for_reading", media
        assert media["retrieval_status"] == "ocr_required", media
        assert media["capabilities"]["can_read"] is True, media["capabilities"]
        assert media["capabilities"]["can_search"] is False, media["capabilities"]

        ocr_trace = assert_pdf_ocr_required_trace(direct_db, media_id)
        no_result_trace = assert_no_search_results(auth_client, headers, media_id, "Freiburger")
        write_trace(
            tmp_path,
            "real-pdf-frz-1784-ocr-required-trace.json",
            {
                "fixture_id": "pdf-frz-1784-01-03-scanned",
                "source_url": "https://zenodo.org/records/16506766",
                "license": "Creative Commons Zero v1.0 Universal",
                "media": media,
                "ocr_required": ocr_trace,
                "no_result": no_result_trace,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_epub_upload_ingest_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    epub_bytes = (FIXTURES_DIR / "epub" / "moby-dick-epub3.epub").read_bytes()
    assert len(epub_bytes) == 815_946
    assert hashlib.sha256(epub_bytes).hexdigest() == (
        "1215d453321c51b130e41354355ad159e48154c1e1431bc1c41d6f138f8b1556"
    )

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="epub",
        filename="moby-dick-epub3.epub",
        content_type="application/epub+zip",
        payload=epub_bytes,
    )

    try:
        from nexus.tasks.ingest_epub import ingest_epub

        result = ingest_epub(str(media_id), request_id="real-media-epub")
        assert result["status"] == "success", result
        assert result["chapter_count"] > 0, result

        register_background_job_cleanup(direct_db, media_id)
        media_trace = assert_media_ready(auth_client, headers, media_id)
        evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "epub", "epub")
        search_trace = assert_search_and_resolver(auth_client, headers, media_id, "whale", "epub")
        no_result_trace = assert_no_search_results(
            auth_client, headers, media_id, "zzzz-real-media-no-result"
        )
        write_trace(
            tmp_path,
            "real-epub-moby-dick-trace.json",
            {
                "fixture_id": "epub-moby-dick-epub3",
                "source_url": "https://www.gutenberg.org/ebooks/2701",
                "license": "Project Gutenberg public-domain ebook",
                "media": media_trace,
                "evidence": evidence_trace,
                "search": search_trace,
                "no_result": no_result_trace,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_browser_captured_article_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    media_id = capture_nasa_water_article(auth_client, direct_db, headers)

    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "web_article", "web")
    search_trace = assert_search_and_resolver(auth_client, headers, media_id, "SOFIA", "web")
    no_result_trace = assert_no_search_results(
        auth_client, headers, media_id, "zzzz-real-media-no-result"
    )
    write_trace(
        tmp_path,
        "real-web-nasa-water-on-moon-trace.json",
        {
            "fixture_id": "web-nasa-water-on-moon",
            "source_url": "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/",
            "license": "NASA public web content",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "no_result": no_result_trace,
        },
    )


def test_real_video_caption_transcript_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    media_id = create_nasa_captioned_video(auth_client, direct_db, headers, user_id)

    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "transcript", "transcript")
    search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "International Space Station", "transcript"
    )
    no_result_trace = assert_no_search_results(
        auth_client, headers, media_id, "zzzz-real-media-no-result"
    )
    write_trace(
        tmp_path,
        "real-video-nasa-picturing-earth-trace.json",
        {
            "fixture_id": "video-nasa-picturing-earth-behind-scenes-captions",
            "source_url": (
                "https://science.nasa.gov/earth/earth-observatory/"
                "picturing-earth-behind-the-scenes/"
            ),
            "caption_url": (
                "https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/"
                "videos/transcripts/PicturingEarthBehindTheScenescaptions.srt"
            ),
            "license": "NASA public web content",
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "no_result": no_result_trace,
        },
    )


def test_real_podcast_episode_transcript_indexes_searches_and_resolves_evidence(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    media_id, podcast_id = create_nasa_podcast_episode(auth_client, direct_db, headers, user_id)

    media_trace = assert_media_ready(auth_client, headers, media_id)
    evidence_trace = assert_complete_evidence_trace(direct_db, media_id, "transcript", "transcript")
    search_trace = assert_search_and_resolver(
        auth_client, headers, media_id, "International Space Station", "transcript"
    )
    no_result_trace = assert_no_search_results(
        auth_client, headers, media_id, "zzzz-real-media-no-result"
    )
    write_trace(
        tmp_path,
        "real-podcast-nasa-hwhap-crew4-trace.json",
        {
            "fixture_id": "podcast-nasa-hwhap-crew4-transcript",
            "source_url": (
                "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/the-crew-4-astronauts/"
            ),
            "license": "NASA public web content",
            "podcast_id": str(podcast_id),
            "media": media_trace,
            "evidence": evidence_trace,
            "search": search_trace,
            "no_result": no_result_trace,
        },
    )
