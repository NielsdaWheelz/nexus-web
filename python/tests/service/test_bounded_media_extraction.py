"""Behavior proofs for file-backed bounded media extraction."""

from __future__ import annotations

import hashlib
import io
import multiprocessing
import stat
import struct
import tarfile
import tempfile
import time
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import fields
from multiprocessing.connection import Connection
from pathlib import Path
from uuid import UUID, uuid4

import fitz
import pytest
from hypothesis import example, given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode, ResourceLimitError
from nexus.jobs.queue import (
    JobExecutionContext,
    complete_job,
    enqueue_job,
    parser_operation_has_live_job,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EPUB_APPARATUS_MAX_TARGETS,
    EPUB_RENDERED_TEXT_MAX_BYTES,
    EPUB_XHTML_MAX_DECODED_BYTES,
    EPUB_XML_MAX_ATTRIBUTES_PER_BOOK,
    EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT,
    EPUB_XML_MAX_DEPTH,
    EPUB_XML_MAX_ELEMENTS_PER_BOOK,
    EPUB_XML_MAX_ELEMENTS_PER_ENTRY,
    EpubExtractionError,
    EpubExtractionPlan,
    build_epub_extraction_plan,
)
from nexus.services.latex_apparatus import (
    LATEX_APPARATUS_MAX_ITEMS,
    LATEX_SELECTED_SOURCE_MAX_BYTES,
)
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    prune_stale_parser_temp,
    stream_storage_object_to_file,
)
from nexus.services.pdf_ingest import (
    PDF_APPARATUS_MAX_ITEMS,
    PDF_EXTRACTED_TEXT_MAX_BYTES,
    PDF_MAX_PAGES,
    PdfExtractionError,
    PdfExtractionPlan,
    PdfSourcePackageArtifact,
    build_pdf_extraction_plan,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    SourcePublicationSuperseded,
    record_source_extraction_progress,
    record_source_finalizing,
)
from nexus.storage.client import StorageError
from tests.testkit.epub_fixtures import (
    ChunkedSourceStorage,
    ReservationSession,
    epub2_payload,
    zip_payload,
)
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.unreachable_state import (
    delete_jobs_by_ids,
    delete_source_attempts_and_media,
)

_UNSUPPORTED_ZIP_COMPRESSION = 99


class _MappedSourceStorage:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def stream_object(self, storage_path: str) -> Iterator[bytes]:
        payload = self.objects[storage_path]
        for offset in range(0, len(payload), 1024 * 1024):
            yield payload[offset : offset + 1024 * 1024]


class _StreamingAssetStorage(ChunkedSourceStorage):
    def __init__(self, payload: bytes) -> None:
        super().__init__(payload)
        self.uploads: dict[str, tuple[bytes, str]] = {}

    def put_object_stream(self, path: str, content, content_type: str) -> None:
        assert not isinstance(content, bytes), "EPUB asset upload received accumulated bytes"
        self.uploads[path] = (content.read(), content_type)


class _FailingSourceStorage:
    def stream_object(self, _storage_path: str) -> Iterator[bytes]:
        yield b"partial"
        raise StorageError("source stream failed")


class _FileSourceStorage:
    def __init__(self, source_path: Path) -> None:
        self.source_path = source_path

    def stream_object(self, _storage_path: str) -> Iterator[bytes]:
        with self.source_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                yield chunk


def _persist_test_media(engine: Engine, *, kind: MediaKind) -> tuple[UUID, UUID]:
    viewer_id = uuid4()
    media_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"bounded-extraction-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=kind.value,
                title="Bounded extraction proof",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.commit()
    return viewer_id, media_id


