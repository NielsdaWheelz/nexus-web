"""Resolve canonical resource-action snapshots for a batch of refs.

The one read aggregator behind ``POST /resource-items/action-snapshots/resolve``.
It answers a single question per ref: *which action capabilities exist for the
viewer, and does the server block any of them?* It is a pure READ aggregator —
authorization derives only from ``viewer_id``, it performs no cross-domain
mutation, and it calls each owning domain's public read API rather than reaching
into another domain's tables.

Every read is SET-BASED: refs are grouped by scheme and each scheme issues a
bounded number of batched queries (``= ANY(:ids)``), never one query per ref
(AC9). It mirrors the batch precedents ``resource_items_out`` (surfaces.py) and
``resource_activations_for_refs`` (routing.py).

The capabilities a snapshot carries are facts, not menu presentation: no labels,
icons, order, confirmation copy, or client busy/blocked state. The frontend
planner owns ordering and turns these facts into a menu. Structurally applicable
but currently forbidden or unavailable operations remain discoverable as a
typed ``Blocked`` capability; operations that do not apply to the resource are
omitted.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.resource_action_snapshots import (
    ConsumptionResourceActionCapabilityOut,
    EpisodeConsumptionResourceActionCapabilityOut,
    HighlightNoteResourceActionCapabilityOut,
    LecternMembershipResourceActionCapabilityOut,
    OpenSourceResourceActionCapabilityOut,
    PlaybackResourceActionCapabilityOut,
    PodcastSubscriptionResourceActionCapabilityOut,
    ResourceActionCapabilityOut,
    ResourceActionSnapshotOut,
    ResourceActionSnapshotResolveResponse,
    ServerActionAvailabilityAvailableOut,
    ServerActionAvailabilityBlockedOut,
    ServerActionAvailabilityOut,
    SimpleResourceActionCapabilityKind,
    SimpleResourceActionCapabilityOut,
    TranscriptResourceActionCapabilityOut,
    compute_facts_revision,
)
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import conversations, highlights, library_governance, reader_apparatus
from nexus.services.artifacts import engine as artifact_engine
from nexus.services.capabilities import can_rename_contributor
from nexus.services.consumption import service as consumption_service
from nexus.services.media import CollectionMedia, list_collection_media_for_viewer_by_ids
from nexus.services.podcasts.subscriptions_query import (
    existing_podcast_ids,
    failed_backfill_podcast_ids,
    subscribed_podcast_ids,
)
from nexus.services.resource_graph.refs import RESOURCE_SCHEMES, ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import (
    resolve_refs,
    visible_content_chunk_ids,
    visible_evidence_span_ids,
    visible_fragment_ids,
)
from nexus.services.resource_items.capabilities import ResourceItemCapability, capability_for_scheme
from nexus.services.resource_items.routing import resource_activations_for_refs

# Schemes whose per-ref visibility check inside ``resolve_refs`` is a permission
# query per ref; the aggregator sources their visibility from a dedicated set-based
# read instead, so a homogeneous batch stays bounded (AC9).
_BATCHED_VISIBILITY_SCHEMES: frozenset[ResourceScheme] = frozenset(
    {
        "library",
        "conversation",
        "highlight",
        "evidence_span",
        "content_chunk",
        "fragment",
        "message",
        "podcast",
        "reader_apparatus_item",
        "artifact",
        "artifact_revision",
    }
)
# Every other scheme is already set-based inside ``resolve_refs`` (media and
# the in-row-owner schemes: page/note_block/external_snapshot/contributor/oracle_*/
# passage_anchor); the aggregator keeps sourcing their
# visibility from that single set-based path.
_RESIDUAL_VISIBILITY_SCHEMES: frozenset[ResourceScheme] = (
    frozenset(RESOURCE_SCHEMES) - _BATCHED_VISIBILITY_SCHEMES
)

if _BATCHED_VISIBILITY_SCHEMES | _RESIDUAL_VISIBILITY_SCHEMES != frozenset(RESOURCE_SCHEMES):
    # justify-defect: the two visibility lanes must partition every resolvable scheme
    # so a newly added scheme cannot silently skip its visibility read.
    raise AssertionError("visibility scheme partition must cover every ResourceScheme")

# CollectionMedia.read_state is the lowercase MediaReadState vocabulary; the
# Consumption capability mirrors the frontend's PascalCase states. The episode
# read model is byte-identical to this one (finished<->played,
# in_progress<->in_progress, unread<->unplayed), so EpisodeConsumption derives
# from the same read_state with no extra query.
_CONSUMPTION_STATE_BY_READ_STATE: dict[str, Literal["Unread", "InProgress", "Finished"]] = {
    "unread": "Unread",
    "in_progress": "InProgress",
    "finished": "Finished",
}
_TranscriptActionState = Literal[
    "NotRequested",
    "Queued",
    "Running",
    "Ready",
    "Partial",
    "Unavailable",
    "FailedQuota",
    "FailedProvider",
]
_TranscriptActionCoverage = Literal["None", "Partial", "Full"]
_TRANSCRIPT_ACTION_STATE: dict[str | None, _TranscriptActionState] = {
    None: "NotRequested",
    "not_requested": "NotRequested",
    "queued": "Queued",
    "running": "Running",
    "ready": "Ready",
    "partial": "Partial",
    "unavailable": "Unavailable",
    "failed_quota": "FailedQuota",
    "failed_provider": "FailedProvider",
}
_TRANSCRIPT_ACTION_COVERAGE: dict[str | None, _TranscriptActionCoverage] = {
    None: "None",
    "none": "None",
    "partial": "Partial",
    "full": "Full",
}


def resolve_action_snapshots(
    db: Session,
    *,
    viewer_id: UUID,
    refs: list[ResourceRef],
    viewer_roles: frozenset[str] = frozenset(),
) -> ResourceActionSnapshotResolveResponse:
    """Resolve one action-facts snapshot per ref, in request order.

    A ref whose resource is not visible to the viewer yields a ``missing`` snapshot
    (``missing=True``, ``capabilities=[]``) that keeps its position — it is never
    dropped. Every snapshot's ``factsRevision`` is finalized from its own facts.
    """
    refs_by_scheme: dict[ResourceScheme, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        refs_by_scheme[ref.scheme].append(ref)

    facts = _ResolvedFacts.load(
        db,
        viewer_id=viewer_id,
        viewer_roles=viewer_roles,
        refs_by_scheme=refs_by_scheme,
    )
    missing_uris = _missing_uris(db, viewer_id=viewer_id, refs=refs, facts=facts)
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=refs, missing_ref_uris=missing_uris
    )

    snapshots: list[ResourceActionSnapshotOut] = []
    for ref in refs:
        activation = activations[ref.uri]
        missing = ref.uri in missing_uris
        capabilities = (
            [] if missing else _capabilities_for_ref(ref, activation=activation, facts=facts)
        )
        snapshot = ResourceActionSnapshotOut(
            ref=ref.uri,
            activation=activation,
            missing=missing,
            capabilities=capabilities,
        )
        snapshot.facts_revision = compute_facts_revision(snapshot)
        snapshots.append(snapshot)
    return ResourceActionSnapshotResolveResponse(snapshots=snapshots)


def _missing_uris(
    db: Session, *, viewer_id: UUID, refs: list[ResourceRef], facts: _ResolvedFacts
) -> set[str]:
    """The uris the viewer cannot see, sourced set-based per scheme (AC9).

    Residual schemes (media and the in-row-owner schemes) derive visibility
    from the single set-based ``resolve_refs`` path; batched-visibility schemes
    derive it from their dedicated per-scheme reads on ``facts``. Only
    ``.missing`` is consumed from ``resolve_refs`` — never labels/summaries — so the
    per-media document-summary read stays off.
    """
    missing: set[str] = set()
    residual = [ref for ref in refs if ref.scheme in _RESIDUAL_VISIBILITY_SCHEMES]
    if residual:
        resolved = resolve_refs(
            db, viewer_id=viewer_id, refs=residual, include_media_document_summary=False
        )
        missing.update(
            ref.uri for ref, item in zip(residual, resolved, strict=True) if item.missing
        )
    missing.update(
        ref.uri
        for ref in refs
        if ref.scheme in _BATCHED_VISIBILITY_SCHEMES and not facts.is_visible_batched(ref)
    )
    return missing


@dataclass(frozen=True, slots=True)
class _ResolvedFacts:
    """The set-based reads for one resolve call — one bounded batch per scheme.

    Carries both the capability facts (media/lectern/library/subscription/ownership)
    and the visibility sets for the batched-visibility schemes. Every field is
    a set-based read over the requested ids, so query count never scales with ref
    count (AC9). ``library``'s keys double as library visibility: the management-facts
    read already returns one row per membership, so a member-visible-but-unmanaged
    library appears (with no manage/delete capability), never as missing.
    """

    media: dict[UUID, CollectionMedia]
    player_descriptors: dict[UUID, PlayerDescriptor]
    lectern_item_ids: dict[UUID, UUID]
    library: dict[UUID, library_governance.LibraryManagementFacts]
    existing_podcast_ids: set[UUID]
    subscribed_podcast_ids: set[UUID]
    failed_backfill_podcast_ids: set[UUID]
    owned_conversation_ids: set[UUID]
    visible_conversation_ids: set[UUID]
    message_action: dict[UUID, conversations.MessageActionFacts]
    highlight_action: dict[UUID, highlights.HighlightActionFacts]
    artifact_action: dict[UUID, artifact_engine.ArtifactActionFacts]
    artifact_revision_action: dict[UUID, artifact_engine.ArtifactActionFacts]
    can_rename_contributor: bool
    visible_evidence_span_ids: set[UUID]
    visible_content_chunk_ids: set[UUID]
    visible_fragment_ids: set[UUID]
    visible_reader_apparatus_item_ids: set[UUID]

    @classmethod
    def load(
        cls,
        db: Session,
        *,
        viewer_id: UUID,
        viewer_roles: frozenset[str],
        refs_by_scheme: dict[ResourceScheme, list[ResourceRef]],
    ) -> _ResolvedFacts:
        def ids(scheme: ResourceScheme) -> list[UUID]:
            return [ref.id for ref in refs_by_scheme.get(scheme, ())]

        # Every read below early-returns on an empty id list without a query, so a
        # homogeneous batch pays only for the one scheme it actually contains.
        media_ids = ids("media")
        media = {
            row.id: row
            for row in list_collection_media_for_viewer_by_ids(
                db,
                viewer_id=viewer_id,
                media_ids=media_ids,
                is_admin="admin" in viewer_roles,
            )
        }
        artifact_candidates, artifact_revision_candidates = (
            artifact_engine.artifact_action_candidates(
                db,
                viewer_id=viewer_id,
                artifact_ids=ids("artifact"),
                revision_ids=ids("artifact_revision"),
            )
        )
        artifact_subject_refs = {
            candidate.subject_ref.uri: candidate.subject_ref
            for candidate in (
                *artifact_candidates.values(),
                *artifact_revision_candidates.values(),
            )
            if candidate.subject_ref is not None
        }
        nested_library_ids = [
            ref.id for ref in artifact_subject_refs.values() if ref.scheme == "library"
        ]
        nested_conversation_ids = [
            ref.id for ref in artifact_subject_refs.values() if ref.scheme == "conversation"
        ]
        library = library_governance.library_management_facts(
            db,
            viewer_id=viewer_id,
            library_ids=[*ids("library"), *nested_library_ids],
        )
        visible_conversation_ids = conversations.visible_conversation_ids(
            db,
            viewer_id=viewer_id,
            conversation_ids=[*ids("conversation"), *nested_conversation_ids],
        )
        residual_artifact_subjects = [
            ref
            for ref in artifact_subject_refs.values()
            if ref.scheme not in ("library", "conversation")
        ]
        resolved_artifact_subjects = resolve_refs(
            db,
            viewer_id=viewer_id,
            refs=residual_artifact_subjects,
            include_media_document_summary=False,
        )
        visible_artifact_subject_uris = {
            item.uri for item in resolved_artifact_subjects if not item.missing
        }
        visible_artifact_subject_uris.update(
            ref.uri
            for ref in artifact_subject_refs.values()
            if (ref.scheme == "library" and ref.id in library)
            or (ref.scheme == "conversation" and ref.id in visible_conversation_ids)
        )

        def candidate_visible(candidate: artifact_engine.ArtifactActionCandidate) -> bool:
            return (
                candidate.subject_ref is None
                or candidate.subject_ref.uri in visible_artifact_subject_uris
            )

        artifact_action = {
            artifact_id: candidate.facts
            for artifact_id, candidate in artifact_candidates.items()
            if candidate_visible(candidate)
        }
        artifact_revision_action = {
            revision_id: candidate.facts
            for revision_id, candidate in artifact_revision_candidates.items()
            if candidate_visible(candidate)
        }
        return cls(
            media=media,
            player_descriptors=consumption_service.player_descriptors(
                db, viewer_id=viewer_id, media_ids=media_ids
            ),
            lectern_item_ids=consumption_service.lectern_item_ids_for_media(
                db, viewer_id=viewer_id, media_ids=media_ids
            ),
            library=library,
            existing_podcast_ids=existing_podcast_ids(db, podcast_ids=ids("podcast")),
            subscribed_podcast_ids=subscribed_podcast_ids(
                db, viewer_id=viewer_id, podcast_ids=ids("podcast")
            ),
            failed_backfill_podcast_ids=failed_backfill_podcast_ids(
                db, viewer_id=viewer_id, podcast_ids=ids("podcast")
            ),
            owned_conversation_ids=conversations.owned_conversation_ids(
                db, viewer_id=viewer_id, conversation_ids=ids("conversation")
            ),
            visible_conversation_ids=visible_conversation_ids,
            message_action=conversations.message_action_facts(
                db, viewer_id=viewer_id, message_ids=ids("message")
            ),
            highlight_action=highlights.highlight_action_facts(
                db, viewer_id=viewer_id, highlight_ids=ids("highlight")
            ),
            artifact_action=artifact_action,
            artifact_revision_action=artifact_revision_action,
            can_rename_contributor=can_rename_contributor(viewer_roles),
            visible_evidence_span_ids=visible_evidence_span_ids(
                db, viewer_id=viewer_id, evidence_span_ids=ids("evidence_span")
            ),
            visible_content_chunk_ids=visible_content_chunk_ids(
                db, viewer_id=viewer_id, content_chunk_ids=ids("content_chunk")
            ),
            visible_fragment_ids=visible_fragment_ids(
                db, viewer_id=viewer_id, fragment_ids=ids("fragment")
            ),
            visible_reader_apparatus_item_ids=reader_apparatus.visible_reader_apparatus_item_ids(
                db, viewer_id=viewer_id, item_ids=ids("reader_apparatus_item")
            ),
        )

    def is_visible_batched(self, ref: ResourceRef) -> bool:
        """Whether a batched-visibility ref is visible, from its per-scheme set."""
        scheme = ref.scheme
        if scheme == "library":
            return ref.id in self.library
        if scheme == "conversation":
            return ref.id in self.visible_conversation_ids
        if scheme == "podcast":
            return ref.id in self.existing_podcast_ids
        if scheme == "message":
            return ref.id in self.message_action
        if scheme == "highlight":
            return ref.id in self.highlight_action
        if scheme == "evidence_span":
            return ref.id in self.visible_evidence_span_ids
        if scheme == "content_chunk":
            return ref.id in self.visible_content_chunk_ids
        if scheme == "fragment":
            return ref.id in self.visible_fragment_ids
        if scheme == "reader_apparatus_item":
            return ref.id in self.visible_reader_apparatus_item_ids
        if scheme == "artifact":
            return ref.id in self.artifact_action
        if scheme == "artifact_revision":
            return ref.id in self.artifact_revision_action
        # justify-defect: callers only pass batched-visibility schemes here.
        raise AssertionError(f"{scheme} is not a batched-visibility scheme")


def _available() -> ServerActionAvailabilityAvailableOut:
    return ServerActionAvailabilityAvailableOut()


_BlockReason = Literal["PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable"]


def _blocked(reason: _BlockReason) -> ServerActionAvailabilityBlockedOut:
    return ServerActionAvailabilityBlockedOut(reason=reason)


def _authorized(allowed: bool) -> ServerActionAvailabilityOut:
    return _available() if allowed else _blocked("PermissionDenied")


def _simple(
    kind: SimpleResourceActionCapabilityKind,
    availability: ServerActionAvailabilityOut | None = None,
) -> SimpleResourceActionCapabilityOut:
    return SimpleResourceActionCapabilityOut(
        kind=kind,
        availability=availability if availability is not None else _available(),
    )


def _capabilities_for_ref(
    ref: ResourceRef, *, activation: ResourceActivationOut, facts: _ResolvedFacts
) -> list[ResourceActionCapabilityOut]:
    """The capability facts for one visible ref, in a deterministic order (core
    first, then scheme-specific). Order is not menu order — the planner reorders —
    but it must be deterministic so identical facts hash identically."""
    capability = capability_for_scheme(ref.scheme)
    capabilities: list[ResourceActionCapabilityOut] = []
    if activation.kind in ("route", "external"):
        capabilities.append(_simple("Open"))
    if activation.kind == "route":
        capabilities.append(_simple("OpenInNewPane"))
    if capability.sharing != "None" and activation.kind == "route":
        capabilities.append(_simple("Share"))
    if capability.chat_subject != "none":
        capabilities.append(_simple("Chat"))

    if ref.scheme == "media":
        _extend_media(ref, capability=capability, facts=facts, capabilities=capabilities)
    elif ref.scheme == "library":
        _extend_library(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "evidence_span":
        pass
    elif ref.scheme == "content_chunk":
        pass
    elif ref.scheme == "highlight":
        _extend_highlight(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "page":
        capabilities.extend((_simple("EditPageTitle"), _simple("DeletePage")))
    elif ref.scheme == "note_block":
        capabilities.append(_simple("EditNoteBody"))
    elif ref.scheme == "fragment":
        pass
    elif ref.scheme == "conversation":
        capabilities.append(
            _simple(
                "DeleteConversation",
                _authorized(ref.id in facts.owned_conversation_ids),
            )
        )
    elif ref.scheme == "message":
        _extend_message(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "oracle_reading":
        pass
    elif ref.scheme == "oracle_passage_anchor":
        pass
    elif ref.scheme == "artifact":
        _extend_artifact(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "artifact_revision":
        _extend_artifact_revision(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "external_snapshot":
        pass
    elif ref.scheme == "contributor":
        capabilities.append(_simple("RenameContributor", _authorized(facts.can_rename_contributor)))
    elif ref.scheme == "podcast":
        _extend_podcast(ref, capability=capability, facts=facts, capabilities=capabilities)
    elif ref.scheme == "reader_apparatus_item":
        pass
    elif ref.scheme == "passage_anchor":
        pass
    else:
        assert_never(ref.scheme)

    return capabilities


def _extend_media(
    ref: ResourceRef,
    *,
    capability: ResourceItemCapability,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    media = facts.media.get(ref.id)
    if media is None:
        return
    if media.canonical_source_url:
        capabilities.append(
            OpenSourceResourceActionCapabilityOut(
                availability=_available(), href=media.canonical_source_url
            )
        )
    descriptor = facts.player_descriptors.get(ref.id)
    if descriptor is not None:
        capabilities.append(
            PlaybackResourceActionCapabilityOut(
                availability=_available(),
                player_descriptor=descriptor,
            )
        )
        capabilities.append(_simple("PlayNext"))
    if media.has_original_file:
        capabilities.append(_simple("DownloadOriginal"))
    ops = media.capabilities
    if ops.retry_applicable:
        capabilities.append(_simple("RetryProcessing", _authorized(ops.can_retry)))
    if ops.refresh_source_applicable:
        capabilities.append(_simple("RefreshSource", _authorized(ops.can_refresh_source)))
    if ops.retry_metadata_applicable:
        capabilities.append(_simple("RetryMetadata", _authorized(ops.can_retry_metadata)))
    if ops.edit_authors_applicable:
        capabilities.append(_simple("EditAuthors", _authorized(ops.can_edit_authors)))
    capabilities.append(_simple("RemoveMedia", _authorized(ops.can_delete)))
    if media.progress_resettable:
        capabilities.append(_simple("ResetProgress"))

    if media.kind == "podcast_episode":
        capabilities.append(
            EpisodeConsumptionResourceActionCapabilityOut(
                availability=_available(),
                state="Played" if media.read_state == "finished" else "Unplayed",
            )
        )
    else:
        capabilities.append(
            ConsumptionResourceActionCapabilityOut(
                availability=_available(),
                state=_CONSUMPTION_STATE_BY_READ_STATE[media.read_state],
            )
        )

    if media.kind in ("podcast_episode", "video"):
        state = _TRANSCRIPT_ACTION_STATE.get(media.transcript_state)
        coverage = _TRANSCRIPT_ACTION_COVERAGE.get(media.transcript_coverage)
        if state is None or coverage is None:
            raise AssertionError(
                "unknown transcript action state: "
                f"{media.transcript_state!r}/{media.transcript_coverage!r}"
            )
        capabilities.append(
            TranscriptResourceActionCapabilityOut(
                availability=_available(),
                state=state,
                coverage=coverage,
            )
        )

    item_id = facts.lectern_item_ids.get(ref.id)
    if item_id is not None:
        capabilities.append(
            LecternMembershipResourceActionCapabilityOut(
                availability=_available(), state="Present", lectern_item_id=item_id
            )
        )
    else:
        capabilities.append(
            LecternMembershipResourceActionCapabilityOut(availability=_available(), state="Absent")
        )

    if capability.library_placement == "ManageEntries":
        capabilities.append(_simple("LibraryPlacement"))
    if media.offline_download_eligible:
        capabilities.append(_simple("OfflineAudio"))


def _extend_library(
    ref: ResourceRef,
    *,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    library = facts.library.get(ref.id)
    if library is None:
        return
    if library.settings_applicable:
        capabilities.append(_simple("LibrarySettings", _authorized(library.can_manage_settings)))
    if library.delete_applicable:
        capabilities.append(_simple("DeleteLibrary", _authorized(library.can_delete)))


def _extend_podcast(
    ref: ResourceRef,
    *,
    capability: ResourceItemCapability,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    subscribed = ref.id in facts.subscribed_podcast_ids
    if subscribed:
        capabilities.append(_simple("PodcastSettings"))
        capabilities.append(_simple("RefreshPodcast"))
    if ref.id in facts.failed_backfill_podcast_ids:
        capabilities.append(_simple("RetryPodcastBackfill"))
    capabilities.append(
        PodcastSubscriptionResourceActionCapabilityOut(
            availability=_available(),
            state="Subscribed" if subscribed else "Unsubscribed",
        )
    )
    if capability.library_placement == "ManageEntries":
        capabilities.append(_simple("LibraryPlacement"))


def _extend_highlight(
    ref: ResourceRef,
    *,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    action = facts.highlight_action.get(ref.id)
    if action is None:
        return
    owner_availability = _authorized(action.is_owner)
    capabilities.append(_simple("EditHighlight", owner_availability))
    if action.note_block_id is None:
        capabilities.append(
            HighlightNoteResourceActionCapabilityOut(
                availability=_available(),
                state="Absent",
            )
        )
    else:
        capabilities.append(
            HighlightNoteResourceActionCapabilityOut(
                availability=_available(),
                state="Present",
                note_block_id=action.note_block_id,
            )
        )
    capabilities.append(_simple("LinkHighlight"))
    if action.learn_applicable:
        capabilities.append(_simple("LearnHighlight"))
    if action.edit_bounds_applicable:
        capabilities.append(_simple("EditHighlightBounds", owner_availability))
    capabilities.append(_simple("DeleteHighlight", owner_availability))


def _extend_message(
    ref: ResourceRef,
    *,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    action = facts.message_action.get(ref.id)
    if action is None:
        return
    owner_availability = _authorized(action.is_owner)
    if action.fork_applicable:
        capabilities.append(_simple("ForkMessage", owner_availability))
    if action.walk_sources_applicable:
        capabilities.append(_simple("WalkMessageSources"))
    if action.rerun_applicable:
        capabilities.append(_simple("RerunMessage", owner_availability))
    if action.regenerate_applicable:
        capabilities.append(_simple("RegenerateMessage", owner_availability))
    capabilities.append(_simple("DeleteMessage", owner_availability))


def _extend_artifact(
    ref: ResourceRef,
    *,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    action = facts.artifact_action.get(ref.id)
    if action is None:
        return
    capabilities.append(
        _simple(
            "RegenerateArtifact",
            _blocked("Processing") if action.has_active_build else _available(),
        )
    )


def _extend_artifact_revision(
    ref: ResourceRef,
    *,
    facts: _ResolvedFacts,
    capabilities: list[ResourceActionCapabilityOut],
) -> None:
    action = facts.artifact_revision_action.get(ref.id)
    if action is not None and action.is_current_revision is False:
        capabilities.append(_simple("MakeArtifactRevisionCurrent"))


__all__ = ["resolve_action_snapshots"]
