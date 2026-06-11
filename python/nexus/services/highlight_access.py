"""Shared highlight access checks."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, highlight_library_intersection_exists
from nexus.db.models import Highlight
from nexus.errors import ApiErrorCode, NotFoundError


def require_typed_highlight_or_404(highlight: Highlight) -> None:
    """Require a highlight to carry a canonical typed anchor row."""

    if highlight.anchor_kind == "fragment_offsets":
        if highlight.fragment_anchor is not None and highlight.anchor_media_id is not None:
            return
    elif highlight.anchor_kind == "pdf_page_geometry":
        if highlight.pdf_anchor is not None and highlight.anchor_media_id is not None:
            return
    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")


def get_highlight_for_visible_read_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    """Load highlight and enforce shared-reader visibility."""

    highlight = db.get(Highlight, highlight_id)
    if highlight is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    require_typed_highlight_or_404(highlight)
    media_id = highlight.anchor_media_id
    if media_id is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    shares_library = db.scalar(
        select(
            highlight_library_intersection_exists(
                viewer_user_id=viewer_id,
                author_user_id_expr=highlight.user_id,
                media_id=media_id,
            )
        )
    )
    if not shares_library:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight


def get_highlight_for_author_write_or_404(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> Highlight:
    """Load highlight and enforce author-only write access."""

    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")

    require_typed_highlight_or_404(highlight)
    media_id = highlight.anchor_media_id
    if media_id is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return highlight
