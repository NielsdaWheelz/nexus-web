"""Artifact-owned adapter for durable Dossier model generations.

The domain owns prompt bytes, input validation, and the final materialized
document. Shared admission owns selection/policy/tool snapshots; shared
execution owns model children and replay. Tool-bearing Dossiers reconstruct
citation candidates only from completed durable tool receipts.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Final, Literal, assert_never, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow
from nexus.schemas.presence import Present
from nexus.services import durable_step_journal
from nexus.services.agent_tools_mcp import (
    CodexGenerationToolBinding,
    compose_codex_generation_tool_binding,
)
from nexus.services.artifacts.bindings._shared import (
    Candidate,
    CitationValidationError,
    materialize_standard,
)
from nexus.services.artifacts.bindings.base import DossierBinding, PublishableDossier
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.definition import DOSSIER_DEFINITION
from nexus.services.artifacts.document_html import DocumentHtmlError
from nexus.services.artifacts.dossier_types import DossierBuildFailureCode
from nexus.services.artifacts.manifests import IdeaInputManifestV1, LibraryInputManifestV1
from nexus.services.artifacts.model_tools import (
    DossierToolExecutionProjection,
    dossier_candidates_from_ledger,
)
from nexus.services.codex_generation_contract import NormalizedFailureCode
from nexus.services.generation_admission import FrozenHostEvidence
from nexus.services.generation_backend import BackendToolExecutor, CodexAdmissionBinder
from nexus.services.generation_events import BackendTerminal
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationSpec,
    ImmutablePromptPayloadRef,
    JsonValue,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_execution import (
    AcceptedGenerationFailure,
    EncodedGenerationTerminal,
    GenerationExecutionRequest,
    JobGenerationJournal,
    admit_job_generation,
    codex_terminal_evidence,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.resource_graph.schemas import (
    CitationInput,
    snapshot_from_jsonb,
    snapshot_to_jsonb,
)
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)
from nexus.services.tool_authority import compose_deferred_generation_tool_executor
from nexus.services.tool_runtime.composition import freeze_tool_plan_snapshot

SYNTHESIS_STEP_PATH: Final = "synthesis"
DOCUMENT_REPAIR_STEP_PATH: Final = "document-repair"
GENERATION_STEP_PATHS: Final = frozenset({SYNTHESIS_STEP_PATH, DOCUMENT_REPAIR_STEP_PATH})
_VISIBLE_SYNTHESIS_FIELD: Final = "content_html"
_MODEL_TOOL_OPERATIONS: Final = frozenset({"dossier_library", "dossier_idea"})


class ArtifactCitation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    target_uri: str
    ordinal: int
    kind: Literal["context", "supports", "contradicts"]
    snapshot: dict[str, object]


class ArtifactGenerationAccepted(BaseModel):
    """A fully validated document, safe to replay without mutable evidence."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    kind: Literal["Accepted"] = "Accepted"
    content_html: str
    content_text: str
    citations: tuple[ArtifactCitation, ...]


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
    """A prepared generation no longer has the same exact prompt."""


class ArtifactGenerationUncertain(RuntimeError):
    """A generation may have dispatched and requires operator repair."""


type LockArtifactDispatch = Callable[[Session], JobRow | None]


@dataclass(slots=True)
class ArtifactGenerationAdmission:
    request: GenerationExecutionRequest
    codex_tools: CodexGenerationToolBinding | None = None

    @property
    def before_terminal(self) -> Callable[[], Awaitable[None]] | None:
        return None if self.codex_tools is None else self.codex_tools.wait_until_idle

    async def close(self) -> None:
        if self.codex_tools is not None:
            await self.codex_tools.drain_and_close()


