"""Unit coverage for the contributor taxonomy leaf (pure normalizers + vocab sets)."""

import pytest

from nexus.services.contributor_taxonomy import (
    CONFIRMED_ALIAS_SOURCES,
    CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    display_contributor_name,
    normalize_contributor_name,
    normalize_contributor_role,
    normalize_resolution_status,
)

pytestmark = pytest.mark.unit


def test_normalize_contributor_role_maps_known_and_unknown() -> None:
    assert normalize_contributor_role("Author") == "author"
    assert normalize_contributor_role("  EDITOR ") == "editor"
    assert normalize_contributor_role(None) == "author"  # missing role defaults to author
    assert normalize_contributor_role("co_author") == "unknown"  # not in the closed vocab
    assert normalize_contributor_role("") == "author"


def test_normalize_contributor_name_collapses_whitespace_and_lowercases() -> None:
    assert normalize_contributor_name("  Jane   Q.  Doe ") == "jane q. doe"
    assert normalize_contributor_name("ALICE") == "alice"


def test_display_contributor_name_collapses_whitespace_but_keeps_case() -> None:
    assert display_contributor_name("  Jane   Q.  Doe ") == "Jane Q. Doe"


def test_normalize_resolution_status_falls_back_to_default() -> None:
    assert normalize_resolution_status("manual", default="unverified") == "manual"
    assert normalize_resolution_status("bogus", default="unverified") == "unverified"
    assert normalize_resolution_status(None, default="manual") == "manual"


def test_strong_authorities_are_a_subset_and_merge_is_confirmed() -> None:
    # D-EXT: provider accounts are not strong identity keys, but stay in the wider set.
    assert STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES <= CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES
    assert {"podcast_index", "rss", "youtube", "gutenberg"} <= CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES
    assert {"podcast_index", "rss", "youtube", "gutenberg"}.isdisjoint(
        STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES
    )
    # AC9: merge writes a "merge"-sourced alias that must count as confirmed.
    assert "merge" in CONFIRMED_ALIAS_SOURCES
