"""Controlled external Pillow work inside the real foreground child bootstrap."""

import builtins
import os
import signal
import subprocess
import sys
from pathlib import Path

mode = sys.argv.pop(1)

if mode == "parent":
    from nexus.config import ImageDecoderLimits
    from nexus.services.image_decoder import decode_image

    original_popen = subprocess.Popen

    def start_decoder(argv, **kwargs):
        kwargs["stdout"] = 1
        return original_popen(
            [sys.executable, "-B", str(Path(__file__)), "wait", *argv[4:]], **kwargs
        )

    subprocess.Popen = start_decoder
    decode_image(
        b"external Pillow probe",
        ImageDecoderLimits(address_space_bytes=256 * 1024 * 1024, cpu_seconds=5, wall_seconds=10),
    )
else:
    original_import = builtins.__import__

    def import_dependency(name, *args, **kwargs):
        module = original_import(name, *args, **kwargs)
        if name == "PIL" and hasattr(module, "Image"):

            def external_decode(*_args, **_kwargs):
                if mode == "cpu":
                    while True:
                        pass
                elif mode == "wait":
                    os.write(1, str(os.getpid()).encode("ascii"))
                    signal.pause()
                else:
                    raise RuntimeError("unknown decoder probe")

            module.Image.open = external_decode
        return module

    builtins.__import__ = import_dependency
    from nexus.image_decoder_child import main

    main()
