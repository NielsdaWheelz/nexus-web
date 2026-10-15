"""The five additive writes the model may make, each through its domain's owner, and undo.

A write takes the fence and checks the answer's cap before its effect. Its
``created_refs`` list exactly the targets it inserted, never one that already
existed, so undo removes only what the assistant made. Note and highlight ids derive
from the call id. There is no delete, overwrite or rewrite tool.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid5

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.services import highlights, library_entries, note_bodies, notes, text_quote, users
from nexus.services.consumption import lectern
from nexus.services.passage_anchors import normalize_quote_text
from nexus.services.resource_graph.edges import EdgeCreate, create_edge, delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.tools.contract import (
    WRITE_CAP,
    WRITES,
    EdgeCreateInput,
    EdgeCreateSuccess,
    HighlightCreateInput,
    HighlightCreateSuccess,
    LibraryAddInput,
    LibraryAddSuccess,
    NoteCreateInput,
    NoteCreateSuccess,
    QueueAddInput,
    QueueAddSuccess,
    refuse,
)

if TYPE_CHECKING:
    from nexus.services.tools.run import Call

_URIS = ("resource_uri", "page_uri", "media_uri", "source_uri", "target_uri")
# owner refusals a write answers as a declared error; any other ApiError is a defect.
_REFUSALS: dict[str, dict[ApiErrorCode, str]] = {
    "nexus.library.add": {
        ApiErrorCode.E_MEDIA_DELETING: "ResourceUnavailable",
        ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED: "ResourceUnavailable",
        ApiErrorCode.E_PODCAST_REPLACES_EPISODES: "TargetAmbiguous",
    },
    "nexus.queue.add": {
        ApiErrorCode.E_LIMIT: "ResourceUnavailable",
        ApiErrorCode.E_MEDIA_DELETING: "ResourceUnavailable",
    },
    "nexus.highlight.create": {ApiErrorCode.E_HIGHLIGHT_CONFLICT: "Conflict"},
    "nexus.edge.create": {ApiErrorCode.E_INVALID_REQUEST: "Conflict"},
}
_UNAVAILABLE = frozenset(
    {
        ApiErrorCode.E_NOT_FOUND,
        ApiErrorCode.E_LIBRARY_NOT_FOUND,
        ApiErrorCode.E_MEDIA_NOT_FOUND,
        ApiErrorCode.E_FORBIDDEN,
        ApiErrorCode.E_LIBRARY_FORBIDDEN,
        ApiErrorCode.E_OWNER_REQUIRED,
        ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN,
    }
)
# an undo target already gone counts as undone: the user may have removed it.
_GONE = frozenset(
    {ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_MEDIA_NOT_FOUND, ApiErrorCode.E_LIBRARY_NOT_FOUND}
)


def _write[T: BaseModel](effect: Callable[[Any, Call], T]) -> Callable[[Any, Call], T]:
    """Admission, fence and the per-answer cap around one write's effect."""

    def run(value: Any, call: Call) -> T:
        for key in _URIS:
            uri = getattr(value, key, None)
            if uri is not None and uri not in call.run.scope:
                refuse("ResourceUnavailable")
        call.fence()  # held until the call's row completes with the effect
        live = call.db.execute(
            text(
                "SELECT count(*) FROM tool_calls WHERE generation_id = :generation"
                " AND tool_id = ANY(:writes) AND status = 'complete' AND reverted_at IS NULL"
            ),
            {"generation": call.run.generation_id, "writes": list(WRITES)},
        ).scalar_one()
        if live >= WRITE_CAP:
            refuse("WriteCapReached")
        try:
            return effect(value, call)
        except ApiError as exc:
            declared = _REFUSALS.get(call.tool_id, {}).get(exc.code)
            if declared is None and exc.code not in _UNAVAILABLE:
                raise
            refuse(declared or "ResourceUnavailable")

    return run


def _ref(raw: str, allowed: tuple[str, ...]) -> ResourceRef:
    ref = parse_resource_ref(raw.strip())
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme not in allowed:
        refuse("InvalidInput")
    return ref


def _text(value: str) -> str:
    """Refuse blank text; the schema's ``min_length`` admits whitespace."""

    if not value.strip():
        refuse("InvalidInput")
    return value.strip()


