from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import User, ViewerCollectionRevision
from nexus.errors import ApiErrorCode, ConflictError
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    bump_collection_revision,
    bump_collection_revisions,
    read_collection_revision,
    require_collection_revision,
)

pytestmark = pytest.mark.integration


def _user(db: Session) -> User:
    user = User(id=uuid4())
    db.add(user)
    db.flush()
    return user


def test_absent_revision_reads_zero_without_creating_a_row(db_session: Session) -> None:
    user = _user(db_session)

    assert (
        read_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.AuthorWorks,
        )
        == 0
    )
    assert (
        db_session.scalars(
            select(ViewerCollectionRevision).where(
                ViewerCollectionRevision.viewer_id == user.id,
            )
        ).all()
        == []
    )


def test_revision_bumps_compose_inside_the_callers_transaction(db_session: Session) -> None:
    user = _user(db_session)

    assert (
        bump_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == 1
    )
    assert (
        bump_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.PodcastEpisodes,
        )
        == 2
    )
    assert (
        read_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.PodcastSubscriptions,
        )
        == 0
    )


def test_revision_precondition_reports_collection_changed(db_session: Session) -> None:
    user = _user(db_session)
    bump_collection_revision(
        db_session,
        viewer_id=user.id,
        family=CollectionFamily.LibrariesIndex,
    )

    with pytest.raises(ConflictError) as exc_info:
        require_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.LibrariesIndex,
            expected=0,
        )

    assert exc_info.value.code == ApiErrorCode.E_COLLECTION_CHANGED
    assert exc_info.value.status_code == 409


def test_bulk_and_all_viewer_bumps_are_single_family_scoped(db_session: Session) -> None:
    first = _user(db_session)
    second = _user(db_session)

    assert bump_collection_revisions(
        db_session,
        viewer_ids=(first.id, second.id, first.id),
        family=CollectionFamily.LibraryEntries,
    ) == {first.id: 1, second.id: 1}
    bump_all_collection_revisions(
        db_session,
        family=CollectionFamily.LibraryEntries,
    )

    assert {
        first.id: read_collection_revision(
            db_session,
            viewer_id=first.id,
            family=CollectionFamily.LibraryEntries,
        ),
        second.id: read_collection_revision(
            db_session,
            viewer_id=second.id,
            family=CollectionFamily.LibraryEntries,
        ),
    } == {first.id: 2, second.id: 2}
    assert (
        read_collection_revision(
            db_session,
            viewer_id=first.id,
            family=CollectionFamily.ConversationIndex,
        )
        == 0
    )
