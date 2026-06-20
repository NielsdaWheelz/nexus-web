"""Chat-run citation persistence.

Sole owner of chat citation persistence: a selected retrieval row becomes one
``origin='citation'`` ``resource_edges`` row (with a dense turn-global ordinal),
attached ``<resources>`` get their ``[N]`` chips, the prune path removes rows and
their paired edges with no orphan left behind, read evidence is made citable, and
the ``citation_index`` event payload is built from the edges.

Extracted verbatim from ``chat_runs.py`` (the executor calls into here); the
behavior — commit ordering, SQL, ordinal logic, exception handling — is
unchanged.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    Conversation,
    MessageToolCall,
    ResourceEdge,
)
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.resource_graph import cleanup as graph_cleanup
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    generated_markdown_citation_ordinals,
    record_citation,
    validate_generated_markdown_citations,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    admits_resource_for_conversation_read,
)
from nexus.services.resource_graph.edges import delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
)
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.retrieval_citation import (
    RetrievalCitation,
    citation_from_search_result,
    insert_retrieval_row,
)
from nexus.services.search import get_search_result

logger = get_logger(__name__)


def _uuid_or_none(raw: object) -> UUID | None:
    if isinstance(raw, UUID):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        parsed = UUID(raw)
    except ValueError:
        return None
    return parsed if str(parsed) == raw else None


def record_tool_citations(
    db: Session, *, run: ChatRun, tool_call_id: UUID | None, start_ordinal: int
) -> int:
    """Record citation edges for a tool call's selected retrievals; return next ordinal.

    The dense turn-global numbering is unchanged from the old per-row ordinal
    column — only the storage moved: each selected row gets one
    ``origin='citation'`` edge (``source = message:<assistant_message_id>``) and a
    ``cited_edge_id`` back-pointer, in the same transaction the row was written.
    """
    if tool_call_id is None:
        return start_ordinal
    # Parity with the old column-nulling of unselected rows: a re-persisted row
    # that is no longer selected loses its citation edge.
    stale = db.execute(
        text(
            """
            SELECT id, cited_edge_id FROM message_retrievals
            WHERE tool_call_id = :tool_call_id
              AND selected = false
              AND cited_edge_id IS NOT NULL
            """
        ),
        {"tool_call_id": tool_call_id},
    ).fetchall()
    for row_id, edge_id in stale:
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=edge_id)
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id = NULL WHERE id = :id"),
            {"id": row_id},
        )
    rows = (
        db.execute(
            text(
                """
                SELECT id, result_type, source_id, media_id, evidence_span_id,
                       source_title, section_label, exact_snippet, deep_link, result_ref
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                ORDER BY ordinal
                """
            ),
            {"tool_call_id": tool_call_id},
        )
        .mappings()
        .all()
    )
    next_ordinal = start_ordinal
    for row in rows:
        if _record_retrieval_citation(db, run=run, row=dict(row), ordinal=next_ordinal):
            next_ordinal += 1
    return next_ordinal


def _record_retrieval_citation(
    db: Session, *, run: ChatRun, row: Mapping[str, Any], ordinal: int
) -> bool:
    """Write one citation edge for a selected telemetry row and point the row at it.

    Replace-by-ordinal: a re-executed run owns its message's citation set, so an
    existing edge at this ordinal (from a replaced tool result) is deleted first.
    Rows with no edge target in the citation render contract (attached ``page:``/
    ``message:`` refs) keep their `[n]` in the prompt but mint no edge.
    """
    target = _citation_target_ref(db, run=run, row=row)
    if target is None:
        return False
    existing = db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.source_scheme == "message",
            ResourceEdge.source_id == run.assistant_message_id,
            ResourceEdge.ordinal == ordinal,
        )
    ).scalar_one_or_none()
    if existing is not None:
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=existing)
    try:
        edge = record_citation(
            db,
            viewer_id=run.owner_user_id,
            source=ResourceRef(scheme="message", id=run.assistant_message_id),
            target=target,
            ordinal=ordinal,
            kind="context",
            snapshot=CitationSnapshot(
                title=row["source_title"],
                excerpt=row["exact_snippet"],
                section_label=row["section_label"],
                result_type=row["result_type"],
                deep_link=row["deep_link"],
            ),
        )
    except NotFoundError:
        # justify-ignore-error: the cited target was deleted between retrieval
        # and citation (e.g. a note reindex mid-run). The telemetry row stays;
        # the [n] renders without a chip.
        logger.warning(
            "chat_run.citation_target_vanished",
            run_id=str(run.id),
            target=target.uri,
            ordinal=ordinal,
        )
        return False
    db.execute(
        text("UPDATE message_retrievals SET cited_edge_id = :edge_id WHERE id = :id"),
        {"edge_id": edge.id, "id": row["id"]},
    )
    return True


def _citation_target_ref(
    db: Session, *, run: ChatRun, row: Mapping[str, Any]
) -> ResourceRef | None:
    """The search-owned citation target for a cited telemetry row."""
    del db, run
    result_ref = row["result_ref"]
    if not isinstance(result_ref, Mapping):
        raise AssertionError("message_retrievals.result_ref must be an object")
    raw_target = result_ref.get("citation_target")
    if raw_target is None:
        return None
    if not isinstance(raw_target, str):
        raise AssertionError("message_retrievals.result_ref.citation_target must be a string")
    target = parse_resource_ref(raw_target)
    if isinstance(target, ResourceRefParseFailure):
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is invalid: {raw_target!r}"
        )
    if resource_citation_result_type(target) is None:
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is not citable: {raw_target}"
        )
    return target


def persist_attached_citations(
    db: Session, run: ChatRun, citations: tuple[RetrievalCitation, ...]
) -> None:
    """Insert the synthetic parent tool-call + one retrieval per citable attached
    resource, so attached ``<resources>`` get a ``[N]`` chip. The resource's `n`
    (dense, 1..k) is recorded as a citation edge through ``record_tool_citations``.
    Idempotent on the synthetic ``tool_call_index = 0``.
    """
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :amid AND tool_call_index = 0 "
            "FOR UPDATE"
        ),
        {"amid": run.assistant_message_id},
    ).first()
    if not citations:
        if existing is not None:
            tool_call_id = existing[0]
            prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
            db.execute(
                text("DELETE FROM message_tool_calls WHERE id = :tool_call_id"),
                {"tool_call_id": tool_call_id},
            )
        return
    if existing is not None:
        tool_call_id = existing[0]
    else:
        tool_call_id = db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id, user_message_id, assistant_message_id, tool_name,
                    tool_call_index, scope, requested_types, result_refs,
                    selected_context_refs, provider_request_ids, status
                )
                VALUES (
                    :conversation_id, :user_message_id, :assistant_message_id,
                    'attached_resources', 0, 'attached_context', '[]'::jsonb,
                    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'complete'
                )
                RETURNING id
                """
            ),
            {
                "conversation_id": run.conversation_id,
                "user_message_id": run.user_message_id,
                "assistant_message_id": run.assistant_message_id,
            },
        ).scalar_one()
    for ordinal, citation in enumerate(citations):
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=citation,
            selected=True,
            scope="attached_context",
            retrieval_status="attached_context",
            included_in_prompt=True,
        )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id, min_ordinal=len(citations))
    record_tool_citations(db, run=run, tool_call_id=tool_call_id, start_ordinal=1)


