"""Nexus usage map and selection records.

The viewer's whole usage map is read once per palette open; the web ranks, latches and
scores from it. A row's points are the mean age points of its last ten visits. Hrefs are
canonicalized structurally (`apps/web/src/lib/nexus/rank.ts` mirrors `_canonical_href`);
the web owns routes.
"""

from datetime import datetime, timedelta
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.nexus_ranking import (
    NexusSelectionRecordRequest,
    NexusUsageMapOut,
    NexusUsageOut,
)
from nexus.schemas.workspace_session import is_canonical_href

# Points for a visit no older than (hours, points); older visits score nothing.
AGE_POINTS = ((4, 100), (24, 80), (72, 60), (168, 40), (720, 20), (2160, 10))
USAGE_WINDOW_DAYS = 90
USAGE_CAP = 500

_RECENT_USAGES = """
    SELECT query_normalized, target_href, use_count, visit_timestamps FROM nexus_usages
    WHERE user_id = :viewer_id AND query_normalized {typed} ''
        AND (visit_timestamps->>0)::timestamptz >= now() - make_interval(days => :days)
    ORDER BY (visit_timestamps->>0)::timestamptz DESC LIMIT :cap
"""


def get_usage_map_for_viewer(db: Session, viewer_id: UUID) -> NexusUsageMapOut:
    """Rows visited within the window, newest first: 500 untyped and 500 typed at most."""
    now = db.execute(text("SELECT now()")).scalar_one()
    params = {"viewer_id": viewer_id, "days": USAGE_WINDOW_DAYS, "cap": USAGE_CAP}
    usages: dict[str, dict[str, NexusUsageOut]] = {}
    for comparison in ("=", "<>"):
        rows = db.execute(text(_RECENT_USAGES.format(typed=comparison)), params)
        for query, href, use_count, stamps in rows:
            points = sum(_age_points(now - datetime.fromisoformat(stamp)) for stamp in stamps)
            usages.setdefault(query, {})[href] = NexusUsageOut(
                use_count=use_count, points=points / len(stamps), last_used=stamps[0]
            )
    return NexusUsageMapOut(usages=usages)


def record_selection_for_viewer(
    db: Session, viewer_id: UUID, *, request: NexusSelectionRecordRequest
) -> None:
    """One upsert: a plain increment, so a resend counts again (frecency only)."""
    params = {
        "viewer_id": viewer_id,
        "query": _normalize_query(request.query),
        "href": _canonical_href(request.target_href),
    }
    db.execute(
        text("""
            INSERT INTO nexus_usages
                (user_id, query_normalized, target_href, use_count, visit_timestamps)
            VALUES (:viewer_id, :query, :href, 1, jsonb_build_array(now()))
            ON CONFLICT (user_id, query_normalized, target_href) DO UPDATE SET
                use_count = nexus_usages.use_count + 1,
                visit_timestamps = jsonb_path_query_array(
                    EXCLUDED.visit_timestamps || nexus_usages.visit_timestamps, '$[0 to 9]'
                )
        """),
        params,
    )
    db.commit()


def _age_points(age: timedelta) -> int:
    return next((points for hours, points in AGE_POINTS if age <= timedelta(hours=hours)), 0)


def _normalize_query(query: str | None) -> str:
    return " ".join((query or "").lower().split())[:200].strip()


def _canonical_href(href: str) -> str:
    parsed = urlsplit(href.strip())
    path = parsed.path.rstrip("/") if len(parsed.path) > 1 else parsed.path
    if parsed.scheme or parsed.netloc or not is_canonical_href(path) or "" in path.split("/")[1:]:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")
    if path.split("/")[1] == "media":
        return path
    query = urlencode(
        sorted(parse_qsl(parsed.query, keep_blank_values=True), key=lambda pair: pair[0])
    )
    fragment = quote(unquote(parsed.fragment), safe="!$&'()*+,-./:;=?@_~")
    return path + (f"?{query}" if query else "") + (f"#{fragment}" if fragment else "")
