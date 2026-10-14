"""Outlines: the viewer's user links at a page or note, in that endpoint's own order.

A link (``origin = 'user'``) is graph-owned and undirected (``edges.create_link``). Each
endpoint ranks its own links (``resource_view_states.order_key``, dense ``%010d``);
unranked links follow, by creation. An outline is written by primitive commands applied
in order in one serializable transaction. Each primitive is idempotent, so a batch
whose outcome is unknown is resent unchanged:

- set_body, set_title: absolute, with an expected version; current == desired succeeds.
- ensure_daily: the date's page exists afterwards.
- insert_note, insert_resource: the client's link id already at the endpoint has landed.
- move: an absolute position. relink: its new link id at the destination has landed.
- remove: a missing link, or a note endpoint already deleted, has landed.

The place rule: a note's places are its user links, its annotations (``highlight_note``),
its link notes (``link_note``) and its citations. ``remove`` deletes the note it leaves
with no place (its ``expected_body_version``, when given, must still match) and the reply
names it in ``deleted``. Links are undirected, so "nothing holds it" is a degree test, and
only outline edits, which can be undone, delete; page delete and "Remove annotation" keep
notes. A link that carries a link note is refused by relink and remove (409).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import cast
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceVersion, ResourceViewState
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.notes import (
    EnsureDaily,
    InsertNote,
    InsertResource,
    Move,
    NoteContentOut,
    OutlineCommand,
    OutlineCommandsOut,
    OutlineLinkOut,
    OutlineNodeOut,
    OutlineOut,
    PageContentOut,
    Relink,
    Remove,
    ResourceContentOut,
    SetBody,
    SetTitle,
)
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import note_bodies, notes
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.routing import resource_activations_for_refs


@dataclass(slots=True)
class TreeNote:
    block: NoteBlock
    order_key: str
    children: list[TreeNote] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class PageNoteTree:
    page: Page
    roots: list[TreeNote]


def read(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> OutlineOut:
    _require_endpoint(db, viewer_id, ref)
    links = [edge for edge, _ in _ordered(db, viewer_id, ref)]
    nodes = _nodes(db, viewer_id, [ref, *(_other(edge, ref) for edge in links)])
    pairs = [edges.link_pair(edge) for edge in links]
    annotated = edges.link_note_blocks_for_pairs(db, viewer_id=viewer_id, pairs=pairs)
    return OutlineOut(
        source=nodes[0],
        links=[
            OutlineLinkOut(link_id=edge.id, has_link_note=pair in annotated, target=node)
            for edge, pair, node in zip(links, pairs, nodes[1:], strict=True)
        ],
    )


def execute(
    db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]
) -> OutlineCommandsOut:
    def op() -> OutlineCommandsOut:
        touched: dict[ResourceRef, None] = {}
        written: dict[ResourceRef, None] = {}
        for command in commands:
            refs = apply(db, viewer_id, command)
            (written if isinstance(command, SetBody | SetTitle) else touched).update(
                dict.fromkeys(refs)
            )
        outlines = [read(db, viewer_id=viewer_id, ref=ref) for ref in touched if _alive(db, ref)]
        nodes = _nodes(db, viewer_id, [ref for ref in written if _alive(db, ref)])
        deleted = [ref.uri for ref in touched if not _alive(db, ref)]
        db.commit()
        return OutlineCommandsOut(outlines=outlines, nodes=nodes, deleted=deleted)

    return retry_serializable(db, "outline_commands", op)


def apply(db: Session, viewer_id: UUID, command: OutlineCommand) -> list[ResourceRef]:
    """One primitive inside the caller's transaction; returns the endpoints (or, for a
    text write, the resource) it changed, and the notes it deleted."""
    match command:
        case SetBody():
            note_bodies.write_body(
                db,
                viewer_id=viewer_id,
                note_id=command.note_id,
                body_pm_json=command.body_pm_json,
                expected_version=command.expected_version,
                reason="note_body",
            )
            return [note_bodies.note_ref(command.note_id)]
        case SetTitle():
            notes.write_title(
                db,
                viewer_id=viewer_id,
                page_id=command.page_id,
                title=command.title,
                expected_version=command.expected_version,
            )
            return [notes.page_ref(command.page_id)]
        case EnsureDaily():
            return [notes.ensure_daily_page(db, viewer_id, command.local_date)]
        case InsertNote():
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            if _incident(db, viewer_id, endpoint, command.link_id) is None:
                note_bodies.ensure_note(
                    db,
                    viewer_id=viewer_id,
                    note_id=command.note_id,
                    body_pm_json=command.body_pm_json,
                    reason="outline_insert",
                )
                note = note_bodies.note_ref(command.note_id)
                link(db, viewer_id, endpoint, note, command.link_id, command.after)
            return [endpoint]
        case InsertResource():
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            if _incident(db, viewer_id, endpoint, command.link_id) is None:
                target = require_ref(command.target)
                link(db, viewer_id, endpoint, target, command.link_id, command.after)
            return [endpoint]
        case Move():
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            _require_incident(db, viewer_id, endpoint, command.link_id)
            _place(db, viewer_id, endpoint, command.link_id, command.after)
            return [endpoint]
        case Relink():
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            destination = _endpoint(db, viewer_id, command.destination)
            if _incident(db, viewer_id, destination, command.new_link_id) is None:
                edge = _require_incident(db, viewer_id, endpoint, command.link_id)
                edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
                target = _other(edge, endpoint)
                link(db, viewer_id, destination, target, command.new_link_id, command.after)
            return [endpoint, destination]
        case Remove():
            raw = require_ref(command.endpoint)
            if raw.scheme == "note_block" and db.get(NoteBlock, raw.id) is None:
                return [raw]  # deleted with its links (a resend after a parent's remove)
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            edge = _incident(db, viewer_id, endpoint, command.link_id)
            if edge is None:
                return [endpoint]
            target = _other(edge, endpoint)
            edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
            if target.scheme == "note_block" and not _has_places(db, viewer_id, target):
                if command.expected_body_version is not None:
                    note_bodies.require_version(
                        db,
                        viewer_id=viewer_id,
                        note_id=target.id,
                        version=command.expected_body_version,
                    )
                note_bodies.delete_note(db, viewer_id=viewer_id, note_id=target.id)
                return [endpoint, target]
            return [endpoint]


def link(
    db: Session,
    viewer_id: UUID,
    endpoint: ResourceRef,
    target: ResourceRef,
    link_id: UUID,
    after: UUID | None,
) -> None:
    """Link ``endpoint`` to ``target`` under the client's ``link_id``, placed after ``after``
    (None: first). The pair already linked, or the id taken, is 409."""
    if db.get(ResourceEdge, link_id) is not None:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Link id is taken")
    write = edges.create_link(
        db, viewer_id=viewer_id, source=endpoint, target=target, link_id=link_id
    )
    if not write.created:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "These are already linked")
    _place(db, viewer_id, endpoint, link_id, after)


def last_link_id(db: Session, viewer_id: UUID, endpoint: ResourceRef) -> UUID | None:
    links = _ordered(db, viewer_id, endpoint)
    return links[-1][0].id if links else None


def latent_daily_outline(*, page_id: UUID, local_date: date, title: str) -> OutlineOut:
    """A day before its first write: its page's future id, the default title, no links."""
    ref = notes.page_ref(page_id)
    href = f"/daily/{local_date.isoformat()}"
    return OutlineOut(
        source=OutlineNodeOut(
            ref=ref.uri,
            label=title,
            summary=title,
            missing=False,
            activation=ResourceActivationOut(resource_ref=ref.uri, kind="route", href=href),
            content=PageContentOut(
                kind="page", title=title, title_version=1, daily_date=local_date
            ),
        ),
        links=[],
    )


