"""Pure parsing/status helpers for the claim extractor and claim verifier protocols."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ClaimCandidate:
    text: str
    start: int | None
    end: int | None


@dataclass(frozen=True)
class VerifiedClaim:
    candidate: ClaimCandidate
    support_status: str
    claim_kind: str
    verifier_status: str
    evidence_rows: list[dict[str, Any]]
    evidence_role: str = "supports"
    unsupported_reason: str | None = None
    confidence: float | None = None


def failed_claim_statuses(
    claim_candidates: list[ClaimCandidate],
    *,
    unsupported_reason: str = "claim was not verified against source evidence",
) -> list[dict[str, Any]]:
    return [
        {
            "ordinal": ordinal,
            "text": claim.text,
            "answer_start_offset": claim.start,
            "answer_end_offset": claim.end,
            "support_status": "not_enough_evidence",
            "verifier_status": "failed",
            "evidence_ordinals": [],
            "unsupported_reason": unsupported_reason,
        }
        for ordinal, claim in enumerate(claim_candidates)
    ]


def failed_verifier_hint(
    *,
    verifier_name: str,
    status_detail: str,
    claim_candidates: list[ClaimCandidate],
    evidence_count: int,
    source_backed: bool,
    parse_failed: bool,
) -> dict[str, Any]:
    claim_statuses = failed_claim_statuses(claim_candidates)
    return {
        "verifier_name": verifier_name,
        "verifier_version": "v1",
        "verifier_status": "parse_failed" if parse_failed else "failed",
        "metadata": {
            "verifier": verifier_name,
            "status_detail": status_detail,
            "draft_claim_count": len(claim_candidates),
            "evidence_count": evidence_count,
            "claim_statuses": claim_statuses,
            "draft_claim_statuses": [dict(item) for item in claim_statuses],
            "removed_claim_statuses": [dict(item) for item in claim_statuses],
            "unsupported_claim_statuses": [dict(item) for item in claim_statuses],
            "draft_unsupported_claim_count": len(claim_statuses),
            "unsupported_claim_count": len(claim_statuses),
            "removed_claim_count": len(claim_statuses),
            "rewrote_answer": True,
            "source_backed": source_backed,
        },
    }


def parse_claim_extractor_response(
    raw_response: str,
    *,
    assistant_content: str,
) -> list[ClaimCandidate]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("claims"), list):
        raise ValueError("claim extractor response must be an object with a claims array")

    claims: list[ClaimCandidate] = []
    seen_ranges: set[tuple[int, int]] = set()
    for item in parsed["claims"]:
        if not isinstance(item, dict):
            raise ValueError("claim extractor item must be an object")
        text_value = item.get("text")
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        if (
            not isinstance(text_value, str)
            or not text_value.strip()
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or end <= start
            or end > len(assistant_content)
        ):
            raise ValueError("claim extractor item has invalid text or offsets")
        if assistant_content[start:end] != text_value:
            raise ValueError("claim extractor offsets do not match the answer draft")
        claim_range = (start, end)
        if claim_range in seen_ranges:
            raise ValueError("claim extractor returned duplicate offsets")
        seen_ranges.add(claim_range)
        claims.append(ClaimCandidate(text_value, start, end))
    return sorted(claims, key=lambda claim: (claim.start or 0, claim.end or 0))


def parse_claim_verifier_response(
    raw_response: str,
    *,
    claim_count: int,
    evidence_count: int,
) -> list[dict[str, Any]]:
    raw = raw_response.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("claims"), list):
        raise ValueError("claim verifier response must be an object with a claims array")

    statuses = {
        "supported",
        "partially_supported",
        "contradicted",
        "not_enough_evidence",
        "out_of_scope",
        "not_source_grounded",
    }
    classified_claims: list[dict[str, Any]] = []
    seen_ordinals: set[int] = set()
    for item in parsed["claims"]:
        if not isinstance(item, dict):
            raise ValueError("claim verifier item must be an object")
        ordinal = item.get("ordinal")
        support_status = item.get("support_status")
        start = item.get("answer_start_offset")
        end = item.get("answer_end_offset")
        evidence_ordinals = item.get("evidence_ordinals", [])
        supporting_evidence_ordinals = item.get("supporting_evidence_ordinals", [])
        contradicting_evidence_ordinals = item.get("contradicting_evidence_ordinals", [])
        context_evidence_ordinals = item.get("context_evidence_ordinals", [])
        if not isinstance(ordinal, int) or ordinal < 0 or ordinal >= claim_count:
            raise ValueError("claim verifier ordinal is out of range")
        if ordinal in seen_ordinals:
            raise ValueError("claim verifier duplicate ordinal")
        if support_status not in statuses:
            raise ValueError("claim verifier support_status is invalid")
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start:
            raise ValueError("claim verifier answer offsets are invalid")
        ordinal_lists = [
            evidence_ordinals,
            supporting_evidence_ordinals,
            contradicting_evidence_ordinals,
            context_evidence_ordinals,
        ]
        if any(
            not isinstance(values, list)
            or any(
                not isinstance(index, int) or index < 0 or index >= evidence_count
                for index in values
            )
            for values in ordinal_lists
        ):
            raise ValueError("claim verifier evidence ordinal is out of range")
        if not evidence_ordinals:
            evidence_ordinals = [
                *supporting_evidence_ordinals,
                *contradicting_evidence_ordinals,
                *context_evidence_ordinals,
            ]
        if (
            support_status in {"supported", "partially_supported"}
            and not supporting_evidence_ordinals
        ):
            supporting_evidence_ordinals = list(evidence_ordinals)
        if support_status == "contradicted" and (
            not supporting_evidence_ordinals or not contradicting_evidence_ordinals
        ):
            raise ValueError(
                "claim verifier contradicted item missing support or conflict evidence"
            )
        if (
            support_status
            in {
                "supported",
                "partially_supported",
                "contradicted",
            }
            and not evidence_ordinals
        ):
            raise ValueError(
                "claim verifier supported, partial, or contradicted item missing evidence"
            )
        seen_ordinals.add(ordinal)
        claim = {
            "ordinal": ordinal,
            "answer_start_offset": start,
            "answer_end_offset": end,
            "support_status": support_status,
            "evidence_ordinals": sorted(set(evidence_ordinals)),
            "supporting_evidence_ordinals": sorted(set(supporting_evidence_ordinals)),
            "contradicting_evidence_ordinals": sorted(set(contradicting_evidence_ordinals)),
            "context_evidence_ordinals": sorted(set(context_evidence_ordinals)),
        }
        unsupported_reason = item.get("unsupported_reason")
        if isinstance(unsupported_reason, str) and unsupported_reason.strip():
            claim["unsupported_reason"] = unsupported_reason.strip()
        elif support_status in {
            "not_enough_evidence",
            "out_of_scope",
            "not_source_grounded",
        }:
            raise ValueError("claim verifier unsupported item missing unsupported_reason")
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            claim["confidence"] = max(0.0, min(float(confidence), 1.0))
        classified_claims.append(claim)

    if len(seen_ordinals) != claim_count:
        raise ValueError("claim verifier did not classify every claim")
    return sorted(classified_claims, key=lambda item: item["ordinal"])


def claim_has_valid_answer_offsets(answer: str, claim: dict[str, object]) -> bool:
    start = claim.get("answer_start_offset")
    end = claim.get("answer_end_offset")
    text_value = claim.get("claim_text")
    if not isinstance(start, int) or not isinstance(end, int) or not isinstance(text_value, str):
        return False
    if start < 0 or end <= start or end > len(answer):
        return False
    return answer[start:end].strip() == text_value.strip()
