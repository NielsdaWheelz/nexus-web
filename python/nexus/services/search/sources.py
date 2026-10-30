"""Visible source relations, strict evidence ranking and browser discovery facts.

A family is a SELECT with conventional columns: ``type, id, label, doc`` (and ``cosine`` when
semantic) for ranking, ``text`` for the snippet, and wire-named columns for projection; ``{where}``
takes scope and filter predicates (by ``str.replace``: the SQL holds json path braces). Visibility
is part of the relation, so ranking and rereading share it. Strict evidence uses an absolute
score in [0, 1)::

    tier      3 label = q, 2 label starts with q, 1 label contains q, else 0 (case-folded)
    evidence  0.5 + ts_rank_cd(doc, q, 32) / 2 when doc matches q, else cosine / 2, else 0
    score     (tier + evidence) / 4, ties by label then id (codepoint order)

A row matches when its doc matches, its label contains q, or it is a semantic neighbour (cosine
>= 0.5). With filters and no text, the listable families score 0 and list by label.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any, NamedTuple, cast
from uuid import UUID

from sqlalchemy import RowMapping, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_visibility_sql,
    requested_media_ids_cte_sql,
    visible_content_credit_rows_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.services.content_indexing import fragment_reading_chunks_sql, reading_chunks_sql
from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    contributor_fts_text_sql,
    credit_target_filter_exists_sql,
)
from nexus.services.media_text_scope import (
    apparatus_scope_rows_sql,
    highlight_in_reading_scope_sql,
    text_scope_rows_sql,
    x_capture_scope_rows_sql,
)
from nexus.services.notes import page_title_sql
from nexus.services.resource_graph.context import context_facts_sql
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.locations import (
    media_passages,
    passage_owner_sql,
    reading_owner_sql,
)
from nexus.services.search.query import SearchScope
from nexus.services.search.scope import (
    ScopeSQL,
    admitted_reading_media_sql,
    compose_scopes,
    scope_predicate,
)
from nexus.services.search.semantic import Embedding, nearest_chunks
from nexus.services.x_source import readable_x_capture_ids_sql
from nexus.text import escape_like

TSQ = "websearch_to_tsquery('english', :q)"
LISTABLE = frozenset({"media", "podcast", "contributor"})  # works and people; passages need text
_CTES = f"""WITH visible_media AS ({visible_media_ids_cte_sql()}),
    visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
    visible_conversations AS ({visible_conversation_ids_cte_sql()})"""
_BASE_CTES = _CTES
_NO_EXACT_PASSAGES = """, frozen_passages AS (
    SELECT NULL::text AS scheme,NULL::uuid AS id WHERE FALSE),
    exact_passage_media AS (SELECT NULL::uuid AS media_id WHERE FALSE)"""
_CTES = _BASE_CTES + ", admitted_media AS (SELECT media_id FROM visible_media)" + _NO_EXACT_PASSAGES


def _ctes(
    r: Retrieval | None = None,
    reading_media_id: UUID | None = None,
    *,
    scope_sql: ScopeSQL | None = None,
) -> tuple[str, dict[str, Any]]:
    if reading_media_id is not None:
        return (
            _BASE_CTES
            + f", admitted_media AS (SELECT CAST(:reading_media_id AS uuid) AS media_id WHERE :reading_media_id IN ({requested_media_ids_cte_sql()}))"
            + _NO_EXACT_PASSAGES,
            {"reading_media_id": reading_media_id},
        )
    if r is None:
        return _CTES, {}
    admitted, params = admitted_reading_media_sql(
        r.scopes, r.frozen, library_media=scope_sql.library_media if scope_sql is not None else None
    )
    prefix = _BASE_CTES + (
        "".join(", " + cte for cte in scope_sql.ctes) if scope_sql is not None else ""
    )
    metadata = _filters("media", r)
    assert metadata is not None
    eligible = f"SELECT candidate.media_id FROM ({admitted}) candidate JOIN media m ON m.id=candidate.media_id WHERE TRUE {metadata}"
    params["frozen_passages"] = json.dumps(
        [
            {"scheme": ref.scheme, "id": str(ref.id)}
            for ref in (r.frozen or ())
            if any(scope.kind == "all" for scope in r.scopes)
            if ref.scheme
            in {
                "content_chunk",
                "evidence_span",
                "fragment",
                "reader_apparatus_item",
                "highlight",
                "passage_anchor",
            }
        ]
    )
    exact_refs = """SELECT scheme,id FROM
        jsonb_to_recordset(CAST(:frozen_passages AS jsonb)) ref(scheme text,id uuid)"""
    for index, scope in enumerate(r.scopes):
        if scope.kind == "conversation":
            params[f"scope_{index}"] = scope.id
            exact_refs += f""" UNION SELECT target_scheme AS scheme,target_id AS id
                FROM ({context_facts_sql(f":scope_{index}")}) context
                WHERE target_scheme IN ('highlight','passage_anchor')"""
    return (
        prefix
        + f""", admitted_media AS ({eligible}),
        frozen_passages AS ({exact_refs}),
        exact_passage_media AS (SELECT m.id AS media_id FROM ({requested_media_ids_cte_sql()}) visible
            JOIN media m ON m.id=visible.media_id
            WHERE EXISTS (SELECT 1 FROM frozen_passages) {metadata})""",
        params,
    )


_APPARATUS_DOCUMENT = """to_tsvector('english',coalesce(rai.label,'') || ' ' ||
    coalesce(rai.kind,'') || ' ' || coalesce(rai.body_text,''))"""

_SOURCE = (
    "m.id AS media_id, m.kind AS media_kind, m.title AS media_title, m.original_published_date"
)


def _semantic_rows(prefix: str) -> str:
    return f"unnest(CAST(:{prefix}_semantic_ids AS uuid[]), CAST(:{prefix}_semantic_cos AS float8[])) AS neighbour(id, cosine)"


def _semantic_params(family: str, neighbours: Sequence[tuple[UUID, float]]) -> dict[str, Any]:
    prefix = {
        "content_chunk": "chunk",
        "note_block": "note",
        "highlight_annotation": "annotation",
    }[family]
    return {
        f"{prefix}_semantic_ids": [identity for identity, _ in neighbours],
        f"{prefix}_semantic_cos": [cosine for _, cosine in neighbours],
    }


_FQUOTE = "jsonb_build_object('exact', f.canonical_text, 'prefix', '', 'suffix', '')"


# Readiness a search hit needs: a located apparatus item (``rai``) of a live state (``ras``)
# and an Oracle anchor still resolved onto its corpus media's chunk and span.
LIVE_APPARATUS = """ras.status IN ('ready', 'partial') AND rai.locator IS NOT NULL
    AND rai.locator_status != 'missing'"""
_STRICT_ADMISSION = {
    "highlight": """ AND ((h.anchor_kind = 'fragment_offsets' AND f.id IS NOT NULL)
        OR (h.anchor_kind = 'pdf_page_geometry' AND pa.highlight_id IS NOT NULL))""",
    "reader_apparatus_item": " AND rai.locator IS NOT NULL AND rai.locator_status != 'missing'",
}
RESOLVED_ORACLE_ANCHORS = """oracle_passage_anchors a
    JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
    JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
        AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
    LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
        AND es.owner_kind = 'media' AND es.owner_id = s.media_id
    WHERE a.resolution_status = 'resolved'
      AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)"""


def _offsets(start: str, end: str, quote: str, media: str = "m") -> str:
    """The jsonb reader locator of ``[start, end)`` in fragment ``f`` of media ``m``, or NULL."""
    return f"""CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL THEN CASE
            WHEN 0 <= f.t_start_ms AND f.t_start_ms < f.t_end_ms AND {quote} ->> 'exact' <> ''
            THEN jsonb_build_object('type', 'transcript_time_range', 'media_id', {media}.id,
                't_start_ms', f.t_start_ms, 't_end_ms', f.t_end_ms, 'text_quote_selector', {quote})
            END
        WHEN {start} < {end} AND {end} <= char_length(f.canonical_text) AND {media}.kind <> 'pdf'
        THEN jsonb_build_object('type', CASE {media}.kind WHEN 'epub' THEN 'epub_fragment_offsets'
                ELSE 'web_text_offsets' END, 'media_id', {media}.id, 'fragment_id', f.id,
            'start_offset', {start}, 'end_offset', {end}, 'media_kind', {media}.kind,
            'text_quote_selector', {quote}) END"""


_ADMITTED = "SELECT media_id FROM admitted_media"


def _exact_candidates(exact: str) -> str:
    """Exact frozen refs admit owners for that row, never the owner's other passages."""
    return f"""SELECT media_id FROM exact_passage_media
        WHERE EXISTS (SELECT 1 FROM frozen_passages ref WHERE {exact})"""


