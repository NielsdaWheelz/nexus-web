"""Priority proof for the one-use direct offline-reading package boundary."""

from __future__ import annotations

import asyncio
import base64
import glob
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import zipfile
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from lxml import html
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.api.routes.offline_reading import PACKAGE_ASSEMBLY_MAX_CONCURRENCY
from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.config import clear_settings_cache, get_settings
from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    ProcessingStatus,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import (
    delete_entry,
    ensure_media_in_default_library,
    media_target,
)
from nexus.services.offline_reading_delivery import build_offline_reading_archive_file
from nexus.services.offline_reading_packages import verify_offline_reading_zip
from nexus.services.reader_publication import replace_reader_publication
from nexus.services.stream_tokens import (
    mint_offline_reading_package_token,
    verify_offline_reading_package_token,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import (
    build_epub_attempt_asset_storage_path,
    build_source_artifact_storage_path,
)
from nexus.web_paths import media_asset_url
from tests.testkit.auth import StaticTokenVerifier

_PACKAGE_TEMP_FILE_GLOB = "nexus-offline-reading-*.zip"


def test_direct_package_is_account_generation_integrity_and_replay_bound(
    engine: Engine,
) -> None:
    viewer_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    source_path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    source = b"%PDF-1.4\n% offline package proof\n%%EOF\n"
    storage = get_storage_client()
    storage.put_object(source_path, source, "application/pdf")

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"offline-package-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.pdf.value,
                title="Verified offline PDF",
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Verified offline PDF",
                html_sanitized="<p>Verified offline PDF</p>",
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind=MediaKind.pdf.value,
            replace_projection=lambda _media: db.add(
                MediaFile(
                    media_id=media_id,
                    storage_path=source_path,
                    content_type="application/pdf",
                    size_bytes=len(source),
                    source_sha256=hashlib.sha256(source).hexdigest(),
                )
            ),
        )
        media = db.get(Media, media_id)
        assert media is not None
        media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()

    verifier = StaticTokenVerifier(viewer_id, f"offline-package-{viewer_id}@example.invalid")
    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=None,
        )
    )
    add_request_id_middleware(app, log_requests=False)

    with Session(engine) as db:
        media = db.get(Media, media_id)
        assert media is not None
        media.processing_status = ProcessingStatus.extracting
        db.commit()

    with TestClient(app) as client:
        not_ready_mint = client.post(
            f"/internal/media/{media_id}/offline-reading-token",
            headers={"Authorization": f"Bearer {verifier.token}"},
        )
        with Session(engine) as db:
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()
        binding = client.get(
            "/internal/offline-reading/account-binding",
            headers={"Authorization": f"Bearer {verifier.token}"},
        )
        stale_mint = client.post(
            f"/internal/media/{media_id}/offline-reading-token",
            headers={"Authorization": f"Bearer {verifier.token}"},
        )
        with Session(engine) as db:
            replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind=MediaKind.pdf.value,
                replace_projection=lambda _media: None,
            )
            db.commit()
        stale = client.get(
            f"/offline-reading/packages/{media_id}",
            headers={"Authorization": f"Bearer {stale_mint.json()['data']['token']}"},
        )
        mint = client.post(
            f"/internal/media/{media_id}/offline-reading-token",
            headers={"Authorization": f"Bearer {verifier.token}"},
        )
        minted = mint.json()["data"]
        current_jti = verify_offline_reading_package_token(
            minted["token"],
            expected_media_id=media_id,
        ).jti
        with Session(engine) as db:
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.extracting
            db.commit()
        not_ready_direct = client.get(
            f"/offline-reading/packages/{media_id}",
            headers={"Authorization": f"Bearer {minted['token']}"},
        )
        with Session(engine) as db:
            claimed_while_not_ready = db.scalar(
                text(
                    """
                    SELECT jti
                    FROM stream_token_jti_claims
                    WHERE jti = :jti
                    """
                ),
                {"jti": current_jti},
            )
        with Session(engine) as db:
            media = db.get(Media, media_id)
            assert media is not None
            media.processing_status = ProcessingStatus.ready_for_reading
            db.commit()
        response = client.get(
            f"/offline-reading/packages/{media_id}",
            headers={
                "Authorization": f"Bearer {minted['token']}",
                "Accept-Encoding": "identity",
            },
        )
        replay = client.get(
            f"/offline-reading/packages/{media_id}",
            headers={"Authorization": f"Bearer {minted['token']}"},
        )

    assert binding.status_code == 200, binding.text
    assert not_ready_mint.status_code == 409, not_ready_mint.text
    assert not_ready_mint.json()["error"]["code"] == "E_MEDIA_NOT_READY"
    assert binding.headers["cache-control"] == "private, no-store"
    assert binding.json()["data"] == {
        "account_id": str(viewer_id),
        "protocol_version": 1,
        "package_schema_version": 1,
        "reader_contract_version": 1,
        "minimum_reader_bundle_version": 1,
    }
    assert mint.status_code == 200, mint.text
    assert mint.headers["cache-control"] == "private, no-store"
    assert minted["account_id"] == str(viewer_id)
    assert minted["reader_generation"] == 2
    assert minted["package_schema_version"] == 1
    assert minted["package_base_url"].startswith(("http://", "https://"))
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["code"] == "E_READER_CONTENT_CHANGED"
    assert not_ready_direct.status_code == 409, not_ready_direct.text
    assert not_ready_direct.json()["error"]["code"] == "E_MEDIA_NOT_READY"
    assert claimed_while_not_ready is None, (
        "a not-ready package denial must happen before its one-time token is claimed"
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/vnd.nexus.offline-reading+zip"
    assert response.headers["content-length"] == str(len(response.content))
    assert "content-encoding" not in response.headers
    assert response.headers["nexus-account-id"] == str(viewer_id)
    assert response.headers["nexus-reader-generation"] == "2"
    expected_digest = base64.b64encode(hashlib.sha256(response.content).digest()).decode("ascii")
    assert response.headers["content-digest"] == f"sha-256=:{expected_digest}:"
    verified = verify_offline_reading_zip(response.content)
    assert verified.manifest.media_id == media_id
    assert verified.manifest.reader_generation == 2
    assert verified.reader_document.document_path == "document.pdf"  # type: ignore[union-attr]

    assert replay.status_code == 401, replay.text
    assert replay.json()["error"]["code"] == "E_STREAM_TOKEN_REPLAYED"
    stale_jti = verify_offline_reading_package_token(
        stale_mint.json()["data"]["token"],
        expected_media_id=media_id,
    ).jti
    with Session(engine) as db:
        claimed_jtis = set(
            db.scalars(
                text(
                    """
                    SELECT jti
                    FROM stream_token_jti_claims
                    WHERE jti IN (:stale_jti, :current_jti)
                    """
                ),
                {"stale_jti": stale_jti, "current_jti": current_jti},
            )
        )
    assert claimed_jtis == {current_jti}, (
        "generation denial consumed a one-use token before authorization"
    )
    storage.delete_object(source_path)


def test_article_and_epub_packages_preserve_canonical_reading_inputs_without_remote_fetches(
    engine: Engine,
    tmp_path: Path,
) -> None:
    """PostgreSQL/MinIO publications become self-contained canonical packages."""
    viewer_id = uuid4()
    article_media_id = uuid4()
    article_fragment_ids = (uuid4(), uuid4())
    epub_media_id = uuid4()
    epub_fragment_ids = (uuid4(), uuid4())
    asset_key = "images/canonical.png"
    asset_path = build_epub_attempt_asset_storage_path(epub_media_id, uuid4(), asset_key)
    asset_body = (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89"
    )
    storage = get_storage_client()
    storage.put_object(asset_path, asset_body, "image/png")

    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"offline-projection-{viewer_id}@example.invalid",
        )
        db.add_all(
            (
                Media(
                    id=article_media_id,
                    kind=MediaKind.web_article.value,
                    title="Canonical article",
                    processing_status=ProcessingStatus.extracting,
                    created_by_user_id=viewer_id,
                ),
                Media(
                    id=epub_media_id,
                    kind=MediaKind.epub.value,
                    title="Canonical EPUB",
                    processing_status=ProcessingStatus.extracting,
                    created_by_user_id=viewer_id,
                ),
            )
        )
        db.flush()

        def publish_article(_media: Media) -> None:
            db.add_all(
                (
                    Fragment(
                        id=article_fragment_ids[0],
                        media_id=article_media_id,
                        idx=0,
                        canonical_text="Opening canonical paragraph.",
                        html_sanitized=(
                            '<h2 id="opening">Opening</h2>'
                            "<p>Opening canonical paragraph.</p>"
                            '<img src="https://remote.invalid/tracker.png" alt="Remote diagram">'
                            '<a href="https://remote.invalid/story">Remote link label</a>'
                            '<a href="#opening" ping="https://remote.invalid/beacon">'
                            "Local heading</a>"
                            '<iframe src="https://remote.invalid/embed">Embed label</iframe>'
                        ),
                    ),
                    Fragment(
                        id=article_fragment_ids[1],
                        media_id=article_media_id,
                        idx=1,
                        canonical_text="Closing canonical paragraph.",
                        html_sanitized="<p>Closing canonical paragraph.</p>",
                    ),
                )
            )

        replace_reader_publication(
            db,
            media_id=article_media_id,
            expected_kind=MediaKind.web_article.value,
            replace_projection=publish_article,
        )

        def publish_epub(_media: Media) -> None:
            first = Fragment(
                id=epub_fragment_ids[0],
                media_id=epub_media_id,
                idx=0,
                canonical_text="Opening chapter canonical text.",
                html_sanitized=(
                    '<h1 id="opening">Opening chapter</h1>'
                    "<p>Opening chapter canonical text.</p>"
                    f'<img src="{media_asset_url(epub_media_id, asset_key)}" alt="Local plate">'
                    '<a href="#opening" aria-label="Local heading"'
                    ' ping="https://remote.invalid/beacon"></a>'
                    '<img src="https://remote.invalid/tracker.png" alt="Remote fallback">'
                    '<a href="./chapter-2.xhtml#target">Continue</a>'
                    '<a href="https://remote.invalid/out">External label</a>'
                ),
            )
            second = Fragment(
                id=epub_fragment_ids[1],
                media_id=epub_media_id,
                idx=1,
                canonical_text="Final chapter canonical text.",
                html_sanitized=(
                    '<h2 id="target">Final chapter</h2><p>Final chapter canonical text.</p>'
                ),
            )
            db.add_all((first, second))
            db.flush()
            db.add_all(
                (
                    EpubFragmentSource(
                        media_id=epub_media_id,
                        fragment_id=first.id,
                        package_href="chapter-1.xhtml",
                        manifest_item_id="chapter-1",
                        spine_itemref_id="spine-1",
                        media_type="application/xhtml+xml",
                        linear=True,
                        reading_order=0,
                    ),
                    EpubFragmentSource(
                        media_id=epub_media_id,
                        fragment_id=second.id,
                        package_href="chapter-2.xhtml",
                        manifest_item_id="chapter-2",
                        spine_itemref_id="spine-2",
                        media_type="application/xhtml+xml",
                        linear=True,
                        reading_order=1,
                    ),
                    EpubTocNode(
                        media_id=epub_media_id,
                        node_id="toc-opening",
                        nav_type="toc",
                        parent_node_id=None,
                        label="Opening",
                        href="chapter-1.xhtml#opening",
                        fragment_idx=0,
                        depth=0,
                        order_key="0000",
                    ),
                    EpubTocNode(
                        media_id=epub_media_id,
                        node_id="toc-final",
                        nav_type="toc",
                        parent_node_id=None,
                        label="Final",
                        href="chapter-2.xhtml#target",
                        fragment_idx=1,
                        depth=0,
                        order_key="0001",
                    ),
                    EpubResource(
                        media_id=epub_media_id,
                        manifest_item_id="canonical-image",
                        package_href="images/canonical.png",
                        asset_key=asset_key,
                        storage_path=asset_path,
                        content_type="image/png",
                        size_bytes=len(asset_body),
                        fallback_item_id=None,
                        properties=None,
                    ),
                )
            )
            db.flush()
            db.add_all(
                (
                    EpubNavLocation(
                        media_id=epub_media_id,
                        location_id="section-opening",
                        ordinal=0,
                        source_node_id="toc-opening",
                        label="Opening",
                        fragment_idx=0,
                        href_path="chapter-1.xhtml",
                        href_fragment="opening",
                        start_offset=0,
                        end_offset=31,
                        source="toc",
                    ),
                    EpubNavLocation(
                        media_id=epub_media_id,
                        location_id="section-final",
                        ordinal=1,
                        source_node_id="toc-final",
                        label="Final",
                        fragment_idx=1,
                        href_path="chapter-2.xhtml",
                        href_fragment="target",
                        start_offset=0,
                        end_offset=29,
                        source="toc",
                    ),
                )
            )

        replace_reader_publication(
            db,
            media_id=epub_media_id,
            expected_kind=MediaKind.epub.value,
            replace_projection=publish_epub,
        )
        article_media = db.get(Media, article_media_id)
        epub_media = db.get(Media, epub_media_id)
        assert article_media is not None and epub_media is not None
        article_media.processing_status = ProcessingStatus.ready_for_reading
        epub_media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()

    sessions = sessionmaker(engine, expire_on_commit=False)
    article_package_path = tmp_path / "article.zip"
    epub_package_path = tmp_path / "book.zip"
    try:
        article_archive = build_offline_reading_archive_file(
            sessions,
            media_id=article_media_id,
            path=article_package_path,
        )
        epub_archive = build_offline_reading_archive_file(
            sessions,
            media_id=epub_media_id,
            path=epub_package_path,
        )
    finally:
        storage.delete_object(asset_path)

    article_package = article_package_path.read_bytes()
    epub_package = epub_package_path.read_bytes()
    assert article_archive.compressed_length == len(article_package)
    assert epub_archive.compressed_length == len(epub_package)
    assert article_archive.content_digest == (
        f"sha-256=:{base64.b64encode(hashlib.sha256(article_package).digest()).decode('ascii')}:"
    )
    assert epub_archive.content_digest == (
        f"sha-256=:{base64.b64encode(hashlib.sha256(epub_package).digest()).decode('ascii')}:"
    )

    with zipfile.ZipFile(io.BytesIO(article_package), "r") as package:
        article_names = package.namelist()
        article_manifest = json.loads(package.read("manifest.json"))
        article_reader = json.loads(package.read("reader.json"))
        article_entries = {
            entry["path"]: package.read(entry["path"]) for entry in article_manifest["entries"]
        }

    assert article_names == ["manifest.json", "reader.json"], article_names
    assert {
        "mediaId": article_manifest["mediaId"],
        "mediaKind": article_manifest["mediaKind"],
        "title": article_manifest["title"],
        "readerGeneration": article_manifest["readerGeneration"],
    } == {
        "mediaId": str(article_media_id),
        "mediaKind": "WebArticle",
        "title": "Canonical article",
        "readerGeneration": 1,
    }
    assert [entry["path"] for entry in article_manifest["entries"]] == ["reader.json"]
    assert (
        article_manifest["entries"][0]["sha256"]
        == hashlib.sha256(article_entries["reader.json"]).hexdigest()
    )
    assert article_reader["navigation"] == [
        {"fragmentId": str(article_fragment_ids[0]), "label": "Opening canonical paragraph."},
        {"fragmentId": str(article_fragment_ids[1]), "label": "Closing canonical paragraph."},
    ]
    assert [fragment["canonicalText"] for fragment in article_reader["fragments"]] == [
        "Opening canonical paragraph.",
        "Closing canonical paragraph.",
    ]
    article_html = html.fragments_fromstring(article_reader["fragments"][0]["htmlSanitized"])
    article_elements = [
        element for root in article_html if hasattr(root, "iter") for element in root.iter()
    ]
    article_text = " ".join(element.text_content() for element in article_elements)
    assert not any(element.tag in {"img", "iframe", "script"} for element in article_elements)
    assert "Remote diagram" in article_text
    assert "Remote link label" in article_text
    assert "Embed label" in article_text
    assert not any(
        value.startswith(("http://", "https://", "//"))
        for element in article_elements
        for value in element.attrib.values()
    )
    assert b"remote.invalid" not in article_package

    with zipfile.ZipFile(io.BytesIO(epub_package), "r") as package:
        epub_names = package.namelist()
        epub_manifest = json.loads(package.read("manifest.json"))
        epub_reader = json.loads(package.read("reader.json"))
        epub_entries = {
            entry["path"]: package.read(entry["path"]) for entry in epub_manifest["entries"]
        }

    assert epub_names == ["manifest.json", f"assets/{asset_key}", "reader.json"], epub_names
    assert {
        "mediaId": epub_manifest["mediaId"],
        "mediaKind": epub_manifest["mediaKind"],
        "title": epub_manifest["title"],
        "readerGeneration": epub_manifest["readerGeneration"],
    } == {
        "mediaId": str(epub_media_id),
        "mediaKind": "Epub",
        "title": "Canonical EPUB",
        "readerGeneration": 1,
    }
    assert [entry["path"] for entry in epub_manifest["entries"]] == [
        f"assets/{asset_key}",
        "reader.json",
    ]
    assert epub_entries[f"assets/{asset_key}"] == asset_body
    assert all(
        entry["sha256"] == hashlib.sha256(epub_entries[entry["path"]]).hexdigest()
        for entry in epub_manifest["entries"]
    )
    assert epub_reader["navigation"] == [
        {"sectionId": "section-opening", "label": "Opening"},
        {"sectionId": "section-final", "label": "Final"},
    ]
    assert [section["canonicalText"] for section in epub_reader["sections"]] == [
        "Opening chapter canonical text.",
        "Final chapter canonical text.",
    ]
    assert [
        {
            key: section[key]
            for key in (
                "sectionId",
                "ordinal",
                "fragmentId",
                "fragmentIdx",
                "hrefPath",
                "anchorId",
                "startOffset",
                "endOffset",
            )
        }
        for section in epub_reader["sections"]
    ] == [
        {
            "sectionId": "section-opening",
            "ordinal": 0,
            "fragmentId": str(epub_fragment_ids[0]),
            "fragmentIdx": 0,
            "hrefPath": "chapter-1.xhtml",
            "anchorId": "opening",
            "startOffset": 0,
            "endOffset": 31,
        },
        {
            "sectionId": "section-final",
            "ordinal": 1,
            "fragmentId": str(epub_fragment_ids[1]),
            "fragmentIdx": 1,
            "hrefPath": "chapter-2.xhtml",
            "anchorId": "target",
            "startOffset": 0,
            "endOffset": 29,
        },
    ]
    assert epub_reader["sections"][0]["assetPaths"] == [f"assets/{asset_key}"]
    assert epub_reader["sections"][1]["assetPaths"] == []
    first_section = html.fragments_fromstring(epub_reader["sections"][0]["htmlSanitized"])
    epub_elements = [
        element for root in first_section if hasattr(root, "iter") for element in root.iter()
    ]
    images = [element for element in epub_elements if element.tag == "img"]
    assert [dict(image.attrib) for image in images] == [
        {"src": f"assets/{asset_key}", "alt": "Local plate"}
    ], "a retained package image must keep its accessible name and nothing addressable"
    epub_text = " ".join(element.text_content() for element in epub_elements)
    assert "Remote fallback" in epub_text
    assert "External label" in epub_text
    continuation = next(
        element for element in epub_elements if element.text_content() == "Continue"
    )
    assert continuation.attrib == {
        "href": "#target",
        "data-nexus-section-id": "section-final",
    }
    local_heading = next(
        element for element in epub_elements if element.get("aria-label") == "Local heading"
    )
    assert local_heading.attrib == {
        "href": "#opening",
        "aria-label": "Local heading",
        "data-nexus-section-id": "section-opening",
    }
    assert not any(
        value.startswith(("http://", "https://", "//"))
        for section in epub_reader["sections"]
        for root in html.fragments_fromstring(section["htmlSanitized"])
        if hasattr(root, "iter")
        for element in root.iter()
        for value in element.attrib.values()
    )
    assert b"remote.invalid" not in epub_package


