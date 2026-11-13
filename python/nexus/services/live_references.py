"""Live structural source locations, independent of chat and presentation.

Callers authorize the referenced resource first. Current coordinates resolve
without selectors, historical copies or nearest-text repair. A None byte limit
checks availability only; bounded reads measure bytes before returning text.
"""

import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.schemas.live_reference import LiveReference, PdfPageTarget, TextOffsetsTarget
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    PdfPageGeometryTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.resource_evidence import CapturedEvidence, CapturedPassageTarget
from nexus.services.media_text_scope import text_scope_rows_sql
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_graph.resolve import PromptBodyTooLarge
from nexus.services.x_source import readable_x_capture_ids_sql


def reference_visible(db: Session, *, viewer_id: UUID, reference: LiveReference) -> bool:
    """Resource authority plus the annotation field's private-owner boundary."""
    from nexus.services.resource_items.items import ref_visible

    ref = require_ref(reference.resource_ref)
    return ref_visible(db, viewer_id=viewer_id, ref=ref) and field_visible(
        db, viewer_id=viewer_id, reference=reference
    )


def field_visible(db: Session, *, viewer_id: UUID, reference: LiveReference) -> bool:
    """Private field authority; callers must also authorize the resource itself."""
    return reference.field is None or bool(
        db.scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM highlights WHERE id=:id AND user_id=:viewer AND authored_visible AND annotation_body_pm_json IS NOT NULL)"
            ),
            {"id": require_ref(reference.resource_ref).id, "viewer": viewer_id},
        )
    )


def from_evidence(evidence: CapturedEvidence) -> LiveReference:
    """Forget captured words, selectors, hashes and versions at the live-reference boundary."""
    target = evidence.target
    assert target.owner_ref is not None, "citable evidence requires a source"
    ref = target.owner_ref
    locator = None
    if isinstance(target, CapturedPassageTarget):
        raw = target.locator.model_dump(mode="json")
        kind = raw["type"]
        if kind in ("web_text_offsets", "epub_fragment_offsets", "x_capture_offsets"):
            locator = {
                "kind": "EpubTextOffsets" if kind == "epub_fragment_offsets" else "WebTextOffsets",
                "fragment_id": raw["fragment_id"],
                "start_offset": raw["start_offset"],
                "end_offset": raw["end_offset"],
            }
            if kind == "x_capture_offsets":
                ref = f"fragment:{raw['fragment_id']}"
        elif kind in ("note_block_offsets", "highlight_annotation_offsets", "message_offsets"):
            locator = {
                "kind": "TextOffsets",
                "start_offset": raw["start_offset"],
                "end_offset": raw["end_offset"],
            }
            if kind == "message_offsets":
                ref = f"message:{raw['message_id']}"
        elif kind in ("transcript_time_range", "audio_time_range", "video_time_range"):
            locator = {
                "kind": "TimeRange",
                "start_ms": raw["t_start_ms"],
                "end_ms": raw["t_end_ms"],
            }
        elif kind == "pdf_page_geometry":
            locator = {
                "kind": "PdfPageGeometry",
                "page_number": raw["page_number"],
                "quads": raw["quads"],
            }
        elif kind == "pdf_page":
            locator = {"kind": "PdfPage", "page_number": raw["page_number"]}
        elif kind != "external_url":
            raise AssertionError(f"unhandled live locator: {kind}")
    return LiveReference.model_validate(
        {"resource_ref": ref, "field": target.field, "locator": locator}
    )


