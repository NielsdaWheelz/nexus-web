import pytest
from pydantic import ValidationError

from nexus.schemas.vault import VaultFile, VaultSyncRequest

pytestmark = pytest.mark.unit


def test_vault_sync_request_forbids_unknown_top_level_fields():
    with pytest.raises(ValidationError):
        VaultSyncRequest(files=[], unexpected=True)


def test_vault_file_forbids_unknown_transport_fields():
    with pytest.raises(ValidationError):
        VaultFile(path="Pages/note.md", content="body", checksum="ignored")


def test_vault_sync_request_accepts_known_file_fields():
    request = VaultSyncRequest(
        files=[VaultFile(path="Pages/note.md", content="body")],
    )

    assert request.files[0].path == "Pages/note.md"