@dataclass(frozen=True, slots=True)
class ArtifactGenerationStep:
    """One exact Dossier generation position and its immutable domain prompt."""

    path: str
    generation_id: UUID
    operation: BackgroundOperationKey
    intent: GenerationIntent
    prompt_template_revision: str
    prompt_payload_ref: ImmutablePromptPayloadRef
    owner: LlmCallOwner
    binding: DossierBinding
    collected: object
    witness: object

    def replay(
        self,
        runtime: DossierBuildRuntime,
    ) -> ArtifactGenerationDispatchRequired | ArtifactGenerationResult | PublishableDossier:
        state = runtime.read_step(self.path)
        if state is None:
            if self._raw_admission(runtime) is not None:
                raise AssertionError("Dossier admission exists without its replay state")
            return DISPATCH_REQUIRED
        self._assert_state_identity(state, runtime=runtime)
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

    async def admit(
        self,
        runtime: DossierBuildRuntime,
        *,
        requester_user_id: UUID,
        lock_dispatch: LockArtifactDispatch,
    ) -> ArtifactGenerationAdmission:
        """Freeze the exact selection and compose route-specific tool transport."""

        from nexus.db.session import get_session_factory

        session_factory = get_session_factory()
        journal = JobGenerationJournal(
            context=runtime.execution_context,
            step_path=self.path,
            lock_dispatch=lock_dispatch,
        )
        scope = self._tool_scope()
        projection = (
            DossierToolExecutionProjection(
                build_id=runtime.build_id,
                baseline_candidates=self._baseline_candidates(),
            )
            if scope is not None
            else None
        )
        binding: CodexGenerationToolBinding | None = None

        def bind_codex(spec: GenerationSpec) -> CodexAdmissionBinder:
            nonlocal binding
            operation = runtime.llm_runtime.admission.model_tool_operation(spec)
            if operation is None or projection is None:
                raise AssertionError("tool-bearing Dossier lost its frozen operation")
            binding = compose_codex_generation_tool_binding(
                session_factory=session_factory,
                user_id=requester_user_id,
                owner=self.owner,
                generation_id=self.generation_id,
                job_context=runtime.execution_context,
                operation=operation,
                spec=spec,
                intent=self.intent,
                settings=runtime.settings,
                projection=projection,
            )
            return binding.bind_admission

        def provider_executor(spec: GenerationSpec) -> BackendToolExecutor:
            operation = runtime.llm_runtime.admission.model_tool_operation(spec)
            if operation is None or projection is None:
                raise AssertionError("tool-bearing Dossier lost its frozen operation")
            return compose_deferred_generation_tool_executor(
                session_factory=session_factory,
                user_id=requester_user_id,
                owner=self.owner,
                generation_id=self.generation_id,
                job_context=runtime.execution_context,
                operation=operation,
                projection=projection,
            )

        request = await admit_job_generation(
            owner=self.owner,
            generation_id=self.generation_id,
            operation=self.operation,
            intent=self.intent,
            prompt_template_revision=self.prompt_template_revision,
            prompt_payload_ref=self.prompt_payload_ref,
            journal=journal,
            session_factory=session_factory,
            runtime=runtime.llm_runtime,
            scope=scope,
            host=self._host_evidence(runtime),
            bind_admission_factory=bind_codex if scope is not None else None,
            tool_executor_factory=provider_executor if scope is not None else None,
        )
        return ArtifactGenerationAdmission(request=request, codex_tools=binding)

    def encode_terminal(self, terminal: BackendTerminal) -> EncodedGenerationTerminal:
        """Validate and persist a final document at the ledger landing boundary."""

        native = codex_terminal_evidence(terminal)
        accepted_failure: AcceptedGenerationFailure | None = None
        if native.status == "succeeded":
            try:
                decoded = decode_structured_synthesis(native, schema=self.binding.schema)
                if not isinstance(getattr(decoded, _VISIBLE_SYNTHESIS_FIELD, None), str):
                    raise StructuredSynthesisError(
                        f"dossier schema has no string {_VISIBLE_SYNTHESIS_FIELD!r} field"
                    )
                materialized = self._materialize(decoded)
                if len(materialized.citations) < DOSSIER_DEFINITION.min_materialized_citations:
                    raise CitationValidationError("dossier output cited no offered evidence")
            except CitationValidationError as error:
                diagnostic = str(error)
                result: ArtifactGenerationResult = ArtifactGenerationFailure(
                    code=DossierBuildFailureCode.CitationValidationFailed,
                    detail=diagnostic,
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output", detail=diagnostic
                )
            except (DocumentHtmlError, StructuredSynthesisError) as error:
                diagnostic = str(error)
                result = ArtifactGenerationInvalid(
                    rejected_output=(
                        json.dumps(
                            native.structured_output,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        if native.structured_output is not None
                        else ""
                    ),
                    diagnostic=diagnostic,
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output", detail=diagnostic
                )
            else:
                result = _accepted_document(materialized)
        elif native.status == "cancelled":
            result = ArtifactGenerationCancelled()
        else:
            code, detail = outcome_failure_facts(native)
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
        return ArtifactGenerationFailure(
            code=_dossier_failure_code(code),
            detail=detail,
        ).model_dump_json()

    def decode_result(self, raw_result: str) -> ArtifactGenerationResult | PublishableDossier:
        result = _RESULT_ADAPTER.validate_json(raw_result)
        if isinstance(result, ArtifactGenerationAccepted):
            return _publishable_document(result)
        return result

    def _materialize(self, decoded: BaseModel) -> PublishableDossier:
        if self.operation not in _MODEL_TOOL_OPERATIONS:
            return self.binding.materialize(self.collected, decoded, self.witness)
        from nexus.db.session import get_session_factory

        with get_session_factory()() as db:
            candidates = dossier_candidates_from_ledger(
                db,
                generation_id=self.generation_id,
                baseline_candidates=self._baseline_candidates(),
            )
        return materialize_standard(decoded, list(candidates))

    def _baseline_candidates(self) -> tuple[Candidate, ...]:
        candidates = getattr(self.witness, "candidates", None)
        if not isinstance(candidates, list) or any(
            not isinstance(candidate, Candidate) for candidate in candidates
        ):
            raise AssertionError("tool-bearing Dossier witness has no canonical candidates")
        return tuple(candidates)

    def _tool_scope(self) -> FrozenToolScope | None:
        manifest = self.binding.input_manifest(self.collected)
        if self.operation == "dossier_library":
            if not isinstance(manifest, LibraryInputManifestV1):
                raise AssertionError("Library Dossier has the wrong manifest")
            refs = {manifest.library_ref, *(entry.media_ref for entry in manifest.media)}
        elif self.operation == "dossier_idea":
            if not isinstance(manifest, IdeaInputManifestV1):
                raise AssertionError("Idea Dossier has the wrong manifest")
            refs = {
                *manifest.included_seed_refs,
                *(source.ref for source in manifest.included_sources),
            }
        else:
            return None
        canonical = tuple(sorted(refs))
        for value in canonical:
            assert_resource_ref(value)
        return FrozenToolScope(admitted_refs=canonical, predicates=())

    def _host_evidence(self, runtime: DossierBuildRuntime) -> FrozenHostEvidence | None:
        if self.operation != "dossier_idea":
            return None
        operation = runtime.research_tool_operation
        snapshot = freeze_tool_plan_snapshot(operation)
        return FrozenHostEvidence(
            plan=FrozenHostToolPlanSnapshot(
                plan_id=operation.definition.plan_id,
                authority_revision=operation.definition.authority_revision,
                facts=cast(dict[str, JsonValue], snapshot.model_dump(mode="json")),
            ),
            evidence_revision=generation_fact_digest(
                self.binding.input_manifest(self.collected).model_dump(mode="json")
            ),
        )

    def _raw_admission(self, runtime: DossierBuildRuntime) -> object | None:
        admissions = runtime.job.payload.get("generation_admissions")
        if admissions is None:
            return None
        if not isinstance(admissions, dict):
            raise AssertionError("Dossier generation admissions are not an object")
        return admissions.get(self.path)

    def _assert_state_identity(
        self,
        state: durable_step_journal.StepReplayState,
        *,
        runtime: DossierBuildRuntime,
    ) -> None:
        if state.generation_id != self.generation_id:
            raise AssertionError(f"{self.path} generation identity changed")
        if isinstance(state.tool_execution, Present):
            raise AssertionError(f"{self.path} generation contains host-tool metadata")
        raw = self._raw_admission(runtime)
        if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
            raise AssertionError("Dossier generation lost its frozen admission")
        spec = decode_generation_spec_document(raw["spec"])
        intent = GenerationIntent.model_validate(raw["intent"])
        if (
            intent != self.intent
            or spec.operation != self.operation
            or spec.prompt_template_revision != self.prompt_template_revision
            or spec.prompt_payload_ref != self.prompt_payload_ref
        ):
            raise ArtifactGenerationInputsChanged(self.path)
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != spec.fingerprint
        ):
            raise AssertionError("Dossier journal differs from its frozen GenerationSpec")


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
    if path not in GENERATION_STEP_PATHS:
        raise ValueError(f"unknown Artifact generation path {path!r}")
    generation_id = durable_step_journal.stable_generation_id(build_id, path)
    intent = build_synthesis_intent(
        system_prompt=system_prompt,
        user_content=user_content,
        schema=binding.schema,
    )
    prompt_revision = f"{binding.llm_operation}.{path}.prompt.v1"
    return ArtifactGenerationStep(
        path=path,
        generation_id=generation_id,
        operation=cast(BackgroundOperationKey, binding.llm_operation),
        intent=intent,
        prompt_template_revision=prompt_revision,
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="artifact_build",
            owner_id=str(build_id),
            revision=prompt_revision,
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
        owner=LlmCallOwner(kind="artifact_build", id=build_id),
        binding=binding,
        collected=collected,
        witness=witness,
    )


def _accepted_document(document: PublishableDossier) -> ArtifactGenerationAccepted:
    return ArtifactGenerationAccepted(
        content_html=document.content_html,
        content_text=document.content_text,
        citations=tuple(
            ArtifactCitation(
                target_uri=citation.target.uri,
                ordinal=citation.ordinal,
                kind=citation.kind,
                snapshot=snapshot_to_jsonb(citation.snapshot),
            )
            for citation in document.citations
        ),
    )


def _publishable_document(result: ArtifactGenerationAccepted) -> PublishableDossier:
    return PublishableDossier(
        content_html=result.content_html,
        content_text=result.content_text,
        citations=tuple(
            CitationInput(
                target=assert_resource_ref(citation.target_uri),
                ordinal=citation.ordinal,
                kind=citation.kind,
                snapshot=snapshot_from_jsonb(citation.snapshot),
            )
            for citation in result.citations
        ),
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
        case unreachable:
            assert_never(unreachable)
