"""Independently declared immutable provider generation ledger fixture."""

from __future__ import annotations

import hashlib
import json

from nexus.services.generation_spec import GenerationSpec


def generation_spec_fixture() -> dict[str, object]:
    output_contract = {"kind": "Text"}
    document: dict[str, object] = {
        "schema_version": "nexus-generation-spec.v1",
        "operation": "metadata_enrichment",
        "selection": {
            "route": "ProviderApi",
            "model_ref": "openai:gpt-5.6-luna",
            "reasoning": "low",
        },
        "selection_source": "BackgroundPolicy",
        "resolved_dispatch_target": {
            "kind": "ProviderApi",
            "model_ref": "openai:gpt-5.6-luna",
            "provider": "openai",
            "model_id": "gpt-5.6-luna",
            "engine": "responses",
            "base_url": {"kind": "Absent"},
            "correlation": "header",
            "routing": {"kind": "Absent"},
            "continuation_codec": "openai.responses.v1",
            "registry_revision": "registry.1",
        },
        "source_catalog_definition_revision": "provider-catalog.1",
        "source_row_fingerprint": "1" * 64,
        "agent_definition_revision": {"kind": "Absent"},
        "source_context_window": {"kind": "Present", "value": 128_000},
        "source_max_output_tokens": {"kind": "Present", "value": 16_384},
        "effective_context_budget_tokens": 32_000,
        "effective_output_budget_tokens": 4_096,
        "bounds": {
            "instructions_max_bytes": 65_536,
            "input_max_bytes": 1_048_576,
            "turn_timeout_seconds": 180,
            "session_open_timeout_seconds": 30,
            "runtime_close_timeout_seconds": 10,
            "transport_margin_seconds": 5,
            "transport_deadline_seconds": 185,
            "stream": {
                "max_frames": 10_000,
                "max_frame_bytes": 1_048_576,
                "max_stream_bytes": 16_777_216,
                "text_flush_interval_ms": {"kind": "Absent"},
                "text_flush_bytes": {"kind": "Absent"},
            },
        },
        "prompt_template_revision": "metadata.prompt.1",
        "prompt_payload_ref": {
            "kind": "DomainPromptPayload",
            "owner_kind": "media_enrichment",
            "owner_id": "proof-owner",
            "revision": "metadata.prompt.1",
            "payload_digest": "2" * 64,
        },
        "instructions_digest": "3" * 64,
        "input_digest": "4" * 64,
        "output_contract": output_contract,
        "output_contract_fingerprint": hashlib.sha256(
            json.dumps(
                output_contract,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
        "display_at_dispatch": {
            "route_label": "OpenAI API",
            "model_label": "GPT-5.6 Luna",
            "reasoning_label": "Low",
            "billing": {"kind": "MeteredApi", "label": "Metered API"},
            "privacy": {
                "summary": "OpenAI API processes this generation.",
                "retention": "Configured API retention applies.",
                "training": "Configured API training policy applies.",
            },
            "processor_chain": {"processors": ("Nexus", "OpenAI API")},
        },
        "host_tool_plan_snapshot": {"kind": "Absent"},
        "host_evidence_revision": {"kind": "Absent"},
        "model_tool_plan_snapshot": {"kind": "Absent"},
        "tool_effect_mode": {"kind": "Absent"},
        "admitted_tool_scope": {"kind": "Absent"},
        "admitted_tool_scope_digest": {"kind": "Absent"},
        "catalog_definition_revision": "8" * 64,
        "policy_revision": "generation-policy.1",
        "backend_contract_revision": "provider-runtime.1",
        "provider_registry_revision": {"kind": "Present", "value": "registry.1"},
    }
    document["fingerprint"] = hashlib.sha256(
        json.dumps(
            document,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return GenerationSpec.model_validate(document).model_dump(mode="json", by_alias=True)