def _requested_owner(exact: str, owner: Callable[[str], str]) -> str:
    """A requested containing scope wins before an exact-reference-only owner."""
    return f"COALESCE(({owner(_ADMITTED)}),({owner(_exact_candidates(exact))}))"


_CHUNK_EXACT = """(ref.scheme='content_chunk' AND ref.id=cc.id)
    OR (ref.scheme='evidence_span' AND ref.id=cc.primary_evidence_span_id)"""
_CHUNK_OWNER = _requested_owner(
    _CHUNK_EXACT,
    lambda candidates: reading_owner_sql(
        f"""SELECT reading_media_id FROM ({
            reading_chunks_sql(f'''
            SELECT cc.owner_id AS media_id
            WHERE cc.owner_kind='media' AND cc.owner_id IN ({candidates})
            UNION ALL
            SELECT candidate_part.media_id FROM media_parts candidate_part
            WHERE cc.owner_kind='media' AND candidate_part.source_media_id=cc.owner_id
              AND candidate_part.media_id IN ({candidates})
            UNION ALL
            SELECT candidate.media_id FROM ({candidates}) candidate
            WHERE cc.owner_kind='fragment'
        ''')
        }) admitted WHERE admitted.chunk_id=cc.id"""
    ),
)
# Direct media and bounded pieces retain point-driven membership. Immutable capture
# fragments use their canonical readable occurrence relation in the same snapshot.
_CHUNK_MEMBER = f"""(EXISTS (SELECT 1 FROM media m
    WHERE cc.owner_kind='media' AND m.id=cc.owner_id AND m.id IN ({_ADMITTED}) {{where}})
    OR EXISTS (SELECT 1 FROM ({reading_chunks_sql(f"SELECT candidate_part.media_id FROM media_parts candidate_part WHERE candidate_part.source_media_id=cc.owner_id AND candidate_part.media_id IN ({_ADMITTED})")}) member
    JOIN media m ON m.id=member.reading_media_id
    WHERE cc.owner_kind='media' AND member.chunk_id=cc.id {{where}})
    OR EXISTS (SELECT 1 FROM ({x_capture_scope_rows_sql(_ADMITTED)}) occurrence
    JOIN media m ON m.id=occurrence.reading_media_id
    JOIN ({readable_x_capture_ids_sql()}) readable ON readable.capture_id=occurrence.capture_id
    WHERE cc.owner_kind='fragment' AND occurrence.fragment_id=cc.owner_id {{where}})
    OR EXISTS (SELECT 1 FROM ({reading_chunks_sql(_exact_candidates(_CHUNK_EXACT))}) member
    JOIN media m ON m.id=member.reading_media_id
    WHERE member.chunk_id=cc.id {{where}}))"""
_HIGHLIGHT_OWNER = _requested_owner(
    "ref.scheme='highlight' AND ref.id=h.id",
    lambda candidates: reading_owner_sql(f"""SELECT candidate.media_id AS reading_media_id
        FROM ({candidates}) candidate
        WHERE candidate.media_id=h.anchor_media_id
            OR (h.anchor_kind='fragment_offsets'
                AND candidate.media_id IN (SELECT part.media_id FROM media_parts part WHERE part.source_media_id=h.anchor_media_id)
                AND {highlight_in_reading_scope_sql("h.id", "candidate.media_id")})
            OR (h.anchor_media_id IS NULL AND EXISTS (
                SELECT 1 FROM ({x_capture_scope_rows_sql("SELECT candidate.media_id")}) occurrence
                JOIN highlight_fragment_anchors anchor ON anchor.fragment_id=occurrence.fragment_id AND anchor.highlight_id=h.id
                JOIN ({readable_x_capture_ids_sql()}) readable ON readable.capture_id=occurrence.capture_id))"""),
)

_APPARATUS_OWNER = _requested_owner(
    "ref.scheme='reader_apparatus_item' AND ref.id=rai.id",
    lambda candidates: reading_owner_sql(
        f"SELECT reading_media_id FROM ({apparatus_scope_rows_sql(candidates)}) admitted WHERE admitted.apparatus_item_id=rai.id"
    ),
)
_SPAN_OWNER = _requested_owner(
    "ref.scheme='evidence_span' AND ref.id=es.id",
    lambda candidates: passage_owner_sql(
        candidates,
        source="es.owner_id",
        fragment="CAST(es.selector->>'fragment_id' AS uuid)",
        start="CAST(es.selector->>'start_offset' AS integer)",
        end="CAST(es.selector->>'end_offset' AS integer)",
    ),
)
_HIGHLIGHT_INTERVAL = text_scope_rows_sql("SELECT reading.media_id AS media_id")
_SCOPED_HQUOTE = "jsonb_build_object('exact',h.exact,'prefix',quote.prefix,'suffix',quote.suffix)"


