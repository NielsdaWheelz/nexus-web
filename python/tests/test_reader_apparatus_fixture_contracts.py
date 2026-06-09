from collections import Counter
from uuid import uuid4

import pytest

from nexus.services.latex_apparatus import extract_latex_biblatex_apparatus_from_archive
from nexus.services.pdf_ingest import (
    _extract_pdf_legal_footnote_apparatus,
    _extract_pdf_native_link_apparatus,
    _merge_pdf_apparatus_results,
)
from nexus.services.pdf_scholarly_apparatus import extract_scholarly_tei_apparatus
from nexus.services.web_article_structure import prepare_web_article_fragment
from tests.reader_apparatus_assertions import (
    assert_body_needles_present,
    assert_edge_source_ref_sequence,
    assert_edge_source_to_target_source_ref_pairs,
    assert_edge_target_source_ref_sequence,
    assert_edges_point_to_non_reference_targets,
    assert_item_and_edge_counts_match_case,
)
from tests.reader_apparatus_corpus import (
    fixture_case_ids,
    fixture_cases,
    fixture_path,
)
from tests.reader_apparatus_gold_graph import load_reader_apparatus_gold_graph
from tests.reader_apparatus_latex_verifiers import verify_arxiv_latex_biblatex_graph
from tests.reader_apparatus_pdf_verifiers import (
    verify_pdf_legal_footnote_graph,
    verify_pdf_native_citation_graph,
    verify_pdf_unsupported_literary_graph,
    verify_pdf_unsupported_scholarly_graph,
)
from tests.reader_apparatus_tei_verifiers import verify_grobid_scholarly_tei_graph
from tests.reader_apparatus_web_verifiers import (
    verify_distill_apparatus_graph,
    verify_gutenberg_full_source_negative_graph,
    verify_gutenberg_linknote_graph,
    verify_gwern_endnote_graph,
    verify_legacy_named_notes_graph,
    verify_mediawiki_reference_graph,
    verify_standalone_margin_notes,
    verify_tufte_margin_graph,
)

pytestmark = pytest.mark.integration

HTML_READY_CASES = fixture_cases(fixture_format="html", status="ready")
HTML_EMPTY_CASES = fixture_cases(fixture_format="html", status="empty")
HTML_DISTILL_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="distill",
    )
]
HTML_MEDIAWIKI_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="mediawiki",
    )
]
HTML_GWERN_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="gwern",
    )
]
HTML_TUFTE_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="tufte",
    )
]
HTML_NUMINOUS_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="numinous",
    )
]
HTML_GUTENBERG_FULL_NEGATIVE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full_negative",
        source_family="gutenberg",
    )
]
HTML_GUTENBERG_LINKNOTE_FULL_SOURCE_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="committed_full",
        source_family="gutenberg_linknotes",
    )
]
HTML_LEGACY_NAMED_NOTES_PATTERN_CASES = [
    case
    for case in fixture_cases(
        fixture_format="html",
        fixture_kind="minimal_pattern",
        source_family="legacy_named_notes",
    )
]
PDF_NATIVE_LINK_CASES = fixture_cases(
    fixture_format="pdf",
    fixture_kind="committed_existing_fixture_pdf_native_link_graph_verified",
)
PDF_LEGAL_FOOTNOTE_PATTERN_CASES = fixture_cases(
    fixture_format="pdf",
    fixture_kind="synthetic_pdf_pattern",
    source_family="pdf_legal_footnotes",
)
PDF_UNSUPPORTED_ADAPTER_CASES = fixture_cases(
    fixture_format="pdf",
    fixture_kind="committed_full_unsupported_adapter",
)
ARXIV_SOURCE_PACKAGE_CASES = fixture_cases(
    fixture_format="arxiv_source",
    fixture_kind="committed_source_package",
)
TEI_GROBID_CASES = fixture_cases(
    fixture_format="tei",
    fixture_kind="committed_derived_tei",
)


