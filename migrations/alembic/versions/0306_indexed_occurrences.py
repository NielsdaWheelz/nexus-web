"""Publish the exact native keyword occurrence index.

Revision ID: 0306
Revises: 0305

Data effects: derive keyword_occurrences from canonical scalar fields for every
family and every existing viewer's contributor visibility. Preserve all canonical
identities, chunks, vectors and publication revisions; no providers or network.
Refuse current ready publications with any chunk lacking exactly one nonnull vector
on their active provider/model. Current publication writers cover every chunk;
inconsistent legacy rows require repair before retry, never silent reindexing.
Add and analyze the owned current-publication expression statistic for semantic
cardinality routing; no canonical data changes.
Writers must be stopped throughout this migration's single transaction. Require
the pinned preloaded pg_search binary, backfill in 256-row identity batches, then
build one all-fields native index. Frozen SQL intentionally duplicates the 0306
publication contract so later application edits cannot change migration meaning.
Refuse version mismatches or incomplete insertion. Restore backup to downgrade.
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision: str = "0306"
down_revision: str | Sequence[str] | None = "0305"
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
    "dossier": "a.id",
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
    "contributor": """SELECT 'contributor:' || CAST(:projection_viewer_id AS text) || ':' || (c.id)::text AS doc_key, 'contributor:' || (c.id)::text AS ref, 'contributor:' || (c.id)::text AS owner_ref, 'contributor'::text AS family, 'contributor:' || CAST(:projection_viewer_id AS text) || ':' || (c.id)::text AS admission_key, NULL::bigint AS source_revision, c.display_name AS name, NULL::text AS discovery_name, NULL::text AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, fts.search_text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM contributors c JOIN (
        SELECT
            c.id AS contributor_id,
            concat_ws(
                ' ',
                c.display_name,
                (
                    SELECT string_agg(ca.alias, ' ' ORDER BY ca.alias ASC)
                    FROM contributor_aliases ca
                    WHERE ca.contributor_id = c.id
                ),
                (
                    SELECT string_agg(DISTINCT vcc.credited_name, ' ' ORDER BY vcc.credited_name)
                    FROM (
        SELECT cc.*
        FROM contributor_credits cc
        WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL
           OR cc.media_id IN (
        WITH RECURSIVE eligible AS (SELECT m.id FROM media m WHERE TRUE AND NOT EXISTS (
            SELECT 1 FROM user_media_deletions d
            WHERE d.media_id = m.id AND d.user_id = :viewer_id) AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = m.id)),
        containment AS (
        SELECT thread_media_id AS parent_media_id, post_media_id AS child_media_id
        FROM x_thread_posts
        UNION
        SELECT de.media_id, de.target_media_id
        FROM document_embeds de
        JOIN x_post_sources xp ON xp.media_id = de.target_media_id
        WHERE de.provider = 'x' AND de.resolution_status = 'resolved'
          AND de.canonical_end_offset IS NOT NULL
    ),
        reached(media_id) AS (
            SELECT roots.media_id FROM (
        SELECT le.media_id FROM library_entries le
        JOIN memberships membership ON membership.library_id = le.library_id
        WHERE membership.user_id = :viewer_id AND le.media_id IS NOT NULL
        UNION
        SELECT m.id FROM media m
        WHERE EXISTS (
        SELECT 1 FROM resource_grants media_grant_path_g
        LEFT JOIN highlights media_grant_path_h
          ON media_grant_path_g.subject_scheme = 'highlight'
         AND media_grant_path_h.id = media_grant_path_g.subject_id
        WHERE ((media_grant_path_g.subject_scheme = 'media'
                AND media_grant_path_g.subject_id = m.id)
               OR media_grant_path_h.anchor_media_id = m.id)
          AND (media_grant_path_g.grantee_user_id = :viewer_id
               OR media_grant_path_g.created_by_user_id = :viewer_id)
    )
        UNION
        SELECT media_id FROM (
        SELECT h.anchor_media_id AS media_id, h.user_id
        FROM highlights h JOIN x_post_sources xp ON xp.media_id = h.anchor_media_id
        UNION
        SELECT pa.owner_id, pa.user_id
        FROM passage_anchors pa JOIN x_post_sources xp ON xp.media_id = pa.owner_id
        WHERE pa.owner_scheme = 'media'
        UNION
        SELECT mr.media_id, c.owner_user_id
        FROM message_retrievals mr
        JOIN x_post_sources xp ON xp.media_id = mr.media_id
        JOIN messages msg ON msg.id = mr.assistant_message_id
        JOIN conversations c ON c.id = msg.conversation_id
        UNION
        SELECT xp.media_id, c.owner_user_id
        FROM messages msg
        JOIN conversations c ON c.id = msg.conversation_id
        JOIN x_post_sources xp
          ON msg.reader_selection_snapshot #>> '{evidence,target,owner_ref}'
             = 'media:' || xp.media_id::text
        UNION
        SELECT xp.media_id, re.user_id
        FROM resource_edges re
        JOIN x_post_sources xp
          ON re.snapshot #>> '{evidence,target,owner_ref}' = 'media:' || xp.media_id::text
        WHERE re.origin = 'citation' AND re.ordinal IS NOT NULL
    ) retained
        WHERE retained.user_id = :viewer_id
    ) roots
            JOIN eligible ON eligible.id = roots.media_id
            UNION
            SELECT edge.child_media_id
            FROM reached JOIN containment edge ON edge.parent_media_id = reached.media_id
            JOIN eligible ON eligible.id = edge.child_media_id
        )
        SELECT media_id FROM reached
    )
           OR cc.podcast_id IN (
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id

        UNION

        SELECT le.podcast_id
        FROM library_entries le
        JOIN memberships m ON m.library_id = le.library_id
                          AND m.user_id = :viewer_id
        WHERE le.podcast_id IS NOT NULL
    )
    ) vcc
                    WHERE vcc.contributor_id = c.id
                )
            ) AS search_text
        FROM contributors c
    ) fts ON fts.contributor_id=c.id WHERE TRUE /*identity_filter*/""",
    "page": """SELECT 'page:' || (p.id)::text AS doc_key, 'page:' || (p.id)::text AS ref, 'page:' || (p.id)::text AS owner_ref, 'page'::text AS family, 'page:' || (p.id)::text AS admission_key, NULL::bigint AS source_revision, p.title AS name, NULL::text AS discovery_name, p.title AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM pages p WHERE TRUE /*identity_filter*/""",
    "note_block": """SELECT 'note_block:' || (n.id)::text AS doc_key, 'note_block:' || (n.id)::text AS ref, 'note_block:' || (n.id)::text AS owner_ref, 'note_block'::text AS family, 'note_block:' || n.id::text || ':' || COALESCE(v.version,1)::text AS admission_key, COALESCE(v.version,1) AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, n.body_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM note_blocks n LEFT JOIN resource_versions v ON v.user_id=n.user_id AND v.resource_scheme='note_block' AND v.resource_id=n.id AND v.lane='body' WHERE n.body_text<>'' /*identity_filter*/""",
    "highlight": """SELECT 'highlight:' || (h.id)::text AS doc_key, 'highlight:' || (h.id)::text AS ref, 'highlight:' || (h.id)::text AS owner_ref, 'highlight'::text AS family, 'highlight:' || (h.id)::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, h.exact AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, h.prefix AS prefix, h.suffix AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM highlights h WHERE TRUE /*identity_filter*/""",
    "conversation": """SELECT 'conversation:' || (c.id)::text AS doc_key, 'conversation:' || (c.id)::text AS ref, 'conversation:' || (c.id)::text AS owner_ref, 'conversation'::text AS family, 'conversation:' || (c.id)::text AS admission_key, NULL::bigint AS source_revision, c.title AS name, NULL::text AS discovery_name, c.title AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM conversations c WHERE TRUE /*identity_filter*/""",
    "message": """SELECT 'message:' || (m.id)::text AS doc_key, 'message:' || (m.id)::text AS ref, 'conversation:' || m.conversation_id::text AS owner_ref, 'message'::text AS family, 'message:' || (m.id)::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, m.content AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM messages m WHERE m.status='complete' AND m.content<>'' /*identity_filter*/""",
    "reader_apparatus_item": """SELECT 'reader_apparatus_item:' || (i.id)::text AS doc_key, 'reader_apparatus_item:' || (i.id)::text AS ref, 'media:' || i.media_id::text AS owner_ref, 'reader_apparatus_item'::text AS family, 'reader_apparatus_item:' || i.media_id::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, i.label AS title, i.body_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, i.kind AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM reader_apparatus_items i JOIN reader_apparatus_states s ON s.id=i.state_id WHERE s.status IN ('ready','partial') /*identity_filter*/""",
    "fragment": """SELECT 'fragment:' || (f.id)::text AS doc_key, 'fragment:' || (f.id)::text AS ref, 'media:' || f.media_id::text AS owner_ref, 'fragment'::text AS family, 'fragment:' || f.media_id::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, f.canonical_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM fragments f JOIN media m ON m.id=f.media_id WHERE f.canonical_text<>'' AND CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL THEN 0<=f.t_start_ms AND f.t_start_ms<f.t_end_ms ELSE m.kind<>'pdf' END /*identity_filter*/""",
    "content_chunk": """SELECT 'content_chunk:' || (c.id)::text AS doc_key, 'content_chunk:' || (c.id)::text AS ref, 'media:' || c.owner_id::text AS owner_ref, 'content_chunk'::text AS family, 'content_chunk:' || c.owner_id::text || ':' || s.lexical_revision::text AS admission_key, s.lexical_revision AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, c.chunk_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM content_chunks c JOIN content_index_states s ON s.owner_kind=c.owner_kind AND s.owner_id=c.owner_id WHERE c.owner_kind='media' AND c.primary_evidence_span_id IS NOT NULL AND c.chunk_text<>'' AND s.lexical_revision IS NOT NULL /*identity_filter*/""",
    "web_result": """SELECT 'external_snapshot:' || (s.id)::text AS doc_key, 'external_snapshot:' || (s.id)::text AS ref, 'external_snapshot:' || (s.id)::text AS owner_ref, 'web_result'::text AS family, 'external_snapshot:' || (s.id)::text AS admission_key, NULL::bigint AS source_revision, s.title AS name, NULL::text AS discovery_name, s.title AS title, s.snippet AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, s.url AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM resource_external_snapshots s WHERE TRUE /*identity_filter*/""",
    "library": """SELECT 'library:' || (l.id)::text AS doc_key, 'library:' || (l.id)::text AS ref, 'library:' || (l.id)::text AS owner_ref, 'library'::text AS family, 'library:' || (l.id)::text AS admission_key, NULL::bigint AS source_revision, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS name, NULL::text AS discovery_name, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM libraries l WHERE TRUE /*identity_filter*/""",
    "oracle_reading": """SELECT 'oracle_reading:' || (r.id)::text AS doc_key, 'oracle_reading:' || (r.id)::text AS ref, 'oracle_reading:' || (r.id)::text AS owner_ref, 'oracle_reading'::text AS family, 'oracle_reading:' || (r.id)::text AS admission_key, NULL::bigint AS source_revision, r.question_text AS name, NULL::text AS discovery_name, r.question_text AS title, NULL::text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, r.folio_motto AS motto, r.interpretation_text AS interpretation, NULL::text AS subject_title FROM oracle_readings r WHERE TRUE /*identity_filter*/""",
    "dossier": """SELECT 'artifact:' || (a.id)::text AS doc_key, 'artifact:' || (a.id)::text AS ref, 'artifact:' || (a.id)::text AS owner_ref, 'dossier'::text AS family, 'artifact:' || (a.id)::text AS admission_key, NULL::bigint AS source_revision, subject.title AS name, 'Dossier — ' || COALESCE(sm.title,sc.title,CASE WHEN sl.is_default THEN 'All' ELSE sl.name END,sp.title,so.display_name,sg.title,si.display_title) AS discovery_name, NULL::text AS title, a.content_text AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, subject.title AS subject_title FROM artifacts a
            LEFT JOIN media sm ON a.subject_scheme='media' AND sm.id=a.subject_id
            LEFT JOIN conversations sc ON a.subject_scheme='conversation' AND sc.id=a.subject_id
            LEFT JOIN libraries sl ON a.subject_scheme='library' AND sl.id=a.subject_id
            LEFT JOIN podcasts sp ON a.subject_scheme='podcast' AND sp.id=a.subject_id
            LEFT JOIN contributors so ON a.subject_scheme='contributor' AND so.id=a.subject_id
            LEFT JOIN pages sg ON a.subject_scheme='page' AND sg.id=a.subject_id
            LEFT JOIN note_blocks sn ON a.subject_scheme='note_block' AND sn.id=a.subject_id
            LEFT JOIN artifact_idea_subjects si ON a.subject_scheme='idea' AND si.id=a.subject_id
            CROSS JOIN LATERAL (SELECT COALESCE(sm.title,sc.title,CASE WHEN sl.is_default THEN 'All' ELSE sl.name END,sp.title,so.display_name,sg.title,sn.body_text,si.display_title,'Dossier') AS title) subject WHERE TRUE /*identity_filter*/""",
    "passage_anchor": """SELECT 'passage_anchor:' || (p.id)::text AS doc_key, 'passage_anchor:' || (p.id)::text AS ref, 'passage_anchor:' || (p.id)::text AS owner_ref, 'passage_anchor'::text AS family, 'passage_anchor:' || (p.id)::text AS admission_key, NULL::bigint AS source_revision, NULL::text AS name, NULL::text AS discovery_name, NULL::text AS title, p.selector#>>'{quote,exact}' AS body, NULL::text AS description, NULL::text AS publisher, NULL::text AS contributors, NULL::text AS prefix, NULL::text AS suffix, NULL::text AS url, NULL::text AS kind, NULL::text AS motto, NULL::text AS interpretation, NULL::text AS subject_title FROM passage_anchors p WHERE COALESCE(p.selector#>>'{quote,exact}','')<>'' /*identity_filter*/""",
}


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
            f"0306 refuses {bad} current serving chunks without exactly one active vector"
        )


