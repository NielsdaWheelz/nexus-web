-- Frozen pre-cutover global hybrid document query; compare in one PostgreSQL snapshot.

            WITH
                visible_media AS (
        SELECT m.id AS media_id
        FROM media m
        WHERE (
            EXISTS (
                SELECT 1
                FROM library_entries le
                JOIN memberships membership
                  ON membership.library_id = le.library_id
                WHERE membership.user_id = :viewer_id
                  AND le.media_id = m.id
            )
            OR EXISTS (
        SELECT 1
        FROM resource_grants media_grant_path_g
        LEFT JOIN highlights media_grant_path_h
          ON media_grant_path_g.subject_scheme = 'highlight'
         AND media_grant_path_h.id = media_grant_path_g.subject_id
        WHERE (
            (
              media_grant_path_g.subject_scheme = 'media'
              AND media_grant_path_g.subject_id = m.id
            )
            OR media_grant_path_h.anchor_media_id = m.id
          )
          AND (
            media_grant_path_g.grantee_user_id = :viewer_id
            OR media_grant_path_g.created_by_user_id = :viewer_id
          )
    )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM user_media_deletions umd
              WHERE umd.user_id = :viewer_id
                AND umd.media_id = m.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM media_teardown_intents mti
              WHERE mti.media_id = m.id
          )
    ),
                media_contributor_credits AS (
        SELECT
            cc.media_id,
            jsonb_agg(
                jsonb_build_object(
                    'credited_name', cc.credited_name,
                    'role', cc.role,
                    'raw_role', cc.raw_role,
                    'ordinal', cc.ordinal,
                    'contributor_handle', c.handle,
                    'contributor_display_name', c.display_name,
                    'href', '/authors/' || c.handle
                )
                ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_credits,
            string_agg(
                concat_ws(
                    ' ',
                    cc.credited_name,
                    c.display_name,
                    COALESCE(alias_text.aliases, '')
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
        WHERE cc.media_id IS NOT NULL
        GROUP BY cc.media_id
    ),
                query_embedding AS (
                    SELECT CAST(:query_embedding AS vector(256)) AS embedding
                ),
                eligible_chunks AS (
                    SELECT
                        cc.id,
                        cc.owner_id AS media_id,
                        m.kind,
                        m.title,
                        m.original_published_date,
                        mcc.contributor_credits,
                        cc.chunk_text,
                        ts_headline(
                            'english',
                            cc.chunk_text,
                            websearch_to_tsquery('english', :query),
                            'MaxWords=50, MinWords=10, MaxFragments=1'
                        ) AS snippet,
                        cc.source_kind,
                        cc.primary_evidence_span_id,
                        cc.summary_locator,
                        cc.created_at,
                        cc.chunk_text_tsv,
                        mcis.active_embedding_provider,
                        mcis.active_embedding_model
                    FROM content_chunks cc
                    JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                    JOIN visible_media vm ON vm.media_id = cc.owner_id
                    JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                        AND mcis.owner_id = cc.owner_id
                        AND mcis.status = 'ready'
                    LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                    WHERE TRUE



                ),
                semantic_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_dimensions = 256
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
                        ec.media_id,
                        ec.kind,
                        ec.title,
                        ec.original_published_date,
                        ec.contributor_credits,
                        ec.chunk_text,
                        ec.snippet,
                        ec.source_kind,
                        ec.primary_evidence_span_id,
                        ec.summary_locator,
                        ec.created_at,
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
                        AND ce.embedding_dimensions = 256
                        AND ec.active_embedding_provider = :query_embedding_provider
                        AND ec.active_embedding_model = :query_embedding_model
                )
            SELECT
                id,
                media_id,
                kind,
                title,
                original_published_date,
                contributor_credits,
                chunk_text,
                snippet,
                source_kind,
                primary_evidence_span_id,
                summary_locator,
                (
                    (0.45 * CASE WHEN lexical_score > 0.0 THEN 1.0 ELSE 0.0 END)
                    + (0.35 * GREATEST(semantic_similarity, 0.0))
                    + (0.15 * GREATEST(lexical_score, 0.0))
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )
                ) AS raw_score
            FROM scored_candidates
            WHERE
                lexical_score > 0.0
                OR semantic_similarity >= :min_semantic_similarity
            ORDER BY raw_score DESC, id ASC
            LIMIT :limit
