"""Paged live evidence on one immutable publication.

The selected source owns positions; current graph/highlight permissions own
visibility. Detail reads retain authored text and PDF geometry. Disclosures sort
by relationship then canonical resource ref, without sorting full note bodies.
"""

import json
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.errors import ApiError, ApiErrorCode, NotFoundError, ReaderContentTooLargeError
from nexus.schemas.reader_document_map import ReaderEvidenceCountsOut
from nexus.schemas.reader_publication_evidence import (
    ReaderEvidenceAssociationsPage,
    ReaderEvidenceAssociationsRequest,
    ReaderEvidenceAssociationSummary,
    ReaderEvidenceBucketPage,
    ReaderEvidenceBucketRequest,
    ReaderEvidenceFactsPage,
    ReaderEvidenceFactsRequest,
    ReaderEvidenceFactSummary,
    ReaderEvidenceGutterItem,
    ReaderEvidenceGutterPage,
    ReaderEvidenceGutterRequest,
    ReaderEvidenceLocationRequest,
    ReaderEvidenceLocationResponse,
    ReaderEvidenceMarker,
    ReaderEvidenceMarkerCounts,
    ReaderEvidenceMarkerPreview,
    ReaderEvidenceMarkerPreviewRequest,
    ReaderEvidenceOverview,
    ReaderEvidenceOverviewBucket,
    ReaderEvidenceOverviewRequest,
    ReaderEvidenceRelatedSummary,
    ReaderEvidenceSeekRequest,
)
from nexus.services.reader_evidence_markers import READER_EVIDENCE_MARKER_TONES
from nexus.services.reader_publication_embeds import get_reader_publication_embed
from nexus.services.reader_publication_evidence_sql import (
    READER_EVIDENCE_MARKERS_SQL,
    reader_evidence_geometry_sql,
    reader_publication_evidence_sql,
)
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.summaries import RESOURCE_SUMMARY_WHITESPACE
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)

_FACT = TypeAdapter(ReaderEvidenceFactSummary)
_OBJECT = TypeAdapter(ReaderEvidenceRelatedSummary)
_ASSOCIATION = TypeAdapter(ReaderEvidenceAssociationSummary)
_ORDER_KINDS = (
    KeysetValueKind.Int,
    KeysetValueKind.Text,
    KeysetValueKind.Text,
    KeysetValueKind.Int,
    KeysetValueKind.Text,
)
_ORDER_FIELDS = ("location_order", "order_key", "locus_ref", "kind_order", "fact_id")
_ORDER_SQL = '(location_order, order_key COLLATE "C", locus_ref COLLATE "C", kind_order, fact_id COLLATE "C")'
_COUNTS_SQL = """
    SELECT count(*) FILTER (WHERE fact_kind = 'Highlight') AS highlights,
           count(*) FILTER (WHERE fact_kind IN ('SourceReference', 'GeneratedCitation')) AS citations,
           count(*) FILTER (WHERE fact_kind = 'Link') AS links,
           count(*) FILTER (WHERE fact_kind = 'Synapse') AS synapses,
           count(*) FILTER (WHERE scope = 'Passages') AS passages,
           count(*) FILTER (WHERE scope = 'Document') AS document
    FROM fact_positions
"""
_MARKER_KINDS = {
    "contents": "Contents",
    "embeds": "Embed",
    "highlights": "Highlight",
    "source_references": "SourceReference",
    "generated_citations": "GeneratedCitation",
    "links": "Link",
    "synapses": "Synapse",
}


def _source(db: Session, viewer_id: UUID, media_id: UUID, generation: int) -> tuple[str, dict]:
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    sql, params = reader_publication_evidence_sql(viewer_id=viewer_id, media_id=media_id)
    return sql, {**params, "viewer_id": viewer_id, "media_id": media_id, "generation": generation}


def _object(row, activations: dict) -> ReaderEvidenceRelatedSummary:
    ref = f"{row['object_scheme']}:{row['object_id']}"
    value = {
        "kind": row["object_kind"],
        "ref": ref,
        "label_excerpt": row["object_label"],
        "label_codepoints": row["object_label_codepoints"],
        "excerpt": row["object_excerpt"],
        "excerpt_codepoints": row["object_excerpt_codepoints"],
        "activation": activations[ref],
    }
    if row["object_kind"] == "Chat":
        value.update(conversation_id=row["conversation_id"], message_ref=row["message_ref"])
    elif row["object_kind"] == "Note":
        value["note_block_id"] = row["object_id"]
    return _OBJECT.validate_python(value)


def _position(row) -> dict:
    if row["scope"] == "Document":
        return {"kind": "Document"}
    if row["unit_key"] is not None:
        return {
            "kind": "Text",
            "range": {
                "unit_key": row["unit_key"],
                "fragment_id": str(row["fragment_id"]),
                "start_cp": row["start_cp"],
                "end_cp": row["end_cp"],
            },
        }
    if row["pdf_page"] is not None:
        return {"kind": "Pdf", "page": row["pdf_page"]}
    return {"kind": "Unavailable", "reason": row["unavailable_reason"]}