def _prepared_case(case: dict[str, object]):
    html = fixture_path(case).read_text(encoding="utf-8")
    return prepare_web_article_fragment(
        html=html,
        base_url="https://example.test/article",
        fragment_idx=0,
        media_title=None,
    )


@pytest.mark.parametrize("case", HTML_READY_CASES, ids=fixture_case_ids(HTML_READY_CASES))
def test_reader_apparatus_html_fixtures_match_manifest_contract(
    case: dict[str, object],
):
    prepared = _prepared_case(case)

    assert_item_and_edge_counts_match_case(
        prepared.apparatus_items,
        prepared.apparatus_edges,
        case,
        item_fields=("kind",),
    )
    assert_edges_point_to_non_reference_targets(
        prepared.apparatus_items,
        prepared.apparatus_edges,
    )
    assert_body_needles_present(prepared.apparatus_items, case["expected"]["body_needles"])


@pytest.mark.parametrize("case", HTML_EMPTY_CASES, ids=fixture_case_ids(HTML_EMPTY_CASES))
def test_reader_apparatus_negative_html_fixtures_do_not_invent_edges(
    case: dict[str, object],
):
    prepared = _prepared_case(case)

    assert prepared.apparatus_items == []
    assert prepared.apparatus_edges == []


@pytest.mark.parametrize(
    "case",
    HTML_DISTILL_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_DISTILL_FULL_SOURCE_CASES],
)
def test_reader_apparatus_distill_full_source_fixtures_match_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_distill_apparatus_graph(html)
    prepared = _prepared_case(case)
    expected_graph = case["expected"]["independent_dom_graph"]
    expected_item_kinds = {
        "bibliography_entry": graph.cited_target_count,
        "bibliography_ref": graph.citation_marker_count,
    }
    if graph.footnote_count:
        expected_item_kinds.update(
            {
                "footnote": graph.footnote_count,
                "footnote_ref": graph.footnote_count,
            }
        )
    expected_edge_relations = {"cites_bibliography_entry": graph.citation_edge_count}
    expected_edge_methods = {"distill_citation": graph.citation_edge_count}
    if graph.footnote_count:
        expected_edge_relations["points_to_note"] = graph.footnote_count
        expected_edge_methods["distill_footnote"] = graph.footnote_count

    assert Counter(item["kind"] for item in prepared.apparatus_items) == expected_item_kinds
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == expected_edge_relations
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == (
        expected_edge_methods
    )
    assert graph.rendered_bibliography_entry_count == expected_graph[
        "rendered_bibliography_entry_count"
    ]
    assert graph.script_bibliography_entry_count == expected_graph[
        "script_bibliography_entry_count"
    ]
    assert graph.blank_citation_key_count == expected_graph["blank_citation_key_count"]
    assert len(graph.uncited_bibliography_keys) == expected_graph[
        "uncited_bibliography_entry_count"
    ]
    assert list(graph.uncited_bibliography_keys) == expected_graph[
        "uncited_bibliography_keys"
    ]
    emitted_bibliography_keys = {
        item["source_ref"].get("citation_key")
        for item in prepared.apparatus_items
        if item["kind"] == "bibliography_entry"
    }
    assert set(graph.uncited_bibliography_keys).isdisjoint(emitted_bibliography_keys)
    citation_edges = [
        edge for edge in prepared.apparatus_edges if edge["relation"] == "cites_bibliography_entry"
    ]
    assert_edge_source_ref_sequence(
        citation_edges,
        graph.citation_edge_keys,
        source_ref_key="citation_key",
    )
    assert_edge_source_to_target_source_ref_pairs(
        prepared.apparatus_items,
        citation_edges,
        tuple((key, key) for key in graph.citation_edge_keys),
        edge_source_ref_key="citation_key",
    )
    footnote_edges = [
        edge for edge in prepared.apparatus_edges if edge["relation"] == "points_to_note"
    ]
    assert_edge_source_ref_sequence(
        footnote_edges,
        graph.footnote_ordinals,
        source_ref_key="ordinal",
    )
    assert_edge_source_to_target_source_ref_pairs(
        prepared.apparatus_items,
        footnote_edges,
        tuple((ordinal, ordinal) for ordinal in graph.footnote_ordinals),
        edge_source_ref_key="ordinal",
    )