def _epub_package(*, manifest_items: str, spine_items: str) -> dict[str, bytes]:
    return {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": b"""\
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>
""",
        "EPUB/package.opf": f"""\
<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Bounded proof</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>{manifest_items}</manifest>
  <spine>{spine_items}</spine>
</package>
""".encode(),
    }


def _epub_payload(*, chapter_body: bytes, asset: bytes | None = None) -> bytes:
    image_manifest = '<item id="image" href="image.png" media-type="image/png"/>' if asset else ""
    image_markup = '<img src="image.png" alt="proof"/>' if asset else ""
    entries = _epub_package(
        manifest_items=(
            '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
            f"{image_manifest}"
        ),
        spine_items='<itemref idref="chapter"/>',
    )
    entries["EPUB/chapter.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        + image_markup.encode()
        + chapter_body
        + b"</body></html>"
    )
    if asset is not None:
        entries["EPUB/image.png"] = asset
    return zip_payload(entries)


def _epub_spine_payload(documents: dict[str, bytes]) -> bytes:
    """Build one EPUB whose spine lists each named XHTML document in order."""
    entries = _epub_package(
        manifest_items="".join(
            f'<item id="{name}" href="{name}.xhtml" media-type="application/xhtml+xml"/>'
            for name in documents
        ),
        spine_items="".join(f'<itemref idref="{name}"/>' for name in documents),
    )
    for name, document in documents.items():
        entries[f"EPUB/{name}.xhtml"] = document
    return zip_payload(entries)


def _zip_entries(payload: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _oversized_nav_epub_payload() -> bytes:
    """One EPUB 3 whose manifest-declared navigation document is not in the spine."""
    entries = _epub_package(
        manifest_items=(
            '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"'
            ' properties="nav"/>'
        ),
        spine_items='<itemref idref="chapter"/>',
    )
    entries["EPUB/chapter.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Readable.</p></body></html>'
    )
    entries["EPUB/nav.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc">'
        + b"x" * (EPUB_XHTML_MAX_DECODED_BYTES + 1)
        + b"</nav></body></html>"
    )
    return zip_payload(entries)


def _with_unreadable_entry(payload: bytes, entry_name: str) -> bytes:
    """Rewrite one stored archive entry to an unsupported compression method.

    The archive still lists the entry and its size, so extraction only learns
    that the bytes cannot be decompressed once it reads that spine item.
    """
    data = bytearray(payload)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        header_offset = archive.getinfo(entry_name).header_offset
    # Local file header keeps the method at +8; central directory keeps it at
    # +10 and the entry name at +46.
    struct.pack_into("<H", data, header_offset + 8, _UNSUPPORTED_ZIP_COMPRESSION)
    encoded_name = entry_name.encode("utf-8")
    cursor = data.find(b"PK\x01\x02")
    while cursor != -1:
        name_length = struct.unpack_from("<H", data, cursor + 28)[0]
        if bytes(data[cursor + 46 : cursor + 46 + name_length]) == encoded_name:
            struct.pack_into("<H", data, cursor + 10, _UNSUPPORTED_ZIP_COMPRESSION)
            return bytes(data)
        cursor = data.find(b"PK\x01\x02", cursor + 4)
    raise AssertionError(f"archive has no central directory record for {entry_name}")


def _tar_payload(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for path, content in entries.items():
            info = tarfile.TarInfo(path)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def _pdf_with_links_payload(link_count: int) -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    ]
    annotations = " ".join(f"{index} 0 R" for index in range(4, 4 + link_count)).encode()
    objects.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [" + annotations + b"] >>"
    )
    objects.extend(
        [b"<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Dest [3 0 R /XYZ 0 0 0] >>"] * link_count
    )
    payload = bytearray(b"%PDF-1.7\n")
    offsets: list[int] = []
    for object_number, body in enumerate(objects, 1):
        offsets.append(len(payload))
        payload.extend(f"{object_number} 0 obj\n".encode())
        payload.extend(body)
        payload.extend(b"\nendobj\n")
    xref_offset = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        payload.extend(f"{offset:010d} 00000 n \n".encode())
    payload.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode()
    )
    return bytes(payload)


def _pdf_source_package_artifact(payload: bytes) -> PdfSourcePackageArtifact:
    return PdfSourcePackageArtifact(
        storage_path="sources/package.tar",
        content_type="application/x-tar",
        size_bytes=len(payload),
        sha256_hex=hashlib.sha256(payload).hexdigest(),
        source_url="https://arxiv.org/e-print/bounded-proof",
        source_kind="arxiv_source",
    )


def _raw_span(
    text: str,
    bbox: tuple[float, float, float, float],
    size: float = 10.0,
) -> dict[str, object]:
    """One PyMuPDF ``rawdict`` span: every character carries its own box."""
    left, top, right, bottom = bbox
    advance = (right - left) / max(len(text), 1)
    return {
        "bbox": bbox,
        "size": size,
        "chars": [
            {
                "c": character,
                "bbox": (left + index * advance, top, left + (index + 1) * advance, bottom),
            }
            for index, character in enumerate(text)
        ],
    }


def _raw_bulk_span(
    text: str,
    bbox: tuple[float, float, float, float],
    size: float = 10.0,
) -> dict[str, object]:
    """One ``rawdict`` span whose whole run is a single entry.

    The budgets proved with this span count extracted bytes, not glyph boxes,
    and one box per character of a multi-megabyte run would dwarf the limit
    under proof.
    """
    return {"bbox": bbox, "size": size, "chars": [{"c": text, "bbox": bbox}]}


def _base_pdf_payload() -> bytes:
    document = fitz.open()
    document.new_page().insert_text((72, 72), "Bounded source package proof")
    payload = document.tobytes()
    document.close()
    return payload


def _process_status_mib(field: str) -> float:
    """Read one memory field of this process from `/proc/self/status`, in MiB.

    `VmRSS` is the resident size right now; `VmHWM` is the kernel's own
    high-water mark, which no sampling loop can miss.
    """
    for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
        if line.startswith(f"{field}:"):
            value, unit = line.removeprefix(f"{field}:").split()
            assert unit == "kB"
            return int(value) / 1024
    raise AssertionError(f"parser probe process has no {field} evidence")


def _reset_peak_rss() -> None:
    """Drop the kernel's RSS high-water mark to the current resident size.

    `VmHWM` covers the whole process lifetime, so without this the probe would
    report the peak of building its own multi-megabyte fixture rather than the
    peak of parsing it. Resetting immediately before the parser runs makes the
    high-water mark measure exactly the envelope the criterion is about.
    """
    Path("/proc/self/clear_refs").write_text("5", encoding="ascii")


def _run_parser_resource_probe(case: str, output: Connection) -> None:
    """Run one production-shaped parser case in an isolated worker process."""
    try:
        reported_high_water_rss_mib: float | None = None
        if case == "pdf-712":
            document = fitz.open()
            for page_index in range(712):
                page = document.new_page()
                page.insert_text((72, 72), f"Page {page_index + 1} bounded extraction proof.")
            payload = document.tobytes()
            document.close()
            _reset_peak_rss()
            plan = build_pdf_extraction_plan(
                media_id=uuid4(),
                attempt_id=uuid4(),
                storage_path="resource-probe/712.pdf",
                source_size_bytes=len(payload),
                expected_source_sha256=hashlib.sha256(payload).hexdigest(),
                storage_client=ChunkedSourceStorage(payload),
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, PdfExtractionPlan)
            assert plan.result.page_count == 712
            detail = plan.result.page_count
        elif case == "pdf-high-links":
            payload = _pdf_with_links_payload(PDF_APPARATUS_MAX_ITEMS + 1)
            _reset_peak_rss()
            plan = build_pdf_extraction_plan(
                media_id=uuid4(),
                attempt_id=uuid4(),
                storage_path="resource-probe/high-links.pdf",
                source_size_bytes=len(payload),
                expected_source_sha256=hashlib.sha256(payload).hexdigest(),
                storage_client=ChunkedSourceStorage(payload),
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, PdfExtractionError)
            assert plan.error_code == "E_RESOURCE_LIMIT"
            assert plan.resource_limit_dimension == "Structure"
            assert plan.terminal is True
            detail = {"links": PDF_APPARATUS_MAX_ITEMS + 1, "error_code": plan.error_code}
        elif case == "latex-output-limit":
            document = fitz.open()
            document.new_page().insert_text((72, 72), "Bounded source package proof")
            pdf_payload = document.tobytes()
            document.close()
            tex = (
                b"\\documentclass{article}\n\\begin{document}\n"
                + (b"\\cite{proof}\n" * LATEX_APPARATUS_MAX_ITEMS)
                + b"\\end{document}\n"
            )
            source_payload = _tar_payload(
                {
                    "main.tex": tex,
                    "references.bib": b"@article{proof,title={Bounded proof}}",
                }
            )
            artifact = _pdf_source_package_artifact(source_payload)
            _reset_peak_rss()
            plan = build_pdf_extraction_plan(
                media_id=uuid4(),
                attempt_id=uuid4(),
                storage_path="resource-probe/source.pdf",
                source_size_bytes=len(pdf_payload),
                expected_source_sha256=hashlib.sha256(pdf_payload).hexdigest(),
                storage_client=_MappedSourceStorage(
                    {
                        "resource-probe/source.pdf": pdf_payload,
                        artifact.storage_path: source_payload,
                    }
                ),
                record_progress=lambda _completed, _total, _unit: None,
                source_package=artifact,
            )
            assert isinstance(plan, PdfExtractionError)
            assert plan.error_code == "E_RESOURCE_LIMIT"
            assert plan.resource_limit_dimension == "Output"
            assert plan.terminal is True
            detail = {
                "citation_markers": LATEX_APPARATUS_MAX_ITEMS,
                "error_code": plan.error_code,
            }
        elif case == "epub-structural-limits":
            structural_cases: list[tuple[str, Callable[[], bytes], str, str, str | None]] = [
                (
                    "decoded-bytes",
                    lambda: _epub_payload(chapter_body=b"x" * EPUB_XHTML_MAX_DECODED_BYTES),
                    "E_RESOURCE_LIMIT",
                    "16 MiB",
                    "Output",
                ),
                (
                    "depth",
                    lambda: _epub_payload(
                        chapter_body=(
                            b"<section>" * EPUB_XML_MAX_DEPTH
                            + b"x"
                            + b"</section>" * EPUB_XML_MAX_DEPTH
                        )
                    ),
                    "E_RESOURCE_LIMIT",
                    "depth",
                    "Structure",
                ),
                (
                    "entry-elements",
                    lambda: _epub_payload(chapter_body=b"<i/>" * EPUB_XML_MAX_ELEMENTS_PER_ENTRY),
                    "E_RESOURCE_LIMIT",
                    "per-entry",
                    "Structure",
                ),
                (
                    "element-attributes",
                    lambda: _epub_payload(
                        chapter_body=(
                            b"<p "
                            + b" ".join(
                                f'a{index}="x"'.encode()
                                for index in range(EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT + 1)
                            )
                            + b">x</p>"
                        )
                    ),
                    "E_RESOURCE_LIMIT",
                    "per-element",
                    "Structure",
                ),
            ]

            elements_per_chapter = EPUB_XML_MAX_ELEMENTS_PER_ENTRY - 2
            structural_cases.append(
                (
                    "book-elements",
                    lambda: _epub_spine_payload(
                        {
                            f"chapter-{index}": (
                                b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                                + b"<i/>" * elements_per_chapter
                                + b"</body></html>"
                            )
                            for index in range(
                                EPUB_XML_MAX_ELEMENTS_PER_BOOK // elements_per_chapter + 1
                            )
                        }
                    ),
                    "E_RESOURCE_LIMIT",
                    "per-book",
                    "Structure",
                )
            )

            attribute_markup = b" ".join(
                f'a{index}="x"'.encode() for index in range(EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT)
            )
            attribute_elements = (
                EPUB_XML_MAX_ATTRIBUTES_PER_BOOK // EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT
            )
            structural_cases.append(
                (
                    "book-attributes",
                    lambda: _epub_payload(
                        chapter_body=(b"<i " + attribute_markup + b"/>") * (attribute_elements + 1)
                    ),
                    "E_RESOURCE_LIMIT",
                    "per-book",
                    "Structure",
                )
            )

            structural_cases.append(
                (
                    "nav-decoded-bytes",
                    _oversized_nav_epub_payload,
                    "E_RESOURCE_LIMIT",
                    "16 MiB",
                    "Output",
                )
            )

            structural_cases.append(
                (
                    "entity",
                    lambda: _epub_spine_payload(
                        {
                            "entity": b"""<?xml version="1.0"?>
<!DOCTYPE html [<!ENTITY expanded "must-not-expand">]>
<html xmlns="http://www.w3.org/1999/xhtml"><body>&expanded;</body></html>"""
                        }
                    ),
                    "E_INVALID_FILE_TYPE",
                    "entities and external resolution are disabled",
                    None,
                )
            )

            structural_details: dict[str, str] = {}
            structural_peaks: list[float] = []
            for (
                label,
                make_payload,
                expected_code,
                expected_message,
                expected_dimension,
            ) in structural_cases:
                payload = make_payload()
                with tempfile.TemporaryDirectory(prefix="nexus-parser-structure-") as directory:
                    source_path = Path(directory) / "source.epub"
                    source_path.write_bytes(payload)
                    source_size_bytes = len(payload)
                    expected_source_sha256 = hashlib.sha256(payload).hexdigest()
                    del payload
                    attempt_id = uuid4()
                    _reset_peak_rss()
                    plan = build_epub_extraction_plan(
                        session_factory=lambda: ReservationSession(),
                        media_id=uuid4(),
                        attempt_id=attempt_id,
                        storage_path=f"resource-probe/{label}.epub",
                        source_size_bytes=source_size_bytes,
                        expected_source_sha256=expected_source_sha256,
                        storage_client=_FileSourceStorage(source_path),
                        record_progress=lambda _completed, _total, _unit: None,
                    )
                    structural_peaks.append(_process_status_mib("VmHWM"))
                assert isinstance(plan, EpubExtractionError), (
                    f"{label}: bounded EPUB case produced a plan instead of a failure"
                )
                assert plan.error_code == expected_code, f"{label}: {plan!r}"
                assert expected_message in plan.error_message, f"{label}: {plan!r}"
                assert plan.resource_limit_dimension == expected_dimension, f"{label}: {plan!r}"
                assert not (get_settings().parser_temp_root / str(attempt_id)).exists(), (
                    f"{label}: attempt files survived a bounded EPUB failure"
                )
                if expected_dimension is not None:
                    assert plan.terminal is True, f"{label}: {plan!r}"
                structural_details[label] = plan.error_code
            reported_high_water_rss_mib = max(structural_peaks)
            detail = structural_details
        elif case in {"epub-maximum-safe", "epub-pathological"}:
            paragraph = b"<p>" + (b"x" * (32 * 1024)) + b"</p>"
            paragraph_count = 992 if case == "epub-maximum-safe" else 1024
            chapter_count = 3
            base_count, remainder = divmod(paragraph_count, chapter_count)
            payload = _epub_spine_payload(
                {
                    f"chapter-{index}": (
                        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                        + paragraph * (base_count + (1 if index < remainder else 0))
                        + b"</body></html>"
                    )
                    for index in range(chapter_count)
                }
            )
            with tempfile.TemporaryDirectory(prefix="nexus-parser-probe-") as directory:
                source_path = Path(directory) / "source.epub"
                source_path.write_bytes(payload)
                source_size_bytes = len(payload)
                expected_source_sha256 = hashlib.sha256(payload).hexdigest()
                del payload
                progress_peaks: list[float] = []
                _reset_peak_rss()
                plan = build_epub_extraction_plan(
                    session_factory=lambda: ReservationSession(),
                    media_id=uuid4(),
                    attempt_id=uuid4(),
                    storage_path=f"resource-probe/{case}.epub",
                    source_size_bytes=source_size_bytes,
                    expected_source_sha256=expected_source_sha256,
                    storage_client=_FileSourceStorage(source_path),
                    record_progress=lambda _completed, _total, _unit: progress_peaks.append(
                        _process_status_mib("VmRSS")
                    ),
                )
            if case == "epub-maximum-safe":
                assert isinstance(plan, EpubExtractionPlan)
                retained_bytes = sum(
                    len(fragment.html_sanitized.encode("utf-8"))
                    + len(fragment.canonical_text.encode("utf-8"))
                    for fragment, _chapter, _items, _edges in plan.fragment_specs
                )
                assert 60 * 1024 * 1024 < retained_bytes <= EPUB_RENDERED_TEXT_MAX_BYTES
                detail = {"retained_bytes": retained_bytes, "progress_peaks": progress_peaks}
            else:
                assert isinstance(plan, EpubExtractionError)
                assert plan.error_code == "E_RESOURCE_LIMIT"
                assert plan.resource_limit_dimension == "Output"
                assert plan.terminal is True
                detail = plan.error_code
        else:
            raise AssertionError(f"unknown parser resource probe: {case}")
        output.send(
            (
                "ok",
                reported_high_water_rss_mib or _process_status_mib("VmHWM"),
                detail,
            )
        )
    except BaseException as exc:
        output.send(("error", 0.0, repr(exc)))
    finally:
        output.close()


def test_lifecycle_preserves_declared_resource_dimension_on_api_error() -> None:
    import nexus.services.epub_lifecycle as epub_lifecycle
    import nexus.services.pdf_lifecycle as pdf_lifecycle

    pdf_error = PdfExtractionError(
        error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
        error_message="PDF text output exceeded its limit",
        terminal=True,
        resource_limit_dimension="Output",
    )
    epub_error = EpubExtractionError(
        error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
        error_message="EPUB archive structure exceeded its limit",
        terminal=True,
        resource_limit_dimension="Structure",
    )
    pdf_raised = pdf_lifecycle._extraction_api_error(pdf_error)
    assert isinstance(pdf_raised, ResourceLimitError), (
        f"PDF resource-limit projection lost its typed carrier: {pdf_raised!r}"
    )
    assert pdf_raised.code is ApiErrorCode.E_RESOURCE_LIMIT
    assert pdf_raised.dimension == "Output"

    epub_raised = epub_lifecycle._extraction_api_error(epub_error)
    assert isinstance(epub_raised, ResourceLimitError), (
        f"EPUB resource-limit projection lost its typed carrier: {epub_raised!r}"
    )
    assert epub_raised.code is ApiErrorCode.E_RESOURCE_LIMIT
    assert epub_raised.dimension == "Structure"

    ordinary_raised = pdf_lifecycle._extraction_api_error(
        PdfExtractionError(
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
            error_message="not a PDF",
        )
    )
    assert isinstance(ordinary_raised, ApiError)
    assert not isinstance(ordinary_raised, ResourceLimitError)
    assert ordinary_raised.code is ApiErrorCode.E_INVALID_FILE_TYPE


def _execute_parser_resource_probe(case: str) -> tuple[float, object]:
    """Return the parser process's own kernel RSS high-water mark and evidence."""
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_run_parser_resource_probe, args=(case, sender))
    process.start()
    sender.close()
    deadline = time.monotonic() + 120
    while not receiver.poll(0.5):
        assert time.monotonic() < deadline, f"{case} parser resource probe did not terminate"
    status, high_water_rss_mib, detail = receiver.recv()
    receiver.close()
    process.join(timeout=10)
    assert not process.is_alive(), f"{case} parser resource probe did not exit"
    assert process.exitcode == 0, f"{case} parser resource probe exited {process.exitcode}"
    assert status == "ok", f"{case} parser resource probe failed: {detail}"
    return float(high_water_rss_mib), detail


