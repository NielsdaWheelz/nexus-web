"""SQL presentation facts for bounded related-resource cards.

This is a summary read: returned excerpts never stand in for authored bodies or
selectors. Visibility is applied before callers count, order, or page. Exact
resource/detail reads retain their existing owners.
"""

from nexus.auth.permissions import (
    highlight_readability_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.services.artifacts.registry import persisted_subject_visible_sql
from nexus.services.contributor_credits import (
    media_author_credits_join_sql,
    media_author_names_agg_sql,
)

# Same scalar whitespace and line boundaries as Python's str.strip/splitlines,
# used by resolve._first_line. SQL returns only the existing 200-point summary.
RESOURCE_SUMMARY_WHITESPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
_LINE_BREAKS = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029"


def _first_line(value: str, limit: int = 200) -> str:
    return (
        f"left(rtrim(substring(ltrim(coalesce({value}, ''), '{RESOURCE_SUMMARY_WHITESPACE}') "
        f"from '[^{_LINE_BREAKS}]*'), '{RESOURCE_SUMMARY_WHITESPACE}'), {limit})"
    )


def resource_summary_rows_sql(endpoint_relation: str) -> str:
    """Read checked-in SQL exposing resource_scheme/resource_id, never request SQL.

    Every branch starts from supplied endpoints. Returned text is capped at the
    reader's existing 300-codepoint excerpt policy; codepoint lengths describe
    the complete display value. Database detoast/aggregation work is a separate
    capacity requirement, not concealed by these bounded Python/response rows.
    """
    parts: list[str] = []

    def branch(
        scheme: str,
        source: str,
        *,
        key: str,
        label: str,
        excerpt: str = "NULL::text",
        visible: str = "TRUE",
        kind: str = "Other",
        conversation_id: str = "NULL::uuid",
        message_ref: str = "NULL::text",
    ) -> None:
        label = f"coalesce(nullif({label}, ''), '{scheme}:' || endpoint.resource_id::text)"
        parts.append(f"""
            SELECT endpoint.resource_scheme, endpoint.resource_id,
                   '{kind}'::text AS object_kind,
                   substring(coalesce({label}, '') from 1 for 300) AS label_excerpt,
                   char_length(coalesce({label}, '')) AS label_codepoints,
                   substring({excerpt} from 1 for 300) AS excerpt,
                   char_length({excerpt}) AS excerpt_codepoints,
                   {conversation_id} AS conversation_id, {message_ref} AS message_ref
            FROM endpoints endpoint JOIN {source}
            WHERE endpoint.resource_scheme = '{scheme}' AND {key} = endpoint.resource_id
              AND ({visible})
        """)

    visible_media = f"IN ({visible_media_ids_cte_sql()})"
    visible_conversations = f"IN ({visible_conversation_ids_cte_sql()})"
    authors = media_author_names_agg_sql()
    author_join = media_author_credits_join_sql("m.id")
    media_source = f"""LATERAL (
        SELECT m.id, m.title, m.kind, {authors}
        FROM media m {author_join}
        WHERE m.id = endpoint.resource_id AND m.id {visible_media}
        GROUP BY m.id
    ) m ON TRUE"""
    branch(
        "media",
        media_source,
        key="m.id",
        kind="Media",
        label="m.title || CASE WHEN m.authors <> '' THEN ' by ' || m.authors ELSE '' END",
        excerpt="m.kind",
    )
    branch(
        "library",
        "libraries l ON l.id = endpoint.resource_id",
        key="l.id",
        label="CASE WHEN l.is_default THEN 'All' ELSE l.name END",
        visible="EXISTS (SELECT 1 FROM memberships member WHERE member.library_id = l.id AND member.user_id = :viewer_id)",
    )
    dossier_joins = """
        LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
        LEFT JOIN conversations c ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
        LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
        LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
        LEFT JOIN contributors co ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
        LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
        LEFT JOIN note_blocks nb ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
        LEFT JOIN artifact_idea_subjects idea ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
    """
    subject_title = "coalesce(m.title, c.title, CASE WHEN l.is_default THEN 'All' ELSE l.name END, p.title, co.display_name, pg.title, CASE WHEN nb.id IS NOT NULL THEN 'Note' END, idea.display_title, 'Dossier')"
    branch(
        "artifact",
        f"artifacts a ON a.id = endpoint.resource_id LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id {dossier_joins}",
        key="a.id",
        kind="Dossier",
        label=f"'Dossier — ' || {subject_title}",
        excerpt=_first_line("r.content_text"),
        visible=persisted_subject_visible_sql(),
    )
    branch(
        "artifact_revision",
        f"artifact_revisions r ON r.id = endpoint.resource_id JOIN artifact_builds b ON b.id = r.build_id JOIN artifacts a ON a.id = b.artifact_id {dossier_joins}",
        key="r.id",
        kind="Dossier",
        label=f"'Dossier revision — ' || {subject_title} || CASE WHEN a.current_revision_id = r.id THEN ' (current)' ELSE ' (historical)' END",
        excerpt=_first_line("r.content_text"),
        visible=persisted_subject_visible_sql(),
    )
    for scheme, table, body in (
        ("evidence_span", "evidence_spans", "span_text"),
        ("content_chunk", "content_chunks", "chunk_text"),
    ):
        title = "CASE WHEN item.owner_kind = 'media' THEN m.title ELSE 'Note' END"
        suffix = (
            "coalesce(item.citation_label, '')"
            if scheme == "evidence_span"
            else f"'chunk: ' || {_first_line(f'item.{body}', 80)}"
        )
        branch(
            scheme,
            f"{table} item ON item.id = endpoint.resource_id LEFT JOIN media m ON item.owner_kind = 'media' AND m.id = item.owner_id LEFT JOIN note_blocks nb ON item.owner_kind = 'note_block' AND nb.id = item.owner_id",
            key="item.id",
            label=f"{title} || ' - ' || {suffix}",
            excerpt=_first_line(f"item.{body}"),
            visible=f"(item.owner_kind = 'media' AND m.id {visible_media}) OR (item.owner_kind = 'note_block' AND nb.user_id = :viewer_id)",
        )
    branch(
        "highlight",
        f"highlights h ON h.id = endpoint.resource_id JOIN LATERAL (SELECT m.title, {authors} FROM media m {author_join} WHERE m.id = h.anchor_media_id GROUP BY m.id) m ON TRUE",
        key="h.id",
        label="'Highlight in “' || m.title || '”' || CASE WHEN m.authors <> '' THEN ' by ' || m.authors ELSE '' END",
        excerpt="h.exact",
        visible=highlight_readability_sql(),
    )
    branch(
        "page",
        "pages p ON p.id = endpoint.resource_id",
        key="p.id",
        label="p.title",
        excerpt="p.title",
        visible="p.user_id = :viewer_id",
    )
    branch(
        "note_block",
        "note_blocks nb ON nb.id = endpoint.resource_id",
        key="nb.id",
        kind="Note",
        label=f"coalesce(nullif({_first_line('nb.body_text', 120)}, ''), 'Note')",
        excerpt=f"nullif({_first_line('nb.body_text')}, '')",
        visible="nb.user_id = :viewer_id",
    )
    branch(
        "fragment",
        "fragments f ON f.id = endpoint.resource_id JOIN media m ON m.id = f.media_id",
        key="f.id",
        label="m.title || ' — fragment ' || (f.idx + 1)::text",
        excerpt=_first_line("f.canonical_text"),
        visible=f"m.id {visible_media}",
    )
    branch(
        "conversation",
        "conversations c ON c.id = endpoint.resource_id",
        key="c.id",
        kind="Chat",
        label="coalesce(nullif(btrim(c.title), ''), 'Untitled conversation')",
        excerpt="'Chat history with ' || (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::text || ' messages.'",
        visible=f"c.id {visible_conversations}",
        conversation_id="c.id",
    )
    branch(
        "message",
        "messages msg ON msg.id = endpoint.resource_id JOIN conversations c ON c.id = msg.conversation_id",
        key="msg.id",
        kind="Chat",
        label="coalesce(nullif(btrim(c.title), ''), 'Untitled conversation')",
        visible=f"msg.status != 'pending' AND c.id {visible_conversations}",
        conversation_id="c.id",
        message_ref="'message:' || msg.id::text",
    )
    branch(
        "oracle_reading",
        "oracle_readings r ON r.id = endpoint.resource_id",
        key="r.id",
        kind="Oracle",
        label=f"'Oracle reading: ' || {_first_line('r.question_text', 80)}",
        excerpt="r.folio_theme",
        visible="r.user_id = :viewer_id",
    )
    branch(
        "oracle_passage_anchor",
        "oracle_passage_anchors pa ON pa.id = endpoint.resource_id JOIN oracle_corpus_sources s ON s.id = pa.corpus_source_id JOIN content_chunks cc ON cc.id = pa.current_content_chunk_id AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id LEFT JOIN evidence_spans es ON es.id = pa.current_evidence_span_id AND es.owner_kind = 'media' AND es.owner_id = s.media_id",
        key="pa.id",
        label="s.title || ' — ' || coalesce(pa.display_label, '')",
        excerpt=_first_line("coalesce(es.span_text, cc.chunk_text)"),
        visible="pa.resolution_status = 'resolved' AND (pa.current_evidence_span_id IS NULL OR es.id IS NOT NULL)",
    )
    branch(
        "external_snapshot",
        "resource_external_snapshots s ON s.id = endpoint.resource_id",
        key="s.id",
        label="s.title",
        excerpt=_first_line("s.snippet"),
        visible="s.user_id = :viewer_id",
    )
    branch(
        "contributor",
        "contributors c ON c.id = endpoint.resource_id",
        key="c.id",
        label="c.display_name",
    )
    branch(
        "podcast",
        "podcasts p ON p.id = endpoint.resource_id",
        key="p.id",
        label="p.title",
        excerpt=_first_line("p.description"),
        visible=f"p.id IN ({visible_podcast_ids_cte_sql()})",
    )
    branch(
        "reader_apparatus_item",
        "reader_apparatus_items item ON item.id = endpoint.resource_id JOIN reader_apparatus_states state ON state.id = item.state_id JOIN media m ON m.id = item.media_id",
        key="item.id",
        label="coalesce(nullif(item.label, ''), nullif(item.kind, ''), 'Reader apparatus') || CASE WHEN m.title <> '' THEN ' in ' || m.title ELSE '' END",
        excerpt=f"coalesce(nullif({_first_line('item.body_text')}, ''), item.kind)",
        visible=f"state.status IN ('ready','partial') AND item.locator IS NOT NULL AND item.locator_status != 'missing' AND m.id {visible_media}",
    )
    passage_label = _first_line("pa.selector #>> '{quote,exact}'", 120)
    branch(
        "passage_anchor",
        "passage_anchors pa ON pa.id = endpoint.resource_id",
        key="pa.id",
        label=f"coalesce(nullif({passage_label}, ''), 'Passage')",
        excerpt=_first_line("pa.selector #>> '{quote,exact}'"),
        visible="pa.user_id = :viewer_id",
    )
    return (
        f"WITH endpoints AS (SELECT DISTINCT resource_scheme, resource_id FROM ({endpoint_relation}) supplied) "
        + " UNION ALL ".join(parts)
    )
