"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path
from uuid import UUID

from sqlalchemy import text

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.services.browser_capture_conversion import convert_browser_article_captures
from nexus.services.llm_ledger import read_terminal_generation_history
from nexus.services.vault import export_vault, sync_vault, watch_vault
from nexus.storage.client import get_storage_client


def main() -> None:
    parser = argparse.ArgumentParser(prog="nexus")
    subparsers = parser.add_subparsers(dest="command", required=True)

    vault_parser = subparsers.add_parser("vault")
    vault_subparsers = vault_parser.add_subparsers(dest="vault_command", required=True)

    export_parser = vault_subparsers.add_parser("export")
    export_parser.add_argument("path")
    export_parser.add_argument("--user", required=True)

    sync_parser = vault_subparsers.add_parser("sync")
    sync_parser.add_argument("path")
    sync_parser.add_argument("--user", required=True)

    watch_parser = vault_subparsers.add_parser("watch")
    watch_parser.add_argument("path")
    watch_parser.add_argument("--user", required=True)
    watch_parser.add_argument("--interval", type=float, default=2.0)

    subparsers.add_parser(
        "convert-browser-article-captures",
        help="one-shot: store pre-cutover browser article captures as verified packets",
    )
    history_parser = subparsers.add_parser(
        "generation-history", help="inspect one terminal generation's sealed audit facts"
    )
    history_parser.add_argument("generation_id", type=UUID)

    args = parser.parse_args()
    db = get_session_factory()()
    try:
        if args.command == "generation-history":
            db.execute(text("SET TRANSACTION READ ONLY"))
            try:
                record = read_terminal_generation_history(db, generation_id=args.generation_id)
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
            if record is None:
                raise SystemExit(f"generation not found: {args.generation_id}")
            print(json.dumps(asdict(record), default=str, indent=2, sort_keys=True))
            return
        if args.command == "convert-browser-article-captures":
            convert_browser_article_captures(db, storage_client=get_storage_client())
            return
        viewer_id = UUID(args.user)
        vault_dir = Path(args.path).expanduser().resolve()
        if args.vault_command == "export":
            export_vault(db, viewer_id, vault_dir)
        elif args.vault_command == "sync":
            sync_vault(db, viewer_id, vault_dir)
        elif args.vault_command == "watch":
            watch_vault(db, viewer_id, vault_dir, interval_seconds=args.interval)
        else:
            raise SystemExit(f"unknown vault command: {args.vault_command}")
    except ApiError as exc:
        raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
    finally:
        db.close()
