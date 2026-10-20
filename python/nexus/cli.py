"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.services.generation.ledger import generation_history
from nexus.services.gutenberg import sync_project_gutenberg_catalog


def main() -> None:
    parser = argparse.ArgumentParser(prog="nexus")
    subparsers = parser.add_subparsers(dest="command", required=True)
    history_parser = subparsers.add_parser(
        "generation-history", help="inspect one closed generation's audit facts"
    )
    history_parser.add_argument("generation_id", type=UUID)
    subparsers.add_parser(
        "sync-gutenberg-catalog",
        help="download the Project Gutenberg feed and reconcile the mirror",
    )
    cleanup_parser = subparsers.add_parser(
        "cleanup-empty-resources",
        help="preview or atomically apply a bounded empty-resource inventory",
    )
    cleanup_mode = cleanup_parser.add_mutually_exclusive_group(required=True)
    cleanup_mode.add_argument("--preview", action="store_true")
    cleanup_mode.add_argument("--apply", type=Path, metavar="INVENTORY")
    args = parser.parse_args()

    db = get_session_factory()()
    try:
        if args.command == "generation-history":
            db.execute(text("SET TRANSACTION READ ONLY"))
            try:
                record = generation_history(db, args.generation_id)
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
            if record is None:
                raise SystemExit(f"generation not found: {args.generation_id}")
            print(json.dumps(record, default=str, indent=2, sort_keys=True))
        elif args.command == "cleanup-empty-resources":
            from nexus.services import empty_resource_cleanup

            if args.preview:
                result = empty_resource_cleanup.preview(db).model_dump(mode="json")
            else:
                inventory = empty_resource_cleanup.CleanupInventory.model_validate_json(
                    args.apply.read_text()
                )
                result = empty_resource_cleanup.apply(db, inventory)
            print(json.dumps(result, default=str, indent=2, sort_keys=True))
        else:
            print(json.dumps(sync_project_gutenberg_catalog(db), default=str, sort_keys=True))
    except ApiError as exc:
        raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
    finally:
        db.close()