def prune_tool_call_retrievals(
    db: Session, *, tool_call_id: UUID, min_ordinal: int | None = None
) -> None:
    """Delete a tool call's telemetry rows AND the citation edges they cite.

    The single owner of "remove ``message_retrievals`` rows": every prune site —
    attached-citation rebuild, read/inspect trace re-write, and the
    ``app_search``/``web_search`` over-count trim on re-execution — routes here so
    no row is ever dropped without its paired ``origin='citation'`` edge (and any
    now-orphaned ``external_snapshot`` target) dying with it. A pruned cited row
    would otherwise leave a dangling edge that renders as a phantom chip.

    ``min_ordinal`` scopes the prune to ``ordinal >= min_ordinal`` (the over-count
    trim); ``None`` prunes every row for the tool call (full rebuild). Pruned rows
    rarely carry a ``cited_edge_id`` — citation edges are minted after persist — so
    the edge-cleanup work runs only on the re-execution path that produced them.
    """
    ordinal_clause = "" if min_ordinal is None else " AND ordinal >= :min_ordinal"
    params: dict[str, Any] = {"tool_call_id": tool_call_id}
    if min_ordinal is not None:
        params["min_ordinal"] = min_ordinal

    cited_edge_ids = (
        db.execute(
            text(
                "SELECT cited_edge_id FROM message_retrievals "
                f"WHERE tool_call_id = :tool_call_id{ordinal_clause} "
                "AND cited_edge_id IS NOT NULL"
            ),
            params,
        )
        .scalars()
        .all()
    )
    if cited_edge_ids:
        owner_user_id = db.execute(
            select(Conversation.owner_user_id)
            .select_from(MessageToolCall)
            .join(Conversation, Conversation.id == MessageToolCall.conversation_id)
            .where(MessageToolCall.id == tool_call_id)
        ).scalar_one()
        for edge_id in cited_edge_ids:
            _delete_citation_edge(db, viewer_id=owner_user_id, edge_id=edge_id)

    web_snapshot_ids = [
        snapshot_id
        for snapshot_id in (
            _uuid_or_none(source_id)
            for source_id in db.execute(
                text(
                    "SELECT source_id FROM message_retrievals "
                    f"WHERE tool_call_id = :tool_call_id{ordinal_clause} "
                    "AND result_type = 'web_result'"
                ),
                params,
            ).scalars()
        )
        if snapshot_id is not None
    ]

    # The candidate ledger FKs message_retrievals; null its pointer before the
    # delete (app_search/web_search write these; chat-run traces never do, so the
    # UPDATE is a harmless no-op there).
    db.execute(
        text(
            "UPDATE message_retrieval_candidate_ledgers SET retrieval_id = NULL "
            "WHERE retrieval_id IN ("
            "  SELECT id FROM message_retrievals "
            f"  WHERE tool_call_id = :tool_call_id{ordinal_clause}"
            ")"
        ),
        params,
    )
    db.execute(
        text(f"DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id{ordinal_clause}"),
        params,
    )
    if web_snapshot_ids:
        graph_cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=web_snapshot_ids)


