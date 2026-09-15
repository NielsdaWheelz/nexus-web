"""Fragment bodies belong to the selected page, with unchanged locators."""

from types import SimpleNamespace
from uuid import UUID

import pytest

from nexus.schemas.search import SearchResultSourceOut
from nexus.services.search import projection, service
from nexus.services.search.cursor import encode_search_cursor
from nexus.services.search.query import SearchQuery
from nexus.services.search.results import _RankedFragmentResult, _SearchScore
from nexus.services.search.retrievers import fragments

VIEWER = UUID(int=1)
MEDIA = UUID(int=2)


def test_search_materializes_only_the_selected_fragment_page(monkeypatch):
    source = SearchResultSourceOut(
        media_id=MEDIA,
        media_kind="epub",
        title="book",
        original_published_date={"kind": "Absent"},
    )
    candidates = [
        _RankedFragmentResult(UUID(int=10 + i), i, "pillow", source, _SearchScore(1))
        for i in range(4)
    ]
    reads = []
    body = "the pillow book " * 100

    def read_content(db, *, viewer_id, result):
        assert viewer_id == VIEWER and result.query == "pillow"
        reads.append(result.id)
        return "the <b>pillow</b> book", projection._direct_fragment_locator(
            media_id=MEDIA,
            media_kind="epub",
            fragment_id=result.id,
            text_value=body,
            start_offset=0,
            end_offset=len(body),
            exact=body,
        )

    monkeypatch.setattr(service, "_query_has_full_text_terms", lambda *_: True)
    monkeypatch.setattr(service, "discovery_candidates", lambda *_, **__: candidates)
    monkeypatch.setattr(service, "_enrich_results_with_media_summaries", lambda *_: None)
    monkeypatch.setattr(fragments, "read_fragment_search_content", read_content)
    monkeypatch.setattr(
        projection,
        "_result_model_fields",
        lambda db, viewer, result: {
            "title": "book",
            "resource_ref": f"fragment:{result.id}",
            "owner_resource_ref": f"media:{MEDIA}",
            "action_subject_ref": f"media:{MEDIA}",
            "activation": {"resource_ref": f"fragment:{result.id}", "kind": "route"},
            "citation_target": f"fragment:{result.id}",
            "context_ref": {"type": "fragment", "id": result.id},
        },
    )
    response = service.search(
        SimpleNamespace(in_transaction=lambda: False),
        VIEWER,
        SearchQuery(text="pillow", limit=1, cursor=encode_search_cursor(1)),
    )
    assert reads == [candidates[1].id]
    assert response.page.has_more
    result = response.results[0]
    assert result.snippet == "the <b>pillow</b> book"
    assert result.citation_label == "fragment 2"
    assert result.locator.end_offset == len(body)
    assert result.locator.text_quote_selector["exact"] == body


@pytest.mark.parametrize(
    ("kind", "body", "start", "end"),
    [
        ("epub", "text", None, None),
        ("article", "text", None, None),
        ("pdf", "text", None, None),
        ("epub", "", None, None),
        ("video", "text", 0, 10),
        ("video", "text", -1, 10),
        ("video", "text", 10, 10),
        ("video", "text", 11, 10),
        ("video", "text", None, 10),
        ("pdf", "text", 0, 10),
    ],
)
def test_metadata_admission_matches_fragment_locator(kind, body, start, end):
    fragment_id = UUID(int=3)
    row = (fragment_id, 0, len(body), start, end, MEDIA, kind, "book", None, [], 1.0)
    db = SimpleNamespace(execute=lambda *_: SimpleNamespace(fetchall=lambda: [row]))
    results = fragments._search_fragments(db, VIEWER, "text", "all", None, 200)
    locator = projection._direct_fragment_locator(
        media_id=MEDIA,
        media_kind=kind,
        fragment_id=fragment_id,
        text_value=body,
        start_offset=0,
        end_offset=len(body),
        exact=body,
        t_start_ms=start,
        t_end_ms=end,
    )
    assert bool(results) == (locator is not None)
