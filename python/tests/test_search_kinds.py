"""Kind taxonomy + strict query validators (search cutover §4.3–§4.5/§4.4a, AC-4/AC-10/D-11).

Pure-function coverage for the leaf that folds the 14 internal result types into the six
user kinds, the format→storage map, kind/format aliases, the server-side implied-kind
enforcer (``effective_kinds``), and the query-strict transport validators. No DB, no
fixtures — every function under test is a pure leaf.
"""

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.search import ALL_RESULT_TYPES
from nexus.services.contributor_taxonomy import CONTRIBUTOR_ROLE_SET
from nexus.services.search.kinds import (
    ALL_KINDS,
    CREDIT_KINDS,
    FORMAT_KINDS,
    FORMAT_TO_STORAGE,
    KIND_TO_RESULT_TYPES,
    SEARCH_KINDS,
    effective_kinds,
    normalize_format,
    normalize_kind,
    result_types_for,
    storage_for_formats,
)
from nexus.services.search.query import (
    SearchQuery,
    _dedup_strings,
    parse_requested_kinds,
    validate_formats,
    validate_roles,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# effective_kinds — the server-side implied-kind enforcer (AC-4, §4.5)
# ---------------------------------------------------------------------------


def test_effective_kinds_none_means_all_six() -> None:
    eff = effective_kinds(None, has_format_filter=False, has_credit_filter=False)
    assert eff == ALL_KINDS
    assert eff == frozenset(SEARCH_KINDS)
    assert len(eff) == 6


def test_effective_kinds_format_only_intersects_documents() -> None:
    eff = effective_kinds(None, has_format_filter=True, has_credit_filter=False)
    assert eff == frozenset({"documents"})
    assert eff == FORMAT_KINDS


def test_effective_kinds_credit_only_intersects_documents_and_people() -> None:
    eff = effective_kinds(None, has_format_filter=False, has_credit_filter=True)
    assert eff == frozenset({"documents", "people"})
    assert eff == CREDIT_KINDS


def test_effective_kinds_both_filters_collapse_to_documents() -> None:
    eff = effective_kinds(None, has_format_filter=True, has_credit_filter=True)
    assert eff == frozenset({"documents"})


def test_effective_kinds_requested_intersected_with_format_kinds() -> None:
    # A requested kind set is narrowed by the filter, never widened.
    eff = effective_kinds(
        frozenset({"documents", "notes"}),
        has_format_filter=True,
        has_credit_filter=False,
    )
    assert eff == frozenset({"documents"})


def test_effective_kinds_notes_plus_format_is_unrepresentable() -> None:
    # The "Notes + PDFs" spine case: notes cannot honor a media-format filter, so the
    # intersection is empty (no results) rather than silently dropping the filter.
    eff = effective_kinds(
        frozenset({"notes"}),
        has_format_filter=True,
        has_credit_filter=False,
    )
    assert eff == frozenset()


def test_effective_kinds_explicit_empty_stays_empty() -> None:
    eff = effective_kinds(frozenset(), has_format_filter=False, has_credit_filter=False)
    assert eff == frozenset()


def test_effective_kinds_people_plus_credit_survives() -> None:
    eff = effective_kinds(
        frozenset({"people"}),
        has_format_filter=False,
        has_credit_filter=True,
    )
    assert eff == frozenset({"people"})


# ---------------------------------------------------------------------------
# result_types_for — kind → internal result types, canonical order (§4.3)
# ---------------------------------------------------------------------------


def test_result_types_for_empty_is_empty() -> None:
    assert result_types_for(frozenset()) == ()


def test_result_types_for_documents_folds_reader_document_types() -> None:
    doc_types = result_types_for(frozenset({"documents"}))
    assert doc_types == (
        "media",
        "podcast",
        "episode",
        "video",
        "content_chunk",
        "fragment",
        "evidence_span",
        "reader_apparatus_item",
    )
    assert len(doc_types) == 8


def test_result_types_for_preserves_all_result_types_order() -> None:
    # The union across all kinds must be emitted in canonical ALL_RESULT_TYPES order.
    all_types = result_types_for(ALL_KINDS)
    assert all_types == ALL_RESULT_TYPES
    assert list(all_types) == [rt for rt in ALL_RESULT_TYPES if rt in set(all_types)]


def test_result_types_for_dedups_union_across_kinds() -> None:
    documents = result_types_for(frozenset({"documents"}))
    notes = result_types_for(frozenset({"notes"}))
    union = result_types_for(frozenset({"documents", "notes"}))
    # No duplicates, and the union is exactly the merged set in canonical order.
    assert len(union) == len(set(union))
    assert set(union) == set(documents) | set(notes)


def test_single_kind_result_types_partition_all_result_types() -> None:
    # The six kinds must partition the 14 internal result types: no overlap, no orphan.
    seen: set[str] = set()
    for kind in SEARCH_KINDS:
        types = set(result_types_for(frozenset({kind})))
        assert not (types & seen), f"{kind} result types overlap another kind"
        seen |= types
    assert seen == set(ALL_RESULT_TYPES)
    # Every kind maps to at least one result type (no empty leaf in the taxonomy).
    for kind in SEARCH_KINDS:
        assert result_types_for(frozenset({kind})), kind


def test_kind_to_result_types_keys_are_the_six_kinds() -> None:
    assert set(KIND_TO_RESULT_TYPES) == set(SEARCH_KINDS)


# ---------------------------------------------------------------------------
# FORMAT_TO_STORAGE / storage_for_formats (AC-10, §4.4a)
# ---------------------------------------------------------------------------


def test_format_to_storage_map() -> None:
    assert FORMAT_TO_STORAGE == {
        "article": "web_article",
        "pdf": "pdf",
        "epub": "epub",
        "video": "video",
        "episode": "podcast_episode",
        "podcast": "podcast",
    }


def test_storage_for_formats_translates_in_order() -> None:
    assert storage_for_formats(("article", "episode", "pdf")) == [
        "web_article",
        "podcast_episode",
        "pdf",
    ]


def test_storage_for_formats_empty() -> None:
    assert storage_for_formats(()) == []


def test_no_gutenberg_storage_target() -> None:
    # Gutenberg is provenance, not a format (N10) — it must never appear as a storage value.
    assert "gutenberg" not in FORMAT_TO_STORAGE
    assert "gutenberg" not in FORMAT_TO_STORAGE.values()


# ---------------------------------------------------------------------------
# normalize_kind / normalize_format — canonical + aliases (§4.4)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token,expected",
    [
        ("documents", "documents"),
        ("document", "documents"),
        ("doc", "documents"),
        ("docs", "documents"),
        ("notes", "notes"),
        ("note", "notes"),
        ("highlights", "highlights"),
        ("highlight", "highlights"),
        ("conversations", "conversations"),
        ("conversation", "conversations"),
        ("chat", "conversations"),
        ("chats", "conversations"),
        ("people", "people"),
        ("person", "people"),
        ("web", "web"),
    ],
)
def test_normalize_kind_canonical_and_aliases(token: str, expected: str) -> None:
    assert normalize_kind(token) == expected


