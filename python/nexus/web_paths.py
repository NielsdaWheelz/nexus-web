"""Browser-facing BFF path templates (the `/api/...` contract the Next.js proxy mirrors).

One dependency-free owner so services emit these URLs without hard-coding the
transport contract. Distinct from FastAPI mount paths (which have no `/api` prefix).
"""

import re
from uuid import UUID

API_PREFIX = "/api"


def media_image_url(encoded_url: str) -> str:
    return f"{API_PREFIX}/media/image?url={encoded_url}"


def media_asset_url(media_id: UUID, asset_key: str) -> str:
    return f"{API_PREFIX}/media/{media_id}/assets/{asset_key}"


def oracle_plate_url(image_id: UUID) -> str:
    return f"{API_PREFIX}/oracle/plates/{image_id}"


# EXACT EPUB-asset classifier: /api/media/{uuid}/assets/..., NOT a bare /api/media/ prefix
# (a prefix match would wrongly catch /api/media/image and every other media path).
_MEDIA_ASSET_RE = re.compile(rf"^{re.escape(API_PREFIX)}/media/[0-9a-f-]{{36}}/assets/")


def is_media_asset_path(value: str) -> bool:
    return bool(_MEDIA_ASSET_RE.match(value))
