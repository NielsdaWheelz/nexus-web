from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from nexus.schemas.reader_apparatus import ReaderApparatusResponse
from tests.reader_apparatus_corpus import (
    APPARATUS_SUPPORT_BY_FIXTURE_POLICY,
    APPARATUS_SUPPORT_LEVELS,
    COMMITTED_FIXTURE_GRAPH_SUPPORT_LEVELS,
    COMMITTED_RAW_SOURCE_FIXTURE_POLICIES,
    DATE_RE,
    DERIVED_FIXTURE_KINDS,
    FIXTURE_PROVENANCE_KEYS,
    FIXTURE_PROVENANCE_STATUSES,
    FIXTURES_ROOT,
    FRONTEND_SURFACE_EXPECTATIONS,
    FRONTEND_SURFACE_GAP_REASONS,
    FRONTEND_SURFACE_VERIFICATION_STATUSES,
    MANIFEST_PATH,
    MANUAL_VERIFICATION_CONTRACTS,
    OVERCLAIM_RE,
    PATTERN_FIXTURE_KINDS,
    PATTERN_SOURCE_POLICIES,
    PATTERN_SUPPORT_LEVELS,
    RAW_FIXTURE_KINDS,
    RAW_SOURCE_COMMIT_SCOPES,
    RAW_SOURCE_FIXTURE_ELIGIBILITY_KEYS,
    RAW_SOURCE_FIXTURE_ELIGIBILITY_STATUSES,
    REAL_MEDIA_FIXTURE_CONTRACTS,
    RETIRED_OVERCLAIM_STATUS_LABELS,
    SOURCE_PACKAGE_SUPPORT_LEVELS,
    SOURCE_PROVENANCE_KEYS,
    SOURCE_PROVENANCE_STATUSES,
    UNSUPPORTED_COMMITTED_FIXTURE_SUPPORT_LEVELS,
    URL_ONLY_STATUSES,
    VERIFIER_SCOPES,
    VERIFIER_TIERS,
    assert_fixture_file_matches_manifest,
    automated_fixture_cases,
    automated_fixtures_by_id,
    fixture_cases_by_real_media_contract,
    fixture_path,
    frontend_api_payload_fixtures,
    frontend_surface_contracts,
    gold_graph_fixtures,
    linked_fixture_cases,
    load_reader_apparatus_manifest,
    real_media_fixture_contracts,
    source_corpus,
    support_counts,
    verifier_tiers,
)
from tests.reader_apparatus_frontend_payloads import (
    FRONTEND_PAYLOAD_INDEX_PATH,
    build_frontend_payload_index,
    frontend_payload_artifacts,
    frontend_payload_manifest_entries,
    frontend_surface_contract_entries,
)
from tests.reader_apparatus_gold_graph import (
    GOLD_GRAPH_COVERAGE,
    load_reader_apparatus_gold_graph,
)

pytestmark = pytest.mark.integration


def test_reader_apparatus_manifest_covers_the_motivating_twenty_source_corpus():
    manifest = load_reader_apparatus_manifest()
    sources = source_corpus()
    source_ids = [source["id"] for source in sources]
    fixture_ids = {case["id"] for case in automated_fixture_cases()}
    blocked_sources = manifest["blocked_motivating_sources"]

    assert manifest["source_count"] == 20
    assert len(sources) == 20
    assert len(source_ids) == len(set(source_ids))
    assert all(source["url"] for source in sources)

    for source in sources:
        assert source["manual_verification"] != "exhaustive", source
        for fixture_id in source["fixture_ids"]:
            assert fixture_id in fixture_ids, source
        for fixture_id in source.get("derived_fixture_ids", []):
            assert fixture_id in fixture_ids, source
            assert fixture_id not in source["fixture_ids"], source

    for blocked_source in blocked_sources:
        assert blocked_source["original_source_id"] not in source_ids, blocked_source
        assert blocked_source["replacement_source_id"] in source_ids, blocked_source
        assert blocked_source["reason"] in {"raw_source_rights_unclear"}, blocked_source
        for fixture_id in blocked_source["fixture_ids"]:
            assert fixture_id in fixture_ids, blocked_source


def test_reader_apparatus_manifest_maps_each_original_objective_source():
    manifest = load_reader_apparatus_manifest()
    sources = {source["id"]: source for source in source_corpus()}
    blocked_sources = {source["id"]: source for source in manifest["blocked_motivating_sources"]}
    objective_sources = manifest["original_objective_sources"]
    support_by_objective_status = {
        "committed_fixture_graph_verified": "committed_fixture_graph_verified",
        "committed_fixture_negative_graph_verified": "committed_fixture_negative_graph_verified",
        "pdf_native_link_graph_verified": "pdf_native_link_graph_verified",
        "source_package_verified": "source_package_verified",
        "unsupported_adapter_negative": "full_source_unsupported_adapter",
        "pattern_only": "pattern_verified",
    }

    assert manifest["original_objective_source_count"] == 20
    assert len(objective_sources) == 20
    assert len({source["url"] for source in objective_sources}) == 20

    for objective_source in objective_sources:
        status = objective_source["objective_status"]
        assert status in {
            *support_by_objective_status,
            "blocked_replaced",
        }, objective_source

        if status == "blocked_replaced":
            blocked = blocked_sources[objective_source["blocked_source_id"]]
            replacement = sources[objective_source["replacement_source_id"]]
            assert blocked["url"] == objective_source["url"], objective_source
            assert blocked["replacement_source_id"] == replacement["id"], objective_source
            assert "corpus_source_id" not in objective_source, objective_source
            replacement_status = objective_source["replacement_status"]
            assert replacement_status in support_by_objective_status, objective_source
            assert (
                replacement["apparatus_support_level"]
                == support_by_objective_status[replacement_status]
            ), objective_source
            continue

        source = sources[objective_source["corpus_source_id"]]
        assert source["url"] == objective_source.get(
            "corpus_url",
            objective_source["url"],
        ), objective_source
        assert source["apparatus_support_level"] == support_by_objective_status[status], (
            objective_source
        )
        assert objective_source.get("blocked_source_id") is None, objective_source
        assert objective_source.get("replacement_source_id") is None, objective_source


def test_reader_apparatus_manifest_hashes_match_committed_fixtures():
    for case in automated_fixture_cases():
        assert_fixture_file_matches_manifest(case)