# family -> its SQL; CREDITED: the id format/author/role filters bind ("vc": the credit rows);
# SEMANTIC: the nearest_chunks owner predicate (it holds {where} too).
SOURCES: dict[str, str] = {
    "media": f"""SELECT CASE m.kind WHEN 'podcast_episode' THEN 'episode'
            WHEN 'video' THEN 'video' ELSE 'media' END AS type, m.id, m.title AS label,
            to_tsvector('english', concat_ws(' ', m.title, m.description, m.publisher,
                mc.contributor_search_text)) AS doc, m.description AS text,
            concat_ws(' ', m.description, m.publisher, mc.contributor_search_text) AS discovery_text
        FROM media m JOIN admitted_media vm ON vm.media_id = m.id
        LEFT JOIN ({contributor_credits_rollup_cte_sql("media_id")}) mc ON mc.media_id = m.id
        WHERE TRUE {{where}}""",
    "podcast": f"""SELECT 'podcast' AS type, p.id, p.title AS label, to_tsvector('english',
            concat_ws(' ', p.title, p.description, pc.contributor_search_text)) AS doc,
            COALESCE(p.description, p.title) AS text, p.title,
            concat_ws(' ', p.description, pc.contributor_search_text) AS discovery_text
        FROM podcasts p JOIN visible_podcasts vp ON vp.podcast_id = p.id
        LEFT JOIN ({contributor_credits_rollup_cte_sql("podcast_id")}) pc ON pc.podcast_id = p.id
        WHERE TRUE {{where}}""",
    "contributor": f"""SELECT 'contributor' AS type, c.id, c.display_name AS label,
            to_tsvector('english', fts.search_text) AS doc, c.display_name AS text,
            c.display_name AS title, 'contributor' AS source_label, c.handle AS contributor_handle,
            jsonb_build_object('display_name', c.display_name) AS contributor,
            fts.search_text AS discovery_text
        FROM contributors c JOIN ({contributor_fts_text_sql()}) fts ON fts.contributor_id = c.id
        WHERE EXISTS (SELECT 1 FROM ({visible_content_credit_rows_sql()}) vc
            WHERE vc.contributor_id = c.id {{where}})""",
    "page": f"""SELECT 'page' AS type, p.id, page.title AS label,
            to_tsvector('english', page.title) AS doc, page.title AS text, page.title,
            'page' AS source_label
        FROM pages p CROSS JOIN LATERAL (SELECT {page_title_sql("p")} AS title) page
        WHERE p.user_id = :viewer_id AND p.authored_visible {{where}}""",
    "note_block": f"""SELECT 'note_block' AS type, nb.id, nb.body_text AS label,
            to_tsvector('english', nb.body_text) AS doc, neighbour.cosine, nb.body_text AS text,
            nb.body_text, 'Note' AS title, 'note' AS source_label,
            jsonb_build_object('type', 'note_block_offsets', 'block_id', nb.id, 'start_offset', 0,
                'end_offset', char_length(nb.body_text),
                'text_quote_selector', jsonb_build_object('exact', nb.body_text),
                'body_version', NULL) AS locator
        FROM note_blocks nb LEFT JOIN (SELECT cc.owner_id, max(neighbour.cosine) AS cosine
            FROM {_semantic_rows("note")} JOIN content_chunks cc ON cc.id = neighbour.id GROUP BY cc.owner_id) neighbour
            ON neighbour.owner_id = nb.id
        WHERE nb.user_id = :viewer_id AND nb.authored_visible AND nb.body_text <> '' {{where}}""",
    "highlight": f"""SELECT 'highlight' AS type,h.id,h.exact AS label,
            to_tsvector('english',concat_ws(' ',h.exact,quote.prefix,quote.suffix)) AS doc,
            h.exact AS text,h.exact,COALESCE(h.color,'yellow') AS color,
            'highlight ' || left(CAST(h.id AS text),8) AS citation_label,
            m.id AS media_id,COALESCE(m.kind,'x') AS media_kind,
            COALESCE(m.title,c.payload #>> '{{content,author,name}}',c.payload->>'attribution_text',c.payload->>'parent_title','captured post') AS media_title,
            m.original_published_date,
            m.id AS reading_media_id,source_m.id AS source_media_id,source_m.kind AS source_media_kind,
            CASE WHEN f.x_post_capture_id IS NOT NULL THEN jsonb_build_object('type','x_capture_offsets','capture_id',f.x_post_capture_id,'fragment_id',f.id,'start_offset',a.start_offset,'end_offset',a.end_offset,'text_quote_selector',{_SCOPED_HQUOTE})
            WHEN f.id IS NOT NULL THEN {_offsets("a.start_offset", "a.end_offset", _SCOPED_HQUOTE, "source_m")}
            ELSE (SELECT jsonb_build_object('type','pdf_page_geometry','media_id',source_m.id,
                'page_number',pa.page_number,'quads',jsonb_agg(jsonb_build_object('x1',q.x1,
                'y1',q.y1,'x2',q.x2,'y2',q.y2,'x3',q.x3,'y3',q.y3,'x4',q.x4,'y4',q.y4)
                ORDER BY q.quad_idx),'exact',h.exact,'prefix',quote.prefix,'suffix',quote.suffix,
                'text_quote_selector',{_SCOPED_HQUOTE}) FROM highlight_pdf_quads q
                WHERE q.highlight_id=h.id HAVING count(*)>0) END AS locator
        FROM highlights h LEFT JOIN media source_m ON source_m.id=h.anchor_media_id
        LEFT JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
        LEFT JOIN fragments f ON f.id=a.fragment_id AND (f.media_id=source_m.id OR (h.anchor_media_id IS NULL AND f.x_post_capture_id IS NOT NULL))
        LEFT JOIN x_post_captures c ON c.id=f.x_post_capture_id
        LEFT JOIN highlight_pdf_anchors pa ON pa.highlight_id=h.id AND pa.media_id=source_m.id
        CROSS JOIN LATERAL (SELECT ({_HIGHLIGHT_OWNER}) AS media_id) reading
        LEFT JOIN media m ON m.id=reading.media_id
        CROSS JOIN LATERAL (SELECT min(bounded.start_offset) AS lo,max(bounded.end_offset) AS hi
            FROM ({_HIGHLIGHT_INTERVAL}) bounded WHERE bounded.fragment_id=a.fragment_id) bounds
        CROSS JOIN LATERAL (SELECT
            CASE WHEN m.id IS NULL OR m.id=source_m.id OR f.id IS NULL THEN COALESCE(h.prefix,'') ELSE right(COALESCE(h.prefix,''),greatest(a.start_offset-bounds.lo,0)) END AS prefix,
            CASE WHEN m.id IS NULL OR m.id=source_m.id OR f.id IS NULL THEN COALESCE(h.suffix,'') ELSE left(COALESCE(h.suffix,''),greatest(bounds.hi-a.end_offset,0)) END AS suffix) quote
        WHERE {highlight_visibility_sql("h")}
          AND (m.id IS NOT NULL OR (f.x_post_capture_id IS NOT NULL AND f.x_post_capture_id IN ({readable_x_capture_ids_sql()}))) {{where}}""",
    "highlight_annotation": f"""SELECT 'highlight' AS type,h.id,h.annotation_body_text AS label,
            to_tsvector('english',h.annotation_body_text) AS doc,ann.cosine,
            h.annotation_body_text AS text,h.annotation_body_text AS span_text,h.exact,
            COALESCE(h.color,'yellow') AS color,'annotation' AS citation_label,
            h.anchor_media_id AS media_id,COALESCE(m.kind,'highlight') AS media_kind,
            COALESCE(m.title,'Highlight') AS media_title,m.original_published_date,
            jsonb_build_object('type','highlight_annotation_offsets','highlight_id',h.id,
                'start_offset',0,'end_offset',char_length(h.annotation_body_text),
                'body_sha256',encode(digest(convert_to(h.annotation_body_text,'UTF8'),'sha256'),'hex'),
                'text_quote_selector',jsonb_build_object('exact',h.annotation_body_text,'prefix',NULL,'suffix',NULL)) AS locator
        FROM highlights h LEFT JOIN media m ON m.id=h.anchor_media_id
            AND m.id IN (SELECT media_id FROM visible_media)
        LEFT JOIN (SELECT cc.owner_id,max(neighbour.cosine) AS cosine FROM {_semantic_rows("annotation")}
            JOIN content_chunks cc ON cc.id=neighbour.id AND cc.owner_kind='highlight'
            GROUP BY cc.owner_id) ann ON ann.owner_id=h.id
        WHERE h.user_id=:viewer_id AND h.authored_visible
          AND h.annotation_body_pm_json IS NOT NULL AND h.annotation_body_text<>'' {{where}}""",
    "message": """SELECT 'message' AS type, ms.id, NULL AS label, ms.content_tsv AS doc,
            ms.content AS text, ms.conversation_id, ms.seq,
            'Conversation message #' || ms.seq AS title, 'message #' || ms.seq AS source_label,
            jsonb_build_object('type', 'message_offsets', 'conversation_id', ms.conversation_id,
                'message_id', ms.id, 'message_seq', ms.seq, 'start_offset', 0,
                'end_offset', char_length(ms.content),
                'text_quote_selector', jsonb_build_object('exact', ms.content)) AS locator
        FROM messages ms JOIN visible_conversations vc ON vc.conversation_id = ms.conversation_id
        WHERE ms.status = 'complete' AND ms.content <> '' {where}""",
    "conversation": """SELECT 'conversation' AS type, c.id, c.title AS label,
            to_tsvector('english', COALESCE(c.title, '')) AS doc, c.title AS text,
            COALESCE(c.title, 'Conversation') AS title, 'conversation' AS source_label
        FROM conversations c JOIN visible_conversations vc ON vc.conversation_id = c.id
        WHERE TRUE {where}""",
    "reader_apparatus_item": f"""SELECT 'reader_apparatus_item' AS type,rai.id,rai.label,
            {_APPARATUS_DOCUMENT} AS doc,
            COALESCE(rai.body_text,rai.label,rai.kind) AS text,rai.kind AS apparatus_kind,
            rai.locator,{_SOURCE},m.id AS reading_media_id,
            source_m.id AS source_media_id,source_m.kind AS source_media_kind
        FROM reader_apparatus_items rai JOIN reader_apparatus_states ras ON ras.id=rai.state_id
        JOIN media source_m ON source_m.id=rai.media_id
        CROSS JOIN LATERAL (SELECT ({_APPARATUS_OWNER}) AS media_id) reading
        JOIN media m ON m.id=reading.media_id
        WHERE ras.status IN ('ready','partial') {{where}}""",
    "fragment": f"""SELECT 'fragment' AS type,f.id,NULL AS label,f.canonical_text_tsv AS doc,
            f.canonical_text AS text,'fragment ' || (f.idx+1) AS citation_label,{_SOURCE},
            m.id AS reading_media_id,CASE WHEN f.x_post_capture_id IS NULL THEN m.id END AS source_media_id,m.kind AS source_media_kind,
            CASE WHEN f.x_post_capture_id IS NOT NULL THEN jsonb_build_object('type','x_capture_offsets',
                'capture_id',f.x_post_capture_id,'fragment_id',f.id,'start_offset',0,
                'end_offset',char_length(f.canonical_text),'text_quote_selector',{_FQUOTE})
              ELSE {_offsets("0", "char_length(f.canonical_text)", _FQUOTE)} END AS locator
        FROM fragments f
        JOIN LATERAL ({_ADMITTED} UNION {_exact_candidates("ref.scheme='fragment' AND ref.id=f.id")}) admitted ON TRUE
        JOIN media m ON m.id=admitted.media_id
        WHERE f.canonical_text<>'' AND (
            (f.media_id=m.id AND CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL
                THEN 0<=f.t_start_ms AND f.t_start_ms<f.t_end_ms ELSE m.kind<>'pdf' END)
            OR (f.x_post_capture_id IN ({readable_x_capture_ids_sql()}) AND EXISTS (
                SELECT 1 FROM ({x_capture_scope_rows_sql("SELECT m.id AS media_id")}) occurrence
                WHERE occurrence.fragment_id=f.id))) {{where}}""",
    "content_chunk": f"""SELECT 'content_chunk' AS type,cc.id,NULL AS label,
            cc.chunk_text_tsv AS doc,neighbour.cosine,cc.chunk_text AS text,cc.source_kind,
            es.id AS span_id,es.span_text,es.selector,es.citation_label,es.resolver_kind,
            {_SOURCE},m.id AS reading_media_id,source_m.id AS source_media_id,source_m.kind AS source_media_kind,
            cc.owner_kind AS chunk_owner_kind,cc.summary_locator AS chunk_locator
        FROM content_chunks cc LEFT JOIN {_semantic_rows("chunk")} ON neighbour.id=cc.id
        LEFT JOIN media source_m ON source_m.id=cc.owner_id AND cc.owner_kind='media'
        CROSS JOIN LATERAL (SELECT ({_CHUNK_OWNER}) AS media_id) reading
        JOIN media m ON m.id=reading.media_id
        JOIN evidence_spans es ON es.id=cc.primary_evidence_span_id
        WHERE cc.owner_kind IN ('media','fragment') {{where}}""",
    "web_result": """SELECT 'web_result' AS type, res.id, res.title AS label,
            to_tsvector('english', concat_ws(' ', res.title, res.url, res.snippet)) AS doc,
            res.snippet AS text, res.title, res.url, CAST(res.id AS text) AS source_id,
            mr.locator, mr.selected, mr.ref ->> 'result_ref' AS result_ref,
            COALESCE(mr.ref ->> 'source_name', mr.ref ->> 'display_url', 'web') AS source_label,
            mr.ref ->> 'display_url' AS display_url, mr.ref ->> 'source_name' AS source_name,
            COALESCE(mr.ref -> 'extra_snippets', '[]') AS extra_snippets,
            mr.ref ->> 'published_at' AS published_at, CAST(mr.ref ->> 'rank' AS int) AS rank,
            mr.ref ->> 'provider' AS provider,
            mr.ref ->> 'provider_request_id' AS provider_request_id
        FROM resource_external_snapshots res
        JOIN (SELECT DISTINCT ON (mr.source_id) mr.source_id, mr.result_ref AS ref, mr.locator,
                mr.selected
            FROM message_retrievals mr JOIN messages msg ON msg.id = mr.assistant_message_id
            JOIN visible_conversations vc ON vc.conversation_id = msg.conversation_id
            WHERE mr.result_type = 'web_result' AND mr.locator IS NOT NULL
              AND mr.locator != 'null' {where}
            ORDER BY mr.source_id, mr.created_at DESC, mr.id DESC) mr
            ON mr.source_id = CAST(res.id AS text)
        WHERE res.user_id = :viewer_id""",
    # Reopen (citations) and link targets only.
    "evidence_span": f"""SELECT 'evidence_span' AS type,es.id,NULL AS label,
            to_tsvector('english',es.span_text) AS doc,es.span_text AS text,es.id AS span_id,
            es.span_text,es.selector,es.citation_label,es.resolver_kind,es.owner_kind,
            COALESCE(reading.media_id,es.owner_id) AS media_id,
            COALESCE(m.kind,es.owner_kind) AS media_kind,COALESCE(m.title,'Note') AS media_title,
            m.original_published_date,reading.media_id AS reading_media_id,
            es.owner_id AS source_media_id,COALESCE(source_m.kind,es.owner_kind) AS source_media_kind
        FROM evidence_spans es LEFT JOIN media source_m ON es.owner_kind='media' AND source_m.id=es.owner_id
        CROSS JOIN LATERAL (SELECT CASE WHEN es.owner_kind='media' THEN ({_SPAN_OWNER}) END AS media_id) reading
        LEFT JOIN media m ON m.id=reading.media_id
        WHERE (reading.media_id IS NOT NULL OR (es.owner_kind='highlight' AND es.owner_id IN (SELECT h.id FROM highlights h JOIN content_index_states cis ON cis.owner_kind='highlight' AND cis.owner_id=h.id WHERE h.user_id=:viewer_id AND h.authored_visible AND h.annotation_body_pm_json IS NOT NULL AND cis.lexical_revision=cis.revision)) OR (es.owner_kind='note_block'
            AND es.owner_id IN (SELECT id FROM note_blocks
                WHERE user_id=:viewer_id AND authored_visible))) {{where}}""",
    "gutenberg": """SELECT 'gutenberg' AS type, pg.ebook_id AS id, pg.title AS label,
            to_tsvector('english', concat_ws(' ', pg.title, credit.names, pg.subjects,
                pg.bookshelves)) AS doc, COALESCE(pg.bookshelves, pg.subjects) AS text
        FROM project_gutenberg_catalog pg LEFT JOIN (SELECT cc.project_gutenberg_catalog_ebook_id
                AS ebook_id, string_agg(cc.credited_name || ' ' || c.display_name, ' ') AS names
            FROM contributor_credits cc JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL GROUP BY 1) credit
            ON credit.ebook_id = pg.ebook_id
        WHERE TRUE {where}""",
    # Direct resources, shared by discovery and the link picker.
    "library": """SELECT 'library' AS type, l.id, l.name AS label, to_tsvector('english', l.name)
            AS doc, l.name AS text
        FROM (SELECT id, CASE WHEN is_default THEN 'All' ELSE name END AS name FROM libraries) l
        JOIN memberships mem ON mem.library_id = l.id AND mem.user_id = :viewer_id
        WHERE TRUE {where}""",
    "oracle_reading": """SELECT 'oracle_reading' AS type, r.id, r.question_text AS label,
            to_tsvector('english', concat_ws(' ', r.question_text, r.folio_motto,
                r.interpretation_text)) AS doc, r.question_text AS text,
            concat_ws(' ', r.folio_motto, r.interpretation_text) AS discovery_text
        FROM oracle_readings r WHERE r.user_id = :viewer_id {where}""",
    "passage_anchor": f"""SELECT DISTINCT 'passage_anchor' AS type, pa.id,
            pa.owner_scheme,pa.owner_id,
            CASE WHEN pa.owner_scheme='media' THEN COALESCE(anchor_part.source_media_id,pa.owner_id) END AS source_media_id,
            pa.selector #>> '{{quote,exact}}' AS label, pa.selector #>> '{{quote,exact}}' AS text,
            to_tsvector('english', COALESCE(pa.selector #>> '{{quote,exact}}', '')) AS doc
        FROM passage_anchors pa
        LEFT JOIN highlights annotation_h ON pa.owner_scheme='highlight' AND annotation_h.id=pa.owner_id
        LEFT JOIN media_parts anchor_part ON pa.owner_scheme='media' AND anchor_part.media_id=pa.owner_id
        LEFT JOIN LATERAL (
            SELECT candidate.media_id FROM ({_ADMITTED} UNION {_exact_candidates("ref.scheme='passage_anchor' AND ref.id=pa.id")}) candidate
            LEFT JOIN media_parts reading_part ON reading_part.media_id=candidate.media_id
            WHERE pa.owner_scheme='media' AND COALESCE(reading_part.source_media_id,candidate.media_id)=COALESCE(anchor_part.source_media_id,pa.owner_id)
        ) reading ON TRUE
        LEFT JOIN media m ON m.id=reading.media_id
        WHERE pa.user_id = :viewer_id
          AND ((pa.owner_scheme = 'media' AND m.id IS NOT NULL)
            OR (pa.owner_scheme = 'note_block' AND pa.owner_id IN (SELECT id FROM note_blocks
                WHERE user_id = :viewer_id))
            OR (pa.owner_scheme='highlight' AND annotation_h.user_id=:viewer_id AND annotation_h.authored_visible AND annotation_h.annotation_body_pm_json IS NOT NULL)
            OR (pa.owner_scheme = 'fragment' AND EXISTS (
                SELECT 1 FROM fragments f JOIN ({readable_x_capture_ids_sql()}) readable
                  ON readable.capture_id=f.x_post_capture_id
                WHERE f.id=pa.owner_id))) {{where}}""",
    "oracle_passage_anchor": f"""SELECT 'oracle_passage_anchor' AS type, a.id,
            a.display_label AS label, COALESCE(es.span_text, cc.chunk_text) AS text,
            to_tsvector('english', concat_ws(' ', a.display_label,
                COALESCE(es.span_text, cc.chunk_text))) AS doc
        FROM {RESOLVED_ORACLE_ANCHORS}
          AND s.media_id IN (SELECT media_id FROM visible_media) {{where}}""",
}
CREDITED = {"media": "m.id", "podcast": "p.id", "contributor": "vc", "content_chunk": "m.id"}
SEMANTIC = {
    "highlight_annotation": """cc.owner_kind='highlight' AND EXISTS (SELECT 1 FROM highlights h
        WHERE h.id=cc.owner_id AND h.user_id=:viewer_id
        AND h.authored_visible AND h.annotation_body_pm_json IS NOT NULL {where})""",
    "note_block": """cc.owner_kind = 'note_block' AND EXISTS (SELECT 1 FROM note_blocks nb
        WHERE nb.id = cc.owner_id AND nb.user_id = :viewer_id AND nb.authored_visible {where})""",
    "content_chunk": f"cc.owner_kind IN ('media','fragment') AND {_CHUNK_MEMBER}",
}


