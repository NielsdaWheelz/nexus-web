"""Focused closure proofs for collection-visible mutation owners."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.consumption import EnsureMediaFinishedCommand
from nexus.schemas.podcast import (
    PodcastSourceFacts,
    PodcastSubscriptionSettingsPatchRequest,
)
from nexus.schemas.presence import Present
from nexus.services import (
    library_entries,
    library_governance,
    library_invitations,
    media_deletion,
    media_source_ingest,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.collection_revisions import CollectionFamily, read_collection_revision
from nexus.services.consumption import service as consumption_service
from nexus.services.podcasts.identity import upsert_podcast
from nexus.services.podcasts.subscriptions import (
    unsubscribe_from_podcast,
    update_subscription_settings_for_viewer,
)
from nexus.services.sealed_handles import seal_library_invitation
from tests.factories import (
    add_media_to_library,
    add_test_podcast_subscription,
    create_test_library,
    create_test_media,
)

pytestmark = pytest.mark.integration


def _seed_user(db: Session) -> tuple[UUID, UUID]:
    user_id = uuid4()
    default_library_id = ensure_user_and_default_library(db, user_id)
    return user_id, default_library_id


def _seed_default_media(db: Session, library_id: UUID, *, count: int = 2) -> list[UUID]:
    media_ids: list[UUID] = []
    for index in range(count):
        media_id = create_test_media(db, title=f"Collection row {index}")
        add_media_to_library(db, library_id, media_id)
        media_ids.append(media_id)
    db.commit()
    return media_ids


def _first_entry_page(db: Session, *, viewer_id: UUID, library_id: UUID):
    return library_entries.list_library_entries(
        db,
        viewer_id,
        library_id,
        view=library_entries.LibraryEntryView(
            order=library_entries.Canonical(),
            projection=library_entries.AllItems(completion="all"),
        ),
        limit=1,
    )


def _assert_stale_entry_continuation(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    page,
) -> None:
    assert isinstance(page.next_cursor, Present)
    with pytest.raises(ConflictError) as exc_info:
        library_entries.list_library_entries(
            db,
            viewer_id,
            library_id,
            view=library_entries.LibraryEntryView(
                order=library_entries.Canonical(),
                projection=library_entries.AllItems(completion="all"),
            ),
            limit=1,
            cursor=page.next_cursor.value,
            collection_revision=page.collection_revision,
        )
    assert exc_info.value.code == ApiErrorCode.E_COLLECTION_CHANGED


def test_processing_fact_change_rejects_an_old_library_entry_continuation(
    db_session: Session,
) -> None:
    viewer_id, library_id = _seed_user(db_session)
    media_ids = _seed_default_media(db_session, library_id)
    page = _first_entry_page(db_session, viewer_id=viewer_id, library_id=library_id)
    db_session.commit()

    assert db_session.get(Media, media_ids[0]) is not None
    media_source_ingest.mark_source_attempt_and_media_failed(
        db=db_session,
        media_id=media_ids[0],
        attempt_id=None,
        stage="extract",
        error_code="E_TEST",
        error_message="test failure",
    )
    db_session.commit()

    _assert_stale_entry_continuation(
        db_session,
        viewer_id=viewer_id,
        library_id=library_id,
        page=page,
    )


def test_consumption_fact_change_rejects_an_old_library_entry_continuation(
    db_session: Session,
) -> None:
    viewer_id, library_id = _seed_user(db_session)
    media_ids = _seed_default_media(db_session, library_id)
    page = _first_entry_page(db_session, viewer_id=viewer_id, library_id=library_id)
    db_session.commit()

    consumption_service._run_consumption_command_op(
        db_session,
        viewer_id,
        EnsureMediaFinishedCommand(
            kind="EnsureMediaFinished",
            clientMutationId=uuid4(),
            mediaId=media_ids[0],
        ),
    )

    _assert_stale_entry_continuation(
        db_session,
        viewer_id=viewer_id,
        library_id=library_id,
        page=page,
    )


def test_media_removal_rejects_an_old_library_entry_continuation(
    db_session: Session,
) -> None:
    viewer_id, library_id = _seed_user(db_session)
    media_ids = _seed_default_media(db_session, library_id)
    page = _first_entry_page(db_session, viewer_id=viewer_id, library_id=library_id)
    db_session.commit()

    media_deletion.remove_media_for_viewer(db_session, viewer_id, media_ids[0])

    _assert_stale_entry_continuation(
        db_session,
        viewer_id=viewer_id,
        library_id=library_id,
        page=page,
    )


def test_membership_acceptance_and_removal_advance_library_entries(
    db_session: Session,
) -> None:
    owner_id, _ = _seed_user(db_session)
    invitee_id, _ = _seed_user(db_session)
    library_id = create_test_library(db_session, owner_id, name="Shared collection")
    invitation_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO library_invitations (
                id,
                library_id,
                inviter_user_id,
                invitee_user_id,
                role,
                status
            )
            VALUES (
                :id,
                :library_id,
                :owner_id,
                :invitee_id,
                'member',
                'pending'
            )
            """
        ),
        {
            "id": invitation_id,
            "library_id": library_id,
            "owner_id": owner_id,
            "invitee_id": invitee_id,
        },
    )
    db_session.commit()
    affected_families = (
        CollectionFamily.AuthorWorks,
        CollectionFamily.LibrariesIndex,
        CollectionFamily.LibraryEntries,
        CollectionFamily.PodcastEpisodes,
        CollectionFamily.PodcastSubscriptions,
    )
    before_accept = {
        family: read_collection_revision(
            db_session,
            viewer_id=invitee_id,
            family=family,
        )
        for family in affected_families
    }

    library_invitations.accept_library_invite(
        db_session,
        invitee_id,
        seal_library_invitation(invitation_id),
    )
    after_accept = {
        family: read_collection_revision(
            db_session,
            viewer_id=invitee_id,
            family=family,
        )
        for family in affected_families
    }
    assert after_accept == {family: revision + 1 for family, revision in before_accept.items()}

    library_governance.remove_library_member(
        db_session,
        owner_id,
        library_id,
        invitee_id,
    )
    assert {
        family: read_collection_revision(
            db_session,
            viewer_id=invitee_id,
            family=family,
        )
        for family in affected_families
    } == {family: revision + 1 for family, revision in after_accept.items()}