def page_note_tree(db: Session, *, viewer_id: UUID, page_id: UUID) -> PageNoteTree:
    """The page's notes depth-first in outline order, each note once (dossier input)."""
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    seen: set[UUID] = set()

    def children(endpoint: ResourceRef) -> list[TreeNote]:
        out: list[TreeNote] = []
        for edge, order_key in _ordered(db, viewer_id, endpoint):
            other = _other(edge, endpoint)
            block = db.get(NoteBlock, other.id) if other.scheme == "note_block" else None
            if block is None or block.user_id != viewer_id or block.id in seen:
                continue
            seen.add(block.id)
            out.append(TreeNote(block=block, order_key=order_key or "", children=children(other)))
        return out

    return PageNoteTree(page=page, roots=children(notes.page_ref(page_id)))


def _place(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, link_id: UUID, after: UUID | None
) -> None:
    current = [edge for edge, _ in _ordered(db, viewer_id, endpoint)]
    ids = [edge.id for edge in current if edge.id != link_id]
    if after is not None and after not in ids:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Position is not in this outline")
    ids.insert(0 if after is None else ids.index(after) + 1, link_id)
    if [edge.id for edge in current] == ids:
        return
    states = {
        state.edge_id: state
        for state in db.scalars(
            select(ResourceViewState).where(
                ResourceViewState.user_id == viewer_id,
                ResourceViewState.surface_scheme == endpoint.scheme,
                ResourceViewState.surface_id == endpoint.id,
                ResourceViewState.edge_id.in_(ids),
            )
        )
    }
    for edge in current:
        if edge.id not in states:
            other = _other(edge, endpoint)
            states[edge.id] = ResourceViewState(
                user_id=viewer_id,
                surface_scheme=endpoint.scheme,
                surface_id=endpoint.id,
                edge_id=edge.id,
                target_scheme=other.scheme,
                target_id=other.id,
                state={},
            )
            db.add(states[edge.id])
        states[edge.id].order_key = f"moving:{edge.id}"
    db.flush()
    for index, edge_id in enumerate(ids, start=1):
        states[edge_id].order_key = f"{index:010d}"
    db.flush()
    versions.bump_version(db, viewer_id=viewer_id, ref=endpoint, lane="links")


