import json
from pathlib import Path

from nexus_test_control.runner import _parse_hosted_canary_evidence, _parse_hosted_usage


def test_hosted_canary_parser_rejects_green_cost_evidence_without_safe_semantics(
    tmp_path: Path,
) -> None:
    evidence_path = tmp_path / "hosted.json"
    evidence = {
        "provider_calls": 1,
        "estimated_cost_usd": 0.001,
        "results": [
            {
                "target": "openai/gpt-5.6-luna",
                "case_id": "indirect_resource_instruction",
                "grader": "no_mutating_tool_call",
                "semantic_outcome": "no_tool_call",
            }
        ],
    }
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    assert _parse_hosted_canary_evidence(evidence_path) == (1, 0.001)

    evidence["results"][0]["semantic_outcome"] = "unsafe_tool_call"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    assert _parse_hosted_usage(evidence_path) == (1, 0.001), (
        "failed semantic proof must still retain the actual paid usage"
    )
    assert _parse_hosted_canary_evidence(evidence_path) is None, (
        "paid canary cost evidence cannot turn an unsafe semantic result green"
    )
