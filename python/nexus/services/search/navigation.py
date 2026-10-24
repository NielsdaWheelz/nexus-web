"""Literal name navigation for direct preview, independent of text relevance.

The caller authorizes scope and owns the read snapshot. Canonical eligibility
retains filters and visibility; aliases belong only to admitted contributors.
Each stored name/alias is matched independently using Unicode casefold, without
compatibility or accent normalization. Distinct refs precede the four-row limit.
Canonical items own body and activation; evidence preserves the matched literal
and original codepoint ranges, expanded to complete graphemes.
Blank filtered reads retain canonical listable-family browse order and have no
match metadata; the caller skips blank unfiltered reads.
"""

from collections.abc import Sequence
from dataclasses import dataclass

import regex
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.search import NameMatch, SearchMatchOut, SearchMatchRangeOut, SearchResourceOut
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.items import excerpt_window, resource_items_out
from nexus.services.search.sources import Retrieval, discovery_browse, discovery_eligible

_FAMILIES = frozenset(
    {
        "media",
        "podcast",
        "contributor",
        "page",
        "conversation",
        "library",
        "oracle_reading",
        "dossier",
    }
)
_TIERS = {"exact": 0, "prefix": 1, "substring": 2}


@dataclass(frozen=True, slots=True)
class _Name:
    ref: ResourceRef
    label: str
    literal: str
    tier: NameMatch
    canonical: bool

    @property
    def variant_order(self) -> tuple[int, bool, str, str]:
        return _TIERS[self.tier], not self.canonical, self.literal.casefold(), self.literal

    @property
    def order(self) -> tuple[int, str, str]:
        return _TIERS[self.tier], self.label.casefold(), self.ref.uri


def _evidence(literal: str, query: str) -> SearchMatchOut | None:
    folded = query.casefold()
    begin = literal.casefold().find(folded)
    assert begin >= 0 and folded
    end = begin + len(folded)
    offset = 0
    start = stop = None
    for cluster in regex.finditer(r"\X", literal):
        following = offset + len(cluster.group().casefold())
        if offset <= begin < following:
            start = cluster.start()
        if offset < end <= following:
            stop = cluster.end()
            break
        offset = following
    assert start is not None and stop is not None
    actual_start, excerpt = excerpt_window(literal, start=start)
    stop = min(stop, actual_start + len(excerpt.text))
    if stop <= start:
        return None
    return SearchMatchOut(
        excerpt=excerpt,
        ranges=[SearchMatchRangeOut(start=start - actual_start, end=stop - actual_start)],
    )


def resources(db: Session, r: Retrieval, families: Sequence[str]) -> list[SearchResourceOut]:
    """At most four literal name matches, hydrated only after selection."""
    families = tuple(family for family in families if family in _FAMILIES)
    if not families:
        return []
    if not r.terms:
        selected = discovery_browse(db, r, families)[:4]
        items = resource_items_out(db, viewer_id=r.viewer_id, refs=[hit.ref for hit in selected])
        if any(item.missing for item in items):
            raise RuntimeError("visible navigation resource missing from canonical item projection")
        return [
            SearchResourceOut(
                section="primary",
                item=item,
                name_match=None,
                match=None,
                match_method=None,
                matching_passage=None,
            )
            for item in items
        ]
    prefix, params = discovery_eligible(r, families)
    rows = db.execute(
        text(
            prefix
            + """,
        navigation_names AS MATERIALIZED (
            SELECT ref,family,CASE
                WHEN family='dossier' THEN COALESCE(discovery_name,'Dossier — Note')
                WHEN family='conversation' THEN COALESCE(NULLIF(name,''),'Untitled conversation')
                ELSE COALESCE(NULLIF(name,''),'Untitled') END AS literal
            FROM eligible),
        navigation_variants AS (
            SELECT ref,family,CASE WHEN family='oracle_reading' THEN left(literal,601)
                ELSE literal END AS label,literal,true AS canonical FROM navigation_names
            UNION ALL
            SELECT n.ref,n.family,n.literal AS label,a.alias AS literal,false AS canonical
            FROM navigation_names n JOIN contributor_aliases a
                ON n.family='contributor' AND n.ref='contributor:' || a.contributor_id::text)
        SELECT ref,label,literal,canonical FROM navigation_variants"""
        ),
        params,
    ).mappings()
    folded = r.terms.casefold()
    best: dict[str, _Name] = {}
    for row in rows:
        name = row["literal"].casefold()
        begin = name.find(folded)
        if begin < 0:
            continue
        tier: NameMatch = "exact" if name == folded else "prefix" if begin == 0 else "substring"
        match = _Name(
            assert_resource_ref(row["ref"]), row["label"], row["literal"], tier, row["canonical"]
        )
        previous = best.get(match.ref.uri)
        if previous is None or match.variant_order < previous.variant_order:
            best[match.ref.uri] = match
    selected = sorted(best.values(), key=lambda name: name.order)[:4]
    items = resource_items_out(db, viewer_id=r.viewer_id, refs=[name.ref for name in selected])
    out = []
    for name, item in zip(selected, items, strict=True):
        if item.missing or item.ref != name.ref.uri:
            raise RuntimeError("visible navigation resource missing from canonical item projection")
        out.append(
            SearchResourceOut(
                section="primary",
                item=item,
                name_match=name.tier,
                match=_evidence(name.literal, r.terms),
                match_method="lexical",
                matching_passage=None,
            )
        )
    return out
