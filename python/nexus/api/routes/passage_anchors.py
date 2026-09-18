"""Resolve a durable passage link within its requested owner."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import InvalidRequestError
from nexus.responses import ok
from nexus.services import passage_anchors
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(prefix="/passage-anchors", tags=["passage-anchors"])


@router.get("/{anchor_id}/resolution")
def resolve_passage_anchor(
    anchor_id: UUID,
    owner_ref: str,
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    owner = parse_resource_ref(owner_ref)
    if isinstance(owner, ResourceRefParseFailure) or owner.scheme not in ("media", "note_block"):
        raise InvalidRequestError(message="Passage owner must be a media or note_block ref")
    response.headers["Cache-Control"] = "private, no-store"
    return ok(
        passage_anchors.get_navigation_target(
            db, viewer_id=viewer.user_id, passage_anchor_id=anchor_id, owner=owner
        )
    )