class Hit(NamedTuple):
    type: str
    id: Any  # a UUID, or the catalogue's integer ebook id
    label: str
    score: float
    reading_media_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class Retrieval:
    """One query against families; empty ``terms`` means structured filters only."""

    viewer_id: UUID
    terms: str
    k: int
    scopes: tuple[SearchScope, ...] = (SearchScope("all"),)
    frozen: tuple[ResourceRef, ...] | None = None
    content_kinds: tuple[str, ...] = ()
    contributor_ids: list[UUID] | None = None
    roles: tuple[str, ...] = ()
    embedding: Embedding | None = None
    exclude_viewer_authored: bool = False


def _filters(family: str, r: Retrieval) -> str | None:
    """Format/author/role predicates, or None when the family cannot honour them."""
    who = r.contributor_ids is not None
    if not (r.content_kinds or r.roles or who):
        return ""
    credited = CREDITED.get(family)
    if credited is None or (
        family == "podcast" and r.content_kinds and "podcast" not in r.content_kinds
    ):
        return None
    if credited == "vc":
        kinds = """ AND (vc.media_id IN (SELECT reading.id FROM media reading
            LEFT JOIN media_parts part ON part.media_id=reading.id
            LEFT JOIN media source ON source.id=part.source_media_id
            WHERE COALESCE(source.kind,reading.kind)=ANY(:kinds))
            OR ('podcast' = ANY(:kinds) AND vc.podcast_id IS NOT NULL))"""
        return (
            (kinds if r.content_kinds else "")
            + (" AND vc.role = ANY(:roles)" if r.roles else "")
            + (" AND vc.contributor_id = ANY(:contributor_ids)" if who else "")
        )
    kinds = (
        " AND COALESCE((SELECT source.kind FROM media_parts part JOIN media source ON source.id=part.source_media_id WHERE part.media_id=m.id),m.kind)=ANY(:kinds)"
        if r.content_kinds and family != "podcast"
        else ""
    )
    owner = "podcast_id" if family == "podcast" else "media_id"
    exists = credit_target_filter_exists_sql(
        owner, credited, filter_contributor_ids=who, filter_roles=bool(r.roles)
    )
    return kinds + exists