@dataclass(frozen=True, slots=True)
class _ReadyArticle:
    """One committed, ready web-article publication the direct route can package."""

    viewer_id: UUID
    email: str
    default_library_id: UUID
    media_id: UUID
    generation: int


def _commit_ready_article(engine: Engine, *, title: str) -> _ReadyArticle:
    viewer_id = uuid4()
    email = f"offline-package-{viewer_id}@example.invalid"
    media_id = uuid4()
    with Session(engine) as db:
        default_library_id = ensure_user_and_default_library(db, viewer_id, email)
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=title,
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind=MediaKind.web_article.value,
            replace_projection=lambda _media: db.add(
                Fragment(
                    id=uuid4(),
                    media_id=media_id,
                    idx=0,
                    canonical_text=f"{title} canonical text.",
                    html_sanitized=f"<p>{title} canonical text.</p>",
                )
            ),
        )
        media = db.get(Media, media_id)
        assert media is not None
        media.processing_status = ProcessingStatus.ready_for_reading
        db.commit()
    return _ReadyArticle(
        viewer_id=viewer_id,
        email=email,
        default_library_id=default_library_id,
        media_id=media_id,
        generation=1,
    )


def _package_app(
    verifier: StaticTokenVerifier,
    *,
    requires_internal_header: bool = False,
    internal_secret: str | None = None,
) -> FastAPI:
    """The production FastAPI stack with only external token verification controlled."""
    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=requires_internal_header,
            internal_secret=internal_secret,
            bootstrap_callback=None,
        )
    )
    add_request_id_middleware(app, log_requests=False)
    return app


