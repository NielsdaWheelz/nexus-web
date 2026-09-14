"""The existing worker Node runtime owns preparation-only browser semantics."""

import shutil
from pathlib import Path
from typing import Literal


class ReaderNodeDefect(RuntimeError):
    """The reader Node runtime this image must ship is missing or failed."""


def reader_node_command(script: Literal["word_boundaries", "epub_paths"]) -> tuple[str, str]:
    executable = shutil.which("node")
    if executable is None:
        # justify-defect: the worker image and local preparation runtime require Node.
        raise ReaderNodeDefect("Reader preparation Node runtime is unavailable")
    path = Path(__file__).with_name("reader_scripts") / f"{script}.mjs"
    if not path.is_file():
        # justify-defect: these scripts are resources of the installed Python package.
        raise ReaderNodeDefect(f"Reader Node script is unavailable at {path}")
    return str(Path(executable).resolve()), str(path)
