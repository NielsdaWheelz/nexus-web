"""Shared citation read-model.

The wire contract for the `[N]` citation jump is pinned here, and the backend
is the sole producer of the shape. The one backend producer is
``resource_graph.citations.build_citation_outs``, reading citation edges
(resource provenance graph §9.5), uniformly for chat, Oracle, and Library
Intelligence. The frontend renders ``CitationOut`` directly and no longer
constructs it.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.resource_items import ResourceActivationOut
from nexus.schemas.retrieval import RetrievalLocator
from nexus.services.resource_graph.schemas import EdgeKind

# A citation's role is exactly an edge kind; single-sourced as ``EdgeKind`` in
# the graph-schema module (LOW #20). Kept as a distinct read-model name so the
# citation contract reads in its own vocabulary.
CitationRole = EdgeKind
# The closed set of citation-edge target schemes that render as chips. Other
# slices (oracle, library intelligence) rely on exactly this set.
CitationTargetType = Literal[
    "evidence_span",
    "content_chunk",
    "media",
    "highlight",
    "fragment",
    "page",
    "note_block",
    "message",
    "external_snapshot",
    "oracle_corpus_passage",
    "reader_apparatus_item",
]


class CitationTargetRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: CitationTargetType
    # Every citation target is a ``resource_edges`` row whose ``target_id`` is a
    # UUID (the finest-grained existing object, §5.2); external web results are
    # snapshotted as ``external_snapshot`` rows, so there is no string-id target.
    id: UUID


class CitationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    excerpt: str | None = None
    section_label: str | None = None
    result_type: str | None = None
    summary_md: str | None = None


class CitationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    role: CitationRole
    target_ref: CitationTargetRef
    activation: ResourceActivationOut
    # Hoisted out of the locator for the render href (not every locator variant
    # carries one; evidence-span citations always do).
    media_id: UUID | None = None
    locator: RetrievalLocator | None = None
    deep_link: str | None = None
    snapshot: CitationSnapshot | None = None
