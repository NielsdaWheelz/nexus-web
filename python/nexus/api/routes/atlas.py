"""The atlas read model: the viewer's stars, constellations and edges in the one frame."""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.atlas import AtlasOut
from nexus.services import atlas

router = APIRouter(prefix="/atlas", tags=["atlas"])


@router.get("")
def read_atlas(viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession) -> Data[AtlasOut]:
    return Data(
        data=atlas.read_atlas(
            db, viewer_id=viewer.user_id, default_library_id=viewer.default_library_id
        )
    )
