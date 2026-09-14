"""Private lookup digest for authored EPUB addresses; originals remain authoritative."""

import hashlib
import json
import subprocess
from collections.abc import Iterable
from tempfile import TemporaryFile

from nexus.services.reader_node import ReaderNodeDefect, reader_node_command


def reader_publication_anchor_key(href_path: str, anchor_id: str) -> str:
    # JSON preserves tuple boundaries without placing unbounded authored strings
    # in a PostgreSQL btree key. This is not a public navigation identity.
    payload = json.dumps([href_path, anchor_id], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_epub_lookup_paths(hrefs: Iterable[str]) -> dict[str, str | None]:
    """Normalize each distinct authored path once through the worker's URL owner."""
    paths = tuple(dict.fromkeys(hrefs))
    if not paths:
        return {}
    with TemporaryFile() as source, TemporaryFile() as output:
        for path in paths:
            source.write(json.dumps(path, ensure_ascii=False).encode("utf-8") + b"\n")
        source.seek(0)
        completed = subprocess.run(
            reader_node_command("epub_paths"),
            stdin=source,
            stdout=output,
            stderr=subprocess.PIPE,
            env={"LANG": "C.UTF-8", "NODE_ENV": "production"},
        )
        if completed.returncode != 0:
            # justify-defect: this owned child normalizes every authored EPUB path
            # or the worker image is wrong; its stderr is the only diagnosis we get.
            raise ReaderNodeDefect(
                "Reader EPUB path normalization failed: "
                + completed.stderr.decode("utf-8", "replace")[-4096:]
            )
        output.seek(0)
        result = {}
        for path in paths:
            normalized = json.loads(output.readline())
            if normalized is not None and not isinstance(normalized, str):
                raise ValueError("EPUB pathname projection must be a string or null")
            result[path] = normalized
        if output.read(1):
            raise ValueError("EPUB pathname projection has unexpected trailing output")
        return result