@pytest.mark.parametrize(
    "case",
    HTML_MEDIAWIKI_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_MEDIAWIKI_FULL_SOURCE_CASES],
)
def test_reader_apparatus_mediawiki_full_source_fixtures_match_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_mediawiki_reference_graph(html)
    prepared = _prepared_case(case)
    expected_graph = case["expected"]["independent_dom_graph"]

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "footnote": graph.target_count,
        "footnote_ref": graph.marker_count,
        "bibliography_entry": graph.cited_work_entry_count,
        "bibliography_ref": graph.nested_cited_work_link_count,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_note": graph.marker_count,
        "cites_bibliography_entry": graph.nested_cited_work_link_count,
    }
    assert Counter(edge["confidence"] for edge in prepared.apparatus_edges) == {
        "strong": graph.marker_count,
        "exact": graph.nested_cited_work_link_count,
    }
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == {
        "html_link_graph": graph.marker_count,
        "mediawiki_cited_work": graph.nested_cited_work_link_count,
    }
    assert graph.nested_cited_work_link_count == expected_graph["nested_cited_work_link_count"]
    assert graph.nested_cited_work_target_count == expected_graph["nested_cited_work_target_count"]
    assert (
        graph.nested_cited_work_resolved_target_count
        == expected_graph["nested_cited_work_resolved_target_count"]
    )
    assert (
        graph.nested_cited_work_unresolved_target_count
        == expected_graph["nested_cited_work_unresolved_target_count"]
    )
    assert graph.cited_work_entry_count == expected_graph["cited_work_entry_count"]
    assert (
        graph.unreferenced_cited_work_entry_count
        == expected_graph["unreferenced_cited_work_entry_count"]
    )
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))
    assert gold_graph["diagnostics"]["independent_dom_graph"] == expected_graph
    assert tuple(gold_graph["diagnostics"]["dom_target_body_sha256s"]) == (
        graph.target_body_sha256s
    )
    assert tuple(gold_graph["diagnostics"]["dom_cited_work_body_sha256s"]) == (
        graph.cited_work_body_sha256s
    )
    footnote_edges = [
        edge for edge in prepared.apparatus_edges if edge["relation"] == "points_to_note"
    ]
    bibliography_edges = [
        edge
        for edge in prepared.apparatus_edges
        if edge["relation"] == "cites_bibliography_entry"
    ]
    assert_edge_target_source_ref_sequence(
        prepared.apparatus_items,
        footnote_edges,
        graph.marker_targets,
    )
    assert_edge_target_source_ref_sequence(
        prepared.apparatus_items,
        bibliography_edges,
        graph.nested_cited_work_marker_targets,
    )
    assert_edge_source_to_target_source_ref_pairs(
        prepared.apparatus_items,
        bibliography_edges,
        tuple((target_id, target_id) for target_id in graph.nested_cited_work_marker_targets),
        edge_source_ref_key="target_id",
    )


