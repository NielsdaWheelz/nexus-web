"""Actual pytest failure reporting through the controller's bounded child capture."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from nexus_test_control.model import Capability, RunStatus
from nexus_test_control.runner import (
    _classified_exact_result,
    _run_fixed_commands,
    _run_owned_commands,
)


@pytest.mark.parametrize(
    ("command_owner", "phase", "body", "fixture", "exception_type", "behavioral"),
    (
        (
            "fixed",
            "call",
            '    assert 1 == 2, "owned primary invariant local-secret-canary"\n',
            "",
            "builtins.AssertionError",
            True,
        ),
        (
            "owned",
            "call",
            '    assert 1 == 2, "owned primary invariant local-secret-canary"\n',
            "",
            "builtins.AssertionError",
            True,
        ),
        (
            "owned",
            "call",
            '    pytest.fail("owned primary invariant local-secret-canary")\n',
            "",
            "builtins.Failed",
            True,
        ),
        (
            "owned",
            "setup",
            "    pass\n",
            "@pytest.fixture(autouse=True)\ndef boundary():\n"
            '    assert 1 == 2, "owned primary invariant local-secret-canary"\n',
            "builtins.AssertionError",
            False,
        ),
        (
            "owned",
            "teardown",
            "    pass\n",
            "@pytest.fixture(autouse=True)\ndef boundary():\n    yield\n"
            '    assert 1 == 2, "owned primary invariant local-secret-canary"\n',
            "builtins.AssertionError",
            False,
        ),
        (
            "owned",
            "call",
            '    raise RuntimeError("AssertionError: owned primary invariant local-secret-canary")\n',
            "",
            "builtins.RuntimeError",
            False,
        ),
    ),
)
def test_service_failure_keeps_actual_pytest_phase_type_message_and_frame(
    tmp_path: Path,
    command_owner: str,
    phase: str,
    body: str,
    fixture: str,
    exception_type: str,
    behavioral: bool,
) -> None:
    (tmp_path / "conftest.py").write_text(
        'import pytest\npytest_plugins = ("nexus_test_control.pytest_report",)\n'
        + fixture
        + "\ndef pytest_terminal_summary(terminalreporter):\n"
        '    terminalreporter.write_line("unrelated-tail-" * 20000)\n'
        '    terminalreporter.write_line("owned noisy child finished")\n'
    )
    source = tmp_path / "test_owned.py"
    source.write_text("import pytest\ndef test_owned():\n" + body)
    run_id = "0123456789abcdef"
    result_directory = tmp_path / "test-results/runs" / run_id
    result_directory.mkdir(parents=True)
    environment = {
        **os.environ,
        "NEXUS_ENV": "test",
        "PYTHONPATH": str(Path(__file__).parents[3]),
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(result_directory),
        "API_TOKEN": "local-secret-canary",
    }
    commands = (((sys.executable, "-m", "pytest", "-q", str(source)), tmp_path),)
    if command_owner == "owned":
        result = _run_owned_commands(Capability.SERVICE, commands, environment, (), context=None)
    else:
        result = _run_fixed_commands(
            Capability.KERNEL_PYTHON,
            commands,
            environment,
            (),
            context=None,
            pythonpath=Path(__file__).parents[3],
        )
    assert result.evidence.status is RunStatus.FAIL
    proof_id = "pytest:python/tests/service/test_owned.py::test_owned"
    classified = _classified_exact_result(result, proof_id)
    expected_kind = "behavioral_assertion_failure" if behavioral else "setup_or_execution_failure"
    assert classified.detail.startswith(f"proof_result={expected_kind}|proof_id={proof_id}|"), (
        "pytest failure lost its actual exception/phase classification after bounded capture: "
        + classified.detail
    )
    assert "local-secret-canary" not in classified.detail
    assert "owned primary invariant" in classified.detail, (
        "bounded service log lost the primary pytest assertion"
    )
    reports = [
        tmp_path / path for path in result.evidence.artifacts if path.endswith(".pytest.json")
    ]
    assert len(reports) == 1, "bounded service receipt omitted the actual pytest failure record"
    payload = json.loads(reports[0].read_text())
    assert len(payload["failures"]) == 1
    failure = payload["failures"][0]
    assert failure["phase"] == phase
    assert failure["exception_type"] == exception_type
    assert "owned primary invariant [REDACTED]" in failure["message"]
    assert failure["node"] == "test_owned.py::test_owned"
    assert Path(failure["frame"]).name == ("test_owned.py" if phase == "call" else "conftest.py")
    assert failure["line"] == (3 if phase == "call" else 5 if phase == "setup" else 6)
    assert failure["truncated"] is False
    log = next(tmp_path / path for path in result.evidence.artifacts if path.endswith(".log"))
    assert len(log.read_bytes()) < 67000, "primary evidence widened the 64 KiB child stdout bound"
    assert "owned noisy child finished" in log.read_text()
    assert "local-secret-canary" not in log.read_text() + reports[0].read_text()


@pytest.mark.parametrize("record_state", ("missing", "malformed", "truncated"))
def test_incomplete_pytest_evidence_cannot_be_a_behavioral_sensitivity_red(
    tmp_path: Path, record_state: str
) -> None:
    plugin = (
        'pytest_plugins = ("nexus_test_control.pytest_report",)\n'
        if record_state == "truncated"
        else ""
    )
    marker = '\nNEXUS_PYTEST_FAILURE:{"phase":"call"' if record_state == "malformed" else ""
    (tmp_path / "conftest.py").write_text(
        plugin
        + "def pytest_terminal_summary(terminalreporter):\n"
        + f"    terminalreporter.write_line({marker!r})\n"
        + '    terminalreporter.write_line("unrelated-tail-" * 20000)\n'
    )
    source = tmp_path / "test_owned.py"
    source.write_text(
        "def test_owned():\n"
        + (
            '    assert False, "oversized evidence " + "x" * 10000\n'
            if record_state == "truncated"
            else '    assert False, "AssertionError: real assertion without complete reporting"\n'
        )
    )
    result = _run_fixed_commands(
        Capability.SERVICE,
        (((sys.executable, "-m", "pytest", "-q", str(source)), tmp_path),),
        os.environ,
        (),
        context=None,
        pythonpath=Path(__file__).parents[3],
    )
    classified = _classified_exact_result(
        result, "pytest:python/tests/service/test_owned.py::test_owned"
    )
    assert classified.evidence.status is RunStatus.FAIL
    assert classified.detail.startswith("proof_result=setup_or_execution_failure|"), (
        "incomplete pytest failure evidence was accepted as a behavioral red: " + classified.detail
    )


@pytest.mark.parametrize(
    ("command_owner", "padding"),
    (("owned", 0), ("owned", 2004), ("fixed", 0), ("fixed", 2004)),
)
def test_pytest_records_redact_before_json_encoding_and_field_truncation(
    tmp_path: Path, command_owner: str, padding: int
) -> None:
    secret = 'local-"secret"\\-canary'
    prefix = "owned primary invariant " + "x" * padding
    (tmp_path / "conftest.py").write_text(
        'pytest_plugins = ("nexus_test_control.pytest_report",)\n'
        "def pytest_terminal_summary(terminalreporter):\n"
        '    terminalreporter.write_line("unrelated-tail-" * 20000)\n'
    )
    # The fixed-command environment deliberately withholds API_TOKEN. Its
    # fixture constructs the fake value without printing a quoted source literal.
    value = (
        'os.environ["API_TOKEN"]'
        if command_owner == "owned"
        else f'bytes.fromhex("{secret.encode().hex()}").decode()'
    )
    source = tmp_path / "test_owned.py"
    source.write_text(
        "import os, pytest\ndef test_owned():\n"
        + ('    assert "API_TOKEN" not in os.environ\n' if command_owner == "fixed" else "")
        + f"    pytest.fail({prefix!r} + {value})\n"
    )
    run_id = "0123456789abcdef"
    directory = tmp_path / "test-results/runs" / run_id
    directory.mkdir(parents=True)
    environment = {
        **os.environ,
        "NEXUS_ENV": "test",
        "PYTHONPATH": str(Path(__file__).parents[3]),
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(directory),
        "API_TOKEN": secret,
    }
    commands = (((sys.executable, "-m", "pytest", "-q", str(source)), tmp_path),)
    if command_owner == "owned":
        result = _run_owned_commands(Capability.SERVICE, commands, environment, (), context=None)
    else:
        result = _run_fixed_commands(
            Capability.KERNEL_PYTHON,
            commands,
            environment,
            (),
            context=None,
            pythonpath=Path(__file__).parents[3],
        )
    assert result.evidence.status is RunStatus.FAIL
    truncated = command_owner == "fixed" and padding > 0
    kind = "setup_or_execution_failure" if truncated else "behavioral_assertion_failure"
    assert result.detail.startswith(f"proof_result={kind}|"), result.detail
    reports = [
        tmp_path / path for path in result.evidence.artifacts if path.endswith(".pytest.json")
    ]
    assert len(reports) == 1
    records = json.loads(reports[0].read_text())["failures"]
    assert len(records) == 1
    assert records[0]["phase"] == "call"
    assert records[0]["exception_type"] == "builtins.Failed"
    assert records[0]["truncated"] is truncated
    assert records[0]["message"] == ("[truncated]" if truncated else prefix + "[REDACTED]")
    retained = result.detail + "".join(
        (tmp_path / path).read_text() for path in result.evidence.artifacts
    )
    assert "local-" not in retained, "pytest encoding/truncation exposed a full or partial secret"
    assert secret not in retained
    assert json.dumps(secret, ensure_ascii=False)[1:-1] not in retained


def test_pytest_truncated_summary_cannot_split_a_parent_only_secret_in_the_node(
    tmp_path: Path,
) -> None:
    secret = "local- - secret-canary"
    (tmp_path / "conftest.py").write_text(
        'pytest_plugins = ("nexus_test_control.pytest_report",)\n'
        "def pytest_terminal_summary(terminalreporter):\n"
        '    terminalreporter.write_line("unrelated-tail-" * 20000)\n'
    )
    source = tmp_path / "test_owned.py"
    source.write_text(
        "import os, pytest\n"
        + '@pytest.mark.parametrize("value", (None,), ids=('
        + f'bytes.fromhex("{secret.encode().hex()}").decode(),))\n'
        + "def test_owned(value):\n"
        + '    assert "API_TOKEN" not in os.environ\n'
        + '    pytest.fail("owned primary invariant " + "x" * 120)\n'
    )
    run_id = "0123456789abcdef"
    directory = tmp_path / "test-results/runs" / run_id
    directory.mkdir(parents=True)
    # Exercise the real truncation path even when the enclosing run sets CI.
    commands = (
        ((sys.executable, "-m", "pytest", "-q", "--force-short-summary", str(source)), tmp_path),
    )
    result = _run_fixed_commands(
        Capability.KERNEL_PYTHON,
        commands,
        {
            **os.environ,
            "NEXUS_ENV": "test",
            "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
            "NEXUS_TEST_RESULTS_DIR": str(directory),
            "API_TOKEN": secret,
        },
        (),
        context=None,
        pythonpath=Path(__file__).parents[3],
    )
    assert result.evidence.status is RunStatus.FAIL
    assert result.detail.startswith("proof_result=behavioral_assertion_failure|"), result.detail
    reports = [
        tmp_path / path for path in result.evidence.artifacts if path.endswith(".pytest.json")
    ]
    assert len(reports) == 1
    records = json.loads(reports[0].read_text())["failures"]
    assert len(records) == 1
    assert records[0]["node"] == "test_owned.py::test_owned[[REDACTED]]"
    assert records[0]["phase"] == "call"
    assert records[0]["exception_type"] == "builtins.Failed"
    assert records[0]["message"] == "owned primary invariant " + "x" * 120
    assert records[0]["truncated"] is False
    retained = result.detail + "".join(
        (tmp_path / path).read_text() for path in result.evidence.artifacts
    )
    assert "local-" not in retained, "pytest summary split a parent-only secret inside its node"
    assert secret not in retained
