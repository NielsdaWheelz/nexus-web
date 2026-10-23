"""Transaction-local authored effects, compact acknowledgements and wake audiences.

The state belongs to exactly one SessionTransaction, never a retry or request.
Shared version/graph owners accumulate actual effects, including far endpoints.
No-op reads address current facts without manufacturing checks or activity.
"""

from dataclasses import dataclass, field
from typing import cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, SessionTransaction

from nexus.db.models import (
    DailyPageBinding,
    Highlight,
    NoteBlock,
    Page,
    ResourceEdge,
    ResourceVersion,
)
from nexus.schemas.writing import (
    WritingAck,
    WritingIdentity,
    WritingInsertion,
    WritingLane,
    WritingLaneVersion,
    WritingLink,
    WritingNote,
    WritingPage,
    WritingPlacement,
)
from nexus.services.resource_graph.refs import ResourceRef, require_ref


@dataclass
class Effects:
    transaction: SessionTransaction
    viewer_ids: set[UUID] = field(default_factory=set)
    lanes: dict[tuple[UUID, ResourceRef, str], tuple[int | None, int | None]] = field(
        default_factory=dict
    )
    addressed: set[ResourceRef] = field(default_factory=set)
    identities: dict[tuple[str, UUID], WritingIdentity] = field(default_factory=dict)
    link_ids: set[UUID] = field(default_factory=set)
    removed: set[UUID] = field(default_factory=set)
    deleted: set[str] = field(default_factory=set)
    insertions: dict[UUID, WritingInsertion] = field(default_factory=dict)
    placements: dict[tuple[str, UUID], WritingPlacement] = field(default_factory=dict)
    changed: bool = False


def effects(db: Session) -> Effects:
    transaction = db.get_transaction()
    if transaction is None:
        transaction = db.begin()
    previous = db.info.get("writing_effects")
    if isinstance(previous, Effects) and previous.transaction is transaction:
        return previous
    current = Effects(transaction)
    db.info["writing_effects"] = current
    return current


def lane(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    name: str,
    before: int | None,
    checked: int | None = None,
) -> None:
    state = effects(db)
    key = (viewer_id, ref, name)
    baseline, proof = state.lanes.setdefault(key, (before, None))
    state.lanes[key] = (baseline, checked if checked is not None else proof)


def changed(db: Session, viewer_id: UUID) -> None:
    state = effects(db)
    state.changed = True
    state.viewer_ids.add(viewer_id)


def identity(db: Session, value: WritingIdentity) -> None:
    state = effects(db)
    state.identities[(value.kind, value.requested_id)] = value
    if value.kind == "link":
        (state.removed if value.state == "deleted" else state.link_ids).add(value.canonical_id)
    else:
        ref = require_ref(f"{value.kind}:{value.canonical_id}")
        if value.state == "deleted":
            state.deleted.add(ref.uri)
        else:
            state.addressed.add(ref)


def ack(db: Session, viewer_id: UUID) -> WritingAck:
    from nexus.services import authored_identities
    from nexus.services.highlights import compact_highlight
    from nexus.services.resource_items.versions import versions_for_ref

    state = effects(db)
    identities: list[WritingIdentity] = []
    for value in state.identities.values():
        binding = authored_identities.recognize(
            db, viewer_id=viewer_id, kind=value.kind, id=value.requested_id
        )
        identities.append(binding.out() if binding is not None else value)
    out = WritingAck(
        identities=identities,
        insertions=list(state.insertions.values()),
        placements=list(state.placements.values()),
        removed_link_ids=list(state.removed),
        deleted_refs=list(state.deleted),
    )
    for ref in state.addressed:
        if ref.uri in state.deleted:
            continue
        versions = versions_for_ref(db, viewer_id=viewer_id, ref=ref)
        if ref.scheme == "note_block":
            note = db.get(NoteBlock, ref.id)
            if note is not None and note.user_id == viewer_id:
                out.notes.append(
                    WritingNote(
                        id=note.id,
                        body_pm_json=note.body_pm_json,
                        body_text=note.body_text,
                        body_version=versions.get("body", 1),
                    )
                )
        elif ref.scheme == "page":
            page = db.get(Page, ref.id)
            if page is not None and page.user_id == viewer_id:
                out.pages.append(
                    WritingPage(
                        id=page.id,
                        title=page.title,
                        title_version=versions.get("title", 1),
                        daily_date=db.scalar(
                            select(DailyPageBinding.local_date).where(
                                DailyPageBinding.page_id == page.id
                            )
                        ),
                    )
                )
        elif ref.scheme == "highlight":
            highlight = db.get(Highlight, ref.id)
            if highlight is not None and highlight.user_id == viewer_id:
                out.highlights.append(compact_highlight(highlight))
    for id in state.link_ids - state.removed:
        row = db.get(ResourceEdge, id)
        if row is not None and row.user_id == viewer_id:
            out.links.append(
                WritingLink(
                    link_id=row.id,
                    source_ref=f"{row.source_scheme}:{row.source_id}",
                    target_ref=f"{row.target_scheme}:{row.target_id}",
                    origin=row.origin,
                )
            )
    for (owner, ref, name), (before, checked) in state.lanes.items():
        if owner != viewer_id or ref.uri in state.deleted:
            continue
        version = db.scalar(
            select(ResourceVersion.version).where(
                ResourceVersion.user_id == owner,
                ResourceVersion.resource_scheme == ref.scheme,
                ResourceVersion.resource_id == ref.id,
                ResourceVersion.lane == name,
            )
        )
        if version is not None:
            out.lanes.append(
                WritingLaneVersion(
                    ref=ref.uri,
                    lane=cast(WritingLane, name),
                    before_version=before,
                    version=version,
                    checked_from_version=checked,
                )
            )
    return out
