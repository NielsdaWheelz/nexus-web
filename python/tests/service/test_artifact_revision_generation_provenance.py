"""Frozen generation-ledger provenance on public Artifact revision reads."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from importlib.util import find_spec
from uuid import uuid4

from sqlalchemy import Engine


def test_revision_reads_project_retired_frozen_generation_identity_without_mutation(
    engine: Engine,
) -> None:
    """Risk: revision history reconstructs provenance from mutable policy or rewrites it."""

    assert find_spec("nexus.services.generation_spec") is not None, (
        "frozen route-neutral generation specs are absent"
    )

    from sqlalchemy.orm import Session

    from nexus.db.models import (
        ArtifactBuild,
        ArtifactRevision,
        LLMCall,
        LLMModelTurn,
        SynthesisArtifact,
    )
    from nexus.schemas.presence import absent, present
    from nexus.services import note_bodies
    from nexus.services.artifacts import revisions
    from nexus.services.bootstrap import ensure_user_and_default_library
    from nexus.services.llm_ledger import (
        GenerationStart,
        LlmCallOwner,
        ModelTurnCompletion,
        ModelTurnStart,
        arm_model_turn_dispatch_in_current_transaction,
        complete_generation_in_current_transaction,
        complete_model_turn_in_current_transaction,
        generation_spec_document,
        start_generation_in_current_transaction,
        start_model_turn_in_current_transaction,
    )
    from tests.testkit.codex_generation import codex_generation_draft

    frozen_model = "retired-codex-model-from-ledger"
    frozen_total_tokens = 731
    user_id = uuid4()
    note_id = uuid4()
    generation_id = uuid4()
    model_turn_id = uuid4()

    with Session(engine, expire_on_commit=False) as db:
        ensure_user_and_default_library(
            db,
            user_id,
            f"artifact-provenance-{user_id}@example.invalid",
        )
        note_bodies.upsert_note_body(
            db,
            viewer_id=user_id,
            block_id=note_id,
            body_pm_json=note_bodies.pm_doc_from_text("Frozen provenance source."),
        )
        artifact = SynthesisArtifact(
            subject_scheme="note_block",
            subject_id=note_id,
            audience_scheme="user",
            audience_id=str(user_id),
        )
        db.add(artifact)
        db.flush()
        build = ArtifactBuild(
            artifact_id=artifact.id,
            requester_user_id=user_id,
            instruction="Use the admitted historical target.",
            idempotency_key=f"artifact-provenance-{uuid4()}",
        )
        db.add(build)
        db.flush()
        revision = ArtifactRevision(
            build_id=build.id,
            content_html="<p>Frozen provenance output.</p>",
            content_text="Frozen provenance output.",
            input_manifest={},
            citation_owner_user_id=user_id,
            creator_user_id=user_id,
        )
        db.add(revision)
        db.flush()
        artifact.current_revision_id = revision.id

        # A retired target is a normal historical state. Public reads must use
        # the immutable generation document, never today's policy or catalog.
        draft = codex_generation_draft(
            request_id=generation_id,
            operation="dossier_note",
            instructions="Return one bounded Artifact revision.",
            input_text="Frozen provenance evidence.",
            model=frozen_model,
            reasoning="high",
            turn_timeout_seconds=120,
            structured_schema={
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
                "additionalProperties": False,
            },
        )
        frozen_spec = generation_spec_document(draft.spec)
        owner = LlmCallOwner(kind="artifact_build", id=build.id)
        start_generation_in_current_transaction(
            db,
            GenerationStart(
                generation_id=generation_id,
                owner=owner,
                spec=frozen_spec,
            ),
        )
        start_model_turn_in_current_transaction(
            db,
            ModelTurnStart(
                model_turn_id=model_turn_id,
                generation_id=generation_id,
                turn_seq=1,
                request_fingerprint="4" * 64,
                route_request_identity={
                    "kind": "CodexPersonal",
                    "request_id": str(generation_id),
                    "generation_spec_fingerprint": frozen_spec.fingerprint,
                    "model_key": frozen_model,
                    "reasoning": "high",
                },
            ),
        )
        arm_model_turn_dispatch_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=model_turn_id,
        )
        complete_model_turn_in_current_transaction(
            db,
            generation_id=generation_id,
            model_turn_id=model_turn_id,
            completion=ModelTurnCompletion(
                terminal={"kind": "Succeeded", "native": {"finish_reason": "stop"}},
                usage=present(
                    {
                        "input_tokens": 600,
                        "output_tokens": 131,
                        "total_tokens": frozen_total_tokens,
                    }
                ),
                billability=present({"kind": "Subscription"}),
                accepted_at=present(datetime(2026, 8, 31, 20, 0, tzinfo=UTC)),
                successor=absent(),
            ),
        )
        complete_generation_in_current_transaction(
            db,
            owner=owner,
            generation_id=generation_id,
            terminal={"kind": "Succeeded", "final_model_turn_seq": 1},
        )
        db.commit()

        generation_row = db.get(LLMCall, generation_id)
        model_turn_row = db.get(LLMModelTurn, model_turn_id)
        assert generation_row is not None and model_turn_row is not None
        spec_before = deepcopy(generation_row.generation_spec)
        turn_identity_before = deepcopy(model_turn_row.route_request_identity)
        turn_usage_before = deepcopy(model_turn_row.usage)

        summaries = revisions.list_revisions(
            db,
            viewer_id=user_id,
            artifact_id=artifact.id,
        )
        view = revisions.get_revision(
            db,
            viewer_id=user_id,
            revision_id=revision.id,
        )

        assert len(summaries) == 1
        for projected in (summaries[0], view):
            assert projected.model_provider == "codex-personal"
            assert projected.model_name == frozen_model
            assert projected.total_tokens == frozen_total_tokens

        db.expire_all()
        generation_after = db.get(LLMCall, generation_id)
        model_turn_after = db.get(LLMModelTurn, model_turn_id)
        assert generation_after is not None and model_turn_after is not None
        assert generation_after.generation_spec == spec_before
        assert generation_after.generation_fingerprint == frozen_spec.fingerprint
        assert model_turn_after.route_request_identity == turn_identity_before
        assert model_turn_after.usage == turn_usage_before
