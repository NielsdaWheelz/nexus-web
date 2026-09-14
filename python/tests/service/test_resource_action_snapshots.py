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
    ArtifactBuild,
    ArtifactRevision,
    ContentBlock,
    ContentChunk,
    Contributor,
    Conversation,
    EvidenceSpan,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    MediaFile,
    MediaKind,
    Membership,
    Message,
    NoteBlock,
    OracleCorpusSource,
    OraclePassageAnchor,
    OracleReading,
    Page,
    PassageAnchor,
    Podcast,
    PodcastEpisode,
    PodcastSubscription,
    ProcessingStatus,
    ReaderApparatusItem,
    ReaderApparatusState,
    ResourceExternalSnapshot,
    SynthesisArtifact,
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
from nexus.services.library_entries import ensure_media_in_default_library, ensure_media_in_library
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_items.action_snapshots import resolve_action_snapshots
from tests.testkit.auth import UserRecord

_ENDPOINT = "/resource-items/action-snapshots/resolve"
_RESOURCE_SCHEME_ORACLE: tuple[ResourceScheme, ...] = (
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "oracle_reading",
    "oracle_passage_anchor",
    "artifact",
    "artifact_revision",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
    "passage_anchor",
)
_BASELINE_CAPABILITY_ORACLE: dict[ResourceScheme, frozenset[str]] = {
    "media": frozenset(
        {
            "Open",
            "OpenInNewPane",
            "Share",
            "Chat",
            "OpenSource",
            "RetryMetadata",
            "EditAuthors",
            "RemoveMedia",
            "Consumption",
            "LecternMembership",
            "LibraryPlacement",
        }
    ),
    "library": frozenset(
        {
            "Open",
            "OpenInNewPane",
            "Share",
            "Chat",
            "LibrarySettings",
            "DeleteLibrary",
        }
    ),
    "evidence_span": frozenset({"Open", "OpenInNewPane", "Chat"}),
    "content_chunk": frozenset({"Open", "OpenInNewPane", "Chat"}),
    "highlight": frozenset(
        {
            "Open",
            "OpenInNewPane",
            "Share",
            "Chat",
            "EditHighlight",
            "HighlightNote",
            "LinkHighlight",
            "LearnHighlight",
            "EditHighlightBounds",
            "DeleteHighlight",
        }
    ),
    "page": frozenset({"Open", "OpenInNewPane", "Share", "Chat", "EditPageTitle", "DeletePage"}),
    "note_block": frozenset({"Open", "OpenInNewPane", "Share", "Chat", "EditNoteBody"}),
    "fragment": frozenset({"Open", "OpenInNewPane", "Chat"}),
    "conversation": frozenset({"Open", "OpenInNewPane", "Share", "Chat", "DeleteConversation"}),
    "message": frozenset({"Open", "OpenInNewPane", "Chat", "DeleteMessage"}),
    "oracle_reading": frozenset({"Open", "OpenInNewPane", "Share", "Chat"}),
    "oracle_passage_anchor": frozenset({"Open", "OpenInNewPane"}),
    "artifact": frozenset({"Open", "OpenInNewPane", "Share", "Chat", "RegenerateArtifact"}),
    "artifact_revision": frozenset(
        {"Open", "OpenInNewPane", "Chat", "MakeArtifactRevisionCurrent"}
    ),
    "external_snapshot": frozenset({"Open"}),
    "contributor": frozenset({"Open", "OpenInNewPane", "Share", "Chat", "RenameContributor"}),
    "podcast": frozenset(
        {
            "Open",
            "OpenInNewPane",
            "Share",
            "Chat",
            "PodcastSettings",
            "RefreshPodcast",
            "PodcastSubscription",
            "LibraryPlacement",
        }
    ),
    "reader_apparatus_item": frozenset({"Open", "OpenInNewPane", "Chat"}),
    "passage_anchor": frozenset({"Open", "OpenInNewPane", "Chat"}),
}


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


