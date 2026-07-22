from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

FIXTURES_ROOT = Path(__file__).parent / "fixtures"
MANIFEST_PATH = FIXTURES_ROOT / "reader_apparatus" / "corpus_manifest.json"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SOURCE_PROVENANCE_KEYS = {
    "status",
    "source_title",
    "publisher",
    "evidence_url",
    "license_name",
    "license_url",
    "raw_source_commit_allowed",
    "raw_source_policy",
    "attribution_required",
    "checked_at",
}
RAW_SOURCE_FIXTURE_ELIGIBILITY_KEYS = {
    "status",
    "can_commit_raw_source",
    "commit_scope",
    "evidence_url",
    "license_name",
    "license_url",
    "attribution_required",
    "share_alike_required",
    "asset_review_required",
    "notes",
    "checked_at",
}
FIXTURE_PROVENANCE_KEYS = {
    "status",
    "source_title",
    "publisher",
    "evidence_url",
    "license_name",
    "license_url",
    "fixture_commit_allowed",
    "fixture_commit_policy",
    "source_text_copied",
    "checked_at",
}

SOURCE_PROVENANCE_STATUSES = {
    "legacy_existing_needs_revalidation",
    "pattern_fixture_only_not_raw_source",
    "url_only_pending_verification",
    "url_only_restricted_or_unclear",
    "url_only_unsupported_adapter",
    "verified_redistributable",
}
FIXTURE_PROVENANCE_STATUSES = {
    "legacy_existing_needs_revalidation",
    "synthetic_test_fixture",
    "verified_redistributable",
}
APPARATUS_SUPPORT_LEVELS = {
    "full_source_unsupported_adapter",
    "committed_fixture_graph_verified",
    "committed_fixture_negative_graph_verified",
    "negative_pattern_verified",
    "partial_marker_only",
    "pdf_native_link_graph_verified",
    "pattern_verified",
    "shared_pattern_verified",
    "source_package_verified",
    "url_only",
}
REAL_MEDIA_FIXTURE_CONTRACTS = {
    "web_article_capture_api",
    "epub_upload_synthetic_api",
    "epub_upload_negative_api",
    "epub_upload_standardebooks_api",
    "pdf_upload_native_link_graph_api",
    "pdf_upload_legal_footnotes_api",
    "pdf_upload_unsupported_pdf_adapter_api",
    "source_package_unit_contract",
    "source_package_unit_and_remote_pdf_api_contract",
    "tei_unit_contract",
}
RAW_SOURCE_FIXTURE_ELIGIBILITY_STATUSES = {
    "eligible",
    "eligible_text_only_with_conditions",
    "eligible_with_conditions",
    "legacy_existing_only",
    "not_eligible_or_unverified",
}
RAW_SOURCE_COMMIT_SCOPES = {
    "curated_article_html_owned_assets_only",
    "arxiv_source_package_with_cc_by_attribution",
    "curated_demo_html_css_with_mit_notice",
    "curated_html_text_and_source_markup_no_external_mirrors",
    "curated_html_text_and_source_markup_no_unvetted_assets",
    "curated_text_html_without_images_with_cc_by_sa_attribution",
    "commons_public_domain_pdf",
    "full_pdf_with_cc_by_attribution",
    "full_epub",
    "legacy_existing_fixture_only",
    "none",
    "project_gutenberg_epub_with_license_terms",
    "project_gutenberg_html_with_license_terms",
}
RAW_FIXTURE_KINDS = {
    "committed_existing_fixture_pdf_native_link_graph_verified",
    "committed_existing_fixture_native_link_partial",
    "committed_full",
    "committed_full_unsupported_adapter",
    "committed_full_negative",
    "committed_source_package",
}
DERIVED_FIXTURE_KINDS = {
    "committed_derived_tei",
}
COMMITTED_RAW_SOURCE_FIXTURE_POLICIES = {
    "committed_full_fixture",
    "committed_full_negative_fixture",
}
URL_ONLY_STATUSES = {
    "url_only_pending_verification",
    "url_only_restricted_or_unclear",
    "url_only_unsupported_adapter",
}
PATTERN_SOURCE_POLICIES = {
    "covered_by_distill_pattern_fixture",
    "minimal_negative_pattern_fixture",
    "minimal_pdf_pattern_fixture",
    "minimal_pattern_fixture",
}
PATTERN_FIXTURE_KINDS = {
    "minimal_negative_pattern",
    "minimal_pattern",
    "synthetic_archive",
    "synthetic_pdf_pattern",
}
APPARATUS_SUPPORT_BY_FIXTURE_POLICY = {
    "committed_existing_fixture_pdf_native_link_graph_verified": "pdf_native_link_graph_verified",
    "committed_existing_fixture_native_link_partial": "partial_marker_only",
    "committed_full_fixture": "committed_fixture_graph_verified",
    "committed_full_unsupported_pdf_adapter": "full_source_unsupported_adapter",
    "committed_full_negative_fixture": "committed_fixture_negative_graph_verified",
    "committed_source_package_fixture": "source_package_verified",
    "covered_by_distill_pattern_fixture": "shared_pattern_verified",
    "minimal_negative_pattern_fixture": "negative_pattern_verified",
    "minimal_pdf_pattern_fixture": "pattern_verified",
    "minimal_pattern_fixture": "pattern_verified",
    "url_only_pdf_adapter_missing": "url_only",
    "url_only_pending_fixture": "url_only",
    "url_only_restricted_or_unclear_license": "url_only",
}
COMMITTED_FIXTURE_GRAPH_SUPPORT_LEVELS = {
    "committed_fixture_graph_verified",
    "committed_fixture_negative_graph_verified",
}
UNSUPPORTED_COMMITTED_FIXTURE_SUPPORT_LEVELS = {
    "full_source_unsupported_adapter",
}
RETIRED_OVERCLAIM_STATUS_LABELS = {
    "full_source_verified",
    "negative_full_source_verified",
}
PATTERN_SUPPORT_LEVELS = {
    "negative_pattern_verified",
    "pattern_verified",
    "shared_pattern_verified",
}
SOURCE_PACKAGE_SUPPORT_LEVELS = {
    "source_package_verified",
}
OVERCLAIM_RE = re.compile(
    r"\b("
    r"all\s+(?:\d+\s+)?(?:[\w.-]+\s+){0,8}"
    r"(?:citation|citations|reference|references|footnote|footnotes|noteref|noterefs|"
    r"marker|markers|sidenote|sidenotes|margin\s+note|margin\s+notes|"
    r"endnote|endnotes)|"
    r"exhaustive|full source verified"
    r")\b",
    re.IGNORECASE,
)
MANUAL_VERIFICATION_CONTRACTS = {
    "full_source_fixture_no_supported_pdf_adapter_negative_verified",
    "pdf_literary_unsupported_adapter_verified",
    "pdf_native_link_graph_verified_not_generic_pdf_extraction",
    "source_archive_noteref_absence_verified",
    "source_archive_noteref_identity_verified",
    "source_dom_graph_verified",
    "source_dom_negative_graph_verified",
    "source_package_latex_biblatex_graph_verified",
    "synthetic_law_review_pdf_footnote_pattern_verified",
}
VERIFIER_TIERS = {
    "current_extractor_gold_snapshot",
    "independent_archive",
    "independent_dom",
    "independent_dom_negative",
    "independent_pdf_graph",
    "independent_source_package",
    "sample_hand_gold",
    "synthetic_negative",
    "synthetic_pattern",
    "unsupported_negative",
}
VERIFIER_SCOPES = {
    "fixture_graph",
    "negative_fixture_graph",
    "negative_pattern_fixture",
    "partial_sample",
    "pattern_fixture",
}


