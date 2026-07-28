"""Unit tests for the X ingest author observation builder.

Pure logic — no database, network, or provider snapshots. Exercises the D-24
rule that the numeric ``x_user`` id is the exact identity key and the username is
never a key.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from nexus.services.contributor_taxonomy import ObservedRoleSlices
from nexus.services.x_ingest import (
    _build_x_author_observation,
    _build_x_fragment,
    _require_x_quote_source_identity,
)
from nexus.services.x_rendering import RenderedXQuoteOccurrence
from nexus.services.x_types import XUnavailableQuoteReference

pytestmark = pytest.mark.unit


def _only_credit(batch: object):
    assert isinstance(batch, ObservedRoleSlices)
    assert batch.managed_roles == frozenset({"author"})
    assert len(batch.credits) == 1
    return batch.credits[0]


class TestBuildXAuthorObservation:
    def test_numeric_id_becomes_x_user_key(self):
        credit = _only_credit(_build_x_author_observation("Ada Lovelace", "1234567890"))
        assert credit.credited_name == "Ada Lovelace"
        assert credit.role == "author"
        assert credit.identity_key is not None
        assert credit.identity_key.authority == "x_user"
        assert credit.identity_key.key == "1234567890"

    def test_username_is_never_a_key(self):
        # The builder only accepts the numeric id; a handle-shaped value is not a
        # valid x_user key and is omitted, leaving the name observed keyless.
        credit = _only_credit(_build_x_author_observation("Ada", "ada"))
        assert credit.identity_key is None

    def test_display_name_is_trimmed_and_collapsed(self):
        credit = _only_credit(_build_x_author_observation("  Ada   Lovelace ", "42"))
        assert credit.credited_name == "Ada Lovelace"
        assert credit.identity_key is not None
        assert credit.identity_key.key == "42"


def test_quote_source_identity_requires_exact_x_post_attempt():
    _require_x_quote_source_identity(
        source_type="x_post",
        provider_target_ref="4444444444",
        post_id="4444444444",
    )

    with pytest.raises(AssertionError, match="source identity changed"):
        _require_x_quote_source_identity(
            source_type="x_author_thread",
            provider_target_ref="4444444444",
            post_id="4444444444",
        )
    with pytest.raises(AssertionError, match="source identity changed"):
        _require_x_quote_source_identity(
            source_type="x_post",
            provider_target_ref="5555555555",
            post_id="4444444444",
        )


def test_quote_locator_uses_appended_marker_when_authored_text_matches_label():
    label = "Quoted X post unavailable — Open on X"
    occurrence = RenderedXQuoteOccurrence(
        ordinal=0,
        occurrence_key="x-quote:1234567890:4444444444",
        post_id="4444444444",
        placeholder_text=label,
        reference=XUnavailableQuoteReference(
            post_id="4444444444",
            canonical_url="https://x.com/i/status/4444444444",
        ),
    )

    prepared = _build_x_fragment(
        media_id=None,
        idx=0,
        html=(
            f"<article><p>{label}</p>"
            '<figure data-nexus-document-embed-id="x-quote:1234567890:4444444444">'
            f"<figcaption>{label}</figcaption></figure></article>"
        ),
        base_url="https://x.com/i/status/1234567890",
        created_at=datetime.now(UTC),
        quote_occurrences=(occurrence,),
    )

    locator = prepared.quote_occurrences[0]
    assert prepared.fragment.canonical_text.count(label) == 2
    assert locator.canonical_start_offset == prepared.fragment.canonical_text.rfind(label)
    assert locator.canonical_start_offset != prepared.fragment.canonical_text.find(label)