def test_pdf_extraction_reports_counted_progress_and_cleans_attempt_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = fitz.open()
    for text in ("First page", "Second page"):
        page = document.new_page()
        page.insert_text((72, 72), text)
    payload = document.tobytes()
    document.close()

    parser_open = fitz.open
    opened_sources: list[object] = []

    def track_parser_open(source: object, *args: object, **kwargs: object):
        opened_sources.append(source)
        return parser_open(source, *args, **kwargs)

    monkeypatch.setattr(fitz, "open", track_parser_open)
    attempt_id = uuid4()
    progress: list[tuple[int, int, str]] = []
    plan = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/document.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda completed, total, unit: progress.append((completed, total, unit)),
    )

    assert isinstance(plan, PdfExtractionPlan), f"valid PDF did not produce a plan: {plan!r}"
    assert plan.result.plain_text == "First page\n\nSecond page"
    assert progress == [(0, 2, "Page"), (2, 2, "Page")]
    assert len(opened_sources) == 1 and isinstance(opened_sources[0], Path), (
        f"PDF parser reopened or used a whole-byte source: {opened_sources!r}"
    )
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists(), (
        "PDF attempt files survived successful extraction"
    )


def test_parser_temp_pruning_preserves_live_and_unknown_directories(tmp_path: Path) -> None:
    live_attempt_id = uuid4()
    stale_attempt_id = uuid4()
    (tmp_path / str(live_attempt_id)).mkdir()
    (tmp_path / str(stale_attempt_id)).mkdir()
    (tmp_path / "operator-owned").mkdir()

    removed = prune_stale_parser_temp(
        tmp_path,
        operation_is_live=lambda operation_id: operation_id == live_attempt_id,
    )

    assert removed == 1
    assert (tmp_path / str(live_attempt_id)).is_dir()
    assert not (tmp_path / str(stale_attempt_id)).exists()
    assert (tmp_path / "operator-owned").is_dir()


