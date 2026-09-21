"""The one dossier synthesis generation.

The domain owns the prompt bytes, the accepted document, and the citation
grounding; shared admission owns selection and tool snapshots; shared execution
owns the model children and replay. A tool-bearing dossier reconstructs its
citation candidates only from completed durable tool receipts.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Final, Literal, assert_never, cast
from uuid import UUID

from llm_tools import ToolResult
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobRow
from nexus.schemas.presence import Present
from nexus.services import durable_step_journal
from nexus.services.artifacts.collect import (
    EXCERPT_CHARS,
    Candidate,
    CitationValidationError,
    Collected,
    PublishableDossier,
    StandardSynthesis,
    materialize_citations,
    synthesis_user_content,
)
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.document_html import DocumentHtmlError
from nexus.services.artifacts.dossier_types import DossierBuildFailureCode
from nexus.services.artifacts.manifests import IdeaInputManifestV1, LibraryInputManifestV1
from nexus.services.generation_backend import (
    BackendTerminal,
    BackendToolExecutor,
    CodexAdmissionBinder,
)
from nexus.services.generation_spec import (
    BackgroundOperationKey,
    FrozenHostToolPlanSnapshot,
    FrozenToolScope,
    GenerationIntent,
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
    GenerationFailureCode,
    JobGenerationJournal,
    admit_job_generation,
    codex_terminal_evidence,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.resource_graph.refs import (
    ResourceRefParseFailure,
    assert_resource_ref,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import CitationSnapshot
from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    build_synthesis_intent,
    decode_structured_synthesis,
    outcome_failure_facts,
)
from nexus.services.tool_authority import (
    DeferredGenerationToolExecutor,
    ToolAuditProjection,
    ToolAuthority,
    ToolAuthorityRefused,
    ToolPositionRecord,
    read_tool_positions,
)
from nexus.services.tool_runtime.catalog import FrozenToolOperation, freeze_tool_plan_snapshot

if TYPE_CHECKING:
    from nexus.services.agent_tools_mcp import CodexGenerationToolBinding

SYNTHESIS_STEP_PATH: Final = "synthesis"
_MODEL_TOOL_OPERATIONS: Final = frozenset({"dossier_library", "dossier_idea"})


class GenerationFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Failure"] = "Failure"
    code: DossierBuildFailureCode
    detail: str | None = None


class GenerationCancelled(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Cancelled"] = "Cancelled"


type GenerationResult = Annotated[
    PublishableDossier | GenerationFailure | GenerationCancelled,
    Field(discriminator="kind"),
]
_RESULT_ADAPTER: TypeAdapter[GenerationResult] = TypeAdapter(GenerationResult)


@dataclass(frozen=True, slots=True)
class DispatchRequired:
    pass


class GenerationInputsChanged(Exception):
    """A prepared generation no longer has the same exact prompt."""


class GenerationUncertainOnReplay(RuntimeError):
    """A generation may have dispatched and requires operator repair."""


@dataclass(slots=True)
class SynthesisAdmission:
    request: GenerationExecutionRequest
    codex_tools: CodexGenerationToolBinding | None = None

    @property
    def before_terminal(self) -> Callable[[], Awaitable[None]] | None:
        return None if self.codex_tools is None else self.codex_tools.wait_until_idle

    async def close(self) -> None:
        if self.codex_tools is not None:
            await self.codex_tools.drain_and_close()


@dataclass(frozen=True, slots=True)
class SynthesisStep:
    """One build's exact generation position and its immutable domain prompt."""

    build_id: UUID
    generation_id: UUID
    operation: BackgroundOperationKey
    intent: GenerationIntent
    prompt_template_revision: str
    prompt_payload_ref: ImmutablePromptPayloadRef
    owner: LlmCallOwner
    collected: Collected

    def replay(self, runtime: DossierBuildRuntime) -> DispatchRequired | GenerationResult:
        state = runtime.read_step(SYNTHESIS_STEP_PATH)
        if state is None:
            if self._raw_admission(runtime) is not None:
                raise AssertionError("Dossier admission exists without its replay state")
            return DispatchRequired()
        self._assert_identity(state, runtime=runtime)
        if state.dispatch_phase is durable_step_journal.Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError("completed synthesis step has no result")
            return self.decode_result(state.terminal_result.value)
        if state.dispatch_phase is durable_step_journal.Uncertain:
            raise GenerationUncertainOnReplay(
                f"build {runtime.build_id} synthesis step is uncertain on replay"
            )
        return DispatchRequired()

    async def admit(
        self,
        runtime: DossierBuildRuntime,
        *,
        requester_user_id: UUID,
        lock_dispatch: Callable[[Session], JobRow | None],
    ) -> SynthesisAdmission:
        """Freeze the exact selection and compose the route's tool transport."""
        session_factory = get_session_factory()
        journal = JobGenerationJournal(
            context=runtime.execution_context,
            step_path=SYNTHESIS_STEP_PATH,
            lock_dispatch=lock_dispatch,
        )
        scope = self._tool_scope()
        projection = (
            DossierToolExecutionProjection(
                build_id=self.build_id,
                baseline_candidates=tuple(self.collected.candidates),
            )
            if scope is not None
            else None
        )
        binding: CodexGenerationToolBinding | None = None

        def bind_codex(spec: GenerationSpec) -> CodexAdmissionBinder:
            from nexus.services.agent_tools_mcp import CodexGenerationToolBinding

            nonlocal binding
            binding = CodexGenerationToolBinding(
                session_factory=session_factory,
                user_id=requester_user_id,
                owner=self.owner,
                generation_id=self.generation_id,
                job_context=runtime.execution_context,
                operation=_model_tool_operation(runtime, spec),
                spec=spec,
                intent=self.intent,
                projection=projection,
            )
            return binding.bind_admission

        def provider_executor(spec: GenerationSpec) -> BackendToolExecutor:
            return DeferredGenerationToolExecutor(
                session_factory=session_factory,
                user_id=requester_user_id,
                owner=self.owner,
                generation_id=self.generation_id,
                job_context=runtime.execution_context,
                operation=_model_tool_operation(runtime, spec),
                projection=projection,
            )

        host_plan, host_evidence_revision = self._host_evidence(runtime)
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
            host_plan=host_plan,
            host_evidence_revision=host_evidence_revision,
            bind_admission_factory=bind_codex if scope is not None else None,
            tool_executor_factory=provider_executor if scope is not None else None,
        )
        return SynthesisAdmission(request=request, codex_tools=binding)

    def encode_terminal(self, terminal: BackendTerminal) -> EncodedGenerationTerminal:
        """Validate and persist the final document at the ledger landing boundary."""
        native = codex_terminal_evidence(terminal)
        accepted_failure: AcceptedGenerationFailure | None = None
        result: GenerationResult
        if native.status == "succeeded":
            try:
                decoded = decode_structured_synthesis(native, schema=StandardSynthesis)
                result = self._materialize(decoded)
            except CitationValidationError as error:
                result = GenerationFailure(
                    code=DossierBuildFailureCode.CitationValidationFailed, detail=str(error)
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output", detail=str(error)
                )
            except (DocumentHtmlError, StructuredSynthesisError) as error:
                result = GenerationFailure(
                    code=DossierBuildFailureCode.DocumentValidationFailed, detail=str(error)
                )
                accepted_failure = AcceptedGenerationFailure(
                    code="invalid_output", detail=str(error)
                )
        elif native.status == "cancelled":
            result = GenerationCancelled()
        else:
            code, detail = outcome_failure_facts(native)
            result = GenerationFailure(
                code=_failure_code(cast("GenerationFailureCode", code)), detail=detail
            )
        return EncodedGenerationTerminal(
            terminal_result=result.model_dump_json(),
            accepted_failure=accepted_failure,
        )

    def encode_failure(self, code: GenerationFailureCode, detail: str) -> str:
        if code == "cancelled":
            return GenerationCancelled().model_dump_json()
        return GenerationFailure(code=_failure_code(code), detail=detail).model_dump_json()

    def decode_result(self, raw_result: str) -> GenerationResult:
        return _RESULT_ADAPTER.validate_json(raw_result)

    def _materialize(self, decoded: StandardSynthesis) -> PublishableDossier:
        if self.operation not in _MODEL_TOOL_OPERATIONS:
            return materialize_citations(decoded, self.collected.candidates)
        with get_session_factory()() as db:
            candidates = dossier_candidates_from_ledger(
                db,
                generation_id=self.generation_id,
                baseline_candidates=self.collected.candidates,
            )
        return materialize_citations(decoded, list(candidates))

    def _tool_scope(self) -> FrozenToolScope | None:
        manifest = self.collected.manifest
        if isinstance(manifest, LibraryInputManifestV1) and self.operation == "dossier_library":
            refs = {manifest.library_ref, *(entry.media_ref for entry in manifest.media)}
        elif isinstance(manifest, IdeaInputManifestV1) and self.operation == "dossier_idea":
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

    def _host_evidence(
        self, runtime: DossierBuildRuntime
    ) -> tuple[FrozenHostToolPlanSnapshot, str] | tuple[None, None]:
        if self.operation != "dossier_idea":
            return None, None
        operation = runtime.research_tool_operation
        snapshot = freeze_tool_plan_snapshot(operation)
        return (
            FrozenHostToolPlanSnapshot(
                plan_id=operation.definition.plan_id,
                authority_revision=operation.definition.authority_revision,
                facts=cast("dict[str, JsonValue]", snapshot.model_dump(mode="json")),
            ),
            generation_fact_digest(self.collected.manifest.model_dump(mode="json")),
        )

    def _raw_admission(self, runtime: DossierBuildRuntime) -> object | None:
        admissions = runtime.job.payload.get("generation_admissions")
        if admissions is None:
            return None
        if not isinstance(admissions, dict):
            raise AssertionError("Dossier generation admissions are not an object")
        return admissions.get(SYNTHESIS_STEP_PATH)

    def _assert_identity(
        self,
        state: durable_step_journal.StepReplayState,
        *,
        runtime: DossierBuildRuntime,
    ) -> None:
        if state.generation_id != self.generation_id:
            raise AssertionError("synthesis generation identity changed")
        raw = self._raw_admission(runtime)
        if not isinstance(raw, dict) or set(raw) != {"spec", "intent"}:
            raise AssertionError("Dossier generation lost its frozen admission")
        spec = decode_generation_spec_document(raw["spec"])
        if (
            GenerationIntent.model_validate(raw["intent"]) != self.intent
            or spec.operation != self.operation
            or spec.prompt_template_revision != self.prompt_template_revision
            or spec.prompt_payload_ref != self.prompt_payload_ref
        ):
            raise GenerationInputsChanged(SYNTHESIS_STEP_PATH)
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != spec.fingerprint
        ):
            raise AssertionError("Dossier journal differs from its frozen GenerationSpec")