def _saved_passages(
    db: Session,
    r: Retrieval,
) -> list[tuple[RowMapping, UUID | None]]:
    """Read quote/id-ordered batches; live scope admission precedes the result limit.

    Family reach only narrows SQL candidates. Current placement and owner choice
    belong to media_passages, including historical unresolved whole-source quotes.
    """
    cell = scope_predicate("passage_anchor", r.scopes, r.frozen)
    filters = _filters("passage_anchor", r)
    if cell is None or filters is None or not r.terms:
        return []
    ctes, scope_params = _ctes(r)
    escaped = escape_like(r.terms)
    params = (
        scope_params
        | cell[1]
        | {
            "viewer_id": r.viewer_id,
            "q": r.terms,
            "prefix": f"{escaped}%",
            "contains": f"%{escaped}%",
            "batch": min(r.k, 100),
            "kinds": list(r.content_kinds),
            "roles": list(r.roles),
            "contributor_ids": r.contributor_ids,
        }
    )
    where = cell[0] + filters
    relation = SOURCES["passage_anchor"].replace("{where}", where)
    lexical = f"(s.doc @@ {TSQ} OR s.label ILIKE :contains)"
    relevance = f"ts_rank_cd(s.doc,{TSQ},32)"
    score = f"""CAST(((CASE WHEN lower(s.label)=lower(:q) THEN 3
        WHEN s.label ILIKE :prefix THEN 2 WHEN s.label ILIKE :contains THEN 1 ELSE 0 END)
        + CASE WHEN s.doc @@ {TSQ} THEN 0.5+{relevance}/2 ELSE 0 END)/4 AS float8)"""
    position = "score"
    cursor: tuple[float, str, str] | None = None
    accepted: list[tuple[RowMapping, UUID | None]] = []
    while len(accepted) < r.k:
        after = ""
        if cursor is not None:
            params |= dict(zip(("after_score", "after_label", "after_id"), cursor, strict=True))
            after = f"""AND (-{position},sort_label COLLATE "C",id::text COLLATE "C")>
                (-CAST(:after_score AS float8),CAST(:after_label AS text) COLLATE "C",
                 CAST(:after_id AS text) COLLATE "C")"""
        rows = list(
            db.execute(
                text(f"""{ctes}, ranked AS (
                    SELECT s.*,{score} AS score,CAST({relevance} AS float8) AS relevance,
                        {lexical} AS lexical,s.label AS sort_label
                    FROM ({relation}) s WHERE {lexical})
                    SELECT *,{position} AS position_score FROM ranked WHERE TRUE {after}
                    ORDER BY {position} DESC,sort_label COLLATE "C",id::text COLLATE "C"
                    LIMIT :batch"""),
                params,
            ).mappings()
        )
        if not rows:
            break
        media = [row for row in rows if row["owner_scheme"] == "media"]
        refs = [ResourceRef("passage_anchor", row["id"]) for row in media]
        requested = (
            list(
                db.scalars(
                    text(f"""{ctes} SELECT candidate.media_id FROM admitted_media candidate
                    LEFT JOIN media_parts part ON part.media_id=candidate.media_id
                    WHERE COALESCE(part.source_media_id,candidate.media_id)=ANY(:sources)"""),
                    params | {"sources": list({row["source_media_id"] for row in media})},
                )
            )
            if media
            else []
        )
        scoped = (
            media_passages(
                db, viewer_id=r.viewer_id, refs=refs, admitted_reading_media_ids=requested
            )
            if refs
            else {}
        )
        exact = (
            set(
                db.scalars(
                    text(f"""{ctes} SELECT id FROM frozen_passages
                    WHERE scheme='passage_anchor' AND id=ANY(:ids)"""),
                    params | {"ids": [ref.id for ref in refs]},
                )
            )
            if refs
            else set()
        )
        fallback = [ref for ref in refs if ref.id in exact and ref.uri not in scoped]
        if fallback:
            scoped.update(media_passages(db, viewer_id=r.viewer_id, refs=fallback))
        for row in rows:
            if row["owner_scheme"] == "media":
                passage = scoped.get(f"passage_anchor:{row['id']}")
                if passage is None:
                    continue
                owner = passage.owner.id
            else:
                owner = None
            accepted.append((row, owner))
            if len(accepted) == r.k:
                break
        cursor = (rows[-1]["position_score"], rows[-1]["sort_label"], str(rows[-1]["id"]))
        if len(rows) < params["batch"]:
            break
    return accepted


