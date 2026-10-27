"""One hop from an exact graph endpoint to the object that owns it.

Media, podcasts, pages and note blocks own themselves. Highlights, fragments,
apparatus items, evidence spans, content chunks and passage anchors resolve to
the media or note block they belong to. An endpoint whose row is gone keeps its
own identity, so it can only match itself.

Direct owner refs need no lookup. A known derived subset joins only its families;
generic graph reads keep the complete six-family lookup.
correlated type guards keep unrelated endpoint families out of each child lookup.
offset 0 prevents the planner from flattening those guards into the joins.
"""

from collections.abc import Collection

_DERIVED_OWNERS = {
    "highlight": (
        "LEFT JOIN LATERAL (SELECT h.anchor_media_id FROM highlights h\n"
        "          WHERE e.scheme = 'highlight' AND h.id = e.id OFFSET 0) h ON true",
        None,
        "h.anchor_media_id",
    ),
    "fragment": (
        "LEFT JOIN LATERAL (SELECT f.media_id FROM fragments f\n"
        "          WHERE e.scheme = 'fragment' AND f.id = e.id OFFSET 0) f ON true",
        None,
        "f.media_id",
    ),
    "reader_apparatus_item": (
        "LEFT JOIN LATERAL (SELECT rai.media_id FROM reader_apparatus_items rai\n"
        "          WHERE e.scheme = 'reader_apparatus_item' AND rai.id = e.id "
        "OFFSET 0) rai ON true",
        None,
        "rai.media_id",
    ),
    "evidence_span": (
        "LEFT JOIN LATERAL (SELECT es.owner_kind, es.owner_id FROM evidence_spans es\n"
        "          WHERE e.scheme = 'evidence_span' AND es.id = e.id OFFSET 0) es ON true",
        "es.owner_kind",
        "es.owner_id",
    ),
    "content_chunk": (
        "LEFT JOIN LATERAL (SELECT cc.owner_kind, cc.owner_id FROM content_chunks cc\n"
        "          WHERE e.scheme = 'content_chunk' AND cc.id = e.id OFFSET 0) cc ON true",
        "cc.owner_kind",
        "cc.owner_id",
    ),
    "passage_anchor": (
        "LEFT JOIN LATERAL (SELECT pa.owner_scheme, pa.owner_id FROM passage_anchors pa\n"
        "          WHERE e.scheme = 'passage_anchor' AND pa.id = e.id OFFSET 0) pa ON true",
        "pa.owner_scheme",
        "pa.owner_id",
    ),
}
DERIVED_SCHEMES = frozenset(_DERIVED_OWNERS)


def _coalesce(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else f"COALESCE({', '.join(parts)})"


def owner_rows_sql(endpoints: str, *, derived_schemes: Collection[str] | None = None) -> str:
    """``endpoints`` is checked-in SQL yielding ``(scheme, id)``; the result adds
    ``owner_scheme`` and ``owner_id``. Binds nothing of its own. Omitted
    ``derived_schemes`` retains the generic six-family lookup."""
    families = [
        columns
        for scheme, columns in _DERIVED_OWNERS.items()
        if derived_schemes is None or scheme in derived_schemes
    ]
    media_ids = [owner_id for _, owner_scheme, owner_id in families if owner_scheme is None]
    owner_kinds = [owner_scheme for _, owner_scheme, _ in families if owner_scheme is not None]
    owner_scheme = _coalesce([*owner_kinds, "e.scheme"])
    if media_ids:
        owner_scheme = (
            f"CASE WHEN {_coalesce(media_ids)} IS NOT NULL THEN 'media' ELSE {owner_scheme} END"
        )
    owner_id = _coalesce([*(columns[2] for columns in families), "e.id"])
    joins = "\n        ".join(columns[0] for columns in families)
    return f"""
        SELECT
            e.scheme,
            e.id,
            {owner_scheme} AS owner_scheme,
            {owner_id} AS owner_id
        FROM ({endpoints}) e
        {joins}
    """