def _delete_citation_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Delete one citation edge and the external snapshot it leaves orphaned.

    Web citations mint a ``resource_external_snapshots`` row per cited result
    (``_citation_target_ref``); when the last edge pointing at one is deleted —
    here, in the ordinal-replace path, or by ``prune_tool_call_retrievals`` — the
    snapshot is garbage. Snapshot GC is owned by ``resource_graph.cleanup`` (the
    same owner the domain-parent delete path uses), so every citation-edge
    deletion path collapses to one rule.
    """
    target_scheme, target_id = db.execute(
        select(ResourceEdge.target_scheme, ResourceEdge.target_id).where(ResourceEdge.id == edge_id)
    ).one()
    delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    if target_scheme == "external_snapshot":
        graph_cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=[target_id])


def clear_message_citations(db: Session, run: ChatRun) -> None:
    edge_ids = (
        db.execute(
            select(ResourceEdge.id).where(
                ResourceEdge.source_scheme == "message",
                ResourceEdge.source_id == run.assistant_message_id,
                ResourceEdge.origin == "citation",
            )
        )
        .scalars()
        .all()
    )
    for edge_id in edge_ids:
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id = NULL WHERE cited_edge_id = :id"),
            {"id": edge_id},
        )
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=edge_id)


def persist_read_evidence_citation(
    db: Session,
    *,
    run: ChatRun,
    tool_call_id: UUID,
    result: Any,
    start_ordinal: int,
) -> int | None:
    """Make an evidence read (`quote`/`section`/`full`/`page_range`) citable.

    Materializes the chip via `get_search_result` under the read tool-call and
    returns its `n` (= ``start_ordinal``), or None when the result is not
    evidence (`too_large`/error) or no durable row materializes.
    """
    if result.is_error or result.citation_result_type is None or result.citation_source_id is None:
        return None
    try:
        search_result = get_search_result(
            db, run.owner_user_id, result.citation_result_type, result.citation_source_id
        )
        citation = citation_from_search_result(search_result, filters={})
        citation.selected = True
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation=citation,
            selected=True,
            scope="read_resource",
            retrieval_status="selected",
            included_in_prompt=True,
        )
    except (NotFoundError, ValueError):
        # justify-ignore-error: no resolvable anchor → the read body still
        # returns, but it is not cited (no row, no `n`).
        return None
    record_tool_citations(db, run=run, tool_call_id=tool_call_id, start_ordinal=start_ordinal)
    return start_ordinal


def emit_citation_index(
    db: Session, run: ChatRun, content_md: str, *, emitter: ChatRunEventEmitter
) -> None:
    """Emit the message's citation set (from edges) + graduate cited local targets.

    The citation_index event carries the graph-built ``CitationOut`` read model
    plus ``citation_edge_id``. Cited local resources not yet in the conversation
    context get an ``origin='citation'`` context edge plus a
    ``context_ref_added`` event built from the returned ContextRefOut.
    """
    message_ref = ResourceRef(scheme="message", id=run.assistant_message_id)
    edges = []
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=run.owner_user_id,
            query=ConnectionQuery(
                refs=(message_ref,),
                direction="outgoing",
                rollup="exact",
                filters=ConnectionFilters(origins=("citation",)),
                limit=100,
                cursor=cursor,
            ),
        )
        edges.extend(edge for edge in page.items if edge.ordinal is not None)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    edges.sort(key=lambda edge: edge.ordinal or 0)
    marker_ordinals = generated_markdown_citation_ordinals(content_md)
    edge_ordinals = [edge.ordinal for edge in edges]
    if marker_ordinals != list(range(1, len(marker_ordinals) + 1)):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Generated markdown citation markers must match citation ordinals exactly; "
            f"markers={marker_ordinals}, citations={edge_ordinals}",
        )
    if not marker_ordinals:
        if edge_ordinals:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Generated markdown citation markers must match citation ordinals exactly; "
                f"markers={marker_ordinals}, citations={edge_ordinals}",
            )
        return
    missing_ordinals = sorted(set(marker_ordinals) - set(edge_ordinals))
    if missing_ordinals:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Generated markdown citation markers must match citation ordinals exactly; "
            f"markers={marker_ordinals}, citations={edge_ordinals}",
        )
    marker_set = set(marker_ordinals)
    for edge in edges:
        if edge.ordinal in marker_set:
            continue
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id = NULL WHERE cited_edge_id = :id"),
            {"id": edge.edge_id},
        )
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=edge.edge_id)
    edges = [edge for edge in edges if edge.ordinal in marker_set]
    citation_inputs = []
    for edge in edges:
        assert edge.ordinal is not None, f"citation edge {edge.edge_id} lost its ordinal"
        assert edge.snapshot is not None, f"citation edge {edge.edge_id} lost its snapshot"
        citation_inputs.append(
            CitationInput(
                target=edge.target_ref,
                ordinal=edge.ordinal,
                kind=edge.kind,
                snapshot=edge.snapshot,
            )
        )
    validate_generated_markdown_citations(content_md, citation_inputs)
    if not edges:
        return
    edge_id_by_ordinal = {edge.ordinal: edge.edge_id for edge in edges}
    citations = []
    for citation in build_citation_outs(db, viewer_id=run.owner_user_id, source=message_ref):
        edge_id = edge_id_by_ordinal.get(citation.ordinal)
        assert edge_id is not None, f"citation ordinal {citation.ordinal} lost its edge id"
        citations.append(
            {
                "citation_edge_id": str(edge_id),
                "citation": citation.model_dump(mode="json"),
            }
        )
    assert len(citations) == len(edges), (
        f"citation read model count mismatch for message {run.assistant_message_id}"
    )
    emitter.citation_index(
        {"assistant_message_id": str(run.assistant_message_id), "citations": citations}
    )
    for edge in edges:
        if edge.target_ref.scheme == "external_snapshot":
            continue
        if admits_resource_for_conversation_read(
            db, conversation_id=run.conversation_id, target=edge.target_ref
        ):
            continue
        try:
            context_ref = add_context_ref_without_commit(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                target=edge.target_ref,
                origin="citation",
            )
        except NotFoundError:
            # justify-ignore-error: the cited target was deleted after the edge
            # was recorded (mid-run reindex). The citation chip keeps rendering
            # from its snapshot; there is just no context ref to add.
            continue
        emitter.context_ref_added(
            {
                "id": str(context_ref.edge_id),
                "conversation_id": str(context_ref.conversation_id),
                "resource_ref": context_ref.target.uri,
                "activation": context_ref.activation.model_dump(mode="json"),
                "label": context_ref.resolved.label,
                "summary": context_ref.resolved.summary,
                "missing": context_ref.resolved.missing,
                "created_at": context_ref.created_at,
                "citation_edge_id": str(edge.edge_id),
            }
        )
