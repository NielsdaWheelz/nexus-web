"""Reader roots are native content plus exact neighbors of this media.

Canonical refs alone establish identity. Native owners retain their presentation
and placement; graph facts add membership metadata, never an incoming relationship.
Native passage continuation requires a locator; a stale locator keeps its source.
Unanchored continuation uses the group's first fact, while authored placement names
only an eligible user link and its own predecessor in the complete endpoint order.
Generic roots use current bounded items and only their own current source target.
This projection is read-only and never inspects a root's descendants.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.highlights import FragmentAnchorOut, TypedHighlightOut
from nexus.schemas.notes import Position
from nexus.schemas.reader_document_map import (
    ReaderAuthoredPlacementOut,
    ReaderChildContinuationOut,
    ReaderDirectFactOut,
    ReaderDocumentMapMarkerOut,
    ReaderEvidenceAnchorOut,
    ReaderEvidenceCountsOut,
    ReaderEvidenceHighlightOut,
    ReaderEvidenceOut,
    ReaderEvidenceResolutionOut,
    ReaderEvidenceResolvedOut,
    ReaderEvidenceResourceOut,
    ReaderEvidenceRootOut,
    ReaderEvidenceSourceReferenceOut,
    ReaderEvidenceUnavailableOut,
    ReaderSiblingContinuationOut,
)
from nexus.schemas.resource_graph import LinkEndpoint, LinkPassageEndpoint, LinkResourceEndpoint
from nexus.schemas.resource_items import (
    LocatedSourceLocationOut,
    ResourceItemOut,
    ResourceSourceTargetKey,
    UnavailableSourceLocationOut,
)
from nexus.services.reader_apparatus import ReaderApparatusResponse, apparatus_resolution
from nexus.services.reader_connections import ReaderConnections
from nexus.services.reader_evidence_markers import build_markers
from nexus.services.reader_locations import (
    highlight_locator,
    locator_is_current_for_media,
    order_key_from_locator,
    timed_fragment_offset,
)
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.evidence import resolve_source_target
from nexus.services.resource_items.items import (
    excerpt,
    passage_label,
    resource_items_out,
    source_attributions,
)
from nexus.services.resource_items.routing import resource_activations_for_refs


@dataclass(frozen=True, slots=True)
class ReaderEvidenceProjection:
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut]


def build_reader_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
    embeds: list[DocumentEmbedOut],
    highlights: list[TypedHighlightOut],
    apparatus: ReaderApparatusResponse,
    connections: ReaderConnections,
    fragment_indexes: dict[str, int],
    fragment_ranges: dict[str, tuple[int, int]],
    fragment_times: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> ReaderEvidenceProjection:
    """Merge direct facts by exact far ref after constructing domain-owned roots."""
    refs = {f"highlight:{highlight.id}" for highlight in highlights}
    refs.update(connection.other.ref for connection in connections.items)
    items = {
        item.ref: item
        for item in resource_items_out(
            db, viewer_id=viewer_id, refs=[assert_resource_ref(ref) for ref in sorted(refs)]
        )
    }
    roots: dict[str, ReaderEvidenceRootOut] = {}
    for highlight in highlights:
        ref = f"highlight:{highlight.id}"
        locator = highlight_locator(
            highlight.anchor.model_dump(mode="json"),
            media_kind=media_kind,
            exact=highlight.exact,
            prefix=highlight.prefix,
            suffix=highlight.suffix,
        )
        unresolved = (
            isinstance(highlight.anchor, FragmentAnchorOut) and highlight.anchor.fragment_id is None
        )
        resolution = (
            ReaderEvidenceUnavailableOut(reason="Stale")
            if unresolved
            or not locator_is_current_for_media(
                locator, media_id=media_id, fragment_indexes=fragment_indexes, page_count=page_count
            )
            else _resolved(
                locator=locator,
                fragment_indexes=fragment_indexes,
                fragment_ranges=fragment_ranges,
                fragment_times=fragment_times,
                ref=ref,
            )
        )
        roots[ref] = ReaderEvidenceRootOut(
            ref=ref,
            content=ReaderEvidenceHighlightOut(
                item=items[ref],
                highlight_id=highlight.id,
                version=highlight.version,
                quote=highlight.exact,
                prefix=highlight.prefix,
                suffix=highlight.suffix,
                color=highlight.color,
                created_at=highlight.created_at,
                updated_at=highlight.updated_at,
                author_user_id=highlight.author_user_id,
                is_owner=highlight.is_owner,
            ),
            resolution=resolution,
            continuation=_child_continuation(assert_resource_ref(ref)),
            authored_placement=None,
        )

    apparatus_source = None
    if apparatus.status in ("ready", "partial") and apparatus.items:
        owner = ResourceRef("media", media_id)
        apparatus_source = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
        activations = resource_activations_for_refs(
            db,
            viewer_id=viewer_id,
            refs=[ResourceRef("reader_apparatus_item", item.id) for item in apparatus.items],
        )
        for item in apparatus.items:
            marker_anchor_id = item.source_ref.get("marker_id")
            selection = excerpt((item.body_text or "")[:601])
            roots[item.resource_ref] = ReaderEvidenceRootOut(
                ref=item.resource_ref,
                content=ReaderEvidenceSourceReferenceOut(
                    resource_ref=item.resource_ref,
                    action_ref=owner.uri,
                    label=passage_label(selection),
                    excerpt=selection,
                    activation=activations[item.resource_ref],
                    location_label=(item.label or None) if apparatus_source is not None else None,
                    stable_key=item.stable_key,
                    apparatus_kind=item.kind,
                    confidence=item.confidence,
                    marker_anchor_id=marker_anchor_id
                    if isinstance(marker_anchor_id, str) and marker_anchor_id.strip()
                    else None,
                ),
                continuation=(
                    _child_continuation(ResourceRef("reader_apparatus_item", item.id))
                    if item.locator is not None
                    else None
                ),
                authored_placement=None,
                resolution=apparatus_resolution(
                    item,
                    media_id=media_id,
                    fragment_indexes=fragment_indexes,
                    page_count=page_count,
                ),
            )

    first_facts: dict[str, int] = {}
    predecessor: UUID | None = None
    endpoint = LinkResourceEndpoint(ref=f"media:{media_id}")
    for index, connection in enumerate(connections.items):
        ref = connection.other.ref
        first_facts.setdefault(ref, index)
        root = roots.get(ref)
        if root is None:
            item = items[ref]
            root = ReaderEvidenceRootOut(
                ref=ref,
                content=ReaderEvidenceResourceOut(item=item),
                continuation=None,
                authored_placement=None,
                resolution=_resource_resolution(
                    db,
                    viewer_id=viewer_id,
                    media_id=media_id,
                    item=item,
                    fragment_indexes=fragment_indexes,
                    page_count=page_count,
                    fragment_ranges=fragment_ranges,
                    fragment_times=fragment_times,
                ),
            )
            if not item.missing:
                root.continuation = (
                    ReaderSiblingContinuationOut(
                        source=endpoint,
                        position=Position(
                            after=connection.edge_id,
                            expected_links_version=connections.links_version,
                        ),
                    )
                    if root.resolution is None
                    else _child_continuation(assert_resource_ref(ref))
                )
            roots[ref] = root
        if (
            root.resolution is None
            and root.authored_placement is None
            and connection.origin == "user"
            and connection.link_note is None
            and not connection.other.missing
            and capability(assert_resource_ref(ref).scheme).link_mode == "direct"
        ):
            root.authored_placement = ReaderAuthoredPlacementOut(
                endpoint=endpoint.ref,
                link_id=connection.edge_id,
                position=Position(
                    after=predecessor, expected_links_version=connections.links_version
                ),
            )
        if all(fact.edge_id != connection.edge_id for fact in root.direct_facts):
            root.direct_facts.append(
                ReaderDirectFactOut(
                    edge_id=connection.edge_id,
                    origin=connection.origin,
                    ordinal=connection.ordinal,
                )
            )

        predecessor = connection.edge_id

    owner_order = {ref: index for index, ref in enumerate(roots)}
    roots_out = sorted(
        roots.values(),
        key=lambda root: _root_sort_key(root, first_facts, owner_order),
    )
    counts = {"highlights": 0, "citations": 0, "links": 0, "machine_links": 0}
    for root in roots_out:
        facets: set[str] = set()
        if isinstance(root.content, ReaderEvidenceHighlightOut):
            facets.add("highlights")
        elif isinstance(root.content, ReaderEvidenceSourceReferenceOut):
            facets.add("citations")
        for fact in root.direct_facts:
            if fact.origin == "citation" and fact.ordinal is not None:
                facets.add("citations")
            elif fact.origin in ("assistant", "discovery"):
                facets.add("machine_links")
            else:
                facets.add("links")
        for facet in facets:
            counts[facet] += 1
    return ReaderEvidenceProjection(
        evidence=ReaderEvidenceOut(
            apparatus_source=apparatus_source,
            roots=roots_out,
            counts=ReaderEvidenceCountsOut(**counts),
        ),
        markers=build_markers(
            media_id=media_id,
            embeds=embeds,
            roots=roots_out,
            fragment_ranges=fragment_ranges,
            fragment_times=fragment_times,
            total_fragment_chars=total_fragment_chars,
            page_count=page_count,
            pdf_page_heights=pdf_page_heights,
        ),
    )


def _resource_resolution(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    item: ResourceItemOut,
    fragment_indexes: dict[str, int],
    page_count: int | None,
    fragment_ranges: dict[str, tuple[int, int]],
    fragment_times: dict[str, tuple[int, int]],
) -> ReaderEvidenceResolutionOut | None:
    try:
        target = resolve_source_target(
            db, viewer_id=viewer_id, target=ResourceSourceTargetKey(resource_ref=item.ref)
        )
    except NotFoundError:
        # justify-ignore-error: absence does not prove local ownership; retain membership.
        return None
    if (
        target.source_activation is None
        or target.source_activation.resource_ref != f"media:{media_id}"
    ):
        return None
    if isinstance(target.location, UnavailableSourceLocationOut):
        return ReaderEvidenceUnavailableOut(reason="Missing" if item.missing else "Unanchorable")
    if not isinstance(target.location, LocatedSourceLocationOut):
        return None
    locator = target.location.locator.model_dump(mode="json")
    if not locator_is_current_for_media(
        locator, media_id=media_id, fragment_indexes=fragment_indexes, page_count=page_count
    ):
        return ReaderEvidenceUnavailableOut(reason="Stale")
    if (
        locator.get("type") in ("transcript_time_range", "audio_time_range", "video_time_range")
        and timed_fragment_offset(locator, fragment_ranges, fragment_times) is None
    ):
        return ReaderEvidenceUnavailableOut(reason="Unanchorable")
    try:
        return _resolved(
            locator=locator,
            fragment_indexes=fragment_indexes,
            fragment_ranges=fragment_ranges,
            fragment_times=fragment_times,
            ref=item.ref,
        )
    except ValidationError:
        # justify-ignore-error: a local locator outside reader grammar is explicitly stale.
        return ReaderEvidenceUnavailableOut(reason="Stale")


def _resolved(
    *,
    locator: dict[str, object],
    fragment_indexes: dict[str, int],
    fragment_ranges: dict[str, tuple[int, int]],
    fragment_times: dict[str, tuple[int, int]],
    ref: str,
) -> ReaderEvidenceResolvedOut:
    parsed = assert_resource_ref(ref)
    timed = timed_fragment_offset(locator, fragment_ranges, fragment_times)
    ordered_locator: dict[str, object] = (
        locator if timed is None else {"fragment_id": timed[0], "start_offset": int(timed[1])}
    )
    return ReaderEvidenceResolvedOut(
        anchor=ReaderEvidenceAnchorOut.model_validate(
            {
                "locator": locator,
                "passage_anchor_id": parsed.id if parsed.scheme == "passage_anchor" else None,
            }
        ),
        order_key=order_key_from_locator(ordered_locator, fragment_indexes) or ref,
    )


def _child_continuation(ref: ResourceRef) -> ReaderChildContinuationOut | None:
    source: LinkEndpoint
    match capability(ref.scheme).link_mode:
        case "direct":
            source = LinkResourceEndpoint(ref=ref.uri)
        case "materialize_passage":
            source = LinkPassageEndpoint(candidate_ref=ref.uri)
        case "none":
            return None
    return ReaderChildContinuationOut(source=source, position=None)


def _root_sort_key(
    root: ReaderEvidenceRootOut, first_facts: dict[str, int], owner_order: dict[str, int]
) -> tuple[int, str, int, str]:
    if isinstance(root.resolution, ReaderEvidenceResolvedOut):
        return (0, root.resolution.order_key, 0, root.ref)
    if root.resolution is None:
        return (1, "", first_facts[root.ref], root.ref)
    return (2, root.resolution.sort_order_key or "", owner_order[root.ref], root.ref)
