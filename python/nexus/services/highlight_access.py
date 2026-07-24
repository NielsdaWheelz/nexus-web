"""Shared highlight access checks."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_highlight, can_read_media
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
    if not can_read_highlight(db, viewer_id, highlight_id):
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