def upgrade() -> None:
    db = op.get_bind()
    preloaded = db.scalar(sa.text("SHOW shared_preload_libraries"))
    if "pg_search" not in {name.strip() for name in preloaded.split(",")}:
        raise RuntimeError(
            "0306 requires shared_preload_libraries=pg_search; restart postgres"
        )
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_search VERSION '0.26.2'")
    catalog = db.scalar(
        sa.text("SELECT extversion FROM pg_extension WHERE extname='pg_search'")
    )
    binary = db.scalar(sa.text("SELECT version FROM paradedb.version_info()"))
    if catalog != "0.26.2" or binary != "0.26.2":
        raise RuntimeError(
            f"0306 requires pg_search 0.26.2; catalog={catalog}, binary={binary}"
        )
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
                    raise RuntimeError(
                        f"0306 incomplete keyword insertion for {family}"
                    )
                if not expected:
                    break
                expected_count += len(expected)
                previous = max(UUID(ref.split(":", 1)[1]) for ref in expected)
        actual_count = db.scalar(
            sa.text("SELECT count(*) FROM keyword_occurrences WHERE family=:family"),
            {"family": family},
        )
        if actual_count != expected_count:
            raise RuntimeError(
                f"0306 unexpected keyword count for {family}: {actual_count} != {expected_count}"
            )

    fields = ", ".join(
        f"({field}::pdb.simple('stemmer=english','stopwords_language=english'))"
        for field in _TEXT_FIELDS
    )
    op.execute(f"""CREATE INDEX keyword_occurrences_bm25 ON keyword_occurrences USING paradedb (
        search_id, (doc_key::pdb.literal), (ref::pdb.literal), (owner_ref::pdb.literal),
        (family::pdb.literal), (admission_key::pdb.literal), {fields})""")
    op.execute("ANALYZE keyword_occurrences")
    op.execute("""CREATE STATISTICS public.content_index_states_lexical_current
        ON (lexical_revision = revision) FROM public.content_index_states""")
    op.execute("ANALYZE public.content_index_states")


def downgrade() -> None:
    raise NotImplementedError("0306 is irreversible; restore the pre-release backup")
