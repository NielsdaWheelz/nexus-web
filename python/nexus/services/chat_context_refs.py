"""Sole reader of persisted chat context for contributor references.

Owns every read of the chat-domain ref columns (``message_retrievals`` and
``message_tool_calls``). Other domains ask "is this contributor still referenced
anywhere in persisted chat context?" by handle and never touch the chat tables
themselves.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session


def contributor_is_referenced_in_persisted_context(db: Session, *, contributor_handle: str) -> bool:
    """True if any persisted chat retrieval or tool call still references the contributor.

    Every persisted contributor ref carries ``{"type": "contributor", "id": <handle>}``
    at its top level — that is the single retrieval-citation contract written to
    ``message_retrievals.context_ref``/``.result_ref`` and to each element of
    ``message_tool_calls.result_refs``/``.selected_context_refs`` (see
    ``retrieval_citation.RetrievalCitation`` and ``search._result_context_ref``). One
    containment test on the handle therefore covers every shape that can exist.
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
            """
        ),
        {"contributor_handle": contributor_handle},
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