@pytest.mark.parametrize(
    "case",
    HTML_GWERN_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_GWERN_FULL_SOURCE_CASES],
)
def test_reader_apparatus_gwern_full_source_fixtures_match_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_gwern_endnote_graph(html)
    prepared = _prepared_case(case)
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "endnote": graph.target_count,
        "endnote_ref": graph.marker_count,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_endnote": graph.marker_count
    }
    assert Counter(edge["confidence"] for edge in prepared.apparatus_edges) == {
        "exact": graph.marker_count
    }
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == {
        "html_semantic": graph.marker_count
    }
    assert_edge_target_source_ref_sequence(
        prepared.apparatus_items,
        prepared.apparatus_edges,
        graph.marker_targets,
    )
    assert gold_graph["diagnostics"]["independent_dom_graph"] == {
        "marker_count": graph.marker_count,
        "target_count": graph.target_count,
        "backlink_count": graph.backlink_count,
    }
    assert tuple(gold_graph["diagnostics"]["dom_marker_ids"]) == graph.marker_ids
    assert tuple(gold_graph["diagnostics"]["dom_marker_targets"]) == graph.marker_targets
    assert tuple(gold_graph["diagnostics"]["dom_target_ids"]) == graph.target_ids
    assert tuple(gold_graph["diagnostics"]["dom_target_body_sha256s"]) == (
        graph.target_body_sha256s
    )


@pytest.mark.parametrize(
    "case",
    HTML_TUFTE_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_TUFTE_FULL_SOURCE_CASES],
)
def test_reader_apparatus_tufte_full_source_fixture_matches_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_tufte_margin_graph(html)
    prepared = _prepared_case(case)
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "sidenote": graph.sidenote_count,
        "sidenote_ref": graph.sidenote_count,
        "margin_note": graph.margin_note_count,
        "margin_note_ref": graph.margin_note_count,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_sidenote": graph.sidenote_count,
        "points_to_margin_note": graph.margin_note_count,
    }
    assert Counter(edge["confidence"] for edge in prepared.apparatus_edges) == {
        "strong": graph.marker_count
    }
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == {
        "tufte_sidenote": graph.sidenote_count,
        "tufte_margin_note": graph.margin_note_count,
    }
    assert_edge_source_ref_sequence(
        prepared.apparatus_edges,
        graph.toggle_ids,
        source_ref_key="toggle_id",
    )
    assert tuple(
        item["body_text"]
        for item in prepared.apparatus_items
        if item["kind"] in {"sidenote", "margin_note"}
    ) == tuple(str(row["body_text"]) for row in graph.rows)
    assert gold_graph["diagnostics"]["independent_dom_graph"] == {
        "sidenote_count": graph.sidenote_count,
        "margin_note_count": graph.margin_note_count,
        "marker_count": graph.marker_count,
    }
    assert tuple(gold_graph["diagnostics"]["dom_toggle_rows"]) == graph.rows
    assert tuple(gold_graph["diagnostics"]["dom_note_body_sha256s"]) == (
        graph.body_sha256s
    )


@pytest.mark.parametrize(
    "case",
    HTML_NUMINOUS_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_NUMINOUS_FULL_SOURCE_CASES],
)
def test_reader_apparatus_numinous_full_source_fixture_matches_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_standalone_margin_notes(html)
    prepared = _prepared_case(case)
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "margin_note": graph.margin_note_count
    }
    assert tuple(item["body_text"] for item in prepared.apparatus_items) == graph.margin_note_texts
    assert prepared.apparatus_edges == []
    assert gold_graph["diagnostics"]["independent_dom_graph"] == {
        "margin_note_count": graph.margin_note_count,
        "edge_count": 0,
    }
    assert tuple(gold_graph["diagnostics"]["dom_margin_note_body_sha256s"]) == (
        graph.margin_note_body_sha256s
    )


@pytest.mark.parametrize(
    "case",
    HTML_GUTENBERG_FULL_NEGATIVE_CASES,
    ids=[case["id"] for case in HTML_GUTENBERG_FULL_NEGATIVE_CASES],
)
def test_reader_apparatus_gutenberg_full_source_negative_fixture_matches_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_gutenberg_full_source_negative_graph(html)
    prepared = _prepared_case(case)
    expected = case["expected"]["independent_dom_negative_graph"]

    assert prepared.apparatus_items == []
    assert prepared.apparatus_edges == []
    assert graph.has_notes_chapter is expected["has_notes_chapter"]
    assert graph.has_project_gutenberg_license is expected["has_project_gutenberg_license"]
    assert graph.inline_note_ref_count == expected["inline_note_ref_count"]
    assert graph.note_target_count == expected["note_target_count"]
    for needle in case["expected"]["source_needles"]:
        assert needle in html


