"""A native stream must finish validly before its terminal becomes durable truth."""

import asyncio
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import cast
from uuid import UUID, uuid4

import pytest

from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationCommandDraft,
    GenerationFrame,
    GenerationNative,
    GenerationTerminal,
)
from nexus.services.generation_backend import (
    BackendChildCompletion,
    BackendChildDispatch,
    BackendGenerationRequest,
    BackendToolExecutor,
    CodexAdmissionBinder,
    GenerationBackend,
    GenerationBackendComposition,
    GenerationBackendDefect,
    GenerationBackendExecution,
    PreparedCodexChild,
    ProviderContinuationIdentity,
    ProviderGenerationTransport,
    ProviderModelToolProjection,
)
from nexus.services.generation_events import BackendEvent, BackendTerminal
from tests.testkit.codex_generation import codex_generation_draft


def test_late_native_evidence_cannot_commit_or_publish_a_generation_terminal() -> None:
    asyncio.run(_prove_terminal_acceptance())


async def _prove_terminal_acceptance() -> None:
    draft = codex_generation_draft(
        request_id=uuid4(),
        operation="chat",
        instructions="Answer the request.",
        input_text="A bounded inference.",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=60,
    )
    host = _Host()
    backend = GenerationBackend(
        GenerationBackendComposition(
            codex=_LateCodex(),
            provider=cast(ProviderGenerationTransport, _Unused()),
            codex_projection=host,
            provider_tools=cast(ProviderModelToolProjection, _Unused()),
        )
    )
    with pytest.raises(GenerationBackendDefect, match="after terminal"):
        await backend.execute(
            GenerationBackendExecution(
                request=BackendGenerationRequest(
                    generation_id=draft.request_id,
                    spec=draft.spec,
                    intent=draft.intent,
                ),
                lifecycle=host,
                tool_executor=cast(BackendToolExecutor, _Unused()),
                observer=host,
                cancellation=asyncio.Event(),
            )
        )
    assert host.completed == [], "a malformed stream committed terminal truth"
    assert not any(isinstance(event, BackendTerminal) for event in host.events)


class _Unused:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"no-tool Codex inference used unrelated boundary {name}")


@dataclass
class _Host:
    completed: list[BackendChildCompletion] = field(default_factory=list)
    events: list[BackendEvent] = field(default_factory=list)

    def prepare(self, request: BackendGenerationRequest) -> PreparedCodexChild:
        return PreparedCodexChild(
            GenerationCommandDraft(
                request_id=request.generation_id,
                spec=request.spec,
                intent=request.intent,
            )
        )

    async def arm_child(self, child: BackendChildDispatch) -> None:
        pass

    async def complete_child(self, completion: BackendChildCompletion) -> BackendChildCompletion:
        self.completed.append(completion)
        return completion

    async def open_successor(self, identity: ProviderContinuationIdentity) -> bytes:
        raise AssertionError("Codex inference has no API successor")

    async def observe(self, event: BackendEvent) -> None:
        self.events.append(event)


class _LateCodex:
    async def stream(
        self,
        draft: GenerationCommandDraft,
        *,
        bind_admission: CodexAdmissionBinder,
    ) -> AsyncGenerator[GenerationFrame]:
        await bind_admission(
            GenerationAdmission(
                request_id=draft.request_id,
                admission_id=uuid4(),
                admitted_at="2026-08-31T12:00:00.000000Z",
                runtime_deadline_seconds=60,
            )
        )
        yield GenerationFrame(
            request_id=draft.request_id,
            sequence=0,
            event=GenerationTerminal(
                status="cancelled",
                failure=None,
                final_text="",
                structured_output=None,
                session_ref=None,
                usage=None,
                diagnostics=("cancelled before completion",),
                accepted_at="2026-08-31T12:00:00.000000Z",
                sdk_version="proof",
                runtime_version="proof",
            ),
        )
        yield GenerationFrame(
            request_id=draft.request_id,
            sequence=1,
            event=GenerationNative(native_type="unexpected.after.terminal"),
        )

    async def cancel(self, request_id: UUID) -> None:
        raise AssertionError("this proof does not request cancellation")