def resolve_location(
    db: Session, reference: LiveReference, *, viewer_id: UUID, byte_limit: int | None
) -> tuple[bool, str | None]:
    """Current coordinates only. None byte limit checks availability without loading text."""
    locator = reference.locator
    if locator is None:
        return True, None
    ref = require_ref(reference.resource_ref)
    parameters: dict[str, object] = {"id": ref.id, "viewer_id": viewer_id}
    label = ""
    if isinstance(
        locator, (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut)
    ):
        parameters |= {
            "fragment": locator.fragment_id,
            "start": locator.start_offset,
            "end": locator.end_offset,
        }
        if ref.scheme not in ("media", "fragment") or (
            ref.scheme == "fragment" and ref.id != locator.fragment_id
        ):
            return False, None
        scopes = text_scope_rows_sql(
            "SELECT CAST(:id AS uuid) AS media_id"
            if ref.scheme == "media"
            else requested_media_ids_cte_sql()
        )
        scoped = f"""EXISTS (SELECT 1 FROM ({scopes}) s
            WHERE s.fragment_id=f.id AND :start>=s.start_offset AND :end<=s.end_offset)"""
        capture_authorized = f"f.x_post_capture_id IN ({readable_x_capture_ids_sql()})"
        authority = (
            f"{scoped} AND (f.x_post_capture_id IS NULL OR {capture_authorized})"
            if ref.scheme == "media"
            else f"((f.x_post_capture_id IS NULL AND {scoped}) OR {capture_authorized})"
        )
        admitted = db.scalar(
            text(f"""SELECT EXISTS (SELECT 1 FROM fragments f
                WHERE f.id=:fragment AND :end<=char_length(f.canonical_text)
                  AND {authority})"""),
            parameters,
        )
        if not admitted:
            return False, None
        if byte_limit is None:
            return True, None
        body_sql = "substring(canonical_text FROM :start+1 FOR :end-:start)"
        rows_sql = "FROM fragments WHERE id=:fragment AND :end<=char_length(canonical_text)"
    elif locator.kind == "TextOffsets":
        parameters |= {"start": locator.start_offset, "end": locator.end_offset}
        if reference.field == "annotation":
            table, column = "highlights", "annotation_body_text"
        elif ref.scheme == "note_block":
            table, column = "note_blocks", "body_text"
        else:
            table, column = "messages", "content"
        body_sql = f"substring({column} FROM :start+1 FOR :end-:start)"
        rows_sql = f"FROM {table} WHERE id=:id AND :end<=char_length({column})"
    elif isinstance(locator, (PdfPageTarget, PdfPageGeometryTargetOut)):
        if ref.scheme != "media":
            return False, None
        parameters["page"] = locator.page_number
        page = db.execute(
            text("""SELECT p.page_width,p.page_height FROM pdf_page_text_spans p JOIN media m ON m.id=p.media_id
            WHERE m.id=:id AND m.kind='pdf' AND p.page_number=:page AND :page<=m.page_count"""),
            parameters,
        ).first()
        if page is None:
            return False, None
        if locator.kind == "PdfPageGeometry":
            from nexus.services.reader_locations import resolved_highlight_reader_target

            target = resolved_highlight_reader_target(
                media_kind="pdf",
                anchor_kind="pdf_page_geometry",
                page_number=locator.page_number,
                page_count=locator.page_number,
                page_width=page.page_width,
                page_height=page.page_height,
                pdf_quads=[quad.model_dump() for quad in locator.quads],
            )
            if target is None:
                return False, None
            label = (
                "current page containing the selected region; exact region text is unavailable:\n"
            )
        body_sql = "substring(m.plain_text FROM p.start_offset+1 FOR p.end_offset-p.start_offset)"
        rows_sql = """FROM pdf_page_text_spans p JOIN media m ON m.id=p.media_id
            WHERE p.media_id=:id AND p.page_number=:page AND m.plain_text IS NOT NULL"""
    else:
        assert locator.kind == "TimeRange"
        if ref.scheme != "media":
            return False, None
        parameters |= {"start": locator.start_ms, "end": locator.end_ms}
        if not db.scalar(
            text(
                """SELECT EXISTS (
                    SELECT 1 FROM media m JOIN fragments f ON f.media_id=m.id
                    WHERE m.id=:id AND m.kind IN ('video','podcast_episode')
                    GROUP BY m.id HAVING min(f.t_start_ms)<=:start AND max(f.t_end_ms)>=:end
                )"""
            ),
            parameters,
        ):
            return False, None
        body_sql = "string_agg(canonical_text,E'\\n' ORDER BY idx)"
        rows_sql = """FROM fragments
            WHERE media_id=:id AND t_end_ms>:start AND t_start_ms<:end"""
        label = "current transcript overlapping the selected time range:\n"
    if byte_limit is None:
        return bool(db.scalar(text(f"SELECT EXISTS (SELECT 1 {rows_sql})"), parameters)), None
    sql = f"SELECT {body_sql} AS body {rows_sql}"
    size = db.scalar(text(f"SELECT octet_length(body) FROM ({sql}) selected"), parameters)
    if size is None:
        return False, None
    if size + len(label.encode()) > byte_limit:
        raise PromptBodyTooLarge(ref.uri)
    body = db.scalar(text(sql), parameters)
    return True, label + body


