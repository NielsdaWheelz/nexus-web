"""Publication-owned table boundaries, installed with their immutable fragment.

The canonical parser supplies text coordinates and element-only paths in one pass.
These rows prove rich containment without rereading the publication's HTML.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import FragmentTable
from nexus.services.canonicalize import CanonicalTable


def insert_fragment_tables(
    db: Session, fragment_id: UUID, tables: Sequence[CanonicalTable]
) -> None:
    db.add_all(
        FragmentTable(
            fragment_id=fragment_id,
            dom_path=list(table.dom_path),
            start_offset=table.start_offset,
            end_offset=table.end_offset,
        )
        for table in tables
    )
