"""Strict same-system contracts for source author-observation carriers."""

from __future__ import annotations

import pytest

from nexus.services.media_author_observation_seam import take_author_observations


@pytest.mark.parametrize(
    ("carrier", "message"),
    [
        ("legacy", "author observations must be a list"),
        (["legacy"], "author observation entry is malformed"),
    ],
)
def test_author_observation_carrier_defects_on_malformed_same_system_shape(
    carrier: object,
    message: str,
) -> None:
    result = {"author_observations": carrier}

    with pytest.raises(AssertionError, match=message):
        take_author_observations(result)
