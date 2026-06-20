import pytest
from pydantic import ValidationError

from nexus.schemas.vault import (
    VaultConflictOut,
    VaultEditableFileIn,
    VaultProjectedFileOut,
    VaultSnapshotOut,
    VaultSyncRequest,
)

pytestmark = pytest.mark.unit


def test_vault_sync_request_rejects_missing_files():
    with pytest.raises(ValidationError):
        VaultSyncRequest()


def test_vault_sync_request_accepts_empty_files_list():
    request = VaultSyncRequest(files=[])

    assert request.files == []


def test_vault_sync_request_forbids_unknown_top_level_fields():
    with pytest.raises(ValidationError):
        VaultSyncRequest(files=[], unexpected=True)


def test_vault_editable_file_rejects_missing_path():
    with pytest.raises(ValidationError):
        VaultEditableFileIn(content="body")


def test_vault_editable_file_rejects_missing_content():
    with pytest.raises(ValidationError):
        VaultEditableFileIn(path="Pages/note.md")


def test_vault_editable_file_forbids_unknown_transport_fields():
    with pytest.raises(ValidationError):
        VaultEditableFileIn(path="Pages/note.md", content="body", checksum="ignored")


@pytest.mark.parametrize(
    "path",
    [
        " Pages/note.md ",
        "/Pages/note.md",
        r"Pages\note.md",
        "Pages/../note.md",
        "Pages/sub/note.md",
        "Pages/.md",
        "Highlights/broken.conflict.md",
        "Highlights/note.txt",
        "Library.md",
        "Media/source.md",
        "Sources/source.md",
    ],
)
def test_vault_editable_file_rejects_invalid_editable_paths(path: str):
    with pytest.raises(ValidationError):
        VaultEditableFileIn(path=path, content="body")


@pytest.mark.parametrize("path", ["Highlights/highlight.md", "Pages/page.md"])
def test_vault_sync_request_accepts_known_file_fields(path: str):
    request = VaultSyncRequest(
        files=[VaultEditableFileIn(path=path, content="body")],
    )

    assert request.files[0].path == path


def test_vault_editable_file_enforces_utf8_byte_size_limit():
    VaultEditableFileIn(path="Pages/note.md", content="é" * 500_000)

    with pytest.raises(ValidationError):
        VaultEditableFileIn(path="Pages/note.md", content=("é" * 500_000) + "a")


def test_vault_snapshot_uses_projected_files_without_editable_path_rules():
    snapshot = VaultSnapshotOut(
        files=[
            VaultProjectedFileOut(path="Library.md", content="library"),
            VaultProjectedFileOut(path="Media/source.md", content="media"),
        ],
        conflicts=[
            VaultConflictOut(
                path="Pages/broken.conflict.md",
                message="Vault page metadata is missing title",
                content="conflict",
            )
        ],
    )

    assert [file.path for file in snapshot.files] == ["Library.md", "Media/source.md"]
    assert snapshot.conflicts[0].path == "Pages/broken.conflict.md"
