"""Search occurrence emphasis layered on the shared bounded resource body."""

import re
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_items import ExcerptOut
from nexus.schemas.search import (
    SearchMatchOut,
    SearchMatchRangeOut,
    SearchResponse,
    SearchResultOut,
)
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.resource_items.items import excerpt, note_display_texts, resource_items_out
from nexus.services.search.candidates import SearchResponse as Candidates


def search_response(
    db: Session, *, viewer_id: UUID, candidates: Candidates, terms: str
) -> SearchResponse:
    items = resource_items_out(
        db,
        viewer_id=viewer_id,
        refs=[assert_resource_ref(c.resource_ref) for c in candidates.results],
    )
    words = list(dict.fromkeys(word for word in re.findall(r"\w+", terms) if word))
    pattern = (
        re.compile("|".join(re.escape(word) for word in words), re.IGNORECASE) if words else None
    )
    note_texts = note_display_texts(
        db,
        viewer_id=viewer_id,
        note_ids=[
            assert_resource_ref(c.resource_ref).id
            for c in candidates.results
            if c.type == "note_block"
        ],
    )
    results = []
    for candidate, item in zip(candidates.results, items, strict=True):
        body = item.preview.body
        quote = candidate.captured_evidence.quote
        exact = (
            note_texts.get(assert_resource_ref(candidate.resource_ref).id, "")
            if candidate.type == "note_block"
            else quote.exact
            if quote
            else candidate.snippet
        )
        match = pattern.search(exact) if pattern else None
        start = max(0, match.start() - 160) if match else 0
        if start and match:
            space = exact.find(" ", start, match.start())
            if space >= 0:
                start = space + 1
        shown = excerpt(exact[start:], 600)
        shown = ExcerptOut(
            text=shown.text, truncated_before=start > 0, truncated_after=shown.truncated_after
        )
        if body.kind == "passage":
            prefix = excerpt(exact[:start], 48, tail=True) if start else body.prefix
            suffix = None if shown.truncated_after else body.suffix
            body = body.model_copy(update={"exact": shown, "prefix": prefix, "suffix": suffix})
        elif body.kind == "prose":
            body = body.model_copy(update={"excerpt": shown})
        item = item.model_copy(update={"preview": item.preview.model_copy(update={"body": body})})
        ranges = (
            [
                SearchMatchRangeOut(start=m.start(), end=m.end())
                for m in pattern.finditer(shown.text)
            ]
            if pattern
            else []
        )
        evidence = (
            SearchMatchOut(excerpt=shown, ranges=ranges)
            if shown.text and (body.kind in ("passage", "prose") or ranges)
            else None
        )
        results.append(
            SearchResultOut(
                type=candidate.type,
                id=candidate.id,
                score=candidate.score,
                item=item,
                match=evidence,
                context_ref=candidate.context_ref,
                locator=getattr(candidate, "locator", None),
                citation_target=candidate.citation_target,
            )
        )
    return SearchResponse(results=results, page=candidates.page)
