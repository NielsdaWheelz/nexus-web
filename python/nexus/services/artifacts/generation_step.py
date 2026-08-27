"""Artifact-owned adapter for the two durable Dossier generation positions.

The engine owns Dossier lifecycle, streaming cancellation, and publication.
This module owns the exact synthesis/document-repair command, strict memoized
result, and the one composition of the shared Codex execution journal for both
positions. Model, effort, capability, bounds, and capacity policy come only from
``generation_policy`` through :class:`GenerationCommand` validation.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Literal, assert_never, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow, get_job
from nexus.schemas.presence import Present, absent, present
from nexus.services import durable_step_journal, generation_policy
from nexus.services.artifacts.bindings._shared import CitationValidationError
from nexus.services.artifacts.bindings.base import DossierBinding
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.definition import DOSSIER_DEFINITION
from nexus.services.artifacts.document_html import DocumentHtmlError
from nexus.services.artifacts.dossier_types import DossierBuildFailureCode
from nexus.services.codex_generation_contract import (
    GenerationCommand,
    GenerationTerminal,
    NormalizedFailureCode,
    request_fingerprint,
)
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    EncodedGenerationTerminal,
    GenerationExecutionRequest,
    JobGenerationJournal,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)

SYNTHESIS_STEP_PATH: Final = "synthesis"
DOCUMENT_REPAIR_STEP_PATH: Final = "document-repair"
GENERATION_STEP_PATHS: Final = frozenset({SYNTHESIS_STEP_PATH, DOCUMENT_REPAIR_STEP_PATH})
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


class ArtifactGenerationFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Failure"] = "Failure"
    code: DossierBuildFailureCode
    detail: str | None = None


class ArtifactGenerationCancelled(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Cancelled"] = "Cancelled"


type ArtifactGenerationResult = (
    ArtifactGenerationAccepted
    | ArtifactGenerationInvalid
    | ArtifactGenerationFailure
    | ArtifactGenerationCancelled
)
_RESULT_ADAPTER: TypeAdapter[ArtifactGenerationResult] = TypeAdapter(ArtifactGenerationResult)


@dataclass(frozen=True, slots=True)
class ArtifactGenerationDispatchRequired:
    pass


DISPATCH_REQUIRED: Final = ArtifactGenerationDispatchRequired()


class ArtifactGenerationInputsChanged(Exception):
    """A prepared generation no longer has the same exact request."""


class ArtifactGenerationUncertain(RuntimeError):
    """A generation may have dispatched and requires operator repair."""


type LockArtifactDispatch = Callable[[Session], JobRow | None]


@dataclass(frozen=True, slots=True)
class ArtifactGenerationStep:
    """One exact tool-free Codex generation position in an Artifact build."""

    path: str
    generation_id: UUID
    fingerprint: str
    command: GenerationCommand
    owner: LlmCallOwner
    binding: DossierBinding
    collected: object
    witness: object

    def replay(
        self,
        runtime: DossierBuildRuntime,
    ) -> ArtifactGenerationDispatchRequired | ArtifactGenerationResult | BaseModel:
        """Classify the claimed job snapshot without crossing host I/O."""

        state = runtime.read_step(self.path)
        if state is None:
            return DISPATCH_REQUIRED
        self._assert_state_identity(state)
        if state.dispatch_phase is durable_step_journal.Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError(f"completed {self.path} step has no result")
            return self.decode_result(state.terminal_result.value)
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
            self._assert_state_identity(state)
            if state.dispatch_phase is not durable_step_journal.Prepared:
                raise AssertionError(f"cannot prepare {self.path} from {state.dispatch_phase}")
            return True
        if not runtime.checkpoint_step(
            db,
            path=self.path,
            state=durable_step_journal.StepReplayState(
                generation_id=self.generation_id,
                dispatch_phase=durable_step_journal.Prepared,
                request_fingerprint=present(self.fingerprint),
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

    def execution_request(
        self,
        runtime: DossierBuildRuntime,
        *,
        lock_dispatch: LockArtifactDispatch,
        streaming: bool,
    ) -> GenerationExecutionRequest:
        """Compose this owner onto the one shared durable Codex boundary."""

        capacity_wait_index = runtime.job.payload.get("capacity_wait_index")
        if type(capacity_wait_index) is not int or capacity_wait_index < 0:
            raise AssertionError("dossier job has an invalid capacity_wait_index")
        return GenerationExecutionRequest(
            owner=self.owner,
            command=self.command,
            journal=JobGenerationJournal(
                context=runtime.execution_context,
                step_path=self.path,
                capacity_wait_index=capacity_wait_index,
                lock_dispatch=lock_dispatch,
            ),
            capacity_wait_index=capacity_wait_index,
            streaming=streaming,
        )

    def encode_terminal(self, terminal: GenerationTerminal) -> EncodedGenerationTerminal:
        """Narrow one strict host terminal to the Dossier's durable result union."""

        accepted_failure: AcceptedGenerationFailure | None = None
        if terminal.status == "succeeded":
            try:
                decoded = decode_structured_synthesis(terminal, schema=self.binding.schema)
                if not isinstance(getattr(decoded, _VISIBLE_SYNTHESIS_FIELD, None), str):
                    raise StructuredSynthesisError(
                        f"dossier schema has no string {_VISIBLE_SYNTHESIS_FIELD!r} field"
                    )
                materialized = self.binding.materialize(
                    self.collected,
                    decoded,
                    self.witness,
                )
                if len(materialized.citations) < DOSSIER_DEFINITION.min_materialized_citations:
                    raise CitationValidationError("dossier output cited no offered evidence")
            except CitationValidationError as error:
                diagnostic = str(error)
                result: ArtifactGenerationResult = ArtifactGenerationFailure(
                    code=DossierBuildFailureCode.CitationValidationFailed,
                    detail=diagnostic,
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output",
                    detail=diagnostic,
                )
            except (DocumentHtmlError, StructuredSynthesisError) as error:
                diagnostic = str(error)
                result: ArtifactGenerationResult = ArtifactGenerationInvalid(
                    rejected_output=(
                        json.dumps(
                            terminal.structured_output,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        if terminal.structured_output is not None
                        else ""
                    ),
                    diagnostic=diagnostic,
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output",
                    detail=diagnostic,
                )
            else:
                result = ArtifactGenerationAccepted(envelope_json=decoded.model_dump_json())
        elif terminal.status == "cancelled":
            result = ArtifactGenerationCancelled()
        else:
            code, detail = outcome_failure_facts(terminal)
            normalized = cast(NormalizedFailureCode, code)
            if normalized == "invalid_output":
                result = ArtifactGenerationInvalid(
                    rejected_output="",
                    diagnostic=detail or "host returned an invalid structured envelope",
                )
            else:
                result = ArtifactGenerationFailure(
                    code=_dossier_failure_code(normalized),
                    detail=detail,
                )
        return EncodedGenerationTerminal(
            terminal_result=result.model_dump_json(),
            accepted_failure=accepted_failure,
        )

    def encode_preaccept_failure(self, code: NormalizedFailureCode, detail: str) -> str:
        """Encode one app-owned failure proven to precede host acceptance."""

        return ArtifactGenerationFailure(
            code=_dossier_failure_code(code),
            detail=detail,
        ).model_dump_json()

    def decode_result(self, raw_result: str) -> ArtifactGenerationResult | BaseModel:
        result = _RESULT_ADAPTER.validate_json(raw_result)
        if isinstance(result, ArtifactGenerationAccepted):
            return self.binding.schema.model_validate_json(result.envelope_json)
        return result

    def _assert_state_identity(self, state: durable_step_journal.StepReplayState) -> None:
        if state.generation_id != self.generation_id:
            raise AssertionError(f"{self.path} generation identity changed")
        if isinstance(state.tool_execution, Present):
            raise AssertionError(f"{self.path} generation contains tool metadata")
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != self.fingerprint
        ):
            raise ArtifactGenerationInputsChanged(self.path)


