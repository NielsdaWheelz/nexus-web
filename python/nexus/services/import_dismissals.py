"""The reader's monotonic acknowledgement of observed import failures.

One serializable transaction applies the whole request. Each item independently reads
the canonical import, caps coverage at its newest raised failure, and preserves any
newer stored acknowledgement. Visibility grants this reader's write, never another's.
"""

from collections.abc import Sequence
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ImportDismissal
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.import_refs import ParsedImportRef
from nexus.services.imports import read_import_detail


def dismiss_imports(
    db: Session, *, viewer_id: UUID, dismissals: Sequence[tuple[ParsedImportRef, datetime]]
) -> None:
    def apply() -> None:
        for ref, through in dismissals:
            try:
                item = read_import_detail(db, viewer_id=viewer_id, ref=ref).item
            except NotFoundError as exc:
                if exc.code != ApiErrorCode.E_IMPORT_NOT_FOUND:
                    raise
                continue
            if item.media_id is None or item.dismissal is None:
                continue
            observed = min(through, item.dismissal.through)
            stored = db.scalar(
                select(ImportDismissal).where(
                    ImportDismissal.user_id == viewer_id, ImportDismissal.media_id == item.media_id
                )
            )
            if stored is None:
                db.add(ImportDismissal(user_id=viewer_id, media_id=item.media_id, through=observed))
            elif stored.through < observed:
                stored.through = observed
            db.flush()

    retry_serializable(db, "dismiss_imports", apply)
