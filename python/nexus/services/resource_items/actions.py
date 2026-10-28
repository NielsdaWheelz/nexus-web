"""The verbs one viewer has on one resource right now.

Facts only: which verbs exist and whether the server blocks them. Inapplicable verbs
are omitted; applicable but forbidden ones are present with ``blocked``. Labels,
order, confirmation and client state belong to the web catalog. Visibility, label and
activation are the item read's, so the two reads agree (I2); each scheme's facts come
from its owner.
"""

from __future__ import annotations

from typing import assert_never, cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.metadata_enrichment import MetadataRetryAllowed
from nexus.schemas.resource_items import (
    BlockReason,
    ConsumptionAction,
    DownloadAction,
    DownloadKind,
    LecternMembershipAction,
    OpenPodcastFeedAction,
    OpenSourceAction,
    PlaybackAction,
    RecoveryAction,
    RefreshSourceAction,
    ResourceActionOut,
    ResourceActionsOut,
    RetryMetadataAction,
    ReviewMetadataResultAction,
    SimpleAction,
    SimpleActionKind,
    TranscriptAction,
    TranscriptState,
)
from nexus.services import highlights, libraries, library_entries
from nexus.services.chat import conversations
from nexus.services.consumption import lectern, projection
from nexus.services.media import media_facts
from nexus.services.podcasts.subscriptions_query import podcast_states
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_item_out

_METADATA_BLOCKED: dict[str, BlockReason] = {
    "not_creator": "PermissionDenied",
    "not_eligible": "TemporarilyUnavailable",
    "active": "Processing",
    "source_context_missing": "TemporarilyUnavailable",
}


