"""Durable optimistic revisions for finite viewer collections."""

from __future__ import annotations

from collections.abc import Collection
from enum import Enum
from uuid import UUID

from sqlalchemy import literal, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import User, ViewerCollectionRevision
from nexus.errors import ApiErrorCode, ConflictError


class CollectionFamily(str, Enum):
    AuthorWorks = "AuthorWorks"
    ConversationIndex = "ConversationIndex"
    LibrariesIndex = "LibrariesIndex"
    LibraryEntries = "LibraryEntries"
    PodcastSubscriptions = "PodcastSubscriptions"
    PodcastEpisodes = "PodcastEpisodes"


def read_collection_revision(
    db: Session,
    *,
    viewer_id: UUID,
    family: CollectionFamily,
) -> int:
    revision = db.scalar(
        select(ViewerCollectionRevision.revision).where(
            ViewerCollectionRevision.viewer_id == viewer_id,
            ViewerCollectionRevision.family == family.value,
        )
    )
    return 0 if revision is None else revision


def require_collection_revision(
    db: Session,
    *,
    viewer_id: UUID,
    family: CollectionFamily,
    expected: int,
) -> int:
    revision = read_collection_revision(db, viewer_id=viewer_id, family=family)
    if revision != expected:
        raise ConflictError(
            ApiErrorCode.E_COLLECTION_CHANGED,
            "Collection changed while loading",
        )
    return revision


def bump_collection_revision(
    db: Session,
    *,
    viewer_id: UUID,
    family: CollectionFamily,
) -> int:
    return bump_collection_revisions(
        db,
        viewer_ids=(viewer_id,),
        family=family,
    )[viewer_id]


def bump_collection_revisions(
    db: Session,
    *,
    viewer_ids: Collection[UUID],
    family: CollectionFamily,
) -> dict[UUID, int]:
    unique_viewers = sorted(set(viewer_ids))
    if not unique_viewers:
        return {}

    statement = insert(ViewerCollectionRevision).values(
        [
            {
                "viewer_id": viewer_id,
                "family": family.value,
                "revision": 1,
            }
            for viewer_id in unique_viewers
        ]
    )
    statement = statement.on_conflict_do_update(
        index_elements=(
            ViewerCollectionRevision.viewer_id,
            ViewerCollectionRevision.family,
        ),
        set_={"revision": ViewerCollectionRevision.revision + 1},
    ).returning(
        ViewerCollectionRevision.viewer_id,
        ViewerCollectionRevision.revision,
    )
    return {row.viewer_id: row.revision for row in db.execute(statement)}


def bump_collection_families(
    db: Session,
    *,
    viewer_ids: Collection[UUID],
    families: Collection[CollectionFamily],
) -> None:
    """Advance several explicitly owned families for the same affected viewers."""
    for family in sorted(set(families), key=lambda value: value.value):
        bump_collection_revisions(
            db,
            viewer_ids=viewer_ids,
            family=family,
        )


def bump_all_collection_revisions(
    db: Session,
    *,
    family: CollectionFamily,
) -> None:
    values = select(
        User.id,
        literal(family.value),
        literal(1),
    ).where(literal(True))
    statement = insert(ViewerCollectionRevision).from_select(
        ("viewer_id", "family", "revision"),
        values,
    )
    db.execute(
        statement.on_conflict_do_update(
            index_elements=(
                ViewerCollectionRevision.viewer_id,
                ViewerCollectionRevision.family,
            ),
            set_={"revision": ViewerCollectionRevision.revision + 1},
        )
    )


def bump_all_collection_families(
    db: Session,
    *,
    families: Collection[CollectionFamily],
) -> None:
    """Advance several explicitly owned families for every current viewer."""
    for family in sorted(set(families), key=lambda value: value.value):
        bump_all_collection_revisions(db, family=family)
