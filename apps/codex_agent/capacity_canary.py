"""Bounded non-content canary for existing-VPS Codex qualification."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import UUID

from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.path_environment import required_absolute_path

from nexus.services import generation_policy
from nexus.services.codex_generation_client import (
    CodexGenerationCapacityUnavailable,
    CodexGenerationClient,
    CodexGenerationProtocolDefect,
    CodexGenerationRequestRejected,
    CodexGenerationTransportAmbiguous,
    CodexGenerationUnavailable,
)
from nexus.services.codex_generation_contract import (
    DossierLibraryOperation,
    GenerationCommand,
    GenerationPermissionRequest,
    GenerationTerminal,
    GenerationToolUse,
)
from nexus.services.generation_intent import (
    GenerationIntent,
    TextOutput,
)

_SCHEMA_VERSION = "nexus-codex-capacity-canary.v3"
_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"
_SYNTHETIC_INPUT = "Reply with one short sentence. Do not call a tool."
# The phase sequence and exit-code table are the canary's public contract: the
# release controller ships without this package and mirrors both, bound by a
# conformance proof, so neither side may be changed alone.
TURNS = (
    ("cold", UUID("e0df73cc-14ed-5439-9b35-6ec04bf15d3b")),
    ("warm_1", UUID("3e693b2f-cfd7-5ef4-9744-d8aa3bd1bf71")),
    ("warm_2", UUID("370d2711-1f73-5fc3-9fc0-cd18ade98316")),
)
_SUBSCRIPTION_BLOCKED_FAILURES = frozenset(
    {"quota_exhausted", "credential_unavailable", "credential_rejected"}
)
# Every non-zero terminal is numbered outside the codes a dying process can
# produce on its own: an uncaught exception exits 1 and a killed process exits
# 128+signal, so neither can be misread as a stated terminal. A stated terminal
# is always accompanied by this module's evidence line on stdout; a crash is
# not, and the controller classifies by that evidence, not by the code alone.
EXIT_CODES = {
    "passed": 0,
    "not_run": 20,
    "subscription_blocked": 21,
    "failed": 22,
    "transport_retriable": 23,
}


async def check(socket_path: Path) -> tuple[dict[str, object], int]:
    """Run the fixed three-turn canary and return only bounded non-content facts."""

    turns: list[dict[str, object]] = []
    client = CodexGenerationClient(socket_path)
    capacity_policy = generation_policy.operation_policy("dossier_library")
    status = "passed"
    for phase, request_id in TURNS:
        command = _command(request_id)
        terminal: GenerationTerminal | None = None
        tool_event_count = 0
        permission_event_count = 0
        try:
            async for frame in client.stream(command):
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
            # Neither side of the acceptance boundary proves a capacity
            # breach: a pre-accept loss dispatched nothing, while a
            # post-accept loss has an uncertain turn but no authored terminal.
            # The release owner must keep both retriable and evidence-free.
            status = "transport_retriable"
            break
        except (CodexGenerationRequestRejected, CodexGenerationProtocolDefect):
            # A rejected fixed command or a broken private wire contract is a
            # defect in the candidate being qualified, not host transience.
            status = "failed"
            break
        if terminal is None:
            # justify-defect: the v2 client yields exactly one terminal frame or raises.
            raise AssertionError("Codex generation stream returned without a terminal")
        failure_kind = terminal.failure.kind if terminal.failure is not None else None
        turns.append(
            {
                "phase": phase,
                "operation": "dossier_library",
                "plan_id": capacity_policy.plan_id,
                "plan_revision": generation_policy.POLICY_REVISION,
                "capability": capacity_policy.capability,
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


def _command(request_id: UUID) -> GenerationCommand:
    policy = generation_policy.operation_policy("dossier_library")
    return GenerationCommand(
        request_id=request_id,
        operation=DossierLibraryOperation(revision=policy.revision),
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.policy_fingerprint(),
        intent=GenerationIntent(
            instructions=(
                "This is a bounded capacity qualification. Reply briefly and do not use tools."
            ),
            input=_SYNTHETIC_INPUT,
            output=TextOutput(),
        ),
    )


def run() -> int:
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    result, exit_code = asyncio.run(check(required_absolute_path(_SOCKET_ENV)))
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return exit_code


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
