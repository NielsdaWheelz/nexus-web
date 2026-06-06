"""Copy pre-cutover Oracle plate objects to stable current storage keys.

Run this before Alembic revision 0137 when the database still has
``oracle_corpus_images.sha256`` and the old content-addressed storage keys.
The script is intentionally fail-closed: every destination object must exist
with the expected content type and byte size before the DB migration rewrites
``oracle_corpus_images.storage_key``.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import create_session_factory
from nexus.storage.client import StorageClientBase, get_storage_client


@dataclass(frozen=True)
class PlateRepairRow:
    image_id: UUID
    work_title: str
    source_key: str
    destination_key: str
    content_type: str
    byte_size: int


def _stable_plate_key(*, image_id: UUID, work_title: str, content_type: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", work_title.lower()).strip("-") or "plate"
    slug = slug[:96]
    extension = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(content_type, ".webp")
    return f"oracle/plates/{slug}-{str(image_id)[:8]}{extension}"


def _load_rows() -> list[PlateRepairRow]:
    session_factory = create_session_factory()
    with session_factory() as db:
        rows = (
            db.execute(
                text(
                    """
                    SELECT id, work_title, storage_key, content_type, byte_size
                    FROM oracle_corpus_images
                    ORDER BY id
                    """
                )
            )
            .mappings()
            .all()
        )
    result: list[PlateRepairRow] = []
    for row in rows:
        image_id = UUID(str(row["id"]))
        destination_key = _stable_plate_key(
            image_id=image_id,
            work_title=str(row["work_title"] or ""),
            content_type=str(row["content_type"] or ""),
        )
        result.append(
            PlateRepairRow(
                image_id=image_id,
                work_title=str(row["work_title"] or ""),
                source_key=str(row["storage_key"]),
                destination_key=destination_key,
                content_type=str(row["content_type"]),
                byte_size=int(row["byte_size"]),
            )
        )
    return result


def _verify_destination(storage: StorageClientBase, row: PlateRepairRow) -> None:
    metadata = storage.head_object(row.destination_key)
    if metadata is None:
        raise RuntimeError(f"missing repaired Oracle plate object: {row.destination_key}")
    if metadata.content_type != row.content_type:
        raise RuntimeError(
            "repaired Oracle plate content type mismatch: "
            f"{row.destination_key} expected={row.content_type} actual={metadata.content_type}"
        )
    if metadata.size_bytes != row.byte_size:
        raise RuntimeError(
            "repaired Oracle plate byte size mismatch: "
            f"{row.destination_key} expected={row.byte_size} actual={metadata.size_bytes}"
        )


def repair_oracle_plate_storage_keys(*, dry_run: bool) -> int:
    rows = _load_rows()
    storage = get_storage_client()
    copied = 0
    already_present = 0
    for row in rows:
        if row.source_key == row.destination_key:
            _verify_destination(storage, row)
            already_present += 1
            continue
        source_metadata = storage.head_object(row.source_key)
        if source_metadata is None:
            raise RuntimeError(f"missing source Oracle plate object: {row.source_key}")
        destination_metadata = storage.head_object(row.destination_key)
        if destination_metadata is None:
            if dry_run:
                print(f"would copy {row.source_key} -> {row.destination_key}")
            else:
                storage.copy_object(row.source_key, row.destination_key)
                _verify_destination(storage, row)
            copied += 1
            continue
        _verify_destination(storage, row)
        already_present += 1
    print(
        "oracle plate storage repair complete: "
        f"rows={len(rows)} copied={copied} already_present={already_present} dry_run={dry_run}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return repair_oracle_plate_storage_keys(dry_run=bool(args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
