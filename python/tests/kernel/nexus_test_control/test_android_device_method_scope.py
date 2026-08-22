import json
from pathlib import Path

from nexus_test_control.model import RunStatus, Workflow
from nexus_test_control.runner import CapabilityContext, run_proof


def test_exact_android_device_proof_uses_one_instrumentation_method(tmp_path: Path) -> None:
    android_root = tmp_path / "apps/android"
    sdk = tmp_path / "android-sdk"
    sdk.mkdir()
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
    _write_executable(android_root / "gradlew")
    environment = {
        "PATH": str(tmp_path / "bin"),
        "HOME": str(tmp_path),
        "ANDROID_HOME": str(sdk),
        "NEXUS_GOOGLE_WEB_CLIENT_ID": "production-shaped-value",
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
