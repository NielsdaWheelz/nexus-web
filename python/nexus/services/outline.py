"""Mixed adjacency reads and atomic, lifetime-identified outline commands.

The serializable owner preflights the complete batch before applying commands.
Creates recognize their accepted identities before transient source/placement
checks; retired prerequisites refuse a mixed batch without a surviving subset.
No create can remint a retired id. Absolute body/title writes are unique per lane.
Structural consumption preserves complete retention/version guards.

Shared graph/version owners collect compact effects, including embed far ends
and cleanup. Checks use each lane's transaction baseline. Only a real check or
an exclusively created endpoint supplies causal proof; retries and equal-value
no-ops do not. The committing wrapper records input change once, last, only
when domain state changed. No mutation hydrates an outline or scans account lanes.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Sequence
from datetime import date, datetime
from typing import assert_never, cast
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceVersion, ResourceViewState
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.notes import (
    ConsumeNote,
    EnsureDaily,
    InsertLink,
    InsertNote,
    Move,
    NoteContentOut,
    OutlineCommand,
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
from nexus.schemas.writing import IdentityKind, WritingAck, WritingInsertion, WritingPlacement
from nexus.services import authored_identities, note_bodies, notes, writing
from nexus.services.resource_graph import connections, edges, links, order, retention
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, require_ref
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out
from nexus.services.suggestion_changes import record_input_change

_CURSOR = TypeAdapter(tuple[UUID, str, int, str | None, datetime, UUID])


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


def execute(db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]) -> WritingAck:
    def op() -> WritingAck:
        apply_in_current_transaction(db, viewer_id=viewer_id, commands=commands)
        result = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db, owners=writing.input_owners(db))
        return result

    return retry_serializable(db, "outline_commands", op)


def apply_in_current_transaction(
    db: Session, *, viewer_id: UUID, commands: Sequence[OutlineCommand]
) -> None:
    """Preflight the whole batch, then apply; the caller notifies and commits."""
    state = writing.effects(db)

    def check(ref: ResourceRef, expected: int) -> None:
        current = versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref).get("links", 1)
        key = (viewer_id, ref, "links")
        before, proof = state.lanes.get(key, (current, None))
        baseline = 1 if before is None and proof == 1 else current if before is None else before
        if baseline != expected:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Outline version changed")
        writing.lane(
            db, viewer_id=viewer_id, ref=ref, name="links", before=before, checked=expected
        )

    unlinks = [command for command in commands if isinstance(command, Unlink)]
    if unlinks and len(unlinks) != len(commands):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unlink commands cannot be mixed with other commands"
        )
    if any(isinstance(command, Move) for command in commands) and len(commands) != 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Move must be the only command")
    if unlinks:
        ids: set[UUID] = set()
        for command in unlinks:
            if command.expected is not None:
                known = authored_identities.recognize(
                    db, viewer_id=viewer_id, kind="link", id=command.link_id
                )
                row = (
                    None
                    if known is not None and known.deleted
                    else db.get(
                        ResourceEdge,
                        known.canonical.resource_id if known is not None else command.link_id,
                    )
                )
                if row is not None:
                    endpoint = require_ref(command.expected.endpoint)
                    if row.user_id != viewer_id or (
                        endpoint.scheme,
                        endpoint.id,
                    ) not in edges.link_pair(row):
                        raise ConflictError(
                            ApiErrorCode.E_RESOURCE_CONFLICT,
                            "Unlink fence is not an owned link endpoint",
                        )
                    check(endpoint, command.expected.links_version)
            ids.add(command.link_id)
        for id in sorted(ids):
            links.unlink_in_txn(db, viewer_id=viewer_id, link_id=id)
        return
    body_targets = {command.note_id for command in commands if isinstance(command, SetBody)}
    removed_ids = {
        command.link_id for command in commands if isinstance(command, Remove | ConsumeNote)
    }
    minted_ids = {
        command.link_id for command in commands if isinstance(command, InsertNote | InsertLink)
    }
    minted_ids.update(command.new_link_id for command in commands if isinstance(command, Relink))
    minted_count = sum(
        isinstance(command, InsertNote | InsertLink | Relink) for command in commands
    )
    if len(minted_ids) != minted_count:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Create ids must be unique in a batch"
        )
    if removed_ids & minted_ids:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Cannot delete and remint an id")
    lanes: set[tuple[str, UUID]] = set()
    recognized: dict[UUID, authored_identities.Binding] = {}
    for command in commands:
        write_lane = (
            ("body", command.note_id)
            if isinstance(command, SetBody)
            else ("title", command.page_id)
            if isinstance(command, SetTitle)
            else None
        )
        if write_lane is not None:
            if write_lane in lanes:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Only one final write per lane"
                )
            lanes.add(write_lane)
        new_id = (
            command.link_id
            if isinstance(command, InsertNote | InsertLink)
            else command.new_link_id
            if isinstance(command, Relink)
            else None
        )
        if new_id is not None:
            binding = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=new_id)
            if binding is not None:
                recognized[new_id] = binding
                if binding.deleted and len(commands) > 1:
                    authored_identities.require_live(binding)
        if isinstance(command, Remove | ConsumeNote):
            removed = authored_identities.recognize(
                db, viewer_id=viewer_id, kind="link", id=command.link_id
            )
            canonical_id = removed.canonical.resource_id if removed is not None else command.link_id
            if canonical_id in minted_ids:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Cannot delete and remint an id"
                )
            row = db.get(ResourceEdge, canonical_id)
            if row is not None:
                target = _other(row, require_ref(command.endpoint))
                if target.scheme == "note_block" and target.id in body_targets:
                    raise InvalidRequestError(
                        ApiErrorCode.E_INVALID_REQUEST, "Cannot write a note consumed by this batch"
                    )
    # Known retired prerequisites refuse before any surviving command can mutate.
    for command in commands:
        if isinstance(command, Relink) and command.new_link_id in recognized:
            continue
        if isinstance(command, InsertNote | InsertLink) and command.link_id in recognized:
            continue
        prerequisites: list[tuple[IdentityKind, UUID]] = []
        if isinstance(command, SetBody):
            prerequisites.append(("note_block", command.note_id))
        elif isinstance(command, SetTitle):
            prerequisites.append(("page", command.page_id))
        elif isinstance(command, InsertNote | InsertLink):
            if isinstance(command, InsertNote):
                prerequisites.append(("note_block", command.note_id))
            elif command.target.kind == "resource":
                target_ref = require_ref(command.target.ref)
                if target_ref.scheme in ("page", "note_block", "highlight"):
                    prerequisites.append((cast(IdentityKind, target_ref.scheme), target_ref.id))
            if command.source.kind == "resource":
                ref = require_ref(command.source.ref)
                if ref.scheme in ("page", "note_block", "highlight"):
                    prerequisites.append((cast(IdentityKind, ref.scheme), ref.id))
            elif command.source.kind == "daily_page":
                prerequisites.append(("page", command.source.page_id))
            elif (
                command.source.kind == "fragment_selection"
                or command.source.kind == "pdf_selection"
            ):
                prerequisites.append(("highlight", command.source.highlight_id))
            if command.position is not None and command.position.after is not None:
                prerequisites.append(("link", command.position.after))
        elif isinstance(command, Move | Relink | Remove | ConsumeNote):
            if isinstance(command, Move):
                prerequisites.append(("link", command.edge_id))
            elif isinstance(command, Relink | Remove | ConsumeNote):
                prerequisites.append(("link", command.link_id))
        for kind, id in prerequisites:
            binding = authored_identities.recognize(db, viewer_id=viewer_id, kind=kind, id=id)
            if binding is not None:
                if not (len(commands) == 1 and isinstance(command, Remove)):
                    authored_identities.require_live(binding)

    created_daily: set[ResourceRef] = set()
    for command in commands:
        if isinstance(command, Unlink):
            # justify-service-invariant-check: all-unlink batches returned above;
            # mixed batches were rejected, which list-based control flow cannot narrow.
            raise AssertionError("Unlink batch reached mixed command application")
        if isinstance(command, InsertNote | InsertLink):
            binding = recognized.get(command.link_id)
            if binding is not None:
                writing.identity(db, binding.out())
                if isinstance(command, InsertNote):
                    child = authored_identities.recognize(
                        db, viewer_id=viewer_id, kind="note_block", id=command.note_id
                    )
                    if child is None:
                        if not binding.deleted:
                            raise ConflictError(
                                ApiErrorCode.E_RESOURCE_CONFLICT,
                                "Initialized link cannot take a new note",
                            )
                    else:
                        writing.identity(db, child.out())
                if binding.deleted:
                    continue
                row = db.get(ResourceEdge, binding.canonical.resource_id)
                if row is None:
                    raise RuntimeError("Live authored link has no edge")
                source = require_ref(binding.row.source_ref or "")
                write = edges.EdgeWrite(
                    edges.edge_out(row), binding.row.canonical_identity_id is None
                )
            else:
                source, created_source = links.materialize_source(
                    db, viewer_id=viewer_id, source=command.source
                )
                if created_source:
                    if source.scheme == "page":
                        created_daily.add(source)
                if isinstance(command, InsertNote):
                    note_bodies.ensure_note(
                        db,
                        viewer_id=viewer_id,
                        note_id=command.note_id,
                        body_pm_json=command.body_pm_json,
                        reason="outline_insert",
                    )
                    target = note_bodies.note_ref(command.note_id)
                else:
                    target = links.materialize_link_endpoint(
                        db, viewer_id=viewer_id, endpoint=command.target
                    )
                _require_endpoint(db, viewer_id, source)
                assert_ref_visible(db, viewer_id=viewer_id, ref=target)
                pair = edges.existing_link_pair(db, viewer_id=viewer_id, a=source, b=target)
                if pair is not None and isinstance(command, InsertLink) and command.require_created:
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "These resources are already linked"
                    )
                if pair is None and command.position is not None:
                    check(source, command.position.expected_links_version)
                    if command.position.after is not None and command.position.after not in [
                        edge.id for edge, _ in order.ordered(db, viewer_id, source)
                    ]:
                        raise ConflictError(
                            ApiErrorCode.E_RESOURCE_CONFLICT, "Position is not in this outline"
                        )
                write = edges.create_link(
                    db, viewer_id=viewer_id, source=source, target=target, link_id=command.link_id
                )
                if write.created and command.position is not None:
                    order.place(db, viewer_id, source, write.edge.id, command.position.after)
            state.link_ids.add(write.edge.id)
            state.addressed.update((write.edge.source, write.edge.target))
            for ref in (write.edge.source, write.edge.target):
                current_version = versions.versions_for_ref(db, viewer_id=viewer_id, ref=ref).get(
                    "links", 1
                )
                writing.lane(db, viewer_id=viewer_id, ref=ref, name="links", before=current_version)
            state.insertions[command.link_id] = WritingInsertion(
                requested_link_id=command.link_id,
                source_ref=source.uri,
                canonical_link_id=write.edge.id,
                created=write.edge.id == command.link_id,
            )
            # Current placement is evidence, never a fabricated expected-version check.
            sequence = [edge.id for edge, _ in order.ordered(db, viewer_id, source)]
            if write.edge.id in sequence:
                index = sequence.index(write.edge.id)
                state.placements[(source.uri, write.edge.id)] = WritingPlacement(
                    endpoint=source.uri,
                    link_id=write.edge.id,
                    after_link_id=sequence[index - 1] if index else None,
                )
        elif isinstance(command, Move):
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            current, desired = order.desired(
                db, viewer_id, endpoint, command.edge_id, command.after
            )
            if [edge.id for edge in current] != desired:
                check(endpoint, command.expected_links_version)
                order.place(db, viewer_id, endpoint, command.edge_id, command.after)
            state.placements[(endpoint.uri, command.edge_id)] = WritingPlacement(
                endpoint=endpoint.uri, link_id=command.edge_id, after_link_id=command.after
            )
        elif isinstance(command, Relink):
            binding = recognized.get(command.new_link_id)
            if binding is not None:
                writing.identity(db, binding.out())
                if not binding.deleted:
                    row = db.get(ResourceEdge, binding.canonical.resource_id)
                    if row is None:
                        raise RuntimeError("Live authored link has no edge")
                    state.addressed.update(
                        (
                            require_ref(f"{row.source_scheme}:{row.source_id}"),
                            require_ref(f"{row.target_scheme}:{row.target_id}"),
                        )
                    )
                    for ref in (
                        require_ref(f"{row.source_scheme}:{row.source_id}"),
                        require_ref(f"{row.target_scheme}:{row.target_id}"),
                    ):
                        current_version = versions.versions_for_ref(
                            db, viewer_id=viewer_id, ref=ref
                        ).get("links", 1)
                        writing.lane(
                            db, viewer_id=viewer_id, ref=ref, name="links", before=current_version
                        )
                    state.insertions[command.new_link_id] = WritingInsertion(
                        requested_link_id=command.new_link_id,
                        source_ref=binding.row.source_ref or "",
                        canonical_link_id=row.id,
                        created=row.id == command.new_link_id,
                    )
                continue
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            destination = _endpoint(db, viewer_id, command.destination)
            edge = _require_incident(db, viewer_id, endpoint, command.link_id)
            target = _other(edge, endpoint)
            check(endpoint, command.expected_source_links_version)
            if command.position is not None:
                check(destination, command.position.expected_links_version)
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
            if command.position is not None:
                order.place(db, viewer_id, destination, write.edge.id, command.position.after)
            state.insertions[command.new_link_id] = WritingInsertion(
                requested_link_id=command.new_link_id,
                source_ref=destination.uri,
                canonical_link_id=write.edge.id,
                created=True,
            )
        elif isinstance(command, EnsureDaily):
            created = db.get(Page, command.page_id) is None
            ref = notes.ensure_daily_page(db, viewer_id, command.local_date, command.page_id)
            state.addressed.add(ref)
            if created:
                created_daily.add(ref)
        else:
            if isinstance(command, Remove | ConsumeNote):
                binding = authored_identities.recognize(
                    db, viewer_id=viewer_id, kind="link", id=command.link_id
                )
                if binding is not None and not binding.deleted:
                    writing.identity(db, binding.out())
                    command = command.model_copy(update={"link_id": binding.canonical.resource_id})
                endpoint = require_ref(command.endpoint)
                if (
                    command.expected_links_version is not None
                    and _incident(db, viewer_id, endpoint, command.link_id) is not None
                ):
                    check(endpoint, command.expected_links_version)
            state.addressed.update(_apply(db, viewer_id, command))
    for ref in created_daily:
        if not any(edge.origin == "user" for edge, _ in order.ordered(db, viewer_id, ref)):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Add an item to save this day"
            )


def _depends_on_link(command: OutlineCommand, link_id: UUID) -> bool:
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


def _apply(
    db: Session, viewer_id: UUID, command: SetBody | SetTitle | Remove | ConsumeNote
) -> list[ResourceRef]:
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
        case Remove() | ConsumeNote():
            binding = authored_identities.recognize(
                db, viewer_id=viewer_id, kind="link", id=command.link_id
            )
            if binding is not None:
                writing.identity(db, binding.out())
                if binding.deleted:
                    return []
            raw = require_ref(command.endpoint)
            if raw.scheme == "note_block" and db.get(NoteBlock, raw.id) is None:
                known = authored_identities.recognize(
                    db, viewer_id=viewer_id, kind="note_block", id=raw.id
                )
                if known is not None:
                    writing.identity(db, known.out())
                return [raw]
            endpoint = _endpoint(db, viewer_id, command.endpoint)
            edge = _incident(db, viewer_id, endpoint, command.link_id)
            if edge is None:
                retired = authored_identities.retire(
                    db, viewer_id=viewer_id, kind="link", id=command.link_id
                )
                writing.identity(db, retired.out())
                return [endpoint]
            target = _other(edge, endpoint)
            if target.scheme != "note_block":
                if isinstance(command, ConsumeNote):
                    raise InvalidRequestError(
                        ApiErrorCode.E_INVALID_REQUEST, "Only a note can be consumed"
                    )
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
            retained = retention.has_retainer(
                db, block.user_id, target, excluding_edge_ids=[edge.id]
            )
            if retained and isinstance(command, ConsumeNote):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "This note is retained elsewhere and cannot be consumed",
                )
            if not retained:
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
            edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
            if not retained:
                note_bodies.delete_note(db, viewer_id=viewer_id, note_id=target.id)
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
                    body=NamedResourceBodyOut(
                        title=title, image_url=None, media_kind=None, contributors=None
                    ),
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
