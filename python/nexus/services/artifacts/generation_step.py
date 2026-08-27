"""Artifact-owned durable protocol for billed structured generation steps.

The universal Dossier engine has two provider transports: streaming synthesis
and unary document repair. This module owns only the semantics they genuinely
share: exact request identity, strict memoized results, and the lease-fenced
Prepared -> Uncertain -> Completed journal transitions. Transport, progress,
cancellation, and terminal publication remain explicit in ``engine``.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from typing import Final, Literal, cast
from uuid import UUID

from provider_runtime import (
    CallOutcome,
    Cancelled,
    Incomplete,
    Refused,
    StructuredContent,
    Succeeded,
)
from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy.orm import Session

from nexus.jobs.queue import get_job
from nexus.schemas.presence import Present, absent, present
from nexus.services import durable_step_journal
from nexus.services.artifacts.bindings.base import DossierBinding
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.dossier_types import DossierBuildFailureCode
from nexus.services.llm_execution import GenerationRequest
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import operation_profile
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)

SYNTHESIS_STEP_PATH: Final = "synthesis"
DOCUMENT_REPAIR_STEP_PATH: Final = "document-repair"
BILLED_GENERATION_STEP_PATHS: Final = frozenset({SYNTHESIS_STEP_PATH, DOCUMENT_REPAIR_STEP_PATH})
_VISIBLE_SYNTHESIS_FIELD: Final = "content_html"


class ArtifactGenerationAccepted(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Accepted"] = "Accepted"
    envelope_json: str


class ArtifactGenerationInvalid(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Invalid"] = "Invalid"
    rejected_output: str
    diagnostic: str


type ArtifactGenerationResult = ArtifactGenerationAccepted | ArtifactGenerationInvalid
_RESULT_ADAPTER: TypeAdapter[ArtifactGenerationResult] = TypeAdapter(
    ArtifactGenerationAccepted | ArtifactGenerationInvalid
)


@dataclass(frozen=True, slots=True)
class ArtifactGenerationFailure:
    code: DossierBuildFailureCode
    detail: str | None


@dataclass(frozen=True, slots=True)
class ArtifactGenerationCancelled:
    pass


@dataclass(frozen=True, slots=True)
class ArtifactGenerationDispatchRequired:
    pass


CANCELLED_GENERATION: Final = ArtifactGenerationCancelled()
DISPATCH_REQUIRED: Final = ArtifactGenerationDispatchRequired()


class ArtifactGenerationInputsChanged(Exception):
    """A prepared billed generation no longer has the same exact request."""


class ArtifactGenerationUncertain(RuntimeError):
    """A billed generation may have dispatched and requires operator repair."""


class ArtifactGenerationProviderDefect(Exception):
    """A provider terminal is not one of the Dossier's modeled failures."""


@dataclass(frozen=True, slots=True)
class ArtifactGenerationStep:
    """One exact billed generation position in an Artifact build."""

    path: str
    generation_id: UUID
    request_fingerprint: str
    request: GenerationRequest
    schema: type[BaseModel]

    def replay(
        self,
        runtime: DossierBuildRuntime,
    ) -> ArtifactGenerationDispatchRequired | ArtifactGenerationInvalid | BaseModel:
        """Classify the claimed job snapshot without crossing provider I/O."""

        state = runtime.read_step(self.path)
        if state is None:
            return DISPATCH_REQUIRED
        if state.generation_id != self.generation_id:
            raise AssertionError(f"{self.path} generation identity changed")
        if isinstance(state.tool_execution, Present):
            raise AssertionError(f"{self.path} billed generation contains tool metadata")
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != self.request_fingerprint
        ):
            raise ArtifactGenerationInputsChanged(self.path)
        if state.dispatch_phase is durable_step_journal.Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError(f"completed {self.path} step has no result")
            return decode_artifact_generation_result(
                _RESULT_ADAPTER.validate_json(state.terminal_result.value),
                schema=self.schema,
            )
        if state.dispatch_phase is durable_step_journal.Uncertain:
            raise ArtifactGenerationUncertain(
                f"build {runtime.build_id} {self.path} step is uncertain on replay"
            )
        if state.dispatch_phase is durable_step_journal.Prepared:
            return DISPATCH_REQUIRED
        raise AssertionError(f"unexpected {self.path} phase {state.dispatch_phase!r}")

    def ensure_prepared(self, db: Session, runtime: DossierBuildRuntime) -> bool:
        """Commit the initial Prepared record, or reuse its exact replay."""

        state = runtime.read_step(self.path)
        if state is not None:
            if state.dispatch_phase is not durable_step_journal.Prepared:
                raise AssertionError(f"cannot prepare {self.path} from {state.dispatch_phase}")
            return True
        if not runtime.checkpoint_step(
            db,
            path=self.path,
            state=durable_step_journal.StepReplayState(
                generation_id=self.generation_id,
                dispatch_phase=durable_step_journal.Prepared,
                request_fingerprint=present(self.request_fingerprint),
                terminal_result=absent(),
            ),
        ):
            db.rollback()
            return False
        db.commit()
        fresh_job = get_job(db, runtime.execution_context.job_id)
        if fresh_job is None:
            return False
        runtime.job = fresh_job
        return True

    def claim_dispatch(self, db: Session, runtime: DossierBuildRuntime) -> bool:
        """Commit Uncertain immediately before the provider boundary."""

        state = runtime.read_step(self.path)
        if state is None or state.dispatch_phase is not durable_step_journal.Prepared:
            raise AssertionError(f"{self.path} dispatch requires a Prepared step")
        if not runtime.checkpoint_step(
            db,
            path=self.path,
            state=state.model_copy(update={"dispatch_phase": durable_step_journal.Uncertain}),
        ):
            db.rollback()
            return False
        db.commit()
        return True

    def complete(
        self,
        db: Session,
        runtime: DossierBuildRuntime,
        result: ArtifactGenerationResult,
    ) -> bool:
        """Lease-fence one strict terminal result into the current job payload."""

        runtime.job = get_job(db, runtime.execution_context.job_id) or runtime.job
        state = runtime.read_step(self.path)
        if state is None or state.dispatch_phase is not durable_step_journal.Uncertain:
            raise AssertionError(f"{self.path} completion requires an Uncertain step")
        if not runtime.checkpoint_step(
            db,
            path=self.path,
            state=state.model_copy(
                update={
                    "dispatch_phase": durable_step_journal.Completed,
                    "terminal_result": present(result.model_dump_json()),
                }
            ),
        ):
            db.rollback()
            return False
        db.commit()
        return True


