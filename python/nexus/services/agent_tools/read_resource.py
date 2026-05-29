"""Provider-neutral read-resource tool execution for chat.

The chat pipeline uses this tool to let the model fetch the full body of a
resource that already appears in the conversation's references. Bodies above
the resolver's inline threshold are pointer-only in the prompt; this tool is
the model's escape hatch for fetching them in full.

Body loading is duplicated here per scheme rather than extending
``resource_resolver`` with a parallel full-body code path: the per-scheme
``SELECT``s are small, and avoiding a second resolver entry point keeps the
threshold logic in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
)
from nexus.coerce import parse_uuid

READ_RESOURCE_TOOL_NAME = "read_resource"

READ_RESOURCE_TOOL_DEFINITION: dict[str, Any] = {
    "name": READ_RESOURCE_TOOL_NAME,
    "description": (
        "Fetch the full content of a resource that appears in <resources> in your "
        "system context. Accepts a resource URI such as 'span:UUID', 'chunk:UUID', "
        "'highlight:UUID', 'page:UUID', 'note_block:UUID', 'fragment:UUID', "
        "'message:UUID', or 'conversation:UUID'. Not valid for 'media:UUID' or "
        "'library:UUID' — those are search scopes; use app_search with scopes=[...]"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "uri": {"type": "string", "description": "Resource URI to read."},
        },
        "required": ["uri"],
    },
}


@dataclass(slots=True)
class ReadResourceResult:
    """Executed read-resource tool call.

    ``body`` carries the full text on success or a model-readable error
    description on failure. ``tool_output`` renders both cases into the XML
    payload returned to the LLM.
    """

    uri: str
    status: Literal["complete", "error"]
    body: str
    error_code: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status == "error"

    def tool_output(self) -> str:
        if self.status == "error":
            return (
                f'<resource_error uri="{xml_escape(self.uri)}" '
                f'code="{xml_escape(self.error_code or "")}">'
                f"{xml_escape(self.body)}"
                f"</resource_error>"
            )
        return (
            f'<resource uri="{xml_escape(self.uri)}">'
            f"<body>{xml_escape(self.body)}</body>"
            f"</resource>"
        )


def execute_read_resource(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    uri: str,
) -> ReadResourceResult:
    """Read the full body of a referenced resource for a chat turn."""

    reference_row = db.execute(
        text(
            """
            SELECT 1
            FROM conversation_references
            WHERE conversation_id = :conversation_id
              AND resource_uri = :resource_uri
            """
        ),
        {"conversation_id": conversation_id, "resource_uri": uri},
    ).first()
    if reference_row is None:
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=(
                f"Resource {uri} is not in this conversation's references. "
                "Use app_search to find new sources first."
            ),
            error_code="not_in_references",
        )

    scheme, sep, ident = uri.partition(":")
    if not sep:
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=f"Resource URI {uri} is malformed.",
            error_code="invalid_uri",
        )

    if scheme == "media" or scheme == "library":
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=(
                f"Resource {uri} is a search scope, not a readable resource. "
                f'Call app_search(query=..., scopes=["{uri}"]) instead.'
            ),
            error_code="scope_not_readable",
        )

    resource_id = parse_uuid(ident)
    if resource_id is None:
        return ReadResourceResult(
            uri=uri,
            status="error",
            body=f"Resource URI {uri} has an invalid identifier.",
            error_code="invalid_uri",
        )

    if scheme == "span":
        return _read_span(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "chunk":
        return _read_chunk(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "highlight":
        return _read_highlight(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "page":
        return _read_page(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "note_block":
        return _read_note_block(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "fragment":
        return _read_fragment(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "conversation":
        return _read_conversation(db, uri, resource_id, viewer_id=viewer_id)
    if scheme == "message":
        return _read_message(db, uri, resource_id, viewer_id=viewer_id)
    return ReadResourceResult(
        uri=uri,
        status="error",
        body=f"Resource URI scheme '{scheme}' is not supported.",
        error_code="unknown_scheme",
    )


def _missing(uri: str) -> ReadResourceResult:
    return ReadResourceResult(
        uri=uri,
        status="error",
        body=f"Resource {uri} is unavailable or you do not have access to it.",
        error_code="missing",
    )


def _read_span(
    db: Session,
    uri: str,
    span_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT es.media_id, es.span_text
            FROM evidence_spans es
            WHERE es.id = :id
            """
        ),
        {"id": span_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[1] or ""))


def _read_chunk(
    db: Session,
    uri: str,
    chunk_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT cc.media_id, cc.chunk_text
            FROM content_chunks cc
            WHERE cc.id = :id
            """
        ),
        {"id": chunk_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[1] or ""))


def _read_highlight(
    db: Session,
    uri: str,
    highlight_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT exact
            FROM highlights
            WHERE id = :id
            """
        ),
        {"id": highlight_id},
    ).first()
    if row is None or not can_read_highlight(db, viewer_id, highlight_id):
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[0] or ""))


def _read_page(
    db: Session,
    uri: str,
    page_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT user_id, description
            FROM pages
            WHERE id = :id
            """
        ),
        {"id": page_id},
    ).first()
    if row is None or row[0] != viewer_id:
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[1] or ""))


def _read_note_block(
    db: Session,
    uri: str,
    block_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT user_id, body_text
            FROM note_blocks
            WHERE id = :id
            """
        ),
        {"id": block_id},
    ).first()
    if row is None or row[0] != viewer_id:
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[1] or ""))


def _read_fragment(
    db: Session,
    uri: str,
    fragment_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT media_id, canonical_text
            FROM fragments
            WHERE id = :id
            """
        ),
        {"id": fragment_id},
    ).first()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return _missing(uri)
    return ReadResourceResult(uri=uri, status="complete", body=str(row[1] or ""))


def _read_conversation(
    db: Session,
    uri: str,
    target_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    """Read a conversation: returns a summary, not the full transcript.

    Per the spec, ``read_resource("conversation:UUID")`` returns a summary;
    deeper inspection requires ``app_search``.
    """

    row = db.execute(
        text(
            """
            SELECT
                c.title,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
                    AS message_count
            FROM conversations c
            WHERE c.id = :id
            """
        ),
        {"id": target_id},
    ).first()
    if row is None or not can_read_conversation(db, viewer_id, target_id):
        return _missing(uri)
    title = str(row[0] or "").strip() or "Untitled conversation"
    message_count = int(row[1] or 0)
    body = f"{title}\nChat history with {message_count} messages."
    return ReadResourceResult(uri=uri, status="complete", body=body)


def _read_message(
    db: Session,
    uri: str,
    message_id: UUID,
    *,
    viewer_id: UUID,
) -> ReadResourceResult:
    row = db.execute(
        text(
            """
            SELECT conversation_id, role, content
            FROM messages
            WHERE id = :id
              AND status != 'pending'
            """
        ),
        {"id": message_id},
    ).first()
    if row is None or not can_read_conversation(db, viewer_id, row[0]):
        return _missing(uri)
    role = str(row[1])
    content = str(row[2] or "")
    body = f"{role}:\n{content}"
    return ReadResourceResult(uri=uri, status="complete", body=body)
