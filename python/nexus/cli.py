"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse
from pathlib import Path
from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.services.vault import export_vault, sync_vault, watch_vault


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

    args = parser.parse_args()
    db = get_session_factory()()
    try:
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
