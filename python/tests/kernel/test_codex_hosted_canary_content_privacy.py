"""Rendered-output privacy contract for the hosted Codex subscription canary."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("case", "safe_message", "body"),
    (
        (
            "terminal_diagnostics",
            "Codex terminal was not successful",
            """
            class FakeRuntime:
                def __init__(self, _config):
                    pass

                async def open_session(self, _session):
                    return object()

                async def stream_turn(self, _session, _turn):
                    yield AgentTerminal(
                        status="failed",
                        failure=AgentFailure("backend_failed"),
                        final_text="",
                        session_ref=_session_ref(),
                        diagnostics=(SENTINEL,),
                    )

                async def close(self):
                    pass


            def test_sentinel_provider_diagnostics_are_not_rendered(tmp_path, monkeypatch):
                state_root = tmp_path / "state"
                working_directory = tmp_path / "cwd"
                state_root.mkdir(mode=0o700)
                working_directory.mkdir(mode=0o700)
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_CANARY", "1")
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_PROFILE", "codex-personal")
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_STATE_ROOT", str(state_root))
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_WORKING_DIRECTORY", str(working_directory))
                monkeypatch.setattr(canary, "AgentRuntime", FakeRuntime)
                canary.test_codex_personal_metadata_canary_uses_one_structured_subscription_turn()
            """,
        ),
        (
            "structured_output",
            "Codex terminal structured metadata did not satisfy the contract",
            """
            class FakeRuntime:
                def __init__(self, _config):
                    pass

                async def open_session(self, _session):
                    return object()

                async def stream_turn(self, _session, _turn):
                    yield AgentTerminal(
                        status="succeeded",
                        failure=None,
                        final_text="",
                        session_ref=_session_ref(),
                        structured_output=FrozenJsonDict({"title": SENTINEL}),
                    )

                async def close(self):
                    pass


            def test_sentinel_structured_output_is_not_rendered(tmp_path, monkeypatch):
                state_root = tmp_path / "state"
                working_directory = tmp_path / "cwd"
                state_root.mkdir(mode=0o700)
                working_directory.mkdir(mode=0o700)
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_CANARY", "1")
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_PROFILE", "codex-personal")
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_STATE_ROOT", str(state_root))
                monkeypatch.setenv("NEXUS_CODEX_HOSTED_WORKING_DIRECTORY", str(working_directory))
                monkeypatch.setattr(canary, "AgentRuntime", FakeRuntime)
                canary.test_codex_personal_metadata_canary_uses_one_structured_subscription_turn()
            """,
        ),
        (
            "tool_payload",
            "Codex emitted a prohibited tool or permission event",
            """
            class FakeRuntime:
                def __init__(self, _config):
                    pass

                async def open_session(self, _session):
                    return object()

                async def stream_turn(self, _session, _turn):
                    yield AgentToolUse(
                        tool_call_id="call",
                        name="untrusted-tool",
                        phase="started",
                        payload=FrozenJsonDict({"payload": SENTINEL}),
                    )
                    yield AgentTerminal(
                        status="succeeded",
                        failure=None,
                        final_text="",
                        session_ref=_session_ref(),
                    )

                async def close(self):
                    pass


            def test_sentinel_tool_payload_is_not_rendered(monkeypatch):
                monkeypatch.setattr(canary, "AgentRuntime", FakeRuntime)
                operation = type("Operation", (), {"session": object(), "turn": object()})()
                asyncio.run(canary._run_once(Path("/tmp"), operation))
            """,
        ),
    ),
)
def test_hosted_canary_rendered_failure_drops_provider_sentinels(
    tmp_path: Path,
    case: str,
    safe_message: str,
    body: str,
) -> None:
    """Risk: hosted pytest output echoes diagnostics, JSON, or tool payloads."""

    sentinel = f"provider-content-sentinel-{case}-6f7ce8d2"
    proof = tmp_path / f"{case}.py"
    proof.write_text(
        _generated_failure_case(sentinel=sentinel, body=body),
        encoding="utf-8",
    )
    python_root = Path(__file__).parents[2]
    result = subprocess.run(
        (sys.executable, "-m", "pytest", "-q", "--tb=short", str(proof)),
        cwd=python_root,
        env={**os.environ, "PYTHONPATH": str(python_root)},
        check=False,
        capture_output=True,
        text=True,
    )
    rendered = result.stdout + result.stderr
    if result.returncode != pytest.ExitCode.TESTS_FAILED:
        raise AssertionError("sentinel failure harness did not produce one failed pytest case")
    if safe_message not in rendered:
        raise AssertionError("hosted canary did not render its fixed safe failure message")
    if sentinel in rendered:
        raise AssertionError("hosted canary rendered provider-owned sentinel content")


def _generated_failure_case(*, sentinel: str, body: str) -> str:
    header = textwrap.dedent(
        f"""\
        import asyncio
        import importlib
        from pathlib import Path

        from provider_runtime.agent_runtime import AgentFailure, AgentSessionRef, AgentTerminal, AgentToolUse
        from provider_runtime.agent_runtime.types import FrozenJsonDict

        canary = importlib.import_module("tests.hosted.nightly.test_codex_personal_metadata")
        SENTINEL = {sentinel!r}


        def _session_ref():
            return AgentSessionRef(
                schema_version="agent-session-ref.v1",
                backend="codex",
                transport="sdk",
                native_session_id="session",
                profile_key="codex-personal",
                state_root_fingerprint="a" * 64,
                cwd_fingerprint="b" * 64,
            )


        """
    )
    return header + textwrap.dedent(body)
