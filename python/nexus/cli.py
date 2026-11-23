"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import text

from nexus.db.engine import bind_database_role
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
    repair_parser = subparsers.add_parser(
        "native-repair", help="reconcile and resume one job held on native execution closure"
    )
    repair_parser.add_argument("job_id", type=UUID)
    subparsers.add_parser("memory-capture-status", help="inspect pending shared-memory capture")
    capture_retry = subparsers.add_parser(
        "memory-capture-retry", help="clear one repaired capture diagnostic"
    )
    capture_retry.add_argument("capture_id", type=UUID)
    capture_retry.add_argument("export_seq", type=int)
    subparsers.add_parser(
        "sync-gutenberg-catalog",
        help="download the Project Gutenberg feed and reconcile the mirror",
    )
    epub = subparsers.add_parser("epub-repair", help="review or apply a retained EPUB projection")
    epub_commands = epub.add_subparsers(dest="action", required=True)
    preview = epub_commands.add_parser("preview")
    preview.add_argument("media_id", type=UUID)
    preview.add_argument("--projection", choices=("navigation", "apparatus"), required=True)
    apply = epub_commands.add_parser("apply")
    apply.add_argument("review_file", type=Path)
    args = parser.parse_args()

    bind_database_role("maintenance")
    if args.command in ("memory-capture-status", "memory-capture-retry"):
        from nexus.services import memory_capture

        try:
            if args.command == "memory-capture-retry":
                memory_capture.retry(args.capture_id, args.export_seq)
            else:
                print(json.dumps(memory_capture.status(), sort_keys=True))
        except ValueError as error:
            raise SystemExit(str(error)) from None
        return
    if args.command == "epub-repair":
        from nexus.services.section_preparation import (
            EpubRepairReview,
            apply_epub_repair,
            preview_epub_repair,
        )

        try:
            if args.action == "preview":
                result = preview_epub_repair(args.media_id, args.projection)
            else:
                review = EpubRepairReview.model_validate_json(args.review_file.read_bytes())
                result = {"status": apply_epub_repair(review)}
        except ApiError as exc:
            raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
        except (OSError, ValueError) as exc:
            raise SystemExit(str(exc)) from exc
        print(json.dumps(result, default=str, ensure_ascii=False, indent=2))
        return
    if args.command == "native-repair":
        from nexus.services.generation.native_execution import repair

        result = repair(args.job_id)
        print(json.dumps(result, sort_keys=True))
        raise SystemExit(1 if result["status"] == "still_held" else 0)
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
        else:
            print(json.dumps(sync_project_gutenberg_catalog(db), default=str, sort_keys=True))
    except ApiError as exc:
        raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
    finally:
        db.close()