def rank(db: Session, r: Retrieval, *, families: Sequence[str]) -> list[Hit]:
    """Independent top-``r.k`` windows, concatenated in supplied family order.

    Ordinary families share one statement's canonical scope relations. Semantic
    domains keep independent complete windows.
    Saved passages retain their placement-validated refill executor. The caller's
    stable merge therefore keeps its original family tie order.
    """
    scopes = compose_scopes(families, r.scopes, r.frozen)
    escaped = escape_like(r.terms)
    ctes, scope_params = _ctes(r, scope_sql=scopes)
    params = (
        dict(scopes.bindings)
        | scope_params
        | {
            "viewer_id": r.viewer_id,
            "q": r.terms,
            "k": r.k,
            "prefix": f"{escaped}%",
            "contains": f"%{escaped}%",
            "kinds": list(r.content_kinds),
            "roles": list(r.roles),
            "contributor_ids": r.contributor_ids,
        }
    )
    for family in SEMANTIC:
        params |= _semantic_params(family, ())
    windows: list[list[Hit]] = [[] for _ in families]
    active: list[tuple[int, str, str]] = []
    semantic_families: list[str] = []
    domains: list[str] = []
    for index, family in enumerate(families):
        cell = scopes.cell(family)
        filters = _filters(family, r)
        if cell is None or filters is None or not (r.terms or family in LISTABLE):
            continue
        if family == "passage_anchor":
            windows[index] = [
                Hit("passage_anchor", row["id"], row["label"], row["score"], owner)
                for row, owner in _saved_passages(db, r)
            ]
            continue
        where = cell[0] + filters + _STRICT_ADMISSION.get(family, "")
        active.append((index, family, where))
        if family in SEMANTIC and r.terms and r.embedding is not None:
            semantic_families.append(family)
            domains.append(_semantic_owner(family, where))
    if domains:
        assert r.embedding is not None
        neighbours = nearest_chunks(
            db,
            r.embedding,
            domains=domains,
            params=params,
            limit=max(200, 4 * r.k),
            ctes=ctes,
            maximum_distance=0.5,
        )
        for family, near in zip(semantic_families, neighbours, strict=True):
            params |= _semantic_params(
                family, [(id, cosine) for id, cosine in near if cosine >= 0.5]
            )
    arms = []
    for index, family, where in active:
        if family == "content_chunk" and r.terms:  # never scan the whole chunk table
            where += f""" AND (cc.chunk_text_tsv @@ {TSQ}
                OR cc.id = ANY(CAST(:chunk_semantic_ids AS uuid[])))"""
        cosine = "s.cosine" if family in SEMANTIC else "NULL"
        score = f"""CAST(((CASE WHEN lower(s.label) = lower(:q) THEN 3 WHEN s.label ILIKE :prefix THEN 2
                WHEN s.label ILIKE :contains THEN 1 ELSE 0 END) + CASE WHEN s.doc @@ {TSQ}
                THEN 0.5 + ts_rank_cd(s.doc, {TSQ}, 32) / 2 ELSE COALESCE({cosine}, 0) / 2 END) / 4
            AS float8)"""
        match = f"s.doc @@ {TSQ} OR s.label ILIKE :contains OR {cosine} IS NOT NULL"
        relation = SOURCES[family].replace("{where}", where)
        matching = None
        if family == "fragment":
            matching = f"SELECT id FROM fragments WHERE canonical_text_tsv @@ {TSQ}"
        elif family == "reader_apparatus_item":
            matching = f"""SELECT rai.id FROM reader_apparatus_items rai
                WHERE {_APPARATUS_DOCUMENT} @@ {TSQ}
                UNION SELECT id FROM reader_apparatus_items WHERE label ILIKE :contains"""
        if matching is not None:
            # Separate complete lexical sets retain their driving point reads.
            name = f"rank_{index}_{family}_matches"
            ctes += f", {name} AS MATERIALIZED ({matching})"
            relation = f"""SELECT matched_source.* FROM {name} matching
                CROSS JOIN LATERAL (SELECT * FROM ({relation}) original_source
                    WHERE original_source.id=matching.id OFFSET 0) matched_source"""
        arms.append(f"""(SELECT {index} AS family_index,s.type,CAST(s.id AS text) AS id,
                COALESCE(s.label, '') AS label,
                {score if r.terms else "CAST(0 AS float8)"} AS score,
                {"s.reading_media_id" if family in {"content_chunk", "fragment", "highlight", "reader_apparatus_item", "evidence_span"} else "NULL::uuid"} AS reading_media_id
            FROM ({relation}) s
            WHERE {match if r.terms else "TRUE"}
            ORDER BY score DESC, COALESCE(s.label, '') COLLATE "C", CAST(s.id AS text) COLLATE "C"
            LIMIT :k)""")
    if arms:
        rows = db.execute(
            text(f"""{ctes} SELECT * FROM ({" UNION ALL ".join(arms)}) ranked
                ORDER BY family_index,score DESC,label COLLATE "C",id COLLATE "C"
            """),
            params,
        )
        for row in rows:
            index, kind, identity, label, score, reading = row
            id = int(identity) if families[index] == "gutenberg" else UUID(identity)
            windows[index].append(
                Hit(
                    "highlight_annotation" if families[index] == "highlight_annotation" else kind,
                    id,
                    label,
                    score,
                    reading,
                )
            )
    return [hit for window in windows for hit in window]


def merge(hits: Iterable[Hit]) -> list[Hit]:
    """The one cross-family order: score desc, then label, then id (as ``rank`` orders them)."""
    selected = []
    highlights = set()
    for hit in sorted(
        hits,
        key=lambda hit: (-hit.score, hit.type == "highlight_annotation", hit.label, str(hit.id)),
    ):
        if hit.type in {"highlight", "highlight_annotation"}:
            if hit.id in highlights:
                continue
            highlights.add(hit.id)
        selected.append(hit)
    return sorted(selected, key=lambda hit: (-hit.score, hit.label, str(hit.id)))


def hydrate_occurrences(
    db: Session,
    viewer_id: UUID,
    family: str,
    occurrences: Sequence[tuple[Any, UUID | None]],
    terms: str,
) -> list[tuple[int, dict[str, Any]]]:
    """Hydrate occurrences without merging their reading audiences.

    Ordinals identify input occurrences, including one ref requested through
    different readings. Each audience participates before canonical owner choice.
    """
    if not occurrences:
        return []
    identity = ""
    if family in (
        "highlight",
        "fragment",
        "content_chunk",
        "evidence_span",
        "reader_apparatus_item",
    ):
        identity = ", (SELECT generation FROM reader_publications rp WHERE rp.media_id=s.media_id) AS publication_generation, ARRAY(SELECT f.id::text FROM fragments f WHERE f.media_id=s.media_id ORDER BY f.t_start_ms NULLS LAST,f.idx) AS source_unit_ids, NULL::bigint AS note_body_version"
    id_type = "bigint" if family == "gutenberg" else "uuid"
    sql = f"""{_BASE_CTES}, occurrences AS (
        SELECT * FROM unnest(CAST(:ids AS {id_type}[]),CAST(:readings AS uuid[]))
            WITH ORDINALITY AS requested(id,reading_id,ordinal))
        SELECT occurrence.ordinal,source.* FROM occurrences occurrence CROSS JOIN LATERAL (
            WITH admitted_media AS (
                SELECT media_id FROM visible_media WHERE occurrence.reading_id IS NULL
                UNION SELECT occurrence.reading_id WHERE occurrence.reading_id IS NOT NULL
                    AND occurrence.reading_id IN ({requested_media_ids_cte_sql()}))
                {_NO_EXACT_PASSAGES}
            SELECT s.* {identity}
            FROM ({SOURCES[family].replace("{where}", _STRICT_ADMISSION.get(family, ""))}) s
            WHERE s.id=occurrence.id
        ) source"""
    rows = db.execute(
        text(sql),
        {
            "viewer_id": viewer_id,
            "q": terms,
            "ids": [id for id, _ in occurrences],
            "readings": [reading for _, reading in occurrences],
        }
        | (_semantic_params(family, ()) if family in SEMANTIC else {}),
    ).mappings()
    out = []
    for row in rows:
        values = dict(row)
        ordinal = values.pop("ordinal") - 1
        out.append((ordinal, values))
    return out


def hydrate(
    db: Session,
    viewer_id: UUID,
    family: str,
    ids: Sequence[Any],
    terms: str,
    reading_media_id: UUID | None = None,
) -> list[dict[str, Any]]:
    """Hydrate one shared reading audience through the occurrence executor."""
    return [
        row
        for _, row in hydrate_occurrences(
            db, viewer_id, family, [(id, reading_media_id) for id in dict.fromkeys(ids)], terms
        )
    ]


GENERATED_FAMILIES = frozenset({"message", "content_chunk", "fragment", "reader_apparatus_item"})


@dataclass(frozen=True, slots=True)
class DiscoveryHit:
    family: str
    ref: ResourceRef
    owner: ResourceRef | None
    name_tier: int
    lexical: bool
    relevance: float
    sort_label: str
    reading_media_id: UUID | None = None

    @property
    def order(self) -> tuple[int, int, float, int, str, str]:
        return (
            -self.name_tier,
            -self.lexical,
            -self.relevance,
            int(self.family == "highlight_annotation"),
            self.sort_label,
            self.ref.uri,
        )


