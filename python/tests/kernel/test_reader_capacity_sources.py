"""Capacity recipes reach their independent byte counts through real decoders."""

import errno
import hashlib
import io
import os
import stat
import struct
import zipfile
from collections.abc import Generator

import fitz
import pytest

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.epub_ingest import _epub_sanitize
from nexus.services.pdf_ingest import normalize_pdf_text
from nexus.services.reader_word_boundaries import reader_word_boundaries
from tests.testkit.reader_capacity_sources import epub_capacity_source, pdf_capacity_source


def test_capacity_source_recipes_keep_real_text_and_independent_byte_budgets() -> None:
    for dense_words in (False, True):
        epub, expected = epub_capacity_source(rendered_bytes=64 * 1024, dense_words=dense_words)
        observed = 0
        with zipfile.ZipFile(io.BytesIO(epub)) as archive:
            assert archive.namelist() == [
                "mimetype",
                "META-INF/container.xml",
                "EPUB/package.opf",
                *(chapter["href_path"] for chapter in expected["chapters"]),
            ]
            assert all(
                entry.date_time == (1980, 1, 1, 0, 0, 0)
                and entry.compress_type == zipfile.ZIP_STORED
                for entry in archive.infolist()
            ), "capacity source archive metadata depends on the wall clock"
            for chapter in expected["chapters"]:
                markup = archive.read(chapter["href_path"]).decode()
                sanitized = _epub_sanitize(markup)
                canonical = generate_canonical_text(sanitized).encode()
                assert len(sanitized.encode()) == chapter["sanitized_html_bytes"]
                assert len(canonical) == chapter["canonical_bytes"]
                assert hashlib.sha256(canonical).hexdigest() == chapter["canonical_sha256"]
                points = tuple(reader_word_boundaries(canonical.decode()))
                assert points[0] == 0 and points[-1] == len(canonical)
                assert len(points) == chapter["word_boundary_count"]
                filler = canonical[chapter["filler_start_cp"] : chapter["filler_end_cp"]]
                assert len(filler.split(b" ")) == chapter["filler_word_count"]
                assert filler.startswith(b"a") and filler.endswith(b"a")
                if dense_words:
                    assert b"  " not in filler and b"aaa" not in filler
                    assert len(points) >= len(canonical) - 32
                else:
                    assert b" " not in filler and len(points) == 14
                observed += len(sanitized.encode()) + len(canonical)
        assert expected["dense_words"] is dense_words
        assert observed == expected["rendered_bytes"] == 64 * 1024
        assert epub_capacity_source(rendered_bytes=64 * 1024, dense_words=dense_words)[0] == epub

    pdf, expected = pdf_capacity_source(page_count=3, text_bytes=10_000, source_bytes=1024 * 1024)
    with fitz.open(stream=pdf, filetype="pdf") as document:
        assert len(document) == expected["page_count"] == 3
        pages = [normalize_pdf_text(page.get_text("text")) for page in document]
    text = "\n\n".join(pages).encode()
    assert len(text) == expected["text_bytes"] == 10_000
    assert hashlib.sha256(text).hexdigest() == expected["text_sha256"]
    assert len(pdf) == expected["source_bytes"] == 1024 * 1024
    assert pdf_capacity_source(page_count=3, text_bytes=10_000, source_bytes=1024 * 1024)[0] == pdf


def _open_anonymous_files_with_bytes(payload: bytes) -> list[tuple[int, int]]:
    identities = []
    for name in os.listdir("/proc/self/fd"):
        descriptor = int(name)
        try:
            info = os.fstat(descriptor)
            if (
                stat.S_ISREG(info.st_mode)
                and info.st_nlink == 0
                and info.st_size == len(payload)
                and os.pread(descriptor, len(payload), 0) == payload
            ):
                identities.append((info.st_dev, info.st_ino))
        except OSError as error:
            # The descriptor used to enumerate /proc is already closed.
            if error.errno != errno.EBADF:
                raise
    return identities


@pytest.mark.parametrize("exhaust", [False, True])
def test_word_input_storage_retires_before_boundary_consumption(exhaust: bool) -> None:
    canonical = "🧠 " * 4096 + "z"
    source_bytes = canonical.encode("utf-8")
    expected = tuple(range(8194))
    output_bytes = b"".join(struct.pack("<I", point) for point in expected)
    offsets = reader_word_boundaries(canonical)
    assert isinstance(offsets, Generator)
    try:
        assert next(offsets) == 0
        # Actual Node completed and produced the independent codepoint oracle.
        # pread leaves the producer's file cursor unchanged. Match source bytes,
        # not an incidental descriptor number or temporary filename.
        output_files = _open_anonymous_files_with_bytes(output_bytes)
        assert len(output_files) == 1
        assert not _open_anonymous_files_with_bytes(source_bytes), (
            "word segmentation input remains open during boundary consumption"
        )
        if exhaust:
            assert (0, *offsets) == expected
    finally:
        offsets.close()
    assert not _open_anonymous_files_with_bytes(source_bytes)
    assert not _open_anonymous_files_with_bytes(output_bytes), (
        "word boundary output remains open after iterator retirement"
    )
