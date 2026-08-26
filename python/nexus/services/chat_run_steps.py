"""Strict durable step records and runtime for one claimed chat job."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from llm_tools import ToolResult
from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.jobs.queue import (
    RUNNING,
    JobExecutionContext,
    JobRow,
    current_dead_job_for_payload,
    get_job,
    lock_chat_generation_admission_in_current_transaction,
    lock_running_job_claim,
    replace_dead_job_payload,
    requeue_dead_job,
    update_running_job_payload,
)
from nexus.schemas.conversation import ChatRunToolResultEventPayload
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.chat_run_event_store import lock_chat_run_for_update
from nexus.services.chat_run_tools import (
    RecordKind,
    ToolModelOutput,
    ToolStepResult,
)
from nexus.services.durable_step_journal import (
    AttachReconciledResult,
    Completed,
    Prepared,
    ProveNotDispatched,
    ReplayPolicy,
    StepReplayState,
    Uncertain,
    UncertainStepResolution,
    decode_step_result,
    decode_step_states,
    encode_step_result,
    payload_with_step_state,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_intent import GenerationIntent
from nexus.services.llm_execution import (
    ExecutionRuntime,
    prove_uncertain_generation_not_dispatched_in_current_transaction,
)
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_generation_owner_in_current_transaction,
)
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    compose_product_tool_runtime,
    freeze_tool_plan_snapshot,
    validate_tool_plan_snapshot,
)
from nexus.services.tool_runtime.execution import (
    reconcile_uncertain_tool_completion,
    recover_chat_tool_execution_receipt,
    stage_prepared_chat_tool_not_dispatched,
    stage_reconciled_chat_tool_terminal,
)


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PreparedChatRun(_StateModel):
    generate_intent: GenerationIntent
    admitted_resource_uris: tuple[str, ...]
    initial_citation_ordinal: int = Field(ge=1)
    initial_tool_call_index: int = Field(ge=0)


class AssistantTurn(_StateModel):
    kind: Literal["AssistantTurn"] = "AssistantTurn"
    text: str
    tool_calls: tuple[ChatToolCall, ...]
    usage: Presence[dict[str, JsonValue]]
    support_id: Presence[str]
    last_provider_event_seq: Presence[int]


class ExpectedFailure(_StateModel):
    kind: Literal["ExpectedFailure"] = "ExpectedFailure"
    assistant_content: str
    error_code: str = Field(min_length=1)
    usage: Presence[dict[str, JsonValue]]
    support_id: Presence[str]
    last_provider_event_seq: Presence[int]


class CancelledGeneration(_StateModel):
    kind: Literal["Cancelled"] = "Cancelled"
    assistant_content: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


type GenerationStepResult = Annotated[
    AssistantTurn | ExpectedFailure | CancelledGeneration,
    Field(discriminator="kind"),
]


class GenerationStepResultEnvelope(RootModel[GenerationStepResult]):
    model_config = ConfigDict(frozen=True)


class PublicationStepResult(_StateModel):
    outcome: Literal["Published", "Degraded", "Failed", "Cancelled"]
    message_id: UUID
    terminal_event_seq: int = Field(ge=1)


class PublicationRequest(_StateModel):
    generated_markdown: str
    usage: Presence[dict[str, JsonValue]]
    last_provider_event_seq: Presence[int]


class RejectedToolStepRequest(_StateModel):
    provider_call_id: str = Field(min_length=1)
    provider_wire_name: str = Field(min_length=1, max_length=128)
    tool_call_index: int = Field(ge=1)


class RejectedToolStepResult(_StateModel):
    tool_call_id: UUID
    canonical_tool_id: None = None
    record_kind: Literal[RecordKind.rejected_provider_call] = RecordKind.rejected_provider_call
    provider_wire_name: str = Field(min_length=1, max_length=128)
    canonical_input_sha256: None = None
    tool_contract_revision: None = None
    binding_policy_revision: None = None
    tool_call_index: int = Field(ge=1)
    model_output: ToolModelOutput
    next_citation_ordinal: int = Field(ge=1)
    result_event: ChatRunToolResultEventPayload


type ToolJournalResult = Annotated[
    ToolStepResult | RejectedToolStepResult,
    Field(discriminator="record_kind"),
]


class ToolJournalResultEnvelope(RootModel[ToolJournalResult]):
    model_config = ConfigDict(frozen=True)


class ChatToolCall(_StateModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class ChatToolProfileAdmission:
    profile_id: str
    profile_revision: str
    snapshot: dict[str, object]


def chat_tool_profile_admission(operation: FrozenToolOperation) -> ChatToolProfileAdmission:
    """Freeze the semantic tool authority persisted on a newly admitted run."""

    snapshot = freeze_tool_plan_snapshot(operation)
    if snapshot.exposure.type != "Native" or snapshot.profile_id != "chat":
        raise ValueError("Chat requires the exact Native chat tool operation")
    return ChatToolProfileAdmission(
        profile_id=snapshot.profile_id,
        profile_revision=snapshot.profile_revision,
        snapshot=snapshot.model_dump(mode="json"),
    )


def validate_chat_tool_profile(run: ChatRun, operation: FrozenToolOperation) -> None:
    """Reject a run whose admitted semantic tool authority has drifted."""

    if (
        run.tool_profile_id is None
        or run.tool_profile_revision is None
        or run.tool_profile_snapshot is None
    ):
        raise AssertionError("chat run is missing its tool profile snapshot")
    decoded = validate_tool_plan_snapshot(
        json.dumps(run.tool_profile_snapshot, separators=(",", ":"), sort_keys=True),
        operation=operation,
    )
    if (
        run.tool_profile_id != decoded.profile_id
        or run.tool_profile_revision != decoded.profile_revision
        or decoded.exposure.type != "Native"
        or decoded.profile_id != "chat"
    ):
        raise AssertionError("chat run tool profile columns disagree with its snapshot")


class UncertainChatStep(RuntimeError):
    """A paid or write effect may have landed and requires operator repair."""


class LostChatJobLease(RuntimeError):
    """The claimed attempt lost its queue lease before a checkpoint landed."""


def step_fingerprint(value: BaseModel) -> str:
    encoded = json.dumps(
        value.model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ChatStepRuntime:
    """The durable capabilities of one currently claimed chat attempt."""

    def __init__(
        self,
        db: Session,
        *,
        run_id: UUID,
        job: JobRow,
        execution_context: JobExecutionContext,
        llm_runtime: ExecutionRuntime,
    ) -> None:
        self.db = db
        self.run_id = run_id
        self.job = job
        self.execution_context = execution_context
        self.llm_runtime = llm_runtime

    def read(self, path: str, policy: ReplayPolicy) -> StepReplayState | None:
        state = read_step_states(self.job).get(path)
        if state is not None and state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        if state is not None and state.dispatch_phase is Uncertain:
            if policy is ReplayPolicy.BilledOnce:
                raise UncertainChatStep(f"chat step {path!r} has an uncertain external outcome")
        return state

    def prepare(self, path: str, fingerprint: str) -> StepReplayState:
        if read_step_states(self.job).get(path) is not None:
            raise AssertionError(f"chat step {path!r} is already prepared")
        state = StepReplayState(
            generation_id=stable_generation_id(self.run_id, path),
            dispatch_phase=Prepared,
            request_fingerprint=present(fingerprint),
            terminal_result=absent(),
        )
        self._checkpoint(path, state)
        return state

    def mark_uncertain(self, path: str) -> StepReplayState:
        current = self._required_state(path, Prepared)
        state = current.model_copy(update={"dispatch_phase": Uncertain})
        self._checkpoint(path, state)
        return state

    def complete(self, path: str, result: BaseModel) -> StepReplayState:
        current = read_step_states(self.job).get(path)
        if current is None or current.dispatch_phase not in {Prepared, Uncertain}:
            raise AssertionError(f"chat step {path!r} cannot complete from its current phase")
        state = current.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": present(encode_step_result(result)),
            }
        )
        self._checkpoint(path, state)
        return state

    def complete_database_step(
        self,
        path: str,
        *,
        fingerprint: str,
        result: BaseModel,
    ) -> StepReplayState:
        """Commit one pure/database step and its exact result in one boundary."""
        if read_step_states(self.job).get(path) is not None:
            raise AssertionError(f"chat database step {path!r} is already journaled")
        state = StepReplayState(
            generation_id=stable_generation_id(self.run_id, path),
            dispatch_phase=Completed,
            request_fingerprint=present(fingerprint),
            terminal_result=present(encode_step_result(result)),
        )
        self._checkpoint(path, state)
        return state

    def complete_publication(self, result: PublicationStepResult) -> None:
        path = "publication"
        current = self._required_state(path, Prepared)
        completed = current.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": present(encode_step_result(result)),
            }
        )
        completed_payload = payload_with_step_state(
            self.job.payload,
            step_path=path,
            state=completed,
        )
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=completed_payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload={"run_id": str(self.run_id)},
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload={"run_id": str(self.run_id)})
        self.db.commit()

    def clear(self) -> None:
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload={"run_id": str(self.run_id)},
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload={"run_id": str(self.run_id)})
        self.db.commit()

    def generation_id(self, path: str) -> UUID:
        state = read_step_states(self.job).get(path)
        if state is None:
            raise AssertionError(f"chat step {path!r} is not prepared")
        if state.generation_id != stable_generation_id(self.run_id, path):
            raise AssertionError(f"chat step {path!r} has a noncanonical generation id")
        return state.generation_id

    def refresh_job(self) -> None:
        """Reload recorder-owned checkpoints before Chat writes another step."""

        refreshed = get_job(self.db, self.execution_context.job_id)
        if (
            refreshed is None
            or refreshed.status != RUNNING
            or refreshed.claimed_by != self.execution_context.worker_id
            or refreshed.attempts != self.execution_context.attempt_no
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = refreshed

    def assert_no_uncertain_tool_effect(self) -> None:
        """Suspend the run while any MCP effect lacks an authoritative receipt."""

        self.refresh_job()
        uncertain = sorted(
            path
            for path, state in read_step_states(self.job).items()
            if isinstance(state.tool_execution, Present) and state.dispatch_phase is Uncertain
        )
        if uncertain:
            raise UncertainChatStep(
                "chat MCP completion requires reconciliation at " + ", ".join(uncertain)
            )
        run = lock_chat_run_for_update(self.db, self.run_id)
        if run is None or run.status not in {"queued", "running"}:
            self.db.rollback()
            raise UncertainChatStep("chat MCP receipt recovery requires one active run")
        self.lock_active_attempt()
        locked_job = get_job(self.db, self.execution_context.job_id)
        if locked_job is None:
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} disappeared")
        operation = compose_product_tool_runtime(None).operations["chat"]
        validate_chat_tool_profile(run, operation)
        payload, incomplete = _repair_completed_mcp_receipts(
            self.db,
            run=run,
            operation=operation,
            payload=locked_job.payload,
        )
        if incomplete:
            self.db.rollback()
            raise UncertainChatStep(
                "chat MCP completion lacks durable receipts at " + ", ".join(incomplete)
            )
        if payload != locked_job.payload and not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(locked_job, payload=payload)
        self.db.commit()

    def stage_prepared_mcp_cancellation_terminals(self) -> None:
        """Close admission-only MCP positions inside the cancelled terminal fold."""

        run = lock_chat_run_for_update(self.db, self.run_id)
        if run is None or run.status not in {"queued", "running"}:
            self.db.rollback()
            raise LostChatJobLease("Chat cancelled terminal lost its active run authority")
        self.lock_active_attempt()
        locked_job = get_job(self.db, self.execution_context.job_id)
        if locked_job is None:
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} disappeared")
        operation = compose_product_tool_runtime(None).operations["chat"]
        validate_chat_tool_profile(run, operation)
        payload = locked_job.payload
        states = read_step_states(locked_job)
        prepared: list[tuple[int, int, str, StepReplayState]] = []
        for path, state in states.items():
            match = re.fullmatch(r"generation/(\d+)/tool/(\d+)", path)
            if (
                match is None
                or state.dispatch_phase is not Prepared
                or not isinstance(state.tool_execution, Present)
            ):
                continue
            generation_seq, tool_call_index = (int(value) for value in match.groups())
            prepared.append((generation_seq, tool_call_index, path, state))

        for generation_seq, tool_call_index, path, state in sorted(prepared):
            generation_state = states.get(f"generation/{generation_seq}")
            if generation_state is None or generation_state.dispatch_phase is not Uncertain:
                self.db.rollback()
                raise AssertionError("prepared MCP cancellation has no uncertain outer generation")
            if state.generation_id != stable_generation_id(self.run_id, path):
                self.db.rollback()
                raise AssertionError("prepared MCP cancellation has a noncanonical generation id")
            _assert_incomplete_mcp_entry_for_tool_state(
                payload,
                step_path=path,
                state=state,
            )
            completed = stage_prepared_chat_tool_not_dispatched(
                db=self.db,
                operation=operation,
                run=run,
                tool_call_index=tool_call_index,
                state=state,
            )
            payload = payload_with_step_state(payload, step_path=path, state=completed)

        if payload != locked_job.payload and not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(locked_job, payload=payload)

    def lock_active_attempt(self) -> None:
        """Lock this live claim into the caller's current effect transaction."""
        if not lock_running_job_claim(self.db, context=self.execution_context):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")

    def lock_dispatch(self, db: Session) -> JobRow | None:
        """Return the currently fenced job for ``JobGenerationJournal``."""
        if not lock_running_job_claim(db, context=self.execution_context):
            return None
        return get_job(db, self.execution_context.job_id)

    def _required_state(self, path: str, phase: Any) -> StepReplayState:
        state = read_step_states(self.job).get(path)
        if state is None or state.dispatch_phase is not phase:
            raise AssertionError(f"chat step {path!r} is not {phase}")
        return state

    def _checkpoint(self, path: str, state: StepReplayState) -> None:
        payload = payload_with_step_state(self.job.payload, step_path=path, state=state)
        if not update_running_job_payload(
            self.db,
            job_id=self.execution_context.job_id,
            worker_id=self.execution_context.worker_id,
            attempt_no=self.execution_context.attempt_no,
            payload=payload,
        ):
            self.db.rollback()
            raise LostChatJobLease(f"chat job {self.job.id} lost its lease")
        self.job = replace(self.job, payload=payload)
        self.db.commit()


