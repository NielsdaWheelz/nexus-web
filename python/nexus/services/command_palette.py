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
            .limit(MAX_COMMAND_PALETTE_RECENTS)
        )
        .scalars()
        .all()
    )
    return [CommandPaletteRecentOut.model_validate(row) for row in rows]


def record_recent_for_viewer(
    db: Session,
    viewer_id: UUID,
    href: str,
    title_snapshot: str | None = None,
) -> CommandPaletteRecentOut:
    """Record one recent destination for the current viewer."""
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
            canonical_href = "/libraries"
        elif segments[0] == "discover":
            canonical_href = "/discover"
        elif segments[0] == "documents":
            canonical_href = "/documents"
        elif segments[0] == "podcasts":
            canonical_href = "/podcasts"
        elif segments[0] == "videos":
            canonical_href = "/videos"
        elif segments[0] == "conversations":
            canonical_href = "/conversations"
        elif segments[0] == "search":
            canonical_href = "/search"
        elif segments[0] == "settings":
            canonical_href = "/settings"
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
    elif segments[0] == "discover" and len(segments) == 2:
        if segments[1] == "podcasts":
            canonical_href = "/discover/podcasts"
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
    elif segments[0] == "settings" and len(segments) == 2:
        if segments[1] == "billing":
            canonical_href = "/settings/billing"
        elif segments[1] == "reader":
            canonical_href = "/settings/reader"
        elif segments[1] == "keys":
            canonical_href = "/settings/keys"
        elif segments[1] == "local-vault":
            canonical_href = "/settings/local-vault"
        elif segments[1] == "identities":
            canonical_href = "/settings/identities"
        elif segments[1] == "keybindings":
            canonical_href = "/settings/keybindings"
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Unsupported recent destination",
            )
    elif segments[0] == "libraries" and len(segments) == 2:
        canonical_href = f"/libraries/{segments[1]}"
    elif segments[0] == "media" and len(segments) == 2:
        canonical_href = f"/media/{segments[1]}"
    elif segments[0] == "conversations" and len(segments) == 2:
        if segments[1] == "new":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination"
            )
        canonical_href = f"/conversations/{segments[1]}"
    elif segments[0] == "podcasts" and len(segments) == 2:
        if segments[1] == "subscriptions":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Unsupported recent destination"
            )
        canonical_href = f"/podcasts/{segments[1]}"
    else:
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
