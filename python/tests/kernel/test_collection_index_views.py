"""Strict Chats / Libraries / Notes index view parsing: one advertised view has
exactly one URL.

The oracle is the collection-refinement cutover's API contract: defaults omit
both keys, and the only valid non-default pairs are ``updated+asc`` /
``title+asc|desc`` for Chats and Notes and ``created+desc`` / ``name+asc|desc``
for Libraries. ``sort`` alone, ``direction`` alone, the explicit default pair,
unknown values, and duplicate keys are ``400 E_INVALID_REQUEST``. A permissive
parse would serve an order the URL does not name, and — for the two cursored
indexes — mint two cursor identities for one view.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import pytest

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.conversations import (
    ChatsTitle,
    ChatsUpdatedNewest,
    ChatsUpdatedOldest,
    parse_conversation_index_query,
)
from nexus.services.library_governance import (
    LibrariesCreatedNewest,
    LibrariesCreatedOldest,
    LibrariesName,
    parse_libraries_index_query,
)
from nexus.services.notes import (
    PagesTitle,
    PagesUpdatedNewest,
    PagesUpdatedOldest,
    parse_notes_index_query,
)

type _ViewParser = Callable[[Sequence[tuple[str, str]]], object]


def _chats(items: Sequence[tuple[str, str]]) -> object:
    return parse_conversation_index_query(items)[0]


def _libraries(items: Sequence[tuple[str, str]]) -> object:
    return parse_libraries_index_query(items)[0]


@pytest.mark.parametrize(
    ("parse", "items", "expected"),
    [
        pytest.param(_chats, (), ChatsUpdatedNewest(), id="chats-both-keys-absent-is-canonical"),
        pytest.param(
            _chats,
            (("scope", "all"),),
            ChatsUpdatedNewest(),
            id="chats-scope-alone-is-canonical",
        ),
        pytest.param(
            _chats,
            (("sort", "updated"), ("direction", "asc")),
            ChatsUpdatedOldest(),
            id="chats-updated-asc-is-reversed-canonical",
        ),
        pytest.param(
            _chats,
            (("sort", "title"), ("direction", "asc")),
            ChatsTitle("asc"),
            id="chats-title-asc",
        ),
        pytest.param(
            _chats,
            (("scope", "shared"), ("sort", "title"), ("direction", "desc")),
            ChatsTitle("desc"),
            id="chats-title-desc-composes-with-scope",
        ),
        pytest.param(
            _libraries,
            (),
            LibrariesCreatedOldest(),
            id="libraries-both-keys-absent-is-canonical",
        ),
        pytest.param(
            _libraries,
            (("sort", "created"), ("direction", "desc")),
            LibrariesCreatedNewest(),
            id="libraries-created-desc-is-reversed-canonical",
        ),
        pytest.param(
            _libraries,
            (("sort", "name"), ("direction", "asc")),
            LibrariesName("asc"),
            id="libraries-name-asc",
        ),
        pytest.param(
            _libraries,
            (("sort", "name"), ("direction", "desc")),
            LibrariesName("desc"),
            id="libraries-name-desc",
        ),
        pytest.param(
            parse_notes_index_query,
            (),
            PagesUpdatedNewest(),
            id="notes-both-keys-absent-is-canonical",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "updated"), ("direction", "asc")),
            PagesUpdatedOldest(),
            id="notes-updated-asc-is-reversed-canonical",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "title"), ("direction", "asc")),
            PagesTitle("asc"),
            id="notes-title-asc",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "title"), ("direction", "desc")),
            PagesTitle("desc"),
            id="notes-title-desc",
        ),
    ],
)
def test_advertised_index_query_parses_to_its_exact_closed_view(
    parse: _ViewParser,
    items: Sequence[tuple[str, str]],
    expected: object,
) -> None:
    view = parse(items)
    assert view == expected, (
        f"index query {list(items)} parsed to {view!r}, not the advertised view {expected!r}"
    )


@pytest.mark.parametrize(
    ("parse", "items"),
    [
        pytest.param(
            _chats,
            (("sort", "updated"), ("direction", "desc")),
            id="chats-explicit-default-pair-is-a-second-url-for-the-canonical-view",
        ),
        pytest.param(_chats, (("sort", "title"),), id="chats-sort-without-direction"),
        pytest.param(_chats, (("direction", "asc"),), id="chats-direction-without-sort"),
        pytest.param(
            _chats,
            (("sort", "created"), ("direction", "asc")),
            id="chats-sort-key-this-surface-lacks",
        ),
        pytest.param(
            _chats,
            (("sort", "title"), ("direction", "sideways")),
            id="chats-unknown-direction-value",
        ),
        pytest.param(
            _chats,
            (("sort", "title"), ("sort", "updated"), ("direction", "asc")),
            id="chats-duplicate-sort-key",
        ),
        pytest.param(
            _libraries,
            (("sort", "created"), ("direction", "asc")),
            id="libraries-explicit-default-pair-is-a-second-url-for-the-canonical-view",
        ),
        pytest.param(_libraries, (("sort", "name"),), id="libraries-sort-without-direction"),
        pytest.param(_libraries, (("direction", "desc"),), id="libraries-direction-without-sort"),
        pytest.param(
            _libraries,
            (("sort", "title"), ("direction", "asc")),
            id="libraries-sort-key-this-surface-lacks",
        ),
        pytest.param(
            _libraries,
            (("sort", "name"), ("direction", "")),
            id="libraries-empty-direction-value",
        ),
        pytest.param(
            _libraries,
            (("sort", "name"), ("direction", "asc"), ("direction", "desc")),
            id="libraries-duplicate-direction-key",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "updated"), ("direction", "desc")),
            id="notes-explicit-default-pair-is-a-second-url-for-the-canonical-view",
        ),
        pytest.param(
            parse_notes_index_query, (("sort", "title"),), id="notes-sort-without-direction"
        ),
        pytest.param(
            parse_notes_index_query,
            (("direction", "asc"),),
            id="notes-direction-without-sort",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "added"), ("direction", "asc")),
            id="notes-sort-key-this-surface-lacks",
        ),
        pytest.param(
            parse_notes_index_query,
            (("sort", "title"), ("direction", "asc"), ("direction", "asc")),
            id="notes-duplicate-direction-key",
        ),
        pytest.param(
            parse_notes_index_query,
            (("limit", "10"),),
            id="notes-page-key-the-exhaustive-index-has-no-contract-for",
        ),
    ],
)
def test_index_query_outside_the_advertised_inventory_is_an_invalid_request(
    parse: _ViewParser,
    items: Sequence[tuple[str, str]],
) -> None:
    with pytest.raises(InvalidRequestError) as raised:
        parse(items)
    assert raised.value.code is ApiErrorCode.E_INVALID_REQUEST, (
        f"index query {list(items)} was rejected with {raised.value.code}, not E_INVALID_REQUEST"
    )
