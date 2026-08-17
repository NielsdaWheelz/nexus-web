"""Bounded non-content canary for existing-VPS Codex qualification."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from uuid import UUID

from apps.codex_agent.auth_environment import reject_api_key_auth
from pydantic import ValidationError

from nexus.services.metadata_enrichment import MetadataEnrichmentOutput
from nexus.services.native_agent_client import (
    CodexAgentClient,
    NativeAgentCapacityUnavailable,
    NativeAgentClientError,
    NativeAgentProtocolDefect,
)
from nexus.services.native_agent_operations import build_metadata_enrichment_command

_SCHEMA_VERSION = "nexus-codex-capacity-canary.v1"
_SYNTHETIC_INPUT = (
    "Known media metadata: title Dune; author Frank Herbert; published 1965; language en."
)
_TURNS = (
    ("cold", UUID("e0df73cc-14ed-5439-9b35-6ec04bf15d3b")),
    ("warm_1", UUID("3e693b2f-cfd7-5ef4-9744-d8aa3bd1bf71")),
    ("warm_2", UUID("370d2711-1f73-5fc3-9fc0-cd18ade98316")),
)
_PROVIDER_BLOCKED_FAILURES = frozenset(
    {"quota_exhausted", "credential_unavailable", "credential_rejected"}
)
_EXIT_CODES = {"passed": 0, "not_run": 20, "provider_blocked": 21, "failed": 1}


async def check(socket_path: Path) -> tuple[dict[str, object], int]:
    """Run the fixed three-turn canary and return only bounded non-content facts."""

    turns: list[dict[str, object]] = []
    client = CodexAgentClient(socket_path)
    status = "passed"
    for phase, request_id in _TURNS:
        command = build_metadata_enrichment_command(
            request_id=request_id,
            input=_SYNTHETIC_INPUT,
        )
        try:
            observation = await client.observe_turn(command)
        except NativeAgentCapacityUnavailable:
            status = "not_run"
            break
        except (NativeAgentClientError, NativeAgentProtocolDefect):
            status = "failed"
            break
        terminal = observation.terminal
        failure_kind = terminal.failure.kind if terminal.failure is not None else None
        structured_output_valid = False
        if terminal.status == "succeeded":
            try:
                MetadataEnrichmentOutput.model_validate(terminal.structured_output)
            except ValidationError:
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
    return result, _EXIT_CODES[status]


def run() -> int:
    reject_api_key_auth()
    socket_path = _required_socket_path()
    result, exit_code = asyncio.run(check(socket_path))
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return exit_code


def _required_socket_path() -> Path:
    raw = os.environ.get("NEXUS_CODEX_AGENT_SOCKET")
    if raw is None or not raw:
        raise RuntimeError("NEXUS_CODEX_AGENT_SOCKET is required")
    path = Path(raw)
    if not path.is_absolute() or os.path.normpath(raw) != raw:
        raise RuntimeError("NEXUS_CODEX_AGENT_SOCKET must be a normalized absolute path")
    return path


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