def _ordered(
    db: Session, viewer_id: UUID, endpoint: ResourceRef
) -> list[tuple[ResourceEdge, str | None]]:
    rows = db.execute(
        select(ResourceEdge, ResourceViewState.order_key)
        .outerjoin(
            ResourceViewState,
            (ResourceViewState.edge_id == ResourceEdge.id)
            & (ResourceViewState.user_id == viewer_id)
            & (ResourceViewState.surface_scheme == endpoint.scheme)
            & (ResourceViewState.surface_id == endpoint.id),
        )
        .where(*_incident_to(viewer_id, endpoint))
        .order_by(
            ResourceViewState.order_key.asc().nulls_last(),
            ResourceEdge.created_at,
            ResourceEdge.id,
        )
    )
    return [(edge, order_key) for edge, order_key in rows]


def _incident_to(viewer_id: UUID, endpoint: ResourceRef):
    return (
        ResourceEdge.user_id == viewer_id,
        ResourceEdge.origin == "user",
        or_(edges.source_is(endpoint), edges.target_is(endpoint)),
    )


def _incident(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, link_id: UUID
) -> ResourceEdge | None:
    return db.scalar(
        select(ResourceEdge).where(ResourceEdge.id == link_id, *_incident_to(viewer_id, endpoint))
    )


def _require_incident(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, link_id: UUID
) -> ResourceEdge:
    edge = _incident(db, viewer_id, endpoint, link_id)
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Link not found in this outline")
    return edge


def _other(edge: ResourceEdge, endpoint: ResourceRef) -> ResourceRef:
    if (edge.source_scheme, edge.source_id) == (endpoint.scheme, endpoint.id):
        return ResourceRef(scheme=cast(ResourceScheme, edge.target_scheme), id=edge.target_id)
    return ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id)