def build_synthesis_step(
    *,
    build_id: UUID,
    operation: BackgroundOperationKey,
    system_prompt: str,
    collected: Collected,
    instruction: str | None,
) -> SynthesisStep:
    intent = build_synthesis_intent(
        system_prompt=system_prompt,
        user_content=synthesis_user_content(collected, instruction),
        schema=StandardSynthesis,
    )
    prompt_revision = f"{operation}.{SYNTHESIS_STEP_PATH}.prompt.v1"
    return SynthesisStep(
        build_id=build_id,
        generation_id=durable_step_journal.stable_generation_id(build_id, SYNTHESIS_STEP_PATH),
        operation=operation,
        intent=intent,
        prompt_template_revision=prompt_revision,
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="artifact_build",
            owner_id=str(build_id),
            revision=prompt_revision,
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
        owner=LlmCallOwner(kind="artifact_build", id=build_id),
        collected=collected,
    )


def _model_tool_operation(
    runtime: DossierBuildRuntime, spec: GenerationSpec
) -> FrozenToolOperation:
    operation = runtime.llm_runtime.admission.model_tool_operation(spec)
    if operation is None:
        raise AssertionError("tool-bearing Dossier lost its frozen operation")
    return operation


def _failure_code(code: GenerationFailureCode) -> DossierBuildFailureCode:
    match code:
        case "auth":
            return DossierBuildFailureCode.Auth
        case "quota":
            return DossierBuildFailureCode.Quota
        case "timeout":
            return DossierBuildFailureCode.Timeout
        case "output_limit" | "turn_limit":
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
        case "cancelled":
            raise AssertionError("cancellation has its own dossier outcome")
        case unreachable:
            assert_never(unreachable)


