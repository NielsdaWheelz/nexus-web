"""The worker's path projection preserves the existing browser URL spelling."""

import json
from pathlib import Path

from nexus.services.reader_publication_anchors import normalize_epub_lookup_paths


def test_epub_pathnames_preserve_browser_unicode_percent_and_relative_semantics() -> None:
    cases = json.loads(
        (Path(__file__).parents[3] / "testdata/offline-reading/epub-pathnames.json").read_text()
    )["cases"]
    assert normalize_epub_lookup_paths(case["href"] for case in cases) == {
        case["href"]: case["pathname"] for case in cases
    }
