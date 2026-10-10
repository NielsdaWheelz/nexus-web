"""Owner-chat bindings of the shared memory contracts to the private MCP client."""

from __future__ import annotations

from functools import partial
from typing import Any, cast
from uuid import UUID

from llm_tools import (
    Available,
    DeclaredToolFailure,
    ExecutionContext,
    ExecutorConfigurationDefect,
    HandlerSuccess,
    PolicyEpoch,
    ReplayPolicy,
    ToolBinding,
    ToolFamily,
    ToolSpec,
    Unavailable,
)
from llm_tools.schema import strict_decode
from pydantic import BaseModel, JsonValue
from sqlalchemy import select
from sqlalchemy.orm import Session
from universal_memory import MemoryError
from universal_memory.tools import (
    MEMORY_READ_SPECS,
    MEMORY_SAVE_NOTE_SPEC,
    MEMORY_SEARCH_SPEC,
    MemoryToolFailure,
)

from nexus.db.models import ChatRun
from nexus.schemas.presence import Absent, Presence
from nexus.services.memory_client import (
    MemoryClientConfig,
    MemoryToolCall,
    MemoryToolName,
    call_memory_tool,
)
from nexus.services.tool_authority import ToolAuditProjection, ToolPositionRecorder


async def _execute(
    value: BaseModel,
    context: ExecutionContext,
    *,
    spec: ToolSpec[Any, Any, Any],
    config: MemoryClientConfig,
) -> HandlerSuccess[Any]:
    recorder = context.recorder
    if not isinstance(recorder, ToolPositionRecorder):
        # justify-defect: only Nexus's canonical position carries chat authority.
        raise ExecutorConfigurationDefect("memory requires the generation position recorder")
    principal = UUID(str(context.principal))
    authority = recorder.authority
    if (
        principal != recorder.principal_id
        or authority.spec.operation != "chat"
        or authority.owner.kind != "chat_run"
        or not config.allows(
            principal, authority.spec.display_at_dispatch.processor_chain.processors
        )
        or (spec is MEMORY_SAVE_NOTE_SPEC and not config.admit)
    ):
        raise DeclaredToolFailure(MemoryToolFailure(code="forbidden"), actual_attempts=0)

    def authorize(db: Session) -> UUID:
        with db.begin():
            authority.lock_in_current_transaction(db)
            conversation = db.scalar(
                select(ChatRun.conversation_id).where(
                    ChatRun.id == authority.owner.id,
                    ChatRun.owner_user_id == principal,
                )
            )
            if conversation is None:
                # justify-defect: current chat authority must identify its original chat.
                raise ExecutorConfigurationDefect("memory chat association is absent")
            return conversation

    conversation_id = await recorder.database.run_sync(authorize)
    arguments: dict[str, JsonValue] = value.model_dump(mode="json")
    if spec is MEMORY_SAVE_NOTE_SPEC:
        if str(context.effect_id) != str(recorder.position_record.id):
            # justify-defect: the executor supplies the canonical effect position.
            raise ExecutorConfigurationDefect("memory save effect identity changed")
        arguments.update(
            submission_id=str(recorder.position_record.id),
            native_conversation_id=str(conversation_id),
        )
    attempts = 1 if spec is MEMORY_SEARCH_SPEC else 0
    try:
        result = await call_memory_tool(
            MemoryToolCall(
                config=config,
                name=cast(MemoryToolName, str(spec.id).replace(".", "_")),
                arguments=arguments,
            )
        )
    except MemoryError as error:
        raise DeclaredToolFailure(
            MemoryToolFailure.model_validate({"code": error.code}),
            # Unavailable does not reveal whether the server entered embedding.
            actual_attempts=int(spec is MEMORY_SEARCH_SPEC and error.code == "unavailable"),
        ) from None
    success = strict_decode(spec.success_type, spec.success_schema, result)
    recorder.stage_audit(ToolAuditProjection(scope="shared_memory"))
    return HandlerSuccess(success, actual_attempts=attempts)


def memory_family(config: Presence[MemoryClientConfig]) -> ToolFamily:
    specs = (*MEMORY_READ_SPECS, MEMORY_SAVE_NOTE_SPEC)
    bindings: list[ToolBinding[Any, Any, Any]] = []
    for spec in specs:
        if isinstance(config, Absent):
            execute = Unavailable("shared memory is not configured")
            policy: dict[str, object] = {}
        else:
            value = config.value
            execute = (
                Available(partial(_execute, spec=spec, config=value))
                if value.connect and (spec is not MEMORY_SAVE_NOTE_SPEC or value.admit)
                else Unavailable("shared memory is not connected or admitted")
            )
            policy = {
                **value.model_dump(mode="json", exclude={"bearer"}),
                "search_attempt_accounting": "success-or-unknown-entry-conservative-one",
            }
        bindings.append(
            ToolBinding(
                spec=spec,
                execute=execute,
                replay_policy=ReplayPolicy.BilledOnce
                if spec is MEMORY_SEARCH_SPEC
                else ReplayPolicy.ReDispatchable,
                implementation_revision="nexus-shared-memory-v1",
                policy_epoch=PolicyEpoch("nexus-shared-memory-v1"),
                policy_inputs=policy,
            )
        )
    return ToolFamily("memory", specs, tuple(bindings))
