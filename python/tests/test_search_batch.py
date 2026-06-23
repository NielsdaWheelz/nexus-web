"""Unit coverage for the multi-scope executor (spec §5.6 / §15).

``search_scopes`` runs ``base`` against each scope, unions the rows, dedupes by
``(result.type, str(result.id))`` keeping the max score, sorts by ``(-score,
str(id))``, and caps at the shared result limit with a default page. We
monkeypatch the ``search`` symbol ``batch.py`` imports so ``fake_search`` returns
canned, scope-keyed responses — no DB, pure merge/sort/cap behavior.
"""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID, uuid4

import pytest

from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultContextRefOut,
    SearchResultConversationOut,
    SearchResultOut,
)
from nexus.services.search import batch
from nexus.services.search.constants import MAX_LIMIT
from nexus.services.search.query import SearchQuery, SearchScope

pytestmark = pytest.mark.unit

FakeSearch = Callable[[object, object, SearchQuery], SearchResponse]


def _conversation_result(result_id: UUID, score: float) -> SearchResultOut:
    """Construct a minimal valid ``conversation`` result — the simplest variant
    (just the shared envelope plus type/id)."""
    resource_ref = f"conversation:{result_id}"
    return SearchResultConversationOut(
        type="conversation",
        id=result_id,
        score=score,
        snippet="snippet",
        title="title",
        resource_ref=resource_ref,
        activation={
            "resourceRef": resource_ref,
            "kind": "route",
            "href": f"/conversations/{result_id}",
        },
        citation_target=None,
        context_ref=SearchResultContextRefOut(type="conversation", id=result_id),
    )


def _run(
    monkeypatch: pytest.MonkeyPatch,
    fake_search: FakeSearch,
    base: SearchQuery,
    scopes: list[SearchScope],
) -> SearchResponse:
    """Patch the module-level ``search`` symbol batch.py imports, then invoke the
    real ``search_scopes``."""
    monkeypatch.setattr("nexus.services.search.batch.search", fake_search)
    return batch.search_scopes(None, uuid4(), base, scopes)