def test_parser_attempt_directory_is_private_and_exactly_cleaned() -> None:
    attempt_id = uuid4()
    with parser_attempt_directory(attempt_id) as attempt_directory:
        assert stat.S_IMODE(attempt_directory.stat().st_mode) == 0o700
        (attempt_directory / "sensitive-source").write_bytes(b"private")
    assert not attempt_directory.exists()


def test_overlapping_parser_runs_never_delete_their_peer_directory() -> None:
    attempt_id = uuid4()
    with parser_attempt_directory(attempt_id) as first:
        (first / "first-source").write_bytes(b"first")
        with parser_attempt_directory(attempt_id) as second:
            (second / "second-source").write_bytes(b"second")
            assert first != second
            assert (first / "first-source").read_bytes() == b"first"
        assert (first / "first-source").read_bytes() == b"first"
        assert not second.exists()
    assert not first.parent.exists()


def test_parser_temp_liveness_preserves_an_older_nonterminal_attempt(engine: Engine) -> None:
    viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.pdf)
    older_attempt_id = uuid4()
    newer_attempt_id = uuid4()
    with Session(engine) as db:
        older = MediaSourceAttempt(
            id=older_attempt_id,
            media_id=media_id,
            created_by_user_id=viewer_id,
            source_type="uploaded_pdf_file",
            attempt_no=1,
            run_count=1,
            status="running",
            intent_key=f"older-parser-{older_attempt_id}",
        )
        db.add(older)
        job = enqueue_job(
            db,
            kind="ingest_media_source",
            payload={"media_id": str(media_id), "attempt_id": str(older_attempt_id)},
        )
        older.job_id = job.id
        newer = MediaSourceAttempt(
            id=newer_attempt_id,
            media_id=media_id,
            created_by_user_id=viewer_id,
            source_type="uploaded_pdf_file",
            attempt_no=2,
            run_count=0,
            status="accepted",
            intent_key=f"newer-parser-{newer_attempt_id}",
        )
        db.add(newer)
        newer_job = enqueue_job(
            db,
            kind="ingest_media_source",
            payload={"media_id": str(media_id), "attempt_id": str(newer_attempt_id)},
        )
        newer.job_id = newer_job.id
        db.commit()

        assert parser_operation_has_live_job(db, operation_id=older_attempt_id), (
            "startup cleanup treated an older live parser as stale"
        )
        reindex = enqueue_job(
            db,
            kind="media_content_reindex_job",
            payload={"media_id": str(media_id), "revision": 1},
        )
        db.commit()
        assert parser_operation_has_live_job(db, operation_id=reindex.id), (
            "startup cleanup treated a live reindex spool as stale"
        )
        delete_jobs_by_ids(db, job_ids=(job.id, newer_job.id, reindex.id))
        delete_source_attempts_and_media(
            db,
            attempt_ids=(older_attempt_id, newer_attempt_id),
            media_id=media_id,
        )
        db.commit()


def test_pdf_extraction_cleans_attempt_files_after_typed_parser_failure() -> None:
    payload = b"not a PDF"
    attempt_id = uuid4()

    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/invalid.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionError)
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists(), (
        "PDF attempt files survived a parser failure path"
    )


def test_pdf_extraction_cleans_attempt_files_after_storage_failure() -> None:
    attempt_id = uuid4()

    with pytest.raises(StorageError, match="source stream failed"):
        build_pdf_extraction_plan(
            media_id=uuid4(),
            attempt_id=attempt_id,
            storage_path="sources/interrupted.pdf",
            source_size_bytes=100,
            expected_source_sha256="0" * 64,
            storage_client=_FailingSourceStorage(),
            record_progress=lambda _completed, _total, _unit: None,
        )

    assert not (get_settings().parser_temp_root / str(attempt_id)).exists(), (
        "PDF attempt files survived an interrupted storage stream"
    )


