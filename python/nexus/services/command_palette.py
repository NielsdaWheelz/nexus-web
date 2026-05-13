"""Command palette usage-history service."""

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import CommandPaletteUsage
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.command_palette import (
    CommandPaletteHistoryOut,
    CommandPaletteHistoryRecentOut,
    CommandPaletteSelectionRecordRequest,
    CommandPaletteUsageOut,
)

MAX_COMMAND_PALETTE_RECENT_DESTINATIONS = 8
MAX_QUERY_NORMALIZED_LENGTH = 200
MAX_TARGET_KEY_LENGTH = 240
MAX_TITLE_SNAPSHOT_LENGTH = 120
MAX_VISIT_TIMESTAMPS = 10
TARGET_ONLY_QUERY_WEIGHT = 0.35
BROWSE_VISIBLE_TYPES = ("podcasts", "podcast_episodes", "videos", "documents")


def get_history_for_viewer(
    db: Session,
    viewer_id: UUID,
    query: str | None = None,
) -> CommandPaletteHistoryOut:
    """Return recent destinations and frecency boosts for the current viewer."""
    query_normalized = _normalize_query(query)

    destination_rows = (
        db.execute(
            select(CommandPaletteUsage)
            .where(
                CommandPaletteUsage.user_id == viewer_id,
                CommandPaletteUsage.target_href.is_not(None),
            )
            .order_by(CommandPaletteUsage.last_used_at.desc(), CommandPaletteUsage.id.desc())
        )
        .scalars()
        .all()
    )

    recent: list[CommandPaletteHistoryRecentOut] = []
    seen_recent_targets: set[str] = set()
    for row in destination_rows:
        if row.target_href is None or row.target_key in seen_recent_targets:
            continue
        seen_recent_targets.add(row.target_key)
        recent.append(
            CommandPaletteHistoryRecentOut(
                target_key=row.target_key,
                target_kind=row.target_kind,
                target_href=row.target_href,
                title_snapshot=row.title_snapshot,
                source=row.source,
                last_used_at=row.last_used_at,
            )
        )
        if len(recent) >= MAX_COMMAND_PALETTE_RECENT_DESTINATIONS:
            break

    boost_rows = _load_frecency_rows(db, viewer_id, query_normalized)
    now = db.execute(select(func.now())).scalar_one()
    frecency_boosts: dict[str, float] = {}
    for row in boost_rows:
        boost = _calculate_frecency(row, now)
        if query_normalized and row.query_normalized == "":
            boost *= TARGET_ONLY_QUERY_WEIGHT
        if boost <= 0:
            continue
        frecency_boosts[row.target_key] = round(
            frecency_boosts.get(row.target_key, 0) + boost,
            3,
        )

    return CommandPaletteHistoryOut(recent=recent, frecency_boosts=frecency_boosts)


def record_selection_for_viewer(
    db: Session,
    viewer_id: UUID,
    body: CommandPaletteSelectionRecordRequest,
) -> CommandPaletteUsageOut:
    """Record one accepted command palette selection for the current viewer."""
    query_normalized = _normalize_query(body.query)
    target_href = _normalize_target_href(body.target_kind, body.target_href)
    target_key = _normalize_target_key(body.target_kind, body.target_key, target_href)
    title_snapshot = _normalize_title_snapshot(body.title_snapshot)

    row: CommandPaletteUsage | None = None
    try:
        row = _record_selection_once(
            db,
            viewer_id,
            query_normalized=query_normalized,
            target_key=target_key,
            target_kind=body.target_kind,
            target_href=target_href,
            title_snapshot=title_snapshot,
            source=body.source,
        )
    except IntegrityError:
        row = _record_selection_once(
            db,
            viewer_id,
            query_normalized=query_normalized,
            target_key=target_key,
            target_kind=body.target_kind,
            target_href=target_href,
            title_snapshot=title_snapshot,
            source=body.source,
        )

    return CommandPaletteUsageOut.model_validate(row)


