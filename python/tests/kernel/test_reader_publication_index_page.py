"""The index chain partitions the document, and publication Find keeps its query contract."""

import pytest
from pydantic import ValidationError

from nexus.schemas.reader_publication import (
    ReaderPublicationFindRequest,
    ReaderPublicationIndexPage,
    ReaderPublicationMemberRef,
    ReaderPublicationUnitIndex,
)

_EMPTY_PAGE = {
    "sections": (),
    "toc": (),
    "landmarks": (),
    "page_list": (),
    "table_metadata": (),
    "anchors": (),
    "next_ref": None,
}


def _unit(key: str, ordinal: int) -> ReaderPublicationUnitIndex:
    return ReaderPublicationUnitIndex(
        member=ReaderPublicationMemberRef(key=key, bytes=16, sha256="0" * 64),
        ordinal=ordinal,
        fragment_id="fragment",
        fragment_idx=ordinal,
        start_cp=0,
        end_cp=1,
    )


def test_index_page_accepts_distinct_ascending_unit_refs() -> None:
    page = ReaderPublicationIndexPage(
        units=(_unit("units/0.json", 0), _unit("units/1.json", 1)),
        **_EMPTY_PAGE,
    )
    assert [unit.member.key for unit in page.units] == ["units/0.json", "units/1.json"]


def test_index_page_rejects_a_repeated_unit_ref() -> None:
    with pytest.raises(ValidationError, match="repeats a unit ref"):
        ReaderPublicationIndexPage(
            units=(_unit("units/0.json", 0), _unit("units/0.json", 1)),
            **_EMPTY_PAGE,
        )


@pytest.mark.parametrize("ordinals", [(1, 0), (0, 0)])
def test_index_page_rejects_units_that_do_not_ascend(ordinals: tuple[int, int]) -> None:
    with pytest.raises(ValidationError, match="ascend by ordinal"):
        ReaderPublicationIndexPage(
            units=tuple(
                _unit(f"units/{index}.json", ordinal) for index, ordinal in enumerate(ordinals)
            ),
            **_EMPTY_PAGE,
        )


def test_publication_find_scopes_a_full_length_publication_section() -> None:
    request = ReaderPublicationFindRequest.model_validate(
        {
            "query": "cafe\u0301",
            "match_case": False,
            "whole_word": True,
            "scope": {"kind": "Section", "section_id": "s" * 256},
        }
    )
    # The publication section id is a longer identity than the EPUB scope admits,
    # and the shared literal-find query still owns the query text.
    assert request.query == "caf\u00e9"
    assert request.after is None


def test_publication_find_rejects_a_query_with_a_line_break() -> None:
    with pytest.raises(ValidationError, match="line breaks"):
        ReaderPublicationFindRequest.model_validate(
            {
                "query": "one\ntwo",
                "match_case": False,
                "whole_word": False,
                "scope": {"kind": "EntireResource"},
            }
        )