def test_pdf_aggregate_limit_is_exact_and_returns_typed_terminal_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Rect:
        width = 612
        height = 792

    class _OversizedPage:
        rect = _Rect()
        rotation = 0

        def get_label(self) -> None:
            return None

        def get_links(self) -> list[object]:
            return []

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            if mode == "rawdict":
                return {
                    "blocks": [
                        {
                            "bbox": (0, 0, 1, 1),
                            "lines": [
                                {
                                    "spans": [
                                        _raw_bulk_span(
                                            "x" * (PDF_EXTRACTED_TEXT_MAX_BYTES + 1),
                                            (0, 0, 1, 1),
                                            12,
                                        )
                                    ]
                                }
                            ],
                        }
                    ]
                }
            raise AssertionError(f"unexpected fake PDF extraction mode: {mode}")

    class _OversizedDocument:
        needs_pass = False
        metadata: dict[str, str] = {}

        def __len__(self) -> int:
            return 1

        def __getitem__(self, index: int) -> _OversizedPage:
            assert index == 0
            return _OversizedPage()

        def close(self) -> None:
            pass

    opened_sources: list[object] = []

    def open_oversized(source: object, *args: object, **kwargs: object) -> _OversizedDocument:
        del args, kwargs
        opened_sources.append(source)
        return _OversizedDocument()

    monkeypatch.setattr(fitz, "open", open_oversized)
    payload = b"file-backed parser input"
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/oversized-text.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert PDF_EXTRACTED_TEXT_MAX_BYTES == 32 * 1024 * 1024
    assert isinstance(result, PdfExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Output"
    assert result.terminal is True
    assert len(opened_sources) == 1 and isinstance(opened_sources[0], Path)


@pytest.mark.parametrize(
    ("limit_case", "expected_dimension"),
    [
        ("pages", "Structure"),
        ("blocks", "Structure"),
        ("links", "Structure"),
        ("lines", "Structure"),
        ("legal-retained", "Output"),
    ],
)
def test_pdf_structural_limits_return_typed_terminal_failure(
    monkeypatch: pytest.MonkeyPatch,
    limit_case: str,
    expected_dimension: str,
) -> None:
    class _Rect:
        width = 612
        height = 792

    normal_line = {"spans": [_raw_span("Body", (10, 100, 40, 112), 12)]}
    text_modes: list[str] = []

    class _StructuralPage:
        rect = _Rect()
        rotation = 0

        def get_label(self) -> None:
            return None

        def get_links(self) -> list[dict[str, object]]:
            if limit_case == "links":
                return [{}] * (PDF_APPARATUS_MAX_ITEMS + 1)
            return []

        def get_textbox(self, _rect: object) -> str:
            raise AssertionError("PDF extraction must not request a second text representation")

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            text_modes.append(mode)
            if mode == "rawdict":
                if limit_case == "blocks":
                    return {
                        "blocks": [{"bbox": (0, 0, 1, 1), "lines": []}]
                        * (PDF_APPARATUS_MAX_ITEMS + 1)
                    }
                if limit_case == "lines":
                    return {"blocks": [{"lines": [normal_line] * (PDF_APPARATUS_MAX_ITEMS + 1)}]}
                if limit_case == "legal-retained":
                    oversized_note = {
                        "spans": [
                            _raw_bulk_span("x" * (8 * 1024 * 1024 + 1), (10, 600, 500, 608), 8)
                        ]
                    }
                    label_line = {"spans": [_raw_span("1", (0, 600, 5, 608), 8)]}
                    return {"blocks": [{"lines": [normal_line, label_line, oversized_note]}]}
                return {"blocks": []}
            raise AssertionError(f"unexpected fake PDF extraction mode: {mode}")

    class _StructuralDocument:
        needs_pass = False
        metadata: dict[str, str] = {}

        def __len__(self) -> int:
            return PDF_MAX_PAGES + 1 if limit_case == "pages" else 1

        def __getitem__(self, index: int) -> _StructuralPage:
            assert limit_case != "pages" and index == 0
            return _StructuralPage()

        def close(self) -> None:
            pass

    monkeypatch.setattr(fitz, "open", lambda *_args, **_kwargs: _StructuralDocument())
    payload = b"file-backed parser input"
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path=f"sources/{limit_case}.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == expected_dimension
    assert result.terminal is True
    assert text_modes == ([] if limit_case == "pages" else ["rawdict"])


@pytest.mark.parametrize("expected_delta", [-1, 1])
def test_storage_stream_rejects_size_drift_and_removes_partial(
    tmp_path: Path,
    expected_delta: int,
) -> None:
    payload = b"immutable original"
    destination = tmp_path / "source.bin"

    with pytest.raises(StorageObjectIntegrityError) as raised:
        stream_storage_object_to_file(
            ChunkedSourceStorage(payload),
            storage_path="sources/source.bin",
            destination=destination,
            expected_size_bytes=len(payload) + expected_delta,
            expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        )

    assert raised.value.code is ApiErrorCode.E_SOURCE_INTEGRITY
    assert not destination.exists()


def test_pdf_digest_mismatch_refuses_to_open_and_cleans_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _base_pdf_payload()
    attempt_id = uuid4()
    opened = False

    def _unexpected_open(*_args: object, **_kwargs: object) -> object:
        nonlocal opened
        opened = True
        raise AssertionError("digest mismatch must stop before PDF open")

    monkeypatch.setattr(fitz, "open", _unexpected_open)
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/digest-mismatch.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256="0" * 64,
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionError)
    assert result.error_code == "E_SOURCE_INTEGRITY"
    assert result.terminal is True
    assert opened is False
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_digest_mismatch_refuses_to_open_and_cleans_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _epub_payload(chapter_body=b"<p>Digest proof.</p>")
    attempt_id = uuid4()
    opened = False

    def _unexpected_open(*_args: object, **_kwargs: object) -> object:
        nonlocal opened
        opened = True
        raise AssertionError("digest mismatch must stop before EPUB open")

    monkeypatch.setattr(zipfile, "ZipFile", _unexpected_open)
    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/digest-mismatch.epub",
        source_size_bytes=len(payload),
        expected_source_sha256="0" * 64,
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_SOURCE_INTEGRITY"
    assert result.terminal is True
    assert opened is False
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_pdf_native_link_text_uses_snapshot_without_second_page_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Rect:
        width = 612
        height = 792

    class _LinkRect:
        x0 = 10
        y0 = 10
        x1 = 24
        y1 = 22

    class _Point:
        x = 10
        y = 692

    text_modes: list[str] = []

    class _NativeLinkPage:
        rect = _Rect()
        rotation = 0

        def get_label(self) -> None:
            return None

        def get_links(self) -> list[dict[str, object]]:
            return [
                {
                    "nameddest": "cite.reference-1",
                    "page": 0,
                    "from": _LinkRect(),
                    "to": _Point(),
                    "xref": 7,
                }
            ]

        def get_textbox(self, _rect: object) -> str:
            raise AssertionError("native citation text must come from the page snapshot")

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            text_modes.append(mode)
            assert mode == "rawdict"
            return {
                "blocks": [
                    {
                        "bbox": (10, 10, 24, 22),
                        "lines": [{"spans": [_raw_span("[1]", (10, 10, 24, 22))]}],
                    },
                    {
                        "bbox": (10, 100, 100, 112),
                        "lines": [{"spans": [_raw_span("References", (10, 100, 100, 112))]}],
                    },
                    {
                        "bbox": (10, 100, 200, 126),
                        "lines": [
                            {
                                "spans": [
                                    _raw_span(
                                        "[1] Snapshot-derived citation target",
                                        (10, 100, 200, 112),
                                    )
                                ]
                            }
                        ],
                    },
                ]
            }

    class _NativeLinkDocument:
        needs_pass = False
        metadata: dict[str, str] = {}

        def __len__(self) -> int:
            return 1

        def __getitem__(self, index: int) -> _NativeLinkPage:
            assert index == 0
            return _NativeLinkPage()

        def close(self) -> None:
            pass

    monkeypatch.setattr(fitz, "open", lambda *_args, **_kwargs: _NativeLinkDocument())
    payload = b"file-backed parser input"
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/native-link.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionPlan)
    assert text_modes == ["rawdict"]
    native_refs = [
        item
        for item in result.apparatus.items
        if item["kind"] == "bibliography_ref" and item["extraction_method"] == "pdf_native_link"
    ]
    assert [item["label"] for item in native_refs] == ["[1]"]


