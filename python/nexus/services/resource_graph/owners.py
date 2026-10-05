"""One hop from an exact graph endpoint to the object that owns it.

Media, podcasts, pages and note blocks own themselves. Highlights, fragments,
apparatus items, evidence spans, content chunks and passage anchors resolve to
the media or note block they belong to. An endpoint whose row is gone keeps its
own identity, so it can only match itself.
"""


def owner_rows_sql(endpoints: str) -> str:
    """``endpoints`` is checked-in SQL yielding ``(scheme, id)``; the result adds
    ``owner_scheme`` and ``owner_id``. Binds nothing of its own."""
    return f"""
        SELECT
            e.scheme,
            e.id,
            CASE WHEN COALESCE(h.anchor_media_id, f.media_id, rai.media_id) IS NOT NULL
                THEN 'media'
                ELSE COALESCE(es.owner_kind, cc.owner_kind, pa.owner_scheme, e.scheme)
            END AS owner_scheme,
            COALESCE(
                h.anchor_media_id, f.media_id, rai.media_id,
                es.owner_id, cc.owner_id, pa.owner_id, e.id
            ) AS owner_id
        FROM ({endpoints}) e
        LEFT JOIN highlights h ON e.scheme = 'highlight' AND h.id = e.id
        LEFT JOIN fragments f ON e.scheme = 'fragment' AND f.id = e.id
        LEFT JOIN reader_apparatus_items rai
          ON e.scheme = 'reader_apparatus_item' AND rai.id = e.id
        LEFT JOIN evidence_spans es ON e.scheme = 'evidence_span' AND es.id = e.id
        LEFT JOIN content_chunks cc ON e.scheme = 'content_chunk' AND cc.id = e.id
        LEFT JOIN passage_anchors pa ON e.scheme = 'passage_anchor' AND pa.id = e.id
    """
