"""Blocks in, embedded chunks out: the pure half of the content index (no database).

A block is one citable slice of an owner's text with the locator that cites it. A chunk
is at most 420 whitespace tokens: a window of one long block (windows step 360 tokens,
so consecutive windows overlap by 60), or a run of whole blocks that touch
(``previous.start + len(previous.text) == next.start``) and share one citable anchor
(fragment, pdf page, transcript segment time, note block). Its locator is the first
block's, widened to the chunk, quoting exactly the chunk's text. Embeddings travel as
float32 bytes, the precision pgvector stores.

A document's chunks stream through a JSONL spool inside its job's parser-temp
directory, so neither the embeddings nor the chunk texts are held twice in memory. The
envelope: 256 KiB per chunk text, 384 MiB per spool.
"""

from __future__ import annotations

import base64
import json
import re
from array import array
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from itertools import islice
from pathlib import Path

from nexus.services.embeddings import embed_texts
from nexus.services.parser_temp import utf8_byte_length

CHUNK_MAX_TOKENS = 420
CHUNK_OVERLAP_TOKENS = 60
EMBED_BATCH = 64
CHUNK_MAX_BYTES = 256 * 1024
SPOOL_MAX_BYTES = 384 * 1024 * 1024
_SPOOL_RECORD_MAX_BYTES = CHUNK_MAX_BYTES * 16 + 1024 * 1024
_ANCHOR_KEYS = {
    "web_text": ("fragment_id",),
    "epub_text": ("fragment_id",),
    "pdf_text": ("page_number",),
    "transcript_time_text": ("t_start_ms", "t_end_ms"),
    "note_text": ("note_block_id",),
}


@dataclass(frozen=True)
class IndexableBlock:
    """``text`` is the slice ``locator`` cites; ``start`` its offset in the owner's text."""

    text: str
    start: int
    locator: dict[str, object]
    heading_path: tuple[str, ...] = ()


@dataclass(frozen=True)
class Chunk:
    block_idx: int  # the first block: its heading path labels the citation
    text: str
    locator: dict[str, object]
    embedding_f32: bytes


class EnvelopeExceeded(Exception):
    """The document does not fit the bounded indexing envelope; retrying cannot help."""


def plan_chunks(blocks: Sequence[IndexableBlock], *, max_bytes: int | None) -> Iterator[Chunk]:
    """Every chunk in order with its embedding, one provider request per 64 chunks."""
    parts_iter = _chunk_parts(blocks)
    while batch := list(islice(parts_iter, EMBED_BATCH)):
        texts = ["".join(blocks[i].text[start:end] for i, start, end in parts) for parts in batch]
        if max_bytes is not None and any(utf8_byte_length(text) > max_bytes for text in texts):
            raise EnvelopeExceeded()
        for parts, text, vector in zip(batch, texts, embed_texts(texts), strict=True):
            yield Chunk(
                parts[0][0], text, _chunk_locator(blocks, parts, text), array("f", vector).tobytes()
            )


def spool_chunks(blocks: Sequence[IndexableBlock], path: Path) -> None:
    """Write the document's chunks to ``path`` (created here) within the envelope."""
    written = 0
    with path.open("xb") as spool:
        for chunk in plan_chunks(blocks, max_bytes=CHUNK_MAX_BYTES):
            record = {
                "block_idx": chunk.block_idx,
                "embedding_f32": base64.b64encode(chunk.embedding_f32).decode("ascii"),
                "locator": chunk.locator,
                "text": chunk.text,
            }
            line = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
            written += len(line)
            if len(line) > _SPOOL_RECORD_MAX_BYTES or written > SPOOL_MAX_BYTES:
                raise EnvelopeExceeded()
            spool.write(line)


def read_spool(path: Path) -> Iterator[Chunk]:
    with path.open("rb") as spool:
        for line in spool:
            record = json.loads(line)
            yield Chunk(
                record["block_idx"],
                record["text"],
                record["locator"],
                base64.b64decode(record["embedding_f32"]),
            )


