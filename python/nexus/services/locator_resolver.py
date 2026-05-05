"""Backend-owned evidence locator resolution."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, NotFoundError


def resolve_evidence_span(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
    index_run_id: UUID | None = None,
) -> dict[str, Any]:
    row = (
        db.execute(
            text(
                """
            SELECT
                es.id,
                es.media_id,
                es.span_text,
                es.index_run_id,
                es.selector,
                es.citation_label,
                es.resolver_kind,
                ss.source_fingerprint,
                ss.metadata AS snapshot_metadata
            FROM evidence_spans es
            LEFT JOIN source_snapshots ss
              ON ss.id = es.source_snapshot_id
            WHERE es.id = :evidence_span_id
            """
            ),
            {"evidence_span_id": evidence_span_id},
        )
        .mappings()
        .first()
    )
    if (
        row is None
        or row["media_id"] != media_id
        or (index_run_id is not None and row["index_run_id"] != index_run_id)
        or not can_read_media(db, viewer_id, media_id)
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    selector: dict[str, Any] = row["selector"] if isinstance(row["selector"], dict) else {}
    resolver_kind = str(row["resolver_kind"])
    params: dict[str, str] = {"evidence": str(evidence_span_id)}
    raw_text_quote = selector.get("text_quote")
    text_quote: dict[str, Any] = raw_text_quote if isinstance(raw_text_quote, dict) else {}
    exact = str(text_quote.get("exact") or row["span_text"] or "")
    prefix = str(text_quote.get("prefix") or "")
    suffix = str(text_quote.get("suffix") or "")
    snapshot_text_matches = _evidence_span_snapshot_matches(
        db,
        evidence_span_id=evidence_span_id,
        exact=exact,
    )
    status = "unresolved"
    highlight: dict[str, Any] | None = None

    if resolver_kind == "web":
        fragment_id = selector.get("fragment_id")
        start_offset = selector.get("start_offset")
        end_offset = selector.get("end_offset")
        if isinstance(fragment_id, str):
            params["fragment"] = fragment_id
        if (
            isinstance(fragment_id, str)
            and isinstance(start_offset, int)
            and isinstance(end_offset, int)
            and snapshot_text_matches
        ):
            status = "resolved"
            highlight = {
                "kind": "web_text",
                "evidence_span_id": str(evidence_span_id),
                "fragment_id": fragment_id,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }

    elif resolver_kind == "epub":
        section_id = selector.get("section_id")
        fragment_id = selector.get("fragment_id")
        start_offset = selector.get("start_offset")
        end_offset = selector.get("end_offset")
        if isinstance(section_id, str):
            params["loc"] = section_id
        if isinstance(fragment_id, str):
            params["fragment"] = fragment_id
        if (
            isinstance(fragment_id, str)
            and isinstance(start_offset, int)
            and isinstance(end_offset, int)
            and snapshot_text_matches
        ):
            status = "resolved"
            highlight = {
                "kind": "epub_text",
                "evidence_span_id": str(evidence_span_id),
                "fragment_id": fragment_id,
                "section_id": section_id if isinstance(section_id, str) else None,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text_quote": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }

    elif resolver_kind == "pdf":
        page_number = selector.get("page_number")
        if isinstance(page_number, int) and page_number >= 1:
            params["page"] = str(page_number)
        raw_geometry = selector.get("geometry")
        geometry: dict[str, Any] = raw_geometry if isinstance(raw_geometry, dict) else {}
        raw_geometry_quads = geometry.get("quads")
        raw_quads = raw_geometry_quads if isinstance(raw_geometry_quads, list) else []
        quads: list[dict[str, float]] = []
        for raw_quad in raw_quads:
            if not isinstance(raw_quad, dict):
                continue
            quad: dict[str, float] = {}
            for key in ("x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"):
                value = raw_quad.get(key)
                if not isinstance(value, int | float):
                    quad = {}
                    break
                quad[key] = float(value)
            if quad:
                quads.append(quad)
        pdf_selector_matches = (
            _pdf_selector_snapshot_matches(
                selector=selector,
                snapshot_source_fingerprint=row["source_fingerprint"],
            )
            and snapshot_text_matches
        )
        if isinstance(page_number, int) and page_number >= 1 and pdf_selector_matches:
            status = "resolved" if quads else "no_geometry"
            highlight = {
                "kind": "pdf_text",
                "evidence_span_id": str(evidence_span_id),
                "page_number": page_number,
                "page_label": selector.get("page_label")
                if isinstance(selector.get("page_label"), str)
                else None,
                "source_fingerprint": (
                    selector.get("source_fingerprint")
                    if isinstance(selector.get("source_fingerprint"), str)
                    else None
                ),
                "text_quote": {"exact": exact, "prefix": prefix, "suffix": suffix},
                "geometry": {**geometry, "quads": quads} if quads else None,
            }

    elif resolver_kind == "transcript":
        t_start_ms = selector.get("t_start_ms")
        t_end_ms = selector.get("t_end_ms")
        if isinstance(t_start_ms, int) and t_start_ms >= 0:
            params["t_start_ms"] = str(t_start_ms)
        if (
            _transcript_selector_snapshot_matches(
                selector=selector,
                snapshot_metadata=row["snapshot_metadata"],
            )
            and snapshot_text_matches
        ):
            status = "resolved"
            highlight = {
                "kind": "transcript_time_text",
                "evidence_span_id": str(evidence_span_id),
                "t_start_ms": t_start_ms if isinstance(t_start_ms, int) else None,
                "t_end_ms": t_end_ms if isinstance(t_end_ms, int) else None,
                "text_quote": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }
    else:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Evidence not found")

    return {
        "evidence_span_id": str(evidence_span_id),
        "media_id": str(media_id),
        "citation_label": str(row["citation_label"]),
        "span_text": str(row["span_text"] or ""),
        "resolver": {
            "kind": resolver_kind,
            "route": f"/media/{media_id}",
            "params": params,
            "status": status,
            "selector": selector,
            "highlight": highlight,
        },
    }


def _evidence_span_snapshot_matches(
    db: Session,
    *,
    evidence_span_id: UUID,
    exact: str,
) -> bool:
    rows = (
        db.execute(
            text(
                """
                SELECT
                    es.span_text,
                    es.start_block_id,
                    es.end_block_id,
                    es.start_block_offset,
                    es.end_block_offset,
                    start_block.block_idx AS start_block_idx,
                    end_block.block_idx AS end_block_idx,
                    cb.id AS block_id,
                    cb.block_idx,
                    cb.canonical_text
                FROM evidence_spans es
                JOIN content_blocks start_block
                  ON start_block.id = es.start_block_id
                 AND start_block.media_id = es.media_id
                 AND start_block.index_run_id = es.index_run_id
                 AND start_block.source_snapshot_id = es.source_snapshot_id
                JOIN content_blocks end_block
                  ON end_block.id = es.end_block_id
                 AND end_block.media_id = es.media_id
                 AND end_block.index_run_id = es.index_run_id
                 AND end_block.source_snapshot_id = es.source_snapshot_id
                JOIN content_blocks cb
                  ON cb.media_id = es.media_id
                 AND cb.index_run_id = es.index_run_id
                 AND cb.source_snapshot_id = es.source_snapshot_id
                 AND cb.block_idx BETWEEN start_block.block_idx AND end_block.block_idx
                WHERE es.id = :evidence_span_id
                ORDER BY cb.block_idx ASC
                """
            ),
            {"evidence_span_id": evidence_span_id},
        )
        .mappings()
        .all()
    )
    if not rows:
        return False

    parts: list[str] = []
    start_idx = int(rows[0]["start_block_idx"])
    end_idx = int(rows[0]["end_block_idx"])
    if start_idx > end_idx:
        return False
    expected_block_idx = start_idx
    for row in rows:
        block_idx = int(row["block_idx"])
        if block_idx != expected_block_idx:
            return False
        block_text = str(row["canonical_text"] or "")
        if block_idx == start_idx:
            block_start = int(row["start_block_offset"])
        else:
            block_start = 0
        if block_idx == end_idx:
            block_end = int(row["end_block_offset"])
        else:
            block_end = len(block_text)
        if block_start < 0 or block_end < block_start or block_end > len(block_text):
            return False
        parts.append(block_text[block_start:block_end])
        expected_block_idx += 1

    reconstructed = "".join(parts)
    if expected_block_idx != end_idx + 1:
        return False

    first_row = rows[0]
    last_row = rows[-1]
    if (
        first_row["block_id"] != first_row["start_block_id"]
        or last_row["block_id"] != first_row["end_block_id"]
    ):
        return False

    span_text = str(first_row["span_text"] or "")
    return reconstructed == span_text and span_text == exact


def _pdf_selector_snapshot_matches(
    *,
    selector: dict[str, Any],
    snapshot_source_fingerprint: Any,
) -> bool:
    selector_fingerprint = selector.get("source_fingerprint")
    if not isinstance(selector_fingerprint, str) or not selector_fingerprint.strip():
        return False
    if (
        isinstance(snapshot_source_fingerprint, str)
        and snapshot_source_fingerprint
        and selector_fingerprint != snapshot_source_fingerprint
    ):
        return False
    return True


def _transcript_selector_snapshot_matches(
    *,
    selector: dict[str, Any],
    snapshot_metadata: Any,
) -> bool:
    raw_transcript_version_id = selector.get("transcript_version_id")
    if not isinstance(raw_transcript_version_id, str):
        return False
    try:
        transcript_version_id = UUID(raw_transcript_version_id)
    except ValueError:
        return False

    metadata = snapshot_metadata if isinstance(snapshot_metadata, dict) else {}
    metadata_version_id = metadata.get("transcript_version_id")
    if metadata_version_id is not None and str(metadata_version_id) != str(transcript_version_id):
        return False

    t_start_ms = selector.get("t_start_ms")
    t_end_ms = selector.get("t_end_ms")
    if not (
        isinstance(t_start_ms, int)
        and isinstance(t_end_ms, int)
        and t_start_ms >= 0
        and t_end_ms > t_start_ms
    ):
        return False

    return True