def _record_selection_once(
    db: Session,
    viewer_id: UUID,
    *,
    query_normalized: str,
    target_key: str,
    target_kind: str,
    target_href: str | None,
    title_snapshot: str,
    source: str,
) -> CommandPaletteUsage:
    with transaction(db):
        current_time = db.execute(select(func.now())).scalar_one()
        row = (
            db.execute(
                select(CommandPaletteUsage).where(
                    CommandPaletteUsage.user_id == viewer_id,
                    CommandPaletteUsage.query_normalized == query_normalized,
                    CommandPaletteUsage.target_key == target_key,
                )
            )
            .scalars()
            .one_or_none()
        )

        timestamp = _serialize_timestamp(current_time)
        if row is None:
            row = CommandPaletteUsage(
                user_id=viewer_id,
                query_normalized=query_normalized,
                target_key=target_key,
                target_kind=target_kind,
                target_href=target_href,
                title_snapshot=title_snapshot,
                source=source,
                use_count=1,
                visit_timestamps=[timestamp],
                last_used_at=current_time,
                created_at=current_time,
                updated_at=current_time,
            )
            db.add(row)
        else:
            row.target_kind = target_kind
            row.target_href = target_href
            row.title_snapshot = title_snapshot
            row.source = source
            row.use_count += 1
            row.visit_timestamps = [timestamp, *row.visit_timestamps[: MAX_VISIT_TIMESTAMPS - 1]]
            row.last_used_at = current_time
            row.updated_at = current_time
        db.flush()
        return row


def _load_frecency_rows(
    db: Session,
    viewer_id: UUID,
    query_normalized: str,
) -> list[CommandPaletteUsage]:
    if query_normalized:
        return list(
            db.execute(
                select(CommandPaletteUsage).where(
                    CommandPaletteUsage.user_id == viewer_id,
                    CommandPaletteUsage.query_normalized.in_([query_normalized, ""]),
                )
            )
            .scalars()
            .all()
        )

    return list(
        db.execute(
            select(CommandPaletteUsage).where(
                CommandPaletteUsage.user_id == viewer_id,
                CommandPaletteUsage.query_normalized == "",
            )
        )
        .scalars()
        .all()
    )


def _normalize_query(query: str | None) -> str:
    if query is None:
        return ""
    return " ".join(query.lower().split()).strip()[:MAX_QUERY_NORMALIZED_LENGTH].strip()


def _normalize_target_key(
    target_kind: str,
    target_key: str,
    target_href: str | None,
) -> str:
    if target_kind == "href":
        if target_href is None:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing target href")
        return target_href

    normalized = " ".join(target_key.split()).strip()
    if not normalized:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing target key")
    return normalized[:MAX_TARGET_KEY_LENGTH].strip()


def _normalize_target_href(target_kind: str, target_href: str | None) -> str | None:
    if target_kind == "href":
        if target_href is None:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing target href")
        return _canonicalize_target_href(target_href)

    if target_href is not None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unexpected target href")
    return None


def _normalize_title_snapshot(title_snapshot: str) -> str:
    normalized = " ".join(title_snapshot.split()).strip()
    if not normalized:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing title snapshot")
    return normalized[:MAX_TITLE_SNAPSHOT_LENGTH].strip()