def _discovery_predicates(
    r: Retrieval, family: str, cell: tuple[str, dict[str, Any]] | None
) -> tuple[str, dict[str, Any]] | None:
    filters = _filters(family, r)
    if cell is None or filters is None or not (r.terms or family in LISTABLE):
        return None
    escaped = escape_like(r.terms)
    params = cell[1] | {
        "viewer_id": r.viewer_id,
        "q": r.terms,
        "k": r.k,
        "prefix": f"{escaped}%",
        "contains": f"%{escaped}%",
        "kinds": list(r.content_kinds),
        "roles": list(r.roles),
        "contributor_ids": r.contributor_ids,
    }
    if family in SEMANTIC:
        params |= _semantic_params(family, ())
    _, scope_params = _ctes(r)
    where = cell[0] + filters
    if r.exclude_viewer_authored:
        scheme = "highlight" if family == "highlight_annotation" else family
        authored = {"page": "p", "note_block": "nb", "highlight": "h"}.get(scheme)
        if authored is not None:
            where += f""" AND NOT EXISTS(SELECT 1 FROM authored_resources authored
                WHERE authored.account_id=:viewer_id
                  AND authored.ref='{scheme}:' || {authored}.id::text)"""
        elif family == "passage_anchor":
            where += """ AND NOT EXISTS(SELECT 1 FROM authored_passages authored
                WHERE authored.account_id=:viewer_id AND authored.anchor_id=pa.id::text)"""
    return where, params | scope_params


def _semantic_owner(family: str, where: str) -> str:
    """One query-local source-set array; canonical membership still owns admission."""
    owner = SEMANTIC[family].replace("{where}", where)
    if family == "content_chunk":
        owner = f"""cc.owner_id = ANY(ARRAY(
            SELECT media_id FROM admitted_media
            UNION SELECT media_id FROM exact_passage_media
            UNION SELECT p.source_media_id FROM media_parts p
                WHERE p.media_id IN (SELECT media_id FROM admitted_media
                    UNION SELECT media_id FROM exact_passage_media)
            UNION SELECT fragment_id FROM ({x_capture_scope_rows_sql("SELECT media_id FROM admitted_media UNION SELECT media_id FROM exact_passage_media")}) captured
        )) AND ({owner})"""
    return owner


def discovery_neighbours(db: Session, r: Retrieval, family: str) -> list[tuple[UUID, float]]:
    """One canonical semantic window, using the shared materialized scope relation.

    A media chunk belongs to an admitted/exact reading or that reading's source.
    This conservative source sieve adds no admission: the entire existing member
    predicate still owns visibility, frozen-ref identity and piece bounds.
    """
    scopes = compose_scopes((family,), r.scopes, None)
    predicates = _discovery_predicates(r, family, scopes.cell(family))
    if predicates is None or r.embedding is None:
        return []
    where, params = predicates
    ctes, scope_params = _ctes(r, scope_sql=scopes)
    owner = _semantic_owner(family, where)
    (near,) = nearest_chunks(
        db,
        r.embedding,
        domains=(owner,),
        params=params | scope_params,
        limit=200,
        ctes=ctes,
        maximum_distance=0.5,
    )
    return [(chunk_id, cosine) for chunk_id, cosine in near if cosine >= 0.5]


def _saved_readings(
    db: Session, r: Retrieval, where: str, params: dict[str, Any], ctes: str
) -> str:
    """Resolve saved passage admission before native scoring or prefix selection."""
    source = SOURCES["passage_anchor"].replace("{where}", where)
    rows = db.execute(
        text(f"{ctes} SELECT s.id,s.owner_scheme,s.source_media_id FROM ({source}) s"), params
    ).all()
    media = [row for row in rows if row.owner_scheme == "media"]
    requested = (
        list(
            db.scalars(
                text(f"""{ctes} SELECT candidate.media_id FROM admitted_media candidate
        LEFT JOIN media_parts part ON part.media_id=candidate.media_id
        WHERE COALESCE(part.source_media_id,candidate.media_id)=ANY(:sources)"""),
                params | {"sources": list({row.source_media_id for row in media})},
            )
        )
        if media
        else []
    )
    refs = [ResourceRef("passage_anchor", row.id) for row in media]
    scoped = (
        media_passages(db, viewer_id=r.viewer_id, refs=refs, admitted_reading_media_ids=requested)
        if refs
        else {}
    )
    exact_ids = set(
        db.scalars(
            text(f"{ctes} SELECT id FROM frozen_passages WHERE scheme='passage_anchor'"), params
        )
    )
    exact_refs = [ref for ref in refs if ref.id in exact_ids and ref.uri not in scoped]
    if exact_refs:
        scoped.update(media_passages(db, viewer_id=r.viewer_id, refs=exact_refs))
    admitted = [
        {
            "id": str(row.id),
            "reading_media_id": str(scoped[f"passage_anchor:{row.id}"].owner.id)
            if row.owner_scheme == "media"
            else None,
        }
        for row in rows
        if row.owner_scheme != "media" or f"passage_anchor:{row.id}" in scoped
    ]
    params["saved_readings"] = json.dumps(admitted)
    return "SELECT DISTINCT id,reading_media_id FROM jsonb_to_recordset(CAST(:saved_readings AS jsonb)) r(id uuid,reading_media_id uuid)"