def test_reader_apparatus_manifest_references_only_git_tracked_fixture_files():
    repo_root = Path(__file__).parents[2]
    required_paths = [
        MANIFEST_PATH,
        FRONTEND_PAYLOAD_INDEX_PATH,
        FIXTURES_ROOT / "reader_apparatus" / "README.md",
        *(fixture_path(case) for case in automated_fixture_cases()),
        *(FIXTURES_ROOT / gold_graph["path"] for gold_graph in gold_graph_fixtures()),
        *(repo_root / payload["path"] for payload in frontend_api_payload_fixtures()),
    ]

    missing = []
    for path in required_paths:
        relative_path = path.relative_to(repo_root)
        result = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "--error-unmatch", "--", str(relative_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            missing.append(str(relative_path))

    assert missing == []


def test_reader_apparatus_manifest_test_selectors_reference_git_tracked_files():
    repo_root = Path(__file__).parents[2]
    manifest = load_reader_apparatus_manifest()
    selectors: set[str] = set()

    def collect_selectors(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("test_selector") and isinstance(child, str):
                    selectors.add(child)
                collect_selectors(child)
            return
        if isinstance(value, list):
            for child in value:
                collect_selectors(child)

    collect_selectors(manifest)
    assert selectors

    missing = []
    for selector in sorted(selectors):
        test_path = selector.split("::", 1)[0]
        repo_relative_path = Path("python") / test_path
        result = subprocess.run(
            [
                "git",
                "-C",
                str(repo_root),
                "ls-files",
                "--error-unmatch",
                "--",
                str(repo_relative_path),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            missing.append(selector)

    assert missing == []


def test_reader_apparatus_frontend_api_payload_fixtures_match_backend_schema():
    repo_root = Path(__file__).parents[2]
    fixture_cases = automated_fixtures_by_id()
    payload_fixtures = frontend_api_payload_fixtures()

    assert load_reader_apparatus_manifest()["frontend_api_payload_schema_version"] == 1
    assert {payload["surface_contract"] for payload in payload_fixtures} == {
        "reader_apparatus_empty_sidecar",
        "reader_apparatus_sidecar_rows",
    }

    for payload_fixture in payload_fixtures:
        fixture_id = payload_fixture["fixture_id"]
        case = fixture_cases[fixture_id]
        path = repo_root / payload_fixture["path"]
        payload_bytes = path.read_bytes()
        assert hashlib.sha256(payload_bytes).hexdigest() == payload_fixture["payload_sha256"]

        payload = json.loads(payload_bytes)
        assert set(payload) == {
            "apparatus",
            "fixture_id",
            "source_fixture_path",
            "source_fixture_sha256",
        }
        assert payload["fixture_id"] == fixture_id
        assert payload["source_fixture_path"] == case["path"]
        assert payload["source_fixture_sha256"] == payload_fixture["source_fixture_sha256"]
        assert payload["source_fixture_sha256"] == case["sha256"]

        apparatus = ReaderApparatusResponse.model_validate(payload["apparatus"])
        expected = case["expected"]
        assert apparatus.status == expected["status"], fixture_id
        assert len(apparatus.items) == sum(expected["item_kinds"].values()), fixture_id
        assert len(apparatus.edges) == sum(expected["edge_relations"].values()), fixture_id

        if payload_fixture["surface_contract"] == "reader_apparatus_empty_sidecar":
            assert apparatus.items == []
            assert apparatus.edges == []
        else:
            assert apparatus.items
            assert apparatus.capabilities.has_sidecar_items is True


def test_reader_apparatus_frontend_payload_manifest_entries_are_generated():
    repo_root = Path(__file__).parents[2]
    artifacts = frontend_payload_artifacts()

    assert frontend_api_payload_fixtures() == frontend_payload_manifest_entries(artifacts)
    assert frontend_surface_contracts() == frontend_surface_contract_entries(artifacts)
    assert FRONTEND_PAYLOAD_INDEX_PATH.read_text(encoding="utf-8") == (
        build_frontend_payload_index(artifacts)
    )

    stale_payloads = [
        str(artifact.path.relative_to(repo_root))
        for artifact in artifacts
        if not artifact.path.exists() or artifact.path.read_bytes() != artifact.payload_bytes
    ]
    assert stale_payloads == []


def test_reader_apparatus_manifest_declares_frontend_surface_coverage_for_every_fixture():
    manifest = load_reader_apparatus_manifest()
    fixture_cases = automated_fixtures_by_id()
    payload_fixture_ids = {payload["fixture_id"] for payload in frontend_api_payload_fixtures()}
    contracts = frontend_surface_contracts()

    assert manifest["frontend_surface_contract_schema_version"] == 3
    assert {contract["fixture_id"] for contract in contracts} == {
        case["id"] for case in automated_fixture_cases()
    }
    assert payload_fixture_ids == set(fixture_cases)

    unrendered_row_fixtures = []
    for contract in contracts:
        fixture_id = contract["fixture_id"]
        case = fixture_cases[fixture_id]
        expected = case["expected"]

        assert set(contract) <= {
            "expected_reader_tools_surface",
            "fixture_id",
            "gap_reason",
            "verification_status",
            "verified_layers",
        }, fixture_id
        assert contract["expected_reader_tools_surface"] in FRONTEND_SURFACE_EXPECTATIONS
        assert contract["verification_status"] in FRONTEND_SURFACE_VERIFICATION_STATUSES

        expected_surface = (
            "citations_tab_rows"
            if expected["status"] in {"partial", "ready"}
            and sum(expected.get("item_kinds", {}).values()) > 0
            else "citations_tab_omitted"
        )
        assert contract["expected_reader_tools_surface"] == expected_surface, fixture_id

        if fixture_id in payload_fixture_ids:
            expected_verification_status = (
                "reader_shell_omission_tested"
                if expected_surface == "citations_tab_omitted"
                else "payload_projection_and_direct_surface_tested"
            )
            assert contract["verification_status"] == expected_verification_status, fixture_id
            assert "gap_reason" not in contract, fixture_id
            continue

        assert contract["verification_status"] == "not_frontend_payload_tested", fixture_id
        assert contract.get("gap_reason") in FRONTEND_SURFACE_GAP_REASONS, fixture_id
        if expected_surface == "citations_tab_rows":
            unrendered_row_fixtures.append(fixture_id)

    assert unrendered_row_fixtures == []


def test_reader_apparatus_gold_graph_manifest_entries_match_committed_fixtures():
    manifest = load_reader_apparatus_manifest()
    fixture_cases = automated_fixtures_by_id()
    gold_fixtures = gold_graph_fixtures()

    assert manifest["gold_graph_schema_version"] == 1
    assert len(gold_fixtures) == len({entry["fixture_id"] for entry in gold_fixtures})

    for entry in gold_fixtures:
        fixture_id = entry["fixture_id"]
        case = fixture_cases[fixture_id]
        path = FIXTURES_ROOT / entry["path"]
        payload = path.read_bytes()
        graph = load_reader_apparatus_gold_graph(fixture_id)

        assert path.exists(), fixture_id
        assert hashlib.sha256(payload).hexdigest() == entry["gold_graph_sha256"]
        assert graph["fixture_id"] == fixture_id
        assert graph["fixture_sha256"] == entry["fixture_sha256"]
        assert graph["fixture_sha256"] == case["sha256"]
        assert graph["coverage"] == entry["coverage"]
        assert graph["coverage"] in GOLD_GRAPH_COVERAGE
        assert graph["audit_basis"] == entry["audit_basis"]
        if graph["coverage"] == "negative_exhaustive":
            assert case["expected"]["status"] == "empty"
            assert graph["items"] == []
            assert graph["edges"] == []
        else:
            assert case["expected"]["status"] in {"ready", "partial"}
            assert graph["items"]
            expected_edge_relations = case["expected"].get("edge_relations", {})
            if expected_edge_relations:
                assert graph["edges"]
            else:
                assert graph["edges"] == []


def test_reader_apparatus_manifest_committed_fixture_claims_have_proof_artifacts():
    gold_entries = {entry["fixture_id"]: entry for entry in gold_graph_fixtures()}

    for source in source_corpus():
        support_level = source["apparatus_support_level"]
        label = source["manual_verification"]
        linked_fixtures = linked_fixture_cases(source)

        if support_level == "committed_fixture_graph_verified":
            assert linked_fixtures, source["id"]
            assert all(case["expected"]["status"] == "ready" for case in linked_fixtures), source[
                "id"
            ]

            if label == "source_dom_graph_verified":
                assert all(
                    case["fixture_kind"] == "committed_full"
                    and case["fixture_format"] == "html"
                    and "independent_dom_graph" in case["expected"]
                    for case in linked_fixtures
                ), source["id"]
                continue

            if label == "source_archive_noteref_identity_verified":
                for case in linked_fixtures:
                    assert case["fixture_kind"] == "committed_full", source["id"]
                    assert case["fixture_format"] == "epub", source["id"]
                    assert case["id"] in gold_entries, source["id"]
                    graph = load_reader_apparatus_gold_graph(case["id"])
                    assert graph["coverage"] == "adapter_scope_exhaustive", source["id"]
                    assert graph["audit_basis"] == "epub_archive_xhtml_semantic_noteref", source[
                        "id"
                    ]
                    assert (
                        len(graph["edges"])
                        == case["expected"]["edge_relations"]["points_to_endnote"]
                    ), source["id"]
                continue

            raise AssertionError(source["id"])

        if support_level == "committed_fixture_negative_graph_verified":
            assert linked_fixtures, source["id"]
            assert all(case["expected"]["status"] == "empty" for case in linked_fixtures), source[
                "id"
            ]

            if label == "source_dom_negative_graph_verified":
                assert all(
                    case["fixture_kind"] == "committed_full_negative"
                    and case["fixture_format"] == "html"
                    and "independent_dom_negative_graph" in case["expected"]
                    for case in linked_fixtures
                ), source["id"]
                continue

            if label == "source_archive_noteref_absence_verified":
                for case in linked_fixtures:
                    assert case["fixture_kind"] == "committed_full_negative", source["id"]
                    assert case["fixture_format"] == "epub", source["id"]
                    assert case["id"] in gold_entries, source["id"]
                    graph = load_reader_apparatus_gold_graph(case["id"])
                    assert graph["coverage"] == "negative_exhaustive", source["id"]
                    assert graph["items"] == [], source["id"]
                    assert graph["edges"] == [], source["id"]
                continue

            raise AssertionError(source["id"])


def test_reader_apparatus_manifest_verifier_tiers_match_fixture_evidence():
    manifest = load_reader_apparatus_manifest()
    fixtures = automated_fixtures_by_id()
    tiers = verifier_tiers()

    assert manifest["verifier_tier_schema_version"] == 1
    assert set(tiers) == set(fixtures)

    for fixture_id, verifier in tiers.items():
        assert set(verifier) <= {"tier", "scope", "secondary_tiers"}, fixture_id
        assert verifier["tier"] in VERIFIER_TIERS, fixture_id
        assert verifier["scope"] in VERIFIER_SCOPES, fixture_id
        secondary_tiers = verifier.get("secondary_tiers", [])
        assert isinstance(secondary_tiers, list), fixture_id
        assert set(secondary_tiers) <= VERIFIER_TIERS, fixture_id
        assert verifier["tier"] not in secondary_tiers, fixture_id

        case = fixtures[fixture_id]
        fixture_kind = case["fixture_kind"]
        fixture_format = case["fixture_format"]
        status = case["expected"]["status"]

        if fixture_kind in {"minimal_pattern", "synthetic_archive", "synthetic_pdf_pattern"}:
            assert verifier == {"tier": "synthetic_pattern", "scope": "pattern_fixture"}, fixture_id
            continue

        if fixture_kind == "minimal_negative_pattern":
            assert verifier == {
                "tier": "synthetic_negative",
                "scope": "negative_pattern_fixture",
            }, fixture_id
            continue

        if fixture_kind == "committed_full" and fixture_format == "html":
            assert verifier["tier"] == "independent_dom", fixture_id
            assert verifier["scope"] == "fixture_graph", fixture_id
            assert "independent_dom_graph" in case["expected"], fixture_id
            continue

        if fixture_kind == "committed_full" and fixture_format == "epub":
            assert verifier["tier"] == "independent_archive", fixture_id
            assert verifier["scope"] == "fixture_graph", fixture_id
            assert verifier["secondary_tiers"] == ["current_extractor_gold_snapshot"], fixture_id
            continue

        if fixture_kind == "committed_full_negative" and fixture_format == "html":
            assert verifier["tier"] == "independent_dom_negative", fixture_id
            assert verifier["scope"] == "negative_fixture_graph", fixture_id
            assert "independent_dom_negative_graph" in case["expected"], fixture_id
            assert status == "empty", fixture_id
            continue

        if fixture_kind == "committed_full_negative" and fixture_format == "epub":
            assert verifier["tier"] == "independent_archive", fixture_id
            assert verifier["scope"] == "negative_fixture_graph", fixture_id
            assert verifier["secondary_tiers"] == ["current_extractor_gold_snapshot"], fixture_id
            assert status == "empty", fixture_id
            continue

        if fixture_kind == "committed_existing_fixture_pdf_native_link_graph_verified":
            assert verifier == {
                "tier": "independent_pdf_graph",
                "scope": "fixture_graph",
            }, fixture_id
            continue

        if fixture_kind == "committed_source_package":
            assert verifier == {
                "tier": "independent_source_package",
                "scope": "fixture_graph",
            }, fixture_id
            continue

        if fixture_kind == "committed_full_unsupported_adapter":
            assert verifier == {
                "tier": "unsupported_negative",
                "scope": "negative_fixture_graph",
            }, fixture_id
            continue

        if fixture_kind == "committed_derived_tei":
            assert verifier == {"tier": "sample_hand_gold", "scope": "partial_sample"}, fixture_id
            assert status == "partial", fixture_id
            continue

        raise AssertionError(fixture_id)


def test_reader_apparatus_manifest_assigns_every_fixture_to_a_real_media_contract():
    manifest = load_reader_apparatus_manifest()
    contracts = real_media_fixture_contracts()
    fixture_ids = {case["id"] for case in automated_fixture_cases()}

    assert manifest["real_media_contract_schema_version"] == 1
    assert set(contracts) == fixture_ids

    for case in automated_fixture_cases():
        contract = contracts[case["id"]]
        assert contract["contract"] in REAL_MEDIA_FIXTURE_CONTRACTS, case["id"]
        assert contract["test_selector"].startswith("tests/"), case["id"]
        if contract["contract"] in {
            "source_package_unit_contract",
            "source_package_unit_and_remote_pdf_api_contract",
        }:
            assert case["fixture_format"] == "arxiv_source", case["id"]
            assert contract["reason"], case["id"]
            if contract["contract"] == "source_package_unit_and_remote_pdf_api_contract":
                assert contract["api_test_selector"].startswith("tests/"), case["id"]
            continue
        if contract["contract"] == "tei_unit_contract":
            assert case["fixture_format"] == "tei", case["id"]
            assert case["fixture_kind"] == "committed_derived_tei", case["id"]
            assert contract["reason"], case["id"]
            continue
        assert case["fixture_format"] in {"html", "epub", "pdf"}, case["id"]
        assert "reason" not in contract, case["id"]


def test_reader_apparatus_manifest_tracks_generic_url_source_html_contract():
    manifest = load_reader_apparatus_manifest()
    contract = manifest["web_article_generic_url_contract"]
    fixture_ids = [
        case["id"] for case in fixture_cases_by_real_media_contract("web_article_capture_api")
    ]
    selector = contract["test_selector"]
    path_text, separator, selector_tail = selector.partition("::")
    test_name = selector_tail.split("::")[-1]
    python_root = Path(__file__).parents[1]

    assert contract["schema_version"] == 1
    assert contract["contract"] == "web_article_generic_url_source_html_api"
    assert contract["fixture_contract_source"] == "web_article_capture_api"
    assert contract["apparatus_source"] == "fetched_source_html"
    assert contract["reader_fragment_source"] == "readability_content_html"
    assert contract["fixture_ids"] == fixture_ids
    assert separator
    assert (python_root / path_text).exists()
    assert f"def {test_name}(" in (python_root / path_text).read_text(encoding="utf-8")


def test_reader_apparatus_manifest_contract_selectors_resolve_to_tests():
    python_root = Path(__file__).parents[1]

    for fixture_id, contract in real_media_fixture_contracts().items():
        _assert_test_selector_resolves(python_root, fixture_id, contract["test_selector"])
        if "api_test_selector" in contract:
            _assert_test_selector_resolves(python_root, fixture_id, contract["api_test_selector"])


def _assert_test_selector_resolves(python_root: Path, fixture_id: str, selector: str) -> None:
    parts = selector.split("::")
    assert len(parts) >= 2, fixture_id
    path = python_root / parts[0]
    assert path.exists(), fixture_id
    test_source = path.read_text(encoding="utf-8")
    if len(parts) > 2:
        assert f"class {parts[-2]}" in test_source, fixture_id
    assert f"def {parts[-1]}(" in test_source, fixture_id


def test_reader_apparatus_manifest_tracks_scoped_pdf_support_without_generic_pdf_claims():
    pdf_sources = [source for source in source_corpus() if source["media_kind"] == "pdf"]

    assert pdf_sources
    assert all(
        "pdf_adapter_missing" in source["fixture_policy"]
        or "url_only" in source["fixture_policy"]
        or "native_link_graph_verified" in source["fixture_policy"]
        or source["fixture_policy"] == "committed_source_package_fixture"
        or source["fixture_policy"] == "committed_full_unsupported_pdf_adapter"
        or source["fixture_policy"] == "minimal_pdf_pattern_fixture"
        for source in pdf_sources
    )
    attention_source = next(
        source for source in pdf_sources if source["id"] == "source-arxiv-attention"
    )
    assert (
        attention_source["fixture_policy"]
        == "committed_existing_fixture_pdf_native_link_graph_verified"
    )
    assert attention_source["manual_verification"] == (
        "pdf_native_link_graph_verified_not_generic_pdf_extraction"
    )
    assert attention_source["apparatus_support_level"] == "pdf_native_link_graph_verified"
    assert "no generic PDF text" in attention_source["current_contract"]
    assert "law-review extraction claimed" in attention_source["current_contract"]

    attention = next(
        case
        for case in automated_fixture_cases()
        if case["id"] == "pdf-attention-native-link-graph"
    )
    assert attention["fixture_kind"] == "committed_existing_fixture_pdf_native_link_graph_verified"
    assert attention["expected"]["status"] == "ready"
    assert attention["expected"]["item_kinds"] == {
        "bibliography_ref": 76,
        "bibliography_entry": 40,
    }
    assert attention["expected"]["item_confidences"] == {"exact": 116}
    assert attention["expected"]["item_methods"] == {
        "pdf_native_link": 76,
        "pdf_native_link_target": 40,
    }
    assert attention["expected"]["edge_relations"] == {"cites_bibliography_entry": 76}
    assert attention["expected"]["edge_confidences"] == {"exact": 76}
    assert attention["expected"]["edge_methods"] == {"pdf_native_link_target": 76}
    assert attention["expected"]["pdf_link_counts"] == {
        "internal": 95,
        "named_cite": 76,
        "total": 113,
        "unique_named_cite_destinations": 40,
    }
    assert attention["expected"]["diagnostics"]["pdf_native_link"] == {
        "status": "targets_materialized",
        "marker_count": 76,
        "target_count": 40,
        "edge_count": 76,
        "unresolved_marker_count": 0,
    }
    arxiv_source = next(
        source for source in pdf_sources if source["id"] == "source-arxiv-2606-01109"
    )
    assert arxiv_source["fixture_policy"] == "committed_source_package_fixture"
    assert arxiv_source["manual_verification"] == "source_package_latex_biblatex_graph_verified"
    assert arxiv_source["apparatus_support_level"] == "source_package_verified"
    assert "no PDF geometry claim" in arxiv_source["current_contract"]

    arxiv_fixture = next(
        case for case in automated_fixture_cases() if case["id"] == "arxiv-2606-source-package"
    )
    assert arxiv_fixture["fixture_format"] == "arxiv_source"
    assert arxiv_fixture["fixture_kind"] == "committed_source_package"
    assert arxiv_fixture["expected"]["latex_biblatex"] == {
        "status": "ready",
        "citation_marker_count": 15,
        "citation_edge_count": 20,
        "cited_bibliography_entry_count": 17,
        "bib_entry_count": 22,
        "uncited_bib_entry_count": 5,
        "footnote_count": 1,
        "missing_citation_keys": [],
    }

    philpapers_source = next(
        source for source in pdf_sources if source["id"] == "source-philpapers-lop-aiz"
    )
    assert philpapers_source["fixture_policy"] == "committed_full_unsupported_pdf_adapter"
    assert philpapers_source["manual_verification"] == (
        "full_source_fixture_no_supported_pdf_adapter_negative_verified"
    )
    assert philpapers_source["apparatus_support_level"] == "full_source_unsupported_adapter"
    assert philpapers_source["fixture_ids"] == ["pdf-philpapers-lop-aiz-unsupported"]
    assert philpapers_source["derived_fixture_ids"] == ["tei-philpapers-lop-aiz-grobid-0-8-2"]
    assert (
        "derived GROBID TEI fixture verifies partial probable bibliography extraction"
        in (philpapers_source["current_contract"])
    )
    assert "gold graph" in philpapers_source["current_contract"]
    assert "citation completeness" in philpapers_source["current_contract"]

    philpapers_fixture = next(
        case
        for case in automated_fixture_cases()
        if case["id"] == "pdf-philpapers-lop-aiz-unsupported"
    )
    assert philpapers_fixture["fixture_format"] == "pdf"
    assert philpapers_fixture["fixture_kind"] == "committed_full_unsupported_adapter"
    assert philpapers_fixture["expected"]["status"] == "empty"
    assert philpapers_fixture["expected"]["item_kinds"] == {}
    assert philpapers_fixture["expected"]["edge_relations"] == {}
    assert philpapers_fixture["expected"]["pdf_unsupported_scholarly"] == {
        "status": "unsupported_adapter_no_apparatus",
        "page_count": 22,
        "endnote_count": 18,
        "has_references_section": True,
        "link_counts": {
            "total": 21,
            "internal": 0,
            "external_uri": 21,
            "named_cite": 0,
        },
        "diagnostics": {
            "pdf_native_link": {
                "status": "no_supported_citation_links",
                "marker_count": 0,
                "target_count": 0,
                "edge_count": 0,
                "unresolved_marker_count": 0,
                "total_link_count": 21,
                "internal_link_count": 0,
                "citation_link_count": 0,
                "skipped": {
                    "non_citation_destination": 21,
                },
            },
            "pdf_legal_footnotes": {
                "status": "no_supported_legal_footnotes",
                "adapter_version": "pdf_legal_footnotes_v1",
                "page_count": 22,
                "marker_count": 0,
                "target_count": 0,
                "edge_count": 0,
                "unresolved_marker_count": 0,
                "unpaired_target_count": 0,
                "skipped": {},
            },
        },
    }
    philpapers_tei_fixture = next(
        case
        for case in automated_fixture_cases()
        if case["id"] == "tei-philpapers-lop-aiz-grobid-0-8-2"
    )
    assert philpapers_tei_fixture["fixture_format"] == "tei"
    assert philpapers_tei_fixture["fixture_kind"] == "committed_derived_tei"
    assert philpapers_tei_fixture["source_ids"] == ["source-philpapers-lop-aiz"]
    assert philpapers_tei_fixture["expected"]["status"] == "partial"
    assert philpapers_tei_fixture["expected"]["grobid_tei_scholarly"] == {
        "status": "partial",
        "adapter_version": "grobid_tei_scholarly_v1",
        "tei_sha256": "41f8b00d794bd5e93d291d4a8a44beee31285aa29978b4474761645e3966b698",
        "bibliography_entry_count": 92,
        "bibliography_ref_count": 158,
        "resolved_bibliography_ref_count": 147,
        "author_year_resolved_bibliography_ref_count": 34,
        "unresolved_bibliography_ref_count": 7,
        "ambiguous_author_year_ref_count": 1,
        "suppressed_fragment_ref_count": 4,
        "suppressed_fragment_edge_count": 5,
        "unique_resolved_target_count": 76,
        "skipped": {
            "bibliography_ref_suspicious_direct_target": 2,
            "bibliography_ref_fragment_author_year_match_suppressed": 2,
        },
    }

    harvard_source = next(
        source for source in pdf_sources if source["id"] == "source-harvard-zittrain"
    )
    assert harvard_source["fixture_policy"] == "minimal_pdf_pattern_fixture"
    assert harvard_source["manual_verification"] == (
        "synthetic_law_review_pdf_footnote_pattern_verified"
    )
    assert harvard_source["apparatus_support_level"] == "pattern_verified"
    assert harvard_source["license_provenance"]["source_title"].startswith("PERMA:")
    assert "raw Harvard PDF remains uncommitted" in harvard_source["current_contract"]

    law_review = next(
        case for case in automated_fixture_cases() if case["id"] == "pdf-law-review-footnotes"
    )
    assert law_review["fixture_format"] == "pdf"
    assert law_review["fixture_kind"] == "synthetic_pdf_pattern"
    assert law_review["expected"]["item_kinds"] == {
        "footnote": 10,
        "footnote_ref": 10,
    }
    assert law_review["expected"]["edge_relations"] == {"points_to_note": 10}
    assert law_review["expected"]["pdf_legal_footnotes"] == {
        "status": "targets_materialized",
        "adapter_version": "pdf_legal_footnotes_v1",
        "page_count": 1,
        "marker_count": 10,
        "target_count": 10,
        "edge_count": 10,
        "unresolved_marker_count": 0,
        "unpaired_target_count": 0,
        "skipped": {},
    }

    commons_source = next(
        source for source in pdf_sources if source["id"] == "source-commons-waste-land-pdf"
    )
    assert commons_source["fixture_policy"] == "committed_full_unsupported_pdf_adapter"
    assert commons_source["manual_verification"] == "pdf_literary_unsupported_adapter_verified"
    assert commons_source["apparatus_support_level"] == "full_source_unsupported_adapter"
    assert "no encoded PDF note graph" in commons_source["current_contract"]

    commons_fixture = next(
        case
        for case in automated_fixture_cases()
        if case["id"] == "pdf-commons-waste-land-negative"
    )
    assert commons_fixture["fixture_format"] == "pdf"
    assert commons_fixture["fixture_kind"] == "committed_full_unsupported_adapter"
    assert commons_fixture["expected"]["status"] == "empty"
    assert commons_fixture["expected"]["pdf_unsupported_literary"] == {
        "status": "unsupported_adapter_no_apparatus",
        "page_count": 72,
        "has_printed_notes": True,
        "link_counts": {
            "total": 0,
            "internal": 0,
            "external_uri": 0,
            "named_cite": 0,
        },
        "diagnostics": {
            "pdf_native_link": {
                "status": "no_supported_citation_links",
                "marker_count": 0,
                "target_count": 0,
                "edge_count": 0,
                "unresolved_marker_count": 0,
                "total_link_count": 0,
                "internal_link_count": 0,
                "citation_link_count": 0,
                "skipped": {},
            },
            "pdf_legal_footnotes": {
                "status": "no_supported_legal_footnotes",
                "adapter_version": "pdf_legal_footnotes_v1",
                "page_count": 72,
                "marker_count": 0,
                "target_count": 0,
                "edge_count": 0,
                "unresolved_marker_count": 0,
                "unpaired_target_count": 0,
                "skipped": {},
            },
        },
    }


def test_reader_apparatus_manifest_marks_committed_epub_noterefs_as_archive_verified():
    epub_sources = {
        source["id"]: source for source in source_corpus() if source["media_kind"] == "epub"
    }

    for source_id in {
        "source-standardebooks-eliot-poetry",
        "source-standardebooks-eliot-poetry-advanced",
        "source-standardebooks-james-pragmatism",
        "source-standardebooks-james-pragmatism-advanced",
    }:
        source = epub_sources[source_id]
        assert source["manual_verification"] == "source_archive_noteref_identity_verified"
        assert "all " in source["current_contract"]
        assert "source-archive noteref identities" in source["current_contract"]

    waste_land = epub_sources["source-gutenberg-waste-land-epub"]
    assert waste_land["manual_verification"] == "source_archive_noteref_absence_verified"
    assert (
        "independent archive scan finds zero authored noteref links"
        in waste_land["current_contract"]
    )


def test_reader_apparatus_manifest_tracks_html_out_of_scope_reference_layers():
    sources = {source["id"]: source for source in source_corpus()}
    fixtures = automated_fixtures_by_id()

    distill_uncited_expectations = {
        "html-distill-misread-tsne-full": [],
        "html-distill-gp-full": ["McHutchon2011"],
        "html-distill-growing-ca-full": [
            "CANEAT2018",
            "Elmenreich2011EvolvingSC",
            "Morphogenesis1993",
            "NeuralODE",
        ],
        "html-distill-research-debt-full": [],
    }
    for fixture_id, uncited_keys in distill_uncited_expectations.items():
        graph = fixtures[fixture_id]["expected"]["independent_dom_graph"]
        assert graph["uncited_bibliography_entry_count"] == len(uncited_keys), fixture_id
        assert graph["uncited_bibliography_keys"] == uncited_keys, fixture_id
        assert graph["script_bibliography_entry_count"] >= graph["cited_target_count"], fixture_id
        if uncited_keys:
            assert (
                "script-only uncited bibliography record"
                in sources[fixtures[fixture_id]["source_ids"][0]]["current_contract"]
            ), fixture_id

    wikipedia_source = sources["source-wikipedia-waste-land"]
    wikipedia = fixtures["html-wikipedia-waste-land-full"]
    graph = wikipedia["expected"]["independent_dom_graph"]
    assert "nested CITEREF works-cited links" in wikipedia_source["current_contract"]
    assert wikipedia["expected"]["item_kinds"] == {
        "footnote": 198,
        "footnote_ref": 240,
        "bibliography_entry": 77,
        "bibliography_ref": 199,
    }
    assert wikipedia["expected"]["edge_relations"] == {
        "points_to_note": 240,
        "cites_bibliography_entry": 199,
    }
    assert graph["nested_cited_work_link_count"] == 199
    assert graph["nested_cited_work_target_count"] == 71
    assert graph["nested_cited_work_resolved_target_count"] == 71
    assert graph["nested_cited_work_unresolved_target_count"] == 0
    assert graph["cited_work_entry_count"] == 77
    assert graph["unreferenced_cited_work_entry_count"] == 6


def test_reader_apparatus_manifest_has_structured_license_provenance():
    manifest = load_reader_apparatus_manifest()

    assert manifest["provenance_schema_version"] == 1
    assert manifest["source_fixture_eligibility_schema_version"] == 1

    for source in source_corpus():
        assert source["apparatus_support_level"] in APPARATUS_SUPPORT_LEVELS, source["id"]

        eligibility = source.get("raw_source_fixture_eligibility")
        assert isinstance(eligibility, dict), source["id"]
        assert RAW_SOURCE_FIXTURE_ELIGIBILITY_KEYS <= set(eligibility), source["id"]
        assert eligibility["status"] in RAW_SOURCE_FIXTURE_ELIGIBILITY_STATUSES, source["id"]
        assert isinstance(eligibility["can_commit_raw_source"], bool), source["id"]
        assert eligibility["commit_scope"] in RAW_SOURCE_COMMIT_SCOPES, source["id"]
        assert isinstance(eligibility["evidence_url"], str) and eligibility["evidence_url"], source[
            "id"
        ]
        assert eligibility["license_name"] is None or isinstance(
            eligibility["license_name"], str
        ), source["id"]
        assert eligibility["license_url"] is None or isinstance(eligibility["license_url"], str), (
            source["id"]
        )
        assert eligibility["attribution_required"] is None or isinstance(
            eligibility["attribution_required"], bool
        ), source["id"]
        assert isinstance(eligibility["share_alike_required"], bool), source["id"]
        assert isinstance(eligibility["asset_review_required"], bool), source["id"]
        assert isinstance(eligibility["notes"], str) and eligibility["notes"], source["id"]
        assert DATE_RE.match(eligibility["checked_at"]), source["id"]

        provenance = source.get("license_provenance")
        assert isinstance(provenance, dict), source["id"]
        assert SOURCE_PROVENANCE_KEYS <= set(provenance), source["id"]
        assert provenance["status"] in SOURCE_PROVENANCE_STATUSES, source["id"]
        assert isinstance(provenance["publisher"], str) and provenance["publisher"], source["id"]
        assert isinstance(provenance["evidence_url"], str) and provenance["evidence_url"], source[
            "id"
        ]
        assert isinstance(provenance["raw_source_commit_allowed"], bool), source["id"]
        assert (
            isinstance(provenance["raw_source_policy"], str) and provenance["raw_source_policy"]
        ), source["id"]
        assert DATE_RE.match(provenance["checked_at"]), source["id"]

    for case in automated_fixture_cases():
        provenance = case.get("license_provenance")
        assert isinstance(provenance, dict), case["id"]
        assert FIXTURE_PROVENANCE_KEYS <= set(provenance), case["id"]
        assert provenance["status"] in FIXTURE_PROVENANCE_STATUSES, case["id"]
        assert isinstance(provenance["publisher"], str) and provenance["publisher"], case["id"]
        assert isinstance(provenance["evidence_url"], str) and provenance["evidence_url"], case[
            "id"
        ]
        assert isinstance(provenance["fixture_commit_allowed"], bool), case["id"]
        assert (
            isinstance(provenance["fixture_commit_policy"], str)
            and provenance["fixture_commit_policy"]
        ), case["id"]
        assert isinstance(provenance["source_text_copied"], bool), case["id"]
        assert DATE_RE.match(provenance["checked_at"]), case["id"]


def test_reader_apparatus_manifest_separates_raw_source_eligibility_from_support_level():
    for source in source_corpus():
        support_level = source["apparatus_support_level"]
        eligibility = source["raw_source_fixture_eligibility"]
        provenance = source["license_provenance"]
        linked_fixtures = linked_fixture_cases(source)

        assert support_level == APPARATUS_SUPPORT_BY_FIXTURE_POLICY[source["fixture_policy"]], (
            source["id"]
        )

        if eligibility["can_commit_raw_source"]:
            assert eligibility["status"] in {
                "eligible",
                "eligible_text_only_with_conditions",
                "eligible_with_conditions",
            }, source["id"]
            assert eligibility["commit_scope"] not in {
                "legacy_existing_fixture_only",
                "none",
            }, source["id"]
            assert eligibility["license_name"], source["id"]
            assert eligibility["license_url"], source["id"]
        else:
            assert eligibility["status"] in {
                "legacy_existing_only",
                "not_eligible_or_unverified",
            }, source["id"]
            assert eligibility["commit_scope"] in {
                "legacy_existing_fixture_only",
                "none",
            }, source["id"]

        if support_level in COMMITTED_FIXTURE_GRAPH_SUPPORT_LEVELS:
            assert eligibility["can_commit_raw_source"] is True, source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert linked_fixtures, source["id"]
            if support_level == "committed_fixture_graph_verified":
                assert all(case["fixture_kind"] == "committed_full" for case in linked_fixtures)
            else:
                assert all(
                    case["fixture_kind"] == "committed_full_negative" for case in linked_fixtures
                )
            assert all(case["license_provenance"]["source_text_copied"] for case in linked_fixtures)
            continue

        if support_level in SOURCE_PACKAGE_SUPPORT_LEVELS:
            assert eligibility["can_commit_raw_source"] is True, source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert provenance["status"] == "verified_redistributable", source["id"]
            assert linked_fixtures, source["id"]
            assert all(
                case["fixture_kind"] == "committed_source_package" for case in linked_fixtures
            )
            assert all(case["license_provenance"]["source_text_copied"] for case in linked_fixtures)
            assert not OVERCLAIM_RE.search(source["current_contract"]), source["id"]
            continue

        if support_level in UNSUPPORTED_COMMITTED_FIXTURE_SUPPORT_LEVELS:
            assert eligibility["can_commit_raw_source"] is True, source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert provenance["status"] == "verified_redistributable", source["id"]
            assert linked_fixtures, source["id"]
            assert all(
                case["fixture_kind"] == "committed_full_unsupported_adapter"
                for case in linked_fixtures
            )
            assert all(case["license_provenance"]["source_text_copied"] for case in linked_fixtures)
            assert not OVERCLAIM_RE.search(source["current_contract"]), source["id"]
            continue

        assert provenance["raw_source_commit_allowed"] is False, source["id"]
        assert support_level not in COMMITTED_FIXTURE_GRAPH_SUPPORT_LEVELS, source["id"]
        assert not OVERCLAIM_RE.search(source["current_contract"]), source["id"]

        if support_level == "url_only":
            assert source["fixture_ids"] == [], source["id"]
            continue

        if support_level in PATTERN_SUPPORT_LEVELS:
            assert linked_fixtures, source["id"]
            assert all(case["fixture_kind"] in PATTERN_FIXTURE_KINDS for case in linked_fixtures), (
                source["id"]
            )
            assert all(
                not case["license_provenance"]["source_text_copied"] for case in linked_fixtures
            ), source["id"]
            continue

        if support_level == "partial_marker_only":
            assert linked_fixtures, source["id"]
            assert all(case["expected"]["status"] == "partial" for case in linked_fixtures)
            continue

        assert support_level == "pdf_native_link_graph_verified", source["id"]
        assert source["id"] == "source-arxiv-attention"
        assert len(linked_fixtures) == 1
        graph_fixture = linked_fixtures[0]
        assert (
            graph_fixture["fixture_kind"]
            == "committed_existing_fixture_pdf_native_link_graph_verified"
        )
        assert graph_fixture["expected"]["status"] == "ready"
        assert graph_fixture["expected"]["item_kinds"] == {
            "bibliography_ref": 76,
            "bibliography_entry": 40,
        }
        assert graph_fixture["expected"]["edge_relations"] == {"cites_bibliography_entry": 76}
        assert graph_fixture["expected"]["diagnostics"]["pdf_native_link"]["status"] == (
            "targets_materialized"
        )


def test_reader_apparatus_manifest_reports_current_support_distribution():
    assert support_counts() == {
        "full_source_unsupported_adapter": 2,
        "committed_fixture_graph_verified": 13,
        "committed_fixture_negative_graph_verified": 2,
        "negative_pattern_verified": 0,
        "partial_marker_only": 0,
        "pdf_native_link_graph_verified": 1,
        "pattern_verified": 1,
        "shared_pattern_verified": 0,
        "source_package_verified": 1,
        "url_only": 0,
    }


def test_reader_apparatus_manifest_rejects_retired_overclaim_status_labels():
    fixture_contract_text = "\n".join(
        [
            (FIXTURES_ROOT / "reader_apparatus" / "corpus_manifest.json").read_text(
                encoding="utf-8"
            ),
            (FIXTURES_ROOT / "reader_apparatus" / "README.md").read_text(encoding="utf-8"),
        ]
    )

    for retired_label in RETIRED_OVERCLAIM_STATUS_LABELS:
        assert retired_label not in fixture_contract_text


def test_reader_apparatus_manifest_overclaim_guard_catches_counted_all_language():
    assert OVERCLAIM_RE.search("all citations")
    assert OVERCLAIM_RE.search("all 240 MediaWiki reference markers")
    assert OVERCLAIM_RE.search("all 53 source-archive noteref identities")
    assert OVERCLAIM_RE.search("all 40 standalone source-authored margin notes")
    assert not OVERCLAIM_RE.search("76 exact bibliography_ref markers")
    assert not OVERCLAIM_RE.search("no citation-completeness claim exists")


def test_reader_apparatus_manifest_overclaim_language_requires_structured_evidence():
    for source in source_corpus():
        if not OVERCLAIM_RE.search(source["current_contract"]):
            continue

        assert source["apparatus_support_level"] in COMMITTED_FIXTURE_GRAPH_SUPPORT_LEVELS, source[
            "id"
        ]
        linked_fixtures = linked_fixture_cases(source)
        assert linked_fixtures, source["id"]

        if source["manual_verification"] == "source_dom_graph_verified":
            assert all(
                case["fixture_kind"] == "committed_full"
                and "independent_dom_graph" in case["expected"]
                for case in linked_fixtures
            ), source["id"]
            continue

        if source["manual_verification"] == "source_archive_noteref_identity_verified":
            assert all(
                case["fixture_kind"] == "committed_full"
                and case["fixture_format"] == "epub"
                and set(case["expected"]["edge_methods"]) == {"epub_noteref"}
                and set(case["expected"]["edge_relations"]) == {"points_to_endnote"}
                for case in linked_fixtures
            ), source["id"]
            continue

        raise AssertionError(source["id"])


def test_reader_apparatus_manifest_manual_verification_labels_match_evidence_shape():
    fixtures = automated_fixtures_by_id()

    for source in source_corpus():
        label = source["manual_verification"]
        linked_fixtures = linked_fixture_cases(source)
        derived_fixtures = [
            fixtures[fixture_id] for fixture_id in source.get("derived_fixture_ids", [])
        ]

        assert label in MANUAL_VERIFICATION_CONTRACTS, source["id"]

        if label == "source_dom_graph_verified":
            assert source["apparatus_support_level"] == "committed_fixture_graph_verified", source[
                "id"
            ]
            assert derived_fixtures == [], source["id"]
            assert all(
                case["fixture_kind"] == "committed_full"
                and case["fixture_format"] == "html"
                and case["expected"]["status"] == "ready"
                and "independent_dom_graph" in case["expected"]
                for case in linked_fixtures
            ), source["id"]
            continue

        if label == "source_dom_negative_graph_verified":
            assert (
                source["apparatus_support_level"] == "committed_fixture_negative_graph_verified"
            ), source["id"]
            assert derived_fixtures == [], source["id"]
            assert all(
                case["fixture_kind"] == "committed_full_negative"
                and case["fixture_format"] == "html"
                and case["expected"]["status"] == "empty"
                and "independent_dom_negative_graph" in case["expected"]
                for case in linked_fixtures
            ), source["id"]
            continue

        if label == "source_archive_noteref_identity_verified":
            assert source["apparatus_support_level"] == "committed_fixture_graph_verified", source[
                "id"
            ]
            assert derived_fixtures == [], source["id"]
            assert all(
                case["fixture_kind"] == "committed_full"
                and case["fixture_format"] == "epub"
                and case["expected"]["status"] == "ready"
                and case["expected"]["item_kinds"].get("endnote_ref", 0) > 0
                and case["expected"]["item_kinds"].get("endnote", 0) > 0
                and case["expected"]["edge_relations"]
                == {"points_to_endnote": (case["expected"]["item_kinds"]["endnote_ref"])}
                and case["expected"]["edge_methods"]
                == {"epub_noteref": (case["expected"]["item_kinds"]["endnote_ref"])}
                for case in linked_fixtures
            ), source["id"]
            continue

        if label == "source_archive_noteref_absence_verified":
            assert (
                source["apparatus_support_level"] == "committed_fixture_negative_graph_verified"
            ), source["id"]
            assert derived_fixtures == [], source["id"]
            assert all(
                case["fixture_kind"] == "committed_full_negative"
                and case["fixture_format"] == "epub"
                and case["expected"]["status"] == "empty"
                and case["expected"]["item_kinds"] == {}
                and case["expected"]["edge_relations"] == {}
                for case in linked_fixtures
            ), source["id"]
            continue

        if label == "pdf_native_link_graph_verified_not_generic_pdf_extraction":
            assert source["apparatus_support_level"] == "pdf_native_link_graph_verified", source[
                "id"
            ]
            assert derived_fixtures == [], source["id"]
            assert len(linked_fixtures) == 1, source["id"]
            case = linked_fixtures[0]
            assert (
                case["fixture_kind"] == "committed_existing_fixture_pdf_native_link_graph_verified"
            )
            assert case["fixture_format"] == "pdf"
            assert case["expected"]["diagnostics"]["pdf_native_link"]["status"] == (
                "targets_materialized"
            )
            assert case["expected"]["pdf_link_counts"]["named_cite"] > 0
            continue

        if label == "source_package_latex_biblatex_graph_verified":
            assert source["apparatus_support_level"] == "source_package_verified", source["id"]
            assert derived_fixtures == [], source["id"]
            assert len(linked_fixtures) == 1, source["id"]
            case = linked_fixtures[0]
            assert case["fixture_kind"] == "committed_source_package"
            assert case["fixture_format"] == "arxiv_source"
            assert case["expected"]["latex_biblatex"]["status"] == "ready"
            assert case["expected"]["latex_biblatex"]["citation_marker_count"] > 0
            assert "no PDF geometry claim" in source["current_contract"]
            continue

        if label == "pdf_literary_unsupported_adapter_verified":
            assert source["apparatus_support_level"] == "full_source_unsupported_adapter", source[
                "id"
            ]
            assert derived_fixtures == [], source["id"]
            assert len(linked_fixtures) == 1, source["id"]
            case = linked_fixtures[0]
            assert case["fixture_kind"] == "committed_full_unsupported_adapter"
            assert case["fixture_format"] == "pdf"
            assert case["expected"]["status"] == "empty"
            assert "pdf_unsupported_literary" in case["expected"]
            assert "no encoded PDF note graph" in source["current_contract"]
            continue

        if label == "full_source_fixture_no_supported_pdf_adapter_negative_verified":
            assert source["apparatus_support_level"] == "full_source_unsupported_adapter", source[
                "id"
            ]
            assert len(linked_fixtures) == 1, source["id"]
            assert len(derived_fixtures) == 1, source["id"]
            pdf_case = linked_fixtures[0]
            tei_case = derived_fixtures[0]
            assert pdf_case["fixture_kind"] == "committed_full_unsupported_adapter"
            assert pdf_case["fixture_format"] == "pdf"
            assert "pdf_unsupported_scholarly" in pdf_case["expected"]
            assert tei_case["fixture_kind"] == "committed_derived_tei"
            assert tei_case["fixture_format"] == "tei"
            assert tei_case["expected"]["grobid_tei_scholarly"]["status"] == "partial"
            assert "no hand-audited gold graph" in source["current_contract"]
            continue

        assert label == "synthetic_law_review_pdf_footnote_pattern_verified", source["id"]
        assert source["apparatus_support_level"] == "pattern_verified", source["id"]
        assert derived_fixtures == [], source["id"]
        assert len(linked_fixtures) == 1, source["id"]
        case = linked_fixtures[0]
        assert case["fixture_kind"] == "synthetic_pdf_pattern"
        assert case["fixture_format"] == "pdf"
        assert case["expected"]["pdf_legal_footnotes"]["status"] == "targets_materialized"
        assert "raw Harvard PDF remains uncommitted" in source["current_contract"]


def test_reader_apparatus_manifest_enforces_raw_fixture_policy():
    for source in source_corpus():
        provenance = source["license_provenance"]
        linked_fixtures = linked_fixture_cases(source)

        if source["fixture_policy"] in COMMITTED_RAW_SOURCE_FIXTURE_POLICIES:
            assert provenance["status"] == "verified_redistributable", source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert provenance["license_name"], source["id"]
            assert provenance["license_url"], source["id"]
            assert linked_fixtures, source["id"]
            assert all(case["fixture_kind"] in RAW_FIXTURE_KINDS for case in linked_fixtures)
            continue

        if source["fixture_policy"] == "committed_source_package_fixture":
            assert provenance["status"] == "verified_redistributable", source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert provenance["license_name"], source["id"]
            assert provenance["license_url"], source["id"]
            assert linked_fixtures, source["id"]
            assert all(
                case["fixture_kind"] == "committed_source_package" for case in linked_fixtures
            )
            continue

        if source["fixture_policy"] == "committed_full_unsupported_pdf_adapter":
            assert provenance["status"] == "verified_redistributable", source["id"]
            assert provenance["raw_source_commit_allowed"] is True, source["id"]
            assert provenance["license_name"], source["id"]
            assert provenance["license_url"], source["id"]
            assert linked_fixtures, source["id"]
            assert all(
                case["fixture_kind"] == "committed_full_unsupported_adapter"
                for case in linked_fixtures
            )
            assert linked_fixtures[0]["expected"]["status"] == "empty"
            continue

        assert provenance["raw_source_commit_allowed"] is False, source["id"]

        if source["fixture_policy"].startswith("url_only"):
            assert source["fixture_ids"] == [], source["id"]
            assert provenance["status"] in URL_ONLY_STATUSES, source["id"]
            continue

        if source["fixture_policy"] in PATTERN_SOURCE_POLICIES:
            assert provenance["status"] == "pattern_fixture_only_not_raw_source", source["id"]
            assert linked_fixtures, source["id"]
            assert all(case["fixture_kind"] in PATTERN_FIXTURE_KINDS for case in linked_fixtures), (
                source["id"]
            )
            continue

        assert source["fixture_policy"] in {
            "committed_existing_fixture_native_link_partial",
            "committed_existing_fixture_pdf_native_link_graph_verified",
        }, source["id"]
        assert source["id"] == "source-arxiv-attention"
        assert provenance["status"] == "legacy_existing_needs_revalidation"
        assert len(linked_fixtures) == 1
        assert linked_fixtures[0]["fixture_kind"] in {
            "committed_existing_fixture_native_link_partial",
            "committed_existing_fixture_pdf_native_link_graph_verified",
        }

    for case in automated_fixture_cases():
        provenance = case["license_provenance"]

        if case["fixture_kind"] in {"committed_full", "committed_full_negative"}:
            assert provenance["status"] == "verified_redistributable", case["id"]
            assert provenance["fixture_commit_allowed"] is True, case["id"]
            assert provenance["source_text_copied"] is True, case["id"]
            assert provenance["license_name"], case["id"]
            assert provenance["license_url"], case["id"]
            assert case["source_ids"], case["id"]
            continue

        if case["fixture_kind"] == "committed_source_package":
            assert case["id"] == "arxiv-2606-source-package"
            assert provenance["status"] == "verified_redistributable", case["id"]
            assert provenance["fixture_commit_allowed"] is True, case["id"]
            assert provenance["source_text_copied"] is True, case["id"]
            assert case["expected"]["status"] == "ready", case["id"]
            assert case["expected"]["edge_relations"] == {"cites_bibliography_entry": 20}, case[
                "id"
            ]
            continue

        if case["fixture_kind"] == "committed_full_unsupported_adapter":
            assert provenance["status"] == "verified_redistributable", case["id"]
            assert provenance["fixture_commit_allowed"] is True, case["id"]
            assert provenance["source_text_copied"] is True, case["id"]
            assert case["expected"]["status"] == "empty", case["id"]
            assert case["expected"]["edge_relations"] == {}, case["id"]
            unsupported_expectations = [
                value
                for key, value in case["expected"].items()
                if key.startswith("pdf_unsupported_")
            ]
            assert len(unsupported_expectations) == 1, case["id"]
            assert unsupported_expectations[0]["status"] == "unsupported_adapter_no_apparatus"
            continue

        if case["fixture_kind"] == "committed_derived_tei":
            assert case["id"] == "tei-philpapers-lop-aiz-grobid-0-8-2"
            assert case["fixture_kind"] in DERIVED_FIXTURE_KINDS
            assert case["fixture_format"] == "tei"
            assert case["source_ids"] == ["source-philpapers-lop-aiz"]
            assert provenance["status"] == "verified_redistributable", case["id"]
            assert provenance["fixture_commit_allowed"] is True, case["id"]
            assert provenance["source_text_copied"] is True, case["id"]
            assert case["expected"]["status"] == "partial", case["id"]
            assert case["expected"]["grobid_tei_scholarly"]["status"] == "partial"
            assert case["expected"]["grobid_tei_scholarly"]["unresolved_bibliography_ref_count"] > 0
            continue

        if case["fixture_kind"] in {
            "committed_existing_fixture_native_link_partial",
            "committed_existing_fixture_pdf_native_link_graph_verified",
        }:
            assert case["id"] == "pdf-attention-native-link-graph"
            assert provenance["status"] == "legacy_existing_needs_revalidation", case["id"]
            assert provenance["fixture_commit_allowed"] is False, case["id"]
            assert provenance["source_text_copied"] is True, case["id"]
            assert case["expected"]["status"] == "ready", case["id"]
            assert case["expected"]["edge_relations"] == {"cites_bibliography_entry": 76}, case[
                "id"
            ]
            continue

        assert case["fixture_kind"] in PATTERN_FIXTURE_KINDS, case["id"]
        assert provenance["status"] == "synthetic_test_fixture", case["id"]
        assert provenance["fixture_commit_allowed"] is True, case["id"]
        assert provenance["source_text_copied"] is False, case["id"]


def test_reader_apparatus_manifest_indexes_non_apparatus_pdf_fixtures():
    manifest = load_reader_apparatus_manifest()
    apparatus_pdf_paths = {
        str(Path(case["path"]))
        for case in automated_fixture_cases()
        if case["fixture_format"] == "pdf"
    }
    non_apparatus_entries = manifest["non_apparatus_fixture_files"]
    non_apparatus_pdf_paths = {
        str(Path(entry["path"])) for entry in non_apparatus_entries if entry["media_kind"] == "pdf"
    }
    actual_pdf_paths = {
        str(path.relative_to(FIXTURES_ROOT)) for path in (FIXTURES_ROOT / "pdf").glob("*.pdf")
    }

    assert actual_pdf_paths == apparatus_pdf_paths | non_apparatus_pdf_paths

    for entry in non_apparatus_entries:
        assert entry["media_kind"] == "pdf", entry
        assert entry["path"] in non_apparatus_pdf_paths, entry
        assert entry["may_be_used_for_reader_apparatus"] is False, entry
        assert entry["provenance_status"] == "legacy_unverified", entry
        assert entry["reason"], entry
