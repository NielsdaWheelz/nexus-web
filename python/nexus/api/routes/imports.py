"""Imports workspace reads: summary, filtered pages, one import's detail and history."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db
from nexus.responses import ok
from nexus.schemas.imports import ImportListQuery, parse_import_ref
from nexus.services.imports import (
    read_import_detail,
    read_import_history,
    read_import_page,
    read_import_summary,
)

router = APIRouter(tags=["imports"])


@router.get("/imports/summary")
def get_import_summary(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    return ok(read_import_summary(db, viewer_id=viewer.user_id))


@router.get("/imports")
def list_imports(
    query: Annotated[ImportListQuery, Query()],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    return ok(
        read_import_page(
            db, viewer_id=viewer.user_id, query=query, is_admin="admin" in viewer.roles
        )
    )


@router.get("/imports/{ref}")
def get_import(
    ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    return ok(
        read_import_detail(
            db,
            viewer_id=viewer.user_id,
            ref=parse_import_ref(ref),
            is_admin="admin" in viewer.roles,
        )
    )


@router.get("/imports/{ref}/history")
def get_import_history(
    ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict:
    return ok(
        read_import_history(
            db,
            viewer_id=viewer.user_id,
            ref=parse_import_ref(ref),
            cursor=cursor,
            limit=limit,
        )
    )
