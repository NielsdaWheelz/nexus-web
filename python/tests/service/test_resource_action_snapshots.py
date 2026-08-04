"""Priority proof: the resource-action snapshot service resolves per-ref action
FACTS that are set-based (no per-ref query growth), ordered like the request,
scoped to the viewer's authority, and content-addressed by a factsRevision that
changes exactly when a fact changes.

The oracle is the product membership contract (which capability kinds exist for a
resource and its real state), never the implementation. State is built through
committed sessions and the REAL owning services (library placement, consumption,
subscriptions), then the snapshot is asserted to reflect it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, event
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    Conversation,
    Media,
    MediaKind,
    Membership,
    Podcast,
    PodcastEpisode,
    PodcastSubscription,
    ProcessingStatus,
)
from nexus.schemas.consumption import (
    EnsureMediaFinishedCommand,
    PlaceItemsCommand,
)
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.resource_action_snapshots import ResourceActionSnapshotOut
from nexus.services import library_governance
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.action_snapshots import resolve_action_snapshots

_ENDPOINT = "/resource-items/action-snapshots/resolve"


# ---------------------------------------------------------------------------
# Committed-state helpers (real users / media / podcasts via fresh sessions).
# ---------------------------------------------------------------------------


def _new_viewer(engine: Engine, label: str) -> UUID:
    viewer_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(db, viewer_id, f"{label}-{viewer_id}@example.invalid")
        db.commit()
    return viewer_id


def _seed_article(engine: Engine, viewer_id: UUID, *, source_url: str | None) -> UUID:
    media_id = uuid4()
    with Session(engine) as db:
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Snapshot proof article",
                canonical_source_url=source_url,
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()
    return media_id


def _seed_subscribed_podcast_episode(engine: Engine, viewer_id: UUID) -> tuple[UUID, UUID]:
    podcast_id = uuid4()
    media_id = uuid4()
    with Session(engine) as db:
        db.add(
            Podcast(
                id=podcast_id,
                provider="test",
                provider_podcast_id=str(uuid4()),
                title="Snapshot proof cast",
                feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
            )
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.podcast_episode.value,
                title="Snapshot proof episode",
                external_playback_url="https://cdn.example.invalid/ep1.mp3",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        db.add(PodcastEpisode(media_id=media_id, podcast_id=podcast_id, duration_seconds=1200))
        db.add(
            PodcastSubscription(
                id=uuid4(),
                user_id=viewer_id,
                podcast_id=podcast_id,
                next_sync_at=datetime.now(UTC),
            )
        )
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()
    return podcast_id, media_id


def _seed_library(engine: Engine, viewer_id: UUID) -> UUID:
    """Create a real non-default library owned by the viewer (owner-admin)."""
    library_id = uuid4()
    with Session(engine) as db:
        library_governance.create_library(
            db, viewer_id, CreateLibraryRequest(library_id=library_id, name="Batch shelf")
        )
    return library_id


def _seed_conversation(engine: Engine, owner_id: UUID, *, sharing: str = "private") -> UUID:
    """Insert a real conversation owned by ``owner_id`` with the given sharing."""
    conversation_id = uuid4()
    with Session(engine) as db:
        db.add(
            Conversation(
                id=conversation_id,
                owner_user_id=owner_id,
                title="Snapshot proof chat",
                sharing=sharing,
            )
        )
        db.commit()
    return conversation_id


def _resolve(engine: Engine, viewer_id: UUID, refs: list[ResourceRef]):
    with Session(engine) as db:
        return resolve_action_snapshots(db, viewer_id=viewer_id, refs=refs)


def _kinds(snapshot: ResourceActionSnapshotOut) -> set[str]:
    return {capability.kind for capability in snapshot.capabilities}


def _capability(snapshot: ResourceActionSnapshotOut, kind: str):
    for capability in snapshot.capabilities:
        if capability.kind == kind:
            return capability
    raise AssertionError(f"capability {kind!r} not present in {sorted(_kinds(snapshot))}")


# ---------------------------------------------------------------------------
# Membership + state.
# ---------------------------------------------------------------------------


def test_seeded_media_reports_core_media_lectern_and_placement_kinds(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "media-owner")
    media_id = _seed_article(engine, viewer_id, source_url="https://example.invalid/article")
    ref = ResourceRef(scheme="media", id=media_id)

    response = _resolve(engine, viewer_id, [ref])
    snapshot = response.snapshots[0]

    assert snapshot.ref == ref.uri
    assert snapshot.missing is False
    kinds = _kinds(snapshot)

    # The owner of a readable media sees the universal core, the open-source jump,
    # metadata/author/delete operations, its read state, a Lectern relationship and
    # library placement.
    assert {
        "Open",
        "Share",
        "Chat",
        "OpenSource",
        "RetryMetadata",
        "EditAuthors",
        "RemoveMedia",
        "Consumption",
        "LecternMembership",
        "LibraryPlacement",
    } <= kinds

    # A web article is not an offline-audio target, is not an episode, and has no
    # engagement to reset yet.
    assert {"OfflineAudio", "EpisodeConsumption", "ResetProgress"}.isdisjoint(kinds)

    assert _capability(snapshot, "OpenSource").href == "https://example.invalid/article"
    assert _capability(snapshot, "Consumption").state == "Unread"
    lectern = _capability(snapshot, "LecternMembership")
    assert lectern.state == "Absent"
    assert lectern.lectern_item_id is None


def test_placing_in_lectern_flips_membership_present_and_changes_facts_revision(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "lectern-user")
    media_id = _seed_article(engine, viewer_id, source_url=None)
    ref = ResourceRef(scheme="media", id=media_id)

    before = _resolve(engine, viewer_id, [ref]).snapshots[0]
    assert _capability(before, "LecternMembership").state == "Absent"

    consumption.run_lectern_command(
        viewer_id,
        PlaceItemsCommand.model_validate(
            {
                "kind": "PlaceItems",
                "clientMutationId": str(uuid4()),
                "mediaIds": [str(media_id)],
                "placement": {"kind": "First"},
            }
        ),
    )

    after = _resolve(engine, viewer_id, [ref]).snapshots[0]
    membership = _capability(after, "LecternMembership")
    assert membership.state == "Present"
    assert membership.lectern_item_id is not None
    # A changed fact must change the content hash.
    assert after.facts_revision != before.facts_revision


def test_marking_media_finished_reports_finished_consumption_and_reset_progress(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "finish-user")
    media_id = _seed_article(engine, viewer_id, source_url=None)
    ref = ResourceRef(scheme="media", id=media_id)

    before = _resolve(engine, viewer_id, [ref]).snapshots[0]
    assert _capability(before, "Consumption").state == "Unread"
    assert "ResetProgress" not in _kinds(before)

    consumption.run_consumption_command(
        viewer_id,
        EnsureMediaFinishedCommand.model_validate(
            {
                "kind": "EnsureMediaFinished",
                "clientMutationId": str(uuid4()),
                "mediaId": str(media_id),
            }
        ),
    )

    after = _resolve(engine, viewer_id, [ref]).snapshots[0]
    assert _capability(after, "Consumption").state == "Finished"
    assert "ResetProgress" in _kinds(after)
    assert after.facts_revision != before.facts_revision


def test_subscribed_podcast_episode_reports_episode_offline_and_subscription_kinds(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "podcast-user")
    podcast_id, media_id = _seed_subscribed_podcast_episode(engine, viewer_id)
    episode_ref = ResourceRef(scheme="media", id=media_id)
    podcast_ref = ResourceRef(scheme="podcast", id=podcast_id)

    response = _resolve(engine, viewer_id, [episode_ref, podcast_ref])
    episode, podcast = response.snapshots

    # An episode uses the binary episode read model, never the ternary
    # Consumption, and its https enclosure is an offline-audio target.
    episode_kinds = _kinds(episode)
    assert {"EpisodeConsumption", "OfflineAudio", "LibraryPlacement"} <= episode_kinds
    assert "Consumption" not in episode_kinds
    assert _capability(episode, "EpisodeConsumption").state == "Unplayed"

    # The subscribed podcast exposes settings, refresh, its subscription state and
    # library placement.
    podcast_kinds = _kinds(podcast)
    assert {"PodcastSettings", "RefreshPodcast", "PodcastSubscription", "LibraryPlacement"} <= (
        podcast_kinds
    )
    assert _capability(podcast, "PodcastSubscription").state == "Subscribed"


# ---------------------------------------------------------------------------
# Order + missing.
# ---------------------------------------------------------------------------


def test_response_order_matches_request_and_missing_ref_kept_in_place(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "order-user")
    media_id = _seed_article(engine, viewer_id, source_url=None)
    present_ref = ResourceRef(scheme="media", id=media_id)
    # Syntactically valid media refs for resources that do not exist.
    unknown_before = ResourceRef(scheme="media", id=uuid4())
    unknown_after = ResourceRef(scheme="media", id=uuid4())

    requested = [unknown_before, present_ref, unknown_after]
    response = _resolve(engine, viewer_id, requested)

    assert [snapshot.ref for snapshot in response.snapshots] == [ref.uri for ref in requested]
    first, middle, last = response.snapshots

    # A missing ref keeps its position with an empty capability set — never dropped.
    assert (first.missing, first.capabilities) == (True, [])
    assert (last.missing, last.capabilities) == (True, [])
    assert first.facts_revision != ""  # still content-addressed
    assert middle.missing is False
    assert "Open" in _kinds(middle)


# ---------------------------------------------------------------------------
# factsRevision.
# ---------------------------------------------------------------------------


def test_facts_revision_is_nonempty_and_deterministic_for_identical_facts(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "revision-user")
    media_id = _seed_article(engine, viewer_id, source_url="https://example.invalid/x")
    ref = ResourceRef(scheme="media", id=media_id)

    first = _resolve(engine, viewer_id, [ref]).snapshots[0]
    second = _resolve(engine, viewer_id, [ref]).snapshots[0]

    assert first.facts_revision != ""
    assert first.facts_revision == second.facts_revision


# ---------------------------------------------------------------------------
# Authorization derives only from the viewer.
# ---------------------------------------------------------------------------


def test_library_manage_capabilities_are_scoped_to_the_viewer_authority(engine: Engine) -> None:
    owner_id = _new_viewer(engine, "lib-owner")
    member_id = _new_viewer(engine, "lib-member")
    library_id = uuid4()
    with Session(engine) as db:
        library_governance.create_library(
            db, owner_id, CreateLibraryRequest(library_id=library_id, name="Shared shelf")
        )
    with Session(engine) as db:
        db.add(Membership(library_id=library_id, user_id=member_id, role="member"))
        db.commit()
    ref = ResourceRef(scheme="library", id=library_id)

    owner_view = _resolve(engine, owner_id, [ref]).snapshots[0]
    member_view = _resolve(engine, member_id, [ref]).snapshots[0]

    # The owner-admin manages and can delete the library.
    assert {"LibrarySettings", "DeleteLibrary"} <= _kinds(owner_view)

    # A non-admin member sees the library (it is routeable/openable for them) but
    # is not offered management or deletion — authority is derived from viewer_id.
    member_kinds = _kinds(member_view)
    assert member_view.missing is False
    assert "Open" in member_kinds
    assert "LibrarySettings" not in member_kinds
    assert "DeleteLibrary" not in member_kinds


def test_delete_conversation_capability_is_scoped_to_the_owner(engine: Engine) -> None:
    owner_id = _new_viewer(engine, "conversation-owner")
    reader_id = _new_viewer(engine, "conversation-reader")
    # A public conversation is visible to any viewer, so both resolve it as present;
    # only the owner holds the delete authority delete_conversation enforces.
    conversation_id = _seed_conversation(engine, owner_id, sharing="public")
    ref = ResourceRef(scheme="conversation", id=conversation_id)

    owner_view = _resolve(engine, owner_id, [ref]).snapshots[0]
    reader_view = _resolve(engine, reader_id, [ref]).snapshots[0]

    # The owner may delete the conversation.
    assert owner_view.missing is False
    assert "DeleteConversation" in _kinds(owner_view)

    # A non-owner reader sees (and can open) the conversation but is not offered
    # deletion — authority is derived from viewer_id, not visibility.
    reader_kinds = _kinds(reader_view)
    assert reader_view.missing is False
    assert "Open" in reader_kinds
    assert "DeleteConversation" not in reader_kinds


# ---------------------------------------------------------------------------
# AC9 — set-based resolution (query count does not grow per ref).
# ---------------------------------------------------------------------------


def _count_statements(engine: Engine, viewer_id: UUID, refs: list[ResourceRef]) -> int:
    executed: list[str] = []

    def _record(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
        executed.append(statement)

    event.listen(engine, "after_cursor_execute", _record)
    try:
        with Session(engine) as db:
            resolve_action_snapshots(db, viewer_id=viewer_id, refs=refs)
    finally:
        event.remove(engine, "after_cursor_execute", _record)
    return len(executed)


def test_media_batch_is_set_based_query_count_does_not_grow_per_ref(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "batch-user")
    media_ids = [
        _seed_article(engine, viewer_id, source_url="https://example.invalid/a") for _ in range(5)
    ]
    refs = [ResourceRef(scheme="media", id=media_id) for media_id in media_ids]

    # Warm the connection pool so per-checkout bookkeeping cannot skew the counts.
    _count_statements(engine, viewer_id, refs[:1])

    one = _count_statements(engine, viewer_id, refs[:1])
    five = _count_statements(engine, viewer_id, refs)

    # Independent oracle: a set-based aggregator issues the SAME (bounded) number of
    # statements for one media ref as for five — a per-ref loop would scale.
    assert five == one, f"expected set-based query count, got one={one} five={five}"


def test_library_batch_is_set_based_query_count_does_not_grow_per_ref(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "library-batch-user")
    library_ids = [_seed_library(engine, viewer_id) for _ in range(5)]
    refs = [ResourceRef(scheme="library", id=library_id) for library_id in library_ids]

    # Warm the connection pool so per-checkout bookkeeping cannot skew the counts.
    _count_statements(engine, viewer_id, refs[:1])

    one = _count_statements(engine, viewer_id, refs[:1])
    five = _count_statements(engine, viewer_id, refs)

    # A homogeneous library batch must not scale: library visibility+management are
    # sourced from one set-based read, never a per-ref is_library_member loop.
    assert five == one, f"expected set-based query count, got one={one} five={five}"


def test_conversation_batch_is_set_based_query_count_does_not_grow_per_ref(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "conversation-batch-user")
    conversation_ids = [_seed_conversation(engine, viewer_id) for _ in range(5)]
    refs = [ResourceRef(scheme="conversation", id=cid) for cid in conversation_ids]

    # Warm the connection pool so per-checkout bookkeeping cannot skew the counts.
    _count_statements(engine, viewer_id, refs[:1])

    one = _count_statements(engine, viewer_id, refs[:1])
    five = _count_statements(engine, viewer_id, refs)

    # A homogeneous conversation batch must not scale: visibility + delete authority
    # are sourced from set-based reads, never a per-ref can_read_conversation loop.
    assert five == one, f"expected set-based query count, got one={one} five={five}"


# ---------------------------------------------------------------------------
# Request validation.
# ---------------------------------------------------------------------------


_DUPLICATE_REF = f"media:{uuid4()}"


@pytest.mark.parametrize(
    "refs",
    [
        pytest.param([], id="empty"),
        pytest.param([f"media:{uuid4()}" for _ in range(101)], id="over_100"),
        pytest.param([_DUPLICATE_REF, _DUPLICATE_REF], id="duplicate"),
        pytest.param(["not-a-parseable-ref"], id="unparseable"),
    ],
)
def test_invalid_request_refs_are_rejected_with_e_invalid_request(
    authenticated_client: TestClient, refs: list[str]
) -> None:
    response = authenticated_client.post(_ENDPOINT, json={"refs": refs})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
