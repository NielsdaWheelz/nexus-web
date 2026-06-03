from nexus.oracle.seed_objects import (
    FIXTURE_BYTES,
    FIXTURE_CONTENT_TYPE,
    FIXTURE_STORAGE_KEY,
    ensure_oracle_seed_objects,
)
from tests.support.storage import FakeStorageClient


def test_ensure_oracle_seed_objects_uploads_fixture_once():
    storage = FakeStorageClient()

    ensure_oracle_seed_objects(storage)
    first_object = storage.get_object(FIXTURE_STORAGE_KEY)

    ensure_oracle_seed_objects(storage)

    metadata = storage.head_object(FIXTURE_STORAGE_KEY)
    assert first_object is not None
    assert len(first_object) == FIXTURE_BYTES
    assert metadata is not None
    assert metadata.content_type == FIXTURE_CONTENT_TYPE
    assert storage.get_object(FIXTURE_STORAGE_KEY) == first_object
