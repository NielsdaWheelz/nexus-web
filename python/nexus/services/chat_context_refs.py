"""Sole reader of persisted chat context for contributor references.

Owns every read of the chat-domain ref columns (``message_retrievals``,
``message_tool_calls``, ``chat_prompt_assemblies``, ``chat_run_events``).
Other domains ask "is this contributor still referenced anywhere in
persisted chat context?" and never touch the chat tables themselves. The
single caller is the orphan-prune eligibility check in
``services/contributors`` (spec 2.8, D-41).
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def contributor_is_referenced_in_persisted_context(
    db: Session,
    *,
    contributor_id: UUID,
    contributor_handle: str,
) -> bool:
    """True if any persisted chat context still references the contributor.

    Two persisted ref forms exist (D-18/D-41):

    - the typed object ``{"type": "contributor", "id": <handle>}`` — the single
      retrieval-citation contract written to ``message_retrievals.context_ref``/
      ``.result_ref`` and each element of ``message_tool_calls.result_refs``/
      ``.selected_context_refs``;
    - the ``"contributor:<uuid>"`` URI string nested anywhere inside
      ``chat_prompt_assemblies`` manifests/refs and ``chat_run_events`` payloads
      (``resource_uri``, ``requested_resource_uri``, ``chat_subject.*``,
      ``companions[]``).
    """
    row = db.execute(
        text(
            f"""
            SELECT 1
            WHERE EXISTS (
                SELECT 1 FROM message_retrievals mr
                WHERE {_contains_contributor_ref_sql("mr.context_ref")}
                   OR {_contains_contributor_ref_sql("mr.result_ref")}
            )
            OR EXISTS (
                SELECT 1 FROM message_tool_calls mtc
                WHERE {_array_contains_contributor_ref_sql("mtc.result_refs")}
                   OR {_array_contains_contributor_ref_sql("mtc.selected_context_refs")}
            )
            OR EXISTS (
                SELECT 1 FROM chat_prompt_assemblies cpa
                WHERE {_contains_contributor_uri_sql("cpa.prompt_block_manifest")}
                   OR {_contains_contributor_uri_sql("cpa.included_context_refs")}
                   OR {_contains_contributor_uri_sql("cpa.dropped_items")}
            )
            OR EXISTS (
                SELECT 1 FROM chat_run_events cre
                WHERE {_contains_contributor_uri_sql("cre.payload")}
            )
            """
        ),
        {
            "contributor_handle": contributor_handle,
            "contributor_uri": f"contributor:{contributor_id}",
        },
    ).fetchone()
    return row is not None


def _contains_contributor_ref_sql(column: str) -> str:
    return (
        f"{column} @> jsonb_build_object("
        "'type', 'contributor', 'id', CAST(:contributor_handle AS text))"
    )


def _array_contains_contributor_ref_sql(column: str) -> str:
    return f"""EXISTS (
        SELECT 1 FROM jsonb_array_elements({column}) AS element(value)
        WHERE {_contains_contributor_ref_sql("element.value")}
    )"""


def _contains_contributor_uri_sql(column: str) -> str:
    # jsonb_path_exists in (default) lax mode visits every nested value via $.**
    # and string-compares scalars; objects/arrays simply never equal the URI.
    return (
        f"jsonb_path_exists({column}, '$.** ? (@ == $uri)', "
        "jsonb_build_object('uri', CAST(:contributor_uri AS text)))"
    )
