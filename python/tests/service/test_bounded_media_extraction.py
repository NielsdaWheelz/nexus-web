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
import warnings
import zipfile
from collections.abc import Iterator
from dataclasses import fields
from multiprocessing.connection import Connection
from pathlib import Path
from uuid import UUID, uuid4

import fitz
import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.db.session import create_session_factory
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import (
    JobExecutionContext,
    claim_job,
    complete_job,
    enqueue_job,
    parser_operation_has_live_job,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.epub_ingest import (
    EPUB_RENDERED_TEXT_MAX_BYTES,
    EpubExtractionError,
    EpubExtractionPlan,
    build_epub_extraction_plan,
)
from nexus.services.latex_apparatus import (
    LATEX_APPARATUS_MAX_ITEMS,
    LATEX_SELECTED_SOURCE_MAX_BYTES,
)
from nexus.services.library_entries import ensure_entry, media_target
from nexus.services.media import get_media_for_viewer, list_visible_media
from nexus.services.parser_temp import (
    StorageObjectSizeMismatch,
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

_UNSUPPORTED_ZIP_COMPRESSION = 99


class _ChunkedSourceStorage:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def stream_object(self, _storage_path: str) -> Iterator[bytes]:
        midpoint = len(self.payload) // 2
        yield self.payload[:midpoint]
        yield self.payload[midpoint:]


class _MappedSourceStorage:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def stream_object(self, storage_path: str) -> Iterator[bytes]:
        payload = self.objects[storage_path]
        for offset in range(0, len(payload), 1024 * 1024):
            yield payload[offset : offset + 1024 * 1024]


class _StreamingAssetStorage(_ChunkedSourceStorage):
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


class _ReservationSession:
    def close(self) -> None:
        pass


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


def _zip_payload(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for path, content in entries.items():
            archive.writestr(path, content)
    return output.getvalue()


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
    return _zip_payload(entries)


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
    return _zip_payload(entries)


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
                storage_client=_ChunkedSourceStorage(payload),
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
                storage_client=_ChunkedSourceStorage(payload),
                record_progress=lambda _completed, _total, _unit: None,
            )
            assert isinstance(plan, PdfExtractionError)
            assert plan.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
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
            assert plan.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
            assert plan.terminal is True
            detail = {
                "citation_markers": LATEX_APPARATUS_MAX_ITEMS,
                "error_code": plan.error_code,
            }
        elif case in {"epub-maximum-safe", "epub-pathological"}:
            paragraph = b"<p>" + (b"x" * (32 * 1024)) + b"</p>"
            paragraph_count = 992 if case == "epub-maximum-safe" else 1024
            payload = _epub_payload(chapter_body=paragraph * paragraph_count)
            with tempfile.TemporaryDirectory(prefix="nexus-parser-probe-") as directory:
                source_path = Path(directory) / "source.epub"
                source_path.write_bytes(payload)
                source_size_bytes = len(payload)
                del payload
                progress_peaks: list[float] = []
                _reset_peak_rss()
                plan = build_epub_extraction_plan(
                    session_factory=lambda: _ReservationSession(),
                    media_id=uuid4(),
                    attempt_id=uuid4(),
                    storage_path=f"resource-probe/{case}.epub",
                    source_size_bytes=source_size_bytes,
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
                assert plan.error_code == ApiErrorCode.E_ARCHIVE_UNSAFE.value
                assert plan.terminal is True
                detail = plan.error_code
        else:
            raise AssertionError(f"unknown parser resource probe: {case}")
        output.send(("ok", _process_status_mib("VmHWM"), detail))
    except BaseException as exc:
        output.send(("error", 0.0, repr(exc)))
    finally:
        output.close()


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
        storage_client=_ChunkedSourceStorage(payload),
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
        db.add(
            MediaSourceAttempt(
                id=uuid4(),
                media_id=media_id,
                created_by_user_id=viewer_id,
                source_type="uploaded_pdf_file",
                attempt_no=2,
                run_count=0,
                status="accepted",
                intent_key=f"newer-parser-{uuid4()}",
            )
        )
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


def test_pdf_extraction_cleans_attempt_files_after_typed_parser_failure() -> None:
    payload = b"not a PDF"
    attempt_id = uuid4()

    result = build_pdf_extraction_plan(
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/invalid.pdf",
        source_size_bytes=len(payload),
        storage_client=_ChunkedSourceStorage(payload),
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
            if mode == "text":
                return "x" * (PDF_EXTRACTED_TEXT_MAX_BYTES + 1)
            if mode == "blocks":
                return []
            if mode == "dict":
                return {"blocks": []}
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
        storage_client=_ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert PDF_EXTRACTED_TEXT_MAX_BYTES == 32 * 1024 * 1024
    assert isinstance(result, PdfExtractionError)
    assert result.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
    assert result.terminal is True
    assert len(opened_sources) == 1 and isinstance(opened_sources[0], Path)


@pytest.mark.parametrize("limit_case", ["pages", "blocks", "links", "lines", "legal-retained"])
def test_pdf_structural_limits_return_typed_terminal_failure(
    monkeypatch: pytest.MonkeyPatch,
    limit_case: str,
) -> None:
    class _Rect:
        width = 612
        height = 792

    normal_span = {"text": "Body", "bbox": (10, 100, 40, 112), "size": 12}
    normal_line = {"spans": [normal_span]}

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
            return "[1]"

        def get_text(self, mode: str, *args: object, **kwargs: object) -> object:
            del args, kwargs
            if mode == "text":
                return "tiny"
            if mode == "blocks":
                if limit_case == "blocks":
                    return [(0, 0, 1, 1, "x")] * (PDF_APPARATUS_MAX_ITEMS + 1)
                if limit_case == "legal-retained":
                    return []
                return []
            if mode == "dict":
                if limit_case == "lines":
                    return {"blocks": [{"lines": [normal_line] * (PDF_APPARATUS_MAX_ITEMS + 1)}]}
                if limit_case == "legal-retained":
                    oversized_note = {
                        "spans": [
                            {
                                "text": "x" * (8 * 1024 * 1024 + 1),
                                "bbox": (10, 600, 500, 608),
                                "size": 8,
                            }
                        ]
                    }
                    label_line = {"spans": [{"text": "1", "bbox": (0, 600, 5, 608), "size": 8}]}
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
        storage_client=_ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(result, PdfExtractionError)
    assert result.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
    assert result.terminal is True


@pytest.mark.parametrize("expected_delta", [-1, 1])
def test_storage_stream_rejects_size_drift_and_removes_partial(
    tmp_path: Path,
    expected_delta: int,
) -> None:
    payload = b"immutable original"
    destination = tmp_path / "source.bin"

    with pytest.raises(StorageObjectSizeMismatch):
        stream_storage_object_to_file(
            _ChunkedSourceStorage(payload),
            storage_path="sources/source.bin",
            destination=destination,
            expected_size_bytes=len(payload) + expected_delta,
        )

    assert not destination.exists()


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
    assert result.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
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
    assert result.error_code == ApiErrorCode.E_SOURCE_TOO_LARGE.value
    assert result.terminal is True


def test_epub_combined_rendered_text_limit_returns_typed_terminal_failure() -> None:
    paragraph = b"<p>" + (b"x" * (32 * 1024)) + b"</p>"
    payload = _epub_payload(chapter_body=paragraph * 1024)
    attempt_id = uuid4()
    result = build_epub_extraction_plan(
        session_factory=lambda: _ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/oversized-text.epub",
        source_size_bytes=len(payload),
        storage_client=_ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert EPUB_RENDERED_TEXT_MAX_BYTES == 64 * 1024 * 1024
    assert isinstance(result, EpubExtractionError)
    assert result.error_code == ApiErrorCode.E_ARCHIVE_UNSAFE.value
    assert result.terminal is True
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
        storage_client=storage,
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"valid EPUB did not produce a plan: {plan!r}"
    assert len(plan.asset_entries) == 1
    assert "content" not in {field.name for field in fields(plan.asset_entries[0])}
    assert list(storage.uploads.values()) == [(asset, "image/png")]
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
        session_factory=lambda: _ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/cross-document-notes.epub",
        source_size_bytes=len(payload),
        storage_client=_ChunkedSourceStorage(payload),
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
        session_factory=lambda: _ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/unreadable-spine-entry.epub",
        source_size_bytes=len(payload),
        storage_client=_ChunkedSourceStorage(payload),
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
        session_factory=lambda: _ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/unreadable-book.epub",
        source_size_bytes=len(payload),
        storage_client=_ChunkedSourceStorage(payload),
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
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=("ingest_media_source",),
        )
        db.commit()
        assert claimed is not None and claimed.attempts == 1

    context = JobExecutionContext(
        job_id=job.id,
        worker_id=worker_id,
        attempt_no=1,
        resource_class="Heavy",
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
        assert complete_job(db, job_id=job.id, worker_id=worker_id)
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


def test_in_flight_source_progress_serializes_through_the_declared_media_wire(
    engine: Engine,
) -> None:
    viewer_id, media_id = _persist_test_media(engine, kind=MediaKind.pdf)
    attempt_id = uuid4()
    worker_id = "media-wire-worker"
    with Session(engine) as db:
        library_id = ensure_user_and_default_library(db, viewer_id)
        ensure_entry(db, library_id, media_target(media_id))
        attempt = MediaSourceAttempt(
            id=attempt_id,
            media_id=media_id,
            created_by_user_id=viewer_id,
            source_type="uploaded_pdf_file",
            attempt_no=1,
            run_count=1,
            status="running",
            intent_key=f"media-wire-progress-{attempt_id}",
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
        claimed = claim_job(
            db,
            job_id=job.id,
            worker_id=worker_id,
            lease_seconds=300,
            heavy_kinds=("ingest_media_source",),
        )
        db.commit()
        assert claimed is not None and claimed.attempts == 1

    fence = SourcePublicationFence.from_context(
        attempt_id=attempt_id,
        context=JobExecutionContext(
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=1,
            resource_class="Heavy",
        ),
    )
    session_factory = create_session_factory(engine)
    record_source_extraction_progress(
        session_factory=session_factory,
        fence=fence,
        media_id=media_id,
        completed=3,
        total=12,
        unit="Page",
    )

    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        with Session(engine) as db:
            counted = get_media_for_viewer(db, viewer_id, media_id).model_dump(mode="json")
    assert not emitted, [str(warning.message) for warning in emitted]
    assert counted["source_progress"] == {
        "kind": "Present",
        "value": {
            "kind": "Counted",
            "stage": "Extract",
            "completed": 3,
            "total": 12,
            "unit": "Page",
            "run_count": 1,
            "updated_at": counted["source_progress"]["value"]["updated_at"],
        },
    }

    record_source_finalizing(
        session_factory=session_factory,
        fence=fence,
        media_id=media_id,
    )
    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        with Session(engine) as db:
            listed, _cursor = list_visible_media(db, viewer_id)
            staged = next(media for media in listed if media.id == media_id).model_dump(mode="json")
    assert not emitted, [str(warning.message) for warning in emitted]
    assert staged["source_progress"]["kind"] == "Present"
    assert staged["source_progress"]["value"]["kind"] == "Stage"
    assert staged["source_progress"]["value"]["stage"] == "Finalize"
    assert staged["source_progress"]["value"]["run_count"] == 1

    with Session(engine) as db:
        assert complete_job(db, job_id=job.id, worker_id=worker_id)
        db.commit()


def test_parser_process_rss_stays_inside_the_background_memory_envelope() -> None:
    measured: dict[str, float] = {}
    details: dict[str, object] = {}
    for case in (
        "pdf-712",
        "pdf-high-links",
        "latex-output-limit",
        "epub-maximum-safe",
        "epub-pathological",
    ):
        high_water_rss_mib, detail = _execute_parser_resource_probe(case)
        measured[case] = high_water_rss_mib
        details[case] = detail

    print(f"bounded-parser-high-water-rss-mib={measured!r}")
    assert all(high_water < 448 for high_water in measured.values()), (
        f"parser exceeded the 448 MiB background-worker hard limit: {measured!r}; {details!r}"
    )