@dataclass(frozen=True, slots=True)
class ReferenceText:
    text: str
    x_capture: bool


def reference_texts(db: Session, references: list[LiveReference]) -> dict[str, ReferenceText]:
    """Bounded exact display slices after this snapshot's full-range admission.

    The extra codepoint lets the shared excerpt projection report selected-text
    omission. Ordinary fragments do not acquire an inferred reading identity.
    """
    if not references:
        return {}
    ranges = []
    for position, reference in enumerate(references):
        ref = require_ref(reference.resource_ref)
        locator = reference.locator
        assert isinstance(
            locator,
            (
                WebTextOffsetsTargetOut,
                EpubTextOffsetsTargetOut,
                TranscriptTextOffsetsTargetOut,
                TextOffsetsTarget,
            ),
        )
        ranges.append(
            {
                "position": position,
                "scheme": ref.scheme,
                "id": str(ref.id),
                "fragment": str(locator.fragment_id)
                if isinstance(
                    locator,
                    (
                        WebTextOffsetsTargetOut,
                        EpubTextOffsetsTargetOut,
                        TranscriptTextOffsetsTargetOut,
                    ),
                )
                else None,
                "start_offset": locator.start_offset,
                "end_offset": locator.end_offset,
            }
        )
    rows = db.execute(
        text("""WITH requested AS (
            SELECT * FROM jsonb_to_recordset(CAST(:ranges AS jsonb))
                AS r(position integer,scheme text,id uuid,fragment uuid,start_offset integer,end_offset integer)
        )
        SELECT r.position,substring(f.canonical_text FROM r.start_offset+1 FOR LEAST(601,r.end_offset-r.start_offset)) AS body,
               f.x_post_capture_id IS NOT NULL AS x_capture
        FROM requested r JOIN fragments f ON f.id=r.fragment
        WHERE r.end_offset<=char_length(f.canonical_text)
        UNION ALL
        SELECT r.position,substring(n.body_text FROM r.start_offset+1 FOR LEAST(601,r.end_offset-r.start_offset)),false
        FROM requested r JOIN note_blocks n ON r.scheme='note_block' AND n.id=r.id
        WHERE r.fragment IS NULL AND r.end_offset<=char_length(n.body_text)
        UNION ALL
        SELECT r.position,substring(m.content FROM r.start_offset+1 FOR LEAST(601,r.end_offset-r.start_offset)),false
        FROM requested r JOIN messages m ON r.scheme='message' AND m.id=r.id
        WHERE r.fragment IS NULL AND r.end_offset<=char_length(m.content)
        UNION ALL
        SELECT r.position,substring(h.annotation_body_text FROM r.start_offset+1 FOR LEAST(601,r.end_offset-r.start_offset)),false
        FROM requested r JOIN highlights h ON r.scheme='highlight' AND h.id=r.id
        WHERE r.fragment IS NULL AND r.end_offset<=char_length(h.annotation_body_text)"""),
        {"ranges": json.dumps(ranges)},
    ).all()
    assert len(rows) == len(references), "admitted reference text changed within its snapshot"
    return {
        references[row.position].model_dump_json(): ReferenceText(row.body, row.x_capture)
        for row in rows
    }
