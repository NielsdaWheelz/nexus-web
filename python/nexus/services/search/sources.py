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
    highlight_readability_sql,
    highlight_visibility_sql,
    visible_content_credit_rows_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.services.content_indexing import reading_chunks_sql
from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    contributor_fts_text_sql,
    credit_target_filter_exists_sql,
)
from nexus.services.media_text_scope import (
    apparatus_scope_rows_sql,
    highlight_in_reading_scope_sql,
    text_scope_rows_sql,
)
from nexus.services.notes import page_title_sql
from nexus.services.resource_graph.context import context_facts_sql
from nexus.services.resource_graph.liveness import authored_link_sql, edge_live_sql
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
            + ", admitted_media AS (SELECT CAST(:reading_media_id AS uuid) AS media_id WHERE :reading_media_id IN (SELECT media_id FROM visible_media))"
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
        exact_passage_media AS (SELECT m.id AS media_id FROM visible_media visible
            JOIN media m ON m.id=visible.media_id
            WHERE EXISTS (SELECT 1 FROM frozen_passages) {metadata})""",
        params,
    )


_SOURCE = (
    "m.id AS media_id, m.kind AS media_kind, m.title AS media_title, m.original_published_date"
)
_ANN = "unnest(CAST(:ann_ids AS uuid[]), CAST(:ann_cos AS float8[])) AS ann(id, cosine)"
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
        f"SELECT reading_media_id FROM ({reading_chunks_sql(f'SELECT cc.owner_id AS media_id WHERE cc.owner_id IN ({candidates}) UNION ALL SELECT candidate_part.media_id FROM media_parts candidate_part WHERE candidate_part.source_media_id=cc.owner_id AND candidate_part.media_id IN ({candidates})')}) admitted WHERE admitted.chunk_id=cc.id"
    ),
)
# Semantic eligibility needs an admitted reading, not its preferred presentation
# owner. The same published chunk bounds admit both the count and vector reads;
# the selected window resolves its reading through _CHUNK_OWNER afterward.
# The semantic reader's _READY already proves cc's current lexical publication.
# Match a source reading directly; only piece candidates need canonical bounds.
_CHUNK_MEMBER = f"""(EXISTS (SELECT 1 FROM media m
    WHERE m.id=cc.owner_id AND m.id IN ({_ADMITTED}) {{where}})
    OR EXISTS (SELECT 1 FROM ({reading_chunks_sql(f"SELECT candidate_part.media_id FROM media_parts candidate_part WHERE candidate_part.source_media_id=cc.owner_id AND candidate_part.media_id IN ({_ADMITTED})")}) member
    JOIN media m ON m.id=member.reading_media_id
    WHERE member.chunk_id=cc.id {{where}}) OR EXISTS (SELECT 1 FROM ({reading_chunks_sql(_exact_candidates(_CHUNK_EXACT))}) member
    JOIN media m ON m.id=member.reading_media_id
    WHERE member.chunk_id=cc.id {{where}}))"""
_HIGHLIGHT_OWNER = _requested_owner(
    "ref.scheme='highlight' AND ref.id=h.id",
    lambda candidates: reading_owner_sql(f"""SELECT candidate.media_id AS reading_media_id
        FROM ({candidates}) candidate
        WHERE candidate.media_id=h.anchor_media_id
            OR (h.anchor_kind='fragment_offsets'
                AND candidate.media_id IN (SELECT part.media_id FROM media_parts part WHERE part.source_media_id=h.anchor_media_id)
                AND {highlight_in_reading_scope_sql("h.id", "candidate.media_id")})"""),
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
        FROM media m JOIN visible_media vm ON vm.media_id = m.id
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
            to_tsvector('english', nb.body_text) AS doc, ann.cosine, nb.body_text AS text,
            nb.body_text, 'Note' AS title, 'note' AS source_label,
            jsonb_build_object('type', 'note_block_offsets', 'block_id', nb.id, 'start_offset', 0,
                'end_offset', char_length(nb.body_text),
                'text_quote_selector', jsonb_build_object('exact', nb.body_text),
                'body_version', NULL) AS locator
        FROM note_blocks nb LEFT JOIN (SELECT cc.owner_id, max(ann.cosine) AS cosine
            FROM {_ANN} JOIN content_chunks cc ON cc.id = ann.id GROUP BY cc.owner_id) ann
            ON ann.owner_id = nb.id
        WHERE nb.user_id = :viewer_id AND nb.authored_visible AND nb.body_text <> '' {{where}}""",
    "highlight": f"""SELECT 'highlight' AS type,h.id,h.exact AS label,
            to_tsvector('english',concat_ws(' ',h.exact,quote.prefix,quote.suffix)) AS doc,
            h.exact AS text,h.exact,COALESCE(h.color,'yellow') AS color,
            'highlight ' || left(CAST(h.id AS text),8) AS citation_label,{_SOURCE},
            m.id AS reading_media_id,source_m.id AS source_media_id,source_m.kind AS source_media_kind,
            CASE WHEN f.id IS NOT NULL THEN {_offsets("a.start_offset", "a.end_offset", _SCOPED_HQUOTE, "source_m")}
            ELSE (SELECT jsonb_build_object('type','pdf_page_geometry','media_id',source_m.id,
                'page_number',pa.page_number,'quads',jsonb_agg(jsonb_build_object('x1',q.x1,
                'y1',q.y1,'x2',q.x2,'y2',q.y2,'x3',q.x3,'y3',q.y3,'x4',q.x4,'y4',q.y4)
                ORDER BY q.quad_idx),'exact',h.exact,'prefix',quote.prefix,'suffix',quote.suffix,
                'text_quote_selector',{_SCOPED_HQUOTE}) FROM highlight_pdf_quads q
                WHERE q.highlight_id=h.id HAVING count(*)>0) END AS locator
        FROM highlights h JOIN media source_m ON source_m.id=h.anchor_media_id
        LEFT JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
        LEFT JOIN fragments f ON f.id=a.fragment_id AND f.media_id=source_m.id
        LEFT JOIN highlight_pdf_anchors pa ON pa.highlight_id=h.id AND pa.media_id=source_m.id
        CROSS JOIN LATERAL (SELECT ({_HIGHLIGHT_OWNER}) AS media_id) reading
        JOIN media m ON m.id=reading.media_id
        CROSS JOIN LATERAL (SELECT min(bounded.start_offset) AS lo,max(bounded.end_offset) AS hi
            FROM ({_HIGHLIGHT_INTERVAL}) bounded WHERE bounded.fragment_id=a.fragment_id) bounds
        CROSS JOIN LATERAL (SELECT
            CASE WHEN m.id=source_m.id OR f.id IS NULL THEN COALESCE(h.prefix,'') ELSE right(COALESCE(h.prefix,''),greatest(a.start_offset-bounds.lo,0)) END AS prefix,
            CASE WHEN m.id=source_m.id OR f.id IS NULL THEN COALESCE(h.suffix,'') ELSE left(COALESCE(h.suffix,''),greatest(bounds.hi-a.end_offset,0)) END AS suffix) quote
        WHERE {highlight_visibility_sql("h")} {{where}}""",
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
            to_tsvector('english',concat_ws(' ',rai.label,rai.kind,rai.body_text)) AS doc,
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
            m.id AS reading_media_id,m.id AS source_media_id,m.kind AS source_media_kind,
            {_offsets("0", "char_length(f.canonical_text)", _FQUOTE)} AS locator
        FROM fragments f JOIN media m ON m.id=f.media_id
        JOIN LATERAL ({_ADMITTED} UNION {_exact_candidates("ref.scheme='fragment' AND ref.id=f.id")}) admitted ON admitted.media_id=m.id
        WHERE f.canonical_text<>'' AND CASE WHEN f.t_start_ms IS NOT NULL
            AND f.t_end_ms IS NOT NULL THEN 0<=f.t_start_ms AND f.t_start_ms<f.t_end_ms
            ELSE m.kind<>'pdf' END {{where}}""",
    "content_chunk": f"""SELECT 'content_chunk' AS type,cc.id,NULL AS label,
            cc.chunk_text_tsv AS doc,ann.cosine,cc.chunk_text AS text,cc.source_kind,
            es.id AS span_id,es.span_text,es.selector,es.citation_label,es.resolver_kind,
            {_SOURCE},m.id AS reading_media_id,source_m.id AS source_media_id,source_m.kind AS source_media_kind
        FROM content_chunks cc LEFT JOIN {_ANN} ON ann.id=cc.id
        JOIN media source_m ON source_m.id=cc.owner_id
        CROSS JOIN LATERAL (SELECT ({_CHUNK_OWNER}) AS media_id) reading
        JOIN media m ON m.id=reading.media_id
        JOIN evidence_spans es ON es.id=cc.primary_evidence_span_id
        WHERE cc.owner_kind='media' {{where}}""",
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
        WHERE (reading.media_id IS NOT NULL OR (es.owner_kind='note_block'
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
                WHERE user_id = :viewer_id))) {{where}}""",
    "oracle_passage_anchor": f"""SELECT 'oracle_passage_anchor' AS type, a.id,
            a.display_label AS label, COALESCE(es.span_text, cc.chunk_text) AS text,
            to_tsvector('english', concat_ws(' ', a.display_label,
                COALESCE(es.span_text, cc.chunk_text))) AS doc
        FROM {RESOLVED_ORACLE_ANCHORS}
          AND s.media_id IN (SELECT media_id FROM visible_media) {{where}}""",
}
CREDITED = {"media": "m.id", "podcast": "p.id", "contributor": "vc", "content_chunk": "m.id"}
SEMANTIC = {
    "note_block": """cc.owner_kind = 'note_block' AND EXISTS (SELECT 1 FROM note_blocks nb
        WHERE nb.id = cc.owner_id AND nb.user_id = :viewer_id AND nb.authored_visible {where})""",
    "content_chunk": f"cc.owner_kind='media' AND {_CHUNK_MEMBER}",
}
# A note attached to a readable highlight by any live authored link, either direction.
_HIGHLIGHT_NOTE = f""" AND EXISTS (SELECT 1 FROM resource_edges edge
    JOIN highlights h ON (edge.source_scheme = 'highlight' AND h.id = edge.source_id
            AND edge.target_scheme = 'note_block' AND edge.target_id = nb.id)
        OR (edge.target_scheme = 'highlight' AND h.id = edge.target_id
            AND edge.source_scheme = 'note_block' AND edge.source_id = nb.id)
    WHERE edge.user_id = :viewer_id AND {authored_link_sql("edge")}
      AND {edge_live_sql("edge")} AND {highlight_readability_sql("h")})"""


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
    highlight_notes_only: bool = False


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