def _serialize_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _calculate_frecency(row: CommandPaletteUsage, now: datetime) -> float:
    timestamps = [_parse_timestamp(value) for value in row.visit_timestamps]
    timestamps = [value for value in timestamps if value is not None]
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
    candidate = href.strip()
    parsed = urlsplit(candidate)

    if parsed.scheme or parsed.netloc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")

    canonical_href = parsed.path
    if len(canonical_href) > 1 and canonical_href.endswith("/"):
        canonical_href = canonical_href.rstrip("/")
    if not canonical_href.startswith("/"):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")

    segments = canonical_href.split("/")[1:]
    if not segments or any(segment == "" for segment in segments):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")

    if len(segments) == 1:
        if segments[0] == "libraries":
            return "/libraries"
        if segments[0] == "browse":
            return _canonicalize_browse_target_href(parsed)
        if segments[0] == "podcasts":
            return "/podcasts"
        if segments[0] == "conversations":
            return "/conversations"
        if segments[0] == "search":
            return "/search"
        if segments[0] == "settings":
            return "/settings"
        if segments[0] == "notes":
            return "/notes"
        if segments[0] == "daily":
            return "/daily"
        if segments[0] == "oracle":
            return "/oracle"
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")

    if segments[0] == "settings" and len(segments) == 2:
        if segments[1] == "billing":
            return "/settings/billing"
        if segments[1] == "reader":
            return "/settings/reader"
        if segments[1] == "appearance":
            return "/settings/appearance"
        if segments[1] == "keys":
            return "/settings/keys"
        if segments[1] == "local-vault":
            return "/settings/local-vault"
        if segments[1] == "identities":
            return "/settings/identities"
        if segments[1] == "keybindings":
            return "/settings/keybindings"
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")

    if segments[0] == "libraries" and len(segments) == 2:
        return f"/libraries/{segments[1]}"

    if segments[0] == "media" and len(segments) == 2:
        return f"/media/{segments[1]}"

    if segments[0] == "pages" and len(segments) == 2:
        return f"/pages/{segments[1]}"

    if segments[0] == "conversations" and len(segments) == 2:
        if segments[1] == "new":
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")
        return f"/conversations/{segments[1]}"

    if segments[0] == "podcasts" and len(segments) == 2:
        if segments[1] == "subscriptions":
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")
        return f"/podcasts/{segments[1]}"

    if segments[0] == "authors" and len(segments) == 2:
        return f"/authors/{segments[1]}"

    if segments[0] == "notes" and len(segments) == 2:
        return f"/notes/{segments[1]}"

    if segments[0] == "daily" and len(segments) == 2:
        return f"/daily/{segments[1]}"

    if segments[0] == "oracle" and len(segments) == 2:
        return f"/oracle/{segments[1]}"

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")


def _canonicalize_browse_target_href(parsed_result) -> str:
    browse_query: str | None = None
    visible_type_tokens: list[str] = []
    saw_visible_types = False

    for key, value in parse_qsl(parsed_result.query, keep_blank_values=True):
        if key == "type":
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")
        if key == "q":
            browse_query = value
            continue
        if key == "types":
            saw_visible_types = True
            visible_type_tokens.extend(part.strip() for part in value.split(","))

    normalized_query = _normalize_browse_query(browse_query)
    normalized_visible_types = _normalize_browse_visible_types(
        visible_type_tokens,
        explicit=saw_visible_types,
    )

    canonical_params: list[tuple[str, str]] = []
    if normalized_query is not None:
        canonical_params.append(("q", normalized_query))
    if normalized_visible_types is not None:
        canonical_params.append(("types", ",".join(normalized_visible_types)))

    if not canonical_params:
        return "/browse"
    return f"/browse?{urlencode(canonical_params)}"


def _normalize_browse_query(query: str | None) -> str | None:
    if query is None:
        return None
    collapsed_query = " ".join(query.split()).strip()
    return collapsed_query or None


def _normalize_browse_visible_types(
    raw_types: list[str],
    *,
    explicit: bool,
) -> tuple[str, ...] | None:
    if not explicit:
        return None

    seen_types: set[str] = set()
    for raw_type in raw_types:
        if not raw_type:
            continue
        if raw_type not in BROWSE_VISIBLE_TYPES:
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported palette target")
        seen_types.add(raw_type)

    ordered_types = tuple(
        browse_type for browse_type in BROWSE_VISIBLE_TYPES if browse_type in seen_types
    )
    if len(ordered_types) == len(BROWSE_VISIBLE_TYPES):
        return None
    return ordered_types