def discovery_eligible(
    db: Session, r: Retrieval, families: Sequence[str]
) -> tuple[str, dict[str, object]]:
    """Canonical eligibility, including the one permitted reading owner of each hit.

    Whole sources keep their owner-wide admission. Piece-only passages carry an
    exact native document identity, so a shared source key cannot admit siblings.
    Native scoring still traverses one comparable lexical stream.
    """
    scopes = compose_scopes(families, r.scopes, None)
    ctes, bindings = _ctes(r, scope_sql=scopes)
    branches = []
    params: dict[str, Any] = {"viewer_id": r.viewer_id} | bindings | dict(scopes.bindings)
    prose = {"note_block", "highlight", "highlight_annotation", "passage_anchor", "message"}
    for family in families:
        predicates = _discovery_predicates(r, family, scopes.cell(family))
        if predicates is None:
            continue
        where, arguments = predicates
        params.update(arguments)
        if family in {"content_chunk", "fragment", "reader_apparatus_item"}:
            state = ""
            revision = "''"
            if family == "content_chunk":
                state = "JOIN content_index_states s ON s.owner_kind='media' AND s.owner_id=m.id AND s.lexical_revision=s.revision"
                revision = "':' || s.revision::text"
            elif family == "reader_apparatus_item":
                state = "JOIN reader_apparatus_states s ON s.media_id=m.id AND s.status IN ('ready','partial')"
            branches.append(f"""SELECT DISTINCT '{family}'::text AS family,
                '{family}:' || m.id::text || {revision} AS admission_key,
                NULL::text AS doc_key,NULL::text AS ref,'media:' || m.id::text AS owner_ref,
                NULL::text AS name,NULL::text AS discovery_name,0 AS name_tier,
                m.id AS reading_media_id,NULL::bigint AS native_search_id
                FROM media m JOIN admitted_media admitted ON admitted.media_id=m.id {state}
                WHERE m.kind<>'text_part' {where}""")
            if family == "fragment":
                branches.append(f"""SELECT DISTINCT 'fragment'::text AS family,
                    p.admission_key,p.doc_key,p.ref,'media:' || m.id::text AS owner_ref,
                    NULL::text AS name,NULL::text AS discovery_name,0 AS name_tier,
                    m.id AS reading_media_id,p.search_id AS native_search_id
                    FROM ({x_capture_scope_rows_sql(_ADMITTED)}) selected
                    JOIN ({readable_x_capture_ids_sql()}) readable ON readable.capture_id=selected.capture_id
                    JOIN media m ON m.id=selected.reading_media_id
                    JOIN keyword_occurrences p ON p.doc_key='fragment:' || selected.fragment_id::text
                    WHERE TRUE {where}""")
                continue
            if family == "content_chunk":
                branches.append(f"""SELECT DISTINCT 'content_chunk'::text AS family,
                    p.admission_key,p.doc_key,p.ref,'media:' || m.id::text AS owner_ref,
                    NULL::text AS name,NULL::text AS discovery_name,0 AS name_tier,
                    m.id AS reading_media_id,p.search_id AS native_search_id
                    FROM ({fragment_reading_chunks_sql(_ADMITTED)}) selected
                    JOIN content_chunks cc ON cc.id=selected.chunk_id AND cc.owner_kind='fragment'
                    JOIN media m ON m.id=selected.reading_media_id
                    JOIN keyword_occurrences p ON p.doc_key='content_chunk:' || cc.id::text
                    WHERE TRUE {where}""")
                source = f"""content_chunks cc
                    JOIN content_index_states s ON s.owner_kind='media' AND s.owner_id=cc.owner_id
                        AND s.lexical_revision=s.revision
                    CROSS JOIN LATERAL (SELECT ({_CHUNK_OWNER}) AS media_id) reading
                    JOIN media m ON m.id=reading.media_id
                    JOIN media_parts part ON part.media_id=m.id
                    JOIN keyword_occurrences p ON p.doc_key='content_chunk:' || cc.id::text"""
                # An admitted root wins before family filters and cannot pass the
                # piece join. Exclude its source before preferred-owner lookup.
                condition = """cc.owner_kind='media' AND cc.owner_id = ANY(ARRAY(
                    SELECT part.source_media_id FROM admitted_media reading
                    JOIN media_parts part ON part.media_id=reading.media_id
                    WHERE NOT EXISTS (SELECT 1 FROM admitted_media root
                        WHERE root.media_id=part.source_media_id
                          AND NOT EXISTS (SELECT 1 FROM media_parts root_part
                              WHERE root_part.media_id=root.media_id))))"""
            else:
                source = f"""reader_apparatus_items rai
                    JOIN reader_apparatus_states state ON state.id=rai.state_id
                    CROSS JOIN LATERAL (SELECT ({_APPARATUS_OWNER}) AS media_id) reading
                    JOIN media m ON m.id=reading.media_id
                    JOIN media_parts part ON part.media_id=m.id
                    JOIN keyword_occurrences p ON p.doc_key='reader_apparatus_item:' || rai.id::text"""
                condition = """state.status IN ('ready','partial') AND rai.media_id = ANY(ARRAY(
                    SELECT part.source_media_id FROM admitted_media reading
                    JOIN media_parts part ON part.media_id=reading.media_id
                    WHERE NOT EXISTS (SELECT 1 FROM admitted_media root
                        JOIN media root_media ON root_media.id=root.media_id
                            AND root_media.kind<>'text_part'
                        WHERE root.media_id=part.source_media_id
                          AND NOT EXISTS (SELECT 1 FROM media_parts root_part
                              WHERE root_part.media_id=root.media_id))))"""
            branches.append(f"""SELECT '{family}'::text AS family,p.admission_key,p.doc_key,p.ref,
                'media:' || m.id::text AS owner_ref,NULL::text AS name,NULL::text AS discovery_name,
                0 AS name_tier,m.id AS reading_media_id,p.search_id AS native_search_id
                FROM {source} WHERE {condition} {where}""")
            continue
        scheme = {"web_result": "external_snapshot", "highlight_annotation": "highlight"}.get(
            family, family
        )
        ref = f"'{scheme}:' || s.id::text"
        key = (
            "'contributor:' || CAST(:viewer_id AS text) || ':' || s.id::text"
            if family == "contributor"
            else ref
        )
        if family == "highlight_annotation":
            key = "'highlight:annotation:' || s.id::text"
        if family == "highlight":
            key = "'highlight:' || COALESCE(s.reading_media_id::text,'source') || ':' || s.id::text"
        owner = "'conversation:' || s.conversation_id::text" if family == "message" else ref
        admission = key
        if family in ("note_block", "highlight_annotation"):
            admission += " || ':' || encode(digest(convert_to(s.text,'UTF8'),'sha256'),'hex')"
        name = "NULL::text" if family in prose else "s.label"
        tier = f"CASE WHEN lower({name})=lower(:q) THEN 3 WHEN {name} ILIKE :prefix THEN 2 WHEN {name} ILIKE :contains THEN 1 ELSE 0 END"
        reading = "s.reading_media_id" if family == "highlight" else "NULL::uuid"
        source = SOURCES[family].replace("{where}", where)
        if family == "passage_anchor":
            saved = _saved_readings(db, r, where, params, ctes)
            source = f"SELECT anchor.*,reading.reading_media_id FROM ({source}) anchor JOIN ({saved}) reading ON reading.id=anchor.id"
            reading = "s.reading_media_id"
        branches.append(
            f"SELECT '{family}'::text AS family,{admission} AS admission_key,{key} AS doc_key,{ref} AS ref,{owner} AS owner_ref,{name} AS name,NULL::text AS discovery_name,{tier} AS name_tier,{reading} AS reading_media_id,NULL::bigint AS native_search_id FROM ({source}) s"
        )
    relation = (
        " UNION ALL ".join(branches)
        if branches
        else "SELECT NULL::text AS family,NULL::text AS admission_key,NULL::text AS doc_key,NULL::text AS ref,NULL::text AS owner_ref,NULL::text AS name,NULL::text AS discovery_name,0 AS name_tier,NULL::uuid AS reading_media_id,NULL::bigint AS native_search_id WHERE FALSE"
    )
    # Scope cells refer to the existing once-materialized library relations.
    return ctes + ", eligible AS MATERIALIZED (" + relation + ")", params


def discovery_semantic_hits(
    db: Session, r: Retrieval, family: str, neighbours: Sequence[tuple[UUID, float]]
) -> list[DiscoveryHit]:
    """Project one approved neighbour window under its chosen current reading owner."""
    predicates = _discovery_predicates(r, family, scope_predicate(family, r.scopes, None))
    if predicates is None or not neighbours:
        return []
    where, params = predicates
    params |= _semantic_params(family, neighbours)
    ctes, bindings = _ctes(r)
    owner = "s.media_id" if family == "content_chunk" else "NULL::uuid"
    reading = "s.reading_media_id" if family == "content_chunk" else "NULL::uuid"
    rows = db.execute(
        text(f"""{ctes} SELECT s.id,{owner} AS owner_id,s.cosine,{reading} AS reading_media_id
        FROM ({SOURCES[family].replace("{where}", where)}) s WHERE s.cosine IS NOT NULL"""),
        params | bindings,
    )
    return [
        DiscoveryHit(
            family,
            ResourceRef(
                "highlight" if family == "highlight_annotation" else cast(ResourceScheme, family),
                row.id,
            ),
            ResourceRef("media", row.owner_id) if row.owner_id else None,
            0,
            False,
            row.cosine,
            "",
            row.reading_media_id,
        )
        for row in rows
    ]


def discovery_semantic_children(
    db: Session, r: Retrieval, neighbours: Sequence[tuple[UUID, float]], owners: Sequence[UUID]
) -> list[DiscoveryHit]:
    """An approved chunk window under matching named pieces; no new vector search."""
    if not neighbours or not owners:
        return []
    predicate = _discovery_predicates(
        r, "content_chunk", scope_predicate("content_chunk", r.scopes, None)
    )
    if predicate is None:
        return []
    ctes, bindings = _ctes(r)
    params = predicate[1] | bindings
    readings = """SELECT part.media_id FROM media_parts part
        JOIN admitted_media admitted ON admitted.media_id=part.media_id
        WHERE part.media_id=ANY(CAST(:named_parts AS uuid[]))"""
    rows = db.execute(
        text(f"""{ctes} SELECT reading.chunk_id,reading.reading_media_id,neighbour.cosine
            FROM ({reading_chunks_sql(readings)}) reading
            JOIN {_semantic_rows("chunk")} ON neighbour.id=reading.chunk_id
            JOIN content_chunks cc ON cc.id=reading.chunk_id
            JOIN evidence_spans es ON es.id=cc.primary_evidence_span_id"""),
        params
        | {
            "viewer_id": r.viewer_id,
            "named_parts": list(owners),
        }
        | _semantic_params("content_chunk", neighbours),
    )
    return [
        DiscoveryHit(
            "content_chunk",
            ResourceRef("content_chunk", row.chunk_id),
            ResourceRef("media", row.reading_media_id),
            0,
            False,
            row.cosine,
            "",
            row.reading_media_id,
        )
        for row in rows
    ]


def discovery_browse(db: Session, r: Retrieval, families: Sequence[str]) -> list[DiscoveryHit]:
    """Canonical filter-only browse, restricted to listable works and people."""
    hits: list[DiscoveryHit] = []
    ctes, bindings = _ctes(r)
    for family in families:
        if family not in LISTABLE:
            continue
        predicates = _discovery_predicates(r, family, scope_predicate(family, r.scopes, None))
        if predicates is None:
            continue
        where, params = predicates
        rows = db.execute(
            text(f"""{ctes} SELECT s.id,COALESCE(s.label,'') AS label
            FROM ({SOURCES[family].replace("{where}", where)}) s
            ORDER BY COALESCE(s.label,'') COLLATE "C",s.id::text COLLATE "C" LIMIT :k"""),
            params | bindings,
        )
        hits.extend(
            DiscoveryHit(
                family,
                ResourceRef(
                    "highlight"
                    if family == "highlight_annotation"
                    else cast(ResourceScheme, family),
                    row.id,
                ),
                None,
                0,
                False,
                0,
                row.label,
            )
            for row in rows
        )
    return sorted(hits, key=lambda hit: hit.order)
