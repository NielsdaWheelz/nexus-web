import json
from pathlib import Path

from nexus.ops.codex_hosted_evidence import codex_hosted_evidence_is_valid


def _evidence() -> dict[str, object]:
    plans = (
        ("routine", "gpt-5.6-luna", "low", 0),
        ("standard", "gpt-5.6-terra", "medium", 0),
        ("thorough", "gpt-5.6-terra", "high", 0),
        ("deep", "gpt-5.6-sol", "high", 1),
    )
    return {
        "schema_version": "nexus-hosted-codex-canary.v2",
        "run_id": "0123456789abcdef",
        "subscription_turns": 4,
        "results": [
            {
                "plan_id": plan_id,
                "plan_revision": "2026-08-20.1",
                "model": model,
                "reasoning": reasoning,
                "backend": "codex",
                "transport": "sdk",
                "auth_profile": "codex-personal",
                "terminal_status": "succeeded",
                "structured_output_valid": True,
                "session_ref_schema_version": "agent-session-ref.v1",
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
                "sdk_version": "0.144.4",
                "runtime_version": "1.0.0",
                "tool_events": tool_events,
                "elapsed_ms": 1,
                "permission_requests": 0,
            }
            for plan_id, model, reasoning, tool_events in plans
        ],
    }


def test_hosted_canary_accepts_exact_four_plan_v2_receipt(tmp_path: Path) -> None:
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(_evidence()), encoding="utf-8")
    assert codex_hosted_evidence_is_valid(path, run_id="0123456789abcdef")


def test_hosted_canary_rejects_unsafe_or_unbounded_receipt(tmp_path: Path) -> None:
    evidence = _evidence()
    results = evidence["results"]
    assert isinstance(results, list)
    results[3]["permission_requests"] = 1
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(evidence), encoding="utf-8")
    assert not codex_hosted_evidence_is_valid(path, run_id="0123456789abcdef")