def build_artifact_generation_step(
    *,
    path: str,
    build_id: UUID,
    binding: DossierBinding,
    collected: object,
    witness: object,
    system_prompt: str,
    user_content: str,
) -> ArtifactGenerationStep:
    """Build the exact app-owned command and its byte-stable durable identity."""

    if path not in GENERATION_STEP_PATHS:
        raise ValueError(f"unknown Artifact generation path {path!r}")
    generation_id = durable_step_journal.stable_generation_id(build_id, path)
    command = GenerationCommand.model_validate(
        {
            "request_id": generation_id,
            "operation": {
                "kind": binding.llm_operation,
                "revision": generation_policy.operation_revision(binding.llm_operation),
            },
            "policy_revision": generation_policy.POLICY_REVISION,
            "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
            "intent": build_synthesis_intent(
                system_prompt=system_prompt,
                user_content=user_content,
                schema=binding.schema,
            ),
        }
    )
    fingerprint = request_fingerprint(command)
    return ArtifactGenerationStep(
        path=path,
        generation_id=generation_id,
        fingerprint=fingerprint,
        command=command,
        owner=LlmCallOwner(kind="artifact_build", id=build_id),
        binding=binding,
        collected=collected,
        witness=witness,
    )


def _dossier_failure_code(code: NormalizedFailureCode) -> DossierBuildFailureCode:
    match code:
        case "auth":
            return DossierBuildFailureCode.Auth
        case "quota":
            return DossierBuildFailureCode.Quota
        case "timeout":
            return DossierBuildFailureCode.Timeout
        case "output_limit":
            return DossierBuildFailureCode.OutputLimit
        case "invalid_output":
            return DossierBuildFailureCode.InvalidOutput
        case "policy_violation":
            return DossierBuildFailureCode.PolicyViolation
        case "runtime_unavailable":
            return DossierBuildFailureCode.RuntimeUnavailable
        case "capacity_unavailable":
            return DossierBuildFailureCode.CapacityUnavailable
        case "context_too_large":
            return DossierBuildFailureCode.ContextTooLarge
        case "defect":
            raise AssertionError("a generation contract defect cannot become a dossier failure")
        case unreachable:
            assert_never(unreachable)
