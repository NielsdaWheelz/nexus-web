"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse
import json
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.services.browser_capture_conversion import (
    convert_browser_article_captures,
    unwrap_article_packet_presence,
)
from nexus.services.generation.ledger import generation_history
from nexus.services.gutenberg import sync_project_gutenberg_catalog
from nexus.storage.client import get_storage_client


def main() -> None:
    parser = argparse.ArgumentParser(prog="nexus")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "convert-browser-article-captures",
        help="one-shot: store every browser article capture as a verified current-form packet",
    )
    history_parser = subparsers.add_parser(
        "generation-history", help="inspect one closed generation's audit facts"
    )
    history_parser.add_argument("generation_id", type=UUID)
    subparsers.add_parser(
        "sync-gutenberg-catalog",
        help="download the Project Gutenberg feed and reconcile the mirror",
    )
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
        elif args.command == "sync-gutenberg-catalog":
            print(json.dumps(sync_project_gutenberg_catalog(db), default=str, sort_keys=True))
        else:
            convert_browser_article_captures(db, storage_client=get_storage_client())
            unwrap_article_packet_presence(db, storage_client=get_storage_client())
    except ApiError as exc:
        raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
    finally:
        db.close()
