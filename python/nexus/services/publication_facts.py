"""Publisher evidence shared by freshness admission and the ordinary media identity.

Bibliographic dates may be enriched independently. These facts come only from feed
publication claims or the reader publication's source and retain their precision.
"""


def earliest_publisher_fact_sql(*, media_id_sql: str, time_zone_sql: str) -> str:
    """One earliest credible fact, comparing civil-day lower bounds in the given zone."""
    return f"""
        SELECT published_at,published_on FROM (
            SELECT fe.published_at,fe.published_on
            FROM feed_entries fe WHERE fe.media_id={media_id_sql}
              AND fe.publication_evidence='publisher'
            UNION ALL
            SELECT rp.publisher_published_at,rp.publisher_published_on
            FROM reader_publications rp WHERE rp.media_id={media_id_sql}
        ) facts
        WHERE published_at IS NOT NULL OR published_on IS NOT NULL
        ORDER BY COALESCE(published_at,published_on::timestamp AT TIME ZONE {time_zone_sql}),
                 published_at NULLS FIRST
        LIMIT 1
    """
