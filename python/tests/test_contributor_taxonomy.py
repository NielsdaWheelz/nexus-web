"""Unit coverage for the contributor taxonomy leaf (pure normalizers + vocab sets).

The legacy reconciliation-era vocab (``normalize_contributor_name``,
``CONFIRMED_ALIAS_SOURCES``, ``STRONG_/CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES``,
``normalize_resolution_status``, ``CONTRIBUTOR_RESOLUTION_STATUSES``) was deleted
post-cutover (S5); its v2 successors (``contributor_match_key``,
``CONTRIBUTOR_KEY_AUTHORITIES``, the observation/handle machinery) are covered in
``test_contributor_taxonomy_v2.py``.
"""

import pytest

from nexus.services.contributor_taxonomy import (
    display_contributor_name,
    normalize_contributor_role,
)

pytestmark = pytest.mark.unit


def test_normalize_contributor_role_maps_known_and_unknown() -> None:
    assert normalize_contributor_role("Author") == "author"
    assert normalize_contributor_role("  EDITOR ") == "editor"
    assert normalize_contributor_role(None) == "author"  # missing role defaults to author
    assert normalize_contributor_role("co_author") == "unknown"  # not in the closed vocab
    assert normalize_contributor_role("") == "author"


def test_display_contributor_name_collapses_whitespace_but_keeps_case() -> None:
    assert display_contributor_name("  Jane   Q.  Doe ") == "Jane Q. Doe"