@pytest.mark.parametrize(
    "case",
    HTML_GUTENBERG_LINKNOTE_FULL_SOURCE_CASES,
    ids=[case["id"] for case in HTML_GUTENBERG_LINKNOTE_FULL_SOURCE_CASES],
)
def test_reader_apparatus_gutenberg_linknote_full_source_fixture_matches_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_gutenberg_linknote_graph(html)
    prepared = _prepared_case(case)
    expected = case["expected"]["independent_dom_graph"]
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "endnote": graph.target_count,
        "endnote_ref": graph.marker_count,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_endnote": graph.marker_count
    }
    assert Counter(edge["confidence"] for edge in prepared.apparatus_edges) == {
        "strong": graph.marker_count
    }
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == {
        "html_project_gutenberg_linknote": graph.marker_count
    }
    assert graph.marker_count == expected["marker_count"]
    assert graph.target_count == expected["target_count"]
    assert graph.backlink_count == expected["backlink_count"]
    assert graph.has_project_gutenberg_license is expected["has_project_gutenberg_license"]
    assert_edge_source_ref_sequence(
        prepared.apparatus_edges,
        graph.marker_ids,
        source_ref_key="marker_id",
    )
    assert_edge_target_source_ref_sequence(
        prepared.apparatus_items,
        prepared.apparatus_edges,
        graph.marker_targets,
    )
    assert tuple(
        item["body_text"]
        for item in prepared.apparatus_items
        if item["kind"] == "endnote"
    ) == graph.note_texts
    assert gold_graph["diagnostics"]["independent_dom_graph"] == {
        "marker_count": graph.marker_count,
        "target_count": graph.target_count,
        "backlink_count": graph.backlink_count,
        "has_project_gutenberg_license": graph.has_project_gutenberg_license,
    }
    assert tuple(gold_graph["diagnostics"]["dom_marker_ids"]) == graph.marker_ids
    assert tuple(gold_graph["diagnostics"]["dom_marker_targets"]) == graph.marker_targets
    assert tuple(gold_graph["diagnostics"]["dom_target_ids"]) == graph.target_ids
    assert tuple(gold_graph["diagnostics"]["dom_note_body_sha256s"]) == (
        graph.note_body_sha256s
    )


@pytest.mark.parametrize(
    "case",
    HTML_LEGACY_NAMED_NOTES_PATTERN_CASES,
    ids=[case["id"] for case in HTML_LEGACY_NAMED_NOTES_PATTERN_CASES],
)
def test_reader_apparatus_legacy_named_notes_pattern_matches_independent_dom_graph(
    case: dict[str, object],
):
    html = fixture_path(case).read_text(encoding="utf-8")
    graph = verify_legacy_named_notes_graph(html)
    prepared = _prepared_case(case)

    assert Counter(item["kind"] for item in prepared.apparatus_items) == {
        "footnote": graph.target_count,
        "footnote_ref": graph.marker_count,
    }
    assert Counter(edge["relation"] for edge in prepared.apparatus_edges) == {
        "points_to_note": graph.marker_count
    }
    assert Counter(edge["confidence"] for edge in prepared.apparatus_edges) == {
        "strong": graph.marker_count
    }
    assert Counter(edge["extraction_method"] for edge in prepared.apparatus_edges) == {
        "html_legacy_named_notes": graph.marker_count
    }
    assert_edge_target_source_ref_sequence(
        prepared.apparatus_items,
        prepared.apparatus_edges,
        graph.marker_targets,
    )