def test_normalize_kind_is_case_and_whitespace_insensitive() -> None:
    assert normalize_kind("  DOCS  ") == "documents"
    assert normalize_kind("Chat") == "conversations"


@pytest.mark.parametrize("junk", ["author", "authors", "media", "garbage", "", "  "])
def test_normalize_kind_rejects_out_of_vocab(junk: str) -> None:
    # "author" is an operator, not a kind — it must not normalize.
    assert normalize_kind(junk) is None


@pytest.mark.parametrize("fmt", ["article", "pdf", "epub", "video", "episode", "podcast"])
def test_normalize_format_canonical(fmt: str) -> None:
    assert normalize_format(fmt) == fmt


def test_normalize_format_is_case_and_whitespace_insensitive() -> None:
    assert normalize_format("  PDF ") == "pdf"


@pytest.mark.parametrize("junk", ["gutenberg", "rss", "html", "", "doc"])
def test_normalize_format_rejects_out_of_vocab(junk: str) -> None:
    assert normalize_format(junk) is None


# ---------------------------------------------------------------------------
# Strict query validators (D-11)
# ---------------------------------------------------------------------------


def test_validate_formats_dedups_preserving_order() -> None:
    assert validate_formats(["pdf", "epub", "pdf"]) == ("pdf", "epub")


