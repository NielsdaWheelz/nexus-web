"""Nexus usage-history service."""

from datetime import UTC, datetime, timedelta
from typing import cast
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import NexusUsage
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.nexus_history import (
    NexusHistoryOut,
    NexusHistoryRecentOut,
    NexusHistorySource,
    NexusSelectionRecordOut,
    NexusSelectionRecordRequest,
)
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

MAX_NEXUS_RECENT_TARGETS = 5
MAX_QUERY_NORMALIZED_LENGTH = 200
MAX_VISIT_TIMESTAMPS = 10
TARGET_ONLY_QUERY_WEIGHT = 0.35
NEXUS_SELECTION_RECORD_SCOPE = "Nexus.SelectionRecord"


def get_history_for_viewer(
    db: Session,
    viewer_id: UUID,
    query: str | None = None,
) -> NexusHistoryOut:
    """Return recent targets and bounded frecency for the current viewer."""
    query_normalized = _normalize_query(query)
    destination_rows = (
        db.execute(
            select(NexusUsage)
            .where(NexusUsage.user_id == viewer_id)
            .order_by(NexusUsage.last_used_at.desc(), NexusUsage.id.desc())
        )
        .scalars()
        .all()
    )

    recent: list[NexusHistoryRecentOut] = []
    seen_recent_hrefs: set[str] = set()
    for row in destination_rows:
        if row.target_href in seen_recent_hrefs:
            continue
        seen_recent_hrefs.add(row.target_href)
        recent.append(
            NexusHistoryRecentOut(
                target_href=row.target_href,
                label_snapshot=row.label_snapshot,
                source=cast(NexusHistorySource, row.source),
                last_used_at=row.last_used_at,
            )
        )
        if len(recent) == MAX_NEXUS_RECENT_TARGETS:
            break

    now = db.execute(select(func.now())).scalar_one()
    raw_frecency_by_href: dict[str, float] = {}
    for row in _load_frecency_rows(db, viewer_id, query_normalized):
        contribution = _calculate_frecency(row, now)
        if query_normalized and row.query_normalized == "":
            contribution *= TARGET_ONLY_QUERY_WEIGHT
        if contribution > 0:
            raw_frecency_by_href[row.target_href] = (
                raw_frecency_by_href.get(row.target_href, 0) + contribution
            )

    return NexusHistoryOut(
        recent=recent,
        frecency_by_href={
            href: round(raw / (raw + 100), 6) for href, raw in raw_frecency_by_href.items()
        },
    )


def record_selection_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    request: NexusSelectionRecordRequest,
) -> NexusSelectionRecordOut:
    """Record one accepted internal Nexus selection exactly once."""
    request_bytes = canonical_json_bytes(request.model_dump(mode="json"))
    query_normalized = _normalize_query(request.query)
    target_href = _canonicalize_target_href(request.target_href)
    label_snapshot = _normalize_label_snapshot(request.label_snapshot)

    def op() -> NexusSelectionRecordOut:
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=NEXUS_SELECTION_RECORD_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            return NexusSelectionRecordOut.model_validate(replay)

        current_time = db.execute(select(func.now())).scalar_one()
        row = db.scalar(
            select(NexusUsage).where(
                NexusUsage.user_id == viewer_id,
                NexusUsage.query_normalized == query_normalized,
                NexusUsage.target_href == target_href,
            )
        )
        timestamp = _serialize_timestamp(current_time)
        if row is None:
            row = NexusUsage(
                user_id=viewer_id,
                query_normalized=query_normalized,
                target_href=target_href,
                label_snapshot=label_snapshot,
                source=request.source,
                use_count=1,
                visit_timestamps=[timestamp],
                last_used_at=current_time,
                created_at=current_time,
                updated_at=current_time,
            )
            db.add(row)
        else:
            row.label_snapshot = label_snapshot
            row.source = request.source
            row.use_count += 1
            row.visit_timestamps = [
                timestamp,
                *row.visit_timestamps[: MAX_VISIT_TIMESTAMPS - 1],
            ]
            row.last_used_at = current_time
            row.updated_at = current_time
        db.flush()

        response = NexusSelectionRecordOut.model_validate(row)
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=NEXUS_SELECTION_RECORD_SCOPE,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=response.model_dump(mode="json"),
            changed_lanes={},
        )
        db.commit()
        return response

    return retry_serializable(db, "record_nexus_selection", op)


