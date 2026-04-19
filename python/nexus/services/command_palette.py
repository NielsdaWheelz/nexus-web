"""Command palette recents service."""

from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from nexus.db.models import CommandPaletteRecent
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.command_palette import CommandPaletteRecentOut

MAX_COMMAND_PALETTE_RECENTS = 8
MAX_TITLE_SNAPSHOT_LENGTH = 120


def list_recents_for_viewer(db: Session, viewer_id: UUID) -> list[CommandPaletteRecentOut]:
    """Return recent destinations for the current viewer."""
    rows = (
        db.execute(
            select(CommandPaletteRecent)
            .where(CommandPaletteRecent.user_id == viewer_id)
            .order_by(CommandPaletteRecent.last_used_at.desc(), CommandPaletteRecent.id.desc())
        )
        .scalars()
        .all()
    )

    kept_rows: list[CommandPaletteRecent] = []
    row_by_href: dict[str, CommandPaletteRecent] = {}
    rows_to_delete: list[CommandPaletteRecent] = []
    needs_cleanup = False

    for row in rows:
        try:
            canonical_href = _canonicalize_recent_href(row.href, allow_removed_cleanup=True)
        except InvalidRequestError:
            canonical_href = None

        if canonical_href is None:
            rows_to_delete.append(row)
            needs_cleanup = True
            continue

        existing = row_by_href.get(canonical_href)
        if existing is None:
            if row.href != canonical_href:
                row.href = canonical_href
                needs_cleanup = True
            row_by_href[canonical_href] = row
            kept_rows.append(row)
            continue

        needs_cleanup = True
        if (row.last_used_at, str(row.id)) > (existing.last_used_at, str(existing.id)):
            existing.last_used_at = row.last_used_at
            if row.title_snapshot is not None:
                existing.title_snapshot = row.title_snapshot
        elif existing.title_snapshot is None and row.title_snapshot is not None:
            existing.title_snapshot = row.title_snapshot
        rows_to_delete.append(row)

    kept_rows.sort(key=lambda row: (row.last_used_at, str(row.id)), reverse=True)
    if len(kept_rows) > MAX_COMMAND_PALETTE_RECENTS:
        rows_to_delete.extend(kept_rows[MAX_COMMAND_PALETTE_RECENTS:])
        kept_rows = kept_rows[:MAX_COMMAND_PALETTE_RECENTS]
        needs_cleanup = True

    if needs_cleanup:
        delete_ids: list[UUID] = []
        seen_delete_ids: set[UUID] = set()
        for row in rows_to_delete:
            if row.id in seen_delete_ids:
                continue
            seen_delete_ids.add(row.id)
            delete_ids.append(row.id)

        with transaction(db):
            if delete_ids:
                db.execute(
                    delete(CommandPaletteRecent).where(CommandPaletteRecent.id.in_(delete_ids))
                )
            db.flush()

    return [CommandPaletteRecentOut.model_validate(row) for row in kept_rows]


def record_recent_for_viewer(
    db: Session,
    viewer_id: UUID,
    href: str,
    title_snapshot: str | None = None,
) -> CommandPaletteRecentOut:
    """Record one recent destination for the current viewer."""
    canonical_href = _canonicalize_recent_href(href)
    if canonical_href is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination")

    normalized_title = None
    if title_snapshot is not None:
        collapsed_title = " ".join(title_snapshot.split()).strip()
        if collapsed_title:
            normalized_title = collapsed_title[:MAX_TITLE_SNAPSHOT_LENGTH].strip()

    with transaction(db):
        current_time = db.execute(select(func.now())).scalar_one()
        row = (
            db.execute(
                select(CommandPaletteRecent).where(
                    CommandPaletteRecent.user_id == viewer_id,
                    CommandPaletteRecent.href == canonical_href,
                )
            )
            .scalars()
            .one_or_none()
        )

        if row is None:
            row = CommandPaletteRecent(
                user_id=viewer_id,
                href=canonical_href,
                title_snapshot=normalized_title,
                created_at=current_time,
                last_used_at=current_time,
            )
            db.add(row)
            db.flush()
        else:
            row.last_used_at = current_time
            if normalized_title is not None:
                row.title_snapshot = normalized_title
            db.flush()

        trim_ids = (
            db.execute(
                select(CommandPaletteRecent.id)
                .where(CommandPaletteRecent.user_id == viewer_id)
                .order_by(CommandPaletteRecent.last_used_at.desc(), CommandPaletteRecent.id.desc())
                .offset(MAX_COMMAND_PALETTE_RECENTS)
            )
            .scalars()
            .all()
        )
        if trim_ids:
            db.execute(delete(CommandPaletteRecent).where(CommandPaletteRecent.id.in_(trim_ids)))

    return CommandPaletteRecentOut.model_validate(row)


def _canonicalize_recent_href(
    href: str,
    *,
    allow_removed_cleanup: bool = False,
) -> str | None:
    candidate = href.strip()
    parsed = urlsplit(candidate)

    if parsed.scheme or parsed.netloc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination")

    canonical_href = parsed.path
    if len(canonical_href) > 1 and canonical_href.endswith("/"):
        canonical_href = canonical_href.rstrip("/")
    if not canonical_href.startswith("/"):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination")

    segments = canonical_href.split("/")[1:]
    if not segments or any(segment == "" for segment in segments):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination")

    if len(segments) == 1:
        if segments[0] == "libraries":
            return "/libraries"
        if segments[0] == "browse":
            return "/browse"
        if segments[0] == "discover":
            if allow_removed_cleanup:
                return "/browse"
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
        if segments[0] == "documents" or segments[0] == "videos":
            if allow_removed_cleanup:
                return None
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
        if segments[0] == "podcasts":
            return "/podcasts"
        if segments[0] == "conversations":
            return "/conversations"
        if segments[0] == "search":
            return "/search"
        if segments[0] == "settings":
            return "/settings"
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported recent destination",
        )

    if segments[0] == "settings" and len(segments) == 2:
        if segments[1] == "billing":
            return "/settings/billing"
        if segments[1] == "reader":
            return "/settings/reader"
        if segments[1] == "keys":
            return "/settings/keys"
        if segments[1] == "local-vault":
            return "/settings/local-vault"
        if segments[1] == "identities":
            return "/settings/identities"
        if segments[1] == "keybindings":
            return "/settings/keybindings"
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported recent destination",
        )

    if segments[0] == "libraries" and len(segments) == 2:
        return f"/libraries/{segments[1]}"

    if segments[0] == "media" and len(segments) == 2:
        return f"/media/{segments[1]}"

    if segments[0] == "conversations" and len(segments) == 2:
        if segments[1] == "new":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
        return f"/conversations/{segments[1]}"

    if segments[0] == "podcasts" and len(segments) == 2:
        if segments[1] == "subscriptions":
            if allow_removed_cleanup:
                return None
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
        return f"/podcasts/{segments[1]}"

    if segments[0] == "discover" and len(segments) == 2 and segments[1] == "podcasts":
        if allow_removed_cleanup:
            return None
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported recent destination",
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination")
