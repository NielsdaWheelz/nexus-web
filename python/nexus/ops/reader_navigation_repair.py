"""Inspect or apply one fenced reader navigation repair.

python -m nexus.ops.reader_navigation_repair inspect --media-id UUID
python -m nexus.ops.reader_navigation_repair apply --media-id UUID --generation N --inspection-digest SHA256
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.services.reader_navigation_repair import (
    apply_reader_navigation_repair,
    inspect_reader_navigation_repair,
)
from nexus.storage.client import get_storage_client


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.reader_navigation_repair")
    subcommands = parser.add_subparsers(dest="command", required=True)
    inspect = subcommands.add_parser("inspect")
    inspect.add_argument("--media-id", type=UUID, required=True)
    apply = subcommands.add_parser("apply")
    apply.add_argument("--media-id", type=UUID, required=True)
    apply.add_argument("--generation", type=int, required=True)
    apply.add_argument("--inspection-digest", required=True)
    args = parser.parse_args()
    factory = get_session_factory()
    storage = get_storage_client()
    if args.command == "inspect":
        result = asdict(
            inspect_reader_navigation_repair(
                session_factory=factory, storage_client=storage, media_id=args.media_id
            )
        )
    else:
        result = {
            "media_id": str(args.media_id),
            "result": apply_reader_navigation_repair(
                session_factory=factory,
                storage_client=storage,
                media_id=args.media_id,
                expected_generation=args.generation,
                expected_inspection_digest=args.inspection_digest,
            ),
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
