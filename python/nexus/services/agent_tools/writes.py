"""The Amanuensis: Nexus's five additive write operations plus Undo.

This module is the domain adapter behind the canonical ``nexus.*`` bindings.
Declarations, execution policy, durable replay, and Chat audit persistence live
in ``services.tool_runtime``; this owner performs only the existing authorized
domain mutations and Undo.

Discipline (amanuensis §§2-4):
- Additive only. There are **no** delete/destroy/overwrite tools (N-1) — the
  agent cannot remove or rewrite anything the user made.
- Every write is origin-marked, surfaced in the trust trail, and one-tap
  reversible (``undo_tool_call``); the composed execution owner enforces the
  per-run cap before entering this domain adapter.
- Every mutation runs through the concern's existing sole-writer service; this
  module never raw-inserts.
- Ambiguity is a refusal, never a guess (``text_quote`` → tool error, D-4).

There are no standalone model-write HTTP endpoints. Undo has one route
(``conversations`` §6).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid5

from llm_tools import ToolEffect
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, MessageToolCall
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.notes import DailyCaptureRequest
from nexus.services import highlights, library_entries, note_bodies, notes, text_quote, users
from nexus.services.chat_run_tools import decode_persisted_tool_record
from nexus.services.consumption import _lectern_store
from nexus.services.consumption import service as consumption_service
from nexus.services.passage_anchors import normalize_quote_text
from nexus.services.resource_graph.edges import create_edge, delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate

if TYPE_CHECKING:
    from nexus.services.tool_runtime.declarations import (
        EdgeCreateInput,
        HighlightCreateInput,
        LibraryAddInput,
        NoteCreateInput,
        QueueAddInput,
    )


@dataclass(frozen=True, slots=True)
class WriteEffect:
    created_refs: list[dict[str, Any]]
    output: dict[str, Any]


class WriteToolRefusal(Exception):
    """A reviewed domain refusal translated by the canonical binding."""

    def __init__(self, error_code: str, message: str):
        self.error_code = error_code
        self.message = message
        super().__init__(message)


def _effect_uuid(effect_id: UUID, component: str) -> UUID:
    """Derive one stable sub-effect identity from the journal-owned effect id."""
    return uuid5(effect_id, component)


def _text(value: str, field: str) -> str:
    """Strip and refuse blank: pydantic ``min_length`` admits whitespace."""
    stripped = value.strip()
    if not stripped:
        raise WriteToolRefusal("invalid_arguments", f"{field} must not be blank")
    return stripped


def _parse_ref(raw: str, *, allowed: tuple[str, ...]) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise WriteToolRefusal("invalid_arguments", f"{raw!r} is not a valid resource URI")
    if parsed.scheme not in allowed:
        raise WriteToolRefusal(
            "invalid_arguments",
            f"{raw!r} must be one of {', '.join(allowed)}",
        )
    return parsed


def add_to_library(db: Session, viewer_id: UUID, value: LibraryAddInput) -> WriteEffect:
    """File a resource into a library through the one actor-authorized filing
    command REST also uses (spec S4.3), so the agent path has full parity: system-
    library rejection, podcast-into-Default rejection, active-subscription
    requirement for podcasts, tombstone-clearing, and an idempotent
    inserted-only outcome for Undo correctness (AC4).

    Media readable-or-restorable authorization (rule 1) is the shared filing
    command's own gate
    (`library_entries.ensure_media_in_library_in_current_transaction`) — NOT
    `assert_ref_visible`, which uses full readable visibility and would 404 a
    tombstoned media the viewer is trying to restore by re-filing it. Podcasts
    have no restorable lane, so that branch still asserts visibility here."""
    ref = _parse_ref(_text(value.resource_uri, "resource_uri"), allowed=("media", "podcast"))
    if ref.scheme == "podcast":
        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)

    library_id = _resolve_library_id(db, viewer_id, value)

    if ref.scheme == "media":
        inserted = library_entries.ensure_media_in_library_in_current_transaction(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            media_id=ref.id,
        )
    else:
        inserted = library_entries.place_subscribed_podcast_in_named_library_in_current_transaction(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            podcast_id=ref.id,
        )

    library_name = db.execute(
        text("SELECT name FROM libraries WHERE id = :id"), {"id": library_id}
    ).scalar_one()

    if not inserted:
        # Already filed here (by the user earlier, or a prior run). Record NO ref
        # so a later Undo can never delete a filing the assistant did not create
        # (R-5); the tool still reports success to the model.
        return WriteEffect(
            created_refs=[],
            output={
                "already_present": True,
                "library_name": library_name,
                "library_uri": f"library:{library_id}",
                "resource_uri": ref.uri,
            },
        )

    entry_id = library_entries.entry_id_for_target_in_current_transaction(
        db,
        library_id=library_id,
        target=(
            library_entries.media_target(ref.id)
            if ref.scheme == "media"
            else library_entries.podcast_target(ref.id)
        ),
    )
    if entry_id is None:
        raise AssertionError("added library filing has no durable entry identity")
    created = {
        "kind": "entry",
        "id": str(entry_id),
        "library_id": str(library_id),
        "target_scheme": ref.scheme,
        "target_id": str(ref.id),
        "label": library_name,
    }
    return WriteEffect(
        created_refs=[created],
        output={
            "already_present": False,
            "library_name": library_name,
            "library_uri": f"library:{library_id}",
            "resource_uri": ref.uri,
        },
    )


def _resolve_library_id(db: Session, viewer_id: UUID, value: LibraryAddInput) -> UUID:
    if value.library_id is not None:
        return value.library_id
    name = value.library_name
    if not name:
        raise WriteToolRefusal(
            "invalid_arguments", "Provide library_id or library_name to file into"
        )
    rows = db.execute(
        text(
            """
            SELECT l.id
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE lower(l.name) = lower(:name)
            """
        ),
        {"viewer_id": viewer_id, "name": name.strip()},
    ).fetchall()
    if not rows:
        raise WriteToolRefusal("library_not_found", f"No library named {name!r}")
    if len(rows) > 1:
        raise WriteToolRefusal(
            "library_ambiguous", f"More than one library named {name!r}; use library_id"
        )
    return rows[0][0]


def create_note(
    db: Session,
    viewer_id: UUID,
    effect_id: UUID,
    value: NoteCreateInput,
) -> WriteEffect:
    body_pm_json = note_bodies.pm_doc_from_markdown_projection(_text(value.markdown, "markdown"))
    note_id = _effect_uuid(effect_id, "nexus.note.create:note_block")
    page_uri = value.page_uri
    if page_uri:
        page_ref = _parse_ref(page_uri, allowed=("page",))
        block = notes.append_note_block_to_page_in_current_transaction(
            db,
            viewer_id,
            page_id=page_ref.id,
            note_id=note_id,
            body_pm_json=body_pm_json,
        )
        note_id = block.id
        page_label = "page"
    else:
        local_date = users.calendar_local_date(db, viewer_id)
        notes.capture_daily_page_note_in_current_transaction(
            db,
            viewer_id,
            local_date=local_date,
            request=DailyCaptureRequest(
                note_id=note_id,
                client_mutation_id=(
                    f"assistant:{_effect_uuid(effect_id, 'nexus.note.create:daily_capture')}"
                ),
                body_pm_json=body_pm_json,
            ),
            page_id_candidate=_effect_uuid(effect_id, "nexus.note.create:daily_page"),
        )
        page_label = "today's note"
    created = {"kind": "note_block", "id": str(note_id), "label": page_label}
    return WriteEffect(
        created_refs=[created],
        output={"note_uri": f"note_block:{note_id}", "page_uri": page_uri},
    )


def create_highlight(
    db: Session,
    viewer_id: UUID,
    effect_id: UUID,
    value: HighlightCreateInput,
) -> WriteEffect:
    media_ref = _parse_ref(_text(value.media_uri, "media_uri"), allowed=("media",))
    assert_ref_visible(db, viewer_id=viewer_id, ref=media_ref)
    exact = _text(value.exact, "exact")

    match = text_quote.resolve_owner_quote(
        db,
        owner_scheme="media",
        owner_id=media_ref.id,
        exact=normalize_quote_text(exact),
        prefix=normalize_quote_text(value.prefix or ""),
        suffix=normalize_quote_text(value.suffix or ""),
    )
    if match.status is not text_quote.QuoteStatus.unique:
        raise WriteToolRefusal(
            {
                text_quote.QuoteStatus.ambiguous: "quote_ambiguous",
                text_quote.QuoteStatus.no_match: "quote_not_found",
                text_quote.QuoteStatus.empty_exact: "invalid_arguments",
            }[match.status],
            {
                text_quote.QuoteStatus.ambiguous: (
                    "That passage appears more than once; add prefix/suffix (the text "
                    "immediately before/after) or quote more surrounding text."
                ),
                text_quote.QuoteStatus.no_match: (
                    "That exact passage was not found in the document; quote it verbatim."
                ),
                text_quote.QuoteStatus.empty_exact: "exact must be non-empty.",
            }[match.status],
        )

    assert match.fragment_id is not None
    assert match.raw_start is not None
    assert match.raw_end is not None
    highlight = highlights.create_fragment_highlight_in_txn(
        db,
        viewer_id=viewer_id,
        highlight_id=_effect_uuid(effect_id, "nexus.highlight.create:highlight"),
        fragment_id=match.fragment_id,
        start_offset=match.raw_start,
        end_offset=match.raw_end,
        color=value.color or "yellow",
    )
    created_refs: list[dict[str, Any]] = [
        {"kind": "highlight", "id": str(highlight.id), "label": exact}
    ]
    note = value.note
    if note and note.strip():
        block = notes.set_highlight_note_body_pm_json_in_current_transaction(
            db,
            viewer_id,
            highlight_id=highlight.id,
            block_id=_effect_uuid(effect_id, "nexus.highlight.create:note_block"),
            body_pm_json=note_bodies.pm_doc_from_markdown_projection(note),
            client_mutation_id=(
                f"assistant:{_effect_uuid(effect_id, 'nexus.highlight.create:note_mutation')}"
            ),
        )
        created_refs.append({"kind": "note_block", "id": str(block.id), "label": "highlight note"})
    note_uri = next(
        (f"note_block:{ref['id']}" for ref in created_refs if ref["kind"] == "note_block"),
        None,
    )
    return WriteEffect(
        created_refs=created_refs,
        output={
            "exact": exact,
            "highlight_uri": f"highlight:{highlight.id}",
            "note_uri": note_uri,
        },
    )


def create_assistant_edge(db: Session, viewer_id: UUID, value: EdgeCreateInput) -> WriteEffect:
    endpoints = ("media", "page", "note_block", "highlight")
    source = _parse_ref(_text(value.source_uri, "source_uri"), allowed=endpoints)
    target = _parse_ref(_text(value.target_uri, "target_uri"), allowed=endpoints)
    rationale = _text(value.rationale, "rationale")
    kind = value.kind or "context"

    edge = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=source,
            target=target,
            kind=kind,
            origin="assistant",
            snapshot=CitationSnapshot(excerpt=rationale),
        ),
    )
    # Endpoint labels for the "Connected A ↔ B" trail row (§2/§7); the endpoints
    # are already proven visible by create_edge's assertions.
    labels = resolve_refs(db, viewer_id=viewer_id, refs=[source, target])
    created = {
        "kind": "edge",
        "id": str(edge.id),
        "source_ref": source.uri,
        "target_ref": target.uri,
        "source_label": labels[0].label,
        "target_label": labels[1].label,
        "rationale": rationale,
        "label": rationale,
    }
    return WriteEffect(
        created_refs=[created],
        output={
            "edge_id": str(edge.id),
            "kind": kind,
            "rationale": rationale,
            "source_uri": source.uri,
            "target_uri": target.uri,
        },
    )


def add_to_queue(db: Session, viewer_id: UUID, value: QueueAddInput) -> WriteEffect:
    media_ref = _parse_ref(_text(value.media_uri, "media_uri"), allowed=("media",))
    assert_ref_visible(db, viewer_id=viewer_id, ref=media_ref)
    # Trusted ensure: append the row at Last if absent, never move an existing row
    # (idempotent re-add). Only its lock-owned inserted receipt grants Undo
    # ownership; an unlocked pre-read can race a concurrent manual insertion.
    inserted = consumption_service.ensure_missing_items_for_assistant_in_current_transaction(
        db,
        viewer_id=viewer_id,
        media_ids=[media_ref.id],
    )
    resolved = _lectern_store.find_item_for_media(db, viewer_id=viewer_id, media_id=media_ref.id)
    if resolved is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    item_id, title = resolved
    if len(inserted) > 1:
        raise AssertionError("single-item queue ensure inserted more than one row")
    if inserted and inserted[0] != (media_ref.id, item_id):
        raise AssertionError("queue ensure returned a different inserted item")
    was_inserted = bool(inserted)
    created_refs = [{"kind": "queue", "id": str(item_id), "label": title}] if was_inserted else []
    return WriteEffect(
        created_refs=created_refs,
        output={
            "already_present": not was_inserted,
            "media_uri": media_ref.uri,
            "queue_entry_id": str(item_id),
            "title": title,
        },
    )


# ---------------------------------------------------------------------------
# Undo
# ---------------------------------------------------------------------------


def undo_tool_call(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, tool_call_id: UUID
) -> UUID:
    """Revert one write tool call's created refs; stamp ``reverted_at``.

    Owner-gated on the conversation and scoped to it (§6): 404 if the row is not a
    write tool of *this* conversation that the viewer owns. Idempotent: an
    already-reverted row is a no-op success. Each revert tolerates an
    already-absent target (the user may have deleted it manually, R-5). Returns
    the ``assistant_message_id`` so the route can rebuild the trail.
    """
    row = db.scalar(
        select(MessageToolCall)
        .join(Conversation, Conversation.id == MessageToolCall.conversation_id)
        .where(
            MessageToolCall.id == tool_call_id,
            MessageToolCall.conversation_id == conversation_id,
            Conversation.owner_user_id == viewer_id,
        )
    )
    if row is None:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "Write tool call not found")
    record = decode_persisted_tool_record(row)
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

    declaration = CHAT_TOOL_DECLARATIONS_BY_ID.get(record.canonical_tool_id or "")
    if declaration is None or declaration.spec.effect is not ToolEffect.Write:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "Write tool call not found")

    assistant_message_id = row.assistant_message_id
    if row.reverted_at is not None:
        return assistant_message_id

    for ref in row.result_refs or []:
        _revert_ref(db, viewer_id=viewer_id, ref=ref)

    reverted_at = datetime.now(UTC)
    row.reverted_at = reverted_at
    row.updated_at = reverted_at
    db.commit()
    return assistant_message_id


def _revert_ref(db: Session, *, viewer_id: UUID, ref: dict[str, Any]) -> None:
    kind = ref.get("kind")
    try:
        if kind == "edge":
            delete_edge(db, viewer_id=viewer_id, edge_id=UUID(ref["id"]))
            db.commit()
        elif kind == "entry":
            target_scheme = ref["target_scheme"]
            if target_scheme == "media":
                library_entries.remove_media_from_library(
                    db,
                    viewer_id,
                    UUID(ref["target_id"]),
                    UUID(ref["library_id"]),
                    allow_default=True,
                )
            elif target_scheme == "podcast":
                library_entries.undo_podcast_filing_for_viewer_in_current_transaction(
                    db,
                    viewer_id=viewer_id,
                    library_id=UUID(ref["library_id"]),
                    podcast_id=UUID(ref["target_id"]),
                )
            else:
                # justify-defect: add_to_library records only the closed media/podcast
                # ResourceRef union in its own result_refs payload.
                raise AssertionError(f"unknown entry target scheme: {target_scheme!r}")
        elif kind == "highlight":
            highlights.delete_highlight(db, viewer_id, UUID(ref["id"]))
        elif kind == "note_block":
            notes.remove_note_block(db, viewer_id, UUID(ref["id"]))
        elif kind == "queue":
            # Tolerates an already-removed Lectern item (manual removal, R-5).
            consumption_service.remove_lectern_item(viewer_id, UUID(ref["id"]))
    except ApiError as exc:
        if exc.code not in {
            ApiErrorCode.E_NOT_FOUND,
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            ApiErrorCode.E_LIBRARY_NOT_FOUND,
        }:
            raise
        # justify-ignore-error: R-5 defines an already-removed Undo target as success.
        db.rollback()
