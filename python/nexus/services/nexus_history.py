"""Nexus usage history: recent targets, query-aware frecency, idempotent selection records.

Score = use_count × mean age points of the last ten visits; under a query the target-only
aggregate (query "") counts 0.35. Hrefs are canonicalized structurally; the web owns routes.
"""

from datetime import datetime, timedelta
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.nexus_history import (
    NexusHistoryOut,
    NexusHistoryRecentOut,
    NexusSelectionRecordOut,
    NexusSelectionRecordRequest,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

SELECTION_SCOPE = "Nexus.SelectionRecord"
# Points for a visit no older than (hours, points); older visits score nothing.
AGE_POINTS = ((4, 100), (24, 80), (72, 60), (168, 40), (720, 20), (2160, 10))


def get_history_for_viewer(db: Session, viewer_id: UUID, query: str | None) -> NexusHistoryOut:
    recent = (
        db.execute(
            text("""
            SELECT target_href, label_snapshot, source, last_used_at FROM (
                SELECT DISTINCT ON (target_href) target_href, label_snapshot, source, last_used_at, id
                FROM nexus_usages
                WHERE user_id = :viewer_id
                ORDER BY target_href, last_used_at DESC, id DESC
            ) newest
            ORDER BY last_used_at DESC, id DESC
            LIMIT 5
        """),
            {"viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )
    norm = _normalize_query(query)
    now = db.execute(text("SELECT now()")).scalar_one()
    rows = db.execute(
        text("""
            SELECT target_href, query_normalized, use_count, visit_timestamps FROM nexus_usages
            WHERE user_id = :viewer_id AND query_normalized IN (:norm, '')
        """),
        {"viewer_id": viewer_id, "norm": norm},
    )
    raw: dict[str, float] = {}
    for href, row_query, use_count, stamps in rows:
        points = sum(_age_points(now - datetime.fromisoformat(stamp)) for stamp in stamps)
        contribution = use_count * points / len(stamps)
        if norm and not row_query:
            contribution *= 0.35
        if contribution > 0:
            raw[href] = raw.get(href, 0) + contribution
    return NexusHistoryOut(
        recent=[NexusHistoryRecentOut.model_validate(dict(row)) for row in recent],
        frecency_by_href={href: round(value / (value + 100), 6) for href, value in raw.items()},
    )


def record_selection_for_viewer(
    db: Session, viewer_id: UUID, *, request: NexusSelectionRecordRequest
) -> NexusSelectionRecordOut:
    request_bytes = canonical_json_bytes(request.model_dump(mode="json"))
    params = {
        "viewer_id": viewer_id,
        "query": _normalize_query(request.query),
        "href": _canonical_href(request.target_href),
        "label": " ".join(request.label_snapshot.split())[:120],
        "source": request.source,
    }
    if not params["label"]:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing Nexus target label")

    def op() -> NexusSelectionRecordOut:
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=SELECTION_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return NexusSelectionRecordOut.model_validate(replay)
        use_count, last_used_at = db.execute(
            text("""
                INSERT INTO nexus_usages
                    (user_id, query_normalized, target_href, label_snapshot, source, use_count, visit_timestamps)
                VALUES (:viewer_id, :query, :href, :label, :source, 1, jsonb_build_array(now()))
                ON CONFLICT (user_id, query_normalized, target_href) DO UPDATE SET
                    label_snapshot = EXCLUDED.label_snapshot,
                    source = EXCLUDED.source,
                    use_count = nexus_usages.use_count + 1,
                    visit_timestamps = jsonb_path_query_array(
                        EXCLUDED.visit_timestamps || nexus_usages.visit_timestamps, '$[0 to 9]'
                    ),
                    last_used_at = now(),
                    updated_at = now()
                RETURNING use_count, last_used_at
            """),
            params,
        ).one()
        response = NexusSelectionRecordOut(use_count=use_count, last_used_at=last_used_at)
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=SELECTION_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json"),
        )
        db.commit()
        return response

    return retry_read_committed(db, "record_nexus_selection", op)


def _age_points(age: timedelta) -> int:
    return next((points for hours, points in AGE_POINTS if age <= timedelta(hours=hours)), 0)


def _normalize_query(query: str | None) -> str:
    return " ".join((query or "").lower().split())[:200].strip()


def _canonical_href(href: str) -> str:
    parsed = urlsplit(href.strip())
    path = parsed.path.rstrip("/") if len(parsed.path) > 1 else parsed.path
    if parsed.scheme or parsed.netloc or not path.startswith("/") or "" in path.split("/")[1:]:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")
    if path.split("/")[1] == "media":
        return path
    query = urlencode(
        sorted(parse_qsl(parsed.query, keep_blank_values=True), key=lambda pair: pair[0])
    )
    fragment = quote(unquote(parsed.fragment), safe="!$&'()*+,-./:;=?@_~")
    return path + (f"?{query}" if query else "") + (f"#{fragment}" if fragment else "")