def _claimed_jtis(engine: Engine, jtis: tuple[str, ...]) -> set[str]:
    with Session(engine) as db:
        return set(
            db.scalars(
                text("SELECT jti FROM stream_token_jti_claims WHERE jti = ANY(:jtis)"),
                {"jtis": list(jtis)},
            )
        )


def _await_blocked_projection_reads(engine: Engine, *, expected: int) -> None:
    """Wait until `expected` package assemblies are blocked reading `fragments`."""
    deadline = time.monotonic() + 60.0
    observed = -1
    while time.monotonic() < deadline:
        with Session(engine) as db:
            observed = int(
                db.scalar(
                    text(
                        """
                        SELECT count(*)
                        FROM pg_locks lock_row
                        JOIN pg_class relation ON relation.oid = lock_row.relation
                        WHERE relation.relname = 'fragments'
                          AND lock_row.database = (
                              SELECT oid FROM pg_database WHERE datname = current_database()
                          )
                          AND NOT lock_row.granted
                        """
                    )
                )
                or 0
            )
            if observed >= expected:
                return
            db.execute(text("SELECT pg_sleep(0.02)"))
    raise AssertionError(
        "package assemblies never reached their blocked projection read: "
        f"expected at least {expected}, observed {observed}"
    )


def _package_temp_files() -> set[str]:
    return set(glob.glob(os.path.join(tempfile.gettempdir(), _PACKAGE_TEMP_FILE_GLOB)))