def _seed_present_ref_per_scheme(
    db: Session,
    *,
    viewer_id: UUID,
    default_library_id: UUID,
) -> list[ResourceRef]:
    """Build one minimally complete, viewer-visible row graph per ResourceScheme."""
    ids = {scheme: uuid4() for scheme in _RESOURCE_SCHEME_ORACLE}
    library_governance.create_library(
        db,
        viewer_id,
        CreateLibraryRequest(library_id=ids["library"], name="Nineteen-scheme proof"),
    )

    media_id = ids["media"]
    content_block_id = uuid4()
    apparatus_state_id = uuid4()
    corpus_source_id = uuid4()
    build_id = uuid4()
    fragment_text = "Every resource action is discoverable."
    db.add_all(
        [
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Nineteen-scheme source",
                canonical_source_url="https://example.invalid/nineteen-schemes",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            ),
            Page(id=ids["page"], user_id=viewer_id, title="Nineteen-scheme page"),
            NoteBlock(
                id=ids["note_block"],
                user_id=viewer_id,
                body_pm_json={"type": "doc", "content": []},
                body_text="Nineteen-scheme note",
            ),
            Conversation(
                id=ids["conversation"],
                owner_user_id=viewer_id,
                title="Nineteen-scheme conversation",
            ),
            ResourceExternalSnapshot(
                id=ids["external_snapshot"],
                user_id=viewer_id,
                provider="test",
                url="https://example.invalid/external-snapshot",
                title="Nineteen-scheme external result",
                snippet="External result snapshot",
                source_snapshot={"kind": "test"},
            ),
            Contributor(
                id=ids["contributor"],
                handle=f"proof-{ids['contributor'].hex}",
                display_name="Nineteen Scheme Contributor",
            ),
            Podcast(
                id=ids["podcast"],
                provider="test",
                provider_podcast_id=ids["podcast"].hex,
                title="Nineteen-scheme podcast",
                feed_url=f"https://feeds.example.invalid/{ids['podcast']}.xml",
            ),
            OracleReading(
                id=ids["oracle_reading"],
                user_id=viewer_id,
                folio_number=1,
                question_text="Can every resource resolve?",
                status="pending",
            ),
        ]
    )
    db.flush()
    ensure_media_in_default_library(db, viewer_id, media_id)

    db.add_all(
        [
            PodcastSubscription(
                id=uuid4(),
                user_id=viewer_id,
                podcast_id=ids["podcast"],
                next_sync_at=datetime.now(UTC),
            ),
            Fragment(
                id=ids["fragment"],
                media_id=media_id,
                idx=0,
                canonical_text=fragment_text,
                html_sanitized=f"<p>{fragment_text}</p>",
            ),
            Message(
                id=ids["message"],
                conversation_id=ids["conversation"],
                seq=1,
                role="user",
                content="Resolve every resource scheme.",
                status="complete",
            ),
            ContentBlock(
                id=content_block_id,
                owner_kind="media",
                owner_id=media_id,
                block_idx=0,
                block_kind="paragraph",
                canonical_text=fragment_text,
                source_start_offset=0,
                source_end_offset=len(fragment_text),
                heading_path=[],
                locator={"fragment_id": str(ids["fragment"])},
                selector={"kind": "web"},
                metadata_json={},
            ),
            ReaderApparatusState(
                id=apparatus_state_id,
                media_id=media_id,
                media_kind=MediaKind.web_article.value,
                source_fingerprint="nineteen-scheme-proof",
                extractor_version="test",
                status="ready",
                item_count=1,
                edge_count=0,
                diagnostics={},
            ),
            PassageAnchor(
                id=ids["passage_anchor"],
                user_id=viewer_id,
                owner_scheme="media",
                owner_id=media_id,
                selector_version=1,
                anchor_key="0" * 64,
                selector={
                    "quote": {"exact": fragment_text, "prefix": "", "suffix": ""},
                    "locator_hint": {"fragment_id": str(ids["fragment"])},
                },
            ),
            SynthesisArtifact(
                id=ids["artifact"],
                subject_scheme="page",
                subject_id=ids["page"],
                audience_scheme="user",
                audience_id=str(viewer_id),
            ),
            OracleCorpusSource(
                id=corpus_source_id,
                work_key=f"proof-{ids['oracle_passage_anchor'].hex}",
                library_id=default_library_id,
                media_id=media_id,
                title="Nineteen-scheme oracle source",
                author_text="Test Author",
                source_repository="test",
                source_url=f"https://example.invalid/oracle/{ids['oracle_passage_anchor']}",
                source_download_url=(
                    f"https://example.invalid/oracle/{ids['oracle_passage_anchor']}.txt"
                ),
                source_media_kind=MediaKind.web_article.value,
                display_order=1,
            ),
        ]
    )
    db.flush()

    db.add_all(
        [
            Highlight(
                id=ids["highlight"],
                user_id=viewer_id,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact=fragment_text,
                prefix="",
                suffix="",
            ),
            EvidenceSpan(
                id=ids["evidence_span"],
                owner_kind="media",
                owner_id=media_id,
                start_block_id=content_block_id,
                end_block_id=content_block_id,
                start_block_offset=0,
                end_block_offset=len(fragment_text),
                span_text=fragment_text,
                selector={"kind": "web", "fragment_id": str(ids["fragment"])},
                citation_label="Proof passage",
                resolver_kind="web",
            ),
            ReaderApparatusItem(
                id=ids["reader_apparatus_item"],
                media_id=media_id,
                state_id=apparatus_state_id,
                stable_key="proof-note",
                kind="footnote",
                label="Proof note",
                body_text="A real apparatus note.",
                locator={
                    "type": "web_text_offsets",
                    "media_id": str(media_id),
                    "fragment_id": str(ids["fragment"]),
                    "start_offset": 0,
                    "end_offset": len(fragment_text),
                },
                locator_status="exact",
                confidence="exact",
                extraction_method="test",
                source_ref={"kind": "test"},
                sort_key="0001",
            ),
            ArtifactBuild(
                id=build_id,
                artifact_id=ids["artifact"],
                requester_user_id=viewer_id,
                idempotency_key=f"proof-{build_id}",
            ),
        ]
    )
    db.flush()

    db.add_all(
        [
            HighlightFragmentAnchor(
                highlight_id=ids["highlight"],
                fragment_id=ids["fragment"],
                start_offset=0,
                end_offset=len(fragment_text),
            ),
            ContentChunk(
                id=ids["content_chunk"],
                owner_kind="media",
                owner_id=media_id,
                primary_evidence_span_id=ids["evidence_span"],
                chunk_idx=0,
                source_kind=MediaKind.web_article.value,
                chunk_text=fragment_text,
                token_count=6,
                heading_path=[],
                summary_locator={"fragment_id": str(ids["fragment"])},
            ),
            ArtifactRevision(
                id=ids["artifact_revision"],
                build_id=build_id,
                content_html="<p>Every scheme is present.</p>",
                content_text="Every scheme is present.",
                input_manifest={},
                citation_owner_user_id=viewer_id,
                creator_user_id=viewer_id,
            ),
        ]
    )
    db.flush()
    db.add(
        OraclePassageAnchor(
            id=ids["oracle_passage_anchor"],
            corpus_source_id=corpus_source_id,
            passage_key="proof-passage",
            display_label="Proof passage",
            selector={"kind": "test"},
            tags=[],
            phase_hints=[],
            current_evidence_span_id=ids["evidence_span"],
            current_content_chunk_id=ids["content_chunk"],
            resolution_status="resolved",
            resolved_at=datetime.now(UTC),
        )
    )
    db.flush()

    return [ResourceRef(scheme=scheme, id=ids[scheme]) for scheme in _RESOURCE_SCHEME_ORACLE]


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