def resource_actions(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceActionsOut:
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
    activation = item.activation
    actions: list[ResourceActionOut] = []
    if not item.missing:
        policy = capability(ref.scheme)
        if activation.kind != "none":
            actions.append(_simple("Open"))
        if activation.kind == "route":
            actions.append(_simple("OpenInNewPane"))
            if policy.sharing != "None":
                actions.append(_simple("Share"))
        if policy.link_mode != "none":
            if policy.chat_subject:
                actions.append(_simple("Chat"))
        actions += _scheme_actions(db, viewer_id=viewer_id, ref=ref)
    return ResourceActionsOut(
        ref=ref.uri,
        label=item.label,
        activation=activation,
        missing=item.missing,
        actions=actions,
    )


def _scheme_actions(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> list[ResourceActionOut]:
    match ref.scheme:
        case "media":
            return _media(db, viewer_id, ref.id)
        case "library":
            return _library(db, viewer_id, ref.id)
        case "podcast":
            return _podcast(db, viewer_id, ref.id)
        case "highlight":
            return _highlight(db, viewer_id, ref.id)
        case "message":
            return _message(db, viewer_id, ref.id)
        case "page":
            return [_simple("EditPageTitle"), _simple("DeletePage")]
        case "note_block":
            return [_simple("EditNoteBody")]
        case "conversation":
            return [_simple("DeleteConversation")]
        case (
            "evidence_span"
            | "content_chunk"
            | "fragment"
            | "oracle_reading"
            | "oracle_passage_anchor"
            | "external_snapshot"
            | "contributor"
            | "reader_apparatus_item"
            | "passage_anchor"
        ):
            return []
        case _ as unreachable:
            assert_never(unreachable)


def _media(db: Session, viewer_id: UUID, media_id: UUID) -> list[ResourceActionOut]:
    media = media_facts(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
    if media is None:
        return []
    kind = media.summary.media_kind.value
    actions: list[ResourceActionOut] = [_simple("Metadata")]
    if media.canonical_source_url:
        actions.append(OpenSourceAction(blocked=None, href=media.canonical_source_url))
    descriptors = projection.player_descriptors(db, viewer_id=viewer_id, media_ids=[media_id])
    if media_id in descriptors:
        actions.append(PlaybackAction(blocked=None, player_descriptor=descriptors[media_id]))
        actions.append(_simple("PlayNext"))
        actions.append(_simple("AddToQueue"))
    if media.has_file:
        actions.append(_simple("DownloadOriginal"))
    # Each obligation's own offer is actionable; a creator's stays discoverable but blocked.
    for own, applicable in (
        (media.source_offer, media.creator_source_offer),
        (media.search_offer, media.creator_search_offer),
    ):
        if own is not None:
            actions.append(RecoveryAction(blocked=None, offer=own))
        elif applicable is not None:
            actions.append(RecoveryAction(blocked="PermissionDenied", offer=applicable))
    # Applicable while a source exists, so a lost refresh's "confirm request" stays reachable
    # during its run; only current availability admits a fresh one.
    if media.source_attempt_id is not None:
        actions.append(
            RefreshSourceAction(
                blocked="PermissionDenied"
                if not media.is_creator
                else None
                if media.refreshable
                else "TemporarilyUnavailable",
                expected_attempt_id=media.source_attempt_id if media.refreshable else None,
            )
        )
    retry = media.metadata.retry
    blocked = None if isinstance(retry, MetadataRetryAllowed) else _METADATA_BLOCKED[retry.reason]
    actions.append(RetryMetadataAction(blocked=blocked, retry=retry))
    operation = media.metadata.operation
    if (
        operation is not None
        and operation.status == "no_findings"
        and operation.reviewed_at is None
    ):
        actions.append(ReviewMetadataResultAction(blocked=None, job_id=operation.job_id))
    if kind == "podcast_episode":
        membership = library_entries.list_item_libraries(
            db, viewer_id=viewer_id, target=library_entries.media_target(media_id)
        ).all_membership
        if membership.included:
            blocked = membership.remove_blocked
            actions.append(
                _simple(
                    "RemoveEpisodeFromAll",
                    "PermissionDenied" if blocked == "RequiresAdmin" else blocked,
                )
            )
        else:
            actions.append(_simple("AddEpisodeToAll"))
    else:
        actions.append(_simple("RemoveMedia", _owner(media.can_delete)))
    if media.progress_resettable:
        actions.append(_simple("ResetProgress"))
    actions.append(
        ConsumptionAction(
            blocked=None,
            finished=media.summary.consumption.state == "Finished",
            episode=kind == "podcast_episode",
        )
    )
    if kind in ("podcast_episode", "video"):
        state = cast(TranscriptState, media.transcript_state or "not_requested")
        actions.append(TranscriptAction(blocked=None, state=state))
    item_ids = lectern.item_ids_for_media(db, viewer_id=viewer_id, media_ids=[media_id])
    actions.append(LecternMembershipAction(blocked=None, lectern_item_id=item_ids.get(media_id)))
    actions.append(_simple("LibraryPlacement"))
    # A document's copy is its readable publication, the one the reading copy builds from.
    readable_copy = kind in ("web_article", "epub", "pdf") and media.can_read
    if media.audio_url is not None or readable_copy:
        actions.append(
            DownloadAction(
                blocked=None,
                media_kind=cast(DownloadKind, kind),
                title=media.summary.title,
            )
        )
    return actions


def _library(db: Session, viewer_id: UUID, library_id: UUID) -> list[ResourceActionOut]:
    try:
        library = libraries.access(db, viewer_id, library_id, lock=False)
    except NotFoundError:
        return []
    actions: list[ResourceActionOut] = [
        _simple("Metadata"),
        _simple("MarkCollectionFinished"),
        _simple("MarkCollectionUnread"),
        _simple("AddUnfinishedToLectern"),
    ]
    out = library.out(viewer_id)
    if out.can_leave:
        actions.append(_simple("LeaveLibrary"))
    if library.mutable:
        actions.extend(
            [
                _simple("LibrarySettings", _owner(out.can_manage)),
                _simple("DeleteLibrary", _owner(out.can_delete)),
            ]
        )
    return actions


def _podcast(db: Session, viewer_id: UUID, podcast_id: UUID) -> list[ResourceActionOut]:
    state = podcast_states(db, viewer_id=viewer_id, podcast_ids=[podcast_id]).get(podcast_id)
    if state is None:
        return []
    actions: list[ResourceActionOut] = [
        _simple("Metadata"),
        OpenPodcastFeedAction(blocked=None, href=state.feed_url),
        _simple("MarkCollectionFinished"),
        _simple("MarkCollectionUnread"),
        _simple("AddUnfinishedToLectern"),
        _simple("TranscribePodcastEpisodes"),
    ]
    if state.website_url is not None:
        actions.append(OpenSourceAction(blocked=None, href=state.website_url))
    actions.append(_simple("UnsubscribePodcast" if state.subscribed else "SubscribePodcast"))
    actions.append(_simple("PodcastLibraries"))
    actions.append(_simple("PodcastSettings"))
    actions.append(_simple("RefreshPodcast"))
    if state.has_episodes:
        actions.append(_simple("RemovePodcastEpisodes"))
    return actions


def _highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> list[ResourceActionOut]:
    facts = highlights.highlight_action_facts(
        db, viewer_id=viewer_id, highlight_ids=[highlight_id]
    ).get(highlight_id)
    if facts is None:
        return []
    owner = _owner(facts.is_owner)
    actions: list[ResourceActionOut] = [
        _simple("EditHighlight", owner),
        _simple("HighlightNote"),
    ]
    if facts.edit_bounds_applicable:
        actions.append(_simple("EditHighlightBounds", owner))
    actions.append(_simple("DeleteHighlight", owner))
    return actions


def _message(db: Session, viewer_id: UUID, message_id: UUID) -> list[ResourceActionOut]:
    facts = conversations.message_action_facts(
        db, viewer_id=viewer_id, message_ids=[message_id]
    ).get(message_id)
    if facts is None:
        return []
    applicable: list[tuple[bool, SimpleActionKind]] = [
        (facts.fork_applicable, "ForkMessage"),
        (facts.rerun_applicable, "RerunMessage"),
        (facts.regenerate_applicable, "RegenerateMessage"),
        (True, "DeleteMessage"),
    ]
    return [_simple(kind) for applies, kind in applicable if applies]


def _simple(kind: SimpleActionKind, blocked: BlockReason | None = None) -> SimpleAction:
    return SimpleAction(kind=kind, blocked=blocked)


def _owner(allowed: bool) -> BlockReason | None:
    return None if allowed else "PermissionDenied"