def _await_reclaimed(staged: set[str]) -> None:
    deadline = time.monotonic() + 30.0
    remaining = staged
    while time.monotonic() < deadline:
        remaining = {path for path in staged if os.path.exists(path)}
        if not remaining:
            return
    raise AssertionError(
        f"abandoned package response files were never reclaimed: {sorted(remaining)}"
    )


def _get_package(app: FastAPI, article: _ReadyArticle, token: str) -> httpx.Response:
    # No lifespan: concurrent scenarios drive one app from several threads and
    # must not race one another's startup/shutdown state.
    client = TestClient(app)
    return client.get(
        f"/offline-reading/packages/{article.media_id}",
        headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
    )


def _refused_promptly(call: Future[httpx.Response]) -> httpx.Response:
    try:
        return call.result(timeout=60)
    except FutureTimeoutError as exc:
        raise AssertionError(
            "an over-capacity package request was admitted into a blocked assembly "
            "instead of being refused"
        ) from exc


def _mint(article: _ReadyArticle) -> tuple[str, str]:
    minted = mint_offline_reading_package_token(
        user_id=article.viewer_id,
        media_id=article.media_id,
        reader_generation=article.generation,
    )
    jti = verify_offline_reading_package_token(
        minted.token,
        expected_media_id=article.media_id,
    ).jti
    return minted.token, jti


