"""Nexus command-line entrypoints."""

from __future__ import annotations

import argparse

from nexus.db.session import get_session_factory
from nexus.errors import ApiError
from nexus.services.browser_capture_conversion import convert_browser_article_captures
from nexus.storage.client import get_storage_client


def main() -> None:
    parser = argparse.ArgumentParser(prog="nexus")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "convert-browser-article-captures",
        help="one-shot: store pre-cutover browser article captures as verified packets",
    )
    parser.parse_args()

    db = get_session_factory()()
    try:
        convert_browser_article_captures(db, storage_client=get_storage_client())
    except ApiError as exc:
        raise SystemExit(f"{exc.code.value}: {exc.message}") from exc
    finally:
        db.close()
