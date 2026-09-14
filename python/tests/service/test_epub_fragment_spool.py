"""Real source-job lifetime for staged EPUB bodies and publication rollback."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import (
    EpubFragmentSource,
    Fragment,
    MediaFile,
    MediaSourceAttempt,
    ReaderPublication,
    ReaderPublicationArtifact,
)
from nexus.jobs.queue import JobExecutionContext
from nexus.services.media_source_ingest import accept_browser_file_capture, run_source_attempt
from nexus.storage.client import get_storage_client
from tests.testkit.auth import UserRecord
from tests.testkit.epub_fixtures import EPUB2_NCX, epub2_payload, zip_payload
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.upload_sessions import delete_storage_prefix


@pytest.mark.parametrize("interrupt_publication", [False, True])
def test_epub_source_keeps_exact_staged_bodies_through_publication(
    db_session: Session,
    test_user: UserRecord,
    interrupt_publication: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = (
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        '<p id="opening">cafe\u0301 🧠</p><pre>x\r\ny</pre></body></html>'
    ).encode()
    source = epub2_payload(chapter=first, ncx=EPUB2_NCX)
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries["OEBPS/content.opf"] = (
        entries["OEBPS/content.opf"]
        .replace(
            b"</manifest>",
            b'<item id="last" href="last.xhtml" media-type="application/xhtml+xml"/></manifest>',
        )
        .replace(b"</spine>", b'<itemref idref="last"/></spine>')
    )
    entries["OEBPS/last.xhtml"] = (
        b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        b'<p id="last">last &amp; body</p></body></html>'
    )
    source = zip_payload(entries)
    expected = ["café 🧠\nx y", "last & body"]
    accepted = accept_browser_file_capture(
        db=db_session,
        viewer_id=test_user.id,
        payload=source,
        filename="staged.epub",
        content_type="application/epub+zip",
        library_ids=[],
    )
    assert accepted.ingest_enqueued
    attempt = db_session.get(MediaSourceAttempt, accepted.source_attempt_id)
    assert attempt is not None and attempt.job_id is not None
    job_id = attempt.job_id
    worker_id = "epub-staged-body-proof"
    claimed = claim_job_row(
        db_session,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("ingest_media_source",),
    )
    db_session.commit()
    assert claimed is not None
    context = JobExecutionContext(
        job_id=job_id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Heavy",
        execution_id=claimed.execution_id,
    )
    bind = db_session.get_bind()
    factory = sessionmaker(
        bind=bind,
        autoflush=False,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    attempt_root = get_settings().parser_temp_root / str(accepted.source_attempt_id)
    snapshots: list[set[bytes]] = []
    interrupted = False
    closed_archives: list[Path] = []
    close_archive = zipfile.ZipFile.close

    def observe_archive_close(archive: zipfile.ZipFile) -> None:
        owned_path = (
            Path(archive.filename)
            if archive.fp is not None
            and archive.filename is not None
            and Path(archive.filename).is_relative_to(attempt_root)
            else None
        )
        if owned_path is not None:
            assert owned_path.read_bytes() == source, (
                "EPUB source archive disappeared or changed before extraction closed it"
            )
        close_archive(archive)
        if owned_path is not None:
            assert archive.fp is None
            closed_archives.append(owned_path)

    monkeypatch.setattr(zipfile.ZipFile, "close", observe_archive_close)

    def observe_publication(_conn, _cursor, statement, _parameters, _context, _many):
        nonlocal interrupted
        if statement.lstrip().startswith("INSERT INTO fragments "):
            assert closed_archives, "EPUB publication began before its source archive closed"
            assert all(not path.exists() for path in closed_archives), (
                "EPUB source archive outlived its last extraction read"
            )
            snapshots.append(
                {path.read_bytes() for path in attempt_root.rglob("*") if path.is_file()}
            )
        if (
            interrupt_publication
            and not interrupted
            and statement.lstrip().startswith("INSERT INTO epub_fragment_sources ")
        ):
            interrupted = True
            raise RuntimeError("external driver interrupted EPUB publication after writes")

    storage = get_storage_client()
    event.listen(bind, "after_cursor_execute", observe_publication)
    try:
        if interrupt_publication:
            with pytest.raises(RuntimeError, match="external driver interrupted EPUB publication"):
                run_source_attempt(
                    session_factory=factory,
                    media_id=accepted.media_id,
                    attempt_id=accepted.source_attempt_id,
                    actor_user_id=test_user.id,
                    request_id=None,
                    context=context,
                )
            assert interrupted and snapshots
            assert (
                db_session.scalar(
                    select(func.count())
                    .select_from(Fragment)
                    .where(Fragment.media_id == accepted.media_id)
                )
                == 0
            ), "failed EPUB publication retained a partial fragment transaction"
            assert (
                db_session.scalar(
                    select(ReaderPublication.generation).where(
                        ReaderPublication.media_id == accepted.media_id
                    )
                )
                is None
            ), "failed EPUB publication advanced the reader generation"
            assert not attempt_root.exists(), "failed source attempt retained its body files"
            db_session.rollback()
            snapshots.clear()

        result = run_source_attempt(
            session_factory=factory,
            media_id=accepted.media_id,
            attempt_id=accepted.source_attempt_id,
            actor_user_id=test_user.id,
            request_id=None,
            context=context,
        )
        assert result["status"] == "success", result
        db_session.expire_all()
        fragments = db_session.scalars(
            select(Fragment).where(Fragment.media_id == accepted.media_id).order_by(Fragment.idx)
        ).all()
        assert [fragment.canonical_text for fragment in fragments] == expected
        assert list(
            db_session.scalars(
                select(EpubFragmentSource.package_href)
                .where(EpubFragmentSource.media_id == accepted.media_id)
                .order_by(EpubFragmentSource.reading_order)
            )
        ) == ["OEBPS/chapter.xhtml", "OEBPS/last.xhtml"]
        media_file = db_session.get(MediaFile, accepted.media_id)
        assert (
            media_file is not None
            and media_file.source_sha256 == hashlib.sha256(source).hexdigest()
        )
        assert b"".join(storage.stream_object(media_file.storage_path)) == source
        generation = db_session.scalar(
            select(ReaderPublication.generation).where(
                ReaderPublication.media_id == accepted.media_id
            )
        )
        assert generation == 1
        artifacts = db_session.scalars(
            select(ReaderPublicationArtifact).where(
                ReaderPublicationArtifact.media_id == accepted.media_id,
                ReaderPublicationArtifact.generation == generation,
                ReaderPublicationArtifact.role == "unit",
            )
        ).all()
        texts: dict[str, list[tuple[int, str]]] = {}
        for artifact in artifacts:
            payload = b"".join(storage.stream_object(artifact.storage_path))
            assert len(payload) == artifact.size_bytes
            assert hashlib.sha256(payload).hexdigest() == artifact.sha256
            unit = json.loads(payload)
            texts.setdefault(unit["fragment_id"], []).append(
                (unit["start_cp"], unit["canonical_text"])
            )
        assert [
            "".join(text for _offset, text in sorted(texts[str(fragment.id)]))
            for fragment in fragments
        ] == expected

        assert snapshots and all(
            {text.encode() for text in expected} <= snapshot for snapshot in snapshots
        ), "EPUB body files were retired before source publication"
        for snapshot in snapshots:
            assert source not in snapshot
            for fragment in fragments:
                assert fragment.html_sanitized.encode() in snapshot
        assert len(closed_archives) == 1 + int(interrupt_publication)
        assert not attempt_root.exists(), "successful source attempt retained its body files"
    except FileNotFoundError as error:
        if error.filename is not None and Path(error.filename).is_relative_to(attempt_root):
            pytest.fail("EPUB staged source disappeared during publication")
        raise
    finally:
        event.remove(bind, "after_cursor_execute", observe_publication)
        delete_storage_prefix(storage, f"media/{accepted.media_id}/")
