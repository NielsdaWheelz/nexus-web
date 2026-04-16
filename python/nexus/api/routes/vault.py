"""Local Markdown vault routes."""

from typing import Annotated, cast

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.vault import VaultConflict, VaultFile, VaultSnapshotOut, VaultSyncRequest
from nexus.services import vault as vault_service

router = APIRouter(tags=["vault"])


@router.get("/vault")
def export_vault(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    files = vault_service.export_vault_files(db, viewer.user_id)
    response = VaultSnapshotOut(
        files=[VaultFile(path=file["path"], content=file["content"]) for file in files]
    )
    return success_response(response.model_dump(mode="json"))


@router.post("/vault")
def sync_vault(
    request: VaultSyncRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = vault_service.sync_vault_files(
        db,
        viewer.user_id,
        [file.model_dump() for file in request.files],
    )
    files = cast(list[dict[str, str]], result["files"])
    delete_paths = cast(list[str], result["delete_paths"])
    conflicts = cast(list[dict[str, str]], result["conflicts"])
    response = VaultSnapshotOut(
        files=[VaultFile(path=file["path"], content=file["content"]) for file in files],
        delete_paths=delete_paths,
        conflicts=[
            VaultConflict(
                path=conflict["path"],
                message=conflict["message"],
                content=conflict["content"],
            )
            for conflict in conflicts
        ],
    )
    return success_response(response.model_dump(mode="json"))