def test_production_internal_header_posture_admits_only_the_direct_package_route(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prod requires X-Nexus-Internal; only this exact path may arrive without it.

    Caddy proxies the APK's package GET straight to the API with no internal
    header, so the path exemption must be evaluated before that check while every
    neighbouring and unrouted path keeps failing closed. The same request carries
    a browser Origin to prove the native lane emits no CORS while stream CORS is
    unchanged.
    """
    article = _commit_ready_article(engine, title="Production posture article")
    internal_secret = f"offline-reading-internal-{uuid4()}"
    browser_origin = get_settings().app_public_url.rstrip("/")
    monkeypatch.setenv("STREAM_CORS_ORIGINS", browser_origin)
    clear_settings_cache()
    try:
        verifier = StaticTokenVerifier(article.viewer_id, article.email)
        app = _package_app(
            verifier,
            requires_internal_header=True,
            internal_secret=internal_secret,
        )
        bearer = {"Authorization": f"Bearer {verifier.token}"}
        with TestClient(app) as client:
            mint = client.post(
                f"/internal/media/{article.media_id}/offline-reading-token",
                headers={**bearer, "X-Nexus-Internal": internal_secret},
            )
            mint_without_internal = client.post(
                f"/internal/media/{article.media_id}/offline-reading-token",
                headers=bearer,
            )
            binding_without_internal = client.get(
                "/internal/offline-reading/account-binding",
                headers=bearer,
            )
            package_token = mint.json()["data"]["token"]
            package_bearer = {"Authorization": f"Bearer {package_token}"}
            direct = client.get(
                f"/offline-reading/packages/{article.media_id}",
                headers={
                    **package_bearer,
                    "Accept-Encoding": "identity",
                    "Origin": browser_origin,
                },
            )
            unrouted_child = client.get(
                f"/offline-reading/packages/{article.media_id}/extra",
                headers=package_bearer,
            )
            non_canonical_path = client.get(
                "/offline-reading/packages/not-a-uuid",
                headers=package_bearer,
            )
            stream_preflight = client.options(
                f"/stream/chat-runs/{uuid4()}",
                headers={
                    "Origin": browser_origin,
                    "Access-Control-Request-Method": "GET",
                },
            )
    finally:
        clear_settings_cache()

    assert mint.status_code == 200, mint.text
    assert mint_without_internal.status_code == 403, mint_without_internal.text
    assert mint_without_internal.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert binding_without_internal.status_code == 403, binding_without_internal.text
    assert binding_without_internal.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert direct.status_code == 200, (
        "the direct package route must serve a Caddy-forwarded request that carries "
        f"only its scoped token: {direct.status_code} {direct.text[:200]}"
    )
    assert direct.headers["nexus-account-id"] == str(article.viewer_id)
    assert direct.headers["content-type"] == "application/vnd.nexus.offline-reading+zip"
    assert [name for name in direct.headers if name.lower().startswith("access-control-")] == [], (
        f"the native package lane emitted browser CORS headers: {dict(direct.headers)}"
    )
    assert unrouted_child.status_code == 403, unrouted_child.text
    assert unrouted_child.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert non_canonical_path.status_code == 403, non_canonical_path.text
    assert non_canonical_path.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert stream_preflight.status_code == 204, stream_preflight.text
    assert stream_preflight.headers["access-control-allow-origin"] == browser_origin


def test_package_route_refuses_foreign_or_revoked_visibility_before_claiming_its_token(
    engine: Engine,
) -> None:
    """A signed token is not read authority: current visibility decides, before the claim.

    Visibility can be revoked inside the token's 300-second lifetime, and a token
    minted for another account must never resolve, so both denials must produce no
    package and must leave the one-use JTI unclaimed for the legitimate holder.
    """
    article = _commit_ready_article(engine, title="Revoked visibility article")
    stranger_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            stranger_id,
            f"offline-package-stranger-{stranger_id}@example.invalid",
        )
        db.commit()
    foreign = mint_offline_reading_package_token(
        user_id=stranger_id,
        media_id=article.media_id,
        reader_generation=article.generation,
    )
    foreign_jti = verify_offline_reading_package_token(
        foreign.token,
        expected_media_id=article.media_id,
    ).jti
    owner_token, owner_jti = _mint(article)

    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app = _package_app(verifier)
    with TestClient(app) as client:
        path = f"/offline-reading/packages/{article.media_id}"
        foreign_response = client.get(
            path,
            headers={"Authorization": f"Bearer {foreign.token}"},
        )
        with Session(engine) as db:
            removed = delete_entry(db, article.default_library_id, media_target(article.media_id))
            db.commit()
        revoked_response = client.get(
            path,
            headers={"Authorization": f"Bearer {owner_token}"},
        )

    assert removed, "the fixture never removed the library entry it meant to revoke"
    assert foreign_response.status_code == 404, foreign_response.text
    assert foreign_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
    assert revoked_response.status_code == 404, (
        "a token minted before visibility was revoked still produced a package: "
        f"{revoked_response.status_code} {revoked_response.text[:200]}"
    )
    assert revoked_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
    assert _claimed_jtis(engine, (foreign_jti, owner_jti)) == set(), (
        "an authorization denial consumed a one-use package token"
    )


def test_concurrent_package_assemblies_are_bounded_and_reject_before_the_token_claim(
    engine: Engine,
) -> None:
    """Admission, not the mintable token, bounds this route's assembly resources.

    Each admitted assembly owns a worker thread, a staging directory, and a
    response file bounded at 512 MiB, so an over-capacity request must be refused
    with a retryable code that leaves its one-use token spendable.
    """
    article = _commit_ready_article(engine, title="Bounded assembly article")
    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app = _package_app(verifier)
    admitted_tokens = [_mint(article) for _ in range(PACKAGE_ASSEMBLY_MAX_CONCURRENCY)]
    rejected_token, rejected_jti = _mint(article)
    later_token, later_jti = _mint(article)

    with (
        ThreadPoolExecutor(max_workers=PACKAGE_ASSEMBLY_MAX_CONCURRENCY + 1) as pool,
        Session(engine) as blocker,
    ):
        blocker.execute(text("LOCK TABLE fragments IN ACCESS EXCLUSIVE MODE"))
        try:
            running = [
                pool.submit(_get_package, app, article, token) for token, _jti in admitted_tokens
            ]
            _await_blocked_projection_reads(engine, expected=PACKAGE_ASSEMBLY_MAX_CONCURRENCY)
            # Over capacity the answer must be immediate. An admitted request
            # would instead join the blocked assemblies and never answer here.
            rejected = _refused_promptly(pool.submit(_get_package, app, article, rejected_token))
        finally:
            blocker.rollback()
        admitted = [call.result(timeout=180) for call in running]
    after_capacity_returns = _get_package(app, article, later_token)

    assert rejected.status_code == 503, (
        "an over-capacity package request was admitted instead of refused: "
        f"{rejected.status_code} {rejected.text[:200]}"
    )
    assert rejected.json()["error"]["code"] == "E_OFFLINE_READING_PACKAGE_BUSY"
    assert [response.status_code for response in admitted] == [200 for _ in admitted_tokens], [
        response.text[:200] for response in admitted
    ]
    assert after_capacity_returns.status_code == 200, (
        "an assembly slot was never returned after its request completed: "
        f"{after_capacity_returns.status_code} {after_capacity_returns.text[:200]}"
    )
    assert _claimed_jtis(
        engine,
        (*(jti for _token, jti in admitted_tokens), rejected_jti, later_jti),
    ) == {*(jti for _token, jti in admitted_tokens), later_jti}, (
        "the capacity refusal consumed the one-use token its caller can still spend"
    )


def _drive_disconnecting_package_request(
    app: FastAPI,
    article: _ReadyArticle,
    token: str,
    disconnect: threading.Event,
) -> list[dict[str, Any]]:
    """Drive one real ASGI request whose client vanishes mid-assembly."""
    path = f"/offline-reading/packages/{article.media_id}"
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"accept-encoding", b"identity"),
        ],
        "client": ("127.0.0.1", 41234),
        "server": ("testserver", 80),
        "state": {},
    }
    sent: list[dict[str, Any]] = []
    request_delivered = threading.Event()

    async def receive() -> dict[str, Any]:
        if not request_delivered.is_set():
            request_delivered.set()
            return {"type": "http.request", "body": b"", "more_body": False}
        # An ASGI server reports the disconnect exactly once the peer is gone.
        await asyncio.get_running_loop().run_in_executor(None, disconnect.wait)
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    return sent


def test_client_disconnect_during_assembly_reclaims_its_response_file(
    engine: Engine,
) -> None:
    """An abandoned transfer converges at the disconnect, not at the 540s deadline."""
    article = _commit_ready_article(engine, title="Disconnect reclaim article")
    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app = _package_app(verifier)
    token, jti = _mint(article)
    disconnect = threading.Event()
    before = _package_temp_files()

    with ThreadPoolExecutor(max_workers=1) as pool, Session(engine) as blocker:
        blocker.execute(text("LOCK TABLE fragments IN ACCESS EXCLUSIVE MODE"))
        try:
            call = pool.submit(
                _drive_disconnecting_package_request, app, article, token, disconnect
            )
            _await_blocked_projection_reads(engine, expected=1)
            staged = _package_temp_files() - before
            started = time.monotonic()
            disconnect.set()
            try:
                sent = call.result(timeout=90)
            except FutureTimeoutError as exc:
                raise AssertionError(
                    "the route never observed its client disconnect: the request was "
                    "still assembling 90s after the peer went away"
                ) from exc
            observed_seconds = time.monotonic() - started
        finally:
            blocker.rollback()
        _await_reclaimed(staged)

    assert len(staged) == 1, (
        f"expected exactly one staged package response file, observed {sorted(staged)}"
    )
    assert observed_seconds < 60, (
        "the route waited for its cooperative deadline instead of observing the "
        f"client disconnect: {observed_seconds:.1f}s"
    )
    start = next(message for message in sent if message["type"] == "http.response.start")
    assert start["status"] == 499, sent
    assert _claimed_jtis(engine, (jti,)) == {jti}, (
        "the disconnected transfer must still have spent its one-use token"
    )
