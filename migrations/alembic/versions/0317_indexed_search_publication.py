"""Publish current indexed search, lexical readiness and independent owner clocks.

Revision ID: 0317
Revises: 0316

Data effects: validate current ready materializations and stamp their lexical
revision without changing canonical text, identities, chunks, vectors or source
revisions. Other states start without lexical capability. Executable note-index
jobs acquire their owner's revision; deleted-note jobs settle superseded with
claims released. Terminal history remains unchanged. Refuse invalid ready spans,
missing note states or incomplete active-vector coverage; no repair or reindex.

Backfill keyword_occurrences from the surviving canonical families, including
viewer-scoped contributor text, in 256-identity batches. Dossier, removed author
editing and link-note paths are absent. The frozen SQL matches the current
projection contract without importing application code. Build the pinned native
index, apparatus lexical indexes and current-publication expression statistic.
Require preloaded pg_search 0.26.2 and matching catalog/binary versions.

Convert exactly one nonnegative legacy suggestion input to baseline:legacy,
preserving its actual revision and created_at. Its UUID is incidental; independent
source clocks and opaque deletion tombstones are created by subsequent writers.
The aggregate starts at the exact legacy revision. No append log or corpus sweep.
Writers must be stopped for this single transaction. Restore the verified
pre-release backup and matching code to downgrade.
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision: str = "0317"
down_revision: str | Sequence[str] | None = "0316"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TEXT_FIELDS = (
    "title",
    "body",
    "description",
    "publisher",
    "contributors",
    "prefix",
    "suffix",
    "url",
    "kind",
    "motto",
    "interpretation",
    "subject_title",
)

_COLUMNS = (
    "doc_key",
    "ref",
    "owner_ref",
    "family",
    "admission_key",
    "source_revision",
    "name",
    "discovery_name",
    "title",
    "body",
    "description",
    "publisher",
    "contributors",
    "prefix",
    "suffix",
    "url",
    "kind",
    "motto",
    "interpretation",
    "subject_title",
)

_SOURCE_IDS = {
    "media": "m.id",
    "podcast": "p.id",
    "contributor": "c.id",
    "page": "p.id",
    "note_block": "n.id",
    "highlight": "h.id",
    "conversation": "c.id",
    "message": "m.id",
    "reader_apparatus_item": "i.id",
    "fragment": "f.id",
    "content_chunk": "c.id",
    "web_result": "s.id",
    "library": "l.id",
    "oracle_reading": "r.id",
    "passage_anchor": "p.id",
}

_SOURCES = {
    "media": """SELECT 'media:' || (m.id)::text AS doc_key, 'media:' || (m.id)::text AS ref, 'media:' || (m.id)::text AS owner_ref, 'media'::text AS family, 'media:' || (m.id)::text AS admission_key, NULL::bigint AS source_revision, m.title AS name, NULL::text AS discovery_name, m.title AS title, NULL::text AS body, m.description AS description, m.publisher AS publisher, credits.contributor_search_text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM media m LEFT JOIN (
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
                concat_ws(' ', cc.credited_name, c.display_name, COALESCE(alias_text.aliases, '')),
                ' ' ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ' ORDER BY alias) AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        WHERE cc.media_id IS NOT NULL
        GROUP BY cc.media_id
    ) credits ON credits.media_id=m.id WHERE TRUE /*identity_filter*/""",
    "podcast": """SELECT 'podcast:' || (p.id)::text AS doc_key, 'podcast:' || (p.id)::text AS ref, 'podcast:' || (p.id)::text AS owner_ref, 'podcast'::text AS family, 'podcast:' || (p.id)::text AS admission_key, NULL::bigint AS source_revision, p.title AS name, NULL::text AS discovery_name, p.title AS title, NULL::text AS body, p.description AS description, NULL::text AS publisher, credits.contributor_search_text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM podcasts p LEFT JOIN (
        SELECT
            cc.podcast_id,
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
                concat_ws(' ', cc.credited_name, c.display_name, COALESCE(alias_text.aliases, '')),
                ' ' ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ' ORDER BY alias) AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        WHERE cc.podcast_id IS NOT NULL
        GROUP BY cc.podcast_id
    ) credits ON credits.podcast_id=p.id WHERE TRUE /*identity_filter*/""",
    "contributor": "SELECT 'contributor:' || CAST(:projection_viewer_id AS text) || ':' || (c.id)::text AS doc_key, 'contributor:' || (c.id)::text AS ref, 'contributor:' || (c.id)::text AS owner_ref, 'contributor'::text AS family, 'contributor:' || CAST(:projection_viewer_id AS text) || ':' || (c.id)::text AS admission_key, NULL::bigint AS source_revision, c.display_name AS name, NULL::text AS discovery_name, NULL::text AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, fts.search_text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM contributors c JOIN (\n        SELECT\n            c.id AS contributor_id,\n            concat_ws(\n                ' ',\n                c.display_name,\n                (\n                    SELECT string_agg(ca.alias, ' ' ORDER BY ca.alias ASC)\n                    FROM contributor_aliases ca\n                    WHERE ca.contributor_id = c.id\n                ),\n                (\n                    SELECT string_agg(DISTINCT vcc.credited_name, ' ' ORDER BY vcc.credited_name)\n                    FROM (\n        SELECT cc.*\n        FROM contributor_credits cc\n        WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL\n           OR cc.media_id IN (\n        WITH RECURSIVE eligible AS (SELECT m.id FROM media m WHERE TRUE AND NOT EXISTS (\n            SELECT 1 FROM user_media_deletions d\n            WHERE d.media_id = m.id AND d.user_id = :viewer_id) AND NOT EXISTS (\n            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = m.id)),\n        containment AS (\n        SELECT thread_media_id AS parent_media_id, post_media_id AS child_media_id\n        FROM x_thread_posts\n        UNION\n        SELECT de.media_id, de.target_media_id\n        FROM document_embeds de\n        JOIN x_post_sources xp ON xp.media_id = de.target_media_id\n        WHERE de.provider = 'x' AND de.resolution_status = 'resolved'\n          AND de.canonical_end_offset IS NOT NULL\n        UNION\n        SELECT source_media_id, media_id FROM media_parts\n    ),\n        reached(media_id) AS (\n            SELECT roots.media_id FROM (\n        SELECT le.media_id FROM library_entries le\n        JOIN memberships membership ON membership.library_id = le.library_id\n        WHERE membership.user_id = :viewer_id AND le.media_id IS NOT NULL\n        UNION\n        SELECT m.id FROM media m\n        WHERE EXISTS (\n        SELECT 1 FROM resource_grants media_grant_path_g\n        LEFT JOIN highlights media_grant_path_h\n          ON media_grant_path_g.subject_scheme = 'highlight'\n         AND media_grant_path_h.id = media_grant_path_g.subject_id\n        WHERE ((media_grant_path_g.subject_scheme = 'media'\n                AND media_grant_path_g.subject_id = m.id)\n               OR media_grant_path_h.anchor_media_id = m.id)\n          AND (media_grant_path_g.grantee_user_id = :viewer_id\n               OR media_grant_path_g.created_by_user_id = :viewer_id)\n    )\n        UNION\n        SELECT media_id FROM (\n        SELECT h.anchor_media_id AS media_id, h.user_id\n        FROM highlights h JOIN x_post_sources xp ON xp.media_id = h.anchor_media_id\n        UNION\n        SELECT pa.owner_id, pa.user_id\n        FROM passage_anchors pa JOIN x_post_sources xp ON xp.media_id = pa.owner_id\n        WHERE pa.owner_scheme = 'media'\n        UNION\n        SELECT mr.media_id, c.owner_user_id\n        FROM message_retrievals mr\n        JOIN x_post_sources xp ON xp.media_id = mr.media_id\n        JOIN messages msg ON msg.id = mr.assistant_message_id\n        JOIN conversations c ON c.id = msg.conversation_id\n        UNION\n        SELECT xp.media_id, c.owner_user_id\n        FROM messages msg\n        JOIN conversations c ON c.id = msg.conversation_id\n        JOIN x_post_sources xp\n          ON msg.reader_selection_snapshot #>> '{evidence,target,owner_ref}'\n             = 'media:' || xp.media_id::text\n        UNION\n        SELECT xp.media_id, re.user_id\n        FROM resource_edges re\n        JOIN x_post_sources xp\n          ON re.snapshot #>> '{evidence,target,owner_ref}' = 'media:' || xp.media_id::text\n        WHERE re.origin = 'citation' AND re.ordinal IS NOT NULL\n    ) retained\n        WHERE retained.user_id = :viewer_id\n    ) roots\n            JOIN eligible ON eligible.id = roots.media_id\n            UNION\n            SELECT edge.child_media_id\n            FROM reached JOIN containment edge ON edge.parent_media_id = reached.media_id\n            JOIN eligible ON eligible.id = edge.child_media_id\n        )\n        SELECT media_id FROM reached\n    )\n           OR cc.podcast_id IN (\n        SELECT ps.podcast_id FROM library_podcast_subscriptions ps\n        JOIN libraries l ON l.id=ps.library_id AND l.system_key IS NULL\n        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id\n        UNION\n        SELECT pe.podcast_id FROM podcast_episodes pe\n        WHERE pe.media_id IN (\n        WITH RECURSIVE eligible AS (SELECT m.id FROM media m WHERE TRUE AND NOT EXISTS (\n            SELECT 1 FROM user_media_deletions d\n            WHERE d.media_id = m.id AND d.user_id = :viewer_id) AND NOT EXISTS (\n            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = m.id)),\n        containment AS (\n        SELECT thread_media_id AS parent_media_id, post_media_id AS child_media_id\n        FROM x_thread_posts\n        UNION\n        SELECT de.media_id, de.target_media_id\n        FROM document_embeds de\n        JOIN x_post_sources xp ON xp.media_id = de.target_media_id\n        WHERE de.provider = 'x' AND de.resolution_status = 'resolved'\n          AND de.canonical_end_offset IS NOT NULL\n        UNION\n        SELECT source_media_id, media_id FROM media_parts\n    ),\n        reached(media_id) AS (\n            SELECT roots.media_id FROM (\n        SELECT le.media_id FROM library_entries le\n        JOIN memberships membership ON membership.library_id = le.library_id\n        WHERE membership.user_id = :viewer_id AND le.media_id IS NOT NULL\n        UNION\n        SELECT m.id FROM media m\n        WHERE EXISTS (\n        SELECT 1 FROM resource_grants media_grant_path_g\n        LEFT JOIN highlights media_grant_path_h\n          ON media_grant_path_g.subject_scheme = 'highlight'\n         AND media_grant_path_h.id = media_grant_path_g.subject_id\n        WHERE ((media_grant_path_g.subject_scheme = 'media'\n                AND media_grant_path_g.subject_id = m.id)\n               OR media_grant_path_h.anchor_media_id = m.id)\n          AND (media_grant_path_g.grantee_user_id = :viewer_id\n               OR media_grant_path_g.created_by_user_id = :viewer_id)\n    )\n        UNION\n        SELECT media_id FROM (\n        SELECT h.anchor_media_id AS media_id, h.user_id\n        FROM highlights h JOIN x_post_sources xp ON xp.media_id = h.anchor_media_id\n        UNION\n        SELECT pa.owner_id, pa.user_id\n        FROM passage_anchors pa JOIN x_post_sources xp ON xp.media_id = pa.owner_id\n        WHERE pa.owner_scheme = 'media'\n        UNION\n        SELECT mr.media_id, c.owner_user_id\n        FROM message_retrievals mr\n        JOIN x_post_sources xp ON xp.media_id = mr.media_id\n        JOIN messages msg ON msg.id = mr.assistant_message_id\n        JOIN conversations c ON c.id = msg.conversation_id\n        UNION\n        SELECT xp.media_id, c.owner_user_id\n        FROM messages msg\n        JOIN conversations c ON c.id = msg.conversation_id\n        JOIN x_post_sources xp\n          ON msg.reader_selection_snapshot #>> '{evidence,target,owner_ref}'\n             = 'media:' || xp.media_id::text\n        UNION\n        SELECT xp.media_id, re.user_id\n        FROM resource_edges re\n        JOIN x_post_sources xp\n          ON re.snapshot #>> '{evidence,target,owner_ref}' = 'media:' || xp.media_id::text\n        WHERE re.origin = 'citation' AND re.ordinal IS NOT NULL\n    ) retained\n        WHERE retained.user_id = :viewer_id\n    ) roots\n            JOIN eligible ON eligible.id = roots.media_id\n            UNION\n            SELECT edge.child_media_id\n            FROM reached JOIN containment edge ON edge.parent_media_id = reached.media_id\n            JOIN eligible ON eligible.id = edge.child_media_id\n        )\n        SELECT media_id FROM reached\n    )\n    )\n    ) vcc\n                    WHERE vcc.contributor_id = c.id\n                )\n            ) AS search_text\n        FROM contributors c\n    ) fts ON fts.contributor_id=c.id WHERE TRUE /*identity_filter*/",
    "page": """SELECT 'page:' || (p.id)::text AS doc_key, 'page:' || (p.id)::text AS ref, 'page:' || (p.id)::text AS owner_ref, 'page'::text AS family, 'page:' || (p.id)::text AS admission_key, NULL::bigint AS source_revision, p.title AS name, NULL::text AS discovery_name, p.title AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM pages p WHERE TRUE /*identity_filter*/""",
    "note_block": """SELECT 'note_block:' || (n.id)::text AS doc_key, 'note_block:' || (n.id)::text AS ref, 'note_block:' || (n.id)::text AS owner_ref, 'note_block'::text AS family, 'note_block:' || n.id::text || ':' || COALESCE(v.version,1)::text AS admission_key, COALESCE(v.version,1) AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, n.body_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM note_blocks n LEFT JOIN resource_versions v ON v.user_id=n.user_id AND v.resource_scheme='note_block' AND v.resource_id=n.id AND v.lane='body' WHERE n.body_text<>'' /*identity_filter*/""",
    "highlight": "SELECT 'highlight:' || reading.media_id::text || ':' || h.id::text AS doc_key, 'highlight:' || (h.id)::text AS ref, 'highlight:' || (h.id)::text AS owner_ref, 'highlight'::text AS family, 'highlight:' || reading.media_id::text || ':' || h.id::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, h.exact AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, CASE WHEN reading.media_id=h.anchor_media_id OR first_anchor.fragment_id IS NULL THEN COALESCE(h.prefix,'') ELSE right(COALESCE(h.prefix,''),GREATEST(first_anchor.start_offset-first_bound.lo,0)) END AS prefix, CASE WHEN reading.media_id=h.anchor_media_id OR last_anchor.fragment_id IS NULL THEN COALESCE(h.suffix,'') ELSE left(COALESCE(h.suffix,''),GREATEST(last_bound.hi-last_anchor.end_offset,0)) END AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM \n    highlights h\n    CROSS JOIN LATERAL (\n        SELECT h.anchor_media_id AS media_id\n        UNION ALL\n        SELECT part.media_id FROM media_parts part\n        WHERE part.source_media_id=h.anchor_media_id\n    ) reading\n    JOIN media reading_media ON reading_media.id=reading.media_id\n    LEFT JOIN LATERAL (\n        SELECT a.fragment_id,a.start_offset,f.idx FROM highlight_fragment_anchors a\n        JOIN fragments f ON f.id=a.fragment_id AND f.media_id=h.anchor_media_id\n        WHERE a.highlight_id=h.id ORDER BY f.idx,a.start_offset LIMIT 1\n    ) first_anchor ON true\n    LEFT JOIN LATERAL (\n        SELECT a.fragment_id,a.end_offset,f.idx FROM highlight_fragment_anchors a\n        JOIN fragments f ON f.id=a.fragment_id AND f.media_id=h.anchor_media_id\n        WHERE a.highlight_id=h.id ORDER BY f.idx DESC,a.end_offset DESC LIMIT 1\n    ) last_anchor ON true\n    LEFT JOIN LATERAL (\n        SELECT bounded.start_offset AS lo FROM (\n        SELECT m.id AS reading_media_id, COALESCE(p.source_media_id,m.id) AS source_media_id,\n               f.id AS fragment_id, f.idx AS fragment_idx,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.start_fragment_idx\n                    THEN p.start_offset ELSE 0 END AS start_offset,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.end_fragment_idx\n                    THEN p.end_offset ELSE char_length(f.canonical_text) END AS end_offset\n        FROM media m\n        JOIN (SELECT reading.media_id AS media_id) requested ON requested.media_id=m.id\n        LEFT JOIN media_parts p ON p.media_id=m.id\n        JOIN fragments f ON f.media_id=COALESCE(p.source_media_id,m.id)\n        WHERE p.media_id IS NULL OR f.idx BETWEEN p.start_fragment_idx AND p.end_fragment_idx\n    ) bounded\n        WHERE bounded.fragment_id=first_anchor.fragment_id LIMIT 1\n    ) first_bound ON true\n    LEFT JOIN LATERAL (\n        SELECT bounded.end_offset AS hi FROM (\n        SELECT m.id AS reading_media_id, COALESCE(p.source_media_id,m.id) AS source_media_id,\n               f.id AS fragment_id, f.idx AS fragment_idx,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.start_fragment_idx\n                    THEN p.start_offset ELSE 0 END AS start_offset,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.end_fragment_idx\n                    THEN p.end_offset ELSE char_length(f.canonical_text) END AS end_offset\n        FROM media m\n        JOIN (SELECT reading.media_id AS media_id) requested ON requested.media_id=m.id\n        LEFT JOIN media_parts p ON p.media_id=m.id\n        JOIN fragments f ON f.media_id=COALESCE(p.source_media_id,m.id)\n        WHERE p.media_id IS NULL OR f.idx BETWEEN p.start_fragment_idx AND p.end_fragment_idx\n    ) bounded\n        WHERE bounded.fragment_id=last_anchor.fragment_id LIMIT 1\n    ) last_bound ON true\n WHERE (reading.media_id=h.anchor_media_id OR (h.anchor_kind='fragment_offsets' AND reading.media_id<>h.anchor_media_id AND (\n        EXISTS (SELECT 1 FROM highlight_fragment_anchors shfa WHERE shfa.highlight_id=h.id)\n        AND NOT EXISTS (\n            SELECT 1 FROM highlight_fragment_anchors shfa\n            WHERE shfa.highlight_id=h.id AND NOT EXISTS (\n                SELECT 1 FROM (\n        SELECT m.id AS reading_media_id, COALESCE(p.source_media_id,m.id) AS source_media_id,\n               f.id AS fragment_id, f.idx AS fragment_idx,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.start_fragment_idx\n                    THEN p.start_offset ELSE 0 END AS start_offset,\n               CASE WHEN p.media_id IS NOT NULL AND f.idx=p.end_fragment_idx\n                    THEN p.end_offset ELSE char_length(f.canonical_text) END AS end_offset\n        FROM media m\n        JOIN (SELECT reading.media_id AS media_id) requested ON requested.media_id=m.id\n        LEFT JOIN media_parts p ON p.media_id=m.id\n        JOIN fragments f ON f.media_id=COALESCE(p.source_media_id,m.id)\n        WHERE p.media_id IS NULL OR f.idx BETWEEN p.start_fragment_idx AND p.end_fragment_idx\n    ) bounded\n                WHERE bounded.fragment_id=shfa.fragment_id\n                  AND bounded.start_offset<=shfa.start_offset AND bounded.end_offset>=shfa.end_offset\n            )\n        )\n    ))) /*identity_filter*/",
    "conversation": """SELECT 'conversation:' || (c.id)::text AS doc_key, 'conversation:' || (c.id)::text AS ref, 'conversation:' || (c.id)::text AS owner_ref, 'conversation'::text AS family, 'conversation:' || (c.id)::text AS admission_key, NULL::bigint AS source_revision, c.title AS name, NULL::text AS discovery_name, c.title AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM conversations c WHERE TRUE /*identity_filter*/""",
    "message": """SELECT 'message:' || (m.id)::text AS doc_key, 'message:' || (m.id)::text AS ref, 'conversation:' || m.conversation_id::text AS owner_ref, 'message'::text AS family, 'message:' || (m.id)::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, m.content AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM messages m WHERE m.status='complete' AND m.content<>'' /*identity_filter*/""",
    "reader_apparatus_item": """SELECT 'reader_apparatus_item:' || (i.id)::text AS doc_key, 'reader_apparatus_item:' || (i.id)::text AS ref, 'media:' || i.media_id::text AS owner_ref, 'reader_apparatus_item'::text AS family, 'reader_apparatus_item:' || i.media_id::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, i.label AS title, i.body_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, i.kind AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM reader_apparatus_items i JOIN reader_apparatus_states s ON s.id=i.state_id WHERE s.status IN ('ready','partial') /*identity_filter*/""",
    "fragment": """SELECT 'fragment:' || (f.id)::text AS doc_key, 'fragment:' || (f.id)::text AS ref, 'media:' || f.media_id::text AS owner_ref, 'fragment'::text AS family, 'fragment:' || f.media_id::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, f.canonical_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM fragments f JOIN media m ON m.id=f.media_id WHERE f.canonical_text<>'' AND CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL THEN 0<=f.t_start_ms AND f.t_start_ms<f.t_end_ms ELSE m.kind<>'pdf' END /*identity_filter*/""",
    "content_chunk": """SELECT 'content_chunk:' || (c.id)::text AS doc_key, 'content_chunk:' || (c.id)::text AS ref, 'media:' || c.owner_id::text AS owner_ref, 'content_chunk'::text AS family, 'content_chunk:' || c.owner_id::text || ':' || s.lexical_revision::text AS admission_key, s.lexical_revision AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, c.chunk_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM content_chunks c JOIN content_index_states s ON s.owner_kind=c.owner_kind AND s.owner_id=c.owner_id WHERE c.owner_kind='media' AND c.primary_evidence_span_id IS NOT NULL AND c.chunk_text<>'' AND s.lexical_revision IS NOT NULL /*identity_filter*/""",
    "web_result": """SELECT 'external_snapshot:' || (s.id)::text AS doc_key, 'external_snapshot:' || (s.id)::text AS ref, 'external_snapshot:' || (s.id)::text AS owner_ref, 'web_result'::text AS family, 'external_snapshot:' || (s.id)::text AS admission_key, NULL::bigint AS source_revision, s.title AS name, NULL::text AS discovery_name, s.title AS title, s.snippet AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, s.url AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM resource_external_snapshots s WHERE TRUE /*identity_filter*/""",
    "library": """SELECT 'library:' || (l.id)::text AS doc_key, 'library:' || (l.id)::text AS ref, 'library:' || (l.id)::text AS owner_ref, 'library'::text AS family, 'library:' || (l.id)::text AS admission_key, NULL::bigint AS source_revision, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS name, NULL::text AS discovery_name, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM libraries l WHERE TRUE /*identity_filter*/""",
    "oracle_reading": """SELECT 'oracle_reading:' || (r.id)::text AS doc_key, 'oracle_reading:' || (r.id)::text AS ref, 'oracle_reading:' || (r.id)::text AS owner_ref, 'oracle_reading'::text AS family, 'oracle_reading:' || (r.id)::text AS admission_key, NULL::bigint AS source_revision, r.question_text AS name, NULL::text AS discovery_name, r.question_text AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, r.folio_motto AS motto, r.interpretation_text AS interpretation, NULL::text AS subject_title FROM oracle_readings r WHERE TRUE /*identity_filter*/""",
    "passage_anchor": """SELECT 'passage_anchor:' || (p.id)::text AS doc_key, 'passage_anchor:' || (p.id)::text AS ref, 'passage_anchor:' || (p.id)::text AS owner_ref, 'passage_anchor'::text AS family, 'passage_anchor:' || (p.id)::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, p.selector#>>'{quote,exact}' AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM passage_anchors p WHERE COALESCE(p.selector#>>'{quote,exact}','')<>'' /*identity_filter*/""",
}


