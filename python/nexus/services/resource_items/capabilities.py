"""What each kind of resource can take part in: one row per scheme.

`resource_graph.refs` owns identity grammar. This table owns link, share, read,
search, citation, prompt, embed, attach, adjacency, expansion and inspector
policy. Rows list only what differs from the defaults. Change a row, run
`make generate-resource-capabilities`, and python and the web agree.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, assert_never
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_visibility_filter
from nexus.db.models import Highlight
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

ShareMode = Literal["None", "CopyOnly", "ResourceGrants", "HighlightGrants", "LibraryMembership"]
LinkMode = Literal["none", "direct", "materialize_passage"]
InspectorRole = Literal["Contents", "LinkedItems", "Forks", "Dossier"]


@dataclass(frozen=True, slots=True)
class InspectorPolicy:
    linked_items: Literal["MediaEvidence", "ResourceConnections"]
    forks: Literal["ConversationForks"] | None
    # Fallback preference, not tab order; ends in the always-published Dossier.
    default_surface_order: tuple[InspectorRole, ...]


_CONNECTIONS = InspectorPolicy("ResourceConnections", None, ("Dossier",))


@dataclass(frozen=True, slots=True)
class Capability:
    sharing: ShareMode = "None"
    link_mode: LinkMode = "direct"
    attachable: bool = True
    embeddable: bool = True
    chat_subject: Literal["none", "label", "scope", "readable", "quote", "generated_output"] = (
        "readable"
    )
    readable: Literal["none", "scope", "body", "media"] = "body"
    inspectable: Literal["none", "media_document_map"] = "none"
    inspector: InspectorPolicy | None = None
    citable_result_type: str | None = None
    app_search_scope: bool = False
    citation_output_source: bool = False
    prompt_render: Literal["none", "label", "inline_body", "quote"] = "inline_body"
    expansion: Literal[
        "none",
        "media_owned_reader_children",
        "page_note_blocks",
        "note_block_owned_evidence",
        "artifact_revisions",
    ] = "none"
    adjacency_source: bool = False


CAPABILITIES: dict[ResourceScheme, Capability] = {
    "media": Capability(
        sharing="ResourceGrants",
        readable="media",
        inspectable="media_document_map",
        inspector=InspectorPolicy("MediaEvidence", None, ("Contents", "LinkedItems", "Dossier")),
        citable_result_type="media",
        app_search_scope=True,
        prompt_render="label",
        expansion="media_owned_reader_children",
    ),
    "library": Capability(
        sharing="LibraryMembership",
        chat_subject="scope",
        readable="scope",
        inspector=_CONNECTIONS,
        app_search_scope=True,
        prompt_render="label",
    ),
    "evidence_span": Capability(
        link_mode="materialize_passage", embeddable=False, citable_result_type="evidence_span"
    ),
    "content_chunk": Capability(
        link_mode="materialize_passage", embeddable=False, citable_result_type="content_chunk"
    ),
    "highlight": Capability(
        sharing="HighlightGrants",
        chat_subject="quote",
        citable_result_type="highlight",
        prompt_render="quote",
    ),
    "page": Capability(
        sharing="CopyOnly",
        inspector=_CONNECTIONS,
        citable_result_type="page",
        expansion="page_note_blocks",
        adjacency_source=True,
    ),
    "note_block": Capability(
        sharing="CopyOnly",
        inspector=_CONNECTIONS,
        citable_result_type="note_block",
        expansion="note_block_owned_evidence",
        adjacency_source=True,
    ),
    "fragment": Capability(
        link_mode="materialize_passage", embeddable=False, citable_result_type="fragment"
    ),
    "conversation": Capability(
        sharing="CopyOnly",
        chat_subject="label",
        inspector=InspectorPolicy(
            "ResourceConnections", "ConversationForks", ("LinkedItems", "Forks", "Dossier")
        ),
        prompt_render="label",
    ),
    "message": Capability(citable_result_type="message", citation_output_source=True),
    "oracle_reading": Capability(
        sharing="CopyOnly", chat_subject="generated_output", citation_output_source=True
    ),
    "oracle_passage_anchor": Capability(
        link_mode="materialize_passage", attachable=False, embeddable=False, chat_subject="none"
    ),
    "artifact": Capability(
        sharing="CopyOnly", chat_subject="generated_output", expansion="artifact_revisions"
    ),
    "artifact_revision": Capability(
        link_mode="none", chat_subject="generated_output", citation_output_source=True
    ),
    "external_snapshot": Capability(
        link_mode="none",
        attachable=False,
        embeddable=False,
        chat_subject="none",
        readable="none",
        citable_result_type="web_result",
        prompt_render="none",
    ),
    "contributor": Capability(
        sharing="CopyOnly",
        chat_subject="label",
        readable="none",
        inspector=_CONNECTIONS,
        prompt_render="label",
    ),
    "podcast": Capability(
        sharing="CopyOnly",
        chat_subject="label",
        readable="none",
        inspector=_CONNECTIONS,
        prompt_render="label",
    ),
    "reader_apparatus_item": Capability(
        link_mode="materialize_passage",
        embeddable=False,
        citable_result_type="reader_apparatus_item",
    ),
    "passage_anchor": Capability(chat_subject="quote", prompt_render="quote"),
}


def capability(scheme: ResourceScheme) -> Capability:
    return CAPABILITIES[scheme]


def app_search_scope_hint() -> str:
    return ", ".join(f"{s}:UUID" for s, c in CAPABILITIES.items() if c.app_search_scope)


def expand_owned_child_refs(
    db: Session, *, viewer_id: UUID, ref: ResourceRef
) -> tuple[ResourceRef, ...]:
    """The refs an owner rolls up (connections, discovery)."""
    match capability(ref.scheme).expansion:
        case "none":
            return ()
        case "media_owned_reader_children":
            highlight_ids = db.scalars(
                select(Highlight.id)
                .where(Highlight.anchor_media_id == ref.id)
                .where(highlight_visibility_filter(viewer_id, ref.id))
                .distinct()
            )
            return (
                *_children(db, "evidence_span", _OWNED.format("evidence_spans", "media"), ref.id),
                *_children(db, "content_chunk", _OWNED.format("content_chunks", "media"), ref.id),
                *_children(db, "fragment", "SELECT id FROM fragments WHERE media_id = :id", ref.id),
                *(ResourceRef(scheme="highlight", id=h) for h in highlight_ids),
                *_children(
                    db,
                    "reader_apparatus_item",
                    "SELECT id FROM reader_apparatus_items WHERE media_id = :id",
                    ref.id,
                ),
                *_children(db, "passage_anchor", _MEDIA_ANCHORS, ref.id, viewer_id=viewer_id),
            )
        case "page_note_blocks":
            return _children(db, "note_block", _PAGE_NOTE_BLOCKS, ref.id, viewer_id=viewer_id)
        case "note_block_owned_evidence":
            return (
                *_children(
                    db, "evidence_span", _OWNED.format("evidence_spans", "note_block"), ref.id
                ),
                *_children(
                    db, "content_chunk", _OWNED.format("content_chunks", "note_block"), ref.id
                ),
            )
        case "artifact_revisions":
            return _children(
                db,
                "artifact_revision",
                "SELECT revision_id FROM artifacts WHERE id = :id AND revision_id IS NOT NULL",
                ref.id,
            )
        case _ as unreachable:
            assert_never(unreachable)


def _children(
    db: Session, scheme: ResourceScheme, sql: str, parent_id: UUID, *, viewer_id: UUID | None = None
) -> tuple[ResourceRef, ...]:
    params = {"id": parent_id} if viewer_id is None else {"id": parent_id, "viewer_id": viewer_id}
    return tuple(ResourceRef(scheme=scheme, id=row[0]) for row in db.execute(text(sql), params))


_OWNED = "SELECT id FROM {} WHERE owner_kind = '{}' AND owner_id = :id"
_MEDIA_ANCHORS = (
    "SELECT id FROM passage_anchors"
    " WHERE user_id = :viewer_id AND owner_scheme = 'media' AND owner_id = :id"
)
_PAGE_NOTE_BLOCKS = """
WITH RECURSIVE links AS (
    SELECT source_scheme AS a_scheme, source_id AS a_id, target_scheme AS b_scheme, target_id AS b_id
    FROM resource_edges
    WHERE user_id = :viewer_id AND origin = 'user' AND kind = 'context'
      AND ordinal IS NULL AND snapshot IS NULL AND source_order_key IS NULL
    UNION ALL
    SELECT target_scheme, target_id, source_scheme, source_id
    FROM resource_edges
    WHERE user_id = :viewer_id AND origin = 'user' AND kind = 'context'
      AND ordinal IS NULL AND snapshot IS NULL AND source_order_key IS NULL
), connected(id) AS (
    SELECT b_id FROM links WHERE a_scheme = 'page' AND a_id = :id AND b_scheme = 'note_block'
    UNION
    SELECT l.b_id FROM links l JOIN connected c ON l.a_id = c.id
    WHERE l.a_scheme = 'note_block' AND l.b_scheme = 'note_block'
)
SELECT id FROM connected
"""