def test_pdf_page_snapshot_failure_keeps_page_heights_aligned_with_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A damaged page must not shift every later page's recorded height.

    Page heights are addressed by page index when a native citation link
    resolves its destination, so one unreadable page may not renumber them.
    """

    class _Rect:
        def __init__(self, height: float) -> None:
            self.width = 612.0
            self.height = height

    class _ReferencePage:
        def __init__(self, height: float, *, damaged: bool, cited: bool) -> None:
            self.rect = _Rect(height)
            self.rotation = 0
            self._damaged = damaged
            self._cited = cited

        def get_label(self) -> None:
            return None

        def get_links(self) -> list[dict[str, object]]:
            if not self._cited:
                return []
            return [
                {
                    "nameddest": "cite.reference-1",
                    "page": 1,
                    "from": fitz.Rect(10.0, 10.0, 24.0, 22.0),
                    "to": fitz.Point(12.0, 692.0),
                    "xref": 7,
                }
            ]

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            assert mode == "rawdict"
            if self._damaged:
                raise RuntimeError("damaged content stream")
            if not self._cited:
                return {"blocks": []}
            return {
                "blocks": [
                    {
                        "bbox": (10, 10, 24, 22),
                        "lines": [{"spans": [_raw_span("[12]", (10, 10, 24, 22))]}],
                    },
                    {
                        "bbox": (10, 50, 100, 62),
                        "lines": [{"spans": [_raw_span("References", (10, 50, 100, 62))]}],
                    },
                    {
                        "bbox": (10, 100, 200, 112),
                        "lines": [
                            {
                                "spans": [
                                    _raw_span("[1] Bounded reference body", (10, 100, 200, 112))
                                ]
                            }
                        ],
                    },
                ]
            }

    pages = [
        _ReferencePage(792.0, damaged=True, cited=False),
        _ReferencePage(792.0, damaged=False, cited=True),
        _ReferencePage(1000.0, damaged=False, cited=False),
    ]

    class _DamagedPageDocument:
        needs_pass = False
        metadata: dict[str, str] = {}

        def __len__(self) -> int:
            return len(pages)

        def __getitem__(self, index: int) -> _ReferencePage:
            return pages[index]

        def close(self) -> None:
            pass

    monkeypatch.setattr(fitz, "open", lambda *_args, **_kwargs: _DamagedPageDocument())
    payload = b"file-backed parser input"
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/damaged-page.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionPlan), f"a damaged page failed the document: {result!r}"
    assert result.result.page_count == 3
    assert [span.page_number for span in result.result.page_spans] == [1, 2, 3]
    diagnostics = result.apparatus.diagnostics["pdf_native_link"]
    assert isinstance(diagnostics, dict)
    assert diagnostics["skipped"] == {}, (
        f"the citation on page 2 did not resolve against page 2's own height: {diagnostics!r}"
    )
    edges = [
        edge for edge in result.apparatus.edges if edge["relation"] == "cites_bibliography_entry"
    ]
    assert len(edges) == 1, f"native citation edge was dropped: {result.apparatus.edges!r}"
    targets = [item for item in result.apparatus.items if item["kind"] == "bibliography_entry"]
    assert [item["label"] for item in targets] == ["[1]"]
    assert [item["locator"]["page_number"] for item in targets] == [2]


def test_pdf_native_link_marker_text_is_clipped_to_the_link_rectangle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Marker text anchors the rectangle that is persisted beside it.

    PyMuPDF renders this sentence as one wide span, so a link over `[12]`
    proves the clip is by character box and not by span overlap. The oracle is
    PyMuPDF's own `get_textbox`, which the parser may no longer call.
    """
    document = fitz.open()
    real_page = document.new_page()
    real_page.insert_text((72, 72), "See also Smith [12] for details")
    span = real_page.get_text("rawdict")["blocks"][0]["lines"][0]["spans"][0]
    characters = [(str(char["c"]), tuple(char["bbox"])) for char in span["chars"]]
    marker_start = "".join(character for character, _bbox in characters).index("[12]")
    marker_boxes = [bbox for _character, bbox in characters[marker_start : marker_start + 4]]
    link_rect = (
        min(box[0] for box in marker_boxes),
        min(box[1] for box in marker_boxes),
        max(box[2] for box in marker_boxes),
        max(box[3] for box in marker_boxes),
    )
    clipped_by_pymupdf = real_page.get_textbox(fitz.Rect(*link_rect)).strip()
    assert clipped_by_pymupdf == "[12]"

    class _LinkedPage:
        rect = real_page.rect
        rotation = 0

        def get_label(self) -> None:
            return None

        def get_links(self) -> list[dict[str, object]]:
            return [
                {
                    "nameddest": "cite.smith-2020",
                    "page": 0,
                    "from": fitz.Rect(*link_rect),
                    "to": fitz.Point(72.0, 400.0),
                    "xref": 11,
                }
            ]

        def get_textbox(self, _rect: object) -> str:
            raise AssertionError("marker text must come from the one page representation")

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            return real_page.get_text(mode)

    class _LinkedDocument:
        needs_pass = False
        metadata: dict[str, str] = {}

        def __len__(self) -> int:
            return 1

        def __getitem__(self, index: int) -> _LinkedPage:
            assert index == 0
            return _LinkedPage()

        def close(self) -> None:
            pass

    monkeypatch.setattr(fitz, "open", lambda *_args, **_kwargs: _LinkedDocument())
    payload = b"file-backed parser input"
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/clipped-link.pdf",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )
    document.close()

    assert isinstance(result, PdfExtractionPlan)
    markers = [item for item in result.apparatus.items if item["kind"] == "bibliography_ref"]
    assert [item["label"] for item in markers] == [clipped_by_pymupdf]
    assert markers[0]["locator"]["exact"] == clipped_by_pymupdf


@pytest.mark.parametrize(
    ("chapter_body", "expected_message"),
    [
        (b"<span>" * 129 + b"x" + b"</span>" * 129, "depth"),
        (b"<p " + b" ".join(f'a{i}="x"'.encode() for i in range(65)) + b">x</p>", "attributes"),
    ],
)
def test_epub_structural_preflight_rejects_adversarial_xhtml_before_dom_build(
    chapter_body: bytes,
    expected_message: str,
) -> None:
    payload = _epub_payload(chapter_body=chapter_body)
    attempt_id = uuid4()
    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/adversarial-structure.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Structure"
    assert expected_message in result.error_message
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


@given(
    nested_depth=st.integers(min_value=0, max_value=130),
    attribute_count=st.integers(min_value=0, max_value=68),
)
@hypothesis_settings(max_examples=24, deadline=None)
@example(
    nested_depth=EPUB_XML_MAX_DEPTH - 3,
    attribute_count=EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT,
)
@example(
    nested_depth=EPUB_XML_MAX_DEPTH - 2,
    attribute_count=EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT,
)
@example(
    nested_depth=0,
    attribute_count=EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT + 1,
)
def test_epub_structural_preflight_fuzzes_both_sides_of_shape_limits(
    nested_depth: int,
    attribute_count: int,
) -> None:
    attributes = b" ".join(f'a{index}="x"'.encode() for index in range(attribute_count))
    leaf = b"<p" + (b" " + attributes if attributes else b"") + b">x</p>"
    chapter_body = b"<section>" * nested_depth + leaf + b"</section>" * nested_depth
    payload = _epub_payload(chapter_body=chapter_body)
    attempt_id = uuid4()

    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/structural-fuzz.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    exceeds_shape = nested_depth + 3 > EPUB_XML_MAX_DEPTH or (
        attribute_count > EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT
    )
    if exceeds_shape:
        assert isinstance(result, EpubExtractionError)
        assert result.error_code == "E_RESOURCE_LIMIT"
        assert result.resource_limit_dimension == "Structure"
        assert result.terminal is True
    else:
        assert isinstance(result, EpubExtractionPlan)
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_pdf_source_package_digest_drift_is_a_defect_and_cleans_attempt_files() -> None:
    pdf_payload = _base_pdf_payload()
    source_payload = _tar_payload({"main.tex": b"\\begin{document}bounded\\end{document}"})
    artifact = PdfSourcePackageArtifact(
        storage_path="sources/package.tar",
        content_type="application/x-tar",
        size_bytes=len(source_payload),
        sha256_hex="0" * 64,
        source_url="https://arxiv.org/e-print/digest-drift",
        source_kind="arxiv_source",
    )
    attempt_id = uuid4()

    with pytest.raises(AssertionError, match="SHA-256"):
        build_pdf_extraction_plan(
            media_id=uuid4(),
            attempt_id=attempt_id,
            storage_path="sources/source.pdf",
            source_size_bytes=len(pdf_payload),
            expected_source_sha256=hashlib.sha256(pdf_payload).hexdigest(),
            storage_client=_MappedSourceStorage(
                {
                    "sources/source.pdf": pdf_payload,
                    artifact.storage_path: source_payload,
                }
            ),
            record_progress=lambda _completed, _total, _unit: None,
            source_package=artifact,
        )

    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_pdf_source_package_identity_and_bounded_apparatus_succeed() -> None:
    pdf_payload = _base_pdf_payload()
    source_payload = _tar_payload(
        {
            "main.tex": (b"\\begin{document}\nA claim \\cite{proof}.\n\\end{document}\n"),
            "references.bib": b"@article{proof,title={Bounded proof},year={2026}}",
        }
    )
    artifact = _pdf_source_package_artifact(source_payload)
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/source.pdf",
        source_size_bytes=len(pdf_payload),
        expected_source_sha256=hashlib.sha256(pdf_payload).hexdigest(),
        storage_client=_MappedSourceStorage(
            {
                "sources/source.pdf": pdf_payload,
                artifact.storage_path: source_payload,
            }
        ),
        record_progress=lambda _completed, _total, _unit: None,
        source_package=artifact,
    )

    assert isinstance(result, PdfExtractionPlan)
    assert [item["kind"] for item in result.apparatus.items] == [
        "bibliography_entry",
        "bibliography_ref",
    ]
    assert len(result.apparatus.edges) == 1


