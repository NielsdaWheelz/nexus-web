"""Selected-source evidence locations and fact classification before pagination.

The relation contains scalar identities/coordinates and bounded display excerpts.
It never hydrates authored bodies in foreground Python. Counts, visibility and
represented-fact coalescing precede a caller's page/window. SQL source scans and
TOAST allocations remain part of database capacity qualification.
"""

from uuid import UUID

from sqlalchemy import union_all

from nexus.auth.permissions import highlight_readability_sql
from nexus.schemas.reader_apparatus import READER_APPARATUS_FORWARD_RELATIONS
from nexus.services.locator_resolver import evidence_span_snapshot_matches_sql
from nexus.services.reader_publication_search import reader_passage_search_rows_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.summaries import resource_summary_rows_sql
from nexus.services.resource_items.capabilities import owned_child_ref_queries


def _quad_origin_sql(quads: str, axis: str) -> str:
    # Static source expressions only. Preserve the existing minimum over every
    # vertex of every quad without hydrating the geometry in a summary response.
    vertices = ", ".join(f"(quad ->> '{axis}{index}')::double precision" for index in range(1, 5))
    return f"(SELECT min(least({vertices})) FROM jsonb_array_elements({quads}) quad)"


# Marker inventory is complete independently of loaded contents or unit pages.
# Display/card capabilities remain the explicitly focused preview owner's read.
READER_EVIDENCE_MARKERS_SQL = """,
    markers AS (
        SELECT fact_kind AS kind, fact_id AS item_id, fraction,
               NULL::text AS section_id, NULL::text AS unit_key,
               NULL::uuid AS embed_id, NULL::text AS occurrence_key, NULL::integer AS embed_ordinal
        FROM fact_positions WHERE scope = 'Passages'
        UNION ALL
        SELECT 'Contents', 'contents:' || target.target_id,
               CASE WHEN fragment.document_length > 0
                   THEN (fragment.document_start + target.offset_cp)::double precision / fragment.document_length END,
               target.target_id, target.unit_key, NULL, NULL, NULL
        FROM reader_publication_targets target
        JOIN selected_units unit ON unit.unit_key = target.unit_key
        JOIN publication_fragments fragment ON fragment.fragment_id = unit.fragment_id
        WHERE target.media_id = :media_id AND target.generation = :generation
        UNION ALL
        SELECT 'Embed', 'embed:' || (embed ->> 'id'),
               CASE WHEN fragment.document_length > 0
                   THEN (fragment.document_start + (embed ->> 'canonical_start_offset')::integer)::double precision / fragment.document_length END,
               NULL, unit.unit_key, (embed ->> 'id')::uuid, embed ->> 'occurrence_key', (embed ->> 'ordinal')::integer
        FROM selected_units unit
        JOIN publication_fragments fragment ON fragment.fragment_id = unit.fragment_id
        CROSS JOIN LATERAL jsonb_array_elements(unit.embed_markers) embed
    )
"""


def reader_evidence_geometry_sql(locus: str) -> str:
    """Exact selected-locus geometry; the caller first validates its PDF source."""
    return f"""CASE {locus}.locus_scheme
        WHEN 'highlight' THEN (SELECT jsonb_agg(jsonb_build_object(
            'x1', q.x1, 'y1', q.y1, 'x2', q.x2, 'y2', q.y2,
            'x3', q.x3, 'y3', q.y3, 'x4', q.x4, 'y4', q.y4) ORDER BY q.quad_idx)
            FROM highlight_pdf_quads q WHERE q.highlight_id = {locus}.locus_id)
        WHEN 'reader_apparatus_item' THEN (SELECT location -> 'quads'
            FROM apparatus_items WHERE item_id = {locus}.locus_id)
        WHEN 'evidence_span' THEN (SELECT selector #> '{{geometry,quads}}'
            FROM evidence_spans WHERE id = {locus}.locus_id)
        WHEN 'content_chunk' THEN (SELECT span.selector #> '{{geometry,quads}}'
            FROM content_chunks chunk JOIN evidence_spans span ON span.id = chunk.primary_evidence_span_id
            WHERE chunk.id = {locus}.locus_id)
    END"""


