"""Shared ``resource_edges`` fact SQL for graph-derived reads.

``edge_fact_rows_sql`` exposes the viewer-owned edge rows for a caller-supplied
origin allowlist. Directional interpretation, owner normalization, and
recommendation policy remain with the composing consumer.
"""

from __future__ import annotations


def edge_fact_rows_sql() -> str:
    """Viewer-owned edge facts for a caller-supplied origin allowlist.

    Binds ``:viewer_id`` and ``:edge_origins``. Columns are ``edge_id``,
    ``edge_kind``, ``edge_origin``, ``source_scheme``, ``source_id``,
    ``target_scheme``, ``target_id``, and ``created_at``.
    """
    return """
        SELECT
            e.id AS edge_id,
            e.kind AS edge_kind,
            e.origin AS edge_origin,
            e.source_scheme,
            e.source_id,
            e.target_scheme,
            e.target_id,
            e.created_at
        FROM resource_edges e
        WHERE e.user_id = :viewer_id
          AND e.origin = ANY(:edge_origins)
    """
