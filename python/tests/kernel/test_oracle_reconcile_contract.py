"""The Oracle operator binds one baked manifest identity before any command."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nexus.ops.oracle_reconcile import bind_oracle_reconcile_inputs
from nexus.release_artifact import RuntimeIdentity


def _manifest_directory(tmp_path: Path) -> Path:
    directory = tmp_path / "oracle"
    directory.mkdir()
    (directory / "manifest_works.json").write_text(
        json.dumps(
            [
                {
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
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    (directory / "manifest_plates.json").write_text(
        json.dumps(
            [
                {
                    "source_repository": "repo",
                    "source_url": "https://example.invalid/plate.jpg",
                    "artist": "Artist",
                    "work_title": "Plate",
                    "attribution_text": "Attribution",
                    "resolved_source_url": "https://example.invalid/plate-bytes.jpg",
                }
            ]
        ),
        encoding="utf-8",
    )
    return directory


def test_reconcile_inputs_require_manifest_argument_record_and_runtime_to_match(
    tmp_path: Path,
) -> None:
    directory = _manifest_directory(tmp_path)
    digest = "sha256:20b33f486bb0f84020d96b7b5861021eda716ce2a51613cd6a63322cf960723e"
    runtime = RuntimeIdentity(
        source_sha="a" * 40,
        expected_database_revision="0211",
        expected_oracle_manifest_digest=digest,
    )

    inputs = bind_oracle_reconcile_inputs(
        manifest_directory=directory,
        expected_manifest_digest=digest,
        runtime_identity=runtime,
    )

    assert inputs.manifest.manifest_digest == digest
    with pytest.raises(ValueError, match="recorded expected Oracle manifest digest"):
        bind_oracle_reconcile_inputs(
            manifest_directory=directory,
            expected_manifest_digest="sha256:" + "0" * 64,
            runtime_identity=runtime,
        )