@pytest.mark.parametrize(
    "case",
    PDF_NATIVE_LINK_CASES,
    ids=[case["id"] for case in PDF_NATIVE_LINK_CASES],
)
def test_reader_apparatus_pdf_native_link_fixture_matches_independent_graph(
    case: dict[str, object],
):
    pdf_bytes = fixture_path(case).read_bytes()
    graph = verify_pdf_native_citation_graph(pdf_bytes)
    extracted = _extract_pdf_native_link_apparatus(pdf_bytes, media_id=uuid4())
    gold_graph = load_reader_apparatus_gold_graph(str(case["id"]))

    assert graph.total_link_count == case["expected"]["pdf_link_counts"]["total"]
    assert graph.internal_link_count == case["expected"]["pdf_link_counts"]["internal"]
    assert graph.citation_link_count == case["expected"]["pdf_link_counts"]["named_cite"]
    assert (
        graph.target_count == case["expected"]["pdf_link_counts"]["unique_named_cite_destinations"]
    )
    assert extracted.status == case["expected"]["status"]
    assert_item_and_edge_counts_match_case(extracted.items, extracted.edges, case)
    target_labels = {
        str(item["label"]) for item in extracted.items if item["kind"] == "bibliography_entry"
    }
    assert target_labels == set(graph.target_labels)
    items_by_key = {item["stable_key"]: item for item in extracted.items}
    assert tuple(str(items_by_key[edge["to_stable_key"]]["label"]) for edge in extracted.edges) == (
        graph.marker_target_labels
    )
    assert len(extracted.edges) == graph.citation_link_count
    assert gold_graph["diagnostics"]["independent_pdf_graph"] == {
        "total_link_count": graph.total_link_count,
        "internal_link_count": graph.internal_link_count,
        "citation_link_count": graph.citation_link_count,
        "target_count": graph.target_count,
        "max_destination_delta_pt": round(graph.max_destination_delta_pt, 3),
    }
    assert tuple(gold_graph["diagnostics"]["pdf_marker_rows"]) == graph.marker_rows
    assert tuple(gold_graph["diagnostics"]["pdf_target_rows"]) == graph.target_rows
    assert tuple(gold_graph["diagnostics"]["target_body_sha256s"]) == (
        graph.target_body_sha256s
    )


@pytest.mark.parametrize(
    "case",
    PDF_LEGAL_FOOTNOTE_PATTERN_CASES,
    ids=[case["id"] for case in PDF_LEGAL_FOOTNOTE_PATTERN_CASES],
)
def test_reader_apparatus_pdf_legal_footnote_fixture_matches_independent_graph(
    case: dict[str, object],
):
    pdf_bytes = fixture_path(case).read_bytes()
    graph = verify_pdf_legal_footnote_graph(pdf_bytes)
    extracted = _extract_pdf_legal_footnote_apparatus(pdf_bytes, media_id=uuid4())

    assert graph.marker_count == case["expected"]["pdf_legal_footnotes"]["marker_count"]
    assert graph.target_count == case["expected"]["pdf_legal_footnotes"]["target_count"]
    assert extracted.status == case["expected"]["status"]
    assert_item_and_edge_counts_match_case(extracted.items, extracted.edges, case)
    assert extracted.diagnostics["pdf_legal_footnotes"] == case["expected"]["pdf_legal_footnotes"]
    assert {item["locator"]["type"] for item in extracted.items if item.get("locator")} == {
        "pdf_page_geometry"
    }
    assert_edge_source_ref_sequence(
        extracted.edges,
        graph.marker_labels,
        source_ref_key="marker_label",
    )
    assert_edge_target_source_ref_sequence(
        extracted.items,
        extracted.edges,
        graph.target_labels,
        source_ref_key="target_label",
    )
    assert_edge_source_to_target_source_ref_pairs(
        extracted.items,
        extracted.edges,
        tuple(zip(graph.marker_labels, graph.target_labels, strict=True)),
        edge_source_ref_key="marker_label",
        target_source_ref_key="target_label",
    )
    assert_body_needles_present(extracted.items, case["expected"]["body_needles"])


