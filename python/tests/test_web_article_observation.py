"""Unit tests for the web-article byline author observation builder.

Pure logic — no database or network. Confirms byline people-splitting is
unchanged (D-31 reverses only the PDF rule), that an absent byline is
``not_observed`` (never an erase), and that a web article claims no identity key.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from nexus.services.contributor_taxonomy import NotObserved, ObservedRoleSlices
from nexus.services.web_article_ingest import (
    _build_web_article_observation,
    _split_byline_names,
)

pytestmark = pytest.mark.unit


@dataclass
class _FakeIngestResult:
    byline: str | None


class TestSplitBylineNames:
    def test_strips_leading_by_and_splits_on_comma_semicolon_and(self):
        assert _split_byline_names("By Ada Lovelace, Alan Turing and Grace Hopper") == [
            "Ada Lovelace",
            "Alan Turing",
            "Grace Hopper",
        ]

    def test_semicolon_splits(self):
        assert _split_byline_names("Ada Lovelace; Alan Turing") == ["Ada Lovelace", "Alan Turing"]

    def test_blank_byline_is_empty(self):
        assert _split_byline_names(None) == []
        assert _split_byline_names("   ") == []


class TestBuildWebArticleObservation:
    def test_multiple_authors_become_ordered_author_slice(self):
        batch = _build_web_article_observation(_FakeIngestResult("By Ada Lovelace and Alan Turing"))
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.managed_roles == frozenset({"author"})
        assert [c.credited_name for c in batch.credits] == ["Ada Lovelace", "Alan Turing"]

    def test_no_identity_key(self):
        batch = _build_web_article_observation(_FakeIngestResult("Ada Lovelace"))
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.credits[0].identity_key is None

    def test_absent_byline_is_not_observed(self):
        assert isinstance(_build_web_article_observation(_FakeIngestResult(None)), NotObserved)
        assert isinstance(_build_web_article_observation(_FakeIngestResult("")), NotObserved)

    def test_duplicate_names_deduped_by_match_key(self):
        batch = _build_web_article_observation(_FakeIngestResult("Ada Lovelace, ADA LOVELACE"))
        assert isinstance(batch, ObservedRoleSlices)
        assert len(batch.credits) == 1
