"""Contributor routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.contributors import (
    ContributorAliasCreateRequest,
    ContributorExternalIdCreateRequest,
    ContributorMergeRequest,
    ContributorSplitRequest,
)
from nexus.services import contributors as contributors_service

router = APIRouter(prefix="/contributors", tags=["contributors"])


@router.get("")
def search_contributors(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str | None = Query(default=None, min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict:
    contributors = contributors_service.search_contributors(
        db,
        viewer_id=viewer.user_id,
        q=q,
        limit=limit,
    )
    return success_response(
        {"contributors": [contributor.model_dump(mode="json") for contributor in contributors]}
    )


@router.get("/{contributor_handle}")
def get_contributor(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.get_contributor_by_handle(
        db,
        contributor_handle,
        viewer.user_id,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.get("/{contributor_handle}/works")
def list_contributor_works(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    role: str | None = Query(default=None, min_length=1, max_length=40),
    content_kind: str | None = Query(default=None, min_length=1, max_length=80),
    q: str | None = Query(default=None, min_length=1, max_length=200),
    limit: int = Query(default=100, ge=1, le=200),
) -> dict:
    works = contributors_service.list_contributor_works(
        db,
        viewer.user_id,
        contributor_handle,
        role=role,
        content_kind=content_kind,
        q=q,
        limit=limit,
    )
    return success_response({"works": [work.model_dump(mode="json") for work in works]})


@router.post("/{contributor_handle}/aliases", status_code=201)
def add_contributor_alias(
    contributor_handle: str,
    request: ContributorAliasCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.add_contributor_alias(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
        request=request,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.delete("/{contributor_handle}/aliases/{alias_id}")
def delete_contributor_alias(
    contributor_handle: str,
    alias_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.delete_contributor_alias(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
        alias_id=alias_id,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.post("/{contributor_handle}/external-ids", status_code=201)
def add_contributor_external_id(
    contributor_handle: str,
    request: ContributorExternalIdCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.add_contributor_external_id(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
        request=request,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.delete("/{contributor_handle}/external-ids/{external_id_id}")
def delete_contributor_external_id(
    contributor_handle: str,
    external_id_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.delete_contributor_external_id(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
        external_id_id=external_id_id,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.post("/merge")
def merge_contributors(
    request: ContributorMergeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.merge_contributors(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        request=request,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.post("/{contributor_handle}/split", status_code=201)
def split_contributor(
    contributor_handle: str,
    request: ContributorSplitRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.split_contributor(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
        request=request,
    )
    return success_response(contributor.model_dump(mode="json"))


@router.post("/{contributor_handle}/tombstone")
def tombstone_contributor(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    contributor = contributors_service.tombstone_contributor(
        db,
        actor_user_id=viewer.user_id,
        actor_roles=viewer.roles,
        contributor_handle=contributor_handle,
    )
    return success_response(contributor.model_dump(mode="json"))
