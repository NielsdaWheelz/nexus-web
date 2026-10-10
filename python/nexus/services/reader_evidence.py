"""Canonical Reader Evidence fact, occurrence and association projection."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal, cast
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.highlights import HIGHLIGHT_COLORS, FragmentAnchorOut, TypedHighlightOut
from nexus.schemas.media import DocumentEmbedOut
from nexus.schemas.presence import Presence, absent, present
from nexus.schemas.reader_apparatus import (
    ReaderApparatusConfidence,
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
    ReaderEvidenceGeneratedCitationOut,
    ReaderEvidenceHighlightOut,
    ReaderEvidenceItemOut,
    ReaderEvidenceLinkOut,
    ReaderEvidenceMachineLinkOut,
    ReaderEvidenceNoteObjectOut,
    ReaderEvidenceObjectOut,
    ReaderEvidenceOut,
    ReaderEvidencePassageGroupOut,
    ReaderEvidencePlainObjectOut,
    ReaderEvidenceResolutionOut,
    ReaderEvidenceResolvedOut,
    ReaderEvidenceSourceReferenceOut,
    ReaderEvidenceSourceTargetOut,
    ReaderEvidenceUnavailableOut,
    ReaderEvidenceUnavailableReason,
    ReaderSourceHtmlOut,
    ReaderSourceTextOut,
    ReaderSourceUnavailableOut,
)
from nexus.schemas.resource_graph import (
    ConnectionEndpointOut,
)
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.reader_connections import ReaderConnectionRow
from nexus.services.reader_evidence_markers import build_markers
from nexus.services.reader_locations import (
    highlight_locator,
    locator_is_current_for_media,
    locator_json,
    order_key_from_locator,
)
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.resource_items.routing import route_for_visible_apparatus_item

_APPARATUS_FORWARD_RELATIONS = frozenset(
    {
        "points_to_note",
        "points_to_endnote",
        "points_to_sidenote",
        "points_to_margin_note",
        "cites_bibliography_entry",
    }
)
_ITEM_KIND_ORDER = {
    "Highlight": 0,
    "SourceReference": 1,
    "GeneratedCitation": 2,
    "Link": 3,
    "MachineLink": 4,
}
_PLAIN_OBJECT_KINDS: dict[str, Literal["Dossier", "Oracle", "Media", "Other"]] = {
    "artifact": "Dossier",
    "artifact_revision": "Dossier",
    "oracle_reading": "Oracle",
    "media": "Media",
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
class _Projection:
    """The five per-document invariants, bound once, plus what the passes accumulate."""

    media_id: UUID
    page_count: int | None
    media_kind: str
    source_targets: dict[str, ReaderEvidenceSourceTargetOut] = field(
        init=False, default_factory=dict
    )
    fragment_indexes: dict[str, int]
    message_meta: dict[UUID, _MessageMeta]
    note_meta: dict[UUID, _NoteMeta]
    groups: dict[str, _PassageAccumulator] = field(default_factory=dict)
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
    """Compose owner payloads into canonical Evidence semantics.

    The passes run in order and are not interchangeable: generated citations produce
    the consumed edges and authored chat loci the later passes read.
    """
    message_meta, note_meta = _load_related_metadata(db, viewer_id=viewer_id, rows=connections)
    ctx = _Projection(
        media_id=media_id,
        page_count=page_count,
        media_kind=media_kind,
        fragment_indexes=fragment_indexes,
        message_meta=message_meta,
        note_meta=note_meta,
    )

    _add_highlight_facts(ctx, highlights=highlights, media_kind=media_kind)
    if apparatus.status in ("ready", "partial"):
        _compose_apparatus(ctx, apparatus=apparatus)
    consumed_edge_ids = _add_generated_citations(ctx, connections=connections)
    _add_machine_links(ctx, connections=connections, consumed_edge_ids=consumed_edge_ids)
    _add_remaining_connections(
        ctx,
        connections=connections,
        consumed_edge_ids=consumed_edge_ids,
    )

    groups_out = _finalize_groups(ctx.groups)
    ctx.document_items.sort(key=_item_sort_key)
    markers = build_markers(
        media_id=media_id,
        embeds=embeds,
        groups=groups_out,
        fragment_ranges=fragment_ranges,
        total_fragment_chars=total_fragment_chars,
        page_count=page_count,
        pdf_page_heights=pdf_page_heights,
    )
    all_items = [item for group in groups_out for item in group.items] + ctx.document_items
    return ReaderEvidenceProjection(
        evidence=ReaderEvidenceOut(
            counts=ReaderEvidenceCountsOut(
                highlights=sum(item.kind == "Highlight" for item in all_items),
                citations=sum(
                    item.kind in ("SourceReference", "GeneratedCitation") for item in all_items
                ),
                links=sum(item.kind == "Link" for item in all_items),
                machine_links=sum(item.kind == "MachineLink" for item in all_items),
                passages=sum(len(group.items) for group in groups_out),
                document=len(ctx.document_items),
            ),
            source_targets=list(ctx.source_targets.values()),
            passage_groups=groups_out,
            document_items=ctx.document_items,
        ),
        markers=markers,
        omitted_item_counts=dict(sorted(ctx.omitted_counts.items())),
    )


def _add_highlight_facts(
    ctx: _Projection, *, highlights: list[TypedHighlightOut], media_kind: str
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
        item = ReaderEvidenceHighlightOut(
            associations=[],
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
        # A text highlight whose quote no longer resolves keeps its row, never a wrong place.
        unresolved = (
            isinstance(highlight.anchor, FragmentAnchorOut) and highlight.anchor.fragment_id is None
        )
        _place_item(
            ctx,
            locus_ref,
            ReaderEvidenceUnavailableOut(reason="Stale")
            if unresolved
            else _resolved(
                locator=locator,
                order_key=order_key_from_locator(locator, ctx.fragment_indexes) or locus_ref,
            ),
            item,
        )
        ctx.represented_facts[locus_ref].append(item)


def _compose_apparatus(ctx: _Projection, *, apparatus: ReaderApparatusResponse) -> None:
    """Every marker owns its targets; an untargeted target stands as its own row."""
    by_key = {item.stable_key: item for item in apparatus.items}
    outgoing: dict[str, list[str]] = defaultdict(list)
    targeted_keys: set[str] = set()
    for edge in sorted(apparatus.edges, key=lambda value: value.sort_key):
        if edge.relation not in _APPARATUS_FORWARD_RELATIONS:
            continue
        outgoing[edge.from_stable_key].append(edge.to_stable_key)
        targeted_keys.add(edge.to_stable_key)

    owners = [
        item
        for item in apparatus.items
        if item.kind.endswith("_ref") or item.stable_key in outgoing
    ]
    owner_keys = {item.stable_key for item in owners}
    owners.extend(
        item
        for item in apparatus.items
        if item.stable_key not in owner_keys and item.stable_key not in targeted_keys
    )
    owners.sort(key=lambda item: item.sort_key)

    for owner in owners:
        targets = [
            by_key[key]
            for key in dict.fromkeys(outgoing.get(owner.stable_key, []))
            if key in by_key
        ]
        if not targets and not owner.kind.endswith("_ref"):
            targets = [owner]
        for target in targets:
            if target.resource_ref in ctx.source_targets:
                continue
            resolution = _apparatus_resolution(ctx, target)
            if target.body_html_sanitized is not None:
                content = ReaderSourceHtmlOut(
                    html_sanitized=target.body_html_sanitized, text=target.body_text or ""
                )
            elif ctx.media_kind == "pdf" and target.body_text:
                content = ReaderSourceTextOut(text=target.body_text)
            else:
                content = ReaderSourceUnavailableOut()
            ctx.source_targets[target.resource_ref] = ReaderEvidenceSourceTargetOut(
                ref=target.resource_ref,
                stable_key=target.stable_key,
                apparatus_kind=target.kind,
                label=present(target.label) if target.label else absent(),
                content=content,
                activation=_apparatus_activation(ctx, target, resolution=resolution),
                resolution=resolution,
            )
        excerpt = next(
            (
                content.text[:240]
                for target in targets
                if isinstance(
                    content := ctx.source_targets[target.resource_ref].content,
                    (ReaderSourceHtmlOut, ReaderSourceTextOut),
                )
                and content.text
            ),
            None,
        )
        marker_anchor_id = owner.source_ref.get("marker_id")
        item = ReaderEvidenceSourceReferenceOut(
            associations=[],
            id=f"source-reference:{owner.stable_key}",
            label=owner.label
            or next((target.label for target in targets if target.label), None)
            or "Source reference",
            excerpt=present(excerpt) if excerpt else absent(),
            stable_key=owner.stable_key,
            apparatus_kind=cast(ReaderApparatusItemKind, owner.kind),
            confidence=cast(ReaderApparatusConfidence, owner.confidence),
            target_refs=[target.resource_ref for target in targets],
            marker_anchor_id=present(marker_anchor_id)
            if isinstance(marker_anchor_id, str) and marker_anchor_id.strip()
            else absent(),
        )
        _place_item(ctx, owner.resource_ref, _apparatus_resolution(ctx, owner), item)
        ctx.represented_facts[owner.resource_ref].append(item)
        for target in targets:
            ctx.represented_facts[target.resource_ref].append(item)


def _apparatus_activation(
    ctx: _Projection, target: ReaderApparatusItemOut, *, resolution: ReaderEvidenceResolutionOut
) -> ResourceActivationOut:
    """Route a target already proven visible by the enclosing apparatus read."""
    href = route_for_visible_apparatus_item(
        media_id=ctx.media_id,
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
        resource_ref=target.resource_ref, kind="route", href=href, unresolved_reason=None
    )


def _apparatus_resolution(
    ctx: _Projection, item: ReaderApparatusItemOut
) -> ReaderEvidenceResolutionOut:
    locator = locator_json(item.locator)
    if locator is None:
        return ReaderEvidenceUnavailableOut(reason="Missing", sort_order_key=item.sort_key)
    if not locator_is_current_for_media(
        locator,
        media_id=ctx.media_id,
        fragment_indexes=ctx.fragment_indexes,
        page_count=ctx.page_count,
    ):
        return ReaderEvidenceUnavailableOut(reason="Stale", sort_order_key=item.sort_key)
    return _resolved(
        locator=locator,
        order_key=order_key_from_locator(locator, ctx.fragment_indexes) or item.sort_key,
    )


def _add_generated_citations(
    ctx: _Projection, *, connections: list[ReaderConnectionRow]
) -> set[UUID]:
    consumed_edge_ids: set[UUID] = set()
    for row in connections:
        if row.connection.origin != "citation" or row.connection.ordinal is None:
            continue
        source_object = _object_for_endpoint(ctx, row.connection.source)
        if source_object is None:
            ctx.omitted_counts["unreadable_related_object"] += 1
            consumed_edge_ids.add(row.connection.edge_id)
            continue
        locus_ref = _matched_ref(row)
        snapshot = row.connection.snapshot
        title = (snapshot.title or "").strip() if snapshot else ""
        excerpt = ((snapshot.excerpt or "").strip() if snapshot else "") or row.excerpt
        item = ReaderEvidenceGeneratedCitationOut(
            id=f"generated-citation:{row.connection.edge_id}",
            label=title or f"Cited by {source_object.label}",
            excerpt=present(excerpt) if excerpt else absent(),
            associations=[ReaderEvidenceAuthoredInOut(object=source_object)],
            edge_id=row.connection.edge_id,
            creation=row.connection.creation,
            mutation=row.connection.mutation,
            role=row.connection.kind,
        )
        _place_item(ctx, locus_ref, _resolution_for_connection(ctx, row), item)
        consumed_edge_ids.add(row.connection.edge_id)
    return consumed_edge_ids


def _add_machine_links(
    ctx: _Projection, *, connections: list[ReaderConnectionRow], consumed_edge_ids: set[UUID]
) -> None:
    for row in connections:
        if row.connection.edge_id in consumed_edge_ids:
            continue
        if row.connection.origin == "document_embed":
            ctx.omitted_counts["document_embed_graph_duplicate"] += 1
            continue
        origin = row.connection.origin
        if origin != "discovery" and origin != "assistant":
            continue
        related = _object_for_endpoint(ctx, row.connection.other)
        if related is None:
            ctx.omitted_counts["unreadable_related_object"] += 1
            consumed_edge_ids.add(row.connection.edge_id)
            continue
        _place_item(
            ctx,
            _matched_ref(row),
            _resolution_for_connection(ctx, row),
            ReaderEvidenceMachineLinkOut(
                associations=[],
                id=f"machine_link:{row.connection.edge_id}",
                label=row.title or related.label,
                excerpt=present(row.excerpt) if row.excerpt else absent(),
                edge_id=row.connection.edge_id,
                creation=row.connection.creation,
                mutation=row.connection.mutation,
                role=row.connection.kind,
                rationale=row.excerpt,
                origin=origin,
                object=related,
            ),
        )
        consumed_edge_ids.add(row.connection.edge_id)


def _add_remaining_connections(
    ctx: _Projection,
    *,
    connections: list[ReaderConnectionRow],
    consumed_edge_ids: set[UUID],
) -> None:
    for row in connections:
        if row.connection.edge_id in consumed_edge_ids or row.connection.origin == "document_embed":
            continue
        locus_ref = _matched_ref(row)
        related = _object_for_endpoint(ctx, row.connection.other)
        if related is None:
            ctx.omitted_counts["unreadable_related_object"] += 1
            continue
        represented = ctx.represented_facts.get(locus_ref, [])
        # A user link is an independently editable fact with its own annotation.
        # Keep that row even when its local highlight already represents the locus.
        if represented and row.connection.origin != "user":
            association = ReaderEvidenceDirectlyAttachedOut(
                object=related,
                edge_id=row.connection.edge_id,
                creation=row.connection.creation,
                mutation=row.connection.mutation,
                role=row.connection.kind,
                origin=row.connection.origin,
                direction="Incoming" if row.connection.direction == "incoming" else "Outgoing",
            )
            key = _association_key(association)
            for fact in represented:
                if all(_association_key(value) != key for value in fact.associations):
                    fact.associations.append(association)
            continue

        resolution = _resolution_for_connection(ctx, row)
        _place_item(
            ctx,
            locus_ref,
            resolution,
            ReaderEvidenceLinkOut(
                associations=[],
                # A same-media Link surfaces one item per local endpoint; the
                # anchored locus keys each so the two rows never collide on id.
                id=f"link:{row.connection.edge_id}:anchor:{locus_ref}",
                label=row.title or related.label,
                excerpt=present(row.excerpt) if row.excerpt else absent(),
                edge_id=row.connection.edge_id,
                creation=row.connection.creation,
                mutation=row.connection.mutation,
                role=row.connection.kind,
                origin=row.connection.origin,
                object=related,
                link_note=row.connection.link_note if row.connection.origin == "user" else None,
            ),
        )


def _load_related_metadata(
    db: Session, *, viewer_id: UUID, rows: list[ReaderConnectionRow]
) -> tuple[dict[UUID, _MessageMeta], dict[UUID, _NoteMeta]]:
    endpoints = [
        assert_resource_ref(endpoint.ref)
        for row in rows
        for endpoint in (row.connection.source, row.connection.target)
        if not endpoint.missing
    ]
    message_ids = sorted({ref.id for ref in endpoints if ref.scheme == "message"}, key=str)
    note_ids = sorted(
        {ref.id for ref in endpoints if ref.scheme == "note_block"}
        | {
            row.connection.link_note.note_block_id
            for row in rows
            if row.connection.link_note is not None
        },
        key=str,
    )
    messages: dict[UUID, _MessageMeta] = {}
    if message_ids:
        messages = {
            UUID(str(row[0])): _MessageMeta(
                conversation_id=UUID(str(row[1])),
                conversation_title=str(row[2] or "Untitled conversation"),
            )
            for row in db.execute(
                text(
                    """
                    SELECT m.id, m.conversation_id, c.title
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.id = ANY(:ids) AND m.status != 'pending'
                    """
                ),
                {"ids": message_ids},
            ).all()
        }
    notes: dict[UUID, _NoteMeta] = {}
    if note_ids:
        notes = {
            UUID(str(row[0])): _NoteMeta(body_pm_json=dict(row[1]), body_text=str(row[2] or ""))
            for row in db.execute(
                text(
                    """
                    SELECT id, body_pm_json, body_text
                    FROM note_blocks
                    WHERE id = ANY(:ids) AND user_id = :viewer_id
                    """
                ),
                {"ids": note_ids, "viewer_id": viewer_id},
            ).all()
        }
    return messages, notes


def _object_for_endpoint(
    ctx: _Projection, endpoint: ConnectionEndpointOut
) -> ReaderEvidenceObjectOut | None:
    if endpoint.missing:
        return None
    ref = assert_resource_ref(endpoint.ref)
    label = endpoint.label or endpoint.ref
    excerpt = present(endpoint.description) if endpoint.description else absent()
    activation = endpoint.activation
    if ref.scheme == "message":
        meta = ctx.message_meta.get(ref.id)
        if meta is None:
            return None
        return ReaderEvidenceChatObjectOut(
            ref=endpoint.ref,
            label=meta.conversation_title,
            excerpt=absent(),
            activation=activation,
            conversation_id=meta.conversation_id,
            message_ref=present(endpoint.ref),
        )
    if ref.scheme == "conversation":
        return ReaderEvidenceChatObjectOut(
            ref=endpoint.ref,
            label=label,
            excerpt=excerpt,
            activation=activation,
            conversation_id=ref.id,
            message_ref=absent(),
        )
    if ref.scheme == "note_block":
        meta = ctx.note_meta.get(ref.id)
        if meta is None:
            return None
        return ReaderEvidenceNoteObjectOut(
            ref=endpoint.ref,
            label=meta.body_text or label,
            excerpt=present(meta.body_text) if meta.body_text else excerpt,
            activation=activation,
            note_block_id=ref.id,
            body_pm_json=meta.body_pm_json,
        )
    return ReaderEvidencePlainObjectOut(
        kind=_PLAIN_OBJECT_KINDS.get(ref.scheme, "Other"),
        ref=endpoint.ref,
        label=label,
        excerpt=excerpt,
        activation=activation,
    )


def _matched_ref(row: ReaderConnectionRow) -> str:
    # The connection already resolved which endpoint is the far object (``other``);
    # the matched locus is its opposite. Never re-derive the locus from storage
    # direction — a neutral Link is undirected, so ``other`` is the only authoritative
    # signal for which endpoint sits on this document.
    connection = row.connection
    if connection.other.ref == connection.target.ref:
        return connection.source.ref
    return connection.target.ref


def _resolution_for_connection(
    ctx: _Projection, row: ReaderConnectionRow
) -> ReaderEvidenceResolutionOut:
    if row.anchor is not None and row.anchor.locator is not None:
        locator = locator_json(row.anchor.locator)
        if locator is not None:
            try:
                resolved = _resolved(
                    locator=locator,
                    order_key=order_key_from_locator(locator, ctx.fragment_indexes)
                    or row.anchor.order_key
                    or _matched_ref(row),
                    passage_anchor_id=row.anchor.passage_anchor_id,
                )
            except ValidationError:
                pass
            else:
                if locator_is_current_for_media(
                    locator,
                    media_id=ctx.media_id,
                    fragment_indexes=ctx.fragment_indexes,
                    page_count=ctx.page_count,
                ):
                    return resolved
                return ReaderEvidenceUnavailableOut(
                    reason="Stale", sort_order_key=row.anchor.order_key
                )
    reason: ReaderEvidenceUnavailableReason = "Unanchorable"
    if row.connection.ordinal is not None and row.connection.target.missing:
        reason = "Missing"
    return ReaderEvidenceUnavailableOut(
        reason=reason,
        sort_order_key=None
        if row.connection.direction == "incoming"
        else row.connection.source_order_key,
    )


def _resolved(
    *, locator: dict[str, object], order_key: str, passage_anchor_id: UUID | None = None
) -> ReaderEvidenceResolvedOut:
    return ReaderEvidenceResolvedOut(
        anchor=ReaderEvidenceAnchorOut.model_validate(
            {"locator": locator, "passage_anchor_id": passage_anchor_id}
        ),
        order_key=order_key,
    )


def _place_item(
    ctx: _Projection,
    locus_ref: str,
    resolution: ReaderEvidenceResolutionOut,
    item: ReaderEvidenceItemOut,
) -> None:
    if locus_ref == f"media:{ctx.media_id}":
        ctx.document_items.append(item)
        return
    group = _ensure_group(ctx, locus_ref, resolution)
    if all(existing.id != item.id for existing in group.items):
        group.items.append(item)


def _ensure_group(
    ctx: _Projection, locus_ref: str, resolution: ReaderEvidenceResolutionOut
) -> _PassageAccumulator:
    group = ctx.groups.get(locus_ref)
    if group is None:
        group = _PassageAccumulator(locus_ref=locus_ref, resolution=resolution)
        ctx.groups[locus_ref] = group
    elif isinstance(group.resolution, ReaderEvidenceUnavailableOut) and isinstance(
        resolution, ReaderEvidenceResolvedOut
    ):
        group.resolution = resolution
    return group


def _association_key(
    association: ReaderEvidenceAssociationOut,
) -> tuple[str, str, UUID | None]:
    edge_id = (
        association.edge_id if isinstance(association, ReaderEvidenceDirectlyAttachedOut) else None
    )
    return (association.relationship, association.object.ref, edge_id)


def _finalize_groups(
    groups: dict[str, _PassageAccumulator],
) -> list[ReaderEvidencePassageGroupOut]:
    out: list[ReaderEvidencePassageGroupOut] = []
    for group in groups.values():
        group.items.sort(key=_item_sort_key)
        group.also_references.sort(
            key=lambda association: (association.object.label.casefold(), association.object.ref)
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
        locator = locator_json(group.resolution.anchor.locator) or {}
        selector = locator.get("text_quote_selector")
        candidates = [selector.get("exact") if isinstance(selector, dict) else None]
        candidates.append(locator.get("exact"))
        for exact in candidates:
            if isinstance(exact, str) and exact.strip():
                return present(exact)
    highlight = next(
        (item for item in group.items if isinstance(item, ReaderEvidenceHighlightOut)), None
    )
    if highlight is not None and highlight.quote.strip():
        return present(highlight.quote)
    reference = next(
        (item for item in group.items if isinstance(item, ReaderEvidenceSourceReferenceOut)), None
    )
    if reference is not None:
        if reference.apparatus_kind.endswith("_ref") and reference.label.strip():
            return present(reference.label)
        if reference.excerpt.kind == "Present" and reference.excerpt.value.strip():
            return present(reference.excerpt.value)
    return absent()


def _item_sort_key(item: ReaderEvidenceItemOut) -> tuple[int, str]:
    return (_ITEM_KIND_ORDER[item.kind], item.id)
