"""Shared retriever SQL fragments."""

from __future__ import annotations

from typing import Literal


def contributor_credits_rollup_cte_sql(owner_column: Literal["media_id", "podcast_id"]) -> str:
    """Return SQL for a CTE that pre-aggregates contributor credits per owner row.

    owner_column selects the `contributor_credits` foreign key to group by. It is a
    fixed internal literal, never user input, so interpolating it into SQL is safe.
    """
    return f"""
        SELECT
            cc.{owner_column},
            jsonb_agg(
                jsonb_build_object(
                    'id', cc.id,
                    'credited_name', cc.credited_name,
                    'role', cc.role,
                    'raw_role', cc.raw_role,
                    'ordinal', cc.ordinal,
                    'source', cc.source,
                    'contributor_handle', c.handle,
                    'contributor_display_name', c.display_name,
                    'href', '/authors/' || c.handle,
                    'contributor', jsonb_build_object(
                        'handle', c.handle,
                        'display_name', c.display_name,
                        'sort_name', c.sort_name,
                        'kind', c.kind,
                        'status', c.status,
                        'disambiguation', c.disambiguation
                    )
                )
                ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_credits,
            string_agg(
                concat_ws(
                    ' ',
                    cc.credited_name,
                    c.display_name,
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, '')
                ),
                ' '
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ') AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        LEFT JOIN (
            SELECT contributor_id, string_agg(external_key, ' ') AS external_ids
            FROM contributor_external_ids
            GROUP BY contributor_id
        ) external_id_text ON external_id_text.contributor_id = c.id
        WHERE cc.{owner_column} IS NOT NULL
          AND c.status NOT IN ('merged', 'tombstoned')
        GROUP BY cc.{owner_column}
    """