def rank(db: Session, r: Retrieval, family: str) -> list[Hit]:
    """The family's top ``r.k`` hits in rule order, within scopes and filters."""
    cell = scope_predicate(family, r.scopes, r.frozen)
    filters = _filters(family, r)
    if cell is None or filters is None or not (r.terms or family in LISTABLE):
        return []
    if family == "passage_anchor":
        return [
            Hit("passage_anchor", row["id"], row["label"], row["score"], owner)
            for row, owner in _saved_passages(db, r)
        ]
    where = (
        cell[0]
        + filters
        + _STRICT_ADMISSION.get(family, "")
        + (_HIGHLIGHT_NOTE if family == "note_block" and r.highlight_notes_only else "")
    )
    escaped = escape_like(r.terms)
    semantic = SEMANTIC.get(family)
    params = cell[1] | {
        "viewer_id": r.viewer_id,
        "q": r.terms,
        "k": r.k,
        "ann_ids": [],
        "ann_cos": [],
    }
    params |= {"prefix": f"{escaped}%", "contains": f"%{escaped}%", "kinds": list(r.content_kinds)}
    params |= {"roles": list(r.roles), "contributor_ids": r.contributor_ids}
    ctes, scope_params = _ctes(r)
    params |= scope_params
    if semantic and r.terms and r.embedding is not None:
        owner = semantic.replace("{where}", where)
        near = nearest_chunks(
            db, r.embedding, owner=owner, params=params, limit=max(200, 4 * r.k), ctes=ctes
        )
        near = [(chunk_id, cosine) for chunk_id, cosine in near if cosine >= 0.5]
        params |= {"ann_ids": [n[0] for n in near], "ann_cos": [n[1] for n in near]}
    if family == "content_chunk" and r.terms:  # never scan the whole chunk table
        where += f""" AND (cc.chunk_text_tsv @@ {TSQ}
            OR cc.id = ANY(CAST(:ann_ids AS uuid[])))"""
    cosine = "s.cosine" if semantic else "NULL"
    score = f"""CAST(((CASE WHEN lower(s.label) = lower(:q) THEN 3 WHEN s.label ILIKE :prefix THEN 2
            WHEN s.label ILIKE :contains THEN 1 ELSE 0 END) + CASE WHEN s.doc @@ {TSQ}
            THEN 0.5 + ts_rank_cd(s.doc, {TSQ}, 32) / 2 ELSE COALESCE({cosine}, 0) / 2 END) / 4
        AS float8)"""
    match = f"s.doc @@ {TSQ} OR s.label ILIKE :contains OR {cosine} IS NOT NULL"
    rows = db.execute(
        text(f"""{ctes} SELECT s.type, s.id, COALESCE(s.label, '') AS label,
                {score if r.terms else "CAST(0 AS float8)"} AS score,
                {"s.reading_media_id" if family in {"content_chunk", "fragment", "highlight", "reader_apparatus_item", "evidence_span"} else "NULL::uuid"} AS reading_media_id
            FROM ({SOURCES[family].replace("{where}", where)}) s
            WHERE {match if r.terms else "TRUE"}
            ORDER BY score DESC, COALESCE(s.label, '') COLLATE "C", CAST(s.id AS text) COLLATE "C"
            LIMIT :k"""),
        params,
    )
    return [Hit(row[0], row[1], row[2], row[3], row[4]) for row in rows]