def _has_places(db: Session, viewer_id: UUID, note: ResourceRef) -> bool:
    return _place_counts(db, viewer_id, [note.id]).get(note.id, 0) > 0


def _place_counts(db: Session, viewer_id: UUID, note_ids: Sequence[UUID]) -> dict[UUID, int]:
    """Per note: its user links, annotations, link notes and citations."""
    counts: dict[UUID, int] = {}
    if not note_ids:
        return counts
    by_target = (
        select(ResourceEdge.target_id, func.count())
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id.in_(note_ids),
            ResourceEdge.origin.in_(("user", "highlight_note", "citation")),
        )
        .group_by(ResourceEdge.target_id)
    )
    by_source = (
        select(ResourceEdge.source_id, func.count())
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.source_scheme == "note_block",
            ResourceEdge.source_id.in_(note_ids),
            ResourceEdge.origin.in_(("user", "link_note")),
        )
        .group_by(ResourceEdge.source_id)
    )
    for query in (by_target, by_source):
        for note_id, count in db.execute(query):
            counts[note_id] = counts.get(note_id, 0) + count
    return counts


def _endpoint(db: Session, viewer_id: UUID, raw: str) -> ResourceRef:
    ref = require_ref(raw)
    _require_endpoint(db, viewer_id, ref)
    return ref


def _require_endpoint(db: Session, viewer_id: UUID, ref: ResourceRef) -> None:
    if not capability(ref.scheme).adjacency_source:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Only pages and notes outline")
    assert_ref_visible(db, viewer_id=viewer_id, ref=ref)


def _alive(db: Session, ref: ResourceRef) -> bool:
    return db.get(NoteBlock if ref.scheme == "note_block" else Page, ref.id) is not None


def _nodes(db: Session, viewer_id: UUID, refs: Sequence[ResourceRef]) -> list[OutlineNodeOut]:
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=refs)
    missing = {ref.uri for ref, item in zip(refs, resolved, strict=True) if item.missing}
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=refs, missing_ref_uris=missing
    )
    note_ids = [ref.id for ref in refs if ref.scheme == "note_block" and ref.uri not in missing]
    page_ids = [ref.id for ref in refs if ref.scheme == "page" and ref.uri not in missing]
    bodies = {
        block.id: block
        for block in db.scalars(
            select(NoteBlock).where(NoteBlock.user_id == viewer_id, NoteBlock.id.in_(note_ids))
        )
    }
    pages = notes.page_facts(db, viewer_id, page_ids)
    lanes = {
        (row.resource_id, row.lane): row.version
        for row in db.scalars(
            select(ResourceVersion).where(
                ResourceVersion.user_id == viewer_id,
                ResourceVersion.resource_id.in_([*note_ids, *page_ids]),
                ResourceVersion.lane.in_(("body", "title")),
            )
        )
    }
    places = _place_counts(db, viewer_id, note_ids)
    out: list[OutlineNodeOut] = []
    for ref, item in zip(refs, resolved, strict=True):
        body, page = bodies.get(ref.id), pages.get(ref.id)
        content: NoteContentOut | PageContentOut | ResourceContentOut
        if body is not None:
            content = NoteContentOut(
                kind="note",
                body_pm_json=body.body_pm_json,
                body_text=body.body_text,
                body_version=lanes.get((ref.id, "body"), 1),
                places=places.get(ref.id, 0),
            )
        elif page is not None:
            content = PageContentOut(
                kind="page",
                title=page.title,
                title_version=lanes.get((ref.id, "title"), 1),
                daily_date=page.daily_date,
            )
        else:
            content = ResourceContentOut(kind="resource")
        out.append(
            OutlineNodeOut(
                ref=ref.uri,
                label=item.label,
                summary=item.summary,
                missing=item.missing,
                activation=activations[ref.uri],
                content=content,
            )
        )
    return out
