"""Oracle publication input identity is strict, stable, and independently reviewable."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from nexus.oracle.manifest import load_oracle_manifest

_WORK = {
    "work_key": "work",
    "title": "Title",
    "author_text": "Author",
    "source_repository": "repo",
    "source_url": "https://example.invalid/work",
    "source_download_url": "https://example.invalid/work.txt",
    "source_media_kind": "web_article",
    "display_order": 1,
    "passage_anchors": [
        {
            "passage_key": "passage",
            "display_label": "Passage",
            "selector": {"kind": "text_quote", "exact": "Words"},
            "tags": ["x"],
            "phase_hints": [],
        }
    ],
}
_PLATE = {
    "source_repository": "repo",
    "source_url": "https://example.invalid/page",
    "artist": "Artist",
    "work_title": "Plate",
    "year": None,
    "attribution_text": "Attribution",
    "resolved_source_url": "https://example.invalid/plate.jpg",
    "tags": ["x"],
}


def _write_manifest(directory: Path, *, works: list[dict], plates: list[dict]) -> None:
    directory.mkdir()
    (directory / "manifest_works.json").write_text(json.dumps(works), encoding="utf-8")
    (directory / "manifest_plates.json").write_text(json.dumps(plates), encoding="utf-8")


def test_manifest_digest_is_the_reviewed_canonical_input_identity(tmp_path: Path) -> None:
    manifest_directory = tmp_path / "oracle"
    _write_manifest(manifest_directory, works=[_WORK], plates=[_PLATE])

    manifest = load_oracle_manifest(manifest_directory)

    assert manifest.manifest_digest == (
        "sha256:949ae1081542bb75673f6e5bb7baa9c9e5881431f24c3008dcf14ea863f23752"
    )
    assert manifest.works[0].work_key == "work"
    assert manifest.plates[0].license_text == "public domain"


@pytest.mark.parametrize(
    ("works", "plates"),
    [
        ([{**_WORK, "unexpected": True}], [_PLATE]),
        ([{**_WORK, "display_order": "1"}], [_PLATE]),
        ([{**_WORK, "source_download_url": "file:///tmp/work.txt"}], [_PLATE]),
        ([_WORK, _WORK], [_PLATE]),
        ([_WORK], [_PLATE, _PLATE]),
        (
            [
                {
                    **_WORK,
                    "passage_anchors": [
                        _WORK["passage_anchors"][0],
                        _WORK["passage_anchors"][0],
                    ],
                }
            ],
            [_PLATE],
        ),
    ],
    ids=(
        "extra-field",
        "type-coercion",
        "invalid-url",
        "duplicate-work",
        "duplicate-plate",
        "duplicate-anchor",
    ),
)
def test_manifest_rejects_ambiguous_or_unowned_inputs(
    tmp_path: Path,
    works: list[dict],
    plates: list[dict],
) -> None:
    manifest_directory = tmp_path / "oracle"
    _write_manifest(manifest_directory, works=works, plates=plates)

    with pytest.raises((ValidationError, ValueError)):
        load_oracle_manifest(manifest_directory)


def test_manifest_rejects_duplicate_json_object_keys(tmp_path: Path) -> None:
    manifest_directory = tmp_path / "oracle"
    _write_manifest(manifest_directory, works=[_WORK], plates=[_PLATE])
    raw = (manifest_directory / "manifest_works.json").read_text(encoding="utf-8")
    (manifest_directory / "manifest_works.json").write_text(
        raw.replace('"title": "Title"', '"title": "First", "title": "Title"'),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicate JSON object key.*title"):
        load_oracle_manifest(manifest_directory)