def reader_publication_evidence_sql(*, viewer_id: UUID, media_id: UUID) -> tuple[str, dict]:
    """Return the checked-in CTEs and existing child-owner bound parameters.

    Composing the canonical Select preserves its highlight visibility and
    retained-child membership rules. Only SQL generated from that owner is
    embedded; request strings never become SQL.
    """
    children = union_all(
        *owned_child_ref_queries(viewer_id=viewer_id, ref=ResourceRef("media", media_id))
    ).compile()
    forward = ",".join(f"'{relation}'" for relation in READER_APPARATUS_FORWARD_RELATIONS)
    passage_search = reader_passage_search_rows_sql(
        "SELECT resource_id AS anchor_id FROM edge_endpoints WHERE resource_scheme = 'passage_anchor'"
    )
    related = resource_summary_rows_sql("SELECT resource_scheme, resource_id FROM edge_endpoints")
    return (
        f"""
    WITH children AS ({children}),
    local_refs AS MATERIALIZED (
        SELECT DISTINCT scheme, id FROM children
        UNION SELECT 'media'::text, CAST(:media_id AS uuid)
    ), selected_units AS (
        SELECT unit_key, ordinal, fragment_id, fragment_idx, start_cp, end_cp, embed_markers
        FROM reader_publication_units
        WHERE media_id = :media_id AND generation = :generation
    ), fragment_lengths AS (
        SELECT fragment_id, min(fragment_idx) AS fragment_idx, max(end_cp) AS length
        FROM selected_units GROUP BY fragment_id
    ), publication_fragments AS (
        SELECT *, coalesce(sum(length) OVER (
            ORDER BY fragment_idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS document_start,
        sum(length) OVER () AS document_length
        FROM fragment_lengths
    ), selected_pdf AS (
        SELECT asset.sha256, descriptor.pdf_page_count AS page_count, source.pdf_page_heights
        FROM reader_publication_artifacts asset
        JOIN reader_publication_artifacts descriptor
          ON descriptor.media_id = asset.media_id AND descriptor.generation = asset.generation
         AND descriptor.role = 'descriptor'
        JOIN reader_publication_search_sources source ON source.media_id = asset.media_id
          AND source.generation = asset.generation AND source.source_ordinal = 0
        WHERE asset.media_id = :media_id AND asset.generation = :generation
          AND asset.role = 'asset' AND asset.media_type = 'application/pdf'
    ), current_pdf AS (
        SELECT a.sha256 FROM reader_publications p JOIN reader_publication_artifacts a
          ON a.media_id = p.media_id AND a.generation = p.generation
        WHERE p.media_id = :media_id AND a.role = 'asset' AND a.media_type = 'application/pdf'
    ), visible_highlights AS (
        SELECT h.id, h.color, h.created_at, h.updated_at, h.user_id,
               h.anchor_kind, substring(h.exact FROM 1 FOR 300) AS excerpt,
               char_length(h.exact) AS excerpt_codepoints
        FROM highlights h WHERE h.anchor_media_id = :media_id
          AND ({highlight_readability_sql()})
    ), apparatus_items AS (
        SELECT item_id, ordinal, stable_key, sort_key, kind, confidence,
               location, locator_status, label_codepoints, body_codepoints,
               substring(label FROM 1 FOR 300) AS label,
               substring(body_text FROM 1 FOR 300) AS body
        FROM reader_publication_apparatus_items
        WHERE media_id = :media_id AND generation = :generation
    ), apparatus_edges AS (
        SELECT edge_id, ordinal, from_item_id, to_item_id
        FROM reader_publication_apparatus_edges
        WHERE media_id = :media_id AND generation = :generation AND relation IN ({forward})
    ), apparatus_owners AS (
        SELECT item.* FROM apparatus_items item
        WHERE right(item.kind, 4) = '_ref'
           OR EXISTS (SELECT 1 FROM apparatus_edges e WHERE e.from_item_id = item.item_id)
           OR NOT EXISTS (SELECT 1 FROM apparatus_edges e WHERE e.to_item_id = item.item_id)
    ), candidate_edges AS (
        SELECT e.id, e.kind, e.origin, e.ordinal, e.source_scheme, e.source_id,
               e.target_scheme, e.target_id, e.snapshot,
               e.origin = 'user' AND e.kind = 'context' AND e.ordinal IS NULL AND e.snapshot IS NULL
                   AND e.source_order_key IS NULL AND e.target_order_key IS NULL AS neutral,
               EXISTS (SELECT 1 FROM local_refs r WHERE r.scheme = e.source_scheme AND r.id = e.source_id) AS source_matched,
               EXISTS (SELECT 1 FROM local_refs r WHERE r.scheme = e.target_scheme AND r.id = e.target_id) AS target_matched
        FROM resource_edges e WHERE e.user_id = :viewer_id AND e.origin NOT IN ('link_note', 'document_embed')
    ), local_edges AS (
        SELECT * FROM candidate_edges WHERE source_matched OR target_matched
    ), edge_endpoints AS (
        SELECT source_scheme AS resource_scheme, source_id AS resource_id FROM local_edges
        UNION SELECT target_scheme, target_id FROM local_edges
    ), passage_positions AS ({passage_search}),
    span_positions AS (
        SELECT es.id, es.selector ->> 'fragment_id' AS fragment_id,
               (es.selector ->> 'start_offset')::integer AS start_cp,
               (es.selector ->> 'end_offset')::integer AS end_cp,
               (es.selector ->> 'page_number')::integer AS pdf_page,
               {_quad_origin_sql("es.selector #> '{geometry,quads}'", "y")} AS pdf_top,
               {_quad_origin_sql("es.selector #> '{geometry,quads}'", "x")} AS pdf_left,
               es.span_text COLLATE "C" = coalesce(nullif(es.selector #>> '{{text_quote,exact}}', ''), es.span_text) COLLATE "C"
                 AND {evidence_span_snapshot_matches_sql()} AS matches_source
        FROM evidence_spans es
        WHERE es.owner_kind = 'media' AND es.owner_id = :media_id
          AND EXISTS (
              SELECT 1 FROM edge_endpoints requested WHERE requested.resource_scheme = 'evidence_span' AND requested.resource_id = es.id
              UNION ALL
              SELECT 1 FROM content_chunks cc JOIN edge_endpoints requested
                ON requested.resource_scheme = 'content_chunk' AND requested.resource_id = cc.id
              WHERE cc.primary_evidence_span_id = es.id
          )
    ), raw_positions AS (
        SELECT 'fragment'::text AS scheme, requested.id,
               fragment.fragment_id::text AS fragment_id,
               0 AS start_cp, least(1, fragment.length) AS end_cp,
               NULL::integer AS pdf_page, NULL::double precision AS pdf_top,
               NULL::double precision AS pdf_left, TRUE AS source_verified,
               'Stale'::text AS unavailable_reason
        FROM local_refs requested LEFT JOIN publication_fragments fragment ON fragment.fragment_id = requested.id
        WHERE requested.scheme = 'fragment'
        UNION ALL
        SELECT 'highlight', h.id, hfa.fragment_id::text, hfa.start_offset, hfa.end_offset,
               hpa.page_number, hpa.sort_top::double precision, hpa.sort_left::double precision,
               CASE WHEN h.anchor_kind = 'pdf_page_geometry'
                   THEN hpa.source_sha256 = (SELECT sha256 FROM selected_pdf) ELSE TRUE END,
               CASE WHEN h.anchor_kind = 'pdf_page_geometry' AND hpa.source_sha256 IS NULL
                   THEN 'SourceUnverified' ELSE 'Stale' END
        FROM visible_highlights h
        LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
        LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
        UNION ALL
        SELECT 'reader_apparatus_item', item.item_id, item.location ->> 'fragment_id',
               (item.location ->> 'start_offset')::integer,
               (item.location ->> 'end_offset')::integer,
               (item.location ->> 'page_number')::integer,
               {_quad_origin_sql("item.location -> 'quads'", "y")},
               {_quad_origin_sql("item.location -> 'quads'", "x")},
               item.location ->> 'media_id' = CAST(:media_id AS text),
               CASE WHEN item.location IS NULL THEN 'Missing' ELSE 'Stale' END
        FROM apparatus_items item
        UNION ALL
        SELECT 'passage_anchor', p.anchor_id, p.fragment_id::text, p.raw_start, p.raw_end,
               p.page_number, NULL, NULL, p.hit_count = 1, 'Unanchorable'
        FROM passage_positions p
        UNION ALL
        SELECT 'evidence_span', p.id, p.fragment_id, p.start_cp, p.end_cp,
               p.pdf_page, p.pdf_top, p.pdf_left,
               p.matches_source AND (p.pdf_page IS NULL OR
                   (SELECT sha256 FROM selected_pdf) = (SELECT sha256 FROM current_pdf)),
               'Unanchorable'
        FROM span_positions p
        UNION ALL
        SELECT 'content_chunk', cc.id,
               CASE WHEN cc.primary_evidence_span_id IS NULL THEN cc.summary_locator ->> 'fragment_id' ELSE p.fragment_id END,
               CASE WHEN cc.primary_evidence_span_id IS NULL THEN (cc.summary_locator ->> 'start_offset')::integer ELSE p.start_cp END,
               CASE WHEN cc.primary_evidence_span_id IS NULL THEN (cc.summary_locator ->> 'end_offset')::integer ELSE p.end_cp END,
               CASE WHEN cc.primary_evidence_span_id IS NULL THEN (cc.summary_locator ->> 'page_number')::integer ELSE p.pdf_page END,
               p.pdf_top, p.pdf_left,
               (cc.primary_evidence_span_id IS NULL OR p.matches_source)
                 AND (coalesce(p.pdf_page, (cc.summary_locator ->> 'page_number')::integer) IS NULL OR
                     (SELECT sha256 FROM selected_pdf) = (SELECT sha256 FROM current_pdf)),
               'Unanchorable'
        FROM content_chunks cc JOIN local_refs requested ON requested.scheme = 'content_chunk' AND requested.id = cc.id
        LEFT JOIN span_positions p ON p.id = cc.primary_evidence_span_id
        WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
    ), positions AS (
        SELECT raw.scheme, raw.id, unit.unit_key,
               CASE WHEN unit.unit_key IS NOT NULL THEN fragment.fragment_id END AS fragment_id,
               CASE WHEN unit.unit_key IS NOT NULL THEN raw.start_cp END AS start_cp,
               CASE WHEN unit.unit_key IS NOT NULL THEN raw.end_cp END AS end_cp,
               CASE WHEN raw.source_verified AND raw.pdf_page BETWEEN 1 AND (SELECT page_count FROM selected_pdf)
                   THEN raw.pdf_page END AS pdf_page,
               raw.pdf_top, raw.pdf_left, raw.unavailable_reason,
               item.sort_key AS unavailable_order_key,
               CASE WHEN unit.unit_key IS NOT NULL THEN
                   'fragment:' || lpad(fragment.fragment_idx::text, 10, '0') || ':' || lpad(raw.start_cp::text, 10, '0')
                   WHEN raw.source_verified AND raw.pdf_page BETWEEN 1 AND (SELECT page_count FROM selected_pdf) THEN
                   'pdf:' || lpad(raw.pdf_page::text, 8, '0') || CASE WHEN raw.pdf_top IS NOT NULL THEN
                       ':' || to_char(raw.pdf_top, 'FM0000000.0000') || ':' || to_char(raw.pdf_left, 'FM0000000.0000') ELSE '' END
               END AS order_key,
               CASE WHEN unit.unit_key IS NOT NULL AND fragment.document_length > 0
                   THEN (fragment.document_start + raw.start_cp)::double precision / fragment.document_length
                   WHEN raw.source_verified AND raw.pdf_top IS NOT NULL
                     AND raw.pdf_page BETWEEN 1 AND (SELECT page_count FROM selected_pdf)
                     AND (SELECT (pdf_page_heights ->> (raw.pdf_page - 1))::double precision FROM selected_pdf) > 0
                   THEN ((raw.pdf_page - 1) + least(1.0, greatest(0.0, raw.pdf_top /
                       (SELECT (pdf_page_heights ->> (raw.pdf_page - 1))::double precision FROM selected_pdf)))) /
                       (SELECT page_count::double precision FROM selected_pdf)
               END AS fraction
        FROM raw_positions raw LEFT JOIN publication_fragments fragment ON fragment.fragment_id::text = raw.fragment_id
        LEFT JOIN apparatus_items item ON raw.scheme = 'reader_apparatus_item' AND item.item_id = raw.id
        LEFT JOIN LATERAL (
            SELECT unit.unit_key FROM selected_units unit
            WHERE raw.source_verified AND unit.fragment_id = fragment.fragment_id
              AND raw.start_cp >= 0 AND raw.end_cp >= raw.start_cp AND raw.end_cp <= fragment.length
              AND unit.start_cp <= raw.start_cp
              AND (unit.end_cp > raw.start_cp OR unit.end_cp = raw.start_cp AND raw.start_cp = fragment.length)
            ORDER BY (unit.end_cp > unit.start_cp) DESC, unit.start_cp DESC, unit.ordinal LIMIT 1
        ) unit ON TRUE
    ), related_objects AS NOT MATERIALIZED ({related}),
    edge_sides AS (
        SELECT e.*, side.scheme AS locus_scheme, side.id AS locus_id,
               side.other_scheme, side.other_id, side.direction
        FROM local_edges e
        LEFT JOIN positions source_position ON source_position.scheme = e.source_scheme AND source_position.id = e.source_id
        LEFT JOIN positions target_position ON target_position.scheme = e.target_scheme AND target_position.id = e.target_id
        CROSS JOIN LATERAL (
            SELECT e.source_scheme AS scheme, e.source_id AS id,
                   e.target_scheme AS other_scheme, e.target_id AS other_id, 'Outgoing'::text AS direction
            WHERE e.source_matched OR e.neutral AND source_position.order_key IS NOT NULL AND target_position.order_key IS NOT NULL
            UNION ALL
            SELECT e.target_scheme, e.target_id, e.source_scheme, e.source_id,
                   CASE WHEN e.neutral THEN 'Outgoing' ELSE 'Incoming' END
            WHERE e.target_matched AND NOT e.source_matched
               OR e.neutral AND source_position.order_key IS NOT NULL AND target_position.order_key IS NOT NULL
        ) side
    ), visible_edges AS (
        SELECT e.*, e.locus_scheme || ':' || e.locus_id::text AS locus_ref,
               other.object_kind, other.conversation_id,
               CASE WHEN e.origin = 'citation' AND e.ordinal IS NOT NULL THEN 'GeneratedCitation'
                   WHEN e.origin = 'synapse' THEN 'Synapse' ELSE 'Link' END AS fact_kind
        FROM edge_sides e JOIN related_objects other
          ON other.resource_scheme = CASE WHEN e.origin = 'citation' AND e.ordinal IS NOT NULL THEN e.source_scheme ELSE e.other_scheme END
         AND other.resource_id = CASE WHEN e.origin = 'citation' AND e.ordinal IS NOT NULL THEN e.source_id ELSE e.other_id END
    ), represented AS (
        SELECT 'highlight:' || h.id::text AS locus_ref, 'highlight:' || h.id::text AS fact_id
        FROM visible_highlights h
        UNION ALL
        SELECT 'reader_apparatus_item:' || item.item_id::text, 'source-reference:' || item.stable_key
        FROM apparatus_owners item
        UNION
        SELECT 'reader_apparatus_item:' || target.to_item_id::text, 'source-reference:' || owner.stable_key
        FROM apparatus_owners owner JOIN apparatus_edges target ON target.from_item_id = owner.item_id
    ), independent_loci AS (
        SELECT locus_ref FROM represented
        UNION SELECT locus_ref FROM visible_edges WHERE fact_kind IN ('GeneratedCitation', 'Synapse')
    ), classified_edges AS (
        SELECT e.*, CASE
            WHEN e.fact_kind <> 'Link' THEN 'Fact'
            WHEN e.kind = 'context' AND e.source_scheme = 'conversation'
              AND e.other_scheme = 'conversation' AND e.source_id = e.conversation_id
              AND EXISTS (SELECT 1 FROM visible_edges citation
                  WHERE citation.fact_kind = 'GeneratedCitation' AND citation.locus_ref = e.locus_ref
                    AND citation.conversation_id = e.conversation_id) THEN 'Omitted'
            WHEN EXISTS (SELECT 1 FROM represented r WHERE r.locus_ref = e.locus_ref) THEN 'DirectlyAttached'
            WHEN e.kind = 'context' AND e.locus_scheme <> 'media'
              AND EXISTS (SELECT 1 FROM independent_loci independent WHERE independent.locus_ref = e.locus_ref)
                THEN 'AlsoReferences'
            ELSE 'Fact' END AS disposition
        FROM visible_edges e
    ), facts AS (
        SELECT 'highlight:' || h.id::text AS fact_id, 'Highlight'::text AS fact_kind, 0 AS kind_order,
               'highlight'::text AS locus_scheme, h.id AS locus_id,
               h.id AS highlight_id, NULL::uuid AS item_id, NULL::uuid AS edge_id,
               NULL::text AS object_scheme, NULL::uuid AS object_id
        FROM visible_highlights h
        UNION ALL
        SELECT 'source-reference:' || item.stable_key, 'SourceReference', 1,
               'reader_apparatus_item', item.item_id, NULL, item.item_id, NULL, NULL, NULL
        FROM apparatus_owners item
        UNION ALL
        SELECT CASE e.fact_kind WHEN 'GeneratedCitation' THEN 'generated-citation:' || e.id::text
                   WHEN 'Synapse' THEN 'synapse:' || e.id::text
                   ELSE 'link:' || e.id::text || ':anchor:' || e.locus_ref END,
               e.fact_kind, CASE e.fact_kind WHEN 'GeneratedCitation' THEN 2 WHEN 'Synapse' THEN 4 ELSE 3 END,
               e.locus_scheme, e.locus_id, NULL, NULL, e.id,
               CASE WHEN e.fact_kind = 'GeneratedCitation' THEN e.source_scheme ELSE e.other_scheme END,
               CASE WHEN e.fact_kind = 'GeneratedCitation' THEN e.source_id ELSE e.other_id END
        FROM classified_edges e WHERE e.disposition = 'Fact'
    ), fact_positions AS (
        SELECT f.*, f.locus_scheme || ':' || f.locus_id::text AS locus_ref,
               p.unit_key, p.fragment_id, p.start_cp, p.end_cp, p.pdf_page,
               p.pdf_top, p.pdf_left, p.fraction,
               coalesce(p.unavailable_reason, 'Unanchorable') AS unavailable_reason,
               CASE WHEN f.locus_scheme = 'media' THEN 'Document' ELSE 'Passages' END AS scope,
               CASE WHEN p.order_key IS NOT NULL THEN 0 WHEN p.unavailable_order_key IS NOT NULL THEN 1 ELSE 2 END AS location_order,
               coalesce(p.order_key, p.unavailable_order_key, f.locus_scheme || ':' || f.locus_id::text) AS order_key
        FROM facts f LEFT JOIN positions p ON p.scheme = f.locus_scheme AND p.id = f.locus_id
    ), associations AS (
        SELECT f.fact_id, f.locus_ref, 'AuthoredIn'::text AS relationship,
               NULL::uuid AS edge_id, NULL::text AS role, NULL::text AS origin, NULL::text AS direction,
               f.object_scheme, f.object_id
        FROM fact_positions f WHERE f.fact_kind = 'GeneratedCitation'
        UNION
        SELECT represented.fact_id, e.locus_ref, 'DirectlyAttached', e.id, e.kind, e.origin, e.direction,
               e.other_scheme, e.other_id
        FROM classified_edges e JOIN represented ON represented.locus_ref = e.locus_ref
        WHERE e.disposition = 'DirectlyAttached'
        UNION
        SELECT NULL, e.locus_ref, 'AlsoReferences', NULL, NULL, NULL, NULL, e.other_scheme, e.other_id
        FROM classified_edges e WHERE e.disposition = 'AlsoReferences'
    )
    """,
        dict(children.params),
    )
