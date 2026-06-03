"""Hermetic seed objects for the oracle corpus.

Uploads a single bundled public-domain fixture plate into object storage so the
0127 migration's NOT NULL backfill and dev/test/e2e flows have a real object to
point at. No network, no Wikimedia. Idempotent.
"""

import hashlib
from pathlib import Path

from nexus.storage.client import StorageClientBase

# Compile-time constants of the committed fixture (python/nexus/oracle/fixtures/seed_plate.jpg).
# The 0127 migration bakes these same literals into its backfill; keep them in lockstep.
FIXTURE_SHA256 = "451cc39a41ea2a2b1bb0dccc9e58df2c7908bd0bac67d219878bf767234a8fa3"
FIXTURE_BYTES = 9382
FIXTURE_CONTENT_TYPE = "image/jpeg"
FIXTURE_STORAGE_KEY = f"oracle/plates/{FIXTURE_SHA256}.jpg"

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "seed_plate.jpg"


def ensure_oracle_seed_objects(storage: StorageClientBase) -> None:
    """Idempotently upload the bundled fixture plate to its content-addressed key."""
    data = _FIXTURE_PATH.read_bytes()
    # justify-defect: the migration backfill and model seed bake in the fixture's
    # sha256+size as literals; a committed fixture that no longer matches is a build defect.
    if len(data) != FIXTURE_BYTES or hashlib.sha256(data).hexdigest() != FIXTURE_SHA256:
        raise RuntimeError("Oracle seed fixture does not match expected sha256/size")
    if storage.head_object(FIXTURE_STORAGE_KEY) is None:
        storage.put_object(FIXTURE_STORAGE_KEY, data, FIXTURE_CONTENT_TYPE)