@lru_cache(maxsize=1)
def load_reader_apparatus_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def automated_fixture_cases() -> list[dict[str, Any]]:
    return list(load_reader_apparatus_manifest()["automated_fixtures"])


def source_corpus() -> list[dict[str, Any]]:
    return list(load_reader_apparatus_manifest()["source_corpus"])


def sources_by_id() -> dict[str, dict[str, Any]]:
    return {source["id"]: source for source in source_corpus()}


def automated_fixtures_by_id() -> dict[str, dict[str, Any]]:
    return {case["id"]: case for case in automated_fixture_cases()}


def automated_fixture_case(fixture_id: str) -> dict[str, Any]:
    try:
        return automated_fixtures_by_id()[fixture_id]
    except KeyError as exc:
        raise KeyError(f"Unknown reader apparatus fixture: {fixture_id}") from exc


def automated_fixture_cases_matching(**criteria: object) -> list[dict[str, Any]]:
    return [
        case
        for case in automated_fixture_cases()
        if all(case.get(key) == value for key, value in criteria.items())
    ]


def real_media_fixture_contracts() -> dict[str, dict[str, Any]]:
    return dict(load_reader_apparatus_manifest()["real_media_fixture_contracts"])


def gold_graph_fixtures() -> list[dict[str, Any]]:
    return list(load_reader_apparatus_manifest()["gold_graph_fixtures"])


def verifier_tiers() -> dict[str, dict[str, Any]]:
    return dict(load_reader_apparatus_manifest()["verifier_tiers"])


def real_media_contract_for_fixture(fixture_id: str) -> dict[str, Any]:
    try:
        return real_media_fixture_contracts()[fixture_id]
    except KeyError as exc:
        raise KeyError(f"Unknown reader apparatus real-media contract: {fixture_id}") from exc


def fixture_cases_by_real_media_contract(contract: str) -> list[dict[str, Any]]:
    contracts = real_media_fixture_contracts()
    return [
        case for case in automated_fixture_cases() if contracts[case["id"]]["contract"] == contract
    ]