def library_add(value: LibraryAddInput, call: Call) -> LibraryAddSuccess:
    """File through the one actor-authorized filing command REST also uses.

    The filing command owns media authorization (readable or restorable, so re-filing
    restores a tombstoned media); podcasts have no restorable lane and are checked here.
    """

    db, viewer = call.db, call.principal
    ref = _ref(value.resource_uri, ("media", "podcast"))
    if ref.scheme == "podcast":
        assert_ref_visible(db, viewer_id=viewer, ref=ref)
    library_id = value.library_id or _library_named(db, viewer, value.library_name)
    if ref.scheme == "media":
        target = library_entries.media_target(ref.id)
        inserted = library_entries.ensure_media_in_library_in_current_transaction(
            db, viewer_id=viewer, library_id=library_id, media_id=ref.id
        )
    else:
        target = library_entries.podcast_target(ref.id)
        inserted = library_entries.place_subscribed_podcast_in_named_library_in_current_transaction(
            db, viewer_id=viewer, library_id=library_id, podcast_id=ref.id, replace_episodes=False
        )
    name = db.execute(
        text("SELECT name FROM libraries WHERE id = :id"), {"id": library_id}
    ).scalar_one()
    if inserted:
        entry_id = library_entries.entry_id(db, library_id, target)
        call.created_refs.append(
            {
                "kind": "entry",
                "id": str(entry_id),
                "label": name,
                "library_id": str(library_id),
                "target_scheme": ref.scheme,
                "target_id": str(ref.id),
            }
        )
    return LibraryAddSuccess(
        already_present=not inserted,
        library_name=name,
        library_uri=f"library:{library_id}",
        resource_uri=ref.uri,
    )


def _library_named(db: Session, viewer_id: UUID, name: str | None) -> UUID:
    if not name:
        refuse("InvalidInput")
    ids = (
        db.execute(
            text(
                "SELECT l.id FROM libraries l JOIN memberships m ON m.library_id = l.id"
                " AND m.user_id = :viewer WHERE lower(l.name) = lower(:name)"
            ),
            {"viewer": viewer_id, "name": name.strip()},
        )
        .scalars()
        .all()
    )
    if len(ids) != 1:
        refuse("TargetAmbiguous" if ids else "ResourceUnavailable")
    return ids[0]


def note_create(value: NoteCreateInput, call: Call) -> NoteCreateSuccess:
    db, viewer = call.db, call.principal
    body = note_bodies.pm_doc_from_markdown_projection(_text(value.markdown))
    note_id = uuid5(call.id, "nexus.note.create:note_block")
    if value.page_uri:
        page = _ref(value.page_uri, ("page",))
        notes.append_note_in_current_transaction(
            db, viewer, page_id=page.id, note_id=note_id, body_pm_json=body
        )
        label = "page"
    else:
        notes.capture_in_current_transaction(
            db,
            viewer,
            local_date=users.calendar_local_date(db, viewer),
            note_id=note_id,
            body_pm_json=body,
        )
        label = "today's note"
    call.created_refs.append({"kind": "note_block", "id": str(note_id), "label": label})
    return NoteCreateSuccess(note_uri=f"note_block:{note_id}", page_uri=value.page_uri)


def highlight_create(value: HighlightCreateInput, call: Call) -> HighlightCreateSuccess:
    """Highlight the one passage the quote names; an ambiguous or absent quote is refused."""

    db, viewer = call.db, call.principal
    media = _ref(value.media_uri, ("media",))
    assert_ref_visible(db, viewer_id=viewer, ref=media)
    exact = _text(value.exact)
    match = text_quote.resolve_owner_quote(
        db,
        owner_scheme="media",
        owner_id=media.id,
        exact=normalize_quote_text(exact),
        prefix=normalize_quote_text(value.prefix or ""),
        suffix=normalize_quote_text(value.suffix or ""),
    )
    if match.status is not text_quote.QuoteStatus.unique:
        refuse(
            {
                text_quote.QuoteStatus.ambiguous: "QuoteAmbiguous",
                text_quote.QuoteStatus.no_match: "QuoteNotFound",
            }.get(match.status, "InvalidInput")
        )
    assert match.fragment_id is not None and match.raw_start is not None
    assert match.raw_end is not None
    highlight = highlights.create_fragment_highlight_in_txn(
        db,
        viewer_id=viewer,
        highlight_id=uuid5(call.id, "nexus.highlight.create:highlight"),
        fragment_id=match.fragment_id,
        start_offset=match.raw_start,
        end_offset=match.raw_end,
        color=value.color or "yellow",
    )
    call.created_refs.append({"kind": "highlight", "id": str(highlight.id), "label": exact})
    note_uri = None
    if value.note and value.note.strip():
        note_id = uuid5(call.id, "nexus.highlight.create:note_block")
        notes.attach_highlight_note_in_current_transaction(
            db,
            viewer,
            highlight_id=highlight.id,
            note_id=note_id,
            body_pm_json=note_bodies.pm_doc_from_markdown_projection(value.note),
        )
        call.created_refs.append(
            {"kind": "note_block", "id": str(note_id), "label": "highlight note"}
        )
        note_uri = f"note_block:{note_id}"
    return HighlightCreateSuccess(
        exact=exact, highlight_uri=f"highlight:{highlight.id}", note_uri=note_uri
    )


