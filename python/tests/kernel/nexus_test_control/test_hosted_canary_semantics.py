import json
from importlib.util import find_spec
from pathlib import Path

from nexus.ops.codex_hosted_evidence import codex_hosted_evidence_is_valid

_SOURCE_SHA = "a" * 40


def _evidence() -> dict[str, object]:
    from nexus.services import generation_policy

    plans = (
        ("routine", "metadata_enrichment", None, "structured", "gpt-5.6-luna", "low", 0),
        ("standard", "dawn_write", None, "text", "gpt-5.6-terra", "medium", 0),
        ("thorough", "dossier_library", None, "structured", "gpt-5.6-terra", "high", 0),
        ("deep", "chat", "deep", "mcp_read", "gpt-5.6-sol", "high", 1),
    )
    return {
        "schema_version": "nexus-hosted-codex-canary.v3",
        "run_id": "0123456789abcdef",
        "source_sha": _SOURCE_SHA,
        "policy_revision": generation_policy.POLICY_REVISION,
        "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
        "policy_facts_fingerprint": generation_policy.POLICY_FACTS_FINGERPRINT,
        "provider_runtime_revision": generation_policy.PLAN_EVAL_PIN["provider_runtime_revision"],
        "codex_sdk_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
        "codex_cli_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
        "qualification_scope": "model_effort_runtime_wire",
        "qualified_plan_ids": ["routine", "standard", "thorough", "deep"],
        "subscription_turns": 4,
        "results": [
            {
                "plan_id": plan_id,
                "operation": operation,
                "profile": profile,
                "operation_revision": generation_policy.operation_revision(
                    operation, profile=profile
                ),
                "case_shape": case_shape,
                "model": model,
                "reasoning": reasoning,
                "backend": "codex",
                "transport": "sdk",
                "auth_profile": "codex-personal",
                "terminal_status": "succeeded",
                "structured_output_valid": case_shape == "structured",
                "session_ref_schema_version": "agent-session-ref.v1",
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
                "sdk_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                "runtime_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                "tool_events": tool_events,
                "elapsed_ms": 1,
                "permission_requests": 0,
            }
            for plan_id, operation, profile, case_shape, model, reasoning, tool_events in plans
        ],
    }


def test_hosted_canary_accepts_exact_four_plan_v3_receipt(tmp_path: Path) -> None:
    assert find_spec("nexus.services.generation_policy") is not None, (
        "fixed Codex generation policy owner is absent"
    )
    path = tmp_path / "hosted.json"
    evidence = _evidence()
    path.write_text(json.dumps(evidence), encoding="utf-8")
    assert codex_hosted_evidence_is_valid(path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA)
    results = evidence["results"]
    assert isinstance(results, list)
    results[3]["permission_requests"] = 1
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(evidence), encoding="utf-8")
    assert not codex_hosted_evidence_is_valid(
        path,
        run_id="0123456789abcdef",
        source_sha=_SOURCE_SHA,
    ), "permission-request evidence turned an unsafe semantic result green"

    for field, value in (
        ("source_sha", "b" * 40),
        ("policy_revision", "other-policy"),
        ("policy_fingerprint", "0" * 64),
        ("policy_facts_fingerprint", "0" * 64),
        ("provider_runtime_revision", "0" * 40),
        ("codex_sdk_version", "0.0.0"),
        ("codex_cli_version", "0.0.0"),
        ("qualification_scope", "all_operation_semantics"),
        ("qualified_plan_ids", ["routine", "standard", "thorough"]),
    ):
        evidence = _evidence()
        evidence[field] = value
        path.write_text(json.dumps(evidence), encoding="utf-8")
        assert not codex_hosted_evidence_is_valid(
            path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA
        ), f"hosted receipt accepted a drifted {field}"

    for field in ("sdk_version", "runtime_version"):
        evidence = _evidence()
        results = evidence["results"]
        assert isinstance(results, list)
        results[0][field] = "0.0.0"
        path.write_text(json.dumps(evidence), encoding="utf-8")
        assert not codex_hosted_evidence_is_valid(
            path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA
        ), f"hosted receipt accepted a per-result drifted {field}"