def _availability(snapshot: ResourceActionSnapshotOut, kind: str) -> tuple[str, str | None]:
    availability = _capability(snapshot, kind).availability
    return availability.kind, getattr(availability, "reason", None)


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


@pytest.mark.parametrize(
    ("kind", "has_transcript"),
    [
        (MediaKind.web_article, False),
        (MediaKind.epub, False),
        (MediaKind.pdf, False),
        (MediaKind.video, True),
    ],
)
def test_document_media_subtypes_publish_their_exact_action_families(
    engine: Engine,
    kind: MediaKind,
    has_transcript: bool,
) -> None:
    viewer_id = _new_viewer(engine, f"{kind.value}-actions")
    media_id = uuid4()
    with Session(engine) as db:
        db.add(
            Media(
                id=media_id,
                kind=kind.value,
                title=f"Snapshot proof {kind.value}",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    snapshot = _resolve(
        engine,
        viewer_id,
        [ResourceRef(scheme="media", id=media_id)],
    ).snapshots[0]
    kinds = _kinds(snapshot)
    assert {
        "Consumption",
        "LecternMembership",
        "LibraryPlacement",
        "RemoveMedia",
    } <= kinds
    assert {"EpisodeConsumption", "OfflineAudio", "Playback", "PlayNext"}.isdisjoint(kinds)
    assert ("Transcript" in kinds) is has_transcript


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
    assert {
        "Playback",
        "PlayNext",
        "Transcript",
        "EpisodeConsumption",
        "OfflineAudio",
        "LibraryPlacement",
    } <= episode_kinds
    assert "Consumption" not in episode_kinds
    assert _capability(episode, "EpisodeConsumption").state == "Unplayed"
    descriptor = _capability(episode, "Playback").player_descriptor
    assert descriptor.media_id == media_id
    assert descriptor.title == "Snapshot proof episode"
    assert descriptor.subtitle.kind == "Present"
    assert descriptor.subtitle.value == "Snapshot proof cast"
    assert descriptor.activation.kind == "FooterAudio"
    assert descriptor.activation.stream_url == "https://cdn.example.invalid/ep1.mp3"
    transcript = _capability(episode, "Transcript")
    assert transcript.state == "NotRequested"
    assert transcript.coverage == "None"

    # The subscribed podcast exposes settings, refresh, its subscription state and
    # library placement.
    podcast_kinds = _kinds(podcast)
    assert {"PodcastSettings", "RefreshPodcast", "PodcastSubscription", "LibraryPlacement"} <= (
        podcast_kinds
    )
    assert _capability(podcast, "PodcastSubscription").state == "Subscribed"


def test_existing_unsubscribed_podcast_remains_actionable(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "unsubscribed-podcast-user")
    podcast_id = uuid4()
    with Session(engine) as db:
        db.add(
            Podcast(
                id=podcast_id,
                provider="test",
                provider_podcast_id=str(uuid4()),
                title="Existing unsubscribed podcast",
                feed_url=f"https://feeds.example.invalid/{uuid4()}.xml",
            )
        )
        db.commit()

    snapshot = _resolve(
        engine,
        viewer_id,
        [ResourceRef(scheme="podcast", id=podcast_id)],
    ).snapshots[0]

    # Podcast detail routes admit every persisted Podcast identity. The action
    # snapshot must therefore remain usable after unsubscribe so its canonical
    # menu can expose Subscribe and open the placement editor; destination-level
    # RequiresSubscription authority is owned by the placement inventory.
    assert snapshot.missing is False
    assert snapshot.activation.kind == "route"
    assert snapshot.activation.href == f"/podcasts/{podcast_id}"
    assert {"Open", "PodcastSubscription", "LibraryPlacement"} <= _kinds(snapshot)
    assert _capability(snapshot, "PodcastSubscription").state == "Unsubscribed"
    assert _availability(snapshot, "LibraryPlacement") == ("Available", None)
    assert {"PodcastSettings", "RefreshPodcast"}.isdisjoint(_kinds(snapshot))


def test_file_backed_media_reports_original_download_capability(engine: Engine) -> None:
    viewer_id = _new_viewer(engine, "download-user")
    media_id = uuid4()
    with Session(engine) as db:
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Snapshot proof PDF",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=f"test/{media_id}.pdf",
                content_type="application/pdf",
                size_bytes=1024,
            )
        )
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    snapshot = _resolve(engine, viewer_id, [ResourceRef(scheme="media", id=media_id)]).snapshots[0]

    # A persisted reader file is a single-Media operation. The signed-file
    # command reauthorizes; the snapshot only publishes its applicability.
    assert "DownloadOriginal" in _kinds(snapshot)


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


