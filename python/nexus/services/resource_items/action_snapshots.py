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
planner owns ordering and turns these facts into a menu. ``availability`` is
``Available`` for every capability this service emits — an ineligible or
inapplicable action is simply OMITTED, and an in-flight action is the client's
busy concern, never a synthesized ``Blocked``.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_action_snapshots import (
    ConsumptionResourceActionCapabilityOut,
    EpisodeConsumptionResourceActionCapabilityOut,
    LecternMembershipResourceActionCapabilityOut,
    OpenSourceResourceActionCapabilityOut,
    PodcastSubscriptionResourceActionCapabilityOut,
    ResourceActionCapabilityOut,
    ResourceActionSnapshotOut,
    ResourceActionSnapshotResolveResponse,
    ServerActionAvailabilityAvailableOut,
    SimpleResourceActionCapabilityOut,
    compute_facts_revision,
)
from nexus.schemas.resource_action_snapshots import (
    _SimpleCapabilityKind as SimpleCapabilityKind,
)
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import conversations, highlights, library_governance, reader_apparatus
from nexus.services.consumption import service as consumption_service
from nexus.services.media import CollectionMedia, list_collection_media_for_viewer_by_ids
from nexus.services.podcasts.subscriptions_query import subscribed_podcast_ids
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
        "reader_apparatus_item",
    }
)
# Every other scheme is already set-based inside ``resolve_refs`` (media/podcast and
# the in-row-owner schemes: page/note_block/external_snapshot/contributor/oracle_*/
# artifact/artifact_revision/passage_anchor); the aggregator keeps sourcing their
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


