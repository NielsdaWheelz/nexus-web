"""Hermetic seed objects for the oracle corpus.

Uploads a single bundled public-domain fixture plate into object storage so
dev/test/e2e flows have a real current Oracle plate object to point at. No
network, no Wikimedia. Idempotent.
"""

from pathlib import Path

from nexus.storage.client import StorageClientBase

# Compile-time size constant for the committed fixture
# (python/nexus/oracle/fixtures/seed_plate.jpg).
FIXTURE_BYTES = 9382
FIXTURE_CONTENT_TYPE = "image/jpeg"
FIXTURE_STORAGE_KEY = "oracle/plates/seed-plate.jpg"

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "seed_plate.jpg"


def ensure_oracle_seed_objects(storage: StorageClientBase) -> None:
    """Idempotently upload the bundled fixture plate to its current storage key."""
    data = _FIXTURE_PATH.read_bytes()
    if len(data) != FIXTURE_BYTES:
        raise RuntimeError("Oracle seed fixture does not match expected size")
    if storage.head_object(FIXTURE_STORAGE_KEY) is None:
        storage.put_object(FIXTURE_STORAGE_KEY, data, FIXTURE_CONTENT_TYPE)