def locate_reader_publication_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceLocationRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceLocationResponse:
    sql, params = _source(db, viewer_id, media_id, generation)
    params.update(fact_id=request.fact_id, max_bytes=limits.index_bytes)
    row = (
        db.execute(
            text(
                sql
                + f""",
        addressed AS (SELECT * FROM fact_positions WHERE fact_id = :fact_id),
        geometry AS (
            SELECT {reader_evidence_geometry_sql("addressed")} AS quads
            FROM addressed WHERE addressed.pdf_page IS NOT NULL
        )
        SELECT addressed.*, (SELECT sha256 FROM selected_pdf) AS source_sha256,
               octet_length(geometry.quads::text) AS geometry_bytes,
               CASE WHEN octet_length(geometry.quads::text) <= :max_bytes THEN geometry.quads END AS quads
        FROM addressed LEFT JOIN geometry ON TRUE
        """
            ),
            params,
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence fact not found")
    if row["geometry_bytes"] is not None and row["geometry_bytes"] > limits.index_bytes:
        raise ReaderContentTooLargeError(
            "Evidence geometry exceeds query capacity",
            limit="index_bytes",
            limit_value=limits.index_bytes,
            measured=row["geometry_bytes"],
        )
    location = _position(row)
    if row["pdf_page"] is not None:
        location = {
            "kind": "PdfGeometry" if row["quads"] else "PdfPage",
            "page": row["pdf_page"],
            "source_sha256": row["source_sha256"],
        }
        if row["quads"]:
            location["quads"] = row["quads"]
    result = ReaderEvidenceLocationResponse(fact_id=request.fact_id, location=location)
    result_bytes = len(result.model_dump_json().encode()) + len(b'{"data":}')
    if result_bytes > limits.index_bytes:
        raise ReaderContentTooLargeError(
            "Evidence location exceeds query capacity",
            limit="index_bytes",
            limit_value=limits.index_bytes,
            measured=result_bytes,
        )
    return result


def get_reader_publication_marker_preview(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceMarkerPreviewRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceMarkerPreview:
    sql, params = _source(db, viewer_id, media_id, generation)
    row = (
        db.execute(
            text(
                sql
                + READER_EVIDENCE_MARKERS_SQL
                + """
            SELECT * FROM markers WHERE 'marker:' || kind || ':' || item_id = :marker_id
        """
            ),
            {**params, "marker_id": request.marker_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader marker not found")
    if row["kind"] == "Contents":
        label, label_count = db.execute(
            text("""SELECT substring(label FROM 1 FOR 300), char_length(label)
                FROM reader_publication_targets WHERE media_id = :media_id
                AND generation = :generation AND target_id = :section_id"""),
            {**params, "section_id": row["section_id"]},
        ).one()
        tone, excerpt, excerpt_count = "Neutral", None, None
    elif row["kind"] == "Embed":
        embed = get_reader_publication_embed(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            generation=generation,
            unit_key=row["unit_key"],
            embed_id=row["embed_id"],
            limits=limits,
        )
        label, label_count = embed.display.label[:300], len(embed.display.label)
        excerpt = (embed.display.description or "")[:300] or None
        excerpt_count = len(embed.display.description) if embed.display.description else None
        tone = "Warning" if embed.resolution_status in ("failed", "unsupported") else "Neutral"
    else:
        page = list_reader_publication_evidence(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            generation=generation,
            request=ReaderEvidenceSeekRequest(
                target={"kind": "Fact", "fact_id": row["item_id"]},
                scope="Passages",
                kinds=(row["kind"],),
                limit=1,
            ),
            limits=limits,
        )
        fact = page.items[0]
        label, label_count = fact.label_excerpt, fact.label_codepoints
        excerpt, excerpt_count = fact.excerpt, fact.excerpt_codepoints
        tone = READER_EVIDENCE_MARKER_TONES[fact.kind]
    result = ReaderEvidenceMarkerPreview(
        marker_id=request.marker_id,
        kind=row["kind"],
        tone=tone,
        label_excerpt=label,
        label_codepoints=label_count,
        excerpt=excerpt,
        excerpt_codepoints=excerpt_count,
    )
    result_bytes = len(result.model_dump_json().encode()) + len(b'{"data":}')
    if result_bytes > limits.index_bytes:
        raise ReaderContentTooLargeError(
            "Reader marker preview exceeds query capacity",
            limit="index_bytes",
            limit_value=limits.index_bytes,
            measured=result_bytes,
        )
    return result


def get_reader_publication_evidence_overview(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceOverviewRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceOverview:
    sql, params = _source(db, viewer_id, media_id, generation)
    params.update(kinds=list(request.kinds), bucket_count=request.bucket_count)
    counts_sql = ", ".join(
        f"count(*) FILTER (WHERE kind = '{kind}') AS {field}"
        for field, kind in _MARKER_KINDS.items()
    )
    rows = (
        db.execute(
            text(
                sql
                + READER_EVIDENCE_MARKERS_SQL
                + f"""
        SELECT CASE WHEN fraction IS NOT NULL THEN least(:bucket_count - 1, floor(fraction * :bucket_count)::integer) END AS bucket,
               {counts_sql}
        FROM markers WHERE kind = ANY(:kinds)
        GROUP BY bucket ORDER BY bucket
    """
            ),
            params,
        )
        .mappings()
        .all()
    )
    buckets = []
    unavailable = ReaderEvidenceMarkerCounts(**dict.fromkeys(_MARKER_KINDS, 0))
    for row in rows:
        counts = ReaderEvidenceMarkerCounts(**{field: row[field] for field in _MARKER_KINDS})
        if row["bucket"] is None:
            unavailable = counts
        else:
            buckets.append(ReaderEvidenceOverviewBucket(index=row["bucket"], counts=counts))
    result = ReaderEvidenceOverview(
        bucket_count=request.bucket_count,
        buckets=tuple(buckets),
        unavailable_counts=unavailable,
    )
    result_bytes = len(result.model_dump_json().encode()) + len(b'{"data":}')
    if result_bytes > limits.index_bytes:
        raise ReaderContentTooLargeError(
            "Evidence overview exceeds query capacity",
            limit="index_bytes",
            limit_value=limits.index_bytes,
            measured=result_bytes,
        )
    return result


def list_reader_publication_evidence_bucket(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceBucketRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceBucketPage:
    if request.index >= request.bucket_count:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence bucket is out of range")
    sql, params = _source(db, viewer_id, media_id, generation)
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "kinds": sorted(set(request.kinds)),
        "bucket_count": request.bucket_count,
        "index": request.index,
    }
    params.update(
        kinds=list(request.kinds),
        bucket_count=request.bucket_count,
        bucket_index=request.index,
        limit=request.limit + 1,
    )
    where = "kind = ANY(:kinds) AND fraction IS NOT NULL AND least(:bucket_count - 1, floor(fraction * :bucket_count)::integer) = :bucket_index"
    if request.after is not None:
        after = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationEvidenceBucket",
            query=binding,
            expected_kinds=(KeysetValueKind.Text,) * 3,
        )
        params.update(zip(("after_fraction", "after_kind", "after_item"), after, strict=True))
        where += ' AND (fraction, kind COLLATE "C", item_id COLLATE "C") > (CAST(:after_fraction AS double precision), :after_kind, :after_item)'
    rows = (
        db.execute(
            text(
                sql
                + READER_EVIDENCE_MARKERS_SQL
                + f"""
        SELECT *, fraction::text AS fraction_cursor FROM markers WHERE {where}
        ORDER BY fraction, kind COLLATE "C", item_id COLLATE "C" LIMIT :limit
    """
            ),
            params,
        )
        .mappings()
        .all()
    )
    items, previous_cursor = [], None
    for row in rows:
        if row["kind"] == "Contents":
            target = {
                "kind": "Contents",
                "section_id": row["section_id"],
                "unit_key": row["unit_key"],
            }
        elif row["kind"] == "Embed":
            target = {
                "kind": "Embed",
                "unit_key": row["unit_key"],
                "id": row["embed_id"],
                "occurrence_key": row["occurrence_key"],
                "ordinal": row["embed_ordinal"],
            }
        else:
            target = {"kind": "Fact", "fact_id": row["item_id"]}
        item = ReaderEvidenceMarker(
            id=f"marker:{row['kind']}:{row['item_id']}",
            kind=row["kind"],
            item_id=row["item_id"],
            position=row["fraction"],
            target=target,
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationEvidenceBucket",
            query=binding,
            after=tuple(
                KeysetValue(KeysetValueKind.Text, row[field])
                for field in ("fraction_cursor", "kind", "item_id")
            ),
        )
        candidate = ReaderEvidenceBucketPage(items=(*items, item), next_cursor=cursor)
        page_bytes = len(candidate.model_dump_json().encode()) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Evidence marker exceeds query capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderEvidenceBucketPage(items=tuple(items), next_cursor=previous_cursor)
        items.append(item)
        previous_cursor = cursor
    return ReaderEvidenceBucketPage(items=tuple(items), next_cursor=None)


def list_reader_publication_gutter(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceGutterRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceGutterPage:
    sql, params = _source(db, viewer_id, media_id, generation)
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "window": request.window.model_dump(mode="json"),
        "kinds": sorted(set(request.kinds)),
        "include_stances": request.include_stances,
    }
    params.update(
        kinds=list(request.kinds),
        include_stances=request.include_stances,
        limit=request.limit + 1,
        max_bytes=limits.index_bytes,
    )
    if request.window.kind == "Text":
        params["visible_units"] = json.dumps([unit.model_dump() for unit in request.window.units])
        sql += """, visible_units AS (
            SELECT input.unit_key, input.ranges, unit.fragment_id, unit.start_cp, unit.end_cp
            FROM jsonb_to_recordset(CAST(:visible_units AS jsonb)) input(unit_key text, ranges jsonb)
            LEFT JOIN selected_units unit ON unit.unit_key = input.unit_key
        )"""
        invalid = db.scalar(
            text(
                sql
                + """
            SELECT EXISTS(SELECT 1 FROM visible_units unit WHERE fragment_id IS NULL
                OR jsonb_array_length(ranges) = 0 AND start_cp <> end_cp
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(ranges) range
                    WHERE (range ->> 0)::bigint < start_cp OR (range ->> 1)::bigint > end_cp))
        """
            ),
            params,
        )
        visible = """EXISTS (SELECT 1 FROM visible_units unit
            WHERE unit.fragment_id = fact.fragment_id AND (
                jsonb_array_length(unit.ranges) = 0 AND unit.unit_key = fact.unit_key
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(unit.ranges) range WHERE
                    fact.start_cp < (range ->> 1)::integer AND fact.end_cp > (range ->> 0)::integer
                    OR fact.start_cp = fact.end_cp AND fact.unit_key = unit.unit_key
                       AND fact.start_cp BETWEEN (range ->> 0)::integer AND (range ->> 1)::integer
                    OR (range ->> 0)::integer = (range ->> 1)::integer
                       AND (range ->> 0)::integer >= fact.start_cp AND (range ->> 0)::integer < fact.end_cp
                )))"""
        geometry = "NULL::jsonb"
    else:
        params["visible_pages"] = json.dumps([page.model_dump() for page in request.window.pages])
        sql += """, visible_pages AS (
            SELECT page, (rect ->> 'left')::double precision AS rect_left,
                   (rect ->> 'top')::double precision AS rect_top,
                   (rect ->> 'right')::double precision AS rect_right,
                   (rect ->> 'bottom')::double precision AS rect_bottom
            FROM jsonb_to_recordset(CAST(:visible_pages AS jsonb)) input(page integer, rect jsonb)
        )"""
        invalid = db.scalar(
            text(
                sql
                + """SELECT EXISTS(SELECT 1 FROM visible_pages
            WHERE page > coalesce((SELECT page_count FROM selected_pdf), 0))"""
            ),
            params,
        )
        geometry = reader_evidence_geometry_sql("fact")
        visible = """EXISTS (SELECT 1 FROM visible_pages page WHERE page.page = fact.pdf_page AND (
            quads IS NULL OR quads = '[]'::jsonb OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(quads) quad WHERE
                    greatest((quad ->> 'x1')::double precision, (quad ->> 'x2')::double precision,
                             (quad ->> 'x3')::double precision, (quad ->> 'x4')::double precision) > page.rect_left
                    AND least((quad ->> 'x1')::double precision, (quad ->> 'x2')::double precision,
                              (quad ->> 'x3')::double precision, (quad ->> 'x4')::double precision) < page.rect_right
                    AND greatest((quad ->> 'y1')::double precision, (quad ->> 'y2')::double precision,
                                 (quad ->> 'y3')::double precision, (quad ->> 'y4')::double precision) > page.rect_top
                    AND least((quad ->> 'y1')::double precision, (quad ->> 'y2')::double precision,
                              (quad ->> 'y3')::double precision, (quad ->> 'y4')::double precision) < page.rect_bottom
            )))"""
    if invalid:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Viewport does not belong to selected source"
        )
    sql += f""", located AS (
        SELECT fact.*, {geometry} AS quads FROM fact_positions fact
        WHERE fact.scope = 'Passages' AND (fact.unit_key IS NOT NULL OR fact.pdf_page IS NOT NULL)
    ), visible AS (SELECT * FROM located fact WHERE {visible}), occurrences AS (
        SELECT fact.*, 'margin:' || fact.fact_id AS occurrence_id, fact.fact_kind AS occurrence_kind,
               0 AS occurrence_order, ''::text AS object_ref, NULL::uuid AS stance_edge, NULL::text AS stance
        FROM visible fact WHERE fact.fact_kind = ANY(:kinds)
        UNION ALL
        SELECT fact.*, 'margin:stance:' || association.edge_id::text, 'Stance', 1,
               association.object_scheme || ':' || association.object_id::text,
               association.edge_id, association.role
        FROM visible fact JOIN associations association ON association.fact_id = fact.fact_id
        WHERE :include_stances AND fact.fact_kind = 'Highlight'
          AND association.relationship = 'DirectlyAttached' AND association.origin = 'user'
          AND association.direction = 'Outgoing' AND association.role IN ('supports', 'contradicts')
    )"""
    fields = (*_ORDER_FIELDS, "occurrence_order", "object_ref", "occurrence_id")
    kinds = (*_ORDER_KINDS, KeysetValueKind.Int, KeysetValueKind.Text, KeysetValueKind.Text)
    order = (
        "("
        + ", ".join(
            field + (' COLLATE "C"' if kind == KeysetValueKind.Text else "")
            for field, kind in zip(fields, kinds, strict=True)
        )
        + ")"
    )
    where = "TRUE"
    if request.after is not None:
        after = decode_signed_keyset_cursor(
            request.after, family="ReaderPublicationGutter", query=binding, expected_kinds=kinds
        )
        params.update((f"after_{i}", value) for i, value in enumerate(after))
        where = f"{order} > (" + ", ".join(f":after_{i}" for i in range(len(fields))) + ")"
    rows = (
        db.execute(
            text(
                sql
                + f""", counts AS (SELECT count(*) AS total_count FROM occurrences),
        page AS (SELECT * FROM occurrences WHERE {where} ORDER BY {order} LIMIT :limit)
        SELECT counts.total_count, page.fact_id, page.fact_kind, page.location_order,
            page.order_key, page.locus_ref, page.kind_order, page.occurrence_order,
            page.object_ref, page.occurrence_id, page.occurrence_kind, page.stance_edge, page.stance,
            page.unit_key, page.fragment_id, page.start_cp, page.end_cp, page.pdf_page,
            page.scope, page.unavailable_reason, octet_length(page.quads::text) AS geometry_bytes,
            CASE WHEN octet_length(page.quads::text) <= :max_bytes THEN page.quads END AS quads,
            (SELECT sha256 FROM selected_pdf) AS source_sha256,
            (SELECT related.excerpt FROM associations association JOIN related_objects related
               ON related.resource_scheme = association.object_scheme AND related.resource_id = association.object_id
               WHERE association.fact_id = page.fact_id AND association.relationship = 'DirectlyAttached'
                 AND association.origin = 'highlight_note' AND association.direction = 'Outgoing'
                 AND related.object_kind = 'Note' AND related.excerpt_codepoints > 0
               ORDER BY related.resource_scheme || ':' || related.resource_id::text LIMIT 1) AS note_excerpt,
            (SELECT related.excerpt_codepoints FROM associations association JOIN related_objects related
               ON related.resource_scheme = association.object_scheme AND related.resource_id = association.object_id
               WHERE association.fact_id = page.fact_id AND association.relationship = 'DirectlyAttached'
                 AND association.origin = 'highlight_note' AND association.direction = 'Outgoing'
                 AND related.object_kind = 'Note' AND related.excerpt_codepoints > 0
               ORDER BY related.resource_scheme || ':' || related.resource_id::text LIMIT 1) AS note_codepoints,
            (SELECT target.body FROM apparatus_edges edge JOIN apparatus_items target ON target.item_id = edge.to_item_id
               WHERE edge.from_item_id = page.item_id AND target.body_codepoints > 0 ORDER BY edge.ordinal LIMIT 1) AS target_excerpt,
            (SELECT target.body_codepoints FROM apparatus_edges edge JOIN apparatus_items target ON target.item_id = edge.to_item_id
               WHERE edge.from_item_id = page.item_id AND target.body_codepoints > 0 ORDER BY edge.ordinal LIMIT 1) AS target_codepoints
        FROM counts LEFT JOIN page ON TRUE
        ORDER BY page.location_order, page.order_key COLLATE "C", page.locus_ref COLLATE "C",
                 page.kind_order, page.fact_id COLLATE "C", page.occurrence_order, page.object_ref COLLATE "C", page.occurrence_id COLLATE "C"
    """
            ),
            params,
        )
        .mappings()
        .all()
    )
    total = rows[0]["total_count"]
    rows = [row for row in rows if row["fact_id"] is not None]
    if not rows:
        return ReaderEvidenceGutterPage(items=(), total_count=total, next_cursor=None)
    summaries = list_reader_publication_evidence(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        request=ReaderEvidenceFactsRequest(
            scope="Passages",
            kinds=("Highlight", "SourceReference", "GeneratedCitation", "Link", "Synapse"),
            window=None,
            after=None,
            limit=25,
        ),
        limits=limits,
        selected_facts=tuple(dict.fromkeys(row["fact_id"] for row in rows)),
    )
    by_id = {item.id: item for item in summaries.items}
    items, previous_cursor = [], None
    for row in rows:
        if row["fact_id"] not in by_id or (row["geometry_bytes"] or 0) > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader gutter item exceeds query capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=row["geometry_bytes"] or 0,
                )
            return ReaderEvidenceGutterPage(
                items=tuple(items), total_count=total, next_cursor=previous_cursor
            )
        fact = by_id[row["fact_id"]]
        location = _position(row)
        if row["pdf_page"] is not None:
            location = {
                "kind": "PdfGeometry" if row["quads"] else "PdfPage",
                "page": row["pdf_page"],
                "source_sha256": row["source_sha256"],
            }
            if row["quads"]:
                location["quads"] = row["quads"]
        label, label_count = fact.label_excerpt, fact.label_codepoints
        excerpt, excerpt_count = fact.excerpt, fact.excerpt_codepoints
        if row["occurrence_kind"] == "Stance":
            label = "Conceded" if row["stance"] == "supports" else "Doubted"
            label_count, excerpt, excerpt_count = len(label), None, None
        elif fact.kind == "Highlight" and row["note_excerpt"]:
            excerpt, excerpt_count = row["note_excerpt"], row["note_codepoints"]
        elif fact.kind == "SourceReference" and row["target_excerpt"]:
            excerpt, excerpt_count = row["target_excerpt"], row["target_codepoints"]
        item = ReaderEvidenceGutterItem(
            id=row["occurrence_id"],
            fact_id=fact.id,
            kind=row["occurrence_kind"],
            label_excerpt=label,
            label_codepoints=label_count,
            excerpt=excerpt,
            excerpt_codepoints=excerpt_count,
            location=location,
            edge_id=row["stance_edge"]
            if row["stance"]
            else fact.edge_id
            if fact.kind == "Synapse"
            else None,
            stance=row["stance"],
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationGutter",
            query=binding,
            after=tuple(
                KeysetValue(kind, row[field]) for kind, field in zip(kinds, fields, strict=True)
            ),
        )
        candidate = ReaderEvidenceGutterPage(
            items=(*items, item), total_count=total, next_cursor=cursor
        )
        page_bytes = len(candidate.model_dump_json().encode()) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader gutter item exceeds query capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderEvidenceGutterPage(
                items=tuple(items), total_count=total, next_cursor=previous_cursor
            )
        items.append(item)
        previous_cursor = cursor
    return ReaderEvidenceGutterPage(items=tuple(items), total_count=total, next_cursor=None)


def list_reader_publication_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceFactsRequest | ReaderEvidenceSeekRequest,
    limits: ReaderPublicationLimits,
    selected_facts: tuple[str, ...] | None = None,
) -> ReaderEvidenceFactsPage:
    sql, params = _source(db, viewer_id, media_id, generation)
    seeking = isinstance(request, ReaderEvidenceSeekRequest)
    window = None if seeking else request.window
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "scope": request.scope,
        "kinds": sorted(set(request.kinds)),
        "window": window.model_dump(mode="json") if window else None,
    }
    params.update(scope=request.scope, kinds=list(request.kinds), limit=request.limit + 1)
    where = "scope = :scope AND fact_kind = ANY(:kinds)"
    if selected_facts is not None:
        where += " AND fact_id = ANY(:selected_facts)"
        params["selected_facts"] = list(selected_facts)
    if window is not None:
        if window.kind == "Unit":
            get_reader_publication_member_for_viewer(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                generation=generation,
                key=window.unit_key,
                role="unit",
            )
            params["window_unit"] = window.unit_key
            where += """ AND EXISTS (SELECT 1 FROM selected_units visible
                WHERE visible.unit_key = :window_unit AND visible.fragment_id = fact_positions.fragment_id
                  AND (fact_positions.start_cp < visible.end_cp AND fact_positions.end_cp > visible.start_cp
                    OR fact_positions.start_cp = fact_positions.end_cp AND fact_positions.unit_key = visible.unit_key))"""
        elif window.kind == "PdfPage":
            params["window_page"] = window.page
            where += " AND pdf_page = :window_page"
        else:
            if window.index >= window.bucket_count:
                raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence bucket is out of range")
            params.update(bucket_count=window.bucket_count, bucket_index=window.index)
            where += " AND least(:bucket_count - 1, floor(fraction * :bucket_count)::integer) = :bucket_index"
    after = None if seeking else request.after
    if after is not None:
        values = decode_signed_keyset_cursor(
            after,
            family="ReaderPublicationEvidence",
            query=binding,
            expected_kinds=_ORDER_KINDS,
        )
        params.update(zip((f"after_{i}" for i in range(5)), values, strict=True))
        where += f" AND {_ORDER_SQL} > (:after_0, :after_1, :after_2, :after_3, :after_4)"
    if seeking:
        if request.target.kind == "Fact":
            seek_fact = request.target.fact_id
        else:
            # The old source-marker map overwrote shared targets in displayed
            # passage/fact order. Resolve that same final owner in SQL.
            seek_fact = db.scalar(
                text(
                    sql
                    + f"""
                    SELECT fact_id FROM fact_positions fact
                    JOIN apparatus_items owner ON owner.item_id = fact.item_id
                    WHERE fact.fact_kind = 'SourceReference' AND (
                        owner.stable_key = :stable_key OR EXISTS (
                            SELECT 1 FROM apparatus_edges edge
                            JOIN apparatus_items target ON target.item_id = edge.to_item_id
                            WHERE edge.from_item_id = owner.item_id AND target.stable_key = :stable_key
                        )) ORDER BY {_ORDER_SQL} DESC LIMIT 1
                """
                ),
                {**params, "stable_key": request.target.stable_key},
            )
        if seek_fact is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source reference not found")
        params["seek_fact"] = seek_fact
        where += f" AND {_ORDER_SQL} >= (SELECT location_order, order_key, locus_ref, kind_order, fact_id FROM fact_positions WHERE fact_id = :seek_fact)"
    rows = (
        db.execute(
            text(
                sql
                + f""",
        counts AS ({_COUNTS_SQL}),
        page AS (SELECT * FROM fact_positions WHERE {where} ORDER BY {_ORDER_SQL} LIMIT :limit)
        SELECT counts.*, page.*,
               h.color, h.created_at, h.updated_at, h.user_id,
               h.excerpt AS highlight_excerpt, h.excerpt_codepoints AS highlight_codepoints,
               item.stable_key, item.kind AS apparatus_kind, item.confidence,
               coalesce(nullif(item.label, ''), first_label.label, 'Source reference') AS source_label,
               coalesce(nullif(item.label_codepoints, 0), first_label.label_codepoints, 16) AS source_label_codepoints,
               coalesce(nullif(item.body, ''), first_body.body) AS source_excerpt,
               coalesce(nullif(item.body_codepoints, 0), first_body.body_codepoints) AS source_excerpt_codepoints,
               (SELECT count(DISTINCT e.to_item_id) FROM apparatus_edges e WHERE e.from_item_id = page.item_id) AS target_count,
               edge.kind AS role, edge.origin,
               substring(btrim(edge.snapshot ->> 'title', '{RESOURCE_SUMMARY_WHITESPACE}') FROM 1 FOR 300) AS snapshot_title,
               char_length(btrim(edge.snapshot ->> 'title', '{RESOURCE_SUMMARY_WHITESPACE}')) AS snapshot_title_codepoints,
               substring(CASE WHEN page.fact_kind = 'GeneratedCitation'
                   THEN btrim(edge.snapshot ->> 'excerpt', '{RESOURCE_SUMMARY_WHITESPACE}') ELSE edge.snapshot ->> 'excerpt' END FROM 1 FOR 300) AS snapshot_excerpt,
               char_length(CASE WHEN page.fact_kind = 'GeneratedCitation'
                   THEN btrim(edge.snapshot ->> 'excerpt', '{RESOURCE_SUMMARY_WHITESPACE}') ELSE edge.snapshot ->> 'excerpt' END) AS snapshot_excerpt_codepoints,
               related.object_kind, related.label_excerpt AS object_label,
               related.label_codepoints AS object_label_codepoints,
               related.excerpt AS object_excerpt, related.excerpt_codepoints AS object_excerpt_codepoints,
               related.conversation_id, related.message_ref,
               (SELECT count(*) FROM associations a WHERE a.fact_id = page.fact_id) AS association_count,
               (SELECT count(*) FROM associations a WHERE a.locus_ref = page.locus_ref AND a.relationship = 'AlsoReferences') AS also_reference_count
        FROM counts LEFT JOIN page ON TRUE
        LEFT JOIN visible_highlights h ON h.id = page.highlight_id
        LEFT JOIN apparatus_items item ON item.item_id = page.item_id
        LEFT JOIN LATERAL (
            SELECT target.label, target.label_codepoints FROM apparatus_edges e JOIN apparatus_items target ON target.item_id = e.to_item_id
            WHERE e.from_item_id = page.item_id AND target.label_codepoints > 0 ORDER BY e.ordinal LIMIT 1
        ) first_label ON TRUE
        LEFT JOIN LATERAL (
            SELECT target.body, target.body_codepoints FROM apparatus_edges e JOIN apparatus_items target ON target.item_id = e.to_item_id
            WHERE e.from_item_id = page.item_id AND target.body_codepoints > 0 ORDER BY e.ordinal LIMIT 1
        ) first_body ON TRUE
        LEFT JOIN resource_edges edge ON edge.id = page.edge_id
        LEFT JOIN related_objects related ON related.resource_scheme = page.object_scheme AND related.resource_id = page.object_id
        ORDER BY page.location_order, page.order_key COLLATE "C", page.locus_ref COLLATE "C", page.kind_order, page.fact_id COLLATE "C"
    """
            ),
            params,
        )
        .mappings()
        .all()
    )
    counts = ReaderEvidenceCountsOut(
        **{name: rows[0][name] for name in ReaderEvidenceCountsOut.model_fields}
    )
    rows = [row for row in rows if row["fact_id"] is not None]
    if seeking and not any(row["fact_id"] == seek_fact for row in rows):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence fact not found in this scope")
    refs = [
        ResourceRef(row["object_scheme"], row["object_id"])
        for row in rows
        if row["object_id"] is not None
    ]
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=refs)
    items = []
    previous_cursor = None
    for row in rows:
        common = {
            "kind": row["fact_kind"],
            "id": row["fact_id"],
            "locus_ref": row["locus_ref"],
            "position": _position(row),
            "association_count": row["association_count"],
            "also_reference_count": row["also_reference_count"],
        }
        if row["fact_kind"] == "Highlight":
            common.update(
                label_excerpt=row["highlight_excerpt"] or "Highlight",
                label_codepoints=row["highlight_codepoints"] or 9,
                excerpt=row["highlight_excerpt"] or None,
                excerpt_codepoints=row["highlight_codepoints"] or None,
                highlight_id=row["highlight_id"],
                color=row["color"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                author_user_id=row["user_id"],
                is_owner=row["user_id"] == viewer_id,
            )
        elif row["fact_kind"] == "SourceReference":
            common.update(
                label_excerpt=row["source_label"],
                label_codepoints=row["source_label_codepoints"],
                excerpt=row["source_excerpt"],
                excerpt_codepoints=row["source_excerpt_codepoints"],
                item_id=row["item_id"],
                stable_key=row["stable_key"],
                apparatus_kind=row["apparatus_kind"],
                confidence=row["confidence"],
                target_count=row["target_count"],
            )
        else:
            label, label_count = row["object_label"], row["object_label_codepoints"]
            if row["fact_kind"] == "GeneratedCitation":
                label, label_count = f"Cited by {label}"[:300], label_count + 9
                if row["snapshot_title"]:
                    label, label_count = (
                        row["snapshot_title"],
                        row["snapshot_title_codepoints"],
                    )
            excerpt = row["snapshot_excerpt"] or row["object_excerpt"]
            excerpt_count = (
                row["snapshot_excerpt_codepoints"]
                if row["snapshot_excerpt"]
                else row["object_excerpt_codepoints"]
            )
            common.update(
                label_excerpt=label,
                label_codepoints=label_count,
                excerpt=excerpt,
                excerpt_codepoints=excerpt_count,
                edge_id=row["edge_id"],
                role=row["role"],
            )
            if row["fact_kind"] != "GeneratedCitation":
                common["object"] = _object(row, activations)
            if row["fact_kind"] == "Link":
                common["origin"] = row["origin"]
        item = _FACT.validate_python(common)
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationEvidence",
            query=binding,
            after=tuple(
                KeysetValue(kind, row[field])
                for kind, field in zip(_ORDER_KINDS, _ORDER_FIELDS, strict=True)
            ),
        )
        candidate = ReaderEvidenceFactsPage(items=(*items, item), counts=counts, next_cursor=cursor)
        page_bytes = len(candidate.model_dump_json().encode()) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Evidence fact exceeds query capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderEvidenceFactsPage(
                items=tuple(items), counts=counts, next_cursor=previous_cursor
            )
        items.append(item)
        previous_cursor = cursor
    return ReaderEvidenceFactsPage(items=tuple(items), counts=counts, next_cursor=None)


def list_reader_publication_evidence_associations(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderEvidenceAssociationsRequest,
    limits: ReaderPublicationLimits,
) -> ReaderEvidenceAssociationsPage:
    sql, params = _source(db, viewer_id, media_id, generation)
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "target": request.target.model_dump(mode="json"),
    }
    if request.target.kind == "Fact":
        where, params["target"] = "a.fact_id = :target", request.target.fact_id
    else:
        where, params["target"] = (
            "a.locus_ref = :target AND a.relationship = 'AlsoReferences'",
            request.target.locus_ref,
        )
    order = "(a.relationship, a.object_scheme || ':' || a.object_id::text, coalesce(a.edge_id::text, ''))"
    if request.after is not None:
        values = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationEvidenceAssociations",
            query=binding,
            expected_kinds=(KeysetValueKind.Text,) * 3,
        )
        params.update(zip(("after_relationship", "after_ref", "after_edge"), values, strict=True))
        where += f" AND {order} > (:after_relationship, :after_ref, :after_edge)"
    params["limit"] = request.limit + 1
    rows = (
        db.execute(
            text(
                sql
                + f"""
        SELECT a.*, related.object_kind, related.label_excerpt AS object_label,
               related.label_codepoints AS object_label_codepoints,
               related.excerpt AS object_excerpt, related.excerpt_codepoints AS object_excerpt_codepoints,
               related.conversation_id, related.message_ref
        FROM associations a JOIN related_objects related
          ON related.resource_scheme = a.object_scheme AND related.resource_id = a.object_id
        WHERE {where} ORDER BY {order} LIMIT :limit
    """
            ),
            params,
        )
        .mappings()
        .all()
    )
    refs = [ResourceRef(row["object_scheme"], row["object_id"]) for row in rows]
    activations = resource_activations_for_refs(db, viewer_id=viewer_id, refs=refs)
    items, previous_cursor = [], None
    for row in rows:
        value = {"relationship": row["relationship"], "object": _object(row, activations)}
        if row["relationship"] == "DirectlyAttached":
            value.update(
                {field: row[field] for field in ("edge_id", "role", "origin", "direction")}
            )
        item = _ASSOCIATION.validate_python(value)
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationEvidenceAssociations",
            query=binding,
            after=tuple(
                KeysetValue(KeysetValueKind.Text, v)
                for v in (
                    row["relationship"],
                    f"{row['object_scheme']}:{row['object_id']}",
                    str(row["edge_id"] or ""),
                )
            ),
        )
        candidate = ReaderEvidenceAssociationsPage(items=(*items, item), next_cursor=cursor)
        page_bytes = len(candidate.model_dump_json().encode()) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Evidence association exceeds query capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return ReaderEvidenceAssociationsPage(items=tuple(items), next_cursor=previous_cursor)
        items.append(item)
        previous_cursor = cursor
    return ReaderEvidenceAssociationsPage(items=tuple(items), next_cursor=None)
