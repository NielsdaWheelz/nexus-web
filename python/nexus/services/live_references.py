"""Saved passage words and live source places, independent of chat presentation.

Callers prove resource authority. Availability compares bounds and saved words in
SQL without loading source text; opening owns relocation against current sources.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.schemas.live_reference import (
    LiveReference,
    PdfPageTarget,
    ReferenceQuote,
    SavedReference,
)
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    PdfPageGeometryTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.resource_evidence import CapturedEvidence, CapturedPassageTarget
from nexus.services.media_text_scope import passage_scope_rows_sql
from nexus.services.resource_graph.refs import require_ref
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


def from_evidence(evidence: CapturedEvidence) -> SavedReference:
    """Keep passage words beside their place; a message always names the whole message."""
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
            if kind == "web_text_offsets" and evidence.source.media_kind in (
                "podcast_episode",
                "video",
            ):
                locator["kind"] = "TranscriptTextOffsets"
                locator["time_range"] = None
            if kind == "x_capture_offsets":
                ref = f"fragment:{raw['fragment_id']}"
        elif kind in ("note_block_offsets", "highlight_annotation_offsets"):
            locator = {
                "kind": "TextOffsets",
                "start_offset": raw["start_offset"],
                "end_offset": raw["end_offset"],
            }
        elif kind == "message_offsets":
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
    quote = evidence.quote
    return SavedReference.model_validate(
        {
            "resource_ref": ref,
            "field": target.field,
            "locator": locator,
            "quote": ReferenceQuote(**quote.model_dump(exclude={"color"}))
            if quote is not None and quote.exact.strip() and locator is not None
            else None,
        }
    )


def resolve_location(db: Session, reference: LiveReference, *, viewer_id: UUID) -> bool:
    """Check current bounds and quoted words in SQL; never materialize source text."""
    locator = reference.locator
    if locator is None:
        return True
    ref = require_ref(reference.resource_ref)
    parameters: dict[str, object] = {"id": ref.id, "viewer_id": viewer_id}
    quote = reference.quote if isinstance(reference, SavedReference) else None
    parameters["exact"] = quote.exact if quote is not None else None
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
            return False
        scopes = passage_scope_rows_sql(
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
                  AND {authority}
                  AND (CAST(:exact AS text) IS NULL OR substring(f.canonical_text FROM :start+1 FOR LEAST(:end-:start,char_length(CAST(:exact AS text))))=:exact))"""),
            parameters,
        )
        return bool(admitted)
    elif locator.kind == "TextOffsets":
        parameters |= {"start": locator.start_offset, "end": locator.end_offset}
        if reference.field == "annotation":
            table, column = "highlights", "annotation_body_text"
        elif ref.scheme == "note_block":
            table, column = "note_blocks", "body_text"
        else:
            table, column = "messages", "content"
        return bool(
            db.scalar(
                text(f"""SELECT EXISTS (SELECT 1 FROM {table}
                    WHERE id=:id AND :end<=char_length({column})
                      AND (CAST(:exact AS text) IS NULL OR substring({column} FROM :start+1 FOR LEAST(:end-:start,char_length(CAST(:exact AS text))))=:exact))"""),
                parameters,
            )
        )
    elif isinstance(locator, (PdfPageTarget, PdfPageGeometryTargetOut)):
        if ref.scheme != "media":
            return False
        parameters["page"] = locator.page_number
        page = db.execute(
            text("""SELECT p.page_width,p.page_height FROM pdf_page_text_spans p JOIN media m ON m.id=p.media_id
            WHERE m.id=:id AND m.kind='pdf' AND p.page_number=:page AND :page<=m.page_count"""),
            parameters,
        ).first()
        if page is None:
            return False
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
                return False
        return True
    else:
        assert locator.kind == "TimeRange"
        if ref.scheme != "media":
            return False
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
            return False
        return True