def edge_create(value: EdgeCreateInput, call: Call) -> EdgeCreateSuccess:
    endpoints = ("media", "page", "note_block", "highlight")
    source, target = _ref(value.source_uri, endpoints), _ref(value.target_uri, endpoints)
    rationale, kind = _text(value.rationale), value.kind or "context"
    edge = create_edge(
        call.db,
        viewer_id=call.principal,
        input=EdgeCreate(
            source=source,
            target=target,
            kind=kind,
            origin="assistant",
            snapshot=CitationSnapshot(excerpt=rationale),
        ),
    )
    call.created_refs.append({"kind": "edge", "id": str(edge.id), "label": rationale})
    return EdgeCreateSuccess(
        edge_id=edge.id,
        kind=kind,
        rationale=rationale,
        source_uri=source.uri,
        target_uri=target.uri,
    )


def queue_add(value: QueueAddInput, call: Call) -> QueueAddSuccess:
    db, viewer = call.db, call.principal
    media = _ref(value.media_uri, ("media",))
    assert_ref_visible(db, viewer_id=viewer, ref=media)
    # only the owner's lock-held inserted receipt makes the item the assistant's.
    inserted = lectern.append_missing_in_txn(db, viewer_id=viewer, media_ids=[media.id])
    found = lectern.find_item_for_media(db, viewer_id=viewer, media_id=media.id)
    if found is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    item_id, title = found
    if inserted:
        call.created_refs.append({"kind": "queue", "id": str(item_id), "label": title})
    return QueueAddSuccess(
        already_present=not inserted, media_uri=media.uri, queue_entry_id=item_id, title=title
    )


def revert(db: Session, viewer_id: UUID, ref: dict[str, Any]) -> None:
    """Remove one created target if it is still the one the write made; gone is undone."""

    kind, target = ref["kind"], UUID(ref["id"])
    try:
        if kind == "edge":
            delete_edge(db, viewer_id=viewer_id, edge_id=target)
        elif kind == "highlight":
            highlights.delete_highlight_in_current_transaction(db, viewer_id, target)
        elif kind == "note_block":
            note_bodies.delete_note(db, viewer_id=viewer_id, note_id=target)
        elif kind == "queue":
            lectern.remove_item_in_txn(db, viewer_id=viewer_id, item_id=target)
        else:
            _unfile(db, viewer_id, ref)
    except ApiError as exc:
        if exc.code not in _GONE:
            raise


def _unfile(db: Session, viewer_id: UUID, ref: dict[str, Any]) -> None:
    """Remove the exact library entry the write inserted, not a later filing of the same item.

    The target's row lock (media, as filing takes it; else the podcast) serializes this
    with the user filing or unfiling it. The last physical reference of a media stays
    refused (409 ``E_MEDIA_LAST_REFERENCE``): undo never deletes a media.
    """

    library_id, item_id = UUID(ref["library_id"]), UUID(ref["target_id"])
    media = ref["target_scheme"] == "media"
    if media:
        library_entries.lock_media_rows_in_order(db, [item_id])
    else:
        db.execute(text("SELECT 1 FROM podcasts WHERE id = :id FOR UPDATE"), {"id": item_id})
    target = (library_entries.media_target if media else library_entries.podcast_target)(item_id)
    current = library_entries.entry_id(db, library_id, target)
    if current != UUID(ref["id"]):
        return
    if media:
        library_entries.remove_media_from_library_in_current_transaction(
            db, viewer_id, item_id, library_id, allow_default=True
        )
    else:
        library_entries.undo_podcast_filing_for_viewer_in_current_transaction(
            db, viewer_id=viewer_id, library_id=library_id, podcast_id=item_id
        )


HANDLERS: dict[str, Callable[..., Any]] = {
    "nexus.library.add": _write(library_add),
    "nexus.note.create": _write(note_create),
    "nexus.highlight.create": _write(highlight_create),
    "nexus.edge.create": _write(edge_create),
    "nexus.queue.add": _write(queue_add),
}
