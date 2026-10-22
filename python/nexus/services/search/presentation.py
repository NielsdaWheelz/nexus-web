"""Literal bounded search evidence layered on canonical resource items and activations."""

import re
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_items import ExcerptOut, ResourceItemOut
from nexus.schemas.search import SearchMatchOut, SearchMatchRangeOut
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.items import excerpt, note_display_texts, resource_items_out
from nexus.services.search.sources import DiscoveryHit, discovery_texts


def present_matches(
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    hits: Sequence[DiscoveryHit],
    terms: str,
) -> dict[str, tuple[ResourceItemOut, SearchMatchOut | None]]:
    """Hydrate selected identities once; excerpt truncation never changes their targets."""
    items = resource_items_out(db, viewer_id=viewer_id, refs=list(dict.fromkeys(refs)))
    texts = discovery_texts(db, viewer_id, hits) if terms else {}
    texts.update(
        (f"note_block:{identity}", value)
        for identity, value in note_display_texts(
            db, viewer_id=viewer_id, note_ids=[h.ref.id for h in hits if h.family == "note_block"]
        ).items()
    )
    words = list(dict.fromkeys(re.findall(r"\w+", terms)))
    pattern = (
        re.compile("|".join(re.escape(word) for word in words), re.IGNORECASE) if words else None
    )
    presented: dict[str, tuple[ResourceItemOut, SearchMatchOut | None]] = {}
    for item in items:
        if item.missing:
            # justify-defect: the same snapshot's visible relation proved this resource exists.
            raise RuntimeError(
                f"Visible discovery resource missing from item projection: {item.ref}"
            )
        body = item.preview.body
        exact = texts.get(item.ref, "")
        title = item.label if body.kind in ("media", "named") else None
        if exact == title:
            exact = ""  # The title already shows the complete direct-name evidence.
        found = pattern.search(exact) if pattern else None
        start = max(0, found.start() - 160) if found else 0
        if start and found:
            space = exact.find(" ", start, found.start())
            if space >= 0:
                start = space + 1
        shown = excerpt(exact[start:], 600)
        shown = ExcerptOut(
            text=shown.text, truncated_before=start > 0, truncated_after=shown.truncated_after
        )
        if exact and body.kind == "passage":
            body = body.model_copy(
                update={
                    "exact": shown,
                    "prefix": excerpt(exact[:start], 48, tail=True) if start else body.prefix,
                    "suffix": None if shown.truncated_after else body.suffix,
                }
            )
        elif exact and body.kind == "prose":
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
        match = SearchMatchOut(excerpt=shown, ranges=ranges) if shown.text else None
        presented[item.ref] = item, match
    return presented