def test_pdf_source_package_selected_source_limit_is_typed_terminal() -> None:
    pdf_payload = _base_pdf_payload()
    selected_file_bytes = 1_800_000
    entries = {
        "main.tex": b"\\begin{document}\n" + b"x" * (selected_file_bytes - 17),
        **{f"references-{index}.bib": b"x" * selected_file_bytes for index in range(4)},
    }
    source_payload = _tar_payload(entries)
    artifact = _pdf_source_package_artifact(source_payload)
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/source.pdf",
        source_size_bytes=len(pdf_payload),
        expected_source_sha256=hashlib.sha256(pdf_payload).hexdigest(),
        storage_client=_MappedSourceStorage(
            {
                "sources/source.pdf": pdf_payload,
                artifact.storage_path: source_payload,
            }
        ),
        record_progress=lambda _completed, _total, _unit: None,
        source_package=artifact,
    )

    assert LATEX_SELECTED_SOURCE_MAX_BYTES == 8 * 1024 * 1024
    assert isinstance(result, PdfExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Output"
    assert result.terminal is True


def test_pdf_source_package_output_limit_is_typed_terminal() -> None:
    pdf_payload = _base_pdf_payload()
    source_payload = _tar_payload(
        {
            "main.tex": (
                b"\\begin{document}\n"
                + (b"\\cite{proof}\n" * LATEX_APPARATUS_MAX_ITEMS)
                + b"\\end{document}\n"
            ),
            "references.bib": b"@article{proof,title={Bounded proof}}",
        }
    )
    artifact = _pdf_source_package_artifact(source_payload)
    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=uuid4(),
        storage_path="sources/source.pdf",
        source_size_bytes=len(pdf_payload),
        expected_source_sha256=hashlib.sha256(pdf_payload).hexdigest(),
        storage_client=_MappedSourceStorage(
            {
                "sources/source.pdf": pdf_payload,
                artifact.storage_path: source_payload,
            }
        ),
        record_progress=lambda _completed, _total, _unit: None,
        source_package=artifact,
    )

    assert isinstance(result, PdfExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Output"
    assert result.terminal is True


def test_epub_combined_rendered_text_limit_returns_typed_terminal_failure() -> None:
    paragraph = b"<p>" + (b"x" * (32 * 1024)) + b"</p>"
    payload = _epub_payload(chapter_body=paragraph * 1024)
    attempt_id = uuid4()
    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/oversized-text.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert EPUB_RENDERED_TEXT_MAX_BYTES == 64 * 1024 * 1024
    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Output"
    assert result.terminal is True
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_apparatus_index_limit_is_a_typed_output_resource_failure() -> None:
    """The apparatus index is extraction output, so its cap is an output budget.

    A footnote-dense but otherwise safe archive is not an unsafe archive.
    """
    notes = b"".join(
        f'<aside epub:type="footnote" id="fn{index}"><p>Note {index}.</p></aside>'.encode()
        for index in range(EPUB_APPARATUS_MAX_TARGETS + 1)
    )
    payload = _epub_payload(chapter_body=b'<section epub:type="footnotes">' + notes + b"</section>")
    attempt_id = uuid4()

    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/apparatus-index.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT", f"apparatus budget misclassified: {result!r}"
    assert result.resource_limit_dimension == "Output", (
        f"apparatus budget misclassified: {result!r}"
    )
    assert result.terminal is True
    assert "bounded index" in result.error_message
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_assets_stream_without_retaining_asset_bytes(engine: Engine) -> None:
    asset = b"streamed-image-proof"
    payload = _epub_payload(chapter_body=b"<p>Readable chapter.</p>", asset=asset)
    storage = _StreamingAssetStorage(payload)
    _viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.epub)
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=create_session_factory(engine),
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path="sources/asset.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"valid EPUB did not produce a plan: {plan!r}"
    assert len(plan.asset_entries) == 1
    assert "content" not in {field.name for field in fields(plan.asset_entries[0])}
    assert list(storage.uploads.values()) == [(asset, "image/png")]
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_referenced_svg_asset_is_sanitized_from_one_entry_handle(engine: Engine) -> None:
    """The SVG preflight and the sanitizing parse share the caller's entry handle."""
    entries = _epub_package(
        manifest_items=(
            '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="image" href="image.svg" media-type="image/svg+xml"/>'
        ),
        spine_items='<itemref idref="chapter"/>',
    )
    entries["EPUB/chapter.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        b'<img src="image.svg" alt="proof"/></body></html>'
    )
    entries["EPUB/image.svg"] = (
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">'
        b'<script>fetch("https://example.invalid")</script>'
        b'<circle cx="4" cy="4" r="3"/></svg>'
    )
    payload = zip_payload(entries)
    storage = _StreamingAssetStorage(payload)
    _viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.epub)
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=create_session_factory(engine),
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path="sources/svg-asset.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"SVG asset failed the book: {plan!r}"
    assert [content_type for _content, content_type in storage.uploads.values()] == [
        "image/svg+xml"
    ]
    (sanitized, _content_type) = next(iter(storage.uploads.values()))
    assert b"<script" not in sanitized, f"SVG script survived sanitization: {sanitized!r}"
    assert b"circle" in sanitized, f"SVG lost its drawable content: {sanitized!r}"
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_referenced_svg_is_structurally_preflighted(engine: Engine) -> None:
    entries = _epub_package(
        manifest_items=(
            '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="image" href="image.svg" media-type="image/svg+xml"/>'
        ),
        spine_items='<itemref idref="chapter"/>',
    )
    entries["EPUB/chapter.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        b'<img src="image.svg" alt="proof"/></body></html>'
    )
    entries["EPUB/image.svg"] = b"<svg>" + (b"<g>" * 129) + (b"</g>" * 129) + b"</svg>"
    payload = zip_payload(entries)
    _viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.epub)
    attempt_id = uuid4()

    result = build_epub_extraction_plan(
        session_factory=create_session_factory(engine),
        media_id=media_id,
        attempt_id=attempt_id,
        storage_path="sources/deep-svg.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=_StreamingAssetStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_RESOURCE_LIMIT"
    assert result.resource_limit_dimension == "Structure"
    assert "depth" in result.error_message
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_footnote_link_into_another_spine_document_survives_extraction() -> None:
    payload = _epub_spine_payload(
        {
            "chapter": (
                b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                b"<p>Bounded extraction keeps the note link"
                b'<sup><a id="fnref1" href="notes.xhtml#fn1">1</a></sup></p>'
                b"</body></html>"
            ),
            "notes": (
                b'<html xmlns="http://www.w3.org/1999/xhtml"'
                b' xmlns:epub="http://www.idpf.org/2007/ops"><body>'
                b'<section epub:type="footnotes">'
                b'<aside epub:type="footnote" id="fn1"><p>Cross document note body.'
                b'<a href="chapter.xhtml#fnref1">back</a></p></aside>'
                b"</section></body></html>"
            ),
        }
    )
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/cross-document-notes.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"valid EPUB did not produce a plan: {plan!r}"
    assert plan.result.chapter_count == 2
    _chapter_fragment, chapter_spec, chapter_items, chapter_edges = plan.fragment_specs[0]
    _notes_fragment, notes_spec, notes_items, _notes_edges = plan.fragment_specs[1]
    assert chapter_spec.href == "EPUB/chapter.xhtml"
    assert notes_spec.href == "EPUB/notes.xhtml"
    note_edges = [edge for edge in chapter_edges if edge["relation"] == "points_to_note"]
    assert len(note_edges) == 1, f"cross document footnote link was dropped: {chapter_edges!r}"
    assert note_edges[0]["confidence"] == "strong"
    assert note_edges[0]["from_stable_key"] in {
        item["stable_key"] for item in chapter_items if item["kind"] == "footnote_ref"
    }
    assert note_edges[0]["to_stable_key"] in {
        item["stable_key"] for item in notes_items if item["kind"] == "footnote"
    }
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_structural_preflight_rejects_an_internal_dtd_subset() -> None:
    payload = _epub_spine_payload(
        {
            "chapter": b"""<?xml version="1.0"?>
<!DOCTYPE html [<!ENTITY expanded "must-not-expand">]>
<html xmlns="http://www.w3.org/1999/xhtml"><body>&expanded;</body></html>"""
        }
    )
    attempt_id = uuid4()

    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/internal-subset.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == "E_INVALID_FILE_TYPE"
    assert "entities and external resolution are disabled" in result.error_message
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


@pytest.mark.parametrize(
    ("case", "chapter_document"),
    [
        (
            "html5",
            b"""<?xml version="1.0"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Safe doctype.</p></body></html>""",
        ),
        (
            "external-identifier",
            b"""<?xml version="1.0"?>
<!DOCTYPE html SYSTEM "http://127.0.0.1:9/must-not-fetch.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Safe doctype.</p></body></html>""",
        ),
    ],
)
def test_epub_extraction_reads_an_inert_doctype_without_resolving_it(
    case: str,
    chapter_document: bytes,
) -> None:
    """An external identifier declares a DTD; it never authorizes fetching one.

    Port 9 discards, so any attempted resolution would fail the import instead
    of publishing a chapter.
    """
    payload = _epub_spine_payload({"chapter": chapter_document})
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path=f"sources/inert-doctype-{case}.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"inert doctype was rejected: {plan!r}"
    assert plan.result.chapter_count == 1
    assert "Safe doctype." in plan.fragment_specs[0][0].canonical_text
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_publishes_a_chapter_that_is_not_well_formed_xml() -> None:
    """Content documents are rendered by the recovering HTML parser.

    An unclosed tag, a void element, and a bare ampersand are ordinary EPUB
    markup; the preflight bounds such a chapter without refusing it.
    """
    payload = _epub_spine_payload(
        {
            "chapter": (
                b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                b"<p>Unclosed paragraph with <br> a raw & ampersand and <span>overlap</p>"
                b"</body></html>"
            )
        }
    )
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/not-well-formed.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"malformed chapter was rejected: {plan!r}"
    assert plan.result.chapter_count == 1
    fragment = plan.fragment_specs[0][0]
    assert "Unclosed paragraph with" in fragment.canonical_text
    assert "a raw & ampersand and overlap" in fragment.canonical_text
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


@pytest.mark.parametrize(
    ("case", "ncx"),
    [
        ("absent", None),
        ("malformed", b"<ncx><navMap><navPoint></ncx>"),
    ],
)
def test_epub_optional_navigation_entry_that_cannot_be_parsed_is_absence(
    case: str,
    ncx: bytes | None,
) -> None:
    """A declared but unusable table of contents leaves the book readable."""
    payload = epub2_payload(
        chapter=(
            b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
            b"<p>Readable chapter.</p></body></html>"
        ),
        ncx=ncx if ncx is not None else b"",
    )
    if case == "absent":
        payload = zip_payload(
            {
                name: content
                for name, content in _zip_entries(payload).items()
                if name != "OEBPS/toc.ncx"
            }
        )
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path=f"sources/{case}-ncx.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"{case} NCX failed the book: {plan!r}"
    assert plan.result.chapter_count == 1
    assert plan.result.toc_node_count == 0
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_publishes_readable_chapters_when_one_spine_entry_is_unreadable() -> None:
    payload = _with_unreadable_entry(
        _epub_spine_payload(
            {
                "chapter": (
                    b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                    b"<p>Readable chapter.</p></body></html>"
                ),
                "broken": (
                    b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                    b"<p>Undecompressible chapter.</p></body></html>"
                ),
            }
        ),
        "EPUB/broken.xhtml",
    )
    attempt_id = uuid4()
    progress: list[tuple[int, int, str]] = []

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/unreadable-spine-entry.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda completed, total, unit: progress.append((completed, total, unit)),
    )

    assert isinstance(plan, EpubExtractionPlan), f"partial EPUB did not produce a plan: {plan!r}"
    assert plan.result.chapter_count == 1
    assert [chapter.href for _fragment, chapter, _items, _edges in plan.fragment_specs] == [
        "EPUB/chapter.xhtml"
    ]
    assert progress == [(0, 1, "Chapter"), (1, 1, "Chapter")]
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_epub_with_only_unreadable_spine_entries_returns_typed_retryable_failure() -> None:
    payload = _with_unreadable_entry(
        _epub_spine_payload(
            {
                "chapter": (
                    b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                    b"<p>Undecompressible chapter.</p></body></html>"
                )
            }
        ),
        "EPUB/chapter.xhtml",
    )
    attempt_id = uuid4()

    result = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/unreadable-book.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, EpubExtractionError)
    assert result.error_code == ApiErrorCode.E_SOURCE_NOT_READABLE.value
    assert result.terminal is False
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()


