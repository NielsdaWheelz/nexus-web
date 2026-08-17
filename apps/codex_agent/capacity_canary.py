"""Bounded non-content canary for existing-VPS Codex qualification."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from uuid import UUID

from apps.codex_agent.auth_environment import reject_api_key_auth
from apps.codex_agent.path_environment import required_absolute_path
from pydantic import ValidationError

from nexus.services.metadata_enrichment import MetadataEnrichmentOutput
from nexus.services.native_agent_client import (
    CodexAgentClient,
    NativeAgentCapacityUnavailable,
    NativeAgentProtocolDefect,
    NativeAgentRequestRejected,
    NativeAgentTransportAmbiguous,
    NativeAgentUnavailable,
)
from nexus.services.native_agent_operations import build_metadata_enrichment_command

_SCHEMA_VERSION = "nexus-codex-capacity-canary.v1"
_SOCKET_ENV = "NEXUS_CODEX_AGENT_SOCKET"
_SYNTHETIC_INPUT = (
    "Known media metadata: title Dune; author Frank Herbert; published 1965; language en."
)
# The phase sequence and exit-code table are the canary's public contract: the
# release controller ships without this package and mirrors both, bound by a
# conformance proof, so neither side may be changed alone.
TURNS = (
    ("cold", UUID("e0df73cc-14ed-5439-9b35-6ec04bf15d3b")),
    ("warm_1", UUID("3e693b2f-cfd7-5ef4-9744-d8aa3bd1bf71")),
    ("warm_2", UUID("370d2711-1f73-5fc3-9fc0-cd18ade98316")),
)
_PROVIDER_BLOCKED_FAILURES = frozenset(
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
    "provider_blocked": 21,
    "failed": 22,
    "transport_retriable": 23,
}


async def check(socket_path: Path) -> tuple[dict[str, object], int]:
    """Run the fixed three-turn canary and return only bounded non-content facts."""

    turns: list[dict[str, object]] = []
    client = CodexAgentClient(socket_path)
    status = "passed"
    for phase, request_id in TURNS:
        command = build_metadata_enrichment_command(
            request_id=request_id,
            input=_SYNTHETIC_INPUT,
        )
        try:
            observation = await client.observe_turn(command)
        except NativeAgentCapacityUnavailable:
            status = "not_run"
            break
        except (NativeAgentUnavailable, NativeAgentTransportAmbiguous):
            # Neither side of the acceptance boundary proves a capacity
            # breach: a pre-accept loss dispatched nothing, while a
            # post-accept loss has an uncertain turn but no authored terminal.
            # The release owner must keep both retriable and evidence-free.
            status = "transport_retriable"
            break
        except (NativeAgentRequestRejected, NativeAgentProtocolDefect):
            # A rejected fixed command or a broken private wire contract is a
            # defect in the candidate being qualified, not host transience.
            status = "failed"
            break
        terminal = observation.terminal
        failure_kind = terminal.failure.kind if terminal.failure is not None else None
        structured_output_valid = False
        if terminal.status == "succeeded":
            try:
                MetadataEnrichmentOutput.model_validate(terminal.structured_output)
            except ValidationError:
                # justify-ignore-error: the canary reports only whether the turn produced a
                # schema-valid output; the rejection detail is model content it may not read.
                pass
            else:
                structured_output_valid = True
        turns.append(
            {
                "phase": phase,
                "terminal_status": terminal.status,
                "failure_kind": failure_kind,
                "usage_present": terminal.usage is not None,
                "sdk_version": terminal.sdk_version,
                "runtime_version": terminal.runtime_version,
                "tool_event_count": observation.tool_event_count,
                "permission_event_count": observation.permission_event_count,
            }
        )
        if failure_kind in _PROVIDER_BLOCKED_FAILURES:
            status = "provider_blocked"
            break
        if (
            terminal.status != "succeeded"
            or terminal.usage is None
            or not structured_output_valid
            or observation.tool_event_count != 0
            or observation.permission_event_count != 0
        ):
            status = "failed"
            break
    result: dict[str, object] = {
        "schema_version": _SCHEMA_VERSION,
        "status": status,
        "turns": turns,
    }
    return result, EXIT_CODES[status]


def run() -> int:
    reject_api_key_auth()
    result, exit_code = asyncio.run(check(required_absolute_path(_SOCKET_ENV)))
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return exit_code


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