@pytest.mark.parametrize(
    "case",
    PDF_UNSUPPORTED_ADAPTER_CASES,
    ids=[case["id"] for case in PDF_UNSUPPORTED_ADAPTER_CASES],
)
def test_reader_apparatus_pdf_unsupported_adapter_fixture_does_not_emit_apparatus(
    case: dict[str, object],
):
    pdf_bytes = fixture_path(case).read_bytes()
    source_family = case["source_family"]
    if source_family == "pdf_scholarly_unsupported":
        expected = case["expected"]["pdf_unsupported_scholarly"]
        graph = verify_pdf_unsupported_scholarly_graph(pdf_bytes)
        assert graph.endnote_count == expected["endnote_count"]
        assert graph.has_references_section is expected["has_references_section"]
    elif source_family == "pdf_literary_unsupported":
        expected = case["expected"]["pdf_unsupported_literary"]
        graph = verify_pdf_unsupported_literary_graph(pdf_bytes)
        assert graph.has_printed_notes is expected["has_printed_notes"]
    else:
        raise AssertionError(source_family)
    extracted = _merge_pdf_apparatus_results(
        _extract_pdf_native_link_apparatus(pdf_bytes, media_id=uuid4()),
        _extract_pdf_legal_footnote_apparatus(pdf_bytes, media_id=uuid4()),
    )

    assert graph.page_count == expected["page_count"]
    assert graph.link_counts == expected["link_counts"]
    for needle in case["expected"]["body_needles"]:
        assert needle in graph.body_text

    assert extracted.status == case["expected"]["status"]
    assert extracted.items == []
    assert extracted.edges == []
    assert extracted.diagnostics == expected["diagnostics"]


@pytest.mark.parametrize(
    "case",
    ARXIV_SOURCE_PACKAGE_CASES,
    ids=[case["id"] for case in ARXIV_SOURCE_PACKAGE_CASES],
)
def test_reader_apparatus_arxiv_source_package_fixture_matches_independent_graph(
    case: dict[str, object],
):
    source_bytes = fixture_path(case).read_bytes()
    graph = verify_arxiv_latex_biblatex_graph(source_bytes)
    extracted = extract_latex_biblatex_apparatus_from_archive(
        source_bytes,
        source_kind=f"fixture:{case['id']}",
        source_ref={
            "format": "arxiv_source",
            "source_url": case["source_url"],
        },
    )

    assert graph.marker_count == case["expected"]["latex_biblatex"]["citation_marker_count"]
    assert graph.edge_count == case["expected"]["latex_biblatex"]["citation_edge_count"]
    assert (
        graph.cited_entry_count
        == case["expected"]["latex_biblatex"]["cited_bibliography_entry_count"]
    )
    assert graph.bib_entry_count == case["expected"]["latex_biblatex"]["bib_entry_count"]
    assert (
        graph.uncited_entry_count == case["expected"]["latex_biblatex"]["uncited_bib_entry_count"]
    )
    assert graph.footnote_count == case["expected"]["latex_biblatex"]["footnote_count"]
    assert extracted.status == case["expected"]["status"]
    assert_item_and_edge_counts_match_case(extracted.items, extracted.edges, case)
    assert extracted.diagnostics["latex_biblatex"] == case["expected"]["latex_biblatex"]
    assert_edge_source_ref_sequence(
        extracted.edges,
        graph.cited_keys,
        source_ref_key="citation_key",
    )
    assert_edge_target_source_ref_sequence(
        extracted.items,
        extracted.edges,
        graph.cited_keys,
        source_ref_key="citation_key",
    )
    assert_edge_source_to_target_source_ref_pairs(
        extracted.items,
        extracted.edges,
        tuple((key, key) for key in graph.cited_keys),
        edge_source_ref_key="citation_key",
    )

    assert_body_needles_present(extracted.items, case["expected"]["body_needles"])


