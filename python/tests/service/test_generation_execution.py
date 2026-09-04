"""Canonical PostgreSQL proof for parent/child generation replay."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from importlib.util import find_spec
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_continuations") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from nexus.db.models import LLMModelTurn, LLMModelTurnContinuation
    from nexus.schemas.presence import absent, present
    from nexus.services.generation_continuations import (
        GenerationContinuationAuthenticationError,
        GenerationContinuationCipher,
        GenerationContinuationContext,
    )
    from nexus.services.generation_spec import GenerationSpec
    from nexus.services.llm_ledger import (
        DispatchableModelTurn,
        GenerationStart,
        LlmCallOwner,
        ModelTurnCompletion,
        ModelTurnStart,
        PendingGenerationContinuation,
        RedispatchForbiddenModelTurn,
        arm_model_turn_dispatch_in_current_transaction,
        arm_resumed_model_turn_dispatch_in_current_transaction,
        complete_generation_in_current_transaction,
        complete_model_turn_in_current_transaction,
        generation_spec_document,
        open_generation_continuation_in_current_transaction,
        read_generation,
        read_model_turns,
        read_pending_generation_continuation_in_current_transaction,
        resume_generation_continuation_in_current_transaction,
        start_generation_in_current_transaction,
        start_model_turn_in_current_transaction,
    )


def _generation_spec() -> dict[str, object]:
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


def test_parent_child_tool_replay_is_exactly_once(request: pytest.FixtureRequest) -> None:
    """Risk: crash replay duplicates a billable child or successor dispatch."""

    assert _CUTOVER_PRESENT, "sealed generation continuation ownership is absent"
    request.getfixturevalue("committed_chat_state_isolation")
    engine = cast(Engine, request.getfixturevalue("engine"))
    generation_id = uuid4()
    first_turn_id = uuid4()
    second_turn_id = uuid4()
    owner = LlmCallOwner(kind="media_enrichment", id=uuid4())
    spec = generation_spec_document(_generation_spec())
    cipher = GenerationContinuationCipher(b"k" * 32)
    context = GenerationContinuationContext(
        generation_id=generation_id,
        source_turn_seq=1,
        successor_turn_seq=2,
        target_fingerprint="1" * 64,
        codec_id="openai.responses.v1",
        policy_revision="generation-policy.1",
    )
    canonical_continuation = b'{"response_id":"provider-successor"}'
    sealed = cipher.seal(
        canonical_continuation=canonical_continuation,
        context=context,
    )
    first = ModelTurnStart(
        model_turn_id=first_turn_id,
        generation_id=generation_id,
        turn_seq=1,
        request_fingerprint="6" * 64,
        route_request_identity={"kind": "ProviderApi", "request_key": "first"},
    )
    second = ModelTurnStart(
        model_turn_id=second_turn_id,
        generation_id=generation_id,
        turn_seq=2,
        request_fingerprint="7" * 64,
        route_request_identity={"kind": "ProviderApi", "request_key": "second"},
    )
    first_completion = ModelTurnCompletion(
        terminal={"kind": "Succeeded", "native": {"finish_reason": "tool_calls"}},
        usage=present({"input_tokens": 100, "output_tokens": 10}),
        billability=present({"kind": "Billable"}),
        accepted_at=present(datetime(2026, 8, 31, 20, 0, tzinfo=UTC)),
        successor=present(sealed),
    )
    with pytest.raises(ValueError, match="timezone-aware"):
        ModelTurnCompletion(
            terminal={"kind": "Failed"},
            usage=absent(),
            billability=absent(),
            accepted_at=present(datetime(2026, 8, 31, 20, 0)),
            successor=absent(),
        )

    with Session(engine) as db:
        start_generation_in_current_transaction(
            db,
            GenerationStart(generation_id=generation_id, owner=owner, spec=spec),
        )
        assert (
            start_generation_in_current_transaction(
                db,
                GenerationStart(generation_id=generation_id, owner=owner, spec=spec),
            )
            == generation_id
        )
        start_model_turn_in_current_transaction(db, first)
        arm_model_turn_dispatch_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
        )
        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
            completion=first_completion,
        )

        with pytest.raises(AssertionError, match="sealed successor continuation"):
            complete_generation_in_current_transaction(
                db,
                owner=owner,
                generation_id=generation_id,
                terminal={"kind": "Succeeded", "final_model_turn_seq": 1},
            )

        wrong_context = GenerationContinuationContext(
            generation_id=generation_id,
            source_turn_seq=1,
            successor_turn_seq=2,
            target_fingerprint="1" * 64,
            codec_id="openai.responses.v1",
            policy_revision="different-policy",
        )
        with pytest.raises(
            GenerationContinuationAuthenticationError,
            match="context authentication failed",
        ):
            resume_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                successor=second,
                expected_context=wrong_context,
                cipher=cipher,
            )
        assert [turn.turn_seq for turn in read_model_turns(db, generation_id=generation_id)] == [1]
        with pytest.raises(ValueError, match="successors require sealed continuation resume"):
            start_model_turn_in_current_transaction(db, second)

        pending = read_pending_generation_continuation_in_current_transaction(
            db,
            generation_id=generation_id,
            cipher=cipher,
        )
        assert isinstance(pending, PendingGenerationContinuation)
        assert pending.source_turn.id == first_turn_id
        assert pending.context == context
        assert pending.canonical_continuation == canonical_continuation

        assert (
            open_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                expected_context=context,
                cipher=cipher,
            )
            == canonical_continuation
        )
        first_resume = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        replayed_resume = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(first_resume, DispatchableModelTurn)
        assert isinstance(replayed_resume, DispatchableModelTurn)
        assert first_resume.turn.id == replayed_resume.turn.id == second_turn_id
        assert first_resume.canonical_continuation == canonical_continuation
        assert canonical_continuation.decode() not in repr(first_resume)
        assert [turn.turn_seq for turn in read_model_turns(db, generation_id=generation_id)] == [
            1,
            2,
        ]

        with pytest.raises(AssertionError, match="different child facts"):
            resume_generation_continuation_in_current_transaction(
                db,
                source_model_turn_id=first_turn_id,
                successor=ModelTurnStart(
                    model_turn_id=uuid4(),
                    generation_id=generation_id,
                    turn_seq=2,
                    request_fingerprint="7" * 64,
                    route_request_identity={
                        "kind": "ProviderApi",
                        "request_key": "second",
                    },
                ),
                expected_context=context,
                cipher=cipher,
            )

        armed_second = arm_resumed_model_turn_dispatch_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert armed_second.id == second_turn_id
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurnContinuation)
                .where(LLMModelTurnContinuation.generation_id == generation_id)
            )
            == 0
        )
        forbidden = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(forbidden, RedispatchForbiddenModelTurn)

        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=second_turn_id,
            completion=ModelTurnCompletion(
                terminal={"kind": "Succeeded", "native": {"finish_reason": "stop"}},
                usage=present({"input_tokens": 40, "output_tokens": 20}),
                billability=present({"kind": "Billable"}),
                accepted_at=present(datetime(2026, 8, 31, 20, 1, tzinfo=UTC)),
                successor=absent(),
            ),
        )
        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=first_turn_id,
            completion=first_completion,
        )
        with pytest.raises(AssertionError, match="omitted its consumed successor"):
            complete_model_turn_in_current_transaction(
                db,
                generation_id=generation_id,
                model_turn_id=first_turn_id,
                completion=ModelTurnCompletion(
                    terminal=first_completion.terminal,
                    usage=first_completion.usage,
                    billability=first_completion.billability,
                    accepted_at=first_completion.accepted_at,
                    successor=absent(),
                ),
            )
        consumed = resume_generation_continuation_in_current_transaction(
            db,
            source_model_turn_id=first_turn_id,
            successor=second,
            expected_context=context,
            cipher=cipher,
        )
        assert isinstance(consumed, RedispatchForbiddenModelTurn)

        complete_generation_in_current_transaction(
            db,
            owner=owner,
            generation_id=generation_id,
            terminal={"kind": "Succeeded", "final_model_turn_seq": 2},
        )
        generation = read_generation(db, generation_id=generation_id)
        assert generation is not None
        assert generation.outcome == "Succeeded"
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurn)
                .where(LLMModelTurn.generation_id == generation_id)
            )
            == 2
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(LLMModelTurnContinuation)
                .where(LLMModelTurnContinuation.generation_id == generation_id)
            )
            == 0
        )