def _windows(text: str) -> Iterator[tuple[int, int, int]]:
    """``(start, end, token_count)`` of each token window over one block's text."""
    matches = re.finditer(r"\S+", text)
    window = list(islice(matches, CHUNK_MAX_TOKENS + 1))
    while window:
        current = window[:CHUNK_MAX_TOKENS]
        yield current[0].start(), current[-1].end(), len(current)
        if len(window) <= CHUNK_MAX_TOKENS:
            return
        window = window[CHUNK_MAX_TOKENS - CHUNK_OVERLAP_TOKENS :]
        window.extend(islice(matches, CHUNK_MAX_TOKENS + 1 - len(window)))


def _anchor(block: IndexableBlock) -> tuple[object, ...]:
    kind = str(block.locator["kind"])
    return (kind, *(block.locator[key] for key in _ANCHOR_KEYS[kind]))


def _chunk_parts(blocks: Sequence[IndexableBlock]) -> Iterator[list[tuple[int, int, int]]]:
    """``[(block_idx, start, end)]`` per chunk, holding one chunk at a time."""
    parts: list[tuple[int, int, int]] = []
    tokens = 0
    for idx, block in enumerate(blocks):
        for start, end, count in _windows(block.text):
            if parts:
                last_idx, _, last_end = parts[-1]
                last = blocks[last_idx]
                if (
                    tokens + count > CHUNK_MAX_TOKENS
                    or start != 0
                    or last_end != len(last.text)
                    or last.start + len(last.text) != block.start
                    or _anchor(last) != _anchor(block)
                ):
                    yield parts
                    parts, tokens = [], 0
            parts.append((idx, start, end))
            tokens += count
    if parts:
        yield parts


def _chunk_locator(
    blocks: Sequence[IndexableBlock], parts: list[tuple[int, int, int]], text: str
) -> dict[str, object]:
    """The first block's locator, widened to the chunk and quoting it exactly."""
    first_idx, first_start, _ = parts[0]
    last_idx, _, last_end = parts[-1]
    head, tail = blocks[first_idx].locator, blocks[last_idx].locator
    locator = head | {"text_quote": {"exact": text, "prefix": "", "suffix": ""}}
    match head["kind"]:
        case "web_text" | "epub_text" | "note_text":
            locator["start_offset"] = int(str(head["start_offset"])) + first_start
            locator["end_offset"] = int(str(tail["start_offset"])) + last_end
        case "pdf_text":  # a page is one block, so a chunk never leaves its page
            locator["page_text_start_offset"] = first_start
            locator["page_text_end_offset"] = last_end
            locator["plain_text_start_offset"] = (
                int(str(head["plain_text_start_offset"])) + first_start
            )
            locator["plain_text_end_offset"] = int(str(tail["plain_text_start_offset"])) + last_end
            geometry = head.get("geometry")
            page_end = int(str(head["page_text_end_offset"]))
            if isinstance(geometry, dict) and page_end > 0:
                # A band across the page at the chunk's proportional text offset.
                width, height = float(geometry["page_width"]), float(geometry["page_height"])
                top = max(0.0, min(height, height * first_start / page_end))
                bottom = min(height, top + max(8.0, min(18.0, height / 60.0)))
                inset = min(48.0, width * 0.08)
                if bottom > top:
                    locator["geometry"] = geometry | {
                        "projection": "proportional_text_offsets",
                        "quads": [
                            {
                                "x1": inset,
                                "y1": top,
                                "x2": width - inset,
                                "y2": top,
                                "x3": width - inset,
                                "y3": bottom,
                                "x4": inset,
                                "y4": bottom,
                            }
                        ],
                    }
        case "transcript_time_text":
            locator["t_end_ms"] = tail["t_end_ms"]
    return locator