def test_source_progress_is_monotonic_and_rejects_a_lost_heavy_fence(engine: Engine) -> None:
    viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.pdf)
    attempt_id = uuid4()
    worker_id = "bounded-parser-worker"
    with Session(engine) as db:
        attempt = MediaSourceAttempt(
            id=attempt_id,
            media_id=media_id,
            created_by_user_id=viewer_id,
            source_type="uploaded_pdf_file",
            attempt_no=1,
            run_count=1,
            status="running",
            intent_key=f"bounded-progress-{attempt_id}",
            processing_stage="Validate",
        )
        db.add(attempt)
        job = enqueue_job(
            db,
            kind="ingest_media_source",
            payload={"media_id": str(media_id), "attempt_id": str(attempt_id)},
        )
        attempt.job_id = job.id
        db.commit()
        claimed = claim_job_row(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=("ingest_media_source",),
        )
        db.commit()
        assert claimed is not None and claimed.attempts == 1
        claimed_attempt_no = claimed.attempts

    context = JobExecutionContext(
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=1,
        resource_class="Heavy",
        execution_id=claimed.execution_id,
    )
    fence = SourcePublicationFence.from_context(attempt_id=attempt_id, context=context)
    session_factory = create_session_factory(engine)
    record_source_extraction_progress(
        session_factory=session_factory,
        fence=fence,
        media_id=media_id,
        completed=0,
        total=12,
        unit="Page",
    )
    record_source_extraction_progress(
        session_factory=session_factory,
        fence=fence,
        media_id=media_id,
        completed=10,
        total=12,
        unit="Page",
    )
    with pytest.raises(AssertionError, match="regressed"):
        record_source_extraction_progress(
            session_factory=session_factory,
            fence=fence,
            media_id=media_id,
            completed=9,
            total=12,
            unit="Page",
        )
    record_source_finalizing(
        session_factory=session_factory,
        fence=fence,
        media_id=media_id,
    )

    with Session(engine) as db:
        persisted = db.get(MediaSourceAttempt, attempt_id)
        assert persisted is not None
        assert persisted.processing_stage == "Finalize"
        assert persisted.progress_completed == 0
        assert persisted.progress_total is None
        assert persisted.progress_unit is None
        assert complete_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=claimed_attempt_no,
        )
        db.commit()

    with pytest.raises(SourcePublicationSuperseded):
        record_source_extraction_progress(
            session_factory=session_factory,
            fence=fence,
            media_id=media_id,
            completed=12,
            total=12,
            unit="Page",
        )
    with Session(engine) as db:
        persisted = db.get(MediaSourceAttempt, attempt_id)
        assert persisted is not None
        assert persisted.processing_stage == "Finalize"
        assert persisted.progress_completed == 0
        delete_jobs_by_ids(db, job_ids=(job.id,))
        delete_source_attempts_and_media(
            db,
            attempt_ids=(attempt_id,),
            media_id=media_id,
        )
        db.commit()


def test_parser_process_rss_stays_inside_the_background_memory_envelope() -> None:
    measured: dict[str, float] = {}
    details: dict[str, object] = {}
    for case in (
        "pdf-712",
        "pdf-high-links",
        "latex-output-limit",
        "epub-structural-limits",
        "epub-maximum-safe",
        "epub-pathological",
    ):
        high_water_rss_mib, detail = _execute_parser_resource_probe(case)
        measured[case] = high_water_rss_mib
        details[case] = detail

    print(f"bounded-parser-high-water-rss-mib={measured!r}")
    parser_budget_mib = 448 - 96
    assert all(high_water < parser_budget_mib for high_water in measured.values()), (
        "parser plus the 96 MiB supervisor target exceeded the 448 MiB "
        f"background-worker hard limit: {measured!r}; {details!r}"
    )
