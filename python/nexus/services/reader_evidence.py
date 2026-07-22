"""Canonical Reader Evidence fact, occurrence, association, and marker projection."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import assert_never, cast
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.highlights import HIGHLIGHT_COLORS, TypedHighlightOut
from nexus.schemas.media import DocumentEmbedOut, MediaNavigationOut
from nexus.schemas.presence import Presence, absent, present
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
    ReaderApparatusEdgeOut,
    ReaderApparatusItemKind,
    ReaderApparatusItemOut,
    ReaderApparatusResponse,
)
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapMarkerOut,
    ReaderEvidenceAlsoReferenceOut,
    ReaderEvidenceAnchorOut,
    ReaderEvidenceAssociationOut,
    ReaderEvidenceAuthoredInOut,
    ReaderEvidenceChatObjectOut,
    ReaderEvidenceCountsOut,
    ReaderEvidenceDirectlyAttachedOut,
    ReaderEvidenceDossierObjectOut,
    ReaderEvidenceGeneratedCitationOut,
    ReaderEvidenceHighlightOut,
    ReaderEvidenceItemOut,
    ReaderEvidenceLinkOut,
    ReaderEvidenceMediaObjectOut,
    ReaderEvidenceNoteObjectOut,
    ReaderEvidenceObjectOut,
    ReaderEvidenceOracleObjectOut,
    ReaderEvidenceOtherObjectOut,
    ReaderEvidenceOut,
    ReaderEvidencePassageGroupOut,
    ReaderEvidenceResolutionOut,
    ReaderEvidenceResolvedOut,
    ReaderEvidenceSourceReferenceOut,
    ReaderEvidenceSourceTargetOut,
    ReaderEvidenceSynapseOut,
    ReaderEvidenceUnavailableOut,
    ReaderEvidenceUnavailableReason,
)
from nexus.schemas.resource_graph import ConnectionEndpointOut
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.reader_connections import ReaderConnectionRow
from nexus.services.reader_evidence_markers import build_markers
from nexus.services.reader_locations import (
    highlight_locator,
    locator_is_current_for_media,
    locator_json,
    order_key_from_locator,
)
from nexus.services.resource_items.routing import route_for_visible_apparatus_item

_APPARATUS_FORWARD_RELATIONS = frozenset(
    {
        "points_to_note",
        "points_to_endnote",
        "points_to_sidenote",
        "points_to_margin_note",
        "cites_bibliography_entry",
        "contains_reference",
    }
)
_ITEM_KIND_ORDER = {
    "Highlight": 0,
    "SourceReference": 1,
    "GeneratedCitation": 2,
    "Link": 3,
    "Synapse": 4,
}


@dataclass(slots=True)
class _PassageAccumulator:
    locus_ref: str
    resolution: ReaderEvidenceResolutionOut
    items: list[ReaderEvidenceItemOut] = field(default_factory=list)
    also_references: list[ReaderEvidenceAlsoReferenceOut] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class _MessageMeta:
    conversation_id: UUID
    conversation_title: str


@dataclass(frozen=True, slots=True)
class _NoteMeta:
    body_pm_json: dict[str, object]
    body_text: str


@dataclass(slots=True)
class _ProjectionState:
    passage_groups: dict[str, _PassageAccumulator] = field(default_factory=dict)
    document_items: list[ReaderEvidenceItemOut] = field(default_factory=list)
    represented_facts: dict[str, list[ReaderEvidenceItemOut]] = field(
        default_factory=lambda: defaultdict(list)
    )
    omitted_counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))


@dataclass(frozen=True, slots=True)
class ReaderEvidenceProjection:
    evidence: ReaderEvidenceOut
    markers: list[ReaderDocumentMapMarkerOut]
    omitted_item_counts: dict[str, int]


def build_reader_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media_kind: str,
    navigation: MediaNavigationOut | None,
    embeds: list[DocumentEmbedOut],
    highlights: list[TypedHighlightOut],
    apparatus: ReaderApparatusResponse,
    connections: list[ReaderConnectionRow],
    fragment_indexes: dict[str, int],
    fragment_ranges: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> ReaderEvidenceProjection:
    """Compose owner payloads into canonical Evidence semantics."""

    message_meta, note_meta = _load_related_metadata(
        db,
        viewer_id=viewer_id,
        rows=connections,
    )
    state = _ProjectionState()

    _add_highlight_facts(
        state,
        highlights=highlights,
        media_kind=media_kind,
        fragment_indexes=fragment_indexes,
    )

    if apparatus.status in ("ready", "partial"):
        _compose_apparatus(
            media_id=media_id,
            page_count=page_count,
            apparatus_items=apparatus.items,
            apparatus_edges=apparatus.edges,
            fragment_indexes=fragment_indexes,
            groups=state.passage_groups,
            represented_facts=state.represented_facts,
        )

    authored_chat_loci, consumed_edge_ids = _add_generated_citations(
        state,
        connections=connections,
        message_meta=message_meta,
        note_meta=note_meta,
        media_id=media_id,
        page_count=page_count,
        fragment_indexes=fragment_indexes,
    )
    _add_synapses(
        state,
        connections=connections,
        consumed_edge_ids=consumed_edge_ids,
        message_meta=message_meta,
        note_meta=note_meta,
        media_id=media_id,
        page_count=page_count,
        fragment_indexes=fragment_indexes,
    )

    _add_remaining_connections(
        state,
        connections=connections,
        consumed_edge_ids=consumed_edge_ids,
        authored_chat_loci=authored_chat_loci,
        message_meta=message_meta,
        note_meta=note_meta,
        media_id=media_id,
        page_count=page_count,
        fragment_indexes=fragment_indexes,
    )

    groups_out = _finalize_groups(state.passage_groups)
    state.document_items.sort(key=_item_sort_key)
    markers = build_markers(
        media_id=media_id,
        media_kind=media_kind,
        navigation=navigation,
        embeds=embeds,
        groups=groups_out,
        fragment_ranges=fragment_ranges,
        total_fragment_chars=total_fragment_chars,
        page_count=page_count,
        pdf_page_heights=pdf_page_heights,
    )
    all_items = [item for group in groups_out for item in group.items] + state.document_items
    counts = ReaderEvidenceCountsOut(
        highlights=sum(item.kind == "Highlight" for item in all_items),
        citations=sum(item.kind in ("SourceReference", "GeneratedCitation") for item in all_items),
        links=sum(item.kind == "Link" for item in all_items),
        synapses=sum(item.kind == "Synapse" for item in all_items),
        passages=sum(len(group.items) for group in groups_out),
        document=len(state.document_items),
    )
    return ReaderEvidenceProjection(
        evidence=ReaderEvidenceOut(
            counts=counts,
            passage_groups=groups_out,
            document_items=state.document_items,
        ),
        markers=markers,
        omitted_item_counts=dict(sorted(state.omitted_counts.items())),
    )


def _add_highlight_facts(
    state: _ProjectionState,
    *,
    highlights: list[TypedHighlightOut],
    media_kind: str,
    fragment_indexes: dict[str, int],
) -> None:
    for highlight in highlights:
        locus_ref = f"highlight:{highlight.id}"
        locator = highlight_locator(
            highlight.anchor.model_dump(mode="json"),
            media_kind=media_kind,
            exact=highlight.exact,
            prefix=highlight.prefix,
            suffix=highlight.suffix,
        )
        resolution = _resolved(
            locator=locator,
            order_key=order_key_from_locator(locator, fragment_indexes) or locus_ref,
        )
        item = ReaderEvidenceHighlightOut(
            id=locus_ref,
            label=highlight.exact or "Highlight",
            excerpt=present(highlight.exact) if highlight.exact else absent(),
            highlight_id=highlight.id,
            quote=highlight.exact,
            prefix=highlight.prefix,
            suffix=highlight.suffix,
            color=cast(HIGHLIGHT_COLORS, highlight.color),
            created_at=highlight.created_at,
            updated_at=highlight.updated_at,
            author_user_id=highlight.author_user_id,
            is_owner=highlight.is_owner,
        )
        _add_passage_item(state.passage_groups, locus_ref, resolution, item)
        state.represented_facts[locus_ref].append(item)


def _add_generated_citations(
    state: _ProjectionState,
    *,
    connections: list[ReaderConnectionRow],
    message_meta: dict[UUID, _MessageMeta],
    note_meta: dict[UUID, _NoteMeta],
    media_id: UUID,
    page_count: int | None,
    fragment_indexes: dict[str, int],
) -> tuple[set[tuple[UUID, str]], set[UUID]]:
    authored_chat_loci: set[tuple[UUID, str]] = set()
    consumed_edge_ids: set[UUID] = set()
    for row in connections:
        if row.connection.origin != "citation" or row.connection.ordinal is None:
            continue
        source_object = _object_for_endpoint(
            row.connection.source,
            message_meta=message_meta,
            note_meta=note_meta,
        )
        if source_object is None:
            state.omitted_counts["unreadable_related_object"] += 1
            consumed_edge_ids.add(row.connection.edge_id)
            continue
        locus_ref = _matched_ref(row)
        snapshot = row.connection.citation.snapshot if row.connection.citation else {}
        snapshot_title = snapshot.get("title") if isinstance(snapshot, dict) else None
        snapshot_excerpt = snapshot.get("excerpt") if isinstance(snapshot, dict) else None
        label = (
            str(snapshot_title).strip()
            if isinstance(snapshot_title, str) and snapshot_title.strip()
            else f"Cited by {source_object.label}"
        )
        excerpt = (
            str(snapshot_excerpt).strip()
            if isinstance(snapshot_excerpt, str) and snapshot_excerpt.strip()
            else row.excerpt
        )
        item = ReaderEvidenceGeneratedCitationOut(
            id=f"generated-citation:{row.connection.edge_id}",
            label=label,
            excerpt=present(excerpt) if excerpt else absent(),
            associations=[ReaderEvidenceAuthoredInOut(object=source_object)],
            edge_id=row.connection.edge_id,
            role=row.connection.kind,
        )
        _place_item(
            state.passage_groups,
            state.document_items,
            media_id=media_id,
            locus_ref=locus_ref,
            resolution=_resolution_for_connection(
                row,
                media_id=media_id,
                fragment_indexes=fragment_indexes,
                page_count=page_count,
            ),
            item=item,
        )
        if isinstance(source_object, ReaderEvidenceChatObjectOut):
            authored_chat_loci.add((source_object.conversation_id, locus_ref))
        consumed_edge_ids.add(row.connection.edge_id)
    return authored_chat_loci, consumed_edge_ids


def _add_synapses(
    state: _ProjectionState,
    *,
    connections: list[ReaderConnectionRow],
    consumed_edge_ids: set[UUID],
    message_meta: dict[UUID, _MessageMeta],
    note_meta: dict[UUID, _NoteMeta],
    media_id: UUID,
    page_count: int | None,
    fragment_indexes: dict[str, int],
) -> None:
    for row in connections:
        if row.connection.edge_id in consumed_edge_ids:
            continue
        if row.connection.origin == "document_embed":
            state.omitted_counts["document_embed_graph_duplicate"] += 1
            continue
        if row.connection.origin != "synapse":
            continue
        related = _object_for_endpoint(
            _other_endpoint(row),
            message_meta=message_meta,
            note_meta=note_meta,
        )
        if related is None:
            state.omitted_counts["unreadable_related_object"] += 1
            consumed_edge_ids.add(row.connection.edge_id)
            continue
        item = ReaderEvidenceSynapseOut(
            id=f"synapse:{row.connection.edge_id}",
            label=row.title or "Synapse",
            excerpt=present(row.excerpt) if row.excerpt else absent(),
            edge_id=row.connection.edge_id,
            role=row.connection.kind,
            rationale=row.excerpt or "Related by Synapse",
            object=related,
        )
        _place_item(
            state.passage_groups,
            state.document_items,
            media_id=media_id,
            locus_ref=_matched_ref(row),
            resolution=_resolution_for_connection(
                row,
                media_id=media_id,
                fragment_indexes=fragment_indexes,
                page_count=page_count,
            ),
            item=item,
        )
        consumed_edge_ids.add(row.connection.edge_id)


def _add_remaining_connections(
    state: _ProjectionState,
    *,
    connections: list[ReaderConnectionRow],
    consumed_edge_ids: set[UUID],
    authored_chat_loci: set[tuple[UUID, str]],
    message_meta: dict[UUID, _MessageMeta],
    note_meta: dict[UUID, _NoteMeta],
    media_id: UUID,
    page_count: int | None,
    fragment_indexes: dict[str, int],
) -> None:
    # Only loci with an independently represented fact can honestly own an
    # AlsoReferences association. A graph edge at an otherwise empty locus is
    # itself a Link fact.
    association_loci = set(state.passage_groups)
    for row in connections:
        if row.connection.edge_id in consumed_edge_ids or row.connection.origin == "document_embed":
            continue
        locus_ref = _matched_ref(row)
        related = _object_for_endpoint(
            _other_endpoint(row),
            message_meta=message_meta,
            note_meta=note_meta,
        )
        if related is None:
            state.omitted_counts["unreadable_related_object"] += 1
            continue
        if _is_companion_chat_edge(
            row=row,
            related=related,
            locus_ref=locus_ref,
            authored_chat_loci=authored_chat_loci,
        ):
            state.omitted_counts["coalesced_chat_context"] += 1
            continue
        represented = state.represented_facts.get(locus_ref, [])
        if represented:
            association = ReaderEvidenceDirectlyAttachedOut(
                object=related,
                edge_id=row.connection.edge_id,
                role=row.connection.kind,
                origin=row.connection.origin,
                direction="Incoming" if row.connection.direction == "incoming" else "Outgoing",
            )
            for fact in represented:
                _add_item_association(fact, association)
            continue

        resolution = _resolution_for_connection(
            row,
            media_id=media_id,
            fragment_indexes=fragment_indexes,
            page_count=page_count,
        )
        if (
            locus_ref != f"media:{media_id}"
            and locus_ref in association_loci
            and row.connection.kind == "context"
        ):
            _add_group_association(
                _ensure_group(state.passage_groups, locus_ref, resolution),
                ReaderEvidenceAlsoReferenceOut(object=related),
            )
            continue

        _place_item(
            state.passage_groups,
            state.document_items,
            media_id=media_id,
            locus_ref=locus_ref,
            resolution=resolution,
            item=ReaderEvidenceLinkOut(
                id=f"link:{row.connection.edge_id}",
                label=row.title or related.label,
                excerpt=present(row.excerpt) if row.excerpt else absent(),
                edge_id=row.connection.edge_id,
                role=row.connection.kind,
                origin=row.connection.origin,
                object=related,
            ),
        )


def _load_related_metadata(
    db: Session,
    *,
    viewer_id: UUID,
    rows: list[ReaderConnectionRow],
) -> tuple[dict[UUID, _MessageMeta], dict[UUID, _NoteMeta]]:
    endpoints = [
        endpoint
        for row in rows
        for endpoint in (row.connection.source, row.connection.target)
        if not endpoint.missing
    ]
    message_ids = sorted(
        {endpoint.id for endpoint in endpoints if endpoint.scheme == "message"}, key=str
    )
    note_ids = sorted(
        {endpoint.id for endpoint in endpoints if endpoint.scheme == "note_block"}, key=str
    )
    messages: dict[UUID, _MessageMeta] = {}
    if message_ids:
        records = db.execute(
            text(
                """
                SELECT m.id, m.conversation_id, c.title
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                WHERE m.id = ANY(:ids)
                  AND m.status != 'pending'
                """
            ),
            {"ids": message_ids},
        ).all()
        messages = {
            UUID(str(row[0])): _MessageMeta(
                conversation_id=UUID(str(row[1])),
                conversation_title=str(row[2] or "Untitled conversation"),
            )
            for row in records
        }
    notes: dict[UUID, _NoteMeta] = {}
    if note_ids:
        records = db.execute(
            text(
                """
                SELECT id, body_pm_json, body_text
                FROM note_blocks
                WHERE id = ANY(:ids) AND user_id = :viewer_id
                """
            ),
            {"ids": note_ids, "viewer_id": viewer_id},
        ).all()
        notes = {
            UUID(str(row[0])): _NoteMeta(
                body_pm_json=dict(row[1]),
                body_text=str(row[2] or ""),
            )
            for row in records
        }
    return messages, notes


def _compose_apparatus(
    *,
    media_id: UUID,
    page_count: int | None,
    apparatus_items: list[ReaderApparatusItemOut],
    apparatus_edges: list[ReaderApparatusEdgeOut],
    fragment_indexes: dict[str, int],
    groups: dict[str, _PassageAccumulator],
    represented_facts: dict[str, list[ReaderEvidenceItemOut]],
) -> None:
    by_key = {item.stable_key: item for item in apparatus_items}
    outgoing: dict[str, list[ReaderApparatusEdgeOut]] = defaultdict(list)
    targeted_keys: set[str] = set()
    for edge in sorted(apparatus_edges, key=lambda value: value.sort_key):
        if edge.relation not in _APPARATUS_FORWARD_RELATIONS:
            continue
        outgoing[edge.from_stable_key].append(edge)
        targeted_keys.add(edge.to_stable_key)

    owners = [
        item
        for item in apparatus_items
        if item.kind.endswith("_ref") or item.stable_key in outgoing
    ]
    owner_keys = {item.stable_key for item in owners}
    owners.extend(
        item
        for item in apparatus_items
        if item.stable_key not in owner_keys and item.stable_key not in targeted_keys
    )
    owners.sort(key=lambda item: item.sort_key)

    for owner in owners:
        target_keys = list(
            dict.fromkeys(
                edge.to_stable_key
                for edge in outgoing.get(owner.stable_key, [])
                if edge.to_stable_key in by_key
            )
        )
        targets = [by_key[target_key] for target_key in target_keys]
        target_out: list[ReaderEvidenceSourceTargetOut] = []
        for target in targets:
            target_resolution = _apparatus_resolution(
                target,
                media_id=media_id,
                fragment_indexes=fragment_indexes,
                page_count=page_count,
            )
            target_out.append(
                ReaderEvidenceSourceTargetOut(
                    ref=target.resource_ref,
                    stable_key=target.stable_key,
                    apparatus_kind=cast(ReaderApparatusItemKind, target.kind),
                    label=present(target.label) if target.label else absent(),
                    body=present(target.body_text) if target.body_text else absent(),
                    activation=_apparatus_activation(
                        media_id,
                        target,
                        resolution=target_resolution,
                    ),
                    resolution=target_resolution,
                )
            )
        target_label = next((target.label for target in targets if target.label), None)
        target_body = next((target.body_text for target in targets if target.body_text), None)
        label = owner.label or target_label or "Source reference"
        excerpt = owner.body_text or target_body
        item = ReaderEvidenceSourceReferenceOut(
            id=f"source-reference:{owner.stable_key}",
            label=label,
            excerpt=present(excerpt) if excerpt else absent(),
            stable_key=owner.stable_key,
            apparatus_kind=cast(ReaderApparatusItemKind, owner.kind),
            confidence=cast(ReaderApparatusConfidence, owner.confidence),
            targets=target_out,
        )
        resolution = _apparatus_resolution(
            owner,
            media_id=media_id,
            fragment_indexes=fragment_indexes,
            page_count=page_count,
        )
        _add_passage_item(groups, owner.resource_ref, resolution, item)
        represented_facts[owner.resource_ref].append(item)
        for target in targets:
            represented_facts[target.resource_ref].append(item)


def _apparatus_activation(
    media_id: UUID,
    target: ReaderApparatusItemOut,
    *,
    resolution: ReaderEvidenceResolutionOut,
) -> ResourceActivationOut:
    """Route a target already proven visible by the enclosing apparatus read."""

    href = route_for_visible_apparatus_item(
        media_id=media_id,
        item_id=target.id,
        stable_key=target.stable_key,
        locator_present=target.locator is not None,
        locator_status=target.locator_status,
        locator_current=isinstance(resolution, ReaderEvidenceResolvedOut),
    )
    if href is None:
        return ResourceActivationOut(
            resource_ref=target.resource_ref,
            kind="none",
            href=None,
            unresolved_reason="not_routeable",
        )
    return ResourceActivationOut(
        resource_ref=target.resource_ref,
        kind="route",
        href=href,
        unresolved_reason=None,
    )


def _apparatus_resolution(
    item: ReaderApparatusItemOut,
    *,
    media_id: UUID,
    fragment_indexes: dict[str, int],
    page_count: int | None,
) -> ReaderEvidenceResolutionOut:
    locator = locator_json(item.locator)
    if locator is None:
        return ReaderEvidenceUnavailableOut(
            reason="Missing",
            sort_order_key=item.sort_key,
        )
    if not locator_is_current_for_media(
        locator,
        media_id=media_id,
        fragment_indexes=fragment_indexes,
        page_count=page_count,
    ):
        return ReaderEvidenceUnavailableOut(
            reason="Stale",
            sort_order_key=item.sort_key,
        )
    return _resolved(
        locator=locator,
        order_key=order_key_from_locator(locator, fragment_indexes) or item.sort_key,
    )


def _object_for_endpoint(
    endpoint: ConnectionEndpointOut,
    *,
    message_meta: dict[UUID, _MessageMeta],
    note_meta: dict[UUID, _NoteMeta],
) -> ReaderEvidenceObjectOut | None:
    if endpoint.missing:
        return None
    label = endpoint.label or endpoint.ref
    excerpt = present(endpoint.description) if endpoint.description else absent()
    if endpoint.scheme == "message":
        meta = message_meta.get(endpoint.id)
        if meta is None:
            return None
        return ReaderEvidenceChatObjectOut(
            ref=endpoint.ref,
            label=meta.conversation_title,
            excerpt=absent(),
            activation=endpoint.activation,
            conversation_id=meta.conversation_id,
            message_ref=present(endpoint.ref),
        )
    if endpoint.scheme == "conversation":
        return ReaderEvidenceChatObjectOut(
            ref=endpoint.ref,
            label=label,
            excerpt=excerpt,
            activation=endpoint.activation,
            conversation_id=endpoint.id,
            message_ref=absent(),
        )
    if endpoint.scheme == "note_block":
        meta = note_meta.get(endpoint.id)
        if meta is None:
            return None
        return ReaderEvidenceNoteObjectOut(
            ref=endpoint.ref,
            label=meta.body_text or label,
            excerpt=present(meta.body_text) if meta.body_text else excerpt,
            activation=endpoint.activation,
            note_block_id=endpoint.id,
            body_pm_json=meta.body_pm_json,
        )
    common = {
        "ref": endpoint.ref,
        "label": label,
        "excerpt": excerpt,
        "activation": endpoint.activation,
    }
    if endpoint.scheme in ("artifact", "artifact_revision"):
        return ReaderEvidenceDossierObjectOut(**common)
    if endpoint.scheme == "oracle_reading":
        return ReaderEvidenceOracleObjectOut(**common)
    if endpoint.scheme == "media":
        return ReaderEvidenceMediaObjectOut(**common)
    return ReaderEvidenceOtherObjectOut(**common)


def _matched_ref(row: ReaderConnectionRow) -> str:
    return (
        row.connection.target_ref
        if row.connection.direction == "incoming"
        else row.connection.source_ref
    )


def _other_endpoint(row: ReaderConnectionRow) -> ConnectionEndpointOut:
    return (
        row.connection.source if row.connection.direction == "incoming" else row.connection.target
    )


def _resolution_for_connection(
    row: ReaderConnectionRow,
    *,
    media_id: UUID,
    fragment_indexes: dict[str, int],
    page_count: int | None,
) -> ReaderEvidenceResolutionOut:
    if row.anchor is not None and row.anchor.locator is not None:
        locator = locator_json(row.anchor.locator)
        if locator is not None:
            order_key = (
                order_key_from_locator(locator, fragment_indexes)
                or row.anchor.order_key
                or _matched_ref(row)
            )
            try:
                resolved = _resolved(
                    locator=locator,
                    order_key=order_key,
                )
            except ValidationError:
                pass
            else:
                if not locator_is_current_for_media(
                    locator,
                    media_id=media_id,
                    fragment_indexes=fragment_indexes,
                    page_count=page_count,
                ):
                    return ReaderEvidenceUnavailableOut(
                        reason="Stale",
                        sort_order_key=row.anchor.order_key,
                    )
                return resolved
    order_key = (
        row.connection.target_order_key
        if row.connection.direction == "incoming"
        else row.connection.source_order_key
    )
    reason: ReaderEvidenceUnavailableReason = "Unanchorable"
    if row.connection.citation is not None:
        match row.connection.citation.target_status:
            case "missing" | "forbidden":
                reason = "Missing"
            case "current" | "unanchorable":
                reason = "Unanchorable"
            case unexpected:
                assert_never(unexpected)
    return ReaderEvidenceUnavailableOut(
        reason=reason,
        sort_order_key=order_key,
    )


def _resolved(
    *,
    locator: dict[str, object],
    order_key: str,
) -> ReaderEvidenceResolvedOut:
    return ReaderEvidenceResolvedOut(
        anchor=ReaderEvidenceAnchorOut(locator=locator),
        order_key=order_key,
    )


def _place_item(
    groups: dict[str, _PassageAccumulator],
    document_items: list[ReaderEvidenceItemOut],
    *,
    media_id: UUID,
    locus_ref: str,
    resolution: ReaderEvidenceResolutionOut,
    item: ReaderEvidenceItemOut,
) -> None:
    if locus_ref == f"media:{media_id}":
        document_items.append(item)
        return
    _add_passage_item(groups, locus_ref, resolution, item)


def _add_passage_item(
    groups: dict[str, _PassageAccumulator],
    locus_ref: str,
    resolution: ReaderEvidenceResolutionOut,
    item: ReaderEvidenceItemOut,
) -> None:
    group = _ensure_group(groups, locus_ref, resolution)
    if all(existing.id != item.id for existing in group.items):
        group.items.append(item)


def _ensure_group(
    groups: dict[str, _PassageAccumulator],
    locus_ref: str,
    resolution: ReaderEvidenceResolutionOut,
) -> _PassageAccumulator:
    group = groups.get(locus_ref)
    if group is None:
        group = _PassageAccumulator(locus_ref=locus_ref, resolution=resolution)
        groups[locus_ref] = group
    elif isinstance(group.resolution, ReaderEvidenceUnavailableOut) and isinstance(
        resolution, ReaderEvidenceResolvedOut
    ):
        group.resolution = resolution
    return group


def _add_item_association(
    item: ReaderEvidenceItemOut,
    association: ReaderEvidenceAssociationOut,
) -> None:
    key = _item_association_key(association)
    if all(_item_association_key(value) != key for value in item.associations):
        item.associations.append(association)


def _item_association_key(
    association: ReaderEvidenceAssociationOut,
) -> tuple[str, str, UUID | None]:
    edge_id = (
        association.edge_id if isinstance(association, ReaderEvidenceDirectlyAttachedOut) else None
    )
    return (association.relationship, association.object.ref, edge_id)


def _add_group_association(
    group: _PassageAccumulator,
    association: ReaderEvidenceAlsoReferenceOut,
) -> None:
    key = (association.relationship, association.object.ref)
    if all((value.relationship, value.object.ref) != key for value in group.also_references):
        group.also_references.append(association)


def _is_companion_chat_edge(
    *,
    row: ReaderConnectionRow,
    related: ReaderEvidenceObjectOut,
    locus_ref: str,
    authored_chat_loci: set[tuple[UUID, str]],
) -> bool:
    return (
        isinstance(related, ReaderEvidenceChatObjectOut)
        and row.connection.kind == "context"
        and row.connection.source_ref == f"conversation:{related.conversation_id}"
        and row.connection.target_ref == locus_ref
        and (related.conversation_id, locus_ref) in authored_chat_loci
        and related.message_ref.kind == "Absent"
    )


def _finalize_groups(
    groups: dict[str, _PassageAccumulator],
) -> list[ReaderEvidencePassageGroupOut]:
    out: list[ReaderEvidencePassageGroupOut] = []
    for group in groups.values():
        group.items.sort(key=_item_sort_key)
        group.also_references.sort(
            key=lambda association: (
                association.object.label.casefold(),
                association.object.ref,
            )
        )
        for item in group.items:
            item.associations.sort(
                key=lambda association: (
                    association.relationship,
                    association.object.label.casefold(),
                    association.object.ref,
                )
            )
        out.append(
            ReaderEvidencePassageGroupOut(
                locus_ref=group.locus_ref,
                resolution=group.resolution,
                target_excerpt=_target_excerpt(group),
                items=group.items,
                also_references=group.also_references,
            )
        )
    out.sort(key=_group_sort_key)
    return out


def _group_sort_key(group: ReaderEvidencePassageGroupOut) -> tuple[int, str, str]:
    if isinstance(group.resolution, ReaderEvidenceResolvedOut):
        return (0, group.resolution.order_key, group.locus_ref)
    if group.resolution.sort_order_key is not None:
        return (1, group.resolution.sort_order_key, group.locus_ref)
    return (2, group.locus_ref, group.locus_ref)


def _target_excerpt(group: _PassageAccumulator) -> Presence[str]:
    if isinstance(group.resolution, ReaderEvidenceResolvedOut):
        locator = locator_json(group.resolution.anchor.locator)
        if locator is not None:
            selector = locator.get("text_quote_selector")
            if isinstance(selector, dict):
                exact = selector.get("exact")
                if isinstance(exact, str) and exact.strip():
                    return present(exact)
            exact = locator.get("exact")
            if isinstance(exact, str) and exact.strip():
                return present(exact)
    highlight = next(
        (item for item in group.items if isinstance(item, ReaderEvidenceHighlightOut)),
        None,
    )
    if highlight is not None and highlight.quote.strip():
        return present(highlight.quote)
    source_reference = next(
        (item for item in group.items if isinstance(item, ReaderEvidenceSourceReferenceOut)),
        None,
    )
    if source_reference is not None:
        if source_reference.apparatus_kind.endswith("_ref") and source_reference.label.strip():
            return present(source_reference.label)
        if source_reference.excerpt.kind == "Present" and source_reference.excerpt.value.strip():
            return present(source_reference.excerpt.value)
    return absent()


def _item_sort_key(item: ReaderEvidenceItemOut) -> tuple[int, str]:
    return (_ITEM_KIND_ORDER[item.kind], item.id)
