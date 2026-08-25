import json
from pathlib import Path

from nexus_test_control.model import Capability, RunStatus, Workflow
from nexus_test_control.runner import CapabilityContext, run_capability, run_proof


def test_exact_android_device_proof_uses_one_instrumentation_method(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    run_id = "0123456789abcdef"
    results = tmp_path / "test-results/runs" / run_id
    sdk.mkdir()
    results.mkdir(parents=True)
    proof_path = "apps/android/app/src/androidTest/java/app/nexus/android/NativeAuthHandoffTest.kt"
    _write(
        tmp_path / proof_path,
        "package app.nexus.android\n"
        "class NativeAuthHandoffTest {\n"
        "    fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {}\n"
        "}\n",
    )
    _write_executable(tmp_path / "bin/java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n"
        ),
    )
    diagnostic = (
        "Nexus control gesture diagnostics: webView=151.0.7922.85, "
        "navigationMode=2, secret=hidden-value"
    )
    _write_executable(android_root / "gradlew", stdout=diagnostic)
    environment = {
        "PATH": str(tmp_path / "bin"),
        "HOME": str(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "production-shaped-value",
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(results),
        "API_TOKEN": "hidden-value",
    }
    proof = f"gradle:{proof_path}::nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin"
    result = run_proof(
        CapabilityContext(tmp_path, Workflow.NIGHTLY, ()),
        proof,
        environment,
        _available_memory=lambda: 8192,
    )

    assert result.evidence.status is RunStatus.PASS
    command = _commands(tmp_path)[-1]
    expected_argv = [
        "--no-daemon",
        ":app:connectedDebugAndroidTest",
        "-Pandroid.testInstrumentationRunnerArguments.class="
        "app.nexus.android.NativeAuthHandoffTest#"
        "nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin",
    ]
    assert command["argv"] == expected_argv, (
        "Android device executor lost exact method scoping: "
        f"proof={proof}; expected boundary={expected_argv}; actual argv={command['argv']}"
    )
    assert command["google_client_id"] == "nexus-test.apps.googleusercontent.com"
    assert command["android_serial"] == "R5CT1234"
    assert result.evidence.artifacts == (
        f"test-results/runs/{run_id}/android-device-instrumentation.json",
    )
    retained = json.loads((tmp_path / result.evidence.artifacts[0]).read_text(encoding="utf-8"))
    assert retained == {
        "authorized_adb_row": ("R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1"),
        "bound_serial": "R5CT1234",
        "capability": "android-device",
        "command": {
            "argv": ["./gradlew", *expected_argv],
            "cwd": "apps/android",
        },
        "exit_code": 0,
        "proof_id": proof,
        "scope": "exact",
        "stderr": "",
        "stdout": diagnostic.replace("hidden-value", "[REDACTED]") + "\n",
        "version": 1,
    }


def test_full_android_device_sweep_retains_attested_success_evidence(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    run_id = "fedcba9876543210"
    results = tmp_path / "test-results/runs" / run_id
    sdk.mkdir()
    results.mkdir(parents=True)
    _write(
        android_root / "app/src/androidTest/java/app/nexus/android/NexusControlGestureTest.kt",
        "package app.nexus.android\nclass NexusControlGestureTest\n",
    )
    _write_executable(tmp_path / "bin/java")
    adb_row = "emulator-5554 device product:sdk model:sdk transport_id:1"
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=f"List of devices attached\n{adb_row}\n",
    )
    diagnostic = "NEXUS_CONTROL_GESTURE_DIAGNOSTICS: navigationMode=2"
    oversized_stdout = "~" * 300_000 + diagnostic
    _write_executable(android_root / "gradlew", stdout=oversized_stdout)
    environment = {
        "PATH": str(tmp_path / "bin"),
        "HOME": str(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(results),
        "API_TOKEN": "~",
    }

    result = run_capability(
        CapabilityContext(tmp_path, Workflow.NIGHTLY, ()),
        Capability.ANDROID_DEVICE,
        environment,
    )

    assert result.evidence.status is RunStatus.PASS
    assert result.evidence.artifacts == (
        f"test-results/runs/{run_id}/android-device-instrumentation.json",
    )
    retained = json.loads((tmp_path / result.evidence.artifacts[0]).read_text(encoding="utf-8"))
    assert retained["authorized_adb_row"] == adb_row
    assert retained["bound_serial"] == "emulator-5554"
    assert retained["scope"] == "complete"
    assert retained["proof_id"] is None
    assert retained["command"] == {
        "argv": [
            "./gradlew",
            "--no-daemon",
            ":app:connectedDebugAndroidTest",
            "-Pandroid.testInstrumentationRunnerArguments.notAnnotation="
            "app.nexus.android.offline.reading.SignedPromotion",
        ],
        "cwd": "apps/android",
    }
    assert diagnostic in retained["stdout"]
    assert len(retained["stdout"]) <= 64 * 1024


def test_exact_nexus_control_proof_rejects_missing_success_diagnostics(
    tmp_path: Path,
) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    run_id = "0011223344556677"
    results = tmp_path / "test-results/runs" / run_id
    sdk.mkdir()
    results.mkdir(parents=True)
    proof_path = (
        "apps/android/app/src/androidTest/java/app/nexus/android/NexusControlGestureTest.kt"
    )
    _write(
        tmp_path / proof_path,
        "package app.nexus.android\n"
        "class NexusControlGestureTest {\n"
        "  fun nexusControlReceivesHorizontalTouchFromOuterAndInnerHalves() = Unit\n"
        "}\n",
    )
    _write_executable(tmp_path / "bin/java")
    _write_executable(
        sdk / "platform-tools/adb",
        stdout=(
            "List of devices attached\n"
            "R5CT1234 device usb:1-2 product:nexus model:Pixel transport_id:1\n"
        ),
    )
    _write_executable(android_root / "gradlew", stdout="BUILD SUCCESSFUL")
    environment = {
        "PATH": str(tmp_path / "bin"),
        "HOME": str(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_TEST_EVIDENCE_RUN_ID": run_id,
        "NEXUS_TEST_RESULTS_DIR": str(results),
    }
    proof = f"gradle:{proof_path}::nexusControlReceivesHorizontalTouchFromOuterAndInnerHalves"

    result = run_proof(
        CapabilityContext(tmp_path, Workflow.NIGHTLY, ()),
        proof,
        environment,
    )

    assert result.evidence.status is RunStatus.NOT_RUN
    assert result.evidence.artifacts == ()
    assert result.detail == "successful Nexus-control instrumentation diagnostics were not retained"
    assert not (results / "android-device-instrumentation.json").exists()


def _write_executable(path: Path, *, stdout: str = "") -> None:
    _write(
        path,
        "#!/usr/bin/python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "record = {\n"
        "    'argv': sys.argv[1:],\n"
        "    'google_client_id': os.environ.get('NEXUS_GOOGLE_WEB_CLIENT_ID'),\n"
        "    'android_serial': os.environ.get('ANDROID_SERIAL'),\n"
        "}\n"
        "with (Path(os.environ['HOME']) / 'commands.jsonl').open('a') as handle:\n"
        "    handle.write(json.dumps(record, sort_keys=True) + '\\n')\n"
        f"print({stdout!r})\n",
    )
    path.chmod(0o755)


def _commands(repo_root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in (repo_root / "commands.jsonl").read_text(encoding="utf-8").splitlines()
    ]


def _write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")
