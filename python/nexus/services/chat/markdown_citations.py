"""prose citation markers from the markdown parser shared with the browser.

the bundled command returns ordered, nonoverlapping spans in the original python
string. parser failures are adapter defects; no fallback reinterprets markdown.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from pydantic import ConfigDict, TypeAdapter


@dataclass(frozen=True, slots=True)
class Marker:
    __pydantic_config__ = ConfigDict(extra="forbid")

    ordinal_text: str
    start: int
    end: int


_MARKERS = TypeAdapter(tuple[Marker, ...])


def parse_markers(markdown: str) -> tuple[Marker, ...]:
    """recognize literal prose markers; offsets count original unicode codepoints."""

    result = subprocess.run(
        ["node", str(Path(__file__).with_suffix(".mjs"))],
        input=markdown,
        encoding="utf-8",
        capture_output=True,
        check=True,
        timeout=10,
    )
    return _MARKERS.validate_json(result.stdout, strict=True)