def test_validate_formats_none_and_empty() -> None:
    assert validate_formats(None) == ()
    assert validate_formats([]) == ()


def test_validate_formats_rejects_out_of_vocab() -> None:
    with pytest.raises(InvalidRequestError) as excinfo:
        validate_formats(["pdf", "gutenberg"])
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert excinfo.value.status_code == 400


def test_validate_roles_accepts_taxonomy_and_dedups() -> None:
    assert validate_roles(["author", "editor", "author"]) == ("author", "editor")
    # Strict role validation reuses the contributor taxonomy vocab.
    assert all(
        role in CONTRIBUTOR_ROLE_SET for role in validate_roles(sorted(CONTRIBUTOR_ROLE_SET))
    )


def test_validate_roles_normalizes_case_and_whitespace() -> None:
    assert validate_roles(["  Author ", "HOST"]) == ("author", "host")


def test_validate_roles_none_and_empty() -> None:
    assert validate_roles(None) == ()
    assert validate_roles([]) == ()


def test_validate_roles_rejects_out_of_vocab() -> None:
    with pytest.raises(InvalidRequestError) as excinfo:
        validate_roles(["author", "wizard"])
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST


def test_parse_requested_kinds_none_is_none() -> None:
    assert parse_requested_kinds(None) is None


def test_parse_requested_kinds_empty_is_empty_frozenset() -> None:
    result = parse_requested_kinds([])
    assert result == frozenset()
    assert isinstance(result, frozenset)


def test_parse_requested_kinds_normalizes_and_dedups() -> None:
    assert parse_requested_kinds(["doc", "documents", "chat"]) == frozenset(
        {"documents", "conversations"}
    )


def test_parse_requested_kinds_rejects_invalid() -> None:
    with pytest.raises(InvalidRequestError) as excinfo:
        parse_requested_kinds(["documents", "bogus"])
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST
    assert excinfo.value.status_code == 400


def test_dedup_strings_trims_dedups_and_drops_empties() -> None:
    assert _dedup_strings(["  Tolkien ", "Tolkien", "", "  ", "Asimov"]) == ("Tolkien", "Asimov")


def test_dedup_strings_none_is_empty() -> None:
    assert _dedup_strings(None) == ()


# ---------------------------------------------------------------------------
# SearchQuery resolution properties (§5.1)
# ---------------------------------------------------------------------------


def test_search_query_effective_result_types_derive_from_kinds() -> None:
    query = SearchQuery(text="x", requested_kinds=frozenset({"highlights"}))
    assert query.effective_result_types == ("highlight",)


def test_search_query_default_kinds_resolve_to_all_result_types() -> None:
    # requested_kinds None ⇒ all kinds ⇒ all result types in canonical order.
    query = SearchQuery(text="x")
    assert query.effective_kinds == ALL_KINDS
    assert query.effective_result_types == ALL_RESULT_TYPES


def test_search_query_format_filter_narrows_effective_kinds() -> None:
    # A format filter on an all-kinds query narrows to Documents (implied-kind on the object).
    query = SearchQuery(text="x", formats=("pdf",))
    assert query.effective_kinds == frozenset({"documents"})


def test_search_query_content_kinds_maps_formats_to_storage() -> None:
    query = SearchQuery(text="x", formats=("article", "episode"))
    assert query.content_kinds == ["web_article", "podcast_episode"]


def test_search_query_content_kinds_default_empty() -> None:
    assert SearchQuery(text="x").content_kinds == []


def test_search_query_has_no_internal_override_fields() -> None:
    assert "result_types" not in SearchQuery.__dataclass_fields__
    assert "storage_kinds" not in SearchQuery.__dataclass_fields__