def decode_prepared(state: StepReplayState) -> PreparedChatRun:
    return _decode_completed(state, PreparedChatRun)


def decode_generation(state: StepReplayState) -> GenerationStepResult:
    return _decode_completed(state, GenerationStepResultEnvelope).root


def decode_rejected_tool(state: StepReplayState) -> RejectedToolStepResult:
    return _decode_completed(state, RejectedToolStepResult)


def _repair_completed_mcp_receipts(
    db: Session,
    *,
    run: ChatRun,
    operation: FrozenToolOperation,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Repair only projections whose inner durable tool terminal is complete."""

    raw_journal = payload.get("_agent_tool_calls", {})
    if not isinstance(raw_journal, dict):
        raise AssertionError("chat MCP journal is not an object")
    states = decode_step_states(payload)
    prepare_state = states.get("prepare")
    if prepare_state is None:
        raise AssertionError("chat MCP journal has no prepare cursor owner")
    prepared = decode_prepared(prepare_state)
    cursor = prepared.initial_citation_ordinal
    expected_index = prepared.initial_tool_call_index + 1
    journal = {
        str(key): dict(value) for key, value in raw_journal.items() if isinstance(value, dict)
    }
    if len(journal) != len(raw_journal):
        raise AssertionError("chat MCP journal has an invalid entry")
    ordered = sorted(journal.items(), key=lambda item: _journal_tool_index(item[1]))
    incomplete: list[str] = []
    for key, entry in ordered:
        generation_seq = entry.get("generation_seq")
        tool_index = entry.get("tool_index")
        if (
            type(generation_seq) is not int
            or generation_seq < 1
            or type(tool_index) is not int
            or tool_index != expected_index
            or entry.get("citation_ordinal") != cursor
        ):
            raise AssertionError("chat MCP journal position/citation order is invalid")
        raw_result = entry.get("result")
        if raw_result is None:
            path = f"generation/{generation_seq}/tool/{tool_index}"
            state = states.get(path)
            if (
                state is None
                or state.dispatch_phase is not Completed
                or not isinstance(state.tool_execution, Present)
                or not isinstance(state.terminal_result, Present)
            ):
                incomplete.append(key)
                expected_index += 1
                continue
            identity = state.tool_execution.value.identity
            provider_wire_name = entry.get("provider_wire_name")
            provider_call_id = entry.get("provider_call_id")
            if (
                entry.get("canonical_tool_id") != identity.tool_id
                or entry.get("digest") != identity.input_digest
                or provider_wire_name != identity.tool_id
                or not isinstance(provider_wire_name, str)
                or not isinstance(provider_call_id, str)
            ):
                raise AssertionError("chat MCP journal differs from its completed tool identity")
            result = recover_chat_tool_execution_receipt(
                db=db,
                operation=operation,
                run=run,
                tool_call_index=tool_index,
                identity=identity,
                raw_result=state.terminal_result.value,
                provider_wire_name=provider_wire_name,
                provider_call_id=provider_call_id,
                starting_citation_ordinal=cursor,
            )
            raw_result = result.model_dump(mode="json")
            entry["result"] = raw_result
            entry["next_citation_ordinal"] = result.next_citation_ordinal
        result = ToolJournalResultEnvelope.model_validate(raw_result).root
        if (
            result.tool_call_index != expected_index
            or entry.get("provider_call_id") != result.model_output.call_id
            or entry.get("next_citation_ordinal") != result.next_citation_ordinal
            or result.next_citation_ordinal < cursor
        ):
            raise AssertionError("chat MCP receipt disagrees with its journal position")
        cursor = result.next_citation_ordinal
        expected_index += 1
    repaired = dict(payload)
    repaired["_agent_tool_calls"] = journal
    return repaired, tuple(incomplete)


def _journal_tool_index(entry: dict[str, Any]) -> int:
    value = entry.get("tool_index")
    if type(value) is not int:
        raise AssertionError("chat MCP journal has an invalid entry")
    return value


def _assert_incomplete_mcp_entry_for_tool_state(
    payload: dict[str, Any],
    *,
    step_path: str,
    state: StepReplayState,
) -> None:
    """Require one preserved outer admission before resolving non-dispatch."""

    match = re.fullmatch(r"generation/(\d+)/tool/(\d+)", step_path)
    if match is None or not isinstance(state.tool_execution, Present):
        raise ValueError("Chat tool state has no canonical MCP position")
    generation_seq, tool_index = (int(value) for value in match.groups())
    raw_journal = payload.get("_agent_tool_calls", {})
    if not isinstance(raw_journal, dict):
        raise ValueError("Chat MCP journal is not an object")
    matches = [
        entry
        for entry in raw_journal.values()
        if isinstance(entry, dict)
        and entry.get("generation_seq") == generation_seq
        and entry.get("tool_index") == tool_index
    ]
    if len(matches) != 1:
        raise ValueError("Chat tool state does not own one outer MCP admission")
    entry = matches[0]
    identity = state.tool_execution.value.identity
    if (
        entry.get("result") is not None
        or entry.get("canonical_tool_id") != identity.tool_id
        or entry.get("provider_wire_name") != identity.tool_id
        or entry.get("digest") != identity.input_digest
        or not isinstance(entry.get("provider_call_id"), str)
        or type(entry.get("citation_ordinal")) is not int
    ):
        raise ValueError("Chat outer MCP admission differs from its prepared tool state")


def reconcile_prepared_mcp_admission_not_dispatched(
    db: Session,
    *,
    run_id: UUID,
    step_path: str,
) -> None:
    """Close one proven-undispatched MCP admission without resolving its generation."""

    try:
        owner = LlmCallOwner(kind="chat_run", id=run_id)
        lock_generation_owner_in_current_transaction(db, owner)
        lock_chat_generation_admission_in_current_transaction(db)
        run = lock_chat_run_for_update(db, run_id)
        if run is None:
            raise ValueError("reconciled chat run does not exist")
        job = current_dead_job_for_payload(
            db,
            kind="chat_run",
            expected_payload_match={"run_id": str(run_id)},
        )
        if job is None:
            raise ValueError("chat run has no suspended job")
        state = read_step_states(job).get(step_path)
        if (
            state is None
            or state.dispatch_phase is not Prepared
            or not isinstance(state.tool_execution, Present)
        ):
            raise ValueError("chat step is not a prepared MCP admission")
        if state.generation_id != stable_generation_id(run_id, step_path):
            raise ValueError("chat step has a noncanonical generation id")
        tool_match = re.fullmatch(r"generation/(\d+)/tool/(\d+)", step_path)
        if tool_match is None:
            raise ValueError("prepared MCP admission occupies a non-tool Chat step")
        generation_seq, tool_call_index = (int(value) for value in tool_match.groups())
        generation_path = f"generation/{generation_seq}"
        generation_state = read_step_states(job).get(generation_path)
        if generation_state is None or generation_state.dispatch_phase is not Uncertain:
            raise ValueError("prepared MCP admission has no uncertain outer generation")
        if run.status not in {"queued", "running"}:
            raise ValueError("reconciled chat result requires one active run")
        operation = compose_product_tool_runtime(None).operations["chat"]
        validate_chat_tool_profile(run, operation)
        _assert_incomplete_mcp_entry_for_tool_state(
            job.payload,
            step_path=step_path,
            state=state,
        )
        next_state = stage_prepared_chat_tool_not_dispatched(
            db=db,
            operation=operation,
            run=run,
            tool_call_index=tool_call_index,
            state=state,
        )
        payload = payload_with_step_state(job.payload, step_path=step_path, state=next_state)
        payload, incomplete = _repair_completed_mcp_receipts(
            db,
            run=run,
            operation=operation,
            payload=payload,
        )
        if incomplete:
            raise AssertionError(
                "prepared Chat tool did not produce its outer MCP receipt: " + ", ".join(incomplete)
            )
        if not replace_dead_job_payload(db, job_id=job.id, payload=payload):
            raise AssertionError("suspended chat job changed while locked")
        db.commit()
    except BaseException:
        db.rollback()
        raise


def reconcile_uncertain_chat_step(
    db: Session,
    *,
    run_id: UUID,
    step_path: str,
    resolution: UncertainStepResolution,
) -> None:
    try:
        owner = LlmCallOwner(kind="chat_run", id=run_id)
        lock_generation_owner_in_current_transaction(db, owner)
        lock_chat_generation_admission_in_current_transaction(db)
        run = lock_chat_run_for_update(db, run_id)
        if run is None:
            raise ValueError("reconciled chat run does not exist")
        job = current_dead_job_for_payload(
            db,
            kind="chat_run",
            expected_payload_match={"run_id": str(run_id)},
        )
        if job is None:
            raise ValueError("chat run has no suspended job")
        state = read_step_states(job).get(step_path)
        if state is None or state.dispatch_phase is not Uncertain:
            raise ValueError("chat step is not uncertain")
        if state.generation_id != stable_generation_id(run_id, step_path):
            raise ValueError("chat step has a noncanonical generation id")
        repair_operation: FrozenToolOperation | None = None
        if isinstance(resolution, ProveNotDispatched):
            tool_execution = state.tool_execution
            if isinstance(tool_execution, Present):
                if tool_execution.value.identity.replay_policy is not ReplayPolicy.BilledOnce:
                    raise ValueError("ReDispatchable tool recovery is owned by lease abandonment")
                tool_execution = present(
                    tool_execution.value.model_copy(update={"dispatch_claim": absent()})
                )
                next_state = state.model_copy(
                    update={
                        "dispatch_phase": Prepared,
                        "tool_execution": tool_execution,
                    }
                )
            else:
                next_state = prove_uncertain_generation_not_dispatched_in_current_transaction(
                    db,
                    owner=owner,
                    state=state,
                )
        elif isinstance(resolution, AttachReconciledResult):
            if isinstance(state.tool_execution, Present):
                if not isinstance(resolution.tool_settlement, Present):
                    raise ValueError("reconciled tool result requires an exact settlement")
                if run.status not in {"queued", "running"}:
                    raise ValueError("reconciled chat result requires one active run")
                tool_match = re.fullmatch(r"generation/\d+/tool/(\d+)", step_path)
                if tool_match is None:
                    raise ValueError("tool execution occupies a non-tool Chat step")
                operation = compose_product_tool_runtime(None).operations["chat"]
                repair_operation = operation
                validate_chat_tool_profile(run, operation)
                next_state = reconcile_uncertain_tool_completion(
                    operation=operation,
                    state=state,
                    raw_result=resolution.terminal_result,
                    settlement=resolution.tool_settlement.value,
                )
                if not isinstance(next_state.terminal_result, Present):
                    raise AssertionError("reconciled tool completion omitted its terminal result")
                result = cast(ToolResult, json.loads(next_state.terminal_result.value))
                stage_reconciled_chat_tool_terminal(
                    db=db,
                    operation=operation,
                    run=run,
                    tool_call_index=int(tool_match.group(1)),
                    identity=state.tool_execution.value.identity,
                    result=result,
                )
            else:
                raise ValueError(
                    "chat generation attachment requires immutable original command facts"
                )
        else:
            raise AssertionError("unknown uncertain chat-step resolution")
        payload = payload_with_step_state(job.payload, step_path=step_path, state=next_state)
        if repair_operation is not None:
            payload, incomplete = _repair_completed_mcp_receipts(
                db,
                run=run,
                operation=repair_operation,
                payload=payload,
            )
            if incomplete:
                raise AssertionError(
                    "reconciled Chat tool did not produce its outer MCP receipt: "
                    + ", ".join(incomplete)
                )
        if not replace_dead_job_payload(db, job_id=job.id, payload=payload):
            raise AssertionError("suspended chat job changed while locked")
        if not requeue_dead_job(db, job_id=job.id):
            raise AssertionError("suspended chat job could not be requeued")
        db.commit()
    except BaseException:
        db.rollback()
        raise


def _decode_completed[T: BaseModel](state: StepReplayState, schema: type[T]) -> T:
    if state.dispatch_phase is not Completed or not isinstance(state.terminal_result, Present):
        raise AssertionError("chat step is not completed")
    return decode_step_result(state.terminal_result.value, schema)


def assistant_turn_result(
    *,
    text: str,
    tool_calls: tuple[ChatToolCall, ...],
    usage: dict[str, JsonValue] | None,
    support_id: str | None,
    last_provider_event_seq: int | None,
) -> AssistantTurn:
    return AssistantTurn(
        text=text,
        tool_calls=tool_calls,
        usage=(absent() if usage is None else Present[dict[str, JsonValue]](value=usage)),
        support_id=absent() if support_id is None else Present[str](value=support_id),
        last_provider_event_seq=(
            absent()
            if last_provider_event_seq is None
            else Present[int](value=last_provider_event_seq)
        ),
    )
