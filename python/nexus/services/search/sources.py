"""Every findable family as one visible SQL relation, ranked by the one rule (S1).

A family is a SELECT with conventional columns: ``type, id, label, doc`` (and ``cosine`` when
semantic) for ranking, ``text`` for the snippet, and wire-named columns for projection; ``{where}``
takes scope and filter predicates (by ``str.replace``: the SQL holds json path braces). Visibility
is part of the relation, so ranking and rereading share it. The rule, absolute in [0, 1)::

    tier      3 label = q, 2 label starts with q, 1 label contains q, else 0 (case-folded)
    evidence  0.5 + ts_rank_cd(doc, q, 32) / 2 when doc matches q, else cosine / 2, else 0
    score     (tier + evidence) / 4, ties by label then id (codepoint order)

A row matches when its doc matches, its label contains q, or it is a semantic neighbour (cosine
>= 0.5). With filters and no text, the listable families score 0 and list by label.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, NamedTuple
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
from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    contributor_fts_text_sql,
    credit_target_filter_exists_sql,
)
from nexus.services.dossier.subjects import head_visible_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.query import SearchScope
from nexus.services.search.scope import scope_predicate
from nexus.services.search.semantic import Embedding, nearest_chunks
from nexus.text import escape_like

TSQ = "websearch_to_tsquery('english', :q)"
LISTABLE = frozenset({"media", "podcast", "contributor"})  # works and people; passages need text
_CTES = f"""WITH visible_media AS ({visible_media_ids_cte_sql()}),
    visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
    visible_conversations AS ({visible_conversation_ids_cte_sql()})"""
_SOURCE = (
    "m.id AS media_id, m.kind AS media_kind, m.title AS media_title, m.original_published_date"
)
_ANN = "unnest(CAST(:ann_ids AS uuid[]), CAST(:ann_cos AS float8[])) AS ann(id, cosine)"
_HQUOTE = """jsonb_build_object('exact', h.exact, 'prefix', COALESCE(h.prefix, ''),
    'suffix', COALESCE(h.suffix, ''))"""
_FQUOTE = "jsonb_build_object('exact', f.canonical_text, 'prefix', '', 'suffix', '')"


# Readiness the picker's quote reader shares: a live apparatus item (``rai`` in state ``ras``)
# and an Oracle anchor still resolved onto its corpus media's chunk and span.
LIVE_APPARATUS = """ras.status IN ('ready', 'partial') AND rai.locator IS NOT NULL
    AND rai.locator_status != 'missing'"""
RESOLVED_ORACLE_ANCHORS = """oracle_passage_anchors a
    JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
    JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
        AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
    LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
        AND es.owner_kind = 'media' AND es.owner_id = s.media_id
    WHERE a.resolution_status = 'resolved'
      AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)"""


def _offsets(start: str, end: str, quote: str) -> str:
    """The jsonb reader locator of ``[start, end)`` in fragment ``f`` of media ``m``, or NULL."""
    return f"""CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL THEN CASE
            WHEN 0 <= f.t_start_ms AND f.t_start_ms < f.t_end_ms AND {quote} ->> 'exact' <> ''
            THEN jsonb_build_object('type', 'transcript_time_range', 'media_id', m.id,
                't_start_ms', f.t_start_ms, 't_end_ms', f.t_end_ms, 'text_quote_selector', {quote})
            END
        WHEN {start} < {end} AND {end} <= char_length(f.canonical_text) AND m.kind <> 'pdf'
        THEN jsonb_build_object('type', CASE m.kind WHEN 'epub' THEN 'epub_fragment_offsets'
                ELSE 'web_text_offsets' END, 'media_id', m.id, 'fragment_id', f.id,
            'start_offset', {start}, 'end_offset', {end}, 'media_kind', m.kind,
            'text_quote_selector', {quote}) END"""


# family -> its SQL; CREDITED: the id format/author/role filters bind ("vc": the credit rows);
# SEMANTIC: the nearest_chunks owner predicate (it holds {where} too).
SOURCES: dict[str, str] = {
    "media": f"""SELECT CASE m.kind WHEN 'podcast_episode' THEN 'episode'
            WHEN 'video' THEN 'video' ELSE 'media' END AS type, m.id, m.title AS label,
            to_tsvector('english', concat_ws(' ', m.title, m.description, m.publisher,
                mc.contributor_search_text)) AS doc, m.description AS text
        FROM media m JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN ({contributor_credits_rollup_cte_sql("media_id")}) mc ON mc.media_id = m.id
        WHERE TRUE {{where}}""",
    "podcast": f"""SELECT 'podcast' AS type, p.id, p.title AS label, to_tsvector('english',
            concat_ws(' ', p.title, p.description, pc.contributor_search_text)) AS doc,
            COALESCE(p.description, p.title) AS text, p.title
        FROM podcasts p JOIN visible_podcasts vp ON vp.podcast_id = p.id
        LEFT JOIN ({contributor_credits_rollup_cte_sql("podcast_id")}) pc ON pc.podcast_id = p.id
        WHERE TRUE {{where}}""",
    "contributor": f"""SELECT 'contributor' AS type, c.id, c.display_name AS label,
            to_tsvector('english', fts.search_text) AS doc, c.display_name AS text,
            c.display_name AS title, 'contributor' AS source_label, c.handle AS contributor_handle,
            jsonb_build_object('display_name', c.display_name) AS contributor
        FROM contributors c JOIN ({contributor_fts_text_sql()}) fts ON fts.contributor_id = c.id
        WHERE EXISTS (SELECT 1 FROM ({visible_content_credit_rows_sql()}) vc
            WHERE vc.contributor_id = c.id {{where}})""",
    "page": """SELECT 'page' AS type, p.id, p.title AS label, to_tsvector('english', p.title)
            AS doc, p.title AS text, p.title, 'page' AS source_label
        FROM pages p WHERE p.user_id = :viewer_id {where}""",
    "note_block": f"""SELECT 'note_block' AS type, nb.id, nb.body_text AS label,
            to_tsvector('english', nb.body_text) AS doc, ann.cosine, nb.body_text AS text,
            nb.body_text, 'Note' AS title, 'note' AS source_label,
            jsonb_build_object('type', 'note_block_offsets', 'block_id', nb.id, 'start_offset', 0,
                'end_offset', char_length(nb.body_text)) AS locator
        FROM note_blocks nb LEFT JOIN (SELECT cc.owner_id, max(ann.cosine) AS cosine
            FROM {_ANN} JOIN content_chunks cc ON cc.id = ann.id GROUP BY cc.owner_id) ann
            ON ann.owner_id = nb.id
        WHERE nb.user_id = :viewer_id AND nb.body_text <> '' {{where}}""",
    "highlight": f"""SELECT 'highlight' AS type, h.id, h.exact AS label,
            to_tsvector('english', concat_ws(' ', h.exact, h.prefix, h.suffix)) AS doc,
            h.exact AS text, h.exact, COALESCE(h.color, 'yellow') AS color,
            'highlight ' || left(CAST(h.id AS text), 8) AS citation_label, {_SOURCE},
            CASE WHEN f.id IS NOT NULL THEN {_offsets("a.start_offset", "a.end_offset", _HQUOTE)}
            ELSE (SELECT jsonb_build_object('type', 'pdf_page_geometry', 'media_id', m.id,
                'page_number', pa.page_number, 'quads', jsonb_agg(jsonb_build_object('x1', q.x1,
                    'y1', q.y1, 'x2', q.x2, 'y2', q.y2, 'x3', q.x3, 'y3', q.y3, 'x4', q.x4,
                    'y4', q.y4) ORDER BY q.quad_idx), 'exact', h.exact,
                'prefix', COALESCE(h.prefix, ''), 'suffix', COALESCE(h.suffix, ''),
                'text_quote_selector', {_HQUOTE})
            FROM highlight_pdf_quads q WHERE q.highlight_id = h.id HAVING count(*) > 0)
            END AS locator
        FROM highlights h JOIN media m ON m.id = h.anchor_media_id
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN highlight_fragment_anchors a ON a.highlight_id = h.id
        LEFT JOIN fragments f ON f.id = a.fragment_id AND f.media_id = m.id
        LEFT JOIN highlight_pdf_anchors pa ON pa.highlight_id = h.id AND pa.media_id = m.id
        WHERE {highlight_visibility_sql("h")}
          AND ((h.anchor_kind = 'fragment_offsets' AND f.id IS NOT NULL)
            OR (h.anchor_kind = 'pdf_page_geometry' AND pa.highlight_id IS NOT NULL)) {{where}}""",
    "message": """SELECT 'message' AS type, ms.id, NULL AS label, ms.content_tsv AS doc,
            ms.content AS text, ms.conversation_id, ms.seq,
            'Conversation message #' || ms.seq AS title, 'message #' || ms.seq AS source_label,
            jsonb_build_object('type', 'message_offsets', 'conversation_id', ms.conversation_id,
                'message_id', ms.id, 'message_seq', ms.seq, 'start_offset', 0,
                'end_offset', char_length(ms.content)) AS locator
        FROM messages ms JOIN visible_conversations vc ON vc.conversation_id = ms.conversation_id
        WHERE ms.status = 'complete' AND ms.content <> '' {where}""",
    "conversation": """SELECT 'conversation' AS type, c.id, c.title AS label,
            to_tsvector('english', COALESCE(c.title, '')) AS doc, c.title AS text,
            COALESCE(c.title, 'Conversation') AS title, 'conversation' AS source_label
        FROM conversations c JOIN visible_conversations vc ON vc.conversation_id = c.id
        WHERE TRUE {where}""",
    # Conversation Dossier claims stay private to the conversation's owner.
    "artifact": """SELECT 'artifact' AS type, a.subject_id AS id, NULL AS label,
            to_tsvector('english', COALESCE(a.content_text, '')) AS doc, a.content_text AS text,
            a.revision_id, 'Dossier' AS title, 'dossier' AS source_label,
            'conversation:' || a.subject_id AS subject_ref
        FROM artifacts a JOIN conversations c ON c.id = a.subject_id
        WHERE a.subject_scheme = 'conversation' AND a.audience_scheme = 'user'
          AND a.audience_id = c.owner_user_id AND c.owner_user_id = :viewer_id
          AND a.revision_id IS NOT NULL {where}""",
    "reader_apparatus_item": f"""SELECT 'reader_apparatus_item' AS type, rai.id, rai.label,
            to_tsvector('english', concat_ws(' ', rai.label, rai.kind, rai.body_text)) AS doc,
            COALESCE(rai.body_text, rai.label, rai.kind) AS text, rai.kind AS apparatus_kind,
            rai.locator, {_SOURCE}
        FROM reader_apparatus_items rai JOIN reader_apparatus_states ras ON ras.id = rai.state_id
        JOIN media m ON m.id = rai.media_id JOIN visible_media vm ON vm.media_id = m.id
        WHERE {LIVE_APPARATUS} {{where}}""",
    "fragment": f"""SELECT 'fragment' AS type, f.id, NULL AS label, f.canonical_text_tsv AS doc,
            f.canonical_text AS text, 'fragment ' || (f.idx + 1) AS citation_label, {_SOURCE},
            {_offsets("0", "char_length(f.canonical_text)", _FQUOTE)} AS locator
        FROM fragments f JOIN media m ON m.id = f.media_id
        JOIN visible_media vm ON vm.media_id = m.id
        WHERE f.canonical_text <> '' AND CASE WHEN f.t_start_ms IS NOT NULL
            AND f.t_end_ms IS NOT NULL THEN 0 <= f.t_start_ms AND f.t_start_ms < f.t_end_ms
            ELSE m.kind <> 'pdf' END {{where}}""",
    "content_chunk": f"""SELECT 'content_chunk' AS type, cc.id, NULL AS label,
            cc.chunk_text_tsv AS doc, ann.cosine, cc.chunk_text AS text, cc.source_kind,
            es.id AS span_id, es.span_text, es.selector, es.citation_label, es.resolver_kind,
            {_SOURCE}
        FROM content_chunks cc LEFT JOIN {_ANN} ON ann.id = cc.id
        JOIN media m ON m.id = cc.owner_id JOIN visible_media vm ON vm.media_id = m.id
        JOIN content_index_states cis ON cis.owner_kind = 'media' AND cis.owner_id = m.id
            AND cis.status = 'ready'
        JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
        WHERE cc.owner_kind = 'media' {{where}}""",
    # One row per external snapshot, carried by its latest citation in a visible conversation.
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
            FROM message_retrievals mr JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            JOIN visible_conversations vc ON vc.conversation_id = mtc.conversation_id
            WHERE mr.result_type = 'web_result' AND mr.locator IS NOT NULL
              AND mr.locator != 'null' {where}
            ORDER BY mr.source_id, mr.created_at DESC, mr.id DESC) mr
            ON mr.source_id = CAST(res.id AS text)
        WHERE res.user_id = :viewer_id""",
    # Reopen (citations) and link targets only.
    "evidence_span": """SELECT 'evidence_span' AS type, es.id, NULL AS label,
            to_tsvector('english', es.span_text) AS doc, es.span_text AS text, es.id AS span_id,
            es.span_text, es.selector, es.citation_label, es.resolver_kind, es.owner_kind,
            es.owner_id AS media_id, COALESCE(m.kind, es.owner_kind) AS media_kind,
            COALESCE(m.title, 'Note') AS media_title, m.original_published_date
        FROM evidence_spans es LEFT JOIN media m ON es.owner_kind = 'media' AND m.id = es.owner_id
        WHERE (m.id IN (SELECT media_id FROM visible_media) OR (es.owner_kind = 'note_block'
            AND es.owner_id IN (SELECT id FROM note_blocks WHERE user_id = :viewer_id))) {where}""",
    # Browse's public catalogue section.
    "gutenberg": """SELECT 'gutenberg' AS type, pg.ebook_id AS id, pg.title AS label,
            to_tsvector('english', concat_ws(' ', pg.title, credit.names, pg.subjects,
                pg.bookshelves)) AS doc, COALESCE(pg.bookshelves, pg.subjects) AS text
        FROM project_gutenberg_catalog pg LEFT JOIN (SELECT cc.project_gutenberg_catalog_ebook_id
                AS ebook_id, string_agg(cc.credited_name || ' ' || c.display_name, ' ') AS names
            FROM contributor_credits cc JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL GROUP BY 1) credit
            ON credit.ebook_id = pg.ebook_id
        WHERE TRUE {where}""",
    # Link-target and openable families.
    "library": """SELECT 'library' AS type, l.id, l.name AS label, to_tsvector('english', l.name)
            AS doc, l.name AS text
        FROM (SELECT id, CASE WHEN is_default THEN 'All' ELSE name END AS name FROM libraries) l
        JOIN memberships mem ON mem.library_id = l.id AND mem.user_id = :viewer_id
        WHERE TRUE {where}""",
    "oracle_reading": """SELECT 'oracle_reading' AS type, r.id, r.question_text AS label,
            to_tsvector('english', concat_ws(' ', r.question_text, r.folio_motto,
                r.interpretation_text)) AS doc, r.question_text AS text
        FROM oracle_readings r WHERE r.user_id = :viewer_id {where}""",
    "dossier": f"""SELECT 'dossier' AS type, a.id, s.title AS label,
            to_tsvector('english', concat_ws(' ', s.title, a.content_text)) AS doc,
            COALESCE(a.content_text, s.title) AS text
        FROM artifacts a
        LEFT JOIN media sm ON a.subject_scheme = 'media' AND sm.id = a.subject_id
        LEFT JOIN conversations sc ON a.subject_scheme = 'conversation' AND sc.id = a.subject_id
        LEFT JOIN libraries sl ON a.subject_scheme = 'library' AND sl.id = a.subject_id
        LEFT JOIN podcasts sp ON a.subject_scheme = 'podcast' AND sp.id = a.subject_id
        LEFT JOIN contributors so ON a.subject_scheme = 'contributor' AND so.id = a.subject_id
        LEFT JOIN pages sg ON a.subject_scheme = 'page' AND sg.id = a.subject_id
        LEFT JOIN note_blocks sn ON a.subject_scheme = 'note_block' AND sn.id = a.subject_id
        LEFT JOIN artifact_idea_subjects si ON a.subject_scheme = 'idea' AND si.id = a.subject_id
        CROSS JOIN LATERAL (SELECT COALESCE(sm.title, sc.title, CASE WHEN sl.is_default
            THEN 'All' ELSE sl.name END, sp.title, so.display_name, sg.title, sn.body_text,
            si.display_title, 'Dossier') AS title) s
        WHERE {head_visible_sql("a")} {{where}}""",
    "passage_anchor": """SELECT 'passage_anchor' AS type, pa.id,
            pa.selector #>> '{quote,exact}' AS label, pa.selector #>> '{quote,exact}' AS text,
            to_tsvector('english', COALESCE(pa.selector #>> '{quote,exact}', '')) AS doc
        FROM passage_anchors pa WHERE pa.user_id = :viewer_id
          AND ((pa.owner_scheme = 'media' AND pa.owner_id IN (SELECT media_id FROM visible_media))
            OR (pa.owner_scheme = 'note_block' AND pa.owner_id IN (SELECT id FROM note_blocks
                WHERE user_id = :viewer_id))) {where}""",
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
        WHERE nb.id = cc.owner_id AND nb.user_id = :viewer_id {where})""",
    "content_chunk": f"""cc.owner_kind = 'media' AND EXISTS (SELECT 1 FROM media m
        JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id = m.id
        WHERE m.id = cc.owner_id {{where}})""",
}
_HIGHLIGHT_NOTE = f""" AND EXISTS (SELECT 1 FROM resource_edges edge
    JOIN highlights h ON h.id = edge.source_id AND edge.source_scheme = 'highlight'
    WHERE edge.user_id = :viewer_id AND edge.origin = 'highlight_note'
      AND edge.target_scheme = 'note_block' AND edge.target_id = nb.id
      AND {highlight_readability_sql("h")})"""


class Hit(NamedTuple):
    type: str
    id: Any  # a UUID, or the catalogue's integer ebook id
    label: str
    score: float


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
        kinds = """ AND (vc.media_id IN (SELECT id FROM media WHERE kind = ANY(:kinds))
            OR ('podcast' = ANY(:kinds) AND vc.podcast_id IS NOT NULL))"""
        return (
            (kinds if r.content_kinds else "")
            + (" AND vc.role = ANY(:roles)" if r.roles else "")
            + (" AND vc.contributor_id = ANY(:contributor_ids)" if who else "")
        )
    kinds = " AND m.kind = ANY(:kinds)" if r.content_kinds and family != "podcast" else ""
    owner = "podcast_id" if family == "podcast" else "media_id"
    exists = credit_target_filter_exists_sql(
        owner, credited, filter_contributor_ids=who, filter_roles=bool(r.roles)
    )
    return kinds + exists


def rank(db: Session, r: Retrieval, family: str) -> list[Hit]:
    """The family's top ``r.k`` hits in rule order, within scopes and filters."""
    cell = scope_predicate(family, r.scopes, r.frozen)
    filters = _filters(family, r)
    if cell is None or filters is None or not (r.terms or family in LISTABLE):
        return []
    where = (
        cell[0]
        + filters
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
    if semantic and r.terms and r.embedding is not None:
        owner = semantic.replace("{where}", where)
        near = nearest_chunks(db, r.embedding, owner=owner, params=params, limit=max(200, 4 * r.k))
        near = [(chunk_id, cosine) for chunk_id, cosine in near if cosine >= 0.5]
        params |= {"ann_ids": [n[0] for n in near], "ann_cos": [n[1] for n in near]}
    if family == "content_chunk" and r.terms:  # never scan the whole chunk table
        where += f""" AND cc.id IN (SELECT id FROM content_chunks WHERE chunk_text_tsv @@ {TSQ}
            UNION ALL SELECT unnest(CAST(:ann_ids AS uuid[])))"""
    cosine = "s.cosine" if semantic else "NULL"
    score = f"""CAST(((CASE WHEN lower(s.label) = lower(:q) THEN 3 WHEN s.label ILIKE :prefix THEN 2
            WHEN s.label ILIKE :contains THEN 1 ELSE 0 END) + CASE WHEN s.doc @@ {TSQ}
            THEN 0.5 + ts_rank_cd(s.doc, {TSQ}, 32) / 2 ELSE COALESCE({cosine}, 0) / 2 END) / 4
        AS float8)"""
    match = f"s.doc @@ {TSQ} OR s.label ILIKE :contains OR {cosine} IS NOT NULL"
    rows = db.execute(
        text(f"""{_CTES} SELECT s.type, s.id, COALESCE(s.label, '') AS label,
                {score if r.terms else "CAST(0 AS float8)"} AS score
            FROM ({SOURCES[family].replace("{where}", where)}) s
            WHERE {match if r.terms else "TRUE"}
            ORDER BY score DESC, COALESCE(s.label, '') COLLATE "C", CAST(s.id AS text) COLLATE "C"
            LIMIT :k"""),
        params,
    )
    return [Hit(row[0], row[1], row[2], row[3]) for row in rows]


def merge(hits: Iterable[Hit]) -> list[Hit]:
    """The one cross-family order: score desc, then label, then id (as ``rank`` orders them)."""
    return sorted(hits, key=lambda hit: (-hit.score, hit.label, str(hit.id)))


def hydrate(
    db: Session, viewer_id: UUID, family: str, ids: Sequence[Any], terms: str
) -> list[RowMapping]:
    """The visible rows of ``ids`` with their projection columns and, given terms, a headline."""
    options = "'MaxWords=50, MinWords=10, MaxFragments=1'"
    headline = f"ts_headline('english', s.text, {TSQ}, {options})" if terms else "NULL"
    sql = f"""{_CTES} SELECT s.*, {headline} AS headline
        FROM ({SOURCES[family].replace("{where}", "")}) s WHERE s.id = ANY(:ids)"""
    params = {"viewer_id": viewer_id, "ids": list(ids), "q": terms, "ann_ids": [], "ann_cos": []}
    return list(db.execute(text(sql), params).mappings())
