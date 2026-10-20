"""Mixed endpoint adjacency and atomic resource insertion commands.

Every command batch is serializable. Minted user-link ids are recognized before
source materialization or placement. Retries return stored canonical endpoints;
duplicate unordered pairs never move. Unlink preserves content and annotations.
Structural remove/relink retain their narrower user-link and annotation guards.
Display ranks cover all facts; page-note traversal and place counts stay user-only.
Version proofs validate transaction-start preconditions, never predicted increments.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import assert_never, cast
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceVersion, ResourceViewState
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.notes import (
    EnsureDaily,
    InsertionOut,
    InsertLink,
    InsertNote,
    LinkVersionOut,
    Move,
    NoteContentOut,
    OutlineCommand,
    OutlineCommandsOut,
    OutlineNodeOut,
    OutlineOccurrenceOut,
    OutlineOut,
    PageContentOut,
    Relink,
    Remove,
    ResourceContentOut,
    SetBody,
    SetTitle,
    Unlink,
)
from nexus.schemas.resource_items import (
    NamedResourceBodyOut,
    ResourceActivationOut,
    ResourceItemOut,
    ResourcePreviewOut,
)
from nexus.services import note_bodies, notes
from nexus.services.resource_graph import connections, edges, links, order
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out
from nexus.services.suggestion_changes import record_input_change

_CURSOR = TypeAdapter(tuple[UUID, str, int, str | None, datetime, UUID])


@dataclass(slots=True)
class TreeNote:
    block: NoteBlock
    order_key: str
    children: list[TreeNote] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class PageNoteTree:
    page: Page
    roots: list[TreeNote]


def read(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, limit: int = 100, cursor: str | None = None
) -> OutlineOut:
    _require_endpoint(db, viewer_id, ref)
    version = versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref).get("links", 1)
    stmt = order.statement(viewer_id, ref)
    if cursor is not None:
        try:
            owner, endpoint, base, rank, created_at, edge_id = _CURSOR.validate_json(
                base64.urlsafe_b64decode(cursor)
            )
            if owner != viewer_id or endpoint != ref.uri:
                raise ValueError
        except (ValueError, TypeError, ValidationError):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Invalid outline cursor"
            ) from None
        if base != version:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Outline changed; refresh page one"
            )
        tail = or_(
            ResourceEdge.created_at > created_at,
            and_(ResourceEdge.created_at == created_at, ResourceEdge.id > edge_id),
        )
        if rank is None:
            stmt = stmt.where(ResourceViewState.order_key.is_(None), tail)
        else:
            stmt = stmt.where(
                or_(
                    ResourceViewState.order_key.is_(None),
                    ResourceViewState.order_key > rank,
                    and_(ResourceViewState.order_key == rank, tail),
                )
            )
    rows = list(db.execute(stmt.limit(limit + 1)).tuples())
    page = rows[:limit]
    hydrated = connections.hydrate_connections(
        db, viewer_id, [edge for edge, _ in page], {(ref.scheme, ref.id)}, "both"
    )
    nodes = _nodes(db, viewer_id, [ref, *(require_ref(item.other.ref) for item in hydrated)])
    items = [
        OutlineOccurrenceOut(
            connection=connection,
            content=ResourceContentOut(kind="resource")
            if connection.ordinal is not None and connection.other.ref == connection.target.ref
            else node.content,
        )
        for connection, node in zip(hydrated, nodes[1:], strict=True)
    ]
    next_cursor = None
    if len(rows) > limit:
        edge, rank = page[-1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps(
                [str(viewer_id), ref.uri, version, rank, edge.created_at.isoformat(), str(edge.id)]
            ).encode()
        ).decode()
    return OutlineOut(source=nodes[0], links_version=version, items=items, next_cursor=next_cursor)


def execute(
    db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]
) -> OutlineCommandsOut:
    if any(isinstance(command, Move) for command in commands) and len(commands) != 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Move must be the only command")
    lanes: set[tuple[str, UUID]] = set()
    for command in commands:
        lane = (
            ("body", command.note_id)
            if isinstance(command, SetBody)
            else (("title", command.page_id) if isinstance(command, SetTitle) else None)
        )
        if lane is not None:
            if lane in lanes:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Only one final write per lane"
                )
            lanes.add(lane)

    def op() -> OutlineCommandsOut:
        starts = {
            (row.resource_scheme, row.resource_id): row.version
            for row in db.scalars(
                select(ResourceVersion).where(
                    ResourceVersion.user_id == viewer_id, ResourceVersion.lane == "links"
                )
            )
        }
        checked: dict[ResourceRef, int | None] = {}
        touched: dict[ResourceRef, None] = {}
        written: dict[ResourceRef, None] = {}
        insertion_edges: list[tuple[bool, UUID]] = []
        minted: set[UUID] = set()
        minted_pairs: dict[UUID, frozenset[edges.Pair]] = {}

        def touch(ref: ResourceRef) -> None:
            touched[ref] = None
            checked.setdefault(ref, None)

        def check(ref: ResourceRef, expected: int) -> None:
            base = starts.get((ref.scheme, ref.id), 1)
            if base != expected:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Outline version changed")
            checked[ref] = base

        def held(id_: UUID) -> ResourceEdge | None:
            row = db.get(ResourceEdge, id_)
            if row is not None and (row.user_id != viewer_id or row.origin != "user"):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Link id is taken")
            return row

        for index, command in enumerate(commands):
            if isinstance(command, InsertNote | InsertLink):
                row = held(command.link_id)
                if row is not None:
                    source = require_ref(f"{row.source_scheme}:{row.source_id}")
                    target = require_ref(f"{row.target_scheme}:{row.target_id}")
                    write = edges.EdgeWrite(edges.edge_out(row), True)
                    checked[source] = checked[target] = None
                else:
                    source, created_source = links.materialize_source(
                        db, viewer_id=viewer_id, source=command.source
                    )
                    if created_source:
                        checked[source] = 1
                    if isinstance(command, InsertNote):
                        exists = note_bodies.note_exists(
                            db, viewer_id=viewer_id, note_id=command.note_id
                        )
                        note_bodies.ensure_note(
                            db,
                            viewer_id=viewer_id,
                            note_id=command.note_id,
                            body_pm_json=command.body_pm_json,
                            reason="outline_insert",
                        )
                        target = note_bodies.note_ref(command.note_id)
                        if not exists:
                            checked[target] = 1
                    else:
                        target = links.materialize_link_endpoint(
                            db, viewer_id=viewer_id, endpoint=command.target
                        )
                    _require_endpoint(db, viewer_id, source)
                    assert_ref_visible(db, viewer_id=viewer_id, ref=target)
                    pair = edges.existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
                    if pair is not None:
                        write = edges.EdgeWrite(edges.edge_out(pair), False)
                        if any(
                            _depends_on_link(later, command.link_id)
                            for later in commands[index + 1 :]
                        ):
                            raise ConflictError(
                                ApiErrorCode.E_RESOURCE_CONFLICT,
                                "Dependent command requires its minted link",
                            )
                    else:
                        if command.position is not None:
                            check(source, command.position.expected_links_version)
                            if (
                                command.position.after is not None
                                and command.position.after
                                not in [edge.id for edge, _ in order.ordered(db, viewer_id, source)]
                            ):
                                raise ConflictError(
                                    ApiErrorCode.E_RESOURCE_CONFLICT,
                                    "Position is not in this outline",
                                )
                        write = edges.create_link(
                            db,
                            viewer_id=viewer_id,
                            source=source,
                            target=target,
                            link_id=command.link_id,
                        )
                        if command.position is not None:
                            order.place(
                                db, viewer_id, source, write.edge.id, command.position.after
                            )
                if write.edge.id == command.link_id:
                    minted.add(command.link_id)
                    minted_pairs[command.link_id] = edges.link_pair(write.edge)
                for ref in (write.edge.source, write.edge.target):
                    touch(ref)
                    if ref.scheme == "note_block":
                        written[ref] = None
                insertion_edges.append(
                    (write.created or write.edge.id == command.link_id, write.edge.id)
                )
            elif isinstance(command, Move):
                endpoint = _endpoint(db, viewer_id, command.endpoint)
                current, desired = order.desired(
                    db, viewer_id, endpoint, command.edge_id, command.after
                )
                if [edge.id for edge in current] != desired:
                    check(endpoint, command.expected_links_version)
                    order.place(db, viewer_id, endpoint, command.edge_id, command.after)
                touch(endpoint)
            elif isinstance(command, Unlink):
                if command.link_id in minted:
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Minted links must survive their batch"
                    )
                for ref in links.unlink(db, viewer_id=viewer_id, link_id=command.link_id):
                    touch(ref)
            elif isinstance(command, Relink):
                if command.link_id in minted:
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT,
                        "Minted links cannot be relinked in their batch",
                    )
                row = held(command.new_link_id)
                if row is not None:
                    for raw in (
                        f"{row.source_scheme}:{row.source_id}",
                        f"{row.target_scheme}:{row.target_id}",
                    ):
                        touch(require_ref(raw))
                else:
                    endpoint = _endpoint(db, viewer_id, command.endpoint)
                    destination = _endpoint(db, viewer_id, command.destination)
                    edge = _require_incident(db, viewer_id, endpoint, command.link_id)
                    target = _other(edge, endpoint)
                    check(endpoint, command.expected_source_links_version)
                    check(destination, command.expected_destination_links_version)
                    if (
                        edges.existing_link_pair(db, viewer_id=viewer_id, a=destination, b=target)
                        is not None
                    ):
                        raise ConflictError(
                            ApiErrorCode.E_RESOURCE_CONFLICT, "Relink destination is already linked"
                        )
                    edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
                    write = edges.create_link(
                        db,
                        viewer_id=viewer_id,
                        source=destination,
                        target=target,
                        link_id=command.new_link_id,
                    )
                    order.place(db, viewer_id, destination, write.edge.id, command.after)
                    for ref in (endpoint, destination, target):
                        touch(ref)
                minted.add(command.new_link_id)
                minted_edge = held(command.new_link_id)
                assert minted_edge is not None
                minted_pairs[command.new_link_id] = edges.link_pair(minted_edge)
            elif isinstance(command, EnsureDaily):
                daily = notes.read_daily_page(db, viewer_id, command.local_date)
                ref = notes.ensure_daily_page(db, viewer_id, command.local_date)
                touch(ref)
                if not daily.materialized:
                    checked[ref] = 1
            else:
                if isinstance(command, Remove) and command.link_id in minted:
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Minted links must survive their batch"
                    )
                refs = _apply(db, viewer_id, command)
                for ref in refs:
                    touch(ref)
                if isinstance(command, SetBody | SetTitle):
                    written.update(dict.fromkeys(refs))
        for id_ in minted:
            survivor = held(id_)
            if survivor is None or edges.link_pair(survivor) != minted_pairs[id_]:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Minted links must survive their batch"
                )
        # Body writes and structural deletion may affect far endpoints not named by
        # the primitive. Compare actual lanes against their transaction-start values.
        for row in db.scalars(
            select(ResourceVersion).where(
                ResourceVersion.user_id == viewer_id, ResourceVersion.lane == "links"
            )
        ):
            if row.version != starts.get((row.resource_scheme, row.resource_id), 1):
                touch(require_ref(f"{row.resource_scheme}:{row.resource_id}"))
        visible = {
            item.ref
            for item in resource_items_out(db, viewer_id=viewer_id, refs=list(touched))
            if not item.missing
        }
        outlines = [read(db, viewer_id=viewer_id, ref=ref) for ref in touched if ref.uri in visible]
        nodes = _nodes(db, viewer_id, [ref for ref in written if ref.uri in visible])
        insertion_rows = [db.get(ResourceEdge, edge_id) for _, edge_id in insertion_edges]
        if any(row is None for row in insertion_rows):
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Insertion results must survive their batch"
            )
        insertion_connections = connections.hydrate_connections(
            db,
            viewer_id,
            [row for row in insertion_rows if row is not None],
            {(row.source_scheme, row.source_id) for row in insertion_rows if row is not None},
            "both",
        )
        insertions = [
            InsertionOut(created=created, connection=connection)
            for (created, _), connection in zip(insertion_edges, insertion_connections, strict=True)
        ]
        result = OutlineCommandsOut(
            outlines=outlines,
            nodes=nodes,
            deleted=[
                ref.uri
                for ref in touched
                if ref.scheme == "note_block" and db.get(NoteBlock, ref.id) is None
            ],
            insertions=insertions,
            link_versions=[
                LinkVersionOut(
                    ref=ref.uri,
                    checked_from_version=checked.get(ref),
                    links_version=versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref).get(
                        "links", 1
                    ),
                )
                for ref in touched
                if ref.uri in visible
            ],
        )
        record_input_change(db)
        db.commit()
        return result

    return retry_serializable(db, "outline_commands", op)


def _depends_on_link(command: OutlineCommand, link_id: UUID) -> bool:
    match command:
        case InsertLink() | InsertNote():
            return command.link_id == link_id or (
                command.position is not None and command.position.after == link_id
            )
        case Move():
            return command.edge_id == link_id or command.after == link_id
        case Relink():
            return link_id in (command.link_id, command.new_link_id, command.after)
        case Remove() | Unlink():
            return command.link_id == link_id
        case _:
            return False


def _apply(db: Session, viewer_id: UUID, command: SetBody | SetTitle | Remove) -> list[ResourceRef]:
    """Retained prose/daily and guarded destructive primitives, flush-only."""
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
        case Remove():
            raw = require_ref(command.endpoint)
            if raw.scheme == "note_block" and db.get(NoteBlock, raw.id) is None:
                return [raw]
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            edge = _incident(db, viewer_id, endpoint, command.link_id)
            if edge is None:
                return [endpoint]
            target = _other(edge, endpoint)
            edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
            if target.scheme == "note_block" and not _has_places(db, viewer_id, target):
                if command.expected_body_version is None:
                    raise ConflictError(
                        ApiErrorCode.E_NOTE_CONFLICT, "Deleting a note requires its body version"
                    )
                note_bodies.require_version(
                    db,
                    viewer_id=viewer_id,
                    note_id=target.id,
                    version=command.expected_body_version,
                )
                note_bodies.delete_note(db, viewer_id=viewer_id, note_id=target.id)
                return [endpoint, target]
            return [endpoint, target]
        case _:
            assert_never(command)


def latent_daily_outline(*, page_id: UUID, local_date: date, title: str) -> OutlineOut:
    """A day before its first write: its page's future id, the default title, no links."""
    ref = notes.page_ref(page_id)
    href = f"/daily/{local_date.isoformat()}"
    return OutlineOut(
        source=OutlineNodeOut(
            item=ResourceItemOut(
                ref=ref.uri,
                action_ref=ref.uri,
                label=title,
                preview=ResourcePreviewOut(
                    body=NamedResourceBodyOut(title=title, media_kind=None, contributors=None),
                    source=None,
                    annotation=None,
                ),
                missing=False,
                activation=ResourceActivationOut(resource_ref=ref.uri, kind="route", href=href),
            ),
            content=PageContentOut(
                kind="page", title=title, title_version=1, daily_date=local_date
            ),
        ),
        links_version=1,
        items=[],
        next_cursor=None,
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
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot host an outline")
    assert_ref_visible(db, viewer_id=viewer_id, ref=ref)


def _nodes(db: Session, viewer_id: UUID, refs: Sequence[ResourceRef]) -> list[OutlineNodeOut]:
    resolved = resource_items_out(db, viewer_id=viewer_id, refs=refs)
    missing = {item.ref for item in resolved if item.missing}
    note_ids = [ref.id for ref in refs if ref.scheme == "note_block" and ref.uri not in missing]
    page_ids = [ref.id for ref in refs if ref.scheme == "page" and ref.uri not in missing]
    bodies = note_bodies.read_notes(db, viewer_id=viewer_id, note_ids=note_ids)
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
                body_version=body.body_version,
                embedded_item=body.embedded_item,
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
                item=item,
                content=content,
            )
        )
    return out
