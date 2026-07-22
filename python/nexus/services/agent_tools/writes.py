"""The Amanuensis: the house agent's five additive write tools + undo.

The sole writer of ``origin='assistant'`` resource edges and the single owner of
every assistant-authored mutation (library entries, note blocks, highlights,
queue items). Tool *definitions* (the ToolSpec dicts) co-locate with their
executors here, mirroring ``app_search`` (amanuensis D-7).

Discipline (amanuensis §§2-4):
- Additive only. There are **no** delete/destroy/overwrite tools (N-1) — the
  agent cannot remove or rewrite anything the user made.
- Every write is capped per run (``ASSISTANT_MAX_WRITES_PER_RUN``), origin-marked,
  surfaced in the trust trail, and one-tap reversible (``undo_tool_call``).
- Every mutation runs through the concern's existing sole-writer service; this
  module never raw-inserts.
- Ambiguity is a refusal, never a guess (``text_quote`` → tool error, D-4).

The only caller is the chat tool loop (``chat_runs``); there are no standalone
HTTP write endpoints (N-7, R-1). Undo has one route (``conversations`` §6).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ChatRun
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.highlights import CreateHighlightRequest
from nexus.schemas.notes import QuickCaptureRequest
from nexus.services import highlights, library_entries, notes, text_quote
from nexus.services.chat_run_tools import (
    assistant_write_tool_call_count,
    persist_write_tool_call,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.resource_graph.edges import create_edge, delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import assert_ref_visible, resolve_refs
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate

# The hard per-run write cap (amanuensis D-6). Counts committed write tool calls
# for the assistant message whose ``reverted_at IS NULL`` — undo reclaims budget
# (AC-9). On the ninth the tool refuses.
ASSISTANT_MAX_WRITES_PER_RUN = 8

ADD_TO_LIBRARY_TOOL_NAME = "add_to_library"
JOT_NOTE_TOOL_NAME = "jot_note"
CREATE_HIGHLIGHT_TOOL_NAME = "create_highlight"
MINT_EDGE_TOOL_NAME = "mint_edge"
QUEUE_ADD_TOOL_NAME = "queue_add"

WRITE_TOOL_NAMES: tuple[str, ...] = (
    ADD_TO_LIBRARY_TOOL_NAME,
    JOT_NOTE_TOOL_NAME,
    CREATE_HIGHLIGHT_TOOL_NAME,
    MINT_EDGE_TOOL_NAME,
    QUEUE_ADD_TOOL_NAME,
)

_EDGE_KINDS = ("context", "supports", "contradicts")

# Parameter schemas follow the canonical JSON-Schema subset (llm-provider-runtime
# hard cutover §5): every property is listed in ``required`` with
# ``additionalProperties: false``, and semantically optional values are
# required-nullable ``anyOf [X, {"type": "null"}]``. Executors treat an explicit
# null exactly like an omitted key (all argument reads go through ``args.get``),
# and defaults (highlight color yellow, edge kind context) live in the execute
# path, never in the schema.
ASSISTANT_WRITE_TOOL_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {
        "name": ADD_TO_LIBRARY_TOOL_NAME,
        "description": (
            "File a resource into one of the user's libraries when they ask you to "
            "(e.g. 'file this under Criticism'). resource_uri is a media: or podcast: "
            "URI; identify the library by library_id or its exact library_name. Only "
            "libraries the user administers are writable, and system libraries are "
            "never writable. A podcast cannot be filed into the Default library. "
            "Filing a podcast requires an active subscription to it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "resource_uri": {
                    "type": "string",
                    "description": "media:<uuid> or podcast:<uuid> to file.",
                },
                "library_id": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": "Target library UUID; null when filing by library_name.",
                },
                "library_name": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": (
                        "Target library name (exact, case-insensitive); "
                        "null when filing by library_id."
                    ),
                },
            },
            "required": ["resource_uri", "library_id", "library_name"],
            "additionalProperties": False,
        },
    },
    {
        "name": JOT_NOTE_TOOL_NAME,
        "description": (
            "Append a note the user dictates to their daily note, or to a specific "
            "page when page_uri is given. markdown is the note text; the words are the "
            "user's own."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "markdown": {"type": "string", "description": "The note text (markdown)."},
                "page_uri": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": "page:<uuid> to append to; null for today's daily note.",
                },
            },
            "required": ["markdown", "page_uri"],
            "additionalProperties": False,
        },
    },
    {
        "name": CREATE_HIGHLIGHT_TOOL_NAME,
        "description": (
            "Dog-ear an exact passage of a document the user is discussing. media_uri "
            "is the document; exact is the passage verbatim. If exact occurs more than "
            "once, add prefix/suffix (the text immediately before/after) to make it "
            "unique — an ambiguous quote is refused, so quote more surrounding text "
            "rather than guessing. An optional note attaches a highlight note."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "media_uri": {"type": "string", "description": "media:<uuid> to highlight in."},
                "exact": {"type": "string", "description": "The passage, verbatim."},
                "prefix": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": (
                        "Text immediately before the passage (to disambiguate); "
                        "null when exact is already unique."
                    ),
                },
                "suffix": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": (
                        "Text immediately after the passage (to disambiguate); "
                        "null when exact is already unique."
                    ),
                },
                "color": {
                    "anyOf": [
                        {
                            "type": "string",
                            "enum": ["yellow", "green", "blue", "pink", "purple"],
                        },
                        {"type": "null"},
                    ],
                    "description": "Highlight color; null for the default (yellow).",
                },
                "note": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                    "description": "Optional highlight note (markdown); null for none.",
                },
            },
            "required": ["media_uri", "exact", "prefix", "suffix", "color", "note"],
            "additionalProperties": False,
        },
    },
    {
        "name": MINT_EDGE_TOOL_NAME,
        "description": (
            "Connect two of the user's resources when they ask you to relate them "
            "(e.g. 'connect these two'). source_uri and target_uri are among "
            "media:/page:/note_block:/highlight: URIs. kind is context (default), "
            "supports, or contradicts. rationale is your one-line reason for the link."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source_uri": {"type": "string", "description": "One endpoint URI."},
                "target_uri": {"type": "string", "description": "The other endpoint URI."},
                "kind": {
                    "anyOf": [
                        {"type": "string", "enum": list(_EDGE_KINDS)},
                        {"type": "null"},
                    ],
                    "description": "Relationship kind; null for the default (context).",
                },
                "rationale": {
                    "type": "string",
                    "description": "One-line reason for the connection.",
                },
            },
            "required": ["source_uri", "target_uri", "kind", "rationale"],
            "additionalProperties": False,
        },
    },
    {
        "name": QUEUE_ADD_TOOL_NAME,
        "description": (
            "Add a media item to the user's consumption queue to read or listen to "
            "next (e.g. 'queue this to read next'). media_uri is a media: URI."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "media_uri": {"type": "string", "description": "media:<uuid> to queue."},
            },
            "required": ["media_uri"],
            "additionalProperties": False,
        },
    },
)


def assistant_write_tool_definitions() -> tuple[dict[str, Any], ...]:
    """The five ToolSpec dicts, gated by the flag (amanuensis AC-6)."""
    if not get_settings().assistant_write_tools_enabled:
        return ()
    return ASSISTANT_WRITE_TOOL_DEFINITIONS


@dataclass(frozen=True, slots=True)
class _HandlerResult:
    created_refs: list[dict[str, Any]]
    output: dict[str, Any]


@dataclass(frozen=True, slots=True)
class WriteToolOutcome:
    tool_call_id: UUID
    created_refs: list[dict[str, Any]]
    tool_output_json: str
    status: str
    error_code: str | None = field(default=None)

    @property
    def is_error(self) -> bool:
        return self.status == "error"


class _ToolRefusal(Exception):
    """A tool-level refusal (bad args, ambiguity, cap) rendered to the model."""

    def __init__(self, error_code: str, message: str):
        self.error_code = error_code
        self.message = message
        super().__init__(message)


def execute_write_tool(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    args: dict[str, Any],
) -> WriteToolOutcome:
    """Enforce the cap, dispatch to the handler, persist the tool row.

    Returns everything the chat loop needs to emit the trust event and append a
    ``ToolResult``. Never raises for a domain/refusal error — those become an
    error tool result (the model reads it and clarifies); only genuine defects
    propagate.
    """
    viewer_id = run.owner_user_id
    try:
        prior = assistant_write_tool_call_count(
            db, assistant_message_id=run.assistant_message_id, tool_names=WRITE_TOOL_NAMES
        )
        if prior >= ASSISTANT_MAX_WRITES_PER_RUN:
            raise _ToolRefusal(
                "write_cap_reached",
                f"Write limit of {ASSISTANT_MAX_WRITES_PER_RUN} per turn reached; "
                "no further writes this turn.",
            )
        result = _dispatch(db, viewer_id=viewer_id, tool_name=tool_name, args=args)
    except _ToolRefusal as refusal:
        output = {"error": refusal.message, "error_code": refusal.error_code}
        tool_call_id = persist_write_tool_call(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_name=tool_name,
            created_refs=[],
            status="error",
            error_code=refusal.error_code,
        )
        db.commit()
        return WriteToolOutcome(
            tool_call_id=tool_call_id,
            created_refs=[],
            tool_output_json=json.dumps(output, default=str),
            status="error",
            error_code=refusal.error_code,
        )
    except ApiError as exc:
        output = {"error": exc.message, "error_code": exc.code.value}
        tool_call_id = persist_write_tool_call(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_name=tool_name,
            created_refs=[],
            status="error",
            error_code=exc.code.value,
        )
        db.commit()
        return WriteToolOutcome(
            tool_call_id=tool_call_id,
            created_refs=[],
            tool_output_json=json.dumps(output, default=str),
            status="error",
            error_code=exc.code.value,
        )

    tool_call_id = persist_write_tool_call(
        db,
        run=run,
        tool_call_index=tool_call_index,
        tool_name=tool_name,
        created_refs=result.created_refs,
        status="complete",
        error_code=None,
    )
    db.commit()
    return WriteToolOutcome(
        tool_call_id=tool_call_id,
        created_refs=result.created_refs,
        tool_output_json=json.dumps(result.output, default=str),
        status="complete",
        error_code=None,
    )


def _dispatch(
    db: Session, *, viewer_id: UUID, tool_name: str, args: dict[str, Any]
) -> _HandlerResult:
    if tool_name == ADD_TO_LIBRARY_TOOL_NAME:
        return _add_to_library(db, viewer_id, args)
    if tool_name == JOT_NOTE_TOOL_NAME:
        return _jot_note(db, viewer_id, args)
    if tool_name == CREATE_HIGHLIGHT_TOOL_NAME:
        return _create_highlight(db, viewer_id, args)
    if tool_name == MINT_EDGE_TOOL_NAME:
        return _mint_edge(db, viewer_id, args)
    if tool_name == QUEUE_ADD_TOOL_NAME:
        return _queue_add(db, viewer_id, args)
    raise _ToolRefusal("unknown_write_tool", f"Unknown write tool {tool_name!r}")


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


def _require_str(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise _ToolRefusal("invalid_arguments", f"{key} is required and must be a non-empty string")
    return value.strip()


def _optional_str(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _ToolRefusal("invalid_arguments", f"{key} must be a string")
    return value


def _parse_ref(raw: str, *, allowed: tuple[str, ...]) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise _ToolRefusal("invalid_arguments", f"{raw!r} is not a valid resource URI")
    if parsed.scheme not in allowed:
        raise _ToolRefusal(
            "invalid_arguments",
            f"{raw!r} must be one of {', '.join(allowed)}",
        )
    return parsed


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _add_to_library(db: Session, viewer_id: UUID, args: dict[str, Any]) -> _HandlerResult:
    """File a resource into a library through the one actor-authorized filing
    command REST also uses (spec S4.3), so the agent path has full parity: system-
    library rejection, podcast-into-Default rejection, active-subscription
    requirement for podcasts, tombstone-clearing, and an idempotent
    inserted-only outcome for Undo correctness (AC4).

    Media readable-or-restorable authorization (rule 1) is the shared filing
    command's own gate (`library_entries.ensure_media_in_library`) — NOT
    `assert_ref_visible`, which uses full readable visibility and would 404 a
    tombstoned media the viewer is trying to restore by re-filing it. Podcasts
    have no restorable lane, so that branch still asserts visibility here."""
    ref = _parse_ref(_require_str(args, "resource_uri"), allowed=("media", "podcast"))
    if ref.scheme == "podcast":
        assert_ref_visible(db, viewer_id=viewer_id, ref=ref)

    library_id = _resolve_library_id(db, viewer_id, args)

    if ref.scheme == "media":
        outcome = library_entries.ensure_media_in_library(db, viewer_id, library_id, ref.id)
    else:
        outcome = library_entries.add_podcast_to_library(db, viewer_id, library_id, ref.id)

    library_name = db.execute(
        text("SELECT name FROM libraries WHERE id = :id"), {"id": library_id}
    ).scalar_one()

    if not outcome.inserted:
        # Already filed here (by the user earlier, or a prior run). Record NO ref
        # so a later Undo can never delete a filing the assistant did not create
        # (R-5); the tool still reports success to the model.
        return _HandlerResult(
            created_refs=[],
            output={
                "filed_to": library_name,
                "library_id": str(library_id),
                "already_present": True,
            },
        )

    created = {
        "kind": "entry",
        "library_id": str(library_id),
        "target_scheme": ref.scheme,
        "target_id": str(ref.id),
        "label": library_name,
    }
    return _HandlerResult(
        created_refs=[created],
        output={"filed_to": library_name, "library_id": str(library_id)},
    )


def _resolve_library_id(db: Session, viewer_id: UUID, args: dict[str, Any]) -> UUID:
    raw_id = _optional_str(args, "library_id")
    if raw_id:
        try:
            return UUID(raw_id)
        except ValueError as exc:
            raise _ToolRefusal("invalid_arguments", "library_id must be a UUID") from exc
    name = _optional_str(args, "library_name")
    if not name:
        raise _ToolRefusal("invalid_arguments", "Provide library_id or library_name to file into")
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
        raise _ToolRefusal("library_not_found", f"No library named {name!r}")
    if len(rows) > 1:
        raise _ToolRefusal(
            "library_ambiguous", f"More than one library named {name!r}; use library_id"
        )
    return rows[0][0]


def _jot_note(db: Session, viewer_id: UUID, args: dict[str, Any]) -> _HandlerResult:
    markdown = _require_str(args, "markdown")
    body_pm_json = notes.pm_doc_from_markdown_projection(markdown)
    page_uri = _optional_str(args, "page_uri")
    if page_uri:
        page_ref = _parse_ref(page_uri, allowed=("page",))
        block = notes.append_note_block_to_page(
            db, viewer_id, page_id=page_ref.id, body_pm_json=body_pm_json
        )
        page_label = "page"
    else:
        from uuid import uuid4

        block = notes.quick_capture(
            db,
            viewer_id,
            request=QuickCaptureRequest(
                id=uuid4(),
                client_mutation_id=f"assistant:{uuid4()}",
                body_pm_json=body_pm_json,
                local_date=None,
            ),
        )
        page_label = "today's note"
    created = {"kind": "note_block", "id": str(block.id), "label": page_label}
    return _HandlerResult(
        created_refs=[created],
        output={"noted_in": page_label, "note_block_id": str(block.id)},
    )


def _create_highlight(db: Session, viewer_id: UUID, args: dict[str, Any]) -> _HandlerResult:
    media_ref = _parse_ref(_require_str(args, "media_uri"), allowed=("media",))
    assert_ref_visible(db, viewer_id=viewer_id, ref=media_ref)
    exact = _require_str(args, "exact")
    prefix = _optional_str(args, "prefix")
    suffix = _optional_str(args, "suffix")
    color = _optional_str(args, "color") or "yellow"

    resolution = text_quote.resolve(
        db, media_id=media_ref.id, exact=exact, prefix=prefix, suffix=suffix
    )
    if resolution.status is not text_quote.QuoteStatus.unique:
        raise _ToolRefusal(
            "quote_not_unique",
            {
                text_quote.QuoteStatus.ambiguous: (
                    "That passage appears more than once; add prefix/suffix (the text "
                    "immediately before/after) or quote more surrounding text."
                ),
                text_quote.QuoteStatus.no_match: (
                    "That exact passage was not found in the document; quote it verbatim."
                ),
                text_quote.QuoteStatus.empty_exact: "exact must be non-empty.",
            }[resolution.status],
        )

    assert resolution.fragment_id is not None
    assert resolution.start_offset is not None
    assert resolution.end_offset is not None
    highlight = highlights.create_highlight_for_fragment(
        db,
        viewer_id,
        resolution.fragment_id,
        CreateHighlightRequest(
            start_offset=resolution.start_offset,
            end_offset=resolution.end_offset,
            color=color,  # type: ignore[arg-type]
        ),
    )
    created_refs: list[dict[str, Any]] = [
        {"kind": "highlight", "id": str(highlight.id), "label": exact}
    ]
    note = _optional_str(args, "note")
    if note and note.strip():
        from uuid import uuid4

        block = notes.set_highlight_note_body_pm_json(
            db,
            viewer_id,
            highlight_id=highlight.id,
            block_id=uuid4(),
            body_pm_json=notes.pm_doc_from_markdown_projection(note),
            client_mutation_id=f"assistant:{uuid4()}",
        )
        created_refs.append({"kind": "note_block", "id": str(block.id), "label": "highlight note"})
    return _HandlerResult(
        created_refs=created_refs,
        output={"highlighted": exact, "highlight_id": str(highlight.id)},
    )


def _mint_edge(db: Session, viewer_id: UUID, args: dict[str, Any]) -> _HandlerResult:
    endpoints = ("media", "page", "note_block", "highlight")
    source = _parse_ref(_require_str(args, "source_uri"), allowed=endpoints)
    target = _parse_ref(_require_str(args, "target_uri"), allowed=endpoints)
    rationale = _require_str(args, "rationale")
    kind = _optional_str(args, "kind") or "context"
    if kind not in _EDGE_KINDS:
        raise _ToolRefusal("invalid_arguments", f"kind must be one of {', '.join(_EDGE_KINDS)}")

    edge = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=source,
            target=target,
            kind=kind,  # type: ignore[arg-type]
            origin="assistant",
            snapshot=CitationSnapshot(excerpt=rationale),
        ),
    )
    db.commit()
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
    return _HandlerResult(
        created_refs=[created],
        output={"connected": [source.uri, target.uri], "edge_id": str(edge.id)},
    )


def _queue_add(db: Session, viewer_id: UUID, args: dict[str, Any]) -> _HandlerResult:
    media_ref = _parse_ref(_require_str(args, "media_uri"), allowed=("media",))
    # Trusted ensure: append the row at Last if absent, never move an existing row
    # (idempotent re-add). The item echoed for undo is the resulting Lectern row,
    # whether newly ensured or already present.
    consumption_service.ensure_missing_items(viewer_id, [media_ref.id], source="Assistant")
    resolved = consumption_service.get_lectern_item_for_media(
        db, viewer_id=viewer_id, media_id=media_ref.id
    )
    if resolved is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    item_id, title = resolved
    created = {"kind": "queue", "id": str(item_id), "label": title}
    return _HandlerResult(
        created_refs=[created],
        output={"queued": title, "queue_item_id": str(item_id)},
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
    row = (
        db.execute(
            text(
                """
            SELECT mtc.id, mtc.tool_name, mtc.result_refs, mtc.reverted_at,
                   mtc.assistant_message_id
            FROM message_tool_calls mtc
            JOIN conversations c ON c.id = mtc.conversation_id
            WHERE mtc.id = :tool_call_id
              AND mtc.conversation_id = :conversation_id
              AND c.owner_user_id = :viewer_id
            """
            ),
            {
                "tool_call_id": tool_call_id,
                "conversation_id": conversation_id,
                "viewer_id": viewer_id,
            },
        )
        .mappings()
        .fetchone()
    )
    if row is None or row["tool_name"] not in WRITE_TOOL_NAMES:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "Write tool call not found")

    assistant_message_id: UUID = row["assistant_message_id"]
    if row["reverted_at"] is not None:
        return assistant_message_id

    for ref in row["result_refs"] or []:
        _revert_ref(db, viewer_id=viewer_id, ref=ref)

    db.execute(
        text(
            "UPDATE message_tool_calls SET reverted_at = now(), updated_at = now() WHERE id = :id"
        ),
        {"id": tool_call_id},
    )
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
                library_entries.undo_media_filing_for_viewer(
                    db,
                    viewer_id,
                    UUID(ref["target_id"]),
                    UUID(ref["library_id"]),
                )
            elif target_scheme == "podcast":
                library_entries.remove_podcast_from_library(
                    db,
                    viewer_id,
                    UUID(ref["library_id"]),
                    UUID(ref["target_id"]),
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
