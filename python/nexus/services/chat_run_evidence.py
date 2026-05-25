"""Evidence persistence for chat runs: claim/evidence row resolution and citation audit."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.services.chat_run_claim_parsing import (
    ClaimCandidate,
    VerifiedClaim,
    claim_has_valid_answer_offsets,
)
from nexus.services.chat_run_evidence_locators import canonical_evidence_span_matches
from nexus.services.chat_run_scope import is_source_backed_run
from nexus.services.context_lookup import hydrate_context_ref
from nexus.services.message_context_snapshots import (
    context_evidence_span_ids,
    trusted_context_snapshot,
)


def message_prompt_evidence_rows(
    db: Session,
    run: ChatRun,
    assistant_message: Message,
    *,
    reconcile_inclusion: bool = True,
) -> tuple[UUID | None, list[dict[str, Any]]]:
    assembly_row = db.execute(
        text(
            """
            SELECT id, included_retrieval_ids
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run.id},
    ).first()
    prompt_assembly_id = assembly_row[0] if assembly_row is not None else None
    included_retrieval_ids = {
        str(retrieval_id) for retrieval_id in (assembly_row[1] if assembly_row else [])
    }
    if reconcile_inclusion:
        for retrieval_id in included_retrieval_ids:
            db.execute(
                text(
                    """
                    UPDATE message_retrievals
                    SET included_in_prompt = true,
                        retrieval_status = CASE
                            WHEN result_type = 'web_result' THEN 'web_result'
                            ELSE 'included_in_prompt'
                        END
                    WHERE id = :retrieval_id
                    """
                ),
                {"retrieval_id": retrieval_id},
            )

    retrieval_rows = db.execute(
        text(
            """
            SELECT mr.id,
                   mr.result_type,
                   mr.source_id,
                   mr.media_id,
                   mr.context_ref,
                   mr.result_ref,
                   mr.deep_link,
                   mr.score,
                   mr.selected,
                   mr.source_title,
                   mr.exact_snippet,
                   mr.snippet_prefix,
                   mr.snippet_suffix,
                   mr.locator,
                   mr.retrieval_status,
                   mr.included_in_prompt,
                   mr.source_version,
                   mr.evidence_span_id
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
              AND mr.selected = true
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message.id},
    ).fetchall()

    evidence_rows: list[dict[str, Any]] = []
    for row in retrieval_rows:
        if str(row[0]) not in included_retrieval_ids:
            continue
        if not isinstance(row[4], dict) or not isinstance(row[5], dict):
            continue
        try:
            context_ref = retrieval_context_ref_json(row[4])
            result_ref = retrieval_result_ref_json(row[5])
            locator = retrieval_locator_json(row[13]) if isinstance(row[13], dict) else None
        except ValidationError:
            # justify-ignore-error: persisted retrieval row failed schema
            # validation (stale/legacy shape); skip it rather than fail the
            # whole document rebuild.
            continue
        if result_ref.get("type") != row[1]:
            continue
        snippet = row[10] or result_ref.get("snippet")
        if not isinstance(snippet, str) or not snippet.strip():
            continue
        source_version = row[16]
        if not isinstance(source_version, str) or not source_version.strip():
            continue
        if locator is None:
            continue
        result_source_version = result_ref.get("source_version")
        if not isinstance(result_source_version, str) or result_source_version != source_version:
            continue
        result_locator = result_ref.get("locator")
        if not isinstance(result_locator, dict) or result_locator != locator:
            continue
        result_context_ref = result_ref.get("context_ref")
        if (
            not isinstance(result_context_ref, dict)
            or result_context_ref.get("type") != context_ref["type"]
        ):
            continue
        if (
            row[3] is not None
            and row[17] is not None
            and not canonical_evidence_span_matches(
                db,
                viewer_id=run.owner_user_id,
                media_id=row[3],
                evidence_span_id=row[17],
                source_version=source_version,
                locator=locator,
                exact_snippet=snippet,
            )
        ):
            continue
        retrieval_status = row[14]
        if row[1] == "web_result":
            retrieval_status = "web_result"
        else:
            retrieval_status = "included_in_prompt"
        source_ref = {
            "type": "message_retrieval",
            "id": str(row[0]),
            "retrieval_id": str(row[0]),
            "label": row[9] or result_ref.get("title") or result_ref.get("source_label"),
            "context_ref": context_ref,
            "result_ref": result_ref,
            "deep_link": row[6],
            "source_version": source_version,
        }
        if row[3] is not None:
            source_ref["media_id"] = str(row[3])
        if row[17] is not None:
            source_ref["evidence_span_id"] = str(row[17])
        evidence_rows.append(
            {
                "retrieval_id": row[0],
                "evidence_span_id": row[17],
                "source_ref": source_ref,
                "context_ref": context_ref,
                "result_ref": result_ref,
                "exact_snippet": snippet.strip(),
                "snippet_prefix": row[11],
                "snippet_suffix": row[12],
                "locator": locator,
                "deep_link": row[6],
                "score": row[7],
                "retrieval_status": retrieval_status,
                "selected": bool(row[8]),
                "included_in_prompt": True,
                "source_version": source_version,
            }
        )
    context_rows = db.execute(
        text(
            """
            SELECT id,
                   context_kind,
                   object_type,
                   object_id,
                   source_media_id,
                   locator_json,
                   context_snapshot
            FROM message_context_items
            WHERE message_id = :user_message_id
            ORDER BY ordinal ASC, id ASC
            """
        ),
        {"user_message_id": run.user_message_id},
    ).fetchall()
    for row in context_rows:
        try:
            snapshot = trusted_context_snapshot(row[6])
        except ValueError:
            # justify-ignore-error: persisted snapshot column has an invalid
            # shape (legacy/corrupted); skip the row rather than fail.
            continue
        locator = row[5] if isinstance(row[5], dict) else snapshot.get("locator")
        if not isinstance(locator, dict):
            continue
        try:
            locator = retrieval_locator_json(locator)
        except ValidationError:
            # justify-ignore-error: persisted locator failed schema validation;
            # skip this evidence row.
            continue
        if locator is None:
            continue
        source_version = snapshot.get("source_version")
        if not isinstance(source_version, str) or not source_version.strip():
            continue
        evidence_span_ids = context_evidence_span_ids(snapshot)
        context_ref: dict[str, object]
        if row[1] == "reader_selection":
            if snapshot.get("evidence_verification") != "source_text_exact_match_v1":
                continue
            snippet = snapshot.get("exact")
            if not isinstance(snippet, str) or not snippet.strip():
                continue
            if row[4] is None:
                continue
            context_ref = {
                "type": "media",
                "id": str(row[4]),
            }
        else:
            if row[2] is None or row[3] is None:
                continue
            context_ref = {"type": str(row[2]), "id": str(row[3])}
            if str(row[2]) == "content_chunk" and evidence_span_ids:
                context_ref["evidence_span_ids"] = [
                    str(evidence_span_id) for evidence_span_id in evidence_span_ids
                ]
            lookup = hydrate_context_ref(
                db,
                viewer_id=run.owner_user_id,
                context_ref=context_ref,
            )
            if not lookup.resolved or not lookup.evidence_text.strip():
                continue
            snippet = lookup.evidence_text
        try:
            context_ref = retrieval_context_ref_json(context_ref)
        except ValidationError:
            # justify-ignore-error: reconstructed context_ref failed schema
            # validation; skip this evidence row.
            continue
        evidence_span_id = evidence_span_ids[0] if evidence_span_ids else None
        if (
            row[4] is not None
            and evidence_span_id is not None
            and not canonical_evidence_span_matches(
                db,
                viewer_id=run.owner_user_id,
                media_id=row[4],
                evidence_span_id=evidence_span_id,
                source_version=source_version,
                locator=locator,
                exact_snippet=snippet,
            )
        ):
            continue
        source_ref = {
            "type": "message_context",
            "id": str(row[0]),
            "message_context_id": str(row[0]),
            "label": snapshot.get("title") or snapshot.get("media_title") or row[2] or row[1],
            "context_ref": context_ref,
            "source_version": source_version,
        }
        if row[4] is not None:
            source_ref["media_id"] = str(row[4])
        evidence_rows.append(
            {
                "retrieval_id": None,
                "evidence_span_id": evidence_span_id,
                "source_ref": source_ref,
                "context_ref": context_ref,
                "result_ref": None,
                "exact_snippet": snippet.strip(),
                "snippet_prefix": snapshot.get("prefix")
                if isinstance(snapshot.get("prefix"), str)
                else None,
                "snippet_suffix": snapshot.get("suffix")
                if isinstance(snapshot.get("suffix"), str)
                else None,
                "locator": locator,
                "deep_link": snapshot.get("route")
                if isinstance(snapshot.get("route"), str)
                else None,
                "score": None,
                "retrieval_status": "attached_context",
                "selected": True,
                "included_in_prompt": True,
                "source_version": source_version,
            }
        )
    return prompt_assembly_id, evidence_rows


def finalize_message_evidence(
    db: Session,
    run: ChatRun,
    assistant_message: Message,
    verifier_hint: dict[str, Any] | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    db.execute(
        text(
            """
            DELETE FROM assistant_message_claim_evidence
            WHERE claim_id IN (
                SELECT id
                FROM assistant_message_claims
                WHERE message_id = :message_id
            )
            """
        ),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_claims WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_evidence_summaries WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )

    conversation = db.get(Conversation, run.conversation_id)
    scope_type = conversation.scope_type if conversation is not None else "general"
    scope_ref: dict[str, object] | None = None
    if conversation is not None and scope_type == "media" and conversation.scope_media_id:
        scope_ref = {"type": "media", "media_id": str(conversation.scope_media_id)}
    elif conversation is not None and scope_type == "library" and conversation.scope_library_id:
        scope_ref = {"type": "library", "library_id": str(conversation.scope_library_id)}

    prompt_assembly_id, evidence_rows = message_prompt_evidence_rows(db, run, assistant_message)
    verifier_name = "source_evidence_gate"
    verifier_version = "v1"
    hinted_verifier_status = None
    verifier_metadata: dict[str, Any] = {
        "status_detail": "missing_verifier_hint",
    }
    if verifier_hint is not None:
        hint_name = verifier_hint.get("verifier_name")
        hint_version = verifier_hint.get("verifier_version")
        hint_status = verifier_hint.get("verifier_status")
        hint_metadata = verifier_hint.get("metadata")
        if isinstance(hint_name, str) and hint_name:
            verifier_name = hint_name
        if isinstance(hint_version, str) and hint_version:
            verifier_version = hint_version
        if hint_status in {"llm_verified", "parse_failed", "failed"}:
            hinted_verifier_status = hint_status
        if isinstance(hint_metadata, dict):
            verifier_metadata = {**verifier_metadata, **hint_metadata}

    answer = assistant_message.content.strip()
    source_backed = (
        is_source_backed_run(
            db,
            run=run,
            assistant_message=assistant_message,
            evidence_rows=evidence_rows,
        )
        or verifier_metadata.get("source_backed") is True
    )
    claim_status_items = verifier_metadata.get("claim_statuses")
    claim_statuses = (
        claim_status_items
        if (
            hinted_verifier_status in {"llm_verified", "parse_failed", "failed"}
            and isinstance(claim_status_items, list)
        )
        else []
    )
    if evidence_rows or claim_statuses:
        verified_claims = []
        if claim_statuses:
            for item in claim_statuses:
                if not isinstance(item, dict):
                    continue
                text_value = item.get("text")
                support_status_value = item.get("support_status")
                evidence_ordinals = item.get("evidence_ordinals")
                if (
                    not isinstance(text_value, str)
                    or support_status_value
                    not in {
                        "supported",
                        "partially_supported",
                        "contradicted",
                        "not_enough_evidence",
                        "out_of_scope",
                        "not_source_grounded",
                    }
                    or not isinstance(evidence_ordinals, list)
                ):
                    continue

                answer_statuses = {"supported", "partially_supported"}
                cite_required_statuses = {"supported", "partially_supported", "contradicted"}
                indexes = [
                    index
                    for index in evidence_ordinals
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                support_indexes = [
                    index
                    for index in item.get("supporting_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                contradict_indexes = [
                    index
                    for index in item.get("contradicting_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                context_indexes = [
                    index
                    for index in item.get("context_evidence_ordinals", [])
                    if isinstance(index, int) and 0 <= index < len(evidence_rows)
                ]
                if not (support_indexes or contradict_indexes or context_indexes):
                    if support_status_value in {"supported", "partially_supported"}:
                        support_indexes = indexes
                if not indexes:
                    indexes = sorted(set([*support_indexes, *contradict_indexes, *context_indexes]))
                unsupported_reason = item.get("unsupported_reason")
                if isinstance(unsupported_reason, str) and unsupported_reason.strip():
                    unsupported_reason = unsupported_reason.strip()
                else:
                    unsupported_reason = None
                confidence = item.get("confidence")
                if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
                    confidence = max(0.0, min(float(confidence), 1.0))
                else:
                    confidence = None

                if (
                    hinted_verifier_status != "llm_verified"
                    and support_status_value in cite_required_statuses
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason or "claim verifier did not complete successfully"
                    )
                if support_status_value in cite_required_statuses and not indexes:
                    support_status_value = "not_enough_evidence"
                    unsupported_reason = (
                        unsupported_reason or "claim verifier returned no citeable evidence"
                    )
                if (
                    support_status_value in {"supported", "partially_supported"}
                    and not support_indexes
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason or "claim verifier returned no supporting evidence"
                    )
                if support_status_value == "contradicted" and (
                    not support_indexes or not contradict_indexes
                ):
                    support_status_value = "not_enough_evidence"
                    indexes = []
                    support_indexes = []
                    contradict_indexes = []
                    context_indexes = []
                    unsupported_reason = (
                        unsupported_reason
                        or "claim verifier returned no supporting and conflicting evidence"
                    )

                evidence_for_claim = []
                if support_status_value in cite_required_statuses:
                    seen_indexes: set[tuple[str, int]] = set()
                    for role, role_indexes in (
                        ("supports", support_indexes),
                        ("contradicts", contradict_indexes),
                        ("context", context_indexes),
                    ):
                        for index in role_indexes:
                            if (role, index) in seen_indexes:
                                continue
                            seen_indexes.add((role, index))
                            evidence_for_claim.append(
                                {**evidence_rows[index], "_evidence_role": role}
                            )
                    if any(
                        not isinstance(row.get("locator"), dict)
                        or not row.get("locator")
                        or not isinstance(row.get("source_version"), str)
                        or not str(row.get("source_version")).strip()
                        or not isinstance(row.get("exact_snippet"), str)
                        or not str(row.get("exact_snippet")).strip()
                        for row in evidence_for_claim
                    ):
                        support_status_value = "not_enough_evidence"
                        evidence_for_claim = []
                        unsupported_reason = (
                            unsupported_reason
                            or "supporting evidence is missing a locator, source version, or snippet"
                        )

                verifier_status_value = item.get("verifier_status")
                if verifier_status_value not in {"llm_verified", "parse_failed", "failed"}:
                    verifier_status_value = (
                        "llm_verified" if hinted_verifier_status == "llm_verified" else "failed"
                    )

                start = item.get("answer_start_offset")
                end = item.get("answer_end_offset")
                if not (
                    isinstance(start, int)
                    and isinstance(end, int)
                    and start >= 0
                    and end > start
                    and assistant_message.content[start:end] == text_value
                ):
                    if support_status_value in answer_statuses:
                        support_status_value = "not_enough_evidence"
                        evidence_for_claim = []
                        unsupported_reason = (
                            unsupported_reason
                            or "claim verifier offsets did not match the final answer"
                        )
                        verifier_status_value = "failed"
                    start = None
                    end = None

                if support_status_value == "not_enough_evidence":
                    verifier_status_value = "failed"

                verified_claims.append(
                    VerifiedClaim(
                        ClaimCandidate(text_value, start, end),
                        support_status_value,
                        "answer"
                        if support_status_value in answer_statuses
                        else "insufficient_evidence",
                        verifier_status_value,
                        evidence_for_claim,
                        unsupported_reason=unsupported_reason,
                        confidence=confidence,
                    )
                )
        if not verified_claims:
            fallback_status = "not_enough_evidence" if source_backed else "not_source_grounded"
            verified_claims = [
                VerifiedClaim(
                    ClaimCandidate(
                        answer or "Assistant answer requires verification.",
                        None,
                        None,
                    ),
                    fallback_status,
                    "insufficient_evidence",
                    "failed",
                    [],
                    unsupported_reason=(
                        "source-backed answer had no complete verifier classification"
                        if source_backed
                        else "assistant answer was not grounded in retrieved or attached sources"
                    ),
                )
            ]
        retrieval_status = (
            "web_result"
            if evidence_rows
            and all(row["retrieval_status"] == "web_result" for row in evidence_rows)
            else "included_in_prompt"
            if evidence_rows
            else "retrieved"
        )
        claim_count = len(verified_claims)
        supported_count = sum(1 for claim in verified_claims if claim.support_status == "supported")
        unsupported_count = claim_count - supported_count
        not_enough_count = sum(
            1 for claim in verified_claims if claim.support_status == "not_enough_evidence"
        )
        contradicted_count = sum(
            1 for claim in verified_claims if claim.support_status == "contradicted"
        )
        partially_supported_count = sum(
            1 for claim in verified_claims if claim.support_status == "partially_supported"
        )
        out_of_scope_count = sum(
            1 for claim in verified_claims if claim.support_status == "out_of_scope"
        )
        not_source_grounded_count = sum(
            1 for claim in verified_claims if claim.support_status == "not_source_grounded"
        )
        verifier_metadata["support_status_counts"] = {
            "supported": supported_count,
            "partially_supported": partially_supported_count,
            "contradicted": contradicted_count,
            "not_enough_evidence": not_enough_count,
            "out_of_scope": out_of_scope_count,
            "not_source_grounded": not_source_grounded_count,
        }
        if supported_count == claim_count:
            support_status = "supported"
        elif supported_count > 0 or partially_supported_count > 0:
            support_status = "partially_supported"
        elif contradicted_count > 0:
            support_status = "contradicted"
        elif out_of_scope_count == claim_count:
            support_status = "out_of_scope"
        elif not_source_grounded_count == claim_count:
            support_status = "not_source_grounded"
        else:
            support_status = "not_enough_evidence"
        if hinted_verifier_status == "parse_failed":
            verifier_status = "parse_failed"
        elif hinted_verifier_status == "llm_verified" and (evidence_rows or not source_backed):
            verifier_status = "llm_verified"
        else:
            verifier_status = "failed"
    elif source_backed:
        verified_claims = [
            VerifiedClaim(
                ClaimCandidate(answer or "Not enough evidence in this scope.", None, None),
                "not_enough_evidence",
                "insufficient_evidence",
                "failed",
                [],
                unsupported_reason="source-backed answer had no selected evidence",
            )
        ]
        support_status = "not_enough_evidence"
        retrieval_status = "retrieved"
        claim_count = 1
        supported_count = 0
        unsupported_count = 1
        not_enough_count = 1
        verifier_status = "failed"
    else:
        verified_claims = [
            VerifiedClaim(
                ClaimCandidate(answer or "Assistant answer was not source-grounded.", None, None),
                "not_source_grounded",
                "insufficient_evidence",
                "failed",
                [],
                unsupported_reason="assistant answer was not grounded in retrieved or attached sources",
            )
        ]
        support_status = "not_source_grounded"
        retrieval_status = "retrieved"
        claim_count = 1
        supported_count = 0
        unsupported_count = 1
        not_enough_count = 0
        verifier_status = "failed"

    if "support_status_counts" not in verifier_metadata:
        verifier_metadata["support_status_counts"] = {
            "supported": sum(1 for claim in verified_claims if claim.support_status == "supported"),
            "partially_supported": sum(
                1 for claim in verified_claims if claim.support_status == "partially_supported"
            ),
            "contradicted": sum(
                1 for claim in verified_claims if claim.support_status == "contradicted"
            ),
            "not_enough_evidence": sum(
                1 for claim in verified_claims if claim.support_status == "not_enough_evidence"
            ),
            "out_of_scope": sum(
                1 for claim in verified_claims if claim.support_status == "out_of_scope"
            ),
            "not_source_grounded": sum(
                1 for claim in verified_claims if claim.support_status == "not_source_grounded"
            ),
        }

    verifier_metadata["claim_evidence_snapshot"] = [
        {
            "ordinal": ordinal,
            "claim_text": claim.candidate.text,
            "answer_start_offset": claim.candidate.start,
            "answer_end_offset": claim.candidate.end,
            "claim_kind": claim.claim_kind,
            "support_status": claim.support_status,
            "unsupported_reason": claim.unsupported_reason,
            "confidence": claim.confidence,
            "verifier_status": claim.verifier_status,
            "evidence": [
                {
                    "evidence_role": row.get("_evidence_role", claim.evidence_role),
                    "retrieval_id": str(row["retrieval_id"]) if row.get("retrieval_id") else None,
                    "evidence_span_id": str(row["evidence_span_id"])
                    if row.get("evidence_span_id")
                    else None,
                    "source_ref": row.get("source_ref"),
                    "context_ref": row.get("context_ref"),
                    "result_ref": row.get("result_ref"),
                    "exact_snippet": row.get("exact_snippet"),
                    "locator": row.get("locator"),
                    "deep_link": row.get("deep_link"),
                    "score": row.get("score"),
                    "retrieval_status": row.get("retrieval_status"),
                    "selected": row.get("selected"),
                    "included_in_prompt": row.get("included_in_prompt"),
                    "source_version": row.get("source_version"),
                }
                for row in claim.evidence_rows
            ],
        }
        for ordinal, claim in enumerate(verified_claims)
    ]

    verifier_run_row = db.execute(
        text(
            """
            INSERT INTO assistant_message_verifier_runs (
                message_id,
                chat_run_id,
                prompt_assembly_id,
                verifier_name,
                verifier_version,
                verifier_status,
                support_status,
                claim_count,
                supported_claim_count,
                unsupported_claim_count,
                not_enough_evidence_count,
                metadata
            )
            VALUES (
                :message_id,
                :chat_run_id,
                :prompt_assembly_id,
                :verifier_name,
                :verifier_version,
                :verifier_status,
                :support_status,
                :claim_count,
                :supported_claim_count,
                :unsupported_claim_count,
                :not_enough_evidence_count,
                :metadata
            )
            RETURNING id
            """
        ).bindparams(bindparam("metadata", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "chat_run_id": run.id,
            "prompt_assembly_id": prompt_assembly_id,
            "verifier_name": verifier_name,
            "verifier_version": verifier_version,
            "verifier_status": verifier_status,
            "support_status": support_status,
            "claim_count": claim_count,
            "supported_claim_count": supported_count,
            "unsupported_claim_count": unsupported_count,
            "not_enough_evidence_count": not_enough_count,
            "metadata": verifier_metadata,
        },
    ).one()
    verifier_run_id = verifier_run_row[0]

    db.execute(
        text(
            """
            INSERT INTO assistant_message_evidence_summaries (
                message_id,
                scope_type,
                scope_ref,
                retrieval_status,
                support_status,
                verifier_status,
                verifier_run_id,
                claim_count,
                supported_claim_count,
                unsupported_claim_count,
                not_enough_evidence_count,
                prompt_assembly_id
            )
            VALUES (
                :message_id,
                :scope_type,
                :scope_ref,
                :retrieval_status,
                :support_status,
                :verifier_status,
                :verifier_run_id,
                :claim_count,
                :supported_claim_count,
                :unsupported_claim_count,
                :not_enough_evidence_count,
                :prompt_assembly_id
            )
            """
        ).bindparams(bindparam("scope_ref", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "scope_type": scope_type,
            "scope_ref": scope_ref,
            "retrieval_status": retrieval_status,
            "support_status": support_status,
            "verifier_run_id": verifier_run_id,
            "claim_count": claim_count,
            "supported_claim_count": supported_count,
            "unsupported_claim_count": unsupported_count,
            "not_enough_evidence_count": not_enough_count,
            "prompt_assembly_id": prompt_assembly_id,
            "verifier_status": verifier_status,
        },
    )

    if claim_count == 0:
        persist_message_citation_audit(
            db,
            run=run,
            assistant_message=assistant_message,
            verifier_run_id=verifier_run_id,
        )
        return [], []

    insert_claim = text(
        """
        INSERT INTO assistant_message_claims (
            message_id,
            ordinal,
            claim_text,
            answer_start_offset,
            answer_end_offset,
            claim_kind,
            support_status,
            unsupported_reason,
            confidence,
            verifier_status,
            verifier_run_id
        )
        VALUES (
            :message_id,
            :ordinal,
            :claim_text,
            :answer_start_offset,
            :answer_end_offset,
            :claim_kind,
            :support_status,
            :unsupported_reason,
            :confidence,
            :verifier_status,
            :verifier_run_id
        )
        RETURNING id, created_at
        """
    )

    insert_evidence = text(
        """
        INSERT INTO assistant_message_claim_evidence (
            claim_id,
            ordinal,
            evidence_role,
            source_ref,
            retrieval_id,
            evidence_span_id,
            context_ref,
            result_ref,
            exact_snippet,
            snippet_prefix,
            snippet_suffix,
            locator,
            deep_link,
            score,
            retrieval_status,
            selected,
            included_in_prompt,
            source_version
        )
        VALUES (
            :claim_id,
            :ordinal,
            :evidence_role,
            :source_ref,
            :retrieval_id,
            :evidence_span_id,
            :context_ref,
            :result_ref,
            :exact_snippet,
            :snippet_prefix,
            :snippet_suffix,
            :locator,
            :deep_link,
            :score,
            :retrieval_status,
            :selected,
            :included_in_prompt,
            :source_version
        )
        RETURNING id, created_at
        """
    ).bindparams(
        bindparam("source_ref", type_=JSONB),
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    claim_events: list[dict[str, object]] = []
    claim_evidence_events: list[dict[str, object]] = []
    for claim_ordinal, verified_claim in enumerate(verified_claims):
        claim = verified_claim.candidate
        claim_row = db.execute(
            insert_claim,
            {
                "message_id": assistant_message.id,
                "ordinal": claim_ordinal,
                "claim_text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "claim_kind": verified_claim.claim_kind,
                "support_status": verified_claim.support_status,
                "unsupported_reason": verified_claim.unsupported_reason,
                "confidence": verified_claim.confidence,
                "verifier_status": verified_claim.verifier_status,
                "verifier_run_id": verifier_run_id,
            },
        ).one()
        claim_id = claim_row[0]
        claim_events.append(
            {
                "id": str(claim_id),
                "message_id": str(assistant_message.id),
                "ordinal": claim_ordinal,
                "claim_text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "claim_kind": verified_claim.claim_kind,
                "support_status": verified_claim.support_status,
                "unsupported_reason": verified_claim.unsupported_reason,
                "confidence": verified_claim.confidence,
                "verifier_status": verified_claim.verifier_status,
                "verifier_run_id": str(verifier_run_id),
                "created_at": claim_row[1].isoformat(),
            }
        )
        for evidence_ordinal, row in enumerate(verified_claim.evidence_rows):
            evidence_role = row.get("_evidence_role")
            if evidence_role not in {"supports", "contradicts", "context", "scope_boundary"}:
                evidence_role = verified_claim.evidence_role
            clean_row = {key: value for key, value in row.items() if key != "_evidence_role"}
            evidence_row = db.execute(
                insert_evidence,
                {
                    "claim_id": claim_id,
                    "ordinal": evidence_ordinal,
                    "evidence_role": evidence_role,
                    **clean_row,
                },
            ).one()
            claim_evidence_events.append(
                {
                    "id": str(evidence_row[0]),
                    "claim_id": str(claim_id),
                    "ordinal": evidence_ordinal,
                    "evidence_role": evidence_role,
                    "source_ref": clean_row["source_ref"],
                    "retrieval_id": str(clean_row["retrieval_id"])
                    if clean_row.get("retrieval_id")
                    else None,
                    "evidence_span_id": str(clean_row["evidence_span_id"])
                    if clean_row.get("evidence_span_id")
                    else None,
                    "context_ref": clean_row.get("context_ref"),
                    "result_ref": clean_row.get("result_ref"),
                    "exact_snippet": clean_row.get("exact_snippet"),
                    "snippet_prefix": clean_row.get("snippet_prefix"),
                    "snippet_suffix": clean_row.get("snippet_suffix"),
                    "locator": clean_row.get("locator"),
                    "deep_link": clean_row.get("deep_link"),
                    "score": clean_row.get("score"),
                    "retrieval_status": clean_row.get("retrieval_status"),
                    "selected": clean_row.get("selected"),
                    "included_in_prompt": clean_row.get("included_in_prompt"),
                    "source_version": clean_row.get("source_version"),
                    "created_at": evidence_row[1].isoformat(),
                }
            )
    persist_message_citation_audit(
        db,
        run=run,
        assistant_message=assistant_message,
        verifier_run_id=verifier_run_id,
    )
    return claim_events, claim_evidence_events


def persist_message_citation_audit(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message,
    verifier_run_id: UUID,
) -> None:
    rows = db.execute(
        text(
            """
            SELECT c.id AS claim_id,
                   c.ordinal AS claim_ordinal,
                   c.claim_text,
                   c.answer_start_offset,
                   c.answer_end_offset,
                   c.support_status,
                   e.id AS evidence_id,
                   e.evidence_role,
                   e.locator,
                   e.source_version,
                   e.exact_snippet
            FROM assistant_message_claims c
            LEFT JOIN assistant_message_claim_evidence e ON e.claim_id = c.id
            WHERE c.message_id = :message_id
              AND c.verifier_run_id = :verifier_run_id
            ORDER BY c.ordinal ASC, e.ordinal ASC
            """
        ),
        {"message_id": assistant_message.id, "verifier_run_id": verifier_run_id},
    ).mappings()

    supported_claims: dict[UUID, dict[str, object]] = {}
    supported_claim_evidence: dict[UUID, int] = {}
    contradiction_pairs: list[dict[str, object]] = []
    missing_locator_evidence_ids: list[str] = []
    missing_source_version_evidence_ids: list[str] = []
    missing_snippet_evidence_ids: list[str] = []
    partially_supported_claim_ids: list[str] = []
    contradicted_claim_ids: list[str] = []
    for row in rows:
        claim_id = row["claim_id"]
        if row["support_status"] in {"supported", "partially_supported"}:
            supported_claims[claim_id] = {
                "id": claim_id,
                "ordinal": row["claim_ordinal"],
                "claim_text": row["claim_text"],
                "answer_start_offset": row["answer_start_offset"],
                "answer_end_offset": row["answer_end_offset"],
            }
        evidence_id = row["evidence_id"]
        if evidence_id is None:
            continue
        if row["support_status"] == "partially_supported":
            partially_supported_claim_ids.append(str(claim_id))
        if row["support_status"] == "contradicted":
            contradicted_claim_ids.append(str(claim_id))
        if (
            row["support_status"] in {"supported", "partially_supported"}
            and row["evidence_role"] == "supports"
        ):
            supported_claim_evidence[claim_id] = supported_claim_evidence.get(claim_id, 0) + 1
        if row["support_status"] == "contradicted" and row["evidence_role"] == "contradicts":
            contradiction_pairs.append(
                {
                    "claim_id": str(claim_id),
                    "claim_ordinal": row["claim_ordinal"],
                    "evidence_id": str(evidence_id),
                }
            )
        locator = row["locator"]
        if not isinstance(locator, dict) or not locator:
            missing_locator_evidence_ids.append(str(evidence_id))
        source_version = row["source_version"]
        if not isinstance(source_version, str) or not source_version.strip():
            missing_source_version_evidence_ids.append(str(evidence_id))
        exact_snippet = row["exact_snippet"]
        if row["evidence_role"] in {"supports", "contradicts"} and (
            not isinstance(exact_snippet, str) or not exact_snippet.strip()
        ):
            missing_snippet_evidence_ids.append(str(evidence_id))

    invalid_offset_claim_ids: list[str] = []
    missing_citation_claim_ids: list[str] = []
    valid_offset_count = 0
    citation_count = 0
    for claim_id, claim in supported_claims.items():
        has_valid_offset = claim_has_valid_answer_offsets(assistant_message.content, claim)
        if has_valid_offset:
            valid_offset_count += 1
        else:
            invalid_offset_claim_ids.append(str(claim_id))
        if has_valid_offset and supported_claim_evidence.get(claim_id, 0) > 0:
            citation_count += 1
        else:
            missing_citation_claim_ids.append(str(claim_id))

    supported_claim_count = len(supported_claims)
    details = {
        "invalid_offset_claim_ids": invalid_offset_claim_ids[:20],
        "missing_citation_claim_ids": missing_citation_claim_ids[:20],
        "missing_locator_evidence_ids": missing_locator_evidence_ids[:20],
        "missing_source_version_evidence_ids": missing_source_version_evidence_ids[:20],
        "missing_snippet_count": len(missing_snippet_evidence_ids),
        "missing_snippet_evidence_ids": missing_snippet_evidence_ids[:20],
        "partially_supported_claim_ids": sorted(set(partially_supported_claim_ids))[:20],
        "contradicted_claim_ids": sorted(set(contradicted_claim_ids))[:20],
        "contradiction_pairs": contradiction_pairs[:20],
    }
    details = {key: value for key, value in details.items() if value}

    db.execute(
        text(
            """
            INSERT INTO assistant_message_citation_audits (
                message_id,
                chat_run_id,
                verifier_run_id,
                supported_claim_count,
                supported_claims_with_valid_offsets_count,
                supported_claims_with_citation_count,
                missing_locator_count,
                missing_source_version_count,
                supported_claims_have_valid_offsets,
                supported_claims_have_citation_placement,
                claim_evidence_has_required_locators,
                claim_evidence_has_source_versions,
                details
            )
            VALUES (
                :message_id,
                :chat_run_id,
                :verifier_run_id,
                :supported_claim_count,
                :supported_claims_with_valid_offsets_count,
                :supported_claims_with_citation_count,
                :missing_locator_count,
                :missing_source_version_count,
                :supported_claims_have_valid_offsets,
                :supported_claims_have_citation_placement,
                :claim_evidence_has_required_locators,
                :claim_evidence_has_source_versions,
                :details
            )
            """
        ).bindparams(bindparam("details", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "chat_run_id": run.id,
            "verifier_run_id": verifier_run_id,
            "supported_claim_count": supported_claim_count,
            "supported_claims_with_valid_offsets_count": valid_offset_count,
            "supported_claims_with_citation_count": citation_count,
            "missing_locator_count": len(missing_locator_evidence_ids),
            "missing_source_version_count": len(missing_source_version_evidence_ids),
            "supported_claims_have_valid_offsets": valid_offset_count == supported_claim_count,
            "supported_claims_have_citation_placement": citation_count == supported_claim_count,
            "claim_evidence_has_required_locators": not missing_locator_evidence_ids,
            "claim_evidence_has_source_versions": not missing_source_version_evidence_ids,
            "details": details,
        },
    )

