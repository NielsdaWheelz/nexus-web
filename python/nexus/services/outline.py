"""Mixed endpoint adjacency and atomic resource insertion commands.

Every command batch is serializable. Minted user-link ids are recognized before
source materialization or placement. Retries return stored canonical endpoints;
duplicate unordered pairs never move; require_created refuses a pair held by another
id. Unlink-only batches deduplicate exact ids with the strictest annotation precondition,
preserve all resource content, and acknowledge with empty arrays. Missing unlink ids
are unchanged; foreign or unsupported origins refuse and roll back every effect.
Structural remove and strict consume use complete graph retention; a batch cannot
delete a note named by any of its set_body commands. Relink preserves its
user-link and annotation guards and recognizes its replacement id first; null
position appends at commit, a concrete position fences the destination.
Version proofs check transaction-start values; far endpoints a command bumps are
reported, never scanned for. Replies carry outlines and links facts for the lanes the
batch moved or checked and, unchecked, for those a no-op command names (I14).
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
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    NoteBlock,
    Page,
    ResourceEdge,
    ResourceVersion,
    ResourceViewState,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.notes import (
    ConsumeNote,
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
from nexus.services.resource_graph import connections, edges, links, order, retention
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


@dataclass(slots=True)
class Applied:
    """What one batch did: the reply is built from this only when a client asked."""

    checked: dict[ResourceRef, int | None] = field(default_factory=dict)
    outlined: dict[ResourceRef, None] = field(default_factory=dict)
    written: dict[ResourceRef, None] = field(default_factory=dict)
    insertions: list[tuple[bool, UUID, ResourceRef]] = field(default_factory=list)
    unlink_only: bool = False


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
    return OutlineOut(
        source=nodes[0],
        insertion_source=links.insertion_source_for_ref(db, viewer_id=viewer_id, ref=ref),
        links_version=version,
        items=items,
        next_cursor=next_cursor,
    )


def execute(
    db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]
) -> OutlineCommandsOut:
    def op() -> OutlineCommandsOut:
        applied = apply_in_current_transaction(db, viewer_id=viewer_id, commands=commands)
        result = _reply(db, viewer_id, applied)
        db.commit()
        return result

    return retry_serializable(db, "outline_commands", op)


def apply_in_current_transaction(
    db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]
) -> Applied:
    """Apply one complete batch, flush only; the caller owns commit, retry and any reply."""
    unlinks: dict[UUID, bool] = {}
    edits = [command for command in commands if not isinstance(command, Unlink)]
    for command in commands:
        if isinstance(command, Unlink):
            unlinks[command.link_id] = unlinks.get(command.link_id, False) or (
                command.require_unannotated
            )
    if unlinks and edits:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unlink commands cannot be mixed with other commands"
        )
    if unlinks:
        changed = [
            links.unlink_in_txn(db, viewer_id=viewer_id, link_id=id_, require_unannotated=strict)
            for id_, strict in unlinks.items()
        ]
        if any(changed):
            record_input_change(db)
        return Applied(unlink_only=True)
    if any(isinstance(command, Move) for command in edits) and len(edits) != 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Move must be the only command")
    lanes = [
        ("body", command.note_id) if isinstance(command, SetBody) else ("title", command.page_id)
        for command in edits
        if isinstance(command, SetBody | SetTitle)
    ]
    if len(lanes) != len(set(lanes)):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Only one final write per lane")
    edited_notes = {command.note_id for command in edits if isinstance(command, SetBody)}

    versions.collect_bumped_links(db)
    out = Applied()
    minted: dict[UUID, frozenset[edges.Pair]] = {}
    created_daily: set[ResourceRef] = set()

    def touch(ref: ResourceRef) -> None:
        out.outlined[ref] = None
        out.checked.setdefault(ref, None)

    def check(ref: ResourceRef, expected: int) -> None:
        base = versions.links_at_batch_start(db, viewer_id, ref)
        if base != expected:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Outline version changed")
        out.checked[ref] = base

    def held(id_: UUID) -> ResourceEdge | None:
        row = db.get(ResourceEdge, id_)
        if row is not None and (row.user_id != viewer_id or row.origin != "user"):
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Link id is taken")
        return row

    for index, command in enumerate(edits):
        match command:
            case InsertNote() | InsertLink():
                row = held(command.link_id)
                if row is not None:
                    source = require_ref(f"{row.source_scheme}:{row.source_id}")
                    target = require_ref(f"{row.target_scheme}:{row.target_id}")
                    write = edges.EdgeWrite(edges.edge_out(row), True)
                    out.checked[source] = out.checked[target] = None
                else:
                    source, created_source = links.materialize_source(
                        db, viewer_id=viewer_id, source=command.source
                    )
                    if created_source:
                        out.checked[source] = 1
                        if source.scheme == "page":
                            created_daily.add(source)
                    if isinstance(command, InsertNote):
                        target = note_bodies.note_ref(command.note_id)
                        if not note_bodies.note_exists(
                            db, viewer_id=viewer_id, note_id=command.note_id
                        ):
                            out.checked[target] = 1
                        note_bodies.ensure_note(
                            db,
                            viewer_id=viewer_id,
                            note_id=command.note_id,
                            body_pm_json=command.body_pm_json,
                            reason="outline_insert",
                        )
                    else:
                        target = links.materialize_link_endpoint(
                            db, viewer_id=viewer_id, endpoint=command.target
                        )
                    _require_endpoint(db, viewer_id, source)
                    assert_ref_visible(db, viewer_id=viewer_id, ref=target)
                    pair = edges.existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
                    if pair is not None:
                        if isinstance(command, InsertLink) and command.require_created:
                            raise ConflictError(
                                ApiErrorCode.E_RESOURCE_CONFLICT,
                                "These resources are already linked",
                            )
                        if any(_depends_on(later, command.link_id) for later in edits[index + 1 :]):
                            raise ConflictError(
                                ApiErrorCode.E_RESOURCE_CONFLICT,
                                "Dependent command requires its minted link",
                            )
                        write = edges.EdgeWrite(edges.edge_out(pair), False)
                    else:
                        if command.position is not None:
                            check(source, command.position.expected_links_version)
                            after = command.position.after
                            if after is not None and after not in [
                                edge.id for edge, _ in order.ordered(db, viewer_id, source)
                            ]:
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
                    minted[command.link_id] = edges.link_pair(write.edge)
                for ref in (write.edge.source, write.edge.target):
                    touch(ref)
                    if ref.scheme == "note_block":
                        out.written[ref] = None
                out.insertions.append(
                    (write.created or write.edge.id == command.link_id, write.edge.id, source)
                )
            case Move():
                endpoint = _endpoint(db, viewer_id, command.endpoint)
                current, desired = order.desired(
                    db, viewer_id, endpoint, command.edge_id, command.after
                )
                if [edge.id for edge in current] != desired:
                    check(endpoint, command.expected_links_version)
                    order.place(db, viewer_id, endpoint, command.edge_id, command.after)
                touch(endpoint)
            case Relink():
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
                    edge = _incident(db, viewer_id, endpoint, command.link_id)
                    if edge is None:
                        raise NotFoundError(
                            ApiErrorCode.E_NOT_FOUND, "Link not found in this outline"
                        )
                    target = _other(edge, endpoint)
                    check(endpoint, command.expected_source_links_version)
                    if command.position is not None:
                        check(destination, command.position.expected_links_version)
                    if edges.existing_link_pair(db, viewer_id=viewer_id, a=destination, b=target):
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
                    if command.position is not None:
                        order.place(
                            db, viewer_id, destination, write.edge.id, command.position.after
                        )
                    for ref in (endpoint, destination, target):
                        touch(ref)
                minted_edge = held(command.new_link_id)
                assert minted_edge is not None  # justify-defect: created or recognized above
                minted[command.new_link_id] = edges.link_pair(minted_edge)
            case EnsureDaily():
                created = db.get(Page, command.page_id) is None
                ref = notes.ensure_daily_page(db, viewer_id, command.local_date, command.page_id)
                touch(ref)
                if created:
                    out.checked[ref] = 1
                    created_daily.add(ref)
            case SetBody():
                note_bodies.write_body(
                    db,
                    viewer_id=viewer_id,
                    note_id=command.note_id,
                    body_pm_json=command.body_pm_json,
                    expected_version=command.expected_version,
                    reason="note_body",
                )
                out.written[note_bodies.note_ref(command.note_id)] = None
            case SetTitle():
                notes.write_title(
                    db,
                    viewer_id=viewer_id,
                    page_id=command.page_id,
                    title=command.title,
                    expected_version=command.expected_version,
                )
                out.written[notes.page_ref(command.page_id)] = None
            case Remove() | ConsumeNote():
                if command.link_id in minted:
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Minted links must survive their batch"
                    )
                for ref in _remove(db, viewer_id, command, edited_notes):
                    touch(ref)
            case _:
                assert_never(command)
    for ref in created_daily:
        if not any(edge.origin == "user" for edge, _ in order.ordered(db, viewer_id, ref)):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Add an item to save this day"
            )
    for id_, pair in minted.items():
        survivor = held(id_)
        if survivor is None or edges.link_pair(survivor) != pair:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Minted links must survive their batch"
            )
    # Body writes (embed edges) and deletion bump far endpoints the commands do not name.
    for ref in versions.bumped_links(db, viewer_id):
        touch(ref)
    record_input_change(db)
    return out


def _reply(db: Session, viewer_id: UUID, applied: Applied) -> OutlineCommandsOut:
    if applied.unlink_only:
        return OutlineCommandsOut(
            outlines=[], nodes=[], deleted=[], insertions=[], link_versions=[]
        )
    refs = [*applied.outlined, *(ref for ref in applied.written if ref not in applied.outlined)]
    visible = {
        item.ref
        for item in resource_items_out(db, viewer_id=viewer_id, refs=refs)
        if not item.missing
    }
    rows = [db.get(ResourceEdge, edge_id) for _, edge_id, _ in applied.insertions]
    present = [row for row in rows if row is not None]
    if len(present) != len(rows):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Insertion results must survive their batch"
        )
    hydrated = connections.hydrate_connections(
        db, viewer_id, present, {(row.source_scheme, row.source_id) for row in present}, "both"
    )
    return OutlineCommandsOut(
        outlines=[
            read(db, viewer_id=viewer_id, ref=ref) for ref in applied.outlined if ref.uri in visible
        ],
        nodes=_nodes(db, viewer_id, [ref for ref in applied.written if ref.uri in visible]),
        deleted=[
            ref.uri
            for ref in applied.outlined
            if ref.scheme == "note_block" and db.get(NoteBlock, ref.id) is None
        ],
        insertions=[
            InsertionOut(
                created=created,
                connection=connection.model_copy(
                    update={
                        "other": connection.target
                        if connection.source.ref == source.uri
                        else connection.source
                    }
                ),
            )
            for (created, _, source), connection in zip(applied.insertions, hydrated, strict=True)
        ],
        link_versions=[
            LinkVersionOut(
                ref=ref.uri,
                checked_from_version=applied.checked.get(ref),
                links_version=versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref).get(
                    "links", 1
                ),
            )
            for ref in applied.outlined
            if ref.uri in visible
        ],
    )


def _depends_on(command: OutlineCommand, link_id: UUID) -> bool:
    match command:
        case InsertLink() | InsertNote():
            return command.link_id == link_id or (
                command.position is not None and command.position.after == link_id
            )
        case Move():
            return command.edge_id == link_id or command.after == link_id
        case Relink():
            return link_id in (command.link_id, command.new_link_id) or (
                command.position is not None and command.position.after == link_id
            )
        case Remove() | Unlink() | ConsumeNote():
            return command.link_id == link_id
        case _:
            return False


def _remove(
    db: Session, viewer_id: UUID, command: Remove | ConsumeNote, edited_notes: set[UUID]
) -> list[ResourceRef]:
    """Structural removal; the note goes only when nothing else retains it. Flush-only."""
    raw = require_ref(command.endpoint)
    if raw.scheme == "note_block" and db.get(NoteBlock, raw.id) is None:
        return [raw]
    endpoint = _endpoint(db, viewer_id, command.endpoint)
    edge = _incident(db, viewer_id, endpoint, command.link_id)
    if edge is None:
        return [endpoint]
    target = _other(edge, endpoint)
    if target.scheme != "note_block":
        if isinstance(command, ConsumeNote):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Only a note can be consumed")
        edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
        return [endpoint, target]
    block = db.scalar(
        select(NoteBlock)
        .where(NoteBlock.id == target.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if block is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
    retained = retention.has_retainer(db, block.user_id, target, excluding_edge_ids=[edge.id])
    if retained and isinstance(command, ConsumeNote):
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "This note is retained elsewhere and cannot be consumed",
        )
    if not retained:
        if target.id in edited_notes:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "A batch cannot delete a note it edits"
            )
        if command.expected_body_version is None:
            raise ConflictError(
                ApiErrorCode.E_NOTE_CONFLICT, "Deleting a note requires its body version"
            )
        note_bodies.require_version(
            db, viewer_id=viewer_id, note_id=target.id, version=command.expected_body_version
        )
    edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
    if not retained:
        note_bodies.delete_note(db, viewer_id=viewer_id, note_id=target.id)
    return [endpoint, target]


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
        insertion_source=None,
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
        for edge, order_key in order.ordered(db, viewer_id, endpoint):
            other = _other(edge, endpoint)
            if edge.origin != "user" or other.scheme != "note_block":
                continue
            block = db.get(NoteBlock, other.id)
            if block is None or block.user_id != viewer_id or block.id in seen:
                continue
            seen.add(block.id)
            out.append(TreeNote(block=block, order_key=order_key or "", children=children(other)))
        return out

    return PageNoteTree(page=page, roots=children(notes.page_ref(page_id)))


def _incident(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, link_id: UUID
) -> ResourceEdge | None:
    return db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.id == link_id,
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "user",
            or_(edges.source_is(endpoint), edges.target_is(endpoint)),
        )
    )


def _other(edge: ResourceEdge, endpoint: ResourceRef) -> ResourceRef:
    if (edge.source_scheme, edge.source_id) == (endpoint.scheme, endpoint.id):
        return ResourceRef(scheme=cast(ResourceScheme, edge.target_scheme), id=edge.target_id)
    return ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id)


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
    live = [ref for ref in refs if ref.uri not in missing]
    note_ids = [ref.id for ref in live if ref.scheme == "note_block"]
    page_ids = [ref.id for ref in live if ref.scheme == "page"]
    bodies = note_bodies.read_notes(db, viewer_id=viewer_id, note_ids=note_ids)
    pages = notes.page_facts(db, viewer_id, page_ids)
    titles = {
        row.resource_id: row.version
        for row in db.scalars(
            select(ResourceVersion).where(
                ResourceVersion.user_id == viewer_id,
                ResourceVersion.resource_id.in_(page_ids),
                ResourceVersion.lane == "title",
            )
        )
    }
    places = retention.retainer_counts(
        db, viewer_id, [note_bodies.note_ref(note_id) for note_id in note_ids]
    )
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
                places=places.get(ref, 0),
            )
        elif page is not None:
            content = PageContentOut(
                kind="page",
                title=page.title,
                title_version=titles.get(ref.id, 1),
                daily_date=page.daily_date,
            )
        else:
            content = ResourceContentOut(kind="resource")
        out.append(OutlineNodeOut(item=item, content=content))
    return out