@pytest.mark.parametrize(
    "case",
    TEI_GROBID_CASES,
    ids=[case["id"] for case in TEI_GROBID_CASES],
)
def test_reader_apparatus_grobid_tei_fixture_matches_independent_graph(
    case: dict[str, object],
):
    tei_xml = fixture_path(case).read_bytes()
    graph = verify_grobid_scholarly_tei_graph(tei_xml)
    extracted = extract_scholarly_tei_apparatus(
        tei_xml,
        source_kind=f"fixture:{case['id']}",
        source_ref={
            "media_id": str(uuid4()),
            "source_url": case["source_url"],
        },
    )
    expected = case["expected"]["grobid_tei_scholarly"]

    assert graph.bibliography_entry_count == expected["bibliography_entry_count"]
    assert graph.bibliography_ref_count == expected["bibliography_ref_count"]
    assert graph.resolved_bibliography_ref_count == expected["resolved_bibliography_ref_count"]
    assert graph.unresolved_bibliography_ref_count == expected["unresolved_bibliography_ref_count"]
    assert graph.unique_resolved_target_count == expected["unique_resolved_target_count"]
    assert (
        graph.author_year_resolved_ref_count
        == expected["author_year_resolved_bibliography_ref_count"]
    )
    assert graph.ambiguous_author_year_ref_count == expected["ambiguous_author_year_ref_count"]
    assert graph.suppressed_fragment_ref_count == expected["suppressed_fragment_ref_count"]
    assert graph.suppressed_fragment_edge_count == expected["suppressed_fragment_edge_count"]
    assert extracted.status == case["expected"]["status"]
    assert_item_and_edge_counts_match_case(extracted.items, extracted.edges, case)
    assert Counter(item["kind"] for item in extracted.items) == {
        "bibliography_entry": graph.bibliography_entry_count,
        "bibliography_ref": graph.bibliography_ref_count,
    }
    assert Counter(edge["relation"] for edge in extracted.edges) == {
        "cites_bibliography_entry": graph.resolved_bibliography_ref_count,
    }
    assert Counter(item["confidence"] for item in extracted.items) == {"probable": 250}
    assert Counter(edge["confidence"] for edge in extracted.edges) == {
        "probable": graph.resolved_bibliography_ref_count
    }
    assert Counter(item["locator_status"] for item in extracted.items) == {"exact": 250}
    assert Counter(item["extraction_method"] for item in extracted.items) == {
        "grobid_tei_bibliography_entry": graph.bibliography_entry_count,
        "grobid_tei_bibliography_ref": graph.bibliography_ref_count,
    }
    assert Counter(edge["extraction_method"] for edge in extracted.edges) == {
        "grobid_tei_bibliography_ref": (
            graph.resolved_bibliography_ref_count - graph.author_year_resolved_ref_count
        ),
        "grobid_tei_author_year_match": graph.author_year_resolved_ref_count,
    }
    assert_edge_source_to_target_source_ref_pairs(
        extracted.items,
        extracted.edges,
        graph.resolved_edge_pairs,
        edge_source_ref_key="target_id",
        target_source_ref_key="target_id",
    )
    assert extracted.diagnostics["grobid_tei_scholarly"] == {
        "status": "partial",
        "adapter_version": "grobid_tei_scholarly_v1",
        "tei_sha256": expected["tei_sha256"],
        "bibliography_entry_count": graph.bibliography_entry_count,
        "bibliography_ref_count": graph.bibliography_ref_count,
        "resolved_bibliography_ref_count": graph.resolved_bibliography_ref_count,
        "author_year_resolved_bibliography_ref_count": (graph.author_year_resolved_ref_count),
        "unresolved_bibliography_ref_count": graph.unresolved_bibliography_ref_count,
        "ambiguous_author_year_ref_count": graph.ambiguous_author_year_ref_count,
        "suppressed_fragment_ref_count": graph.suppressed_fragment_ref_count,
        "suppressed_fragment_edge_count": graph.suppressed_fragment_edge_count,
        "skipped": expected["skipped"],
    }
    assert_body_needles_present(extracted.items, case["expected"]["body_needles"])
