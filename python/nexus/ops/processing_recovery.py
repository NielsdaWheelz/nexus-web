"""Trusted, exact-fact operator admissions for diagnosed processing repairs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from nexus.db.models import Media, ResourceMutation
from nexus.db.session import get_session_factory
from nexus.services.media_source_ingest import reprocess_retained_epub


def _runtime_sha256() -> str:
    """Fingerprint the on-disk python runtime used by this command."""
    package = Path(__file__).resolve().parents[1]
    digest = hashlib.sha256()
    for path in sorted(package.rglob("*.py")):
        digest.update(str(path.relative_to(package)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.processing_recovery")
    commands = parser.add_subparsers(dest="command", required=True)
    reprocess = commands.add_parser("reprocess-source")
    reprocess.add_argument("media_id", type=UUID)
    reprocess.add_argument("expected_attempt_id", type=UUID)
    reprocess.add_argument("expected_source_sha256")
    reprocess.add_argument("mutation_id")
    args = parser.parse_args()
    with get_session_factory()() as db:
        reprocess_retained_epub(
            db,
            media_id=args.media_id,
            expected_attempt_id=args.expected_attempt_id,
            expected_source_sha256=args.expected_source_sha256,
            mutation_id=args.mutation_id,
            runtime_sha256=_runtime_sha256(),
        )
        result = db.scalar(
            select(ResourceMutation.response_json).where(
                ResourceMutation.user_id
                == select(Media.created_by_user_id)
                .where(Media.id == args.media_id)
                .scalar_subquery(),
                ResourceMutation.mutation_scope == f"operator_reprocess_source:{args.media_id}",
                ResourceMutation.client_mutation_id == args.mutation_id,
            )
        )
        if result is None:
            raise RuntimeError("Committed reprocess receipt is missing")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
