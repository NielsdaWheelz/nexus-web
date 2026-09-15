"""Bounded non-content canary using one caller-frozen production command spec."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.path_environment import required_absolute_path
from pydantic import BaseModel, ConfigDict, ValidationError

from nexus.schemas.presence import Absent
from nexus.services.codex_generation_client import (
    CodexGenerationCapacityUnavailable,
    CodexGenerationClient,
    CodexGenerationProtocolDefect,
    CodexGenerationRequestRejected,
    CodexGenerationTransportAmbiguous,
    CodexGenerationUnavailable,
)
from nexus.services.codex_generation_contract import (
    GenerationAdmission,
    GenerationCommand,
    GenerationCommandDraft,
    GenerationPermissionRequest,
    GenerationTerminal,
    GenerationToolUse,
    generation_command_from_draft,
)
from nexus.services.generation_intent import GenerationIntent, TextOutput
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.generation_spec import (
    GenerationSpecWire,
    ImmutablePromptPayloadRef,
    TextOutputSnapshot,
    generation_fact_digest,
)

if TYPE_CHECKING:
    from nexus.config import Settings

_SCHEMA_VERSION = "nexus-codex-capacity-canary.v4"
_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"
_INPUT_FILE_ENV = "NEXUS_CODEX_CAPACITY_GENERATION_SPEC_FILE"
_MAX_INPUT_FILE_BYTES = 2 * 1024 * 1024
CANARY_INSTRUCTIONS = "Write one short morning brief sentence for a capacity qualification."
CANARY_INPUT = "No personal context is supplied. Return bounded non-empty text."
CANARY_PROMPT_TEMPLATE_REVISION = "codex-capacity-canary.dawn-write.v1"
# The phase sequence and exit-code table are public controller contracts.
TURNS = (
    ("cold", UUID("e0df73cc-14ed-5439-9b35-6ec04bf15d3b")),
    ("warm_1", UUID("3e693b2f-cfd7-5ef4-9744-d8aa3bd1bf71")),
    ("warm_2", UUID("370d2711-1f73-5fc3-9fc0-cd18ade98316")),
)
_SUBSCRIPTION_BLOCKED_FAILURES = frozenset(
    {"quota_exhausted", "credential_unavailable", "credential_rejected"}
)
EXIT_CODES = {
    "passed": 0,
    "not_run": 20,
    "subscription_blocked": 21,
    "failed": 22,
    "transport_retriable": 23,
}


class CapacityCanaryInput(BaseModel):
    """Controller-owned semantic admission plus the exact referenced prompt bytes."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal["nexus-codex-capacity-canary-input.v1"]
    spec: GenerationSpecWire
    intent: GenerationIntent

    def validated_draft(self, request_id: UUID) -> GenerationCommandDraft:
        spec = self.spec
        if spec.operation != "dawn_write" or spec.selection_source != "BackgroundPolicy":
            raise ValueError("capacity canary requires the dawn_write background operation")
        if not isinstance(spec.selection, CodexPersonalSelection):
            raise ValueError("capacity canary requires Codex Personal selection")
        if not isinstance(spec.output_contract, TextOutputSnapshot) or not isinstance(
            self.intent.output, TextOutput
        ):
            raise ValueError("capacity canary requires Text output")
        if not isinstance(spec.model_tool_plan_snapshot, Absent):
            raise ValueError("capacity canary requires NoModelTools")
        if not isinstance(spec.host_tool_plan_snapshot, Absent):
            raise ValueError("capacity canary requires NoHostTools")
        # GenerationCommandDraft re-proves the prompt payload, instruction/input
        # digests, output contract, bounds, route, and grant absence.
        return GenerationCommandDraft(request_id=request_id, spec=spec, intent=self.intent)


def _bind_tool_free_draft(
    draft: GenerationCommandDraft,
) -> Callable[[GenerationAdmission], Awaitable[GenerationCommand]]:
    async def bind_admission(_admission: GenerationAdmission) -> GenerationCommand:
        return generation_command_from_draft(draft, tool_grant=None)

    return bind_admission


