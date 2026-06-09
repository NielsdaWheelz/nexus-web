"""Reader apparatus real-media ingest/API checks."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from uuid import UUID

import fitz
import pytest

from nexus.storage.client import get_storage_client
from tests.helpers import auth_headers, create_test_user_id
from tests.reader_apparatus_assertions import (
    assert_edge_source_ref_sequence,
    assert_edge_source_to_target_source_ref_pairs,
    assert_edge_target_source_ref_sequence,
    assert_edges_point_to_expected_item_kinds,
    assert_edges_point_to_non_reference_targets,
    assert_item_and_edge_counts_match_case,
)
from tests.reader_apparatus_corpus import (
    EpubApparatusCase,
    WebArticleApparatusCase,
    automated_fixture_case,
    fixture_bytes,
    fixture_cases_by_real_media_contract,
    fixture_text,
    standardebooks_epub_real_media_cases,
    web_article_real_media_cases,
)
from tests.reader_apparatus_epub_verifiers import (
    assert_epub_noteref_pairs_match_apparatus,
    epub_noteref_pairs_from_archive,
)
from tests.reader_apparatus_pdf_verifiers import (
    verify_pdf_legal_footnote_graph,
    verify_pdf_native_citation_graph,
    verify_pdf_unsupported_literary_graph,
    verify_pdf_unsupported_scholarly_graph,
)
from tests.real_media.conftest import (
    ensure_real_media_prerequisites,
    register_background_job_cleanup,
    register_media_cleanup,
    run_source_attempt_for_media,
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


WEB_ARTICLE_CASES = web_article_real_media_cases()


STANDARD_EBOOKS_EPUB_CASES = standardebooks_epub_real_media_cases()
UNSUPPORTED_PDF_CASES = fixture_cases_by_real_media_contract(
    "pdf_upload_unsupported_pdf_adapter_api"
)


@pytest.mark.parametrize(
    "case",
    WEB_ARTICLE_CASES,
    ids=[case.fixture_id for case in WEB_ARTICLE_CASES],
)
def test_real_browser_captured_article_fixture_matches_reader_apparatus_matrix(
    case: WebArticleApparatusCase,
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    html = fixture_text(automated_fixture_case(case.fixture_id))

    session_response = auth_client.post("/auth/extension-sessions", headers=headers)
    assert session_response.status_code == 201, session_response.text
    session_id = UUID(session_response.json()["data"]["id"])
    token = session_response.json()["data"]["token"]
    direct_db.register_cleanup("extension_sessions", "id", session_id)

    capture_response = auth_client.post(
        "/media/capture/article",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "url": _capture_url(case),
            "title": case.title,
            "site_name": "Reader Apparatus Fixtures",
            "content_html": html,
        },
    )
    assert capture_response.status_code == 202, capture_response.text
    media_id = UUID(capture_response.json()["data"]["media_id"])
    register_media_cleanup(direct_db, media_id)

    result = run_source_attempt_for_media(direct_db, media_id)
    assert result["status"] == "success", result

    register_background_job_cleanup(direct_db, media_id)
    apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
    assert apparatus_response.status_code == 200, apparatus_response.text
    apparatus = apparatus_response.json()["data"]
    assert apparatus["media_kind"] == "web_article"
    _assert_apparatus_matches_case(apparatus, case)

    write_trace(
        tmp_path,
        f"real-{case.fixture_id}-reader-apparatus-trace.json",
        {
            "fixture_id": case.fixture_id,
            "modeled_source_url": case.modeled_source_url,
            "license": "synthetic minimal fixture modeled after source-authored markup shape",
            "ingest": result,
            "apparatus": apparatus,
        },
    )


def test_real_epub_noteref_persists_reader_apparatus(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    case = _single_real_media_fixture_case("epub_upload_synthetic_api")
    epub_bytes = fixture_bytes(case)

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="epub",
        filename=Path(case["path"]).name,
        content_type="application/epub+zip",
        payload=epub_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["chapter_count"] == case["expected"]["chapter_count"], result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "epub"
        assert apparatus["status"] == case["expected"]["status"]
        assert_item_and_edge_counts_match_case(
            apparatus["items"],
            apparatus["edges"],
            case,
            item_fields=("kind",),
            edge_fields=("relation",),
        )
        assert_edges_point_to_expected_item_kinds(
            apparatus["items"],
            apparatus["edges"],
            {"points_to_note": ("footnote_ref", "footnote")},
        )
        assert any(
            item["kind"] == "footnote"
            and all(needle in item["body_text"] for needle in case["expected"]["body_needles"])
            for item in apparatus["items"]
        )
        assert {
            item["locator"]["type"]
            for item in apparatus["items"]
            if item["locator_status"] == "exact"
        } == {"epub_fragment_offsets"}
        assert all(item["locator_status"] == "exact" for item in apparatus["items"])
        assert all(
            item["source_ref"]["package_href"].endswith("chapter.xhtml")
            and item["source_ref"]["manifest_id"] == "chapter"
            and item["source_ref"]["spine_index"] == 0
            for item in apparatus["items"]
        ), apparatus["items"]

        write_trace(
            tmp_path,
            "real-epub-noteref-reader-apparatus-trace.json",
            {
                "fixture_id": case["id"],
                "source_url": case["source_url"],
                "license": case["license_note"],
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


@pytest.mark.parametrize(
    "case",
    STANDARD_EBOOKS_EPUB_CASES,
    ids=[case.fixture_id for case in STANDARD_EBOOKS_EPUB_CASES],
)
def test_real_standardebooks_epub_cross_fragment_endnotes_persist_reader_apparatus(
    case: EpubApparatusCase,
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    epub_bytes = fixture_bytes(automated_fixture_case(case.fixture_id))
    expected_noterefs = epub_noteref_pairs_from_archive(epub_bytes)
    assert len(expected_noterefs) == case.edge_relations["points_to_endnote"]

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="epub",
        filename=case.filename,
        content_type="application/epub+zip",
        payload=epub_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["chapter_count"] == case.chapter_count, result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "epub"
        _assert_epub_apparatus_matches_case(apparatus, case)
        assert_epub_noteref_pairs_match_apparatus(apparatus, expected_noterefs)

        write_trace(
            tmp_path,
            f"real-{case.fixture_id}-reader-apparatus-trace.json",
            {
                "fixture_id": case.fixture_id,
                "source_url": case.source_url,
                "license": case.license_note,
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_epub_waste_land_notes_chapter_does_not_invent_reader_apparatus(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    case = _single_real_media_fixture_case("epub_upload_negative_api")
    epub_bytes = fixture_bytes(case)
    assert epub_noteref_pairs_from_archive(epub_bytes) == []

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="epub",
        filename=Path(case["path"]).name,
        content_type="application/epub+zip",
        payload=epub_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["chapter_count"] > 0, result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "epub"
        assert apparatus["status"] == case["expected"]["status"]
        assert apparatus["items"] == []
        assert apparatus["edges"] == []

        write_trace(
            tmp_path,
            "real-epub-waste-land-reader-apparatus-trace.json",
            {
                "fixture_id": case["id"],
                "source_url": case["source_url"],
                "license": case["license_note"],
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_pdf_attention_persists_native_link_graph_reader_apparatus(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    case = _single_real_media_fixture_case("pdf_upload_native_link_graph_api")
    pdf_bytes = fixture_bytes(case)
    graph = verify_pdf_native_citation_graph(pdf_bytes)
    assert _pdf_link_counts(pdf_bytes) == case["expected"]["pdf_link_counts"]
    assert (
        graph.target_count == case["expected"]["pdf_link_counts"]["unique_named_cite_destinations"]
    )

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename=Path(case["path"]).name,
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["has_text"] is True, result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "pdf"
        _assert_pdf_native_link_graph_apparatus_matches_case(
            apparatus,
            case,
            media_id,
            graph,
        )

        write_trace(
            tmp_path,
            "real-pdf-attention-reader-apparatus-trace.json",
            {
                "fixture_id": case["id"],
                "source_url": case["source_url"],
                "license": case["license_note"],
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def test_real_pdf_law_review_fixture_persists_legal_footnote_reader_apparatus(
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    case = _single_real_media_fixture_case("pdf_upload_legal_footnotes_api")
    pdf_bytes = fixture_bytes(case)
    graph = verify_pdf_legal_footnote_graph(pdf_bytes)

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename=Path(case["path"]).name,
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["has_text"] is True, result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "pdf"
        _assert_pdf_legal_footnote_apparatus_matches_case(
            apparatus,
            case,
            media_id,
            graph,
        )

        write_trace(
            tmp_path,
            "real-pdf-law-review-footnotes-reader-apparatus-trace.json",
            {
                "fixture_id": case["id"],
                "source_url": case["modeled_source_url"],
                "license": case["license_note"],
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


@pytest.mark.parametrize(
    "case",
    UNSUPPORTED_PDF_CASES,
    ids=[case["id"] for case in UNSUPPORTED_PDF_CASES],
)
def test_real_pdf_unsupported_adapter_fixture_does_not_invent_reader_apparatus(
    case: dict[str, object],
    auth_client,
    direct_db: DirectSessionManager,
    tmp_path,
):
    ensure_real_media_prerequisites()
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    auth_client.get("/me", headers=headers)
    direct_db.register_cleanup("users", "id", user_id)

    pdf_bytes = fixture_bytes(case)
    if case["source_family"] == "pdf_scholarly_unsupported":
        graph = verify_pdf_unsupported_scholarly_graph(pdf_bytes)
        expected = case["expected"]["pdf_unsupported_scholarly"]
        assert graph.endnote_count == expected["endnote_count"]
    elif case["source_family"] == "pdf_literary_unsupported":
        graph = verify_pdf_unsupported_literary_graph(pdf_bytes)
        expected = case["expected"]["pdf_unsupported_literary"]
        assert graph.has_printed_notes is expected["has_printed_notes"]
    else:
        raise AssertionError(case["source_family"])
    assert graph.page_count == expected["page_count"]
    assert graph.link_counts == expected["link_counts"]

    media_id, storage_path = upload_file_media(
        auth_client,
        direct_db,
        headers,
        kind="pdf",
        filename=Path(case["path"]).name,
        content_type="application/pdf",
        payload=pdf_bytes,
    )

    try:
        result = run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success", result
        assert result["has_text"] is True, result

        register_background_job_cleanup(direct_db, media_id)
        apparatus_response = auth_client.get(f"/media/{media_id}/apparatus", headers=headers)
        assert apparatus_response.status_code == 200, apparatus_response.text
        apparatus = apparatus_response.json()["data"]
        assert apparatus["media_kind"] == "pdf"
        assert apparatus["status"] == case["expected"]["status"]
        assert apparatus["items"] == []
        assert apparatus["edges"] == []
        assert apparatus["diagnostics"] == expected["diagnostics"]

        write_trace(
            tmp_path,
            f"real-{case['id']}-reader-apparatus-trace.json",
            {
                "fixture_id": case["id"],
                "source_url": case["source_url"],
                "license": case["license_note"],
                "ingest": result,
                "apparatus": apparatus,
            },
        )
    finally:
        get_storage_client().delete_object(storage_path)


def _assert_apparatus_matches_case(
    apparatus: dict[str, object],
    case: WebArticleApparatusCase,
) -> None:
    assert apparatus["status"] == case.expected_status
    items = apparatus["items"]
    edges = apparatus["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    assert Counter(item["kind"] for item in items) == case.item_kinds
    assert Counter(edge["relation"] for edge in edges) == case.edge_relations
    assert Counter(edge["confidence"] for edge in edges) == case.edge_confidences
    assert Counter(edge["extraction_method"] for edge in edges) == case.edge_methods
    body_text = "\n".join(str(item.get("body_text") or "") for item in items)
    for needle in case.body_needles:
        assert needle in body_text
    if case.expected_status == "ready":
        assert apparatus["capabilities"]["has_sidecar_items"] is True
        assert apparatus["capabilities"]["supports_hover_preview"] is bool(case.edge_relations)
        assert_edges_point_to_non_reference_targets(items, edges)
    else:
        assert items == []
        assert edges == []
    exact_locators = [item for item in items if item["locator_status"] == "exact"]
    assert len(exact_locators) >= case.min_exact_locators
    assert {item["locator"]["type"] for item in exact_locators} <= {"web_text_offsets"}


def _assert_epub_apparatus_matches_case(
    apparatus: dict[str, object],
    case: EpubApparatusCase,
) -> None:
    assert apparatus["status"] == "ready"
    items = apparatus["items"]
    edges = apparatus["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    assert Counter(item["kind"] for item in items) == case.item_kinds
    assert Counter(edge["relation"] for edge in edges) == case.edge_relations
    assert Counter(edge["confidence"] for edge in edges) == case.edge_confidences
    assert Counter(edge["extraction_method"] for edge in edges) == case.edge_methods
    assert_edges_point_to_expected_item_kinds(
        items,
        edges,
        {"points_to_endnote": ("endnote_ref", "endnote")},
    )
    body_text = "\n".join(str(item.get("body_text") or "") for item in items)
    for needle in case.body_needles:
        assert needle in body_text
    marker_items = [item for item in items if item["kind"] == "endnote_ref"]
    assert all(item["locator_status"] == "exact" for item in marker_items)
    assert {item["locator"]["type"] for item in marker_items} == {"epub_fragment_offsets"}
    endnote_items = [item for item in items if item["kind"] == "endnote"]
    assert all(item["locator_status"] == "exact" for item in endnote_items)
    assert {item["locator"]["type"] for item in endnote_items} == {"epub_fragment_offsets"}
    assert any(
        item["source_ref"]["package_href"].endswith("endnotes.xhtml") for item in endnote_items
    )
    assert apparatus["capabilities"]["has_sidecar_items"] is True
    assert apparatus["capabilities"]["supports_hover_preview"] is True


def _assert_pdf_native_link_graph_apparatus_matches_case(
    apparatus: dict[str, object],
    case: dict[str, object],
    media_id: UUID,
    graph,
) -> None:
    expected = case["expected"]
    assert isinstance(expected, dict)
    assert apparatus["status"] == expected["status"]
    items = apparatus["items"]
    edges = apparatus["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    assert_item_and_edge_counts_match_case(items, edges, case)
    assert_edges_point_to_expected_item_kinds(
        items,
        edges,
        {"cites_bibliography_entry": ("bibliography_ref", "bibliography_entry")},
    )
    assert apparatus["capabilities"] == {
        "has_inline_markers": True,
        "has_sidecar_items": True,
        "supports_hover_preview": True,
        "supports_jump_to_marker": True,
        "supports_jump_to_target": True,
        "has_probable_items": False,
    }

    target_labels = {str(item["label"]) for item in items if item["kind"] == "bibliography_entry"}
    assert target_labels == set(graph.target_labels)
    items_by_key = {item["stable_key"]: item for item in items}
    assert tuple(str(items_by_key[edge["to_stable_key"]]["label"]) for edge in edges) == (
        graph.marker_target_labels
    )
    body_text = "\n".join(str(item.get("body_text") or "") for item in items)
    for needle in expected.get("body_needles", []):
        assert needle in body_text

    for item in items:
        assert item["label"]
        assert item["locator_status"] == "exact"
        assert item["confidence"] == "exact"
        locator = item["locator"]
        assert locator["type"] == "pdf_page_geometry"
        assert locator["media_id"] == str(media_id)
        if item["kind"] == "bibliography_ref":
            assert item["body_text"] is None
            assert item["body_html_sanitized"] is None
            assert item["extraction_method"] == "pdf_native_link"
            assert locator["exact"] == item["label"]
            assert locator["text_quote_selector"] == {"exact": item["label"]}
        else:
            assert item["kind"] == "bibliography_entry"
            assert item["body_text"]
            assert item["body_html_sanitized"] is None
            assert item["extraction_method"] == "pdf_native_link_target"
            assert locator["exact"] == item["body_text"]
            assert locator["text_quote_selector"] == {"exact": item["body_text"]}
        assert len(locator["quads"]) == 1
        assert set(locator["quads"][0]) == {
            "x1",
            "y1",
            "x2",
            "y2",
            "x3",
            "y3",
            "x4",
            "y4",
        }
        source_ref = item["source_ref"]
        assert source_ref["format"] == "pdf"
        if item["kind"] == "bibliography_ref":
            assert source_ref["page_number"] == locator["page_number"]
            assert str(source_ref["named_destination"]).startswith("cite.")
            assert isinstance(source_ref["link_index"], int)
            assert source_ref["destination_page_number"] >= 1
            assert set(source_ref["source_rect"]) == {"left", "top", "right", "bottom"}
        else:
            assert str(source_ref["named_destination"]).startswith("cite.")
            assert source_ref["target_label"] == item["label"]
            assert source_ref["target_page_number"] == locator["page_number"]
            assert set(source_ref["reference_block"]) == {"left", "top", "right", "bottom"}

    diagnostics = apparatus["diagnostics"]["pdf_native_link"]
    expected_diagnostics = expected["diagnostics"]["pdf_native_link"]
    assert diagnostics["status"] == expected_diagnostics["status"]
    assert diagnostics["marker_count"] == expected_diagnostics["marker_count"]
    assert diagnostics["target_count"] == expected_diagnostics["target_count"]
    assert diagnostics["edge_count"] == expected_diagnostics["edge_count"]
    assert diagnostics["unresolved_marker_count"] == expected_diagnostics["unresolved_marker_count"]
    assert diagnostics["citation_link_count"] == expected["pdf_link_counts"]["named_cite"]
    assert diagnostics["internal_link_count"] == expected["pdf_link_counts"]["internal"]
    assert diagnostics["total_link_count"] == expected["pdf_link_counts"]["total"]


def _assert_pdf_legal_footnote_apparatus_matches_case(
    apparatus: dict[str, object],
    case: dict[str, object],
    media_id: UUID,
    graph,
) -> None:
    expected = case["expected"]
    assert isinstance(expected, dict)
    assert apparatus["status"] == expected["status"]
    items = apparatus["items"]
    edges = apparatus["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    assert_item_and_edge_counts_match_case(items, edges, case)
    assert_edges_point_to_expected_item_kinds(
        items,
        edges,
        {"points_to_note": ("footnote_ref", "footnote")},
    )
    assert apparatus["capabilities"] == {
        "has_inline_markers": True,
        "has_sidecar_items": True,
        "supports_hover_preview": True,
        "supports_jump_to_marker": True,
        "supports_jump_to_target": True,
        "has_probable_items": False,
    }
    assert graph.marker_count == expected["pdf_legal_footnotes"]["marker_count"]
    assert graph.target_count == expected["pdf_legal_footnotes"]["target_count"]
    assert_edge_source_ref_sequence(
        edges,
        graph.marker_labels,
        source_ref_key="marker_label",
    )
    assert_edge_target_source_ref_sequence(
        items,
        edges,
        graph.target_labels,
        source_ref_key="target_label",
    )
    assert_edge_source_to_target_source_ref_pairs(
        items,
        edges,
        tuple(zip(graph.marker_labels, graph.target_labels, strict=True)),
        edge_source_ref_key="marker_label",
        target_source_ref_key="target_label",
    )

    body_text = "\n".join(str(item.get("body_text") or "") for item in items)
    for needle in expected.get("body_needles", []):
        assert needle in body_text

    for item in items:
        assert item["label"]
        assert item["locator_status"] == "exact"
        assert item["confidence"] == "strong"
        locator = item["locator"]
        assert locator["type"] == "pdf_page_geometry"
        assert locator["media_id"] == str(media_id)
        assert len(locator["quads"]) == 1
        assert item["source_ref"]["format"] == "pdf"
        if item["kind"] == "footnote_ref":
            assert item["body_text"] is None
            assert item["extraction_method"] == "pdf_legal_footnote_marker"
            assert locator["exact"] == item["label"]
        else:
            assert item["kind"] == "footnote"
            assert item["body_text"]
            assert item["extraction_method"] == "pdf_legal_footnote_target"
            assert locator["exact"] == item["body_text"]

    assert apparatus["diagnostics"]["pdf_legal_footnotes"] == expected["pdf_legal_footnotes"]


def _capture_url(case: WebArticleApparatusCase) -> str:
    if case.modeled_source_url.startswith("synthetic:"):
        return f"https://example.com/reader-apparatus/{case.fixture_id}"
    return case.modeled_source_url


def _single_real_media_fixture_case(contract: str) -> dict[str, object]:
    cases = fixture_cases_by_real_media_contract(contract)
    assert len(cases) == 1, contract
    return cases[0]


def _pdf_link_counts(pdf_bytes: bytes) -> dict[str, int]:
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        total = 0
        internal = 0
        named_cite = 0
        named_cite_destinations: set[str] = set()
        for page in document:
            for link in page.get_links():
                total += 1
                if "page" in link:
                    internal += 1
                destination = str(link.get("nameddest") or "")
                if destination.startswith("cite."):
                    named_cite += 1
                    named_cite_destinations.add(destination)
        return {
            "internal": internal,
            "named_cite": named_cite,
            "total": total,
            "unique_named_cite_destinations": len(named_cite_destinations),
        }