def merge(hits: Iterable[Hit]) -> list[Hit]:
    """The one cross-family order: score desc, then label, then id (as ``rank`` orders them)."""
    return sorted(hits, key=lambda hit: (-hit.score, hit.label, str(hit.id)))


def hydrate(
    db: Session,
    viewer_id: UUID,
    family: str,
    ids: Sequence[Any],
    terms: str,
    reading_media_id: UUID | None = None,
) -> list[RowMapping]:
    """The visible rows and frozen source identity in one statement snapshot."""
    identity = ""
    if family in (
        "highlight",
        "fragment",
        "content_chunk",
        "evidence_span",
        "reader_apparatus_item",
    ):
        identity = ", (SELECT generation FROM reader_publications rp WHERE rp.media_id=s.media_id) AS publication_generation, ARRAY(SELECT f.id::text FROM fragments f WHERE f.media_id=s.media_id ORDER BY f.t_start_ms NULLS LAST,f.idx) AS source_unit_ids, NULL::bigint AS note_body_version"
    ctes, scope_params = _ctes(reading_media_id=reading_media_id)
    sql = f"""{ctes} SELECT s.* {identity}
        FROM ({SOURCES[family].replace("{where}", _STRICT_ADMISSION.get(family, ""))}) s
        WHERE s.id = ANY(:ids)"""
    params = {
        "viewer_id": viewer_id,
        "ids": list(ids),
        "q": terms,
        "ann_ids": [],
        "ann_cos": [],
    } | scope_params
    return list(db.execute(text(sql), params).mappings())


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
    def order(self) -> tuple[int, int, float, str, str]:
        return (-self.name_tier, -self.lexical, -self.relevance, self.sort_label, self.ref.uri)


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
        "ann_ids": [],
        "ann_cos": [],
    }
    _, scope_params = _ctes(r)
    return cell[0] + filters, params | scope_params