def resolve_action_snapshots(
    db: Session, *, viewer_id: UUID, refs: list[ResourceRef]
) -> ResourceActionSnapshotResolveResponse:
    """Resolve one action-facts snapshot per ref, in request order.

    A ref whose resource is not visible to the viewer yields a ``missing`` snapshot
    (``missing=True``, ``capabilities=[]``) that keeps its position — it is never
    dropped. Every snapshot's ``factsRevision`` is finalized from its own facts.
    """
    refs_by_scheme: dict[ResourceScheme, list[ResourceRef]] = defaultdict(list)
    for ref in refs:
        refs_by_scheme[ref.scheme].append(ref)

    facts = _ResolvedFacts.load(db, viewer_id=viewer_id, refs_by_scheme=refs_by_scheme)
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

    Residual schemes (media/podcast and the in-row-owner schemes) derive visibility
    from the single set-based ``resolve_refs`` path; the eight batched-visibility
    schemes derive it from their dedicated per-scheme reads on ``facts``. Only
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
    and the visibility sets for the eight batched-visibility schemes. Every field is
    a set-based read over the requested ids, so query count never scales with ref
    count (AC9). ``library``'s keys double as library visibility: the management-facts
    read already returns one row per membership, so a member-visible-but-unmanaged
    library appears (with no manage/delete capability), never as missing.
    """

    media: dict[UUID, CollectionMedia]
    lectern_item_ids: dict[UUID, UUID]
    library: dict[UUID, library_governance.LibraryManagementFacts]
    subscribed_podcast_ids: set[UUID]
    owned_conversation_ids: set[UUID]
    visible_conversation_ids: set[UUID]
    visible_message_ids: set[UUID]
    visible_highlight_ids: set[UUID]
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
                db, viewer_id=viewer_id, media_ids=media_ids
            )
        }
        return cls(
            media=media,
            lectern_item_ids=consumption_service.lectern_item_ids_for_media(
                db, viewer_id=viewer_id, media_ids=media_ids
            ),
            library=library_governance.library_management_facts(
                db, viewer_id=viewer_id, library_ids=ids("library")
            ),
            subscribed_podcast_ids=subscribed_podcast_ids(
                db, viewer_id=viewer_id, podcast_ids=ids("podcast")
            ),
            owned_conversation_ids=conversations.owned_conversation_ids(
                db, viewer_id=viewer_id, conversation_ids=ids("conversation")
            ),
            visible_conversation_ids=conversations.visible_conversation_ids(
                db, viewer_id=viewer_id, conversation_ids=ids("conversation")
            ),
            visible_message_ids=conversations.visible_message_ids(
                db, viewer_id=viewer_id, message_ids=ids("message")
            ),
            visible_highlight_ids=highlights.visible_highlight_ids(
                db, viewer_id=viewer_id, highlight_ids=ids("highlight")
            ),
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
        if scheme == "message":
            return ref.id in self.visible_message_ids
        if scheme == "highlight":
            return ref.id in self.visible_highlight_ids
        if scheme == "evidence_span":
            return ref.id in self.visible_evidence_span_ids
        if scheme == "content_chunk":
            return ref.id in self.visible_content_chunk_ids
        if scheme == "fragment":
            return ref.id in self.visible_fragment_ids
        if scheme == "reader_apparatus_item":
            return ref.id in self.visible_reader_apparatus_item_ids
        # justify-defect: callers only pass batched-visibility schemes here.
        raise AssertionError(f"{scheme} is not a batched-visibility scheme")


def _available() -> ServerActionAvailabilityAvailableOut:
    return ServerActionAvailabilityAvailableOut()


def _simple(kind: SimpleCapabilityKind) -> SimpleResourceActionCapabilityOut:
    return SimpleResourceActionCapabilityOut(kind=kind, availability=_available())


def _capabilities_for_ref(
    ref: ResourceRef, *, activation: ResourceActivationOut, facts: _ResolvedFacts
) -> list[ResourceActionCapabilityOut]:
    """The capability facts for one visible ref, in a deterministic order (core
    first, then scheme-specific). Order is not menu order — the planner reorders —
    but it must be deterministic so identical facts hash identically."""
    capability = capability_for_scheme(ref.scheme)
    routeable = activation.kind in ("route", "external")

    capabilities: list[ResourceActionCapabilityOut] = []
    # CORE — universal across every resolvable scheme.
    if routeable:
        capabilities.append(_simple("Open"))
    if capability.sharing != "None" and routeable:
        capabilities.append(_simple("Share"))
    if capability.chat_subject != "none":
        capabilities.append(_simple("Chat"))

    if ref.scheme == "media":
        _extend_media(ref, capability=capability, facts=facts, capabilities=capabilities)
    elif ref.scheme == "library":
        _extend_library(ref, facts=facts, capabilities=capabilities)
    elif ref.scheme == "podcast":
        _extend_podcast(ref, capability=capability, facts=facts, capabilities=capabilities)
    elif ref.scheme == "conversation":
        if ref.id in facts.owned_conversation_ids:
            capabilities.append(_simple("DeleteConversation"))
    # Every other scheme is core-only by construction.

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
    ops = media.capabilities
    if ops.can_retry:
        capabilities.append(_simple("RetryProcessing"))
    if ops.can_refresh_source:
        capabilities.append(_simple("RefreshSource"))
    if ops.can_retry_metadata:
        capabilities.append(_simple("RetryMetadata"))
    if ops.can_edit_authors:
        capabilities.append(_simple("EditAuthors"))
    if ops.can_delete:
        capabilities.append(_simple("RemoveMedia"))
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

    item_id = facts.lectern_item_ids.get(ref.id)
    if item_id is not None:
        capabilities.append(
            LecternMembershipResourceActionCapabilityOut(
                availability=_available(), state="Present", lectern_item_id=str(item_id)
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
    if library.can_manage_settings:
        capabilities.append(_simple("LibrarySettings"))
    if library.can_delete:
        capabilities.append(_simple("DeleteLibrary"))


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
    capabilities.append(
        PodcastSubscriptionResourceActionCapabilityOut(
            availability=_available(),
            state="Subscribed" if subscribed else "Unsubscribed",
        )
    )
    if capability.library_placement == "ManageEntries":
        capabilities.append(_simple("LibraryPlacement"))


__all__ = ["resolve_action_snapshots"]
