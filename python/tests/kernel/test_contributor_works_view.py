"""Strict author-works view parsing: one advertised view has exactly one URL.

The oracle is the collection-refinement cutover's API contract — canonical
``Published — newest`` omits both keys; the only valid non-default pairs are
``published+asc`` and ``title+asc|desc``; ``sort`` or ``direction`` alone, the
explicit default pair, unknown values, and duplicate keys are
``400 E_INVALID_REQUEST``. A permissive parse would silently serve a different
order than the URL names and would mint two cursor identities for one view.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.contributors import (
    ContributorWorksView,
    WorksPublishedNewest,
    WorksPublishedOldest,
    WorksTitle,
    parse_contributor_works_query,
)


@pytest.mark.parametrize(
    ("items", "expected"),
    [
        pytest.param((), WorksPublishedNewest(), id="both-keys-absent-is-canonical"),
        pytest.param(
            (("sort", "published"), ("direction", "asc")),
            WorksPublishedOldest(),
            id="published-asc-is-reversed-canonical",
        ),
        pytest.param(
            (("sort", "title"), ("direction", "asc")),
            WorksTitle("asc"),
            id="title-asc",
        ),
        pytest.param(
            (("sort", "title"), ("direction", "desc")),
            WorksTitle("desc"),
            id="title-desc",
        ),
    ],
)
def test_advertised_works_query_parses_to_its_exact_closed_view(
    items: Sequence[tuple[str, str]],
    expected: ContributorWorksView,
) -> None:
    view, _query = parse_contributor_works_query(items)
    assert view == expected, (
        f"author works query {list(items)} parsed to {view!r}, not the advertised view {expected!r}"
    )


@pytest.mark.parametrize(
    "items",
    [
        pytest.param(
            (("sort", "published"), ("direction", "desc")),
            id="explicit-default-pair-is-a-second-url-for-the-canonical-view",
        ),
        pytest.param((("sort", "title"),), id="sort-without-direction"),
        pytest.param((("direction", "asc"),), id="direction-without-sort"),
        pytest.param((("sort", "added"), ("direction", "asc")), id="sort-key-this-surface-lacks"),
        pytest.param((("sort", "title"), ("direction", "sideways")), id="unknown-direction-value"),
        pytest.param((("sort", "title"), ("direction", "")), id="empty-direction-value"),
        pytest.param(
            (("sort", "title"), ("sort", "published"), ("direction", "asc")),
            id="duplicate-sort-key",
        ),
        pytest.param(
            (("sort", "title"), ("direction", "asc"), ("direction", "desc")),
            id="duplicate-direction-key",
        ),
    ],
)
def test_works_query_outside_the_advertised_inventory_is_an_invalid_request(
    items: Sequence[tuple[str, str]],
) -> None:
    with pytest.raises(InvalidRequestError) as raised:
        parse_contributor_works_query(items)
    assert raised.value.code is ApiErrorCode.E_INVALID_REQUEST, (
        f"author works query {list(items)} was rejected with {raised.value.code}, not"
        " E_INVALID_REQUEST"
    )
