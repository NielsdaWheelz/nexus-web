"""Unit tests for the X ingest author observation builder.

Pure logic — no database, network, or provider snapshots. Exercises the D-24
rule that the numeric ``x_user`` id is the exact identity key and the username is
never a key.
"""

from __future__ import annotations

import pytest

from nexus.services.contributor_taxonomy import ObservedRoleSlices
from nexus.services.x_ingest import _build_x_author_observation

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
