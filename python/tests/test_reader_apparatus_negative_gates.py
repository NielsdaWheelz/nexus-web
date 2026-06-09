"""Static negative gates for source-authored reader apparatus ownership."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_ROOT = _REPO_ROOT / "apps" / "web" / "src"


def test_reader_apparatus_not_parsed_in_html_renderer():
    renderer_path = _WEB_ROOT / "components" / "HtmlRenderer.tsx"
    text = renderer_path.read_text(encoding="utf-8")
    forbidden = re.compile(
        r"footnote|endnote|noteref|biblioref|data-reader-apparatus|reader-apparatus",
        re.IGNORECASE,
    )

    assert not forbidden.search(text), "HtmlRenderer must not parse source-authored apparatus"


def test_reader_apparatus_not_written_by_retrieval_citation_service():
    citation_path = _PY_ROOT / "services" / "retrieval_citation.py"
    text = citation_path.read_text(encoding="utf-8")

    assert "reader_apparatus" not in text
    assert "reader-apparatus" not in text


def test_reader_apparatus_surface_not_registered_under_conversation_context():
    model_path = _WEB_ROOT / "lib" / "panes" / "paneSecondaryModel.ts"
    text = model_path.read_text(encoding="utf-8")
    bad_registration = re.compile(
        r'id:\s*"reader-apparatus"[\s\S]{0,160}?groupId:\s*"conversation-context"'
    )

    assert not bad_registration.search(text)