def test_union_across_scopes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Results from two different scopes both appear in the merged output."""
    media_id = uuid4()
    library_id = uuid4()
    conv_a = uuid4()
    conv_b = uuid4()

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        if query.scope.kind == "media":
            return SearchResponse(results=[_conversation_result(conv_a, 0.9)])
        if query.scope.kind == "library":
            return SearchResponse(results=[_conversation_result(conv_b, 0.8)])
        raise AssertionError(f"unexpected scope {query.scope!r}")

    base = SearchQuery(text="q")
    scopes = [SearchScope("media", media_id), SearchScope("library", library_id)]

    response = _run(monkeypatch, fake_search, base, scopes)
    ids = {str(result.id) for result in response.results}
    assert ids == {str(conv_a), str(conv_b)}


def test_dedupe_keeps_max_score(monkeypatch: pytest.MonkeyPatch) -> None:
    """The same (type, id) returned by two scopes appears once, with the higher score."""
    shared_id = uuid4()

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        if query.scope.kind == "media":
            return SearchResponse(results=[_conversation_result(shared_id, 0.3)])
        if query.scope.kind == "library":
            return SearchResponse(results=[_conversation_result(shared_id, 0.7)])
        raise AssertionError(f"unexpected scope {query.scope!r}")

    base = SearchQuery(text="q")
    scopes = [SearchScope("media", uuid4()), SearchScope("library", uuid4())]

    response = _run(monkeypatch, fake_search, base, scopes)
    assert len(response.results) == 1
    assert str(response.results[0].id) == str(shared_id)
    assert response.results[0].score == pytest.approx(0.7)


def test_dedupe_max_score_independent_of_scope_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """Max-score wins even when the higher score is contributed by the FIRST scope —
    proves the keep is a score comparison, not last-write-wins."""
    shared_id = uuid4()

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        score = 0.95 if query.scope.kind == "media" else 0.1
        return SearchResponse(results=[_conversation_result(shared_id, score)])

    base = SearchQuery(text="q")
    scopes = [SearchScope("media", uuid4()), SearchScope("library", uuid4())]

    response = _run(monkeypatch, fake_search, base, scopes)
    assert len(response.results) == 1
    assert response.results[0].score == pytest.approx(0.95)


def test_sort_by_score_then_id_tiebreak(monkeypatch: pytest.MonkeyPatch) -> None:
    """Output ordered by (-score, str(id)); a score tie falls back to str(id)."""
    high = uuid4()
    # Two tied-score ids; sort tiebreak is on str(id), so derive expected order.
    tie_one = uuid4()
    tie_two = uuid4()
    lower, higher = sorted((tie_one, tie_two), key=str)

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        if query.scope.kind == "media":
            return SearchResponse(
                results=[
                    _conversation_result(high, 0.9),
                    _conversation_result(tie_one, 0.5),
                ]
            )
        if query.scope.kind == "library":
            return SearchResponse(results=[_conversation_result(tie_two, 0.5)])
        raise AssertionError(f"unexpected scope {query.scope!r}")

    base = SearchQuery(text="q")
    scopes = [SearchScope("media", uuid4()), SearchScope("library", uuid4())]

    response = _run(monkeypatch, fake_search, base, scopes)
    ordered_ids = [str(result.id) for result in response.results]
    # Highest score first; then the two tied rows ordered by str(id).
    assert ordered_ids == [str(high), str(lower), str(higher)]


def test_cap_truncates_to_base_limit_and_page_is_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """More unique rows than base.limit ⇒ truncated to limit; page is default
    (multi-scope is intentionally unpaginated)."""
    # Five unique rows with strictly descending scores so order is unambiguous.
    rows = [(uuid4(), score) for score in (0.9, 0.8, 0.7, 0.6, 0.5)]

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        if query.scope.kind == "media":
            return SearchResponse(results=[_conversation_result(rid, s) for rid, s in rows[:3]])
        if query.scope.kind == "library":
            return SearchResponse(results=[_conversation_result(rid, s) for rid, s in rows[3:]])
        raise AssertionError(f"unexpected scope {query.scope!r}")

    base = SearchQuery(text="q", limit=2)
    scopes = [SearchScope("media", uuid4()), SearchScope("library", uuid4())]

    response = _run(monkeypatch, fake_search, base, scopes)
    assert len(response.results) == 2
    # The two highest-scoring rows survive the cap.
    assert [str(r.id) for r in response.results] == [str(rows[0][0]), str(rows[1][0])]
    # Default page: unpaginated.
    assert response.page == SearchPageInfo()
    assert response.page.has_more is False
    assert response.page.next_cursor is None


def test_cap_honors_shared_max_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [(uuid4(), 1.0 - index / 100) for index in range(MAX_LIMIT + 5)]

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        if query.scope.kind != "media":
            raise AssertionError(f"unexpected scope {query.scope!r}")
        return SearchResponse(results=[_conversation_result(rid, score) for rid, score in rows])

    response = _run(
        monkeypatch,
        fake_search,
        SearchQuery(text="q", limit=MAX_LIMIT + 100),
        [SearchScope("media", uuid4())],
    )

    assert len(response.results) == MAX_LIMIT


def test_per_scope_scope_is_honored_via_replace(monkeypatch: pytest.MonkeyPatch) -> None:
    """``replace(base, scope=scope)`` is honored: fake_search sees each per-scope
    ``SearchScope`` while the other base fields are preserved."""
    media_id = uuid4()
    library_id = uuid4()
    seen: list[SearchScope] = []

    def fake_search(db: object, viewer_id: object, query: SearchQuery) -> SearchResponse:
        seen.append(query.scope)
        # base fields outside `scope` survive the replace().
        assert query.text == "hello"
        assert query.limit == 5
        # Return a scope-specific row so the per-scope identity is observable.
        return SearchResponse(results=[_conversation_result(query.scope.id, 0.5)])

    base = SearchQuery(text="hello", limit=5)
    scopes = [SearchScope("media", media_id), SearchScope("library", library_id)]

    response = _run(monkeypatch, fake_search, base, scopes)
    assert seen == scopes
    # Distinct scope ids ⇒ two distinct conversation rows in the union.
    assert {str(r.id) for r in response.results} == {str(media_id), str(library_id)}