def _load_frecency_rows(
    db: Session,
    viewer_id: UUID,
    query_normalized: str,
) -> list[NexusUsage]:
    query_filter = (
        NexusUsage.query_normalized.in_([query_normalized, ""])
        if query_normalized
        else NexusUsage.query_normalized == ""
    )
    return list(
        db.execute(
            select(NexusUsage).where(
                NexusUsage.user_id == viewer_id,
                query_filter,
            )
        )
        .scalars()
        .all()
    )


def _normalize_query(query: str | None) -> str:
    if query is None:
        return ""
    return " ".join(query.lower().split()).strip()[:MAX_QUERY_NORMALIZED_LENGTH].strip()


def _normalize_label_snapshot(label_snapshot: str) -> str:
    normalized = " ".join(label_snapshot.split()).strip()
    if not normalized:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing Nexus target label")
    return normalized


def _serialize_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _calculate_frecency(row: NexusUsage, now: datetime) -> float:
    timestamps = [_parse_timestamp(value) for value in row.visit_timestamps]
    if not timestamps:
        return 0
    bucket_points_sum = sum(_frecency_bucket_points(now, timestamp) for timestamp in timestamps)
    if bucket_points_sum <= 0:
        return 0
    return row.use_count * bucket_points_sum / min(len(timestamps), MAX_VISIT_TIMESTAMPS)


def _frecency_bucket_points(now: datetime, timestamp: datetime) -> int:
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)

    age = now - timestamp
    if age <= timedelta(hours=4):
        return 100
    if age <= timedelta(hours=24):
        return 80
    if age <= timedelta(days=3):
        return 60
    if age <= timedelta(days=7):
        return 40
    if age <= timedelta(days=30):
        return 20
    if age <= timedelta(days=90):
        return 10
    return 0


def _canonicalize_target_href(href: str) -> str:
    parsed = urlsplit(href.strip())
    if parsed.scheme or parsed.netloc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")

    canonical_path = parsed.path
    if len(canonical_path) > 1 and canonical_path.endswith("/"):
        canonical_path = canonical_path.rstrip("/")
    if not canonical_path.startswith("/"):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")

    segments = canonical_path.split("/")[1:]
    if not segments or any(segment == "" for segment in segments):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")

    if len(segments) == 1:
        if segments[0] in {
            "lectern",
            "libraries",
            "podcasts",
            "conversations",
            "search",
            "settings",
            "notes",
            "stats",
            "atlas",
            "oracle",
        }:
            return _with_semantic_target_state(canonical_path, parsed.query, parsed.fragment)
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")

    if segments[0] == "settings" and len(segments) == 2:
        if segments[1] in {
            "billing",
            "reader",
            "appearance",
            "keys",
            "local-vault",
            "identities",
            "keybindings",
        }:
            return _with_semantic_target_state(canonical_path, parsed.query, parsed.fragment)
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")

    if segments[0] in {"libraries", "media", "pages", "authors", "notes", "oracle"}:
        if len(segments) == 2:
            if segments[0] == "media":
                return canonical_path
            return _with_semantic_target_state(canonical_path, parsed.query, parsed.fragment)

    if segments[0] == "conversations" and len(segments) == 2:
        if segments[1] != "new":
            return _with_semantic_target_state(canonical_path, parsed.query, parsed.fragment)

    if segments[0] == "podcasts" and len(segments) == 2:
        if segments[1] != "subscriptions":
            return _with_semantic_target_state(canonical_path, parsed.query, parsed.fragment)

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported Nexus target")


def _with_semantic_target_state(path: str, query: str, fragment: str) -> str:
    query_pairs = parse_qsl(query, keep_blank_values=True)
    canonical_query = urlencode(sorted(query_pairs, key=lambda pair: pair[0]))
    canonical_fragment = quote(
        unquote(fragment),
        safe="!$&'()*+,-./:;=?@_~",
    )

    href = path
    if canonical_query:
        href = f"{href}?{canonical_query}"
    if canonical_fragment:
        href = f"{href}#{canonical_fragment}"
    return href