def fixture_cases(
    *,
    fixture_format: str | None = None,
    fixture_kind: str | None = None,
    source_family: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    cases = automated_fixture_cases()
    if fixture_format is not None:
        cases = [case for case in cases if case["fixture_format"] == fixture_format]
    if fixture_kind is not None:
        cases = [case for case in cases if case["fixture_kind"] == fixture_kind]
    if source_family is not None:
        cases = [case for case in cases if case.get("source_family") == source_family]
    if status is not None:
        cases = [case for case in cases if case["expected"]["status"] == status]
    return cases


def fixture_case_ids(cases: list[dict[str, Any]]) -> list[str]:
    return [case["id"] for case in cases]


def linked_fixture_cases(source: dict[str, Any]) -> list[dict[str, Any]]:
    fixtures = automated_fixtures_by_id()
    return [fixtures[fixture_id] for fixture_id in source["fixture_ids"]]


def support_counts() -> dict[str, int]:
    counts = Counter(source["apparatus_support_level"] for source in source_corpus())
    return {support_level: counts[support_level] for support_level in APPARATUS_SUPPORT_LEVELS}


def fixture_path(case: dict[str, Any]) -> Path:
    return FIXTURES_ROOT / str(case["path"])


def fixture_bytes(case: dict[str, Any]) -> bytes:
    payload = fixture_path(case).read_bytes()
    assert_fixture_payload_matches_manifest(case, payload)
    return payload


def fixture_text(case: dict[str, Any]) -> str:
    return fixture_bytes(case).decode("utf-8")


def assert_fixture_file_matches_manifest(case: dict[str, Any]) -> None:
    path = fixture_path(case)
    assert path.exists(), case["id"]
    assert_fixture_payload_matches_manifest(case, path.read_bytes())


def assert_fixture_payload_matches_manifest(case: dict[str, Any], payload: bytes) -> None:
    assert len(payload) == case["byte_length"], case["id"]
    assert hashlib.sha256(payload).hexdigest() == case["sha256"], case["id"]


def expected_counts(case: dict[str, Any], key: str) -> dict[str, int]:
    value = case["expected"].get(key, {})
    if not isinstance(value, dict):
        raise TypeError(f"Expected {key} for {case['id']} to be a mapping")
    return {str(k): int(v) for k, v in value.items()}


@dataclass(frozen=True)
class WebArticleApparatusCase:
    fixture_id: str
    filename: str
    modeled_source_url: str
    title: str
    byte_length: int
    sha256: str
    expected_status: str
    item_kinds: dict[str, int]
    edge_relations: dict[str, int]
    edge_confidences: dict[str, int]
    edge_methods: dict[str, int]
    body_needles: tuple[str, ...] = ()
    min_exact_locators: int = 0


@dataclass(frozen=True)
class EpubApparatusCase:
    fixture_id: str
    filename: str
    source_url: str
    license_note: str
    byte_length: int
    sha256: str
    chapter_count: int
    item_kinds: dict[str, int]
    edge_relations: dict[str, int]
    edge_confidences: dict[str, int]
    edge_methods: dict[str, int]
    body_needles: tuple[str, ...]


def web_article_real_media_cases() -> list[WebArticleApparatusCase]:
    return [
        web_article_apparatus_case(case["id"])
        for case in fixture_cases_by_real_media_contract("web_article_capture_api")
    ]


def standardebooks_epub_real_media_cases() -> list[EpubApparatusCase]:
    return [
        epub_apparatus_case(case["id"])
        for case in fixture_cases_by_real_media_contract("epub_upload_standardebooks_api")
    ]


def web_article_apparatus_case(fixture_id: str) -> WebArticleApparatusCase:
    case = automated_fixture_case(fixture_id)
    expected = case["expected"]
    return WebArticleApparatusCase(
        fixture_id=case["id"],
        filename=Path(case["path"]).name,
        modeled_source_url=case["modeled_source_url"],
        title=case["title"],
        byte_length=int(case["byte_length"]),
        sha256=case["sha256"],
        expected_status=expected["status"],
        item_kinds=expected_counts(case, "item_kinds"),
        edge_relations=expected_counts(case, "edge_relations"),
        edge_confidences=expected_counts(case, "edge_confidences"),
        edge_methods=expected_counts(case, "edge_methods"),
        body_needles=tuple(expected.get("body_needles", ())),
        min_exact_locators=int(expected.get("min_exact_locators", 0)),
    )


def epub_apparatus_case(fixture_id: str) -> EpubApparatusCase:
    case = automated_fixture_case(fixture_id)
    expected = case["expected"]
    return EpubApparatusCase(
        fixture_id=case["id"],
        filename=Path(case["path"]).name,
        source_url=case["source_url"],
        license_note=case["license_note"],
        byte_length=int(case["byte_length"]),
        sha256=case["sha256"],
        chapter_count=int(expected["chapter_count"]),
        item_kinds=expected_counts(case, "item_kinds"),
        edge_relations=expected_counts(case, "edge_relations"),
        edge_confidences=expected_counts(case, "edge_confidences"),
        edge_methods=expected_counts(case, "edge_methods"),
        body_needles=tuple(expected.get("body_needles", ())),
    )
