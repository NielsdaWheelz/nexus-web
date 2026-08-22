"""Priority proof: an EPUB 2 book's inert doctypes and named entities stay readable.

An XHTML 1.1 doctype, an NCX doctype, and HTML named entities are inert markup a
conformant reading system resolves locally. Rejecting any of them would refuse a
whole legacy corpus that has nothing wrong with it.
"""

from __future__ import annotations

import hashlib
from uuid import uuid4

from nexus.config import get_settings
from nexus.services.epub_ingest import EpubExtractionPlan, build_epub_extraction_plan
from tests.testkit.epub_fixtures import (
    EPUB2_NCX,
    ChunkedSourceStorage,
    ReservationSession,
    epub2_payload,
)


def test_epub2_public_doctype_and_named_entities_publish_readable_chapters() -> None:
    payload = epub2_payload(
        chapter=b"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"
  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><p>Call&nbsp;me Ishmael&mdash;some years ago.</p></body></html>""",
        ncx=EPUB2_NCX,
    )
    attempt_id = uuid4()

    plan = build_epub_extraction_plan(
        session_factory=lambda: ReservationSession(),
        media_id=uuid4(),
        attempt_id=attempt_id,
        storage_path="sources/epub2-legacy.epub",
        source_size_bytes=len(payload),
        expected_source_sha256=hashlib.sha256(payload).hexdigest(),
        storage_client=ChunkedSourceStorage(payload),
        record_progress=lambda _completed, _total, _unit: None,
    )

    assert isinstance(plan, EpubExtractionPlan), f"EPUB 2 book was rejected: {plan!r}"
    assert plan.result.chapter_count == 1
    fragment = plan.fragment_specs[0][0]
    assert "Call\u00a0me Ishmael\u2014some years ago." in fragment.html_sanitized
    assert "Ishmael\u2014some years ago." in fragment.canonical_text
    assert [node.label for node in plan.toc_nodes] == ["Chapter\u00a0One"], (
        f"the NCX table of contents was not read: {[node.label for node in plan.toc_nodes]!r}"
    )
    assert not (get_settings().parser_temp_root / str(attempt_id)).exists()
