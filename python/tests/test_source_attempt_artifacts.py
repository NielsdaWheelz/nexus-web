from nexus.services.source_attempt_artifacts import (
    clone_source_payload_for_new_attempt,
    source_attempt_storage_paths,
)


def test_source_attempt_storage_paths_collects_top_level_and_nested_artifacts():
    assert source_attempt_storage_paths(
        {
            "storage_path": "media/source.html",
            "arxiv_source_package": {
                "status": "fetched",
                "storage_path": "media/source.tar",
            },
        }
    ) == ["media/source.html", "media/source.tar"]


def test_source_attempt_storage_paths_dedupes_and_ignores_malformed_values():
    assert source_attempt_storage_paths(
        {
            "storage_path": "media/source.tar",
            "arxiv_source_package": {"storage_path": "media/source.tar"},
            "unexpected": {"storage_path": "media/ignored.bin"},
        }
    ) == ["media/source.tar"]
    assert (
        source_attempt_storage_paths(
            {
                "storage_path": "",
                "arxiv_source_package": {"storage_path": 123},
            }
        )
        == []
    )


def test_clone_source_payload_for_new_attempt_strips_derived_artifacts_only():
    payload = clone_source_payload_for_new_attempt(
        {
            "remote_kind": "pdf",
            "storage_path": "media/source.html",
            "arxiv_source_package": {
                "status": "fetched",
                "storage_path": "media/source.tar",
            },
        }
    )

    assert payload == {
        "remote_kind": "pdf",
        "storage_path": "media/source.html",
    }