def test_podcast_identity_changes_advance_every_viewers_dependent_collections(
    db_session: Session,
) -> None:
    first_viewer_id, _ = _seed_user(db_session)
    second_viewer_id, _ = _seed_user(db_session)
    before = {
        (viewer_id, family): read_collection_revision(
            db_session,
            viewer_id=viewer_id,
            family=family,
        )
        for viewer_id in (first_viewer_id, second_viewer_id)
        for family in (
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastSubscriptions,
        )
    }

    upsert_podcast(
        db_session,
        PodcastSourceFacts(
            provider_podcast_id=f"writer-closure-{uuid4()}",
            title="Revision closure",
            feed_url=f"https://example.com/{uuid4()}.xml",
        ),
        now=datetime.now(UTC),
    )

    for key, revision in before.items():
        viewer_id, family = key
        assert (
            read_collection_revision(
                db_session,
                viewer_id=viewer_id,
                family=family,
            )
            == revision + 1
        )


def test_subscription_settings_advance_library_entries_and_subscription_index(
    db_session: Session,
) -> None:
    viewer_id, _ = _seed_user(db_session)
    podcast_id = upsert_podcast(
        db_session,
        PodcastSourceFacts(
            provider_podcast_id=f"settings-closure-{uuid4()}",
            title="Settings closure",
            feed_url=f"https://example.com/{uuid4()}.xml",
        ),
        now=datetime.now(UTC),
    )
    add_test_podcast_subscription(
        db_session,
        user_id=viewer_id,
        podcast_id=podcast_id,
        default_playback_speed=1.0,
    )
    db_session.commit()
    before = {
        family: read_collection_revision(
            db_session,
            viewer_id=viewer_id,
            family=family,
        )
        for family in (
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastSubscriptions,
        )
    }
    db_session.commit()

    update_subscription_settings_for_viewer(
        db_session,
        viewer_id,
        podcast_id,
        PodcastSubscriptionSettingsPatchRequest(auto_queue=True),
    )

    for family, revision in before.items():
        assert (
            read_collection_revision(
                db_session,
                viewer_id=viewer_id,
                family=family,
            )
            == revision + 1
        )


def test_unsubscribe_returns_the_rebased_subscription_revision(
    db_session: Session,
) -> None:
    viewer_id, _ = _seed_user(db_session)
    podcast_id = upsert_podcast(
        db_session,
        PodcastSourceFacts(
            provider_podcast_id=f"unsubscribe-closure-{uuid4()}",
            title="Unsubscribe closure",
            feed_url=f"https://example.com/{uuid4()}.xml",
        ),
        now=datetime.now(UTC),
    )
    add_test_podcast_subscription(
        db_session,
        user_id=viewer_id,
        podcast_id=podcast_id,
        default_playback_speed=1.0,
    )
    db_session.commit()
    before = read_collection_revision(
        db_session,
        viewer_id=viewer_id,
        family=CollectionFamily.PodcastSubscriptions,
    )
    db_session.commit()

    response = unsubscribe_from_podcast(
        db_session,
        viewer_id,
        podcast_id,
        idempotency_key=f"writer-closure-{uuid4()}",
    )

    assert response.collection_revision == before + 1
    assert response.collection_revision == read_collection_revision(
        db_session,
        viewer_id=viewer_id,
        family=CollectionFamily.PodcastSubscriptions,
    )
    assert response.model_dump(mode="json", by_alias=True)["collectionRevision"] == before + 1
