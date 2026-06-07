"""Shared retriever SQL fragments."""

from __future__ import annotations

from typing import Literal

# Recency half-life term appended to the document hybrid score (media only). Notes omit
# it so a note's age never reorders it. Whitespace/placement here is load-bearing: the
# media query string must stay byte-identical (modulo whitespace) so document ranking is
# unchanged — see hybrid_content_chunk_tail_sql.
_RECENCY_DECAY_TERM = """
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )"""


def query_embedding_cte_sql(embedding_dims: int) -> str:
    """Return the `query_embedding` CTE body shared by the hybrid retrievers.

    `embedding_dims` is `transcript_embedding_dimensions()`, a fixed internal integer
    (never user input), so interpolating it into SQL is safe.
    """
    return f"""query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                )"""


def hybrid_content_chunk_tail_sql(
    *,
    leading_ctes: str,
    embedding_dims: int,
    scored_passthrough_columns: str,
    final_select_columns: str,
    order_by_id: str,
    include_recency_decay: bool,
) -> str:
    """Build the hybrid content-chunk retrieval query (lexical ∪ semantic).

    This is the single owner of the hybrid pipeline shared by document
    (`library_content._search_content_chunks`) and note-block
    (`notes._search_note_chunks`) search: the `semantic_candidates` / `lexical_candidates`
    / `candidate_ids` (UNION) / `scored_candidates` CTEs, the ANN candidate logic, the
    content_embeddings provider/model/dimensions join predicate, the 0.45/0.35/0.15 hybrid
    weight expression, the `min_semantic_similarity` floor, and the
    `WHERE lexical_score > 0.0 OR semantic_similarity >= :min_semantic_similarity` filter
    all live here exactly once.

    The caller supplies the owner-gated leading CTE block (everything from the first CTE
    through `eligible_chunks` and the `query_embedding` CTE, owner-gated and projecting its
    own columns), the extra `scored_candidates` pass-through columns, the extra final-SELECT
    columns, the `id` column to break ties on, and whether to apply the recency-decay term
    (True for documents, False for notes).

    `leading_ctes`, `scored_passthrough_columns`, `final_select_columns`, and `order_by_id`
    are caller-owned fixed internal SQL literals (never user input), so interpolating them is
    safe — mirroring contributor_credits_rollup_cte_sql. `embedding_dims` is a fixed integer.
    """
    recency_term = _RECENCY_DECAY_TERM if include_recency_decay else ""
    return f"""
            WITH
                {leading_ctes},
                semantic_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_dimensions = {embedding_dims}
                    JOIN query_embedding qe ON true
                    WHERE ec.active_embedding_provider = :query_embedding_provider
                      AND ec.active_embedding_model = :query_embedding_model
                    ORDER BY ce.embedding_vector <=> qe.embedding ASC, ec.id ASC
                    LIMIT :ann_limit
                ),
                lexical_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    WHERE ec.chunk_text_tsv @@ websearch_to_tsquery('english', :query)
                    ORDER BY
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query)) DESC,
                        ec.id ASC
                    LIMIT :ann_limit
                ),
                candidate_ids AS (
                    SELECT id FROM semantic_candidates
                    UNION
                    SELECT id FROM lexical_candidates
                ),
                scored_candidates AS (
                    SELECT
                        ec.id,
                        {scored_passthrough_columns}
                        CASE
                            WHEN ce.chunk_id IS NULL THEN 0.0
                            ELSE (1 - (ce.embedding_vector <=> qe.embedding))
                        END AS semantic_similarity,
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query))
                            AS lexical_score
                    FROM candidate_ids ci
                    JOIN eligible_chunks ec ON ec.id = ci.id
                    JOIN query_embedding qe ON true
                    LEFT JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_dimensions = {embedding_dims}
                        AND ec.active_embedding_provider = :query_embedding_provider
                        AND ec.active_embedding_model = :query_embedding_model
                )
            SELECT
                {final_select_columns}
                (
                    (0.45 * CASE WHEN lexical_score > 0.0 THEN 1.0 ELSE 0.0 END)
                    + (0.35 * GREATEST(semantic_similarity, 0.0))
                    + (0.15 * GREATEST(lexical_score, 0.0)){recency_term}
                ) AS raw_score
            FROM scored_candidates
            WHERE
                lexical_score > 0.0
                OR semantic_similarity >= :min_semantic_similarity
            ORDER BY raw_score DESC, {order_by_id} ASC
            LIMIT :limit
        """


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