def _publish_lexical_readiness() -> None:
    db = op.get_bind()
    invalid = db.scalar(
        sa.text("""
        SELECT count(*) FROM content_index_states s WHERE s.status = 'ready' AND (
            (s.owner_kind = 'media' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.id = s.owner_id))
            OR (s.owner_kind = 'note_block' AND NOT EXISTS (SELECT 1 FROM note_blocks n WHERE n.id = s.owner_id))
            OR s.owner_kind NOT IN ('media', 'note_block')
            OR NOT EXISTS (SELECT 1 FROM content_chunks c
                WHERE c.owner_kind = s.owner_kind AND c.owner_id = s.owner_id)
            OR EXISTS (SELECT 1 FROM content_chunks c LEFT JOIN evidence_spans e
                ON e.id = c.primary_evidence_span_id
                WHERE c.owner_kind = s.owner_kind AND c.owner_id = s.owner_id
                  AND (btrim(c.chunk_text) = '' OR e.id IS NULL
                       OR e.owner_kind <> s.owner_kind OR e.owner_id <> s.owner_id
                       OR btrim(e.span_text) = '')))
    """)
    )
    if invalid:
        raise RuntimeError(f"0317 cannot convert {invalid} invalid ready content indexes")
    missing = db.scalar(
        sa.text("""
        SELECT count(*) FROM note_blocks n WHERE NOT EXISTS (
            SELECT 1 FROM content_index_states s
            WHERE s.owner_kind = 'note_block' AND s.owner_id = n.id)
    """)
    )
    if missing:
        raise RuntimeError(f"0317 cannot convert {missing} notes without index state")
    op.add_column(
        "content_index_states",
        sa.Column("lexical_revision", sa.BigInteger(), nullable=True),
    )
    db.execute(
        sa.text(
            "UPDATE content_index_states SET lexical_revision = revision WHERE status = 'ready'"
        )
    )
    db.execute(
        sa.text("""
        UPDATE background_jobs j SET payload = j.payload || jsonb_build_object('revision', s.revision)
        FROM content_index_states s
        WHERE j.kind = 'note_reindex_job' AND j.status IN ('pending', 'failed', 'running')
          AND s.owner_kind = 'note_block' AND j.payload->>'note_block_id' = s.owner_id::text
          AND EXISTS (SELECT 1 FROM note_blocks n WHERE n.id = s.owner_id)
    """)
    )
    db.execute(
        sa.text("""
        UPDATE background_jobs j SET status = 'succeeded', result = '{"status":"superseded"}',
            finished_at = now(), updated_at = now(), execution_id = NULL,
            claimed_by = NULL, lease_expires_at = NULL
        WHERE j.kind = 'note_reindex_job' AND j.status IN ('pending', 'failed', 'running')
          AND NOT EXISTS (SELECT 1 FROM note_blocks n
                          WHERE n.id::text = j.payload->>'note_block_id')
    """)
    )

    op.execute("""
        CREATE INDEX ix_reader_apparatus_items_body_fts ON reader_apparatus_items
        USING gin (to_tsvector('english', coalesce(label, '') || ' ' ||
            coalesce(kind, '') || ' ' || coalesce(body_text, '')))
    """)
    op.execute("""
        CREATE INDEX ix_reader_apparatus_items_label_trgm ON reader_apparatus_items
        USING gin (label gin_trgm_ops)
    """)