def test_api_resolves_all_nineteen_schemes_as_present_resources(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    assert RESOURCE_SCHEMES == _RESOURCE_SCHEME_ORACLE
    assert set(_BASELINE_CAPABILITY_ORACLE) == set(_RESOURCE_SCHEME_ORACLE)
    refs = _seed_present_ref_per_scheme(
        db_session,
        viewer_id=test_user.id,
        default_library_id=test_user.default_library_id,
    )
    requested = [ref.uri for ref in refs]

    response = authenticated_client.post(_ENDPOINT, json={"refs": requested})

    assert response.status_code == 200
    snapshots = response.json()["data"]["snapshots"]
    assert [snapshot["ref"] for snapshot in snapshots] == requested
    assert [snapshot["activation"]["resourceRef"] for snapshot in snapshots] == requested
    by_scheme = dict(zip(_RESOURCE_SCHEME_ORACLE, snapshots, strict=True))
    for scheme, snapshot in by_scheme.items():
        actual_kinds = {capability["kind"] for capability in snapshot["capabilities"]}
        assert snapshot["missing"] is False, f"{scheme} resolved as missing"
        assert snapshot["activation"]["kind"] == (
            "external" if scheme == "external_snapshot" else "route"
        ), f"{scheme} did not publish its real activation"
        assert snapshot["activation"]["href"], f"{scheme} activation has no destination"
        assert actual_kinds == _BASELINE_CAPABILITY_ORACLE[scheme], (
            f"{scheme} baseline capability drift: "
            f"expected={sorted(_BASELINE_CAPABILITY_ORACLE[scheme])} "
            f"actual={sorted(actual_kinds)}"
        )
        assert len(snapshot["factsRevision"]) == 64

    def capability(scheme: ResourceScheme, kind: str) -> dict:
        snapshot = by_scheme[scheme]
        return next(
            capability for capability in snapshot["capabilities"] if capability["kind"] == kind
        )

    assert capability("media", "Consumption")["state"] == "Unread"
    assert capability("media", "LecternMembership")["state"] == "Absent"
    assert capability("highlight", "HighlightNote")["state"] == "Absent"
    assert capability("library", "LibrarySettings")["availability"] == {"kind": "Available"}
    assert capability("conversation", "DeleteConversation")["availability"] == {"kind": "Available"}
    assert capability("artifact", "RegenerateArtifact")["availability"] == {"kind": "Available"}
    assert capability("artifact_revision", "MakeArtifactRevisionCurrent")["availability"] == {
        "kind": "Available"
    }
    assert capability("contributor", "RenameContributor")["availability"] == {
        "kind": "Blocked",
        "reason": "PermissionDenied",
    }
    assert capability("podcast", "PodcastSubscription")["state"] == "Subscribed"


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

    # A non-admin member sees the library and the structurally applicable
    # operations. Authority is explanatory state, never silent omission.
    assert member_view.missing is False
    assert "Open" in _kinds(member_view)
    assert _availability(member_view, "LibrarySettings") == (
        "Blocked",
        "PermissionDenied",
    )
    assert _availability(member_view, "DeleteLibrary") == (
        "Blocked",
        "PermissionDenied",
    )


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

    # A non-owner reader sees (and can open) the conversation and can discover
    # that deletion requires ownership. Visibility never masquerades as authority.
    assert reader_view.missing is False
    assert "Open" in _kinds(reader_view)
    assert _availability(reader_view, "DeleteConversation") == (
        "Blocked",
        "PermissionDenied",
    )


def test_shared_highlight_keeps_viewer_owned_note_and_link_available(
    engine: Engine,
) -> None:
    owner_id = _new_viewer(engine, "highlight-owner")
    reader_id = _new_viewer(engine, "highlight-reader")
    media_id = _seed_article(engine, owner_id, source_url=None)
    library_id = _seed_library(engine, owner_id)
    fragment_id = uuid4()
    highlight_id = uuid4()
    with Session(engine) as db:
        ensure_media_in_library(db, owner_id, library_id, media_id)
    with Session(engine) as db:
        db.add(Membership(library_id=library_id, user_id=reader_id, role="member"))
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Shared exact quote",
                html_sanitized="<p>Shared exact quote</p>",
            )
        )
        db.add(
            Highlight(
                id=highlight_id,
                user_id=owner_id,
                anchor_kind="fragment_offsets",
                anchor_media_id=media_id,
                color="yellow",
                exact="Shared exact quote",
                prefix="",
                suffix="",
            )
        )
        db.add(
            HighlightFragmentAnchor(
                highlight_id=highlight_id,
                fragment_id=fragment_id,
                start_offset=0,
                end_offset=18,
            )
        )
        db.commit()

    ref = ResourceRef(scheme="highlight", id=highlight_id)
    owner_view = _resolve(engine, owner_id, [ref]).snapshots[0]
    reader_view = _resolve(engine, reader_id, [ref]).snapshots[0]

    assert _availability(owner_view, "EditHighlight") == ("Available", None)
    assert _availability(reader_view, "EditHighlight") == (
        "Blocked",
        "PermissionDenied",
    )
    assert _availability(reader_view, "EditHighlightBounds") == (
        "Blocked",
        "PermissionDenied",
    )
    assert _availability(reader_view, "DeleteHighlight") == (
        "Blocked",
        "PermissionDenied",
    )
    # Highlight notes and neutral Links are viewer-owned relationships. Their
    # command owners authorize a readable shared Highlight, not Highlight authorship.
    assert _availability(reader_view, "HighlightNote") == ("Available", None)
    assert _availability(reader_view, "LinkHighlight") == ("Available", None)


