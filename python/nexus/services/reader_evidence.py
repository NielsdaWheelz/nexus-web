"""Reader roots are native content, quoted messages and exact neighbors of this media.

Native roots use canonical refs; citation occurrences use their edge identities.
Native owners retain their presentation and placement; graph facts add membership
metadata, never an incoming relationship.
Generic roots use current bounded items and only their own current source target.
This projection is read-only and never inspects a root's descendants.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass
from itertools import batched, chain
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.errors import NotFoundError
from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.highlights import FragmentAnchorOut, TypedHighlightOut
from nexus.schemas.reader_document_map import (
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
)
from nexus.schemas.resource_items import (
    CitationSourceTargetKey,
    LocatedSourceLocationOut,
    ResourceItemOut,
    ResourceSourceTargetKey,
    SourceTargetOut,
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
from nexus.services.resource_items.evidence import resolve_source_target
from nexus.services.resource_items.items import (
    excerpt,
    passage_label,
    passage_link_revision,
    resource_items_out,
    source_attributions,
)
from nexus.services.resource_items.locations import media_passages
from nexus.services.resource_items.routing import activations_from_resolved_passages

ReaderRootOrder = tuple[int, str, int, str]
ReaderMarkerOrder = tuple[float, str, str]


@dataclass(frozen=True, slots=True)
class ReaderEvidenceProjection:
    evidence: ReaderEvidenceOut
    roots: list[tuple[ReaderRootOrder, bytes]]
    markers: list[tuple[ReaderMarkerOrder, bytes]]


def build_reader_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    canonical_media_id: UUID,
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
    highlight_refs = {f"highlight:{highlight.id}" for highlight in highlights}
    direct_refs = {
        connection.other.ref
        for connection in connections.items
        if not (connection.origin == "citation" and connection.ordinal is not None)
    }

    def markers_for(
        local_embeds: list[DocumentEmbedOut], local_roots: list[ReaderEvidenceRootOut]
    ) -> list[ReaderDocumentMapMarkerOut]:
        return build_markers(
            media_id=media_id,
            embeds=local_embeds,
            roots=local_roots,
            fragment_ranges=fragment_ranges,
            fragment_times=fragment_times,
            total_fragment_chars=total_fragment_chars,
            page_count=page_count,
            pdf_page_heights=pdf_page_heights,
        )

    # Source references with authored facts stay live until those facts are merged.
    # The rest are complete. Keep their encoded wire values and ordering keys only.
    packed_roots: list[tuple[ReaderRootOrder, bytes]] = []
    packed_markers: list[tuple[ReaderMarkerOrder, bytes]] = []
    connected_apparatus: dict[str, ReaderEvidenceRootOut] = {}
    connected_order: dict[str, int] = {}
    source_count = 0
    apparatus_source = None
    source_batches = batched(apparatus.items, 128)
    first_batch = next(source_batches, ()) if apparatus.status in ("ready", "partial") else ()
    if first_batch:
        owner = ResourceRef("media", media_id)
        apparatus_source = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
        for batch in chain((first_batch,), source_batches):
            refs = [ResourceRef("reader_apparatus_item", item.id) for item in batch]
            passages = media_passages(
                db,
                viewer_id=viewer_id,
                refs=refs,
                reading_media_ids={ref.uri: media_id for ref in refs},
                include_excerpts=False,
            )
            activations = activations_from_resolved_passages(
                db,
                viewer_id=viewer_id,
                refs=refs,
                missing_ref_uris=frozenset(),
                scoped=passages,
            )
            standalone: list[ReaderEvidenceRootOut] = []
            for item in batch:
                resolution = apparatus_resolution(
                    item,
                    media_id=canonical_media_id,
                    fragment_indexes=fragment_indexes,
                    page_count=page_count,
                )
                marker_anchor_id = item.source_ref.get("marker_id")
                selection = excerpt((item.body_text or "")[:601])
                passage = passages.get(item.resource_ref)
                root = ReaderEvidenceRootOut(
                    ref=item.resource_ref,
                    content=ReaderEvidenceSourceReferenceOut(
                        resource_ref=item.resource_ref,
                        action_ref=owner.uri,
                        label=passage_label(selection.text),
                        excerpt=selection,
                        activation=activations[item.resource_ref],
                        location_label=(item.label or None)
                        if apparatus_source is not None
                        else None,
                        stable_key=item.stable_key,
                        apparatus_kind=item.kind,
                        confidence=item.confidence,
                        link_revision=passage_link_revision(
                            passage.owner, passage.quote, passage.locator
                        )
                        if passage is not None
                        else None,
                        marker_anchor_id=marker_anchor_id
                        if isinstance(marker_anchor_id, str) and marker_anchor_id.strip()
                        else None,
                    ),
                    resolution=resolution,
                )
                slot = len(highlight_refs) + source_count
                source_count += 1
                if item.resource_ref in direct_refs:
                    connected_apparatus[item.resource_ref] = root
                    connected_order[item.resource_ref] = slot
                else:
                    standalone.append(root)
                    packed_roots.append(
                        (
                            _root_sort_key(root, {}, slot),
                            zlib.compress(root.model_dump_json().encode(), level=1),
                        )
                    )
            packed_markers.extend(
                (
                    (marker.position, marker.kind, marker.item_id),
                    zlib.compress(marker.model_dump_json().encode(), level=1),
                )
                for marker in markers_for([], standalone)
            )

    generic_refs = direct_refs - highlight_refs - connected_apparatus.keys()
    targets: dict[str, SourceTargetOut] = {}
    reading_media_ids = {ref: media_id for ref in highlight_refs}
    for ref in sorted(generic_refs):
        try:
            target = resolve_source_target(
                db,
                viewer_id=viewer_id,
                target=ResourceSourceTargetKey(field=None, resource_ref=ref),
                reading_media_id=media_id,
            )
        except NotFoundError:
            # justify-ignore-error: absence does not prove local ownership; retain membership.
            continue
        targets[ref] = target
        if (
            target.source_activation is not None
            and target.source_activation.resource_ref == f"media:{media_id}"
            and isinstance(target.location, LocatedSourceLocationOut)
        ):
            reading_media_ids[ref] = media_id
    items = {
        item.ref: item
        for item in resource_items_out(
            db,
            viewer_id=viewer_id,
            refs=[assert_resource_ref(ref) for ref in sorted(highlight_refs | generic_refs)],
            reading_media_ids=reading_media_ids,
            excerpt_mode="full",
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
                locator,
                media_id=canonical_media_id,
                fragment_indexes=fragment_indexes,
                page_count=page_count,
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
        )

    roots.update(connected_apparatus)

    first_facts: dict[str, int] = {}
    for index, connection in enumerate(connections.items):
        ref = connection.other.ref
        cited = connection.origin == "citation" and connection.ordinal is not None
        key = str(connection.edge_id) if cited else ref
        first_facts.setdefault(key, index)
        root = roots.get(key)
        if root is None:
            item = connection.other if cited else items[ref]
            target = targets.get(ref)
            if cited:
                try:
                    target = resolve_source_target(
                        db,
                        viewer_id=viewer_id,
                        target=CitationSourceTargetKey(
                            edge_id=connection.edge_id,
                            side="source" if connection.direction == "outgoing" else "target",
                        ),
                        reading_media_id=media_id,
                    )
                except NotFoundError:
                    # justify-ignore-error: a retired occurrence retains no guessed location.
                    target = None
            root = ReaderEvidenceRootOut(
                ref=ref,
                content=ReaderEvidenceResourceOut(item=item),
                resolution=_resource_resolution(
                    target=target,
                    media_id=media_id,
                    canonical_media_id=canonical_media_id,
                    item=item,
                    fragment_indexes=fragment_indexes,
                    page_count=page_count,
                    fragment_ranges=fragment_ranges,
                    fragment_times=fragment_times,
                ),
            )
            roots[key] = root
        if all(fact.edge_id != connection.edge_id for fact in root.direct_facts):
            root.direct_facts.append(
                ReaderDirectFactOut(
                    edge_id=connection.edge_id,
                    origin=connection.origin,
                    ordinal=connection.ordinal,
                    rationale=connection.snapshot.rationale
                    if connection.origin in ("assistant", "discovery")
                    and connection.snapshot is not None
                    else None,
                )
            )

    standalone_count = len(packed_roots)
    counts = {"highlights": 0, "citations": standalone_count, "links": 0, "machine_links": 0}
    roots_out = list(roots.values())
    for index, (key, root) in enumerate(roots.items()):
        slot = connected_order.get(
            key, index if key in highlight_refs else index + standalone_count
        )
        packed_roots.append(
            (
                _root_sort_key(root, first_facts, slot),
                zlib.compress(root.model_dump_json().encode(), level=1),
            )
        )
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
    packed_markers.extend(
        (
            (marker.position, marker.kind, marker.item_id),
            zlib.compress(marker.model_dump_json().encode(), level=1),
        )
        for marker in markers_for(embeds, roots_out)
    )
    return ReaderEvidenceProjection(
        evidence=ReaderEvidenceOut(
            apparatus_source=apparatus_source,
            roots=[],
            counts=ReaderEvidenceCountsOut(**counts),
        ),
        roots=packed_roots,
        markers=packed_markers,
    )


def _resource_resolution(
    *,
    target: SourceTargetOut | None,
    media_id: UUID,
    canonical_media_id: UUID,
    item: ResourceItemOut,
    fragment_indexes: dict[str, int],
    page_count: int | None,
    fragment_ranges: dict[str, tuple[int, int]],
    fragment_times: dict[str, tuple[int, int]],
) -> ReaderEvidenceResolutionOut | None:
    if (
        target is None
        or target.source_activation is None
        or target.source_activation.resource_ref != f"media:{media_id}"
    ):
        return None
    if isinstance(target.location, UnavailableSourceLocationOut):
        return ReaderEvidenceUnavailableOut(reason="Missing" if item.missing else "Unanchorable")
    if not isinstance(target.location, LocatedSourceLocationOut):
        return None
    locator = target.location.locator.model_dump(mode="json")
    if not locator_is_current_for_media(
        locator,
        media_id=canonical_media_id,
        fragment_indexes=fragment_indexes,
        page_count=page_count,
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


def _root_sort_key(
    root: ReaderEvidenceRootOut, first_facts: dict[str, int], owner_slot: int
) -> ReaderRootOrder:
    from nexus.services.reader_evidence_markers import evidence_root_key

    key = evidence_root_key(root)
    if isinstance(root.resolution, ReaderEvidenceResolvedOut):
        return (0, root.resolution.order_key, 0, root.ref)
    if root.resolution is None:
        return (1, "", first_facts[key], key)
    return (2, root.resolution.sort_order_key or "", owner_slot, key)
