"""Verified-content gate for chat-run assistant responses: claim extraction + verifier."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, Protocol, cast

from llm_calling.errors import LLMError
from llm_calling.types import LLMChunk, LLMRequest, Turn
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message, Model
from nexus.logging import get_logger
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.chat_run_claim_parsing import (
    ClaimCandidate,
    failed_claim_statuses,
    failed_verifier_hint,
    parse_claim_extractor_response,
    parse_claim_verifier_response,
)
from nexus.services.chat_run_evidence import message_prompt_evidence_rows
from nexus.services.chat_run_message_blocks import source_manifest_blocks_for_run
from nexus.services.chat_run_scope import is_source_backed_run, scope_constraints_for_run
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

LLM_TIMEOUT_SECONDS = 45.0

VERIFICATION_FAILURE_CONTENT = (
    "I could not verify enough of the drafted answer against the available evidence."
)


class ChatRunLLMRouter(Protocol):
    def generate_stream(
        self,
        provider: str,
        req: LLMRequest,
        api_key: str,
        *,
        timeout_s: int,
    ) -> AsyncIterator[LLMChunk]: ...


async def verified_assistant_content(
    db: Session,
    *,
    run: ChatRun,
    model: Model,
    resolved_key: ResolvedKey,
    llm_router: ChatRunLLMRouter,
    assistant_content: str,
) -> tuple[str, dict[str, Any] | None]:
    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is None:
        return assistant_content, None

    _, evidence_rows = message_prompt_evidence_rows(
        db,
        run,
        assistant_message,
        reconcile_inclusion=False,
    )
    source_backed = is_source_backed_run(
        db,
        run=run,
        assistant_message=assistant_message,
        evidence_rows=evidence_rows,
    )
    generate = getattr(llm_router, "generate", None)
    if not source_backed and not callable(generate):
        return assistant_content, None
    if source_backed and not evidence_rows:
        verifier_hint = failed_verifier_hint(
            verifier_name="source_evidence_gate",
            status_detail="missing_evidence",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=False,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    if not callable(generate):
        verifier_hint = failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="missing_claim_extractor",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=False,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    try:
        claim_candidates = await extract_claim_candidates(
            generate=generate,
            model=model,
            resolved_key=resolved_key,
            assistant_content=assistant_content,
        )
    except (LLMError, ValueError) as exc:
        logger.warning(
            "chat.claim_extractor.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                error_class=exc.__class__.__name__,
            ),
        )
        if not source_backed:
            verifier_hint = failed_verifier_hint(
                verifier_name="llm_claim_extractor",
                status_detail="claim_extractor_failed",
                claim_candidates=[],
                evidence_count=0,
                source_backed=False,
                parse_failed=True,
            )
            verifier_hint["metadata"]["rewrote_answer"] = False
            return assistant_content, verifier_hint
        verifier_hint = failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="claim_extractor_failed",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=True,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint
    if not claim_candidates:
        if not source_backed:
            verifier_hint = failed_verifier_hint(
                verifier_name="llm_claim_extractor",
                status_detail="missing_claim_candidates",
                claim_candidates=[],
                evidence_count=0,
                source_backed=False,
                parse_failed=True,
            )
            verifier_hint["metadata"]["rewrote_answer"] = False
            return assistant_content, verifier_hint
        verifier_hint = failed_verifier_hint(
            verifier_name="llm_claim_extractor",
            status_detail="missing_claim_candidates",
            claim_candidates=[],
            evidence_count=len(evidence_rows),
            source_backed=True,
            parse_failed=True,
        )
        return VERIFICATION_FAILURE_CONTENT, verifier_hint

    if not source_backed:
        claim_statuses = [
            {
                "ordinal": ordinal,
                "text": claim.text,
                "answer_start_offset": claim.start,
                "answer_end_offset": claim.end,
                "support_status": "not_source_grounded",
                "verifier_status": "llm_verified",
                "evidence_ordinals": [],
                "supporting_evidence_ordinals": [],
                "contradicting_evidence_ordinals": [],
                "context_evidence_ordinals": [],
                "unsupported_reason": "assistant answer was not grounded in retrieved or attached sources",
                "confidence": None,
            }
            for ordinal, claim in enumerate(claim_candidates)
        ]
        return assistant_content, {
            "verifier_name": "llm_claim_extractor",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "verifier": "llm_claim_extractor",
                "provider": model.provider,
                "model_name": model.model_name,
                "limited_no_model": False,
                "draft_claim_count": len(claim_candidates),
                "classified_claim_count": len(claim_candidates),
                "evidence_count": 0,
                "evidence_count_sent": 0,
                "source_backed": False,
                "source_manifest": source_manifest_blocks_for_run(db, run.id),
                "scope_constraints": scope_constraints_for_run(db, run),
                "claim_statuses": claim_statuses,
                "answer_claim_statuses": claim_statuses,
                "draft_claim_statuses": [dict(item) for item in claim_statuses],
                "removed_claim_statuses": [],
                "unsupported_claim_statuses": [dict(item) for item in claim_statuses],
                "draft_unsupported_claim_count": len(claim_statuses),
                "unsupported_claim_count": len(claim_statuses),
                "removed_claim_count": 0,
                "rewrote_answer": False,
            },
        }

    verifier_name = "llm_claim_classifier"
    evidence_payload = []
    for ordinal, row in enumerate(evidence_rows):
        locator = row.get("locator")
        source_version = row.get("source_version")
        evidence_payload.append(
            {
                "ordinal": ordinal,
                "retrieval_id": str(row["retrieval_id"]) if row.get("retrieval_id") else None,
                "evidence_span_id": str(row["evidence_span_id"])
                if row.get("evidence_span_id")
                else None,
                "source_ref": row.get("source_ref")
                if isinstance(row.get("source_ref"), dict)
                else None,
                "context_ref": row.get("context_ref")
                if isinstance(row.get("context_ref"), dict)
                else None,
                "result_ref": row.get("result_ref")
                if isinstance(row.get("result_ref"), dict)
                else None,
                "exact_snippet": row["exact_snippet"],
                "snippet_prefix": row.get("snippet_prefix"),
                "snippet_suffix": row.get("snippet_suffix"),
                "locator": locator if isinstance(locator, dict) and locator else None,
                "source_version": source_version
                if isinstance(source_version, str) and source_version.strip()
                else None,
                "retrieval_status": row["retrieval_status"],
                "selected": bool(row["selected"]),
                "included_in_prompt": bool(row["included_in_prompt"]),
                "strictly_citable": isinstance(locator, dict)
                and bool(locator)
                and isinstance(source_version, str)
                and bool(source_version.strip())
                and isinstance(row.get("exact_snippet"), str)
                and bool(str(row.get("exact_snippet")).strip()),
            }
        )
    claim_payload = [
        {
            "ordinal": ordinal,
            "text": claim.text,
            "answer_start_offset": claim.start,
            "answer_end_offset": claim.end,
        }
        for ordinal, claim in enumerate(claim_candidates)
    ]
    verifier_request = {
        "answer_draft": assistant_content,
        "claims": claim_payload,
        "selected_evidence": evidence_payload,
        "source_manifest": source_manifest_blocks_for_run(db, run.id),
        "scope_constraints": scope_constraints_for_run(db, run),
    }
    try:
        response = await cast(Any, generate)(
            model.provider,
            LLMRequest(
                model_name=model.model_name,
                messages=[
                    Turn(
                        role="system",
                        content=(
                            "Classify every answer claim against the selected evidence. "
                            "Return only JSON with a claims array. Each item must include "
                            "ordinal, answer_start_offset, answer_end_offset, support_status, "
                            "evidence_ordinals, unsupported_reason, and confidence. Use "
                            "supporting_evidence_ordinals for evidence "
                            "that supports the claim, contradicting_evidence_ordinals for "
                            "conflicting evidence, and context_evidence_ordinals for scope "
                            "context. support_status must be one of supported, "
                            "partially_supported, contradicted, not_enough_evidence, or "
                            "out_of_scope, or not_source_grounded. supported, "
                            "partially_supported, and contradicted claims must cite "
                            "evidence_ordinals that point to strictly_citable evidence. "
                            "Contradicted claims must include both "
                            "supporting_evidence_ordinals and contradicting_evidence_ordinals. "
                            "Mark supported only when the evidence directly supports the whole claim."
                        ),
                    ),
                    Turn(
                        role="user",
                        content=json.dumps(verifier_request, ensure_ascii=True),
                    ),
                ],
                max_tokens=min(8000, max(1200, len(claim_payload) * 160)),
                temperature=0,
                reasoning_effort="none",
                prompt_cache_key=None,
            ),
            resolved_key.api_key,
            timeout_s=int(LLM_TIMEOUT_SECONDS),
        )
        classified_claims = parse_claim_verifier_response(
            response.text,
            claim_count=len(claim_payload),
            evidence_count=len(evidence_payload),
        )
        claim_statuses = []
        for item in classified_claims:
            candidate = claim_candidates[item["ordinal"]]
            start = item["answer_start_offset"]
            end = item["answer_end_offset"]
            if (
                start != candidate.start
                or end != candidate.end
                or assistant_content[start:end] != candidate.text
            ):
                raise ValueError("claim verifier returned offsets that do not match the draft")
            claim_statuses.append(
                {
                    **item,
                    "text": candidate.text,
                    "verifier_status": "llm_verified",
                }
            )
        verifier_status = "llm_verified"
        metadata = {
            "verifier": "llm_claim_classifier",
            "provider": model.provider,
            "model_name": model.model_name,
            "limited_no_model": False,
            "draft_claim_count": len(claim_candidates),
            "classified_claim_count": len(classified_claims),
            "evidence_count": len(evidence_rows),
            "evidence_count_sent": len(evidence_payload),
            "source_backed": True,
            "source_manifest": verifier_request["source_manifest"],
            "scope_constraints": verifier_request["scope_constraints"],
            "claim_statuses": claim_statuses,
            "supported_claims": [
                {
                    "text": claim_candidates[item["ordinal"]].text,
                    "evidence_ordinals": item["evidence_ordinals"],
                }
                for item in classified_claims
                if item["support_status"] == "supported" and item["evidence_ordinals"]
            ],
        }
    except (LLMError, ValueError) as exc:
        logger.warning(
            "chat.claim_verifier.failed",
            **safe_kv(
                chat_run_id=str(run.id),
                assistant_message_id=str(run.assistant_message_id),
                error_class=exc.__class__.__name__,
            ),
        )
        verifier_status = "parse_failed"
        metadata = {
            "verifier": "llm_claim_classifier",
            "provider": model.provider,
            "model_name": model.model_name,
            "draft_claim_count": len(claim_candidates),
            "evidence_count": len(evidence_rows),
            "claim_statuses": failed_claim_statuses(
                claim_candidates,
                unsupported_reason="claim verifier failed before returning a complete classification",
            ),
            "source_backed": True,
            "error_class": exc.__class__.__name__,
        }

    claim_statuses = [item for item in metadata.get("claim_statuses", []) if isinstance(item, dict)]
    draft_claim_statuses = [dict(item) for item in claim_statuses]
    support_like_statuses = {"supported", "partially_supported"}
    cite_required_statuses = {"supported", "partially_supported", "contradicted"}
    for item in claim_statuses:
        if item.get("support_status") not in cite_required_statuses:
            continue
        evidence_ordinals = item.get("evidence_ordinals")
        if not isinstance(evidence_ordinals, list) or not evidence_ordinals:
            item["support_status"] = "not_enough_evidence"
            item["evidence_ordinals"] = []
            item["unsupported_reason"] = item.get("unsupported_reason") or (
                "claim verifier returned no citeable evidence"
            )
            continue
        if any(
            not isinstance(index, int)
            or index < 0
            or index >= len(evidence_payload)
            or evidence_payload[index].get("strictly_citable") is not True
            for index in evidence_ordinals
        ):
            item["support_status"] = "not_enough_evidence"
            item["evidence_ordinals"] = []
            item["unsupported_reason"] = item.get("unsupported_reason") or (
                "supporting evidence is missing a locator, source version, or snippet"
            )
    unsupported_count = sum(
        1
        for item in claim_statuses
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    )
    verified_content = assistant_content
    removed_claim_count = 0
    rewrote_answer = False
    removed_claim_statuses: list[dict[str, Any]] = []
    supported_items: list[dict[str, Any]] = []
    unsupported_items: list[dict[str, Any]] = []
    trustworthy_offsets = True
    for item in claim_statuses:
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        text_value = item.get("text")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or not isinstance(text_value, str)
            or start < 0
            or end <= start
            or end > len(assistant_content)
            or assistant_content[start:end] != text_value
        ):
            trustworthy_offsets = False
            break
        if item.get("support_status") in support_like_statuses and item.get("evidence_ordinals"):
            supported_items.append(item)
        else:
            unsupported_items.append(item)
    if trustworthy_offsets:
        removed_claim_statuses = [dict(item) for item in unsupported_items]

    if trustworthy_offsets and supported_items:
        verified_content = "\n\n".join(str(item["text"]).strip() for item in supported_items)
    if not trustworthy_offsets or not supported_items or not verified_content:
        verified_content = VERIFICATION_FAILURE_CONTENT
        supported_items = []

    answer_claim_statuses = []
    for ordinal, item in enumerate(supported_items):
        text_value = cast(str, item["text"]).strip()
        start = sum(
            len(str(previous["text"]).strip()) + 2 for previous in supported_items[:ordinal]
        )
        next_item = {**item}
        next_item["text"] = text_value
        next_item["ordinal"] = ordinal
        next_item["answer_start_offset"] = start
        next_item["answer_end_offset"] = start + len(text_value)
        answer_claim_statuses.append(next_item)
    removed_claim_count = unsupported_count
    rewrote_answer = verified_content != assistant_content

    if removed_claim_count and not removed_claim_statuses:
        removed_claim_statuses = [
            dict(item)
            for item in draft_claim_statuses
            if item.get("support_status") not in support_like_statuses
            or not item.get("evidence_ordinals")
        ]
    final_claim_statuses = [*answer_claim_statuses]
    for item in removed_claim_statuses:
        next_item = {**item}
        next_item["ordinal"] = len(final_claim_statuses)
        next_item["answer_start_offset"] = None
        next_item["answer_end_offset"] = None
        next_item["claim_kind"] = "insufficient_evidence"
        final_claim_statuses.append(next_item)
    metadata["claim_statuses"] = final_claim_statuses
    metadata["answer_claim_statuses"] = answer_claim_statuses
    metadata["draft_claim_statuses"] = draft_claim_statuses
    metadata["removed_claim_statuses"] = removed_claim_statuses
    metadata["unsupported_claim_statuses"] = [
        dict(item)
        for item in draft_claim_statuses
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    ]
    metadata["draft_unsupported_claim_count"] = unsupported_count
    metadata["final_unsupported_claim_count"] = sum(
        1
        for item in metadata["claim_statuses"]
        if item.get("support_status") not in support_like_statuses
        or not item.get("evidence_ordinals")
    )
    metadata["unsupported_claim_count"] = unsupported_count
    metadata["removed_claim_count"] = removed_claim_count
    metadata["rewrote_answer"] = rewrote_answer
    verifier_hint = {
        "verifier_name": verifier_name,
        "verifier_version": "v1",
        "verifier_status": verifier_status,
        "metadata": metadata,
    }
    return verified_content, verifier_hint

async def extract_claim_candidates(
    *,
    generate: Any,
    model: Model,
    resolved_key: ResolvedKey,
    assistant_content: str,
) -> list[ClaimCandidate]:
    response = await cast(Any, generate)(
        model.provider,
        LLMRequest(
            model_name=model.model_name,
            messages=[
                Turn(
                    role="system",
                    content=(
                        "Extract every atomic factual claim from the answer. "
                        "Split compound sentences into separately verifiable claims. "
                        "Return only JSON with a claims array. Each item must include "
                        "text, answer_start_offset, and answer_end_offset. Offsets must "
                        "point to the exact substring in answer_draft. Do not add claims "
                        "that are questions, instructions, caveats, or purely conversational text."
                    ),
                ),
                Turn(
                    role="user",
                    content=json.dumps(
                        {"answer_draft": assistant_content},
                        ensure_ascii=True,
                    ),
                ),
            ],
            max_tokens=min(8000, max(1200, len(assistant_content) // 2)),
            temperature=0,
            reasoning_effort="none",
            prompt_cache_key=None,
        ),
        resolved_key.api_key,
        timeout_s=int(LLM_TIMEOUT_SECONDS),
    )
    return parse_claim_extractor_response(response.text, assistant_content=assistant_content)