def test_page_snapshot_endpoint_exposes_every_existing_page_operation(
    authenticated_client: TestClient,
) -> None:
    page_id = uuid4()
    created = authenticated_client.post(
        "/notes/pages",
        json={"page_id": str(page_id), "title": "Canonical action proof"},
    )
    assert created.status_code == 201

    response = authenticated_client.post(_ENDPOINT, json={"refs": [f"page:{page_id}"]})

    assert response.status_code == 200
    snapshot = response.json()["data"]["snapshots"][0]
    assert snapshot["missing"] is False
    assert snapshot["activation"]["resourceRef"] == f"page:{page_id}"
    assert {capability["kind"] for capability in snapshot["capabilities"]} == {
        "Open",
        "OpenInNewPane",
        "Share",
        "Chat",
        "EditPageTitle",
        "DeletePage",
    }


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


def test_mixed_scheme_batch_is_bounded_for_the_full_closed_ref_vocabulary(
    engine: Engine,
) -> None:
    viewer_id = _new_viewer(engine, "mixed-batch-user")
    one_per_scheme = [ResourceRef(scheme=scheme, id=uuid4()) for scheme in _RESOURCE_SCHEME_ORACLE]
    five_per_scheme = [
        ResourceRef(scheme=scheme, id=uuid4())
        for scheme in _RESOURCE_SCHEME_ORACLE
        for _ in range(5)
    ]

    _count_statements(engine, viewer_id, one_per_scheme)
    nineteen = _count_statements(engine, viewer_id, one_per_scheme)
    ninety_five = _count_statements(engine, viewer_id, five_per_scheme)

    assert ninety_five == nineteen, (
        "expected one bounded batch lane per scheme, got "
        f"nineteen={nineteen} ninety_five={ninety_five}"
    )


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
