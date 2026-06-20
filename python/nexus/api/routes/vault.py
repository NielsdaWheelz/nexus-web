"""Local Markdown vault routes."""

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.vault import (
    VaultConflictOut,
    VaultProjectedFileOut,
    VaultSnapshotOut,
    VaultSyncRequest,
)
from nexus.services import vault as vault_service
from nexus.services.vault_contracts import EditableVaultFile

router = APIRouter(tags=["vault"])


@router.get("/vault")
def export_vault(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    files = vault_service.export_vault_files(db, viewer.user_id)
    response = VaultSnapshotOut(
        files=[VaultProjectedFileOut(path=file["path"], content=file["content"]) for file in files]
    )
    return ok(response)


@router.get("/vault/download")
def download_vault(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    return Response(
        content=vault_service.export_vault_zip(db, viewer.user_id),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="nexus-vault.zip"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/vault")
def sync_vault(
    request: VaultSyncRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = vault_service.sync_vault_files(
        db,
        viewer.user_id,
        [EditableVaultFile(path=file.path, content=file.content) for file in request.files],
    )
    response = VaultSnapshotOut(
        files=[
            VaultProjectedFileOut(path=file["path"], content=file["content"])
            for file in result["files"]
        ],
        delete_paths=result["delete_paths"],
        conflicts=[
            VaultConflictOut(
                path=conflict["path"],
                message=conflict["message"],
                content=conflict["content"],
            )
            for conflict in result["conflicts"]
        ],
    )
    return ok(response)