# ---------------------------------------------------------------------------
# The ledger-candidate projection `tool_authority` drives for tool-bearing runs.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DossierToolExecutionProjection:
    """Bind one build and its initial citation-candidate sequence to tool runs."""

    build_id: UUID
    baseline_candidates: tuple[Candidate, ...]

    @property
    def scope_label(self) -> str:
        return "dossier_evidence"

    def lock_owner(self, db: Session, *, user_id: UUID, owner: LlmCallOwner) -> None:
        if owner != LlmCallOwner(kind="artifact_build", id=self.build_id):
            raise ToolAuthorityRefused("Dossier projection owner differs from the generation")
        requester = db.execute(
            text("SELECT requester_user_id FROM artifact_builds WHERE id = :build_id FOR UPDATE"),
            {"build_id": self.build_id},
        ).scalar_one_or_none()
        if requester is None or UUID(str(requester)) != user_id:
            raise ToolAuthorityRefused("Dossier projection requester is not live")

    def stage_started(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        provider_wire_name: str,
        arguments: Mapping[str, object],
    ) -> None:
        del db, authority, position, provider_wire_name, arguments

    def stage_terminal(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
        audit: ToolAuditProjection,
    ) -> None:
        del db, authority, position, result, audit

    def render_output(
        self,
        db: Session,
        *,
        authority: ToolAuthority,
        position: ToolPositionRecord,
        result: ToolResult,
    ) -> str:
        del position
        if result.get("type") != "Success":
            return _canonical_json(result)
        candidates = dossier_candidates_from_ledger(
            db,
            generation_id=authority.generation_id,
            baseline_candidates=self.baseline_candidates,
        )
        index_by_target = {candidate.target.uri: candidate.index for candidate in candidates}
        return _canonical_json(
            {
                **result,
                "dossier_citation_candidates": [
                    {
                        "candidate_index": index_by_target[candidate.target.uri],
                        "target_uri": candidate.target.uri,
                    }
                    for candidate in _candidates_from_result(result, start_index=0)
                    if candidate.target.uri in index_by_target
                ],
            }
        )

    def live_write_count(self, db: Session, *, authority: ToolAuthority) -> int | None:
        del db, authority
        return None