async def check(
    socket_path: Path,
    canary_input: CapacityCanaryInput,
) -> tuple[dict[str, object], int]:
    """Run the fixed three-turn canary and return only bounded non-content facts."""

    turns: list[dict[str, object]] = []
    client = CodexGenerationClient(socket_path)
    status = "passed"
    for phase, request_id in TURNS:
        draft = canary_input.validated_draft(request_id)
        terminal: GenerationTerminal | None = None
        tool_event_count = 0
        permission_event_count = 0

        try:
            async for frame in client.stream(
                draft,
                bind_admission=_bind_tool_free_draft(draft),
            ):
                if isinstance(frame.event, GenerationToolUse):
                    tool_event_count += 1
                elif isinstance(frame.event, GenerationPermissionRequest):
                    permission_event_count += 1
                elif isinstance(frame.event, GenerationTerminal):
                    terminal = frame.event
        except CodexGenerationCapacityUnavailable:
            status = "not_run"
            break
        except (CodexGenerationUnavailable, CodexGenerationTransportAmbiguous):
            status = "transport_retriable"
            break
        except (CodexGenerationRequestRejected, CodexGenerationProtocolDefect):
            status = "failed"
            break
        if terminal is None:
            raise AssertionError("Codex generation stream returned without a terminal")
        failure_kind = terminal.failure.kind if terminal.failure is not None else None
        selection = draft.spec.selection
        if not isinstance(selection, CodexPersonalSelection):
            raise AssertionError("validated capacity command lost its Codex selection")
        turns.append(
            {
                "phase": phase,
                "operation": draft.spec.operation,
                "generation_spec_fingerprint": draft.spec.fingerprint,
                "model": selection.model,
                "reasoning": selection.reasoning,
                "terminal_status": terminal.status,
                "failure_kind": failure_kind,
                "usage_present": terminal.usage is not None,
                "sdk_version": terminal.sdk_version,
                "runtime_version": terminal.runtime_version,
                "tool_event_count": tool_event_count,
                "permission_event_count": permission_event_count,
            }
        )
        if failure_kind in _SUBSCRIPTION_BLOCKED_FAILURES:
            status = "subscription_blocked"
            break
        if (
            terminal.status != "succeeded"
            or terminal.usage is None
            or not terminal.final_text.strip()
            or terminal.structured_output is not None
            or tool_event_count != 0
            or permission_event_count != 0
        ):
            status = "failed"
            break
    result: dict[str, object] = {
        "schema_version": _SCHEMA_VERSION,
        "status": status,
        "turns": turns,
    }
    return result, EXIT_CODES[status]


def load_canary_input(path: Path) -> CapacityCanaryInput:
    """Read one owner-controlled, regular, non-symlink frozen input file."""

    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise RuntimeError("capacity canary input must be a resolved absolute path")
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or metadata.st_size <= 0
        or metadata.st_size > _MAX_INPUT_FILE_BYTES
    ):
        raise RuntimeError("capacity canary input is not a bounded owner-controlled file")
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise RuntimeError("capacity canary input changed before it was opened")
        chunks: list[bytes] = []
        observed = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, _MAX_INPUT_FILE_BYTES + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > _MAX_INPUT_FILE_BYTES:
                raise RuntimeError("capacity canary input exceeds its byte bound")
        payload = b"".join(chunks)
        settled = os.fstat(descriptor)
        if len(payload) != metadata.st_size or (
            settled.st_dev,
            settled.st_ino,
            settled.st_size,
        ) != (metadata.st_dev, metadata.st_ino, metadata.st_size):
            raise RuntimeError("capacity canary input changed while it was read")
    finally:
        os.close(descriptor)
    try:
        value = CapacityCanaryInput.model_validate_json(payload)
    except ValidationError as error:
        raise RuntimeError("capacity canary input is invalid") from error
    if _canonical_input_bytes(value) != payload:
        raise RuntimeError("capacity canary input is not canonical JSON")
    return value


async def materialize_capacity_input(settings: Settings) -> CapacityCanaryInput:
    """Freeze the production Dawn selection for controller-owned qualification input."""

    from nexus.services.generation_catalog import build_generation_catalog_service
    from nexus.services.generation_policy import GENERATION_POLICY

    intent = GenerationIntent(
        instructions=CANARY_INSTRUCTIONS,
        input=CANARY_INPUT,
        output=TextOutput(),
    )
    catalog = build_generation_catalog_service(settings)
    await catalog.startup()

    from nexus.services.generation_service import GenerationService
    from nexus.services.tool_runtime.composition import compose_product_tool_runtime

    service = GenerationService(
        catalog=catalog,
        policy=GENERATION_POLICY,
        tools=compose_product_tool_runtime(None),
    )
    spec = await service.freeze_background(
        operation="dawn_write",
        intent=intent,
        prompt_template_revision=CANARY_PROMPT_TEMPLATE_REVISION,
        prompt_payload_ref=ImmutablePromptPayloadRef(
            owner_kind="CodexCapacityCanary",
            owner_id="production-capacity",
            revision="dawn-write.v1",
            payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
        ),
    )
    return CapacityCanaryInput(
        schema_version="nexus-codex-capacity-canary-input.v1",
        spec=spec,
        intent=intent,
    )


def _canonical_input_bytes(value: CapacityCanaryInput) -> bytes:
    return (
        json.dumps(
            value.model_dump(mode="json", by_alias=True),
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def run(argv: tuple[str, ...] | None = None) -> int:
    arguments = tuple(sys.argv[1:]) if argv is None else argv
    if arguments == ("materialize-input",):
        from nexus.config import get_settings

        value = asyncio.run(materialize_capacity_input(get_settings()))
        sys.stdout.buffer.write(_canonical_input_bytes(value))
        return 0
    if arguments:
        raise RuntimeError("capacity canary accepts only the materialize-input subcommand")
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    result, exit_code = asyncio.run(
        check(
            required_absolute_path(_SOCKET_ENV),
            load_canary_input(required_absolute_path(_INPUT_FILE_ENV)),
        )
    )
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return exit_code


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()


__all__ = [
    "CANARY_INPUT",
    "CANARY_INSTRUCTIONS",
    "CANARY_PROMPT_TEMPLATE_REVISION",
    "EXIT_CODES",
    "TURNS",
    "CapacityCanaryInput",
    "check",
    "load_canary_input",
    "main",
    "materialize_capacity_input",
    "run",
]