def build_artifact_generation_step(
    *,
    path: str,
    build_id: UUID,
    requester: UUID,
    binding: DossierBinding,
    system_prompt: str,
    user_content: str,
) -> ArtifactGenerationStep:
    """Build the exact provider request and byte-stable stored identity."""

    if path not in BILLED_GENERATION_STEP_PATHS:
        raise ValueError(f"unknown Artifact billed generation path {path!r}")
    profile = operation_profile(binding.llm_operation)
    intent = replace(
        build_synthesis_intent(
            profile=profile,
            system_prompt=system_prompt,
            user_content=user_content,
            max_output_tokens=binding.max_output_tokens,
            schema=binding.schema,
        ),
        reasoning=binding.reasoning,
    )
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "operation": str(binding.llm_operation),
                "provider": str(profile.target.provider),
                "model": str(profile.target.model),
                "system_prompt": system_prompt,
                "user_content": user_content,
                "max_output_tokens": binding.max_output_tokens,
                "reasoning": str(binding.reasoning),
                "schema": binding.schema.model_json_schema(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    generation_id = durable_step_journal.stable_generation_id(build_id, path)
    return ArtifactGenerationStep(
        path=path,
        generation_id=generation_id,
        request_fingerprint=fingerprint,
        request=GenerationRequest(
            generation_id=generation_id,
            owner=LlmCallOwner(kind="artifact_build", id=build_id, user_id=requester),
            operation=binding.llm_operation,
            profile=profile,
            reasoning=binding.reasoning,
            intent=intent,
        ),
        schema=binding.schema,
    )


def classify_artifact_generation_outcome(
    outcome: CallOutcome,
    *,
    schema: type[BaseModel],
    path: str,
) -> ArtifactGenerationResult | ArtifactGenerationFailure | ArtifactGenerationCancelled:
    """Normalize the closed Dossier provider terminal contract once."""

    if isinstance(outcome, Cancelled):
        return CANCELLED_GENERATION
    if isinstance(outcome, Succeeded):
        try:
            decoded = decode_structured_synthesis(outcome, schema=schema)
            if not isinstance(getattr(decoded, _VISIBLE_SYNTHESIS_FIELD, None), str):
                raise StructuredSynthesisError(
                    f"dossier schema has no string {_VISIBLE_SYNTHESIS_FIELD!r} field"
                )
        except StructuredSynthesisError as exc:
            raw_content = outcome.response.content
            return ArtifactGenerationInvalid(
                rejected_output=(
                    json.dumps(
                        raw_content.payload,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    if isinstance(raw_content, StructuredContent)
                    else ""
                ),
                diagnostic=str(exc),
            )
        return ArtifactGenerationAccepted(envelope_json=decoded.model_dump_json())
    if isinstance(outcome, (Incomplete, Refused)):
        code = (
            DossierBuildFailureCode.ProviderRefused
            if isinstance(outcome, Refused) or outcome.status == "refused"
            else DossierBuildFailureCode.ProviderIncomplete
        )
        _, detail = outcome_failure_facts(outcome)
        return ArtifactGenerationFailure(code=code, detail=detail)

    failure_code, detail = outcome_failure_facts(outcome)
    if failure_code == "invalid_structured_output":
        fallback = (
            "provider returned an invalid repaired envelope"
            if path == DOCUMENT_REPAIR_STEP_PATH
            else "provider returned an invalid structured envelope"
        )
        return ArtifactGenerationInvalid(
            rejected_output="",
            diagnostic=detail or fallback,
        )
    if failure_code == "context_too_large":
        return ArtifactGenerationFailure(
            code=DossierBuildFailureCode.ContextTooLarge,
            detail=detail,
        )
    raise ArtifactGenerationProviderDefect(
        f"non-modeled {path} outcome {type(outcome).__name__}:{failure_code}"
    )


def decode_artifact_generation_result(
    result: ArtifactGenerationResult,
    *,
    schema: type[BaseModel],
) -> ArtifactGenerationInvalid | BaseModel:
    """Return an invalid diagnostic or the schema-validated accepted envelope."""

    if isinstance(result, ArtifactGenerationInvalid):
        return result
    return schema.model_validate_json(result.envelope_json)


def encode_reconciled_artifact_generation_result(
    raw_result: str,
    *,
    schema: type[BaseModel],
) -> str:
    """Normalize an operator-attached result into the canonical stored envelope."""

    normalized = schema.model_validate_json(raw_result)
    return ArtifactGenerationAccepted(
        envelope_json=cast(BaseModel, normalized).model_dump_json()
    ).model_dump_json()
