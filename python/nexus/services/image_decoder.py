"""One bounded Linux foreground image validation; no process pool or byte cache."""

import ctypes
import os
import signal
import subprocess
import sys

from nexus.config import ImageDecoderLimits
from nexus.errors import ApiError, ApiErrorCode, ResourceLimitError
from nexus.image_decoder_child import INPUT_MAX_BYTES, RESULT
from nexus.logging import get_logger
from nexus.services.image_validation import IMAGE_FORMAT_MIME_TYPES, MAX_IMAGE_DIMENSION

logger = get_logger(__name__)


def _anonymous_file(name: bytes):
    # The locked standalone Python omits os.memfd_create; Linux libc exposes
    # the same syscall. No filesystem path or independently retained file exists.
    libc = ctypes.CDLL(None, use_errno=True)
    create = libc.memfd_create
    create.argtypes = [ctypes.c_char_p, ctypes.c_uint]
    create.restype = ctypes.c_int
    descriptor = create(name, 1)  # MFD_CLOEXEC; pass_fds names the only inherited fds.
    if descriptor < 0:
        raise OSError(ctypes.get_errno(), "image decoder anonymous file could not be created")
    return os.fdopen(descriptor, "w+b")


def decode_image(data: bytes, limits: ImageDecoderLimits) -> tuple[str, int, int]:
    if sys.platform != "linux":
        raise RuntimeError("foreground image containment requires Linux")
    if len(data) > INPUT_MAX_BYTES:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds encoded byte limit")
    # Anonymous descriptors work in the read-only API container. Their bytes
    # remain charged to its cgroup and are released before this call returns.
    with (
        _anonymous_file(b"nexus-image-input") as source,
        _anonymous_file(b"nexus-image-result") as result,
    ):
        source.write(data)
        source.seek(0)
        process = subprocess.Popen(
            [
                sys.executable,
                "-B",
                "-m",
                "nexus.image_decoder_child",
                str(source.fileno()),
                str(result.fileno()),
                str(os.getpid()),
                str(limits.address_space_bytes),
                str(limits.cpu_seconds),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(source.fileno(), result.fileno()),
        )
        try:
            try:
                process.wait(timeout=limits.wall_seconds)
            except subprocess.TimeoutExpired as error:
                raise ResourceLimitError(
                    "Image validation exceeded its time limit", dimension="Time"
                ) from error
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        if process.returncode == -signal.SIGXCPU:
            raise ResourceLimitError(
                "Image validation reached its execution limit", dimension="Time"
            )
        if process.returncode in (-signal.SIGKILL, -signal.SIGSEGV, -signal.SIGBUS):
            # The child bounds its own address space and reports MemoryError as
            # status 3. These deaths are the host deciding instead: the API
            # container's cgroup OOM killer sends SIGKILL, and an allocation that
            # faults while memory is already exhausted surfaces as SIGSEGV or
            # SIGBUS. A killed child writes no result at all, so the parent is the
            # only place this can be classified, and the dimension is the one the
            # admission contract owns.
            raise ResourceLimitError(
                "Image validation exhausted its memory limit", dimension="Memory"
            )
        if process.returncode != 0:
            # justify-defect: every image outcome, hostile bytes included, is a
            # status this child writes and exits 0 for, and the signalled deaths
            # above carry every bounded-resource termination. Any other exit means
            # the executable or its provisioning is broken, not that the image was
            # bad.
            raise RuntimeError(f"image decoder exited unexpectedly: {process.returncode}")
        result.seek(0)
        encoded = result.read(RESULT.size + 1)
        if len(encoded) != RESULT.size:
            # justify-defect: RESULT is a fixed-size struct both sides compile
            # against, so a differently sized result is a protocol mismatch
            # between our parent and our child.
            raise RuntimeError("image decoder violated its fixed result contract")
        status, width, height, label, high_water_bytes = RESULT.unpack(encoded)
        logger.info("image_decoder_completed", status=status, high_water_bytes=high_water_bytes)
        if status == 1:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image")
        if status == 2:
            raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits")
        if status == 3:
            raise ResourceLimitError(
                "Image validation exceeded its memory limit", dimension="Memory"
            )
        if status != 0:
            # justify-defect: statuses 1-3 above carry every modeled image and
            # budget outcome, so status 4 is the child reporting an owned failure
            # — a decoder import that could not be provisioned, or an exception
            # the decode contract does not model. It must not be laundered into
            # the resource-limit class the client treats as a rejected image.
            raise RuntimeError(f"image decoder failed: {label.rstrip(b'\x00').decode('ascii')}")
        mime = label.rstrip(b"\x00").decode("ascii")
        if (
            mime not in IMAGE_FORMAT_MIME_TYPES.values()
            or not 0 < width <= MAX_IMAGE_DIMENSION
            or not 0 < height <= MAX_IMAGE_DIMENSION
        ):
            # justify-defect: the MIME map and the dimension ceiling are the same
            # owners the child validated against, so a status-0 result outside
            # them means the two executables disagree.
            raise RuntimeError("image decoder returned invalid validated dimensions or MIME")
        return mime, width, height
