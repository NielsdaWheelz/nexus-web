"""Existing supported image bytes cross a real bounded decoder process."""

import base64
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from nexus.config import ImageDecoderLimits
from nexus.errors import ApiError, ApiErrorCode, ResourceLimitError
from nexus.services.image_decoder import decode_image
from tests.testkit.background_worker_supervisor import await_process_exit, read_when_present

FIXTURE = Path(__file__).resolve().parents[3] / "testdata/capacity/artwork.json"
LIMITS = ImageDecoderLimits(address_space_bytes=256 * 1024 * 1024, cpu_seconds=5, wall_seconds=10)
PROBE = Path(__file__).resolve().parents[1] / "testkit/image_decoder_probe.py"


@pytest.mark.parametrize(
    "name", ["rotated-jpeg", "animated-gif", "maximum-dimensions", "maximum-png-metadata"]
)
def test_existing_image_envelope_is_validated_in_the_bounded_child(name: str) -> None:
    source = next(case for case in json.loads(FIXTURE.read_text())["cases"] if case["name"] == name)
    data = base64.b64decode(source["base64"])
    mime, width, height = decode_image(data, LIMITS)
    assert mime == source["type"]
    assert (width, height) == (source["width"], source["height"])


def test_decoder_rejects_invalid_bytes_as_a_source_failure() -> None:
    with pytest.raises(ApiError) as caught:
        decode_image(b"this is not an image", LIMITS)
    assert caught.value.code == ApiErrorCode.E_INVALID_REQUEST


def test_decoder_import_provisioning_failure_is_a_defect_not_a_resource_limit() -> None:
    """An address space too small to import the decoder is our misprovisioning.

    The hard limits are set before any import, so this failure happens before an
    untrusted byte is read. Reporting it as a resource limit would reach the
    client as the same 422 as hostile-image rejection — retried never, reported
    as no defect — hiding a total artwork outage caused by our own profile.
    """
    limits = ImageDecoderLimits(
        address_space_bytes=16 * 1024 * 1024, cpu_seconds=5, wall_seconds=10
    )
    with pytest.raises(RuntimeError) as caught:
        decode_image(b"small source", limits)
    assert not isinstance(caught.value, ApiError), (
        "an unprovisionable decoder import must not be classified as an image failure"
    )
    assert "import:" in str(caught.value), caught.value


@pytest.mark.parametrize("mode,signal_number", [("cpu", signal.SIGXCPU), ("wait", signal.SIGKILL)])
def test_actual_decoder_cpu_and_wall_limits_terminate_before_return(
    monkeypatch: pytest.MonkeyPatch, mode: str, signal_number: int
) -> None:
    original_popen = subprocess.Popen
    processes = []

    def start_decoder(argv, **kwargs):
        process = original_popen([sys.executable, "-B", str(PROBE), mode, *argv[4:]], **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", start_decoder)
    limits = ImageDecoderLimits(
        address_space_bytes=256 * 1024 * 1024, cpu_seconds=2, wall_seconds=5 if mode == "cpu" else 1
    )
    with pytest.raises(ResourceLimitError) as caught:
        decode_image(b"external Pillow probe", limits)
    assert caught.value.dimension == "Time"
    assert len(processes) == 1
    assert processes[0].poll() == -signal_number, (
        "decoder returned before its actual limit-specific termination"
    )


@pytest.mark.parametrize("killed_by", [signal.SIGKILL, signal.SIGSEGV, signal.SIGBUS])
def test_a_child_killed_for_memory_is_the_owned_resource_envelope(
    monkeypatch: pytest.MonkeyPatch, killed_by: signal.Signals
) -> None:
    """A decoder the host kills is a memory limit, not a broken executable.

    The child reports its own RLIMIT_AS MemoryError as a status, but a container
    cgroup OOM kill and an allocation fault under exhaustion write no result at
    all: the parent sees only how the child died. Classifying those as a defect
    would report an oversized image for this deployment as a 500 with no owned
    dimension, on the one foreground route whose byte bounds are qualified.
    """
    original_popen = subprocess.Popen

    def start_killed_decoder(argv: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        return original_popen(
            [sys.executable, "-B", "-c", f"import os, signal; os.kill(os.getpid(), {killed_by})"],
            **kwargs,
        )

    monkeypatch.setattr(subprocess, "Popen", start_killed_decoder)
    with pytest.raises(ResourceLimitError) as caught:
        decode_image(b"external Pillow probe", LIMITS)
    assert caught.value.dimension == "Memory", (
        "a host-killed decoder was classified outside the memory limit it died for"
    )


def test_api_parent_death_terminates_its_actual_decoder(tmp_path: Path) -> None:
    child_pid_path = tmp_path / "decoder.pid"
    child_pid = None
    with child_pid_path.open("wb") as child_pid_file:
        parent = subprocess.Popen(
            [sys.executable, "-B", str(PROBE), "parent"],
            stdout=child_pid_file,
            stderr=subprocess.DEVNULL,
        )
        try:
            child_pid = int(read_when_present(child_pid_path, what="foreground decoder pid"))
            parent.kill()
            parent.wait(timeout=5)
            await_process_exit(child_pid, what="foreground decoder after API parent death")
        finally:
            if parent.poll() is None:
                parent.kill()
            parent.wait(timeout=5)
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
