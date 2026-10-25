"""The five additive writes the model may make, each through its domain's owner, and undo.

A write takes the fence and checks the answer's cap before its effect. Its
``created_refs`` list exactly the targets it inserted, never one that already
existed. Named filing uses frozen library/removal guards. Its entry receipt adds
the exact final library revision; later reaffirmation invalidates undo. Default
holdings survive undo; historical null-revision entries confer no undo authority.

Notes, highlights and their placement links are authored: one server command per
call, inside the fenced call transaction, through the semantic owner that feeds every
device. Their ids derive from the call id and the call row's single completion stops a
retry from minting a second touch. Locks follow the authored order: fence, viewer,
media, then the account head, which also fences the baseline each command observes.
Assistant edges stay directed machine facts with their kind and rationale. There is
no delete, overwrite or rewrite tool; undo deletes a created resource observing its
current state, and an unseen device edit may revive it. Effects and exact source-clock
invalidations join the tool receipt's one serializable attempt; participants never
commit or repeat external calls.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid5

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Highlight, Media, NoteBlock, Page
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.services import (
    authored,
    libraries,
    library_entries,
    note_bodies,
    text_quote,
    users,
)
from nexus.services.capabilities import is_text_document_ready
from nexus.services.consumption import lectern
from nexus.services.highlights import AFFIX_CODEPOINTS
from nexus.services.media_text_scope import read_media_text_scope
from nexus.services.passage_anchors import normalize_quote_text
from nexus.services.podcasts import subscriptions
from nexus.services.reader_publication import lock_publication_generation
from nexus.services.resource_graph.edges import EdgeCreate, create_edge, delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    assert_resource_ref,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
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
        ApiErrorCode.E_RESOURCE_CONFLICT: "Conflict",
    },
    "nexus.queue.add": {
        ApiErrorCode.E_LIMIT: "ResourceUnavailable",
        ApiErrorCode.E_MEDIA_DELETING: "ResourceUnavailable",
    },
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
        users.lock_viewer(call.db, call.principal)
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
            result = effect(value, call)
        except ApiError as exc:
            declared = _REFUSALS.get(call.tool_id, {}).get(exc.code)
            if declared is None and exc.code not in _UNAVAILABLE:
                raise
            refuse(declared or "ResourceUnavailable")
        if call.tool_id == "nexus.library.add":
            projection.refresh_viewer_contributors(
                call.db,
                list(
                    call.db.scalars(
                        text("SELECT user_id FROM memberships WHERE library_id=:id"),
                        {"id": value.library_id},
                    )
                ),
            )
        owners = {
            uri
            for item in (value, result)
            for key in (*_URIS, "note_uri", "highlight_uri", "library_uri")
            if (uri := getattr(item, key, None)) is not None
        }
        record_input_change(call.db, owners=owners)
        return result

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
        if value.podcast is None:
            refuse("InvalidInput")
        assert_ref_visible(db, viewer_id=viewer, ref=ref)
        intent = value.podcast
        existing = db.scalar(
            text(
                "SELECT id FROM library_podcast_subscriptions WHERE id=:id"
                if intent.mode == "follow"
                else "SELECT id FROM podcast_library_imports WHERE id=:id"
            ),
            {"id": intent.id},
        )
        admission = subscriptions.admit_in_current_transaction(
            db,
            viewer_id=viewer,
            library_id=value.library_id,
            podcast_id=ref.id,
            id=intent.id,
            import_id=intent.import_id,
            expected_order_revision=int(value.expected_order_revision),
            expected_removal_revision=int(value.expected_removal_revision),
        )
        library = libraries.access(db, viewer, value.library_id, lock=False)
        return LibraryAddSuccess(
            podcast=admission,
            already_present=existing is not None,
            library_name=library.name,
            library_uri=f"library:{library.id}",
            resource_uri=ref.uri,
        )
    if value.podcast is not None:
        refuse("InvalidInput")
    library_id = value.library_id
    target = library_entries.media_target(ref.id)
    placement, inserted_entry_id = library_entries.set_item_in_current_transaction(
        db,
        viewer_id=viewer,
        library_id=library_id,
        target=target,
        included=True,
        expected_order_revision=int(value.expected_order_revision),
        expected_removal_revision=int(value.expected_removal_revision),
    )
    if inserted_entry_id is not None:
        call.created_refs.append(
            {
                "kind": "entry",
                "id": str(inserted_entry_id),
                "label": placement.name,
                "library_id": str(library_id),
                "target_scheme": ref.scheme,
                "target_id": str(ref.id),
                "order_revision": placement.order_revision,
            }
        )
    return LibraryAddSuccess(
        podcast=None,
        already_present=inserted_entry_id is None,
        library_name=placement.name,
        library_uri=f"library:{library_id}",
        resource_uri=ref.uri,
    )


def _note_and_link(note: str, body: dict[str, Any], owner: str) -> list[dict[str, Any]]:
    """Create ``note`` and append it last under ``owner``, at each endpoint."""
    a, b = sorted((owner, note))
    return [
        {"kind": "create_note", "ref": note, "body_pm_json": body},
        {
            "kind": "add_link",
            "link_id": None,
            "endpoint_a": a,
            "endpoint_b": b,
            "position_a": None,
            "position_b": None,
        },
    ]


def note_create(value: NoteCreateInput, call: Call) -> NoteCreateSuccess:
    """One command: the note and its placement on the page or today's daily page.

    A day's page is its permanent binding; an unbound day is minted, and a deleted day
    revives with this first item. Opening a day never wrote it."""
    db, viewer = call.db, call.principal
    body = note_bodies.markdown_body(_text(value.markdown))
    note = ResourceRef("note_block", uuid5(call.id, "nexus.note.create:note_block"))
    authored.lock_account(db, viewer)
    intents: list[dict[str, Any]] = []
    if value.page_uri:
        owner = _ref(value.page_uri, ("page",))
        assert_ref_visible(db, viewer_id=viewer, ref=owner)
        label = "page"
    else:
        local_date = users.calendar_local_date(db, viewer)
        owner = assert_resource_ref(authored.daily_page_ref(db, viewer, local_date))
        label = "today's note"
        day = db.get(Page, owner.id)
        if day is None:
            intents.append(
                {
                    "kind": "create_page",
                    "ref": owner.uri,
                    "title": "",
                    "local_date": str(local_date),
                }
            )
        elif not day.authored_visible:
            intents.append({"kind": "restore_resource", "ref": owner.uri})
    intents += _note_and_link(note.uri, body, owner.uri)
    authored.server_command(
        db,
        viewer,
        command={"kind": "batch", "intents": intents},
        resource_refs=[owner.uri],
        link_ids=[],
    )
    call.created_refs.append({"kind": "note_block", "id": str(note.id), "label": label})
    return NoteCreateSuccess(note_uri=note.uri, page_uri=value.page_uri)


def highlight_create(value: HighlightCreateInput, call: Call) -> HighlightCreateSuccess:
    """Highlight the one passage the quote names; an ambiguous or absent quote is refused.

    The selection captures its canonical owner's fragment offsets, literal quote and
    context, and the reader publication it was resolved against. A coinciding highlight
    is never a conflict: each annotation is independent."""

    db, viewer = call.db, call.principal
    media = _ref(value.media_uri, ("media",))
    library_entries.lock_media_for_reference(db, media.id)
    assert_ref_visible(db, viewer_id=viewer, ref=media)
    generation = lock_publication_generation(db, media_id=media.id)
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
    start, end = match.raw_start, match.raw_end
    fragment = db.get(Fragment, match.fragment_id)
    reading = db.get(Media, media.id)
    if fragment is None or reading is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    bounds = (0, len(fragment.canonical_text))
    if reading.kind == "text_part":
        scope = read_media_text_scope(db, media.id)
        if not scope.contains(fragment.id, start, end):
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        interval = next(i for i in scope.fragment_intervals if i.fragment_id == fragment.id)
        bounds, generation = (interval.start_offset, interval.end_offset), scope.source_generation
    elif fragment.media_id != media.id:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    source = db.get(Media, fragment.media_id)
    if source is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    readiness = db.execute(
        text(
            "SELECT m.processing_status, t.transcript_state, t.transcript_coverage FROM media m"
            " LEFT JOIN media_transcript_states t ON t.media_id = m.id WHERE m.id = :id"
        ),
        {"id": source.id},
    ).one()
    if not is_text_document_ready(
        source.kind,
        str(readiness.processing_status),
        None if readiness.transcript_state is None else str(readiness.transcript_state),
        None if readiness.transcript_coverage is None else str(readiness.transcript_coverage),
    ):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")
    words = fragment.canonical_text[start:end]
    prefix = fragment.canonical_text[max(bounds[0], start - AFFIX_CODEPOINTS) : start]
    suffix = fragment.canonical_text[end : min(bounds[1], end + AFFIX_CODEPOINTS)]
    publication = None if generation is None else {"kind": "reader", "generation": generation}
    locator: dict[str, Any] = {
        "type": "epub_fragment_offsets" if source.kind == "epub" else "web_text_offsets",
        "media_id": str(source.id),
        "fragment_id": str(fragment.id),
        "start_offset": start,
        "end_offset": end,
        "media_kind": source.kind,
        "text_quote_selector": {"exact": words, "prefix": prefix, "suffix": suffix},
    }
    if source.kind == "epub":
        locator["section_id"] = None
    highlight = ResourceRef("highlight", uuid5(call.id, "nexus.highlight.create:highlight"))
    intents: list[dict[str, Any]] = [
        {
            "kind": "capture_source",
            "source_ref": f"media:{source.id}",
            "capture": {"kind": "media", "label": source.title, "publication": publication},
        },
        {
            "kind": "create_highlight",
            "ref": highlight.uri,
            "source_ref": f"media:{source.id}",
            "selection": {
                "publication": publication,
                "locator": locator,
                "quote_exact": words,
                "prefix": prefix,
                "suffix": suffix,
                "passage_ref": None,
            },
            "color": value.color or "yellow",
        },
    ]
    note = None
    if value.note and value.note.strip():
        note = ResourceRef("note_block", uuid5(call.id, "nexus.highlight.create:note_block"))
        intents += _note_and_link(note.uri, note_bodies.markdown_body(value.note), highlight.uri)
    authored.server_command(
        db, viewer, command={"kind": "batch", "intents": intents}, resource_refs=[], link_ids=[]
    )
    call.created_refs.append({"kind": "highlight", "id": str(highlight.id), "label": exact})
    if note is not None:
        call.created_refs.append(
            {"kind": "note_block", "id": str(note.id), "label": "highlight note"}
        )
    return HighlightCreateSuccess(
        exact=exact, highlight_uri=highlight.uri, note_uri=None if note is None else note.uri
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
            snapshot=CitationSnapshot(rationale=rationale),
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
    """Remove one created target if it is still the one the write made; gone is undone.

    A note or highlight is deleted through the semantic owner, observing its current
    canonical touches under the account head; a deleted or absent one is undone."""

    kind, target = ref["kind"], UUID(ref["id"])
    if kind == "entry":
        _unfile(db, viewer_id, ref)
        return
    if kind in ("note_block", "highlight"):
        uri = f"{kind}:{target}"
        authored.lock_account(db, viewer_id)
        row = db.get(NoteBlock if kind == "note_block" else Highlight, target)
        if row is None or row.user_id != viewer_id or not row.authored_visible:
            return
        (state,) = authored.read_states(db, viewer_id, resource_refs=[uri], link_ids=[]).resources
        authored.server_command(
            db,
            viewer_id,
            command={"kind": "delete_resource", "ref": uri, "observed_touch": state.touch_vv},
            resource_refs=[uri],
            link_ids=[],
        )
        return
    try:
        if kind == "edge":
            delete_edge(db, viewer_id=viewer_id, edge_id=target)
        elif kind == "queue":
            lectern.remove_item_in_txn(db, viewer_id=viewer_id, item_id=target)
    except ApiError as exc:
        if exc.code not in _GONE:
            raise


def _unfile(db: Session, viewer_id: UUID, ref: dict[str, Any]) -> None:
    """Undo requires the exact inserted entry and its unchanged named-library revision."""
    if ref["target_scheme"] != "media":
        raise ApiError(ApiErrorCode.E_RESOURCE_CONFLICT, "Podcast actions need scoped review")
    target = library_entries.media_target(UUID(ref["target_id"]))
    library_entries.undo_library_entry_in_current_transaction(
        db,
        viewer_id=viewer_id,
        library_id=UUID(ref["library_id"]),
        target=target,
        entry_id=UUID(ref["id"]),
        order_revision=None if ref["order_revision"] is None else int(ref["order_revision"]),
    )


HANDLERS: dict[str, Callable[..., Any]] = {
    "nexus.library.add": _write(library_add),
    "nexus.note.create": _write(note_create),
    "nexus.highlight.create": _write(highlight_create),
    "nexus.edge.create": _write(edge_create),
    "nexus.queue.add": _write(queue_add),
}
