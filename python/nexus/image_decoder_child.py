"""Fixed image-validation child protocol; only stdlib loads before containment."""

import os
import resource
import signal
import struct
import sys

from nexus.process_lifetime import arm_parent_death_signal

# status, display width/height, MIME or defect type, post-exec memory high-water.
RESULT = struct.Struct("!BHH64sQ")
INPUT_MAX_BYTES = 10 * 1024 * 1024


def main() -> None:
    input_fd, output_fd, parent_pid, address_space_bytes, cpu_seconds = map(int, sys.argv[1:])
    arm_parent_death_signal()
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_AS, (address_space_bytes, address_space_bytes))
    signal.signal(signal.SIGXCPU, signal.SIG_DFL)
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds - 1, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (RESULT.size, RESULT.size))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    status, width, height, label = 0, 0, 0, b""
    try:
        # Imports and every decoder allocation occur after the hard limits, so an
        # address space provisioned below the decoder's own import cost fails here,
        # before any untrusted byte is touched.
        # justify-defect: that is our own misprovisioned profile, not a property of
        # the image, so it must not reach the client as a resource limit shared with
        # hostile-image rejection.
        from nexus.errors import ApiError, ApiErrorCode
        from nexus.services.image_validation import validate_and_decode_image
    except Exception as error:
        status, label = 4, b"import:" + type(error).__name__.encode("ascii")[:56]
    else:
        try:
            with os.fdopen(input_fd, "rb") as source:
                data = source.read(INPUT_MAX_BYTES + 1)
            if len(data) > INPUT_MAX_BYTES:
                status = 2
            else:
                try:
                    mime, width, height = validate_and_decode_image(data)
                    label = mime.encode("ascii")
                    if len(label) >= 64:
                        # justify-defect: the MIME map and the result struct are both
                        # ours, so a MIME that cannot cross this boundary is an owned
                        # contract violation, never an invalid image.
                        raise ValueError("image MIME exceeds the owned result contract")
                except ApiError as error:
                    if error.code == ApiErrorCode.E_IMAGE_TOO_LARGE:
                        status = 2
                    elif error.code == ApiErrorCode.E_INVALID_REQUEST:
                        status = 1
                    else:
                        status, label = 4, type(error).__name__.encode("ascii")[:63]
        except MemoryError:
            status = 3
        except Exception as error:
            # justify-defect: decode raises only the modeled image errors above when
            # this executable and its decoder agree, so anything else is an owned
            # failure. No input or arbitrary exception text crosses this fixed-size
            # result boundary.
            status, label = 4, type(error).__name__.encode("ascii")[:63]
    # getrusage preserves the pre-exec parent's footprint. VmHWM belongs to
    # this executable's memory map, so it attributes decoder allocation only.
    with open("/proc/self/status", encoding="ascii") as process_status:
        high_water_bytes = next(
            int(line.split()[1]) * 1024 for line in process_status if line.startswith("VmHWM:")
        )
    result = RESULT.pack(status, width, height, label, high_water_bytes)
    # justify-defect: the result is a fixed-size write to a pipe owned by the
    # parent and sized by RLIMIT_FSIZE, so a short write means the protocol itself
    # is broken and no status can be reported through it.
    if os.write(output_fd, result) != RESULT.size:
        raise RuntimeError("image decoder result was not written completely")


if __name__ == "__main__":
    main()