def dossier_candidates_from_ledger(
    db: Session,
    *,
    generation_id: UUID,
    baseline_candidates: Sequence[Candidate],
) -> tuple[Candidate, ...]:
    """Reconstruct the exact candidate order from terminal tool receipts."""
    candidates = list(baseline_candidates)
    seen = {candidate.target.uri for candidate in candidates}
    for position in read_tool_positions(db, generation_id=generation_id):
        if position.replay_status != "Completed" or position.result_evidence is None:
            continue
        raw_result = position.result_evidence.get("tool_result")
        if not isinstance(raw_result, dict):
            raise AssertionError("completed Dossier tool position has no canonical result")
        for candidate in _candidates_from_result(raw_result, start_index=len(candidates)):
            if candidate.target.uri in seen:
                continue
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=candidate.target,
                    text=candidate.text,
                    snapshot=candidate.snapshot,
                )
            )
            seen.add(candidate.target.uri)
    return tuple(candidates)


def _candidates_from_result(result: Mapping[str, object], *, start_index: int) -> list[Candidate]:
    if result.get("type") != "Success" or not isinstance(result.get("value"), dict):
        return []
    candidates: list[Candidate] = []
    seen: set[str] = set()
    for node in _objects(result["value"]):
        evidence = node.get("evidence")
        if not isinstance(evidence, dict):
            continue
        target_uri = evidence.get("citation_target") or evidence.get("resource_uri")
        if not isinstance(target_uri, str) or target_uri in seen:
            continue
        parsed = parse_resource_ref(target_uri)
        if isinstance(parsed, ResourceRefParseFailure):
            continue
        title = node.get("title")
        text_value = next(
            (
                value
                for key in ("text", "excerpt", "rationale")
                if isinstance(value := node.get(key), str) and value
            ),
            title if isinstance(title, str) else target_uri,
        )
        candidates.append(
            Candidate(
                index=start_index + len(candidates),
                target=parsed,
                text=text_value,
                snapshot=CitationSnapshot(
                    title=title if isinstance(title, str) else None,
                    excerpt=text_value[:EXCERPT_CHARS],
                    result_type=parsed.scheme,
                ),
            )
        )
        seen.add(target_uri)
    return candidates


def _objects(value: object) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    if isinstance(value, dict):
        found.append(value)
        for child in value.values():
            found.extend(_objects(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_objects(child))
    return found


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
