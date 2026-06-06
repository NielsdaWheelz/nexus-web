"""Reconcile message_retrievals from a prompt assembly."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun


def reconcile_prompt_retrievals(db: Session, *, run: ChatRun, assembly: Any) -> None:
    included_ids = [str(retrieval_id) for retrieval_id in assembly.ledger.included_retrieval_ids]
    dropped_ids = [
        item["key"].split(":", 1)[1]
        for item in assembly.ledger.dropped_items
        if item.get("lane") in {"retrieved_evidence", "web_evidence"}
        and isinstance(item.get("key"), str)
        and ":" in item["key"]
        and item["key"].split(":", 1)[0] in {"retrieved_evidence", "web_evidence"}
    ]
    if included_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = true,
                    retrieval_status = CASE
                        WHEN result_type = 'web_result' THEN 'web_result'
                        ELSE 'included_in_prompt'
                    END
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       true,
                       'included_in_prompt',
                       'prompt_assembly',
                       result_ref,
                       locator
                FROM message_retrievals
                WHERE id = ANY(:included_ids)
                """
            ),
            {"included_ids": included_ids},
        )
    if dropped_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = false,
                    retrieval_status = 'excluded_by_budget'
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )
        db.execute(
            text(
                """
                INSERT INTO message_retrieval_candidate_ledgers (
                    tool_call_id,
                    retrieval_id,
                    ordinal,
                    result_type,
                    source_id,
                    score,
                    selected,
                    included_in_prompt,
                    selection_status,
                    selection_reason,
                    result_ref,
                    locator
                )
                SELECT tool_call_id,
                       id,
                       ordinal,
                       result_type,
                       source_id,
                       score,
                       selected,
                       false,
                       'excluded_by_budget',
                       'prompt_assembly',
                       result_ref,
                       locator
                FROM message_retrievals
                WHERE id = ANY(:dropped_ids)
                  AND selected = true
                """
            ),
            {"dropped_ids": dropped_ids},
        )