def _require_serving_embedding_coverage(db: sa.Connection) -> None:
    """Refuse legacy ready states that cannot use chunk count for semantic routing."""
    bad = db.scalar(
        sa.text("""
        SELECT count(*) FROM (
            SELECT c.id
            FROM content_index_states s
            JOIN content_chunks c ON c.owner_kind=s.owner_kind AND c.owner_id=s.owner_id
            LEFT JOIN content_embeddings e ON e.chunk_id=c.id
                AND e.embedding_provider=s.active_embedding_provider
                AND e.embedding_model=s.active_embedding_model
                AND e.embedding_vector IS NOT NULL
            WHERE s.status='ready' AND (s.lexical_revision=s.revision) IS TRUE
                AND s.active_embedding_provider IS NOT NULL
                AND s.active_embedding_model IS NOT NULL
            GROUP BY c.id HAVING count(e.id)<>1
        ) invalid
    """)
    )
    if bad:
        raise RuntimeError(
            f"0317 refuses {bad} current serving chunks without exactly one active vector"
        )


def upgrade() -> None:
    db = op.get_bind()
    preloaded = db.scalar(sa.text("SHOW shared_preload_libraries"))
    if "pg_search" not in {name.strip() for name in preloaded.split(",")}:
        raise RuntimeError("0317 requires shared_preload_libraries=pg_search; restart postgres")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_search VERSION '0.26.2'")
    catalog = db.scalar(sa.text("SELECT extversion FROM pg_extension WHERE extname='pg_search'"))
    binary = db.scalar(sa.text("SELECT version FROM paradedb.version_info()"))
    if catalog != "0.26.2" or binary != "0.26.2":
        raise RuntimeError(f"0317 requires pg_search 0.26.2; catalog={catalog}, binary={binary}")
    valid_clock = db.scalar(
        sa.text("SELECT count(*) = 1 AND bool_and(revision >= 0) FROM suggestion_inputs")
    )
    if not valid_clock:
        raise RuntimeError("0317 requires exactly one nonnegative legacy suggestion input")
    _publish_lexical_readiness()
    _require_serving_embedding_coverage(db)

    fields = ", ".join(field + " text" for field in _TEXT_FIELDS)
    op.execute(f"""CREATE TABLE keyword_occurrences (
        search_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        doc_key text NOT NULL UNIQUE, ref text NOT NULL, owner_ref text NOT NULL,
        family text NOT NULL, admission_key text NOT NULL, source_revision bigint,
        name text, discovery_name text, {fields})""")
    db.execute(sa.text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    for family, source_sql in _SOURCES.items():
        expected_count = 0
        viewers = (
            db.scalars(sa.text("SELECT id FROM users ORDER BY id"))
            if family == "contributor"
            else (None,)
        )
        for viewer in viewers:
            previous = None
            while True:
                identity = _SOURCE_IDS[family]
                if family == "highlight":
                    # One canonical highlight may have many reading variants. Page
                    # identities and bound each physical insert to 256 variants.
                    after = "WHERE id>:previous" if previous is not None else ""
                    batch_ids = db.scalars(
                        sa.text(f"SELECT id FROM highlights {after} ORDER BY id LIMIT 256"),
                        {"previous": previous},
                    ).all()
                    if not batch_ids:
                        break
                    source = source_sql.replace(
                        "/*identity_filter*/", "AND h.id=ANY(CAST(:batch_ids AS uuid[]))"
                    )
                    previous_key = ""
                    while True:
                        expected, inserted = db.execute(
                            sa.text(f"""WITH canonical AS MATERIALIZED (
                                SELECT {",".join(_COLUMNS)} FROM ({source}) variant
                                WHERE variant.doc_key>:previous_key
                                ORDER BY variant.doc_key LIMIT 256
                            ), inserted AS (
                                INSERT INTO keyword_occurrences ({",".join(_COLUMNS)})
                                SELECT {",".join(_COLUMNS)} FROM canonical RETURNING doc_key
                            )
                            SELECT ARRAY(SELECT doc_key FROM canonical ORDER BY doc_key),
                                   ARRAY(SELECT doc_key FROM inserted ORDER BY doc_key)"""),
                            {
                                "viewer_id": viewer,
                                "projection_viewer_id": viewer,
                                "batch_ids": batch_ids,
                                "previous_key": previous_key,
                            },
                        ).one()
                        if expected != inserted:
                            raise RuntimeError("0317 incomplete keyword insertion for highlight")
                        if not expected:
                            break
                        expected_count += len(expected)
                        previous_key = expected[-1]
                    previous = batch_ids[-1]
                    continue
                else:
                    after = f"AND {identity}>:previous" if previous is not None else ""
                    source = source_sql.replace(
                        "/*identity_filter*/", f"{after} ORDER BY {identity} LIMIT 256"
                    )
                expected, inserted = db.execute(
                    sa.text(f"""WITH canonical AS MATERIALIZED ({source}),
                        inserted AS (
                            INSERT INTO keyword_occurrences ({",".join(_COLUMNS)})
                            SELECT {",".join(_COLUMNS)} FROM canonical RETURNING ref
                        )
                        SELECT ARRAY(SELECT ref FROM canonical ORDER BY ref),
                               ARRAY(SELECT ref FROM inserted ORDER BY ref)"""),
                    {
                        "viewer_id": viewer,
                        "projection_viewer_id": viewer,
                        "previous": previous,
                    },
                ).one()
                if expected != inserted:
                    raise RuntimeError(f"0317 incomplete keyword insertion for {family}")
                expected_count += len(expected)
                if expected:
                    previous = max(UUID(ref.split(":", 1)[1]) for ref in expected)
                else:
                    break
        actual_count = db.scalar(
            sa.text("SELECT count(*) FROM keyword_occurrences WHERE family=:family"),
            {"family": family},
        )
        if actual_count != expected_count:
            raise RuntimeError(
                f"0317 unexpected keyword count for {family}: {actual_count} != {expected_count}"
            )

    fields = ", ".join(
        f"({field}::pdb.simple('stemmer=english','stopwords_language=english'))"
        for field in _TEXT_FIELDS
    )
    op.execute(f"""CREATE INDEX keyword_occurrences_bm25 ON keyword_occurrences USING paradedb (
        search_id, (doc_key::pdb.literal), (ref::pdb.literal), (owner_ref::pdb.literal),
        (family::pdb.literal), (admission_key::pdb.literal), {fields})""")
    op.execute(
        "CREATE INDEX keyword_occurrences_highlight_ref ON keyword_occurrences (ref) WHERE family='highlight'"
    )
    op.execute("ANALYZE keyword_occurrences")
    op.execute("""CREATE STATISTICS public.content_index_states_lexical_current
        ON (lexical_revision = revision) FROM public.content_index_states""")
    op.execute("ANALYZE public.content_index_states")
    op.alter_column("suggestion_inputs", "id", type_=sa.Text(), postgresql_using="id::text")
    db.execute(sa.text("UPDATE suggestion_inputs SET id = 'baseline:legacy'"))


def downgrade() -> None:
    raise NotImplementedError("0317 is irreversible; restore the verified pre-release backup")
