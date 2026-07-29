from types import MappingProxyType

import pytest
from pydantic import ValidationError

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.collection_page import (
    CollectionPage,
    CollectionRevisionOut,
    parse_collection_query,
    parse_manual_page_query,
)
from nexus.schemas.presence import absent, present

pytestmark = pytest.mark.unit


def test_collection_page_serializes_one_strict_camel_case_envelope() -> None:
    page = CollectionPage[str](
        items=["first", "second"],
        collection_revision=7,
        next_cursor=present("cursor"),
    )

    assert page.model_dump(mode="json", by_alias=True) == {
        "items": ["first", "second"],
        "collectionRevision": 7,
        "nextCursor": {"kind": "Present", "value": "cursor"},
    }
    assert CollectionRevisionOut(collection_revision=7).model_dump(mode="json", by_alias=True) == {
        "collectionRevision": 7
    }

    with pytest.raises(ValidationError):
        CollectionPage[str].model_validate(
            {
                "items": [],
                "collectionRevision": 0,
                "nextCursor": {"kind": "Absent"},
                "hasMore": False,
            }
        )


def test_collection_page_rejects_noncanonical_revision_values() -> None:
    for invalid in (-1, 2**63, True, "1"):
        with pytest.raises(ValidationError):
            CollectionPage[str](
                items=[],
                collection_revision=invalid,  # type: ignore[arg-type]
                next_cursor=absent(),
            )


def test_parse_collection_query_accepts_first_and_continuation_pages() -> None:
    first = parse_collection_query(
        [("sort", "alpha"), ("limit", "100")],
        domain_keys=frozenset({"sort", "q"}),
    )
    continuation = parse_collection_query(
        [
            ("sort", "alpha"),
            ("q", ""),
            ("cursor", "opaque"),
            ("collection_revision", "42"),
            ("limit", "200"),
        ],
        domain_keys=frozenset({"sort", "q"}),
    )

    assert first.limit == 100
    assert first.cursor is None
    assert first.collection_revision is None
    assert first.parameters == MappingProxyType({"sort": "alpha"})
    assert continuation.limit == 200
    assert continuation.cursor == "opaque"
    assert continuation.collection_revision == 42
    assert continuation.parameters == MappingProxyType({"sort": "alpha", "q": ""})


@pytest.mark.parametrize(
    "items",
    [
        [("limit", "100"), ("limit", "100")],
        [("q", "one"), ("q", "two")],
        [("unknown", "value")],
        [("offset", "0")],
        [("cursor", "")],
        [("collection_revision", "")],
        [("cursor", "opaque")],
        [("collection_revision", "1")],
        [("cursor", "opaque"), ("collection_revision", "01")],
        [("cursor", "opaque"), ("collection_revision", "+1")],
        [("cursor", "opaque"), ("collection_revision", " 1")],
        [("cursor", "opaque"), ("collection_revision", "١")],
        [("cursor", "opaque"), ("collection_revision", str(2**63))],
        [("limit", "0")],
        [("limit", "01")],
        [("limit", "+1")],
        [("limit", " 1")],
        [("limit", "١")],
        [("limit", "201")],
    ],
)
def test_parse_collection_query_rejects_noncanonical_request_shapes(
    items: list[tuple[str, str]],
) -> None:
    with pytest.raises(InvalidRequestError) as exc_info:
        parse_collection_query(items, domain_keys=frozenset({"q"}))

    assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST


def test_parse_collection_query_rejects_invalid_owner_key_configuration() -> None:
    with pytest.raises(ValueError):
        parse_collection_query([], domain_keys=frozenset({"cursor"}))


def test_manual_page_query_is_strict_without_requiring_a_revision() -> None:
    parsed = parse_manual_page_query(
        [("q", "needle"), ("cursor", "opaque"), ("limit", "25")],
        domain_keys=frozenset({"q"}),
        default_limit=50,
        max_limit=100,
    )
    assert parsed.limit == 25
    assert parsed.cursor == "opaque"
    assert parsed.collection_revision is None
    assert parsed.parameters == {"q": "needle"}


@pytest.mark.parametrize(
    "items",
    [
        [("q", "one"), ("q", "two")],
        [("scope", "mine")],
        [("collection_revision", "1")],
        [("offset", "0")],
        [("cursor", "")],
        [("limit", "01")],
        [("limit", "101")],
    ],
)
def test_manual_page_query_rejects_legacy_or_noncanonical_shapes(
    items: list[tuple[str, str]],
) -> None:
    with pytest.raises(InvalidRequestError):
        parse_manual_page_query(
            items,
            domain_keys=frozenset({"q"}),
            default_limit=50,
            max_limit=100,
        )
