"""Freeze dictionary word boundaries through the worker's existing Node runtime."""

import struct
import subprocess
from collections.abc import Iterator
from tempfile import TemporaryFile

from nexus.services.reader_node import ReaderNodeDefect, reader_node_command


def reader_word_boundaries(canonical_text: str) -> Iterator[int]:
    """Stage original fragment input and uint32 codepoint output, then yield offsets.

    ICU may retain an entire unbroken dictionary span. This is worker preparation
    memory, not a bounded reader request; release qualification must include it.
    The existing background child's process group and wall deadline own this child.
    """
    with TemporaryFile() as output:
        with TemporaryFile() as source:
            for start in range(0, len(canonical_text), 8192):
                source.write(canonical_text[start : start + 8192].encode("utf-8"))
            source.seek(0)
            completed = subprocess.run(
                reader_node_command("word_boundaries"),
                stdin=source,
                stdout=output,
                stderr=subprocess.PIPE,
                env={"LANG": "C.UTF-8", "NODE_ENV": "production"},
            )
        if completed.returncode != 0:
            # justify-defect: this owned child segments every preparation or the
            # worker image is wrong; its stderr is the only diagnosis we get.
            raise ReaderNodeDefect(
                "Reader word boundary segmentation failed: "
                + completed.stderr.decode("utf-8", "replace")[-4096:]
            )
        output.seek(0)
        previous = -1
        while payload := output.read(16 * 1024):
            if len(payload) % 4:
                raise ValueError("Reader word boundary output is incomplete")
            for (point,) in struct.iter_unpack("<I", payload):
                if not previous < point <= len(canonical_text):
                    raise ValueError("Reader word boundaries are not ordered source offsets")
                if previous == -1 and point != 0:
                    raise ValueError("Reader word boundaries omit the source start")
                yield point
                previous = point
        if previous != len(canonical_text):
            raise ValueError("Reader word boundaries omit the source end")
