"""Ensure committed Oracle seed objects exist in configured object storage."""

from nexus.oracle.seed_objects import FIXTURE_STORAGE_KEY, ensure_oracle_seed_objects
from nexus.storage.client import get_storage_client


def main() -> int:
    ensure_oracle_seed_objects(get_storage_client())
    print(f"ensured {FIXTURE_STORAGE_KEY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
