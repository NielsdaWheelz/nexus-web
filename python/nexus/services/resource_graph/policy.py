"""Executable edge-shape policy for the resource graph product spine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.resource_graph.refs import ResourceScheme
from nexus.services.resource_graph.schemas import (
    EDGE_KINDS,
    EDGE_ORIGINS,
    EdgeCreate,
    EdgeKind,
    EdgeOrigin,
)
from nexus.services.resource_items.capabilities import (
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
    citation_output_source_schemes,
    resource_can_be_citation_output_source,
)

SchemeSet = tuple[ResourceScheme, ...] | Literal["any"]

SEARCH_SCOPE_EDGE_KIND: EdgeKind = "context"
SYNAPSE_SOURCE_SCHEMES: tuple[ResourceScheme, ...] = ("media", "page", "note_block", "highlight")
SYNAPSE_TARGET_SCHEMES: tuple[ResourceScheme, ...] = ("media", "note_block", "evidence_span")
# The assistant's hand stays inside the durable library graph (amanuensis D-1):
# a widened copy of the synapse shape that admits page + highlight, and excludes
# evidence_span (which only the synapse scanner mints).
ASSISTANT_EDGE_SCHEMES: tuple[ResourceScheme, ...] = ("media", "page", "note_block", "highlight")


@dataclass(frozen=True, slots=True)
class EdgeShapePolicy:
    origin: EdgeOrigin
    writer: str
    allowed_kinds: tuple[EdgeKind, ...]
    source_schemes: SchemeSet
    target_schemes: SchemeSet
    ordinal: Literal["forbidden", "citation_required"]
    snapshot: Literal["forbidden", "citation_required", "synapse_required", "assistant_required"]
    source_order: Literal["forbidden", "optional", "conversation_context_optional"]
    target_order: Literal["forbidden"]
    cleanup: str
    search_activation: Literal["never", "allowlisted_only"]
    rendering: str


EDGE_SHAPE_POLICIES: dict[EdgeOrigin, EdgeShapePolicy] = {
    "user": EdgeShapePolicy(
        origin="user",
        writer="resource_graph.edges public user-link API and resource adjacency service",
        allowed_kinds=EDGE_KINDS,
        source_schemes="any",
        target_schemes="any",
        ordinal="forbidden",
        snapshot="forbidden",
        source_order="optional",
        target_order="forbidden",
        cleanup="delete bare rows with either endpoint",
        search_activation="allowlisted_only",
        rendering="user connection",
    ),
    "citation": EdgeShapePolicy(
        origin="citation",
        writer="resource_graph.citations and conversation context graduation",
        allowed_kinds=EDGE_KINDS,
        source_schemes=(*citation_output_source_schemes(), "conversation"),
        target_schemes="any",
        ordinal="citation_required",
        snapshot="citation_required",
        source_order="conversation_context_optional",
        target_order="forbidden",
        cleanup="delete with source; preserve target snapshots",
        search_activation="allowlisted_only",
        rendering="citation or context ref",
    ),
    "system": EdgeShapePolicy(
        origin="system",
        writer="resource_graph.context",
        allowed_kinds=("context",),
        source_schemes=("conversation",),
        target_schemes="any",
        ordinal="forbidden",
        snapshot="forbidden",
        source_order="conversation_context_optional",
        target_order="forbidden",
        cleanup="delete bare rows with either endpoint",
        search_activation="allowlisted_only",
        rendering="context ref",
    ),
    "note_body": EdgeShapePolicy(
        origin="note_body",
        writer="note body sync",
        allowed_kinds=("context",),
        source_schemes=("note_block",),
        target_schemes="any",
        ordinal="forbidden",
        snapshot="forbidden",
        source_order="forbidden",
        target_order="forbidden",
        cleanup="replace with parsed body refs",
        search_activation="allowlisted_only",
        rendering="note body ref",
    ),
    "highlight_note": EdgeShapePolicy(
        origin="highlight_note",
        writer="notes highlight attachment path",
        allowed_kinds=("context",),
        source_schemes=("highlight",),
        target_schemes=("note_block",),
        ordinal="forbidden",
        snapshot="forbidden",
        source_order="forbidden",
        target_order="forbidden",
        cleanup="delete with highlight or note block",
        search_activation="allowlisted_only",
        rendering="highlight note attachment",
    ),
    "synapse": EdgeShapePolicy(
        origin="synapse",
        writer="services.synapse",
        allowed_kinds=EDGE_KINDS,
        source_schemes=SYNAPSE_SOURCE_SCHEMES,
        target_schemes=SYNAPSE_TARGET_SCHEMES,
        ordinal="forbidden",
        snapshot="synapse_required",
        source_order="forbidden",
        target_order="forbidden",
        cleanup="replace with scan; delete on dismissal",
        search_activation="never",
        rendering="suggestion",
    ),
    "assistant": EdgeShapePolicy(
        origin="assistant",
        writer="services.agent_tools.writes",
        allowed_kinds=EDGE_KINDS,
        source_schemes=ASSISTANT_EDGE_SCHEMES,
        target_schemes=ASSISTANT_EDGE_SCHEMES,
        ordinal="forbidden",
        snapshot="assistant_required",
        source_order="forbidden",
        target_order="forbidden",
        cleanup="delete on undo; delete bare rows with either endpoint",
        search_activation="never",
        rendering="assistant connection",
    ),
    "document_embed": EdgeShapePolicy(
        origin="document_embed",
        writer="document_embeds child-link sync",
        allowed_kinds=("context",),
        source_schemes=("media",),
        target_schemes=("media",),
        ordinal="forbidden",
        snapshot="forbidden",
        source_order="forbidden",
        target_order="forbidden",
        cleanup="replace with current document embeds; delete with parent or child",
        search_activation="allowlisted_only",
        rendering="source-authored embedded media",
    ),
}


def validate_edge_shape(edge: EdgeCreate) -> None:
    if edge.kind not in EDGE_KINDS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid edge kind {edge.kind!r}"
        )
    if edge.origin not in EDGE_ORIGINS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid edge origin {edge.origin!r}"
        )
    if edge.source == edge.target:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "An edge cannot relate a resource to itself"
        )
    if edge.target_order_key is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Target order keys are reserved until multi-occurrence blocks ship",
        )
    for label, value in (
        ("source_order_key", edge.source_order_key),
        ("target_order_key", edge.target_order_key),
    ):
        if value is not None and not 1 <= len(value) <= 64:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, f"{label} must be 1-64 characters"
            )
    if edge.source_order_key is not None and not _allows_source_order(edge):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Source order key is not valid for this edge shape",
        )
    if edge.origin == "citation":
        _validate_citation(edge)
        return
    if edge.ordinal is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Only citation edges can carry ordinals"
        )
    if edge.snapshot is not None and edge.origin not in ("synapse", "assistant"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Only citation, synapse, and assistant edges can carry snapshots",
        )
    if edge.origin == "synapse":
        _validate_synapse(edge)
        return
    if edge.origin == "assistant":
        _validate_assistant(edge)
        return

    policy = EDGE_SHAPE_POLICIES[edge.origin]
    if edge.kind not in policy.allowed_kinds:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"{edge.origin} edges must use kind=context"
        )
    if not _scheme_allowed(edge.source.scheme, policy.source_schemes) or not _scheme_allowed(
        edge.target.scheme, policy.target_schemes
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, _shape_message(edge.origin))


def _validate_citation(edge: EdgeCreate) -> None:
    if edge.ordinal is None:
        if edge.snapshot is not None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Only ordinal citation edges can carry citation snapshots",
            )
        if edge.kind != "context" or edge.source.scheme != "conversation":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Bare citation edges must be conversation context refs",
            )
        return
    if edge.snapshot is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Citation ordinal requires a snapshot",
        )
    if not resource_can_be_citation_output_source(edge.source):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Citation ordinals must start from a generated output resource",
        )
    if edge.source_order_key is not None or edge.target_order_key is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Citation edges cannot carry order keys"
        )
    if edge.ordinal < 1:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Citation ordinal must be >= 1")


def _validate_synapse(edge: EdgeCreate) -> None:
    if edge.source.scheme not in SYNAPSE_SOURCE_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Synapse edges must start from media, page, note_block, or highlight",
        )
    if edge.target.scheme not in SYNAPSE_TARGET_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Synapse edges must target media or note_block",
        )
    if edge.snapshot is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Synapse edges require a rationale snapshot",
        )
    if not (edge.snapshot.excerpt or "").strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Synapse snapshots require a non-empty excerpt",
        )


def _validate_assistant(edge: EdgeCreate) -> None:
    if (
        edge.source.scheme not in ASSISTANT_EDGE_SCHEMES
        or edge.target.scheme not in ASSISTANT_EDGE_SCHEMES
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Assistant edges must connect media, page, note_block, or highlight",
        )
    if edge.source_order_key is not None or edge.target_order_key is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Assistant edges cannot carry order keys"
        )
    if edge.snapshot is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Assistant edges require a rationale snapshot",
        )
    if not (edge.snapshot.excerpt or "").strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Assistant snapshots require a non-empty excerpt",
        )


def _allows_source_order(edge: EdgeCreate) -> bool:
    if edge.origin == "user":
        return edge.kind == "context" and edge.ordinal is None and edge.snapshot is None
    return (
        edge.origin in CONVERSATION_CONTEXT_EDGE_ORIGINS
        and edge.kind == SEARCH_SCOPE_EDGE_KIND
        and edge.source.scheme == "conversation"
        and edge.ordinal is None
        and edge.snapshot is None
    )


def _scheme_allowed(scheme: ResourceScheme, allowed: SchemeSet) -> bool:
    return allowed == "any" or scheme in allowed


def _shape_message(origin: EdgeOrigin) -> str:
    if origin == "highlight_note":
        return "Highlight note edges must connect highlight to note_block"
    if origin == "note_body":
        return "Note body edges must start from note_block"
    if origin == "system":
        return "System edges must be conversation context refs"
    if origin == "document_embed":
        return "Document embed edges must connect media to media"
    return "Invalid edge shape"