def discovery_neighbours(db: Session, r: Retrieval, family: str) -> list[tuple[UUID, float]]:
    """One fixed chunk window, reused for ranking and selected-owner enrichment."""
    predicates = _discovery_predicates(r, family, scope_predicate(family, r.scopes, None))
    if predicates is None or r.embedding is None:
        return []
    where, params = predicates
    near = nearest_chunks(
        db,
        r.embedding,
        owner=SEMANTIC[family].replace("{where}", where),
        params=params,
        limit=200,
        ctes=_ctes(r)[0],
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
    prose = {"note_block", "highlight", "passage_anchor", "message"}
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
                continue
            if family == "content_chunk":
                source = f"""content_chunks cc
                    JOIN content_index_states s ON s.owner_kind='media' AND s.owner_id=cc.owner_id
                        AND s.lexical_revision=s.revision
                    CROSS JOIN LATERAL (SELECT ({_CHUNK_OWNER}) AS media_id) reading
                    JOIN media m ON m.id=reading.media_id
                    JOIN media_parts part ON part.media_id=m.id
                    JOIN keyword_occurrences p ON p.doc_key='content_chunk:' || cc.id::text"""
                condition = "cc.owner_kind='media' AND cc.owner_id IN (SELECT part.source_media_id FROM admitted_media reading JOIN media_parts part ON part.media_id=reading.media_id)"
            else:
                source = f"""reader_apparatus_items rai
                    JOIN reader_apparatus_states state ON state.id=rai.state_id
                    CROSS JOIN LATERAL (SELECT ({_APPARATUS_OWNER}) AS media_id) reading
                    JOIN media m ON m.id=reading.media_id
                    JOIN media_parts part ON part.media_id=m.id
                    JOIN keyword_occurrences p ON p.doc_key='reader_apparatus_item:' || rai.id::text"""
                condition = "state.status IN ('ready','partial') AND rai.media_id IN (SELECT part.source_media_id FROM admitted_media reading JOIN media_parts part ON part.media_id=reading.media_id)"
            branches.append(f"""SELECT '{family}'::text AS family,p.admission_key,p.doc_key,p.ref,
                'media:' || m.id::text AS owner_ref,NULL::text AS name,NULL::text AS discovery_name,
                0 AS name_tier,m.id AS reading_media_id,p.search_id AS native_search_id
                FROM {source} WHERE {condition} {where}""")
            continue
        scheme = {"web_result": "external_snapshot"}.get(family, family)
        ref = f"'{scheme}:' || s.id::text"
        key = (
            "'contributor:' || CAST(:viewer_id AS text) || ':' || s.id::text"
            if family == "contributor"
            else ref
        )
        if family == "highlight":
            key = "'highlight:' || s.reading_media_id::text || ':' || s.id::text"
        owner = "'conversation:' || s.conversation_id::text" if family == "message" else ref
        admission = key
        if family == "note_block":
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
    params |= {
        "ann_ids": [identity for identity, _ in neighbours],
        "ann_cos": [cosine for _, cosine in neighbours],
    }
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
            ResourceRef(cast(ResourceScheme, family), row.id),
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
        text(f"""{ctes} SELECT reading.chunk_id,reading.reading_media_id,ann.cosine
            FROM ({reading_chunks_sql(readings)}) reading
            JOIN {_ANN} ON ann.id=reading.chunk_id
            JOIN content_chunks cc ON cc.id=reading.chunk_id
            JOIN evidence_spans es ON es.id=cc.primary_evidence_span_id"""),
        params
        | {
            "viewer_id": r.viewer_id,
            "named_parts": list(owners),
            "ann_ids": [identity for identity, _ in neighbours],
            "ann_cos": [cosine for _, cosine in neighbours],
        },
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
                ResourceRef(cast(ResourceScheme, family), row.id),
                None,
                0,
                False,
                0,
                row.label,
            )
            for row in rows
        )
    return sorted(hits, key=lambda hit: hit.order)
