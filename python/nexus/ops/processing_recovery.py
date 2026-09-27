"""Trusted, exact-fact operator admissions for diagnosed processing repairs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, ResourceMutation
from nexus.db.retries import admit_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode, ConflictError
from nexus.jobs.queue import current_dead_job_for_payload
from nexus.services.content_indexing import request_media_content_reindex
from nexus.services.media_source_ingest import correct_source_type, reprocess_retained_epub
from nexus.services.reader_publication import normalize_stored_web_publication
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.web_article_structure import add_heading_anchors


def normalize_web(
    db: Session,
    *,
    media_id: UUID,
    expected_generation: int,
    expected_index_revision: int,
    mutation_id: str,
) -> dict[str, object]:
    scope = f"operator_normalize_web:{media_id}"
    request_bytes = canonical_json_bytes(
        {
            "expected_generation": expected_generation,
            "expected_index_revision": expected_index_revision,
        }
    )

    def admit() -> dict[str, object]:
        creator_id = db.scalar(select(Media.created_by_user_id).where(Media.id == media_id))
        if creator_id is None:
            raise ConflictError(ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media has no creator identity.")
        replay = lookup_replay(
            db,
            viewer_id=creator_id,
            scope=scope,
            client_mutation_id=mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            db.rollback()
            return replay
        media = db.execute(
            text(
                "SELECT kind, processing_status FROM media WHERE id = :media_id FOR NO KEY UPDATE"
            ),
            {"media_id": media_id},
        ).one_or_none()
        if (
            media is None
            or media.kind != "web_article"
            or media.processing_status != "ready_for_reading"
        ):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Media is not a readable web article."
            )
        revision = db.scalar(
            text("""
            SELECT revision FROM content_index_states
            WHERE owner_kind = 'media' AND owner_id = :media_id FOR UPDATE
        """),
            {"media_id": media_id},
        )
        if revision != expected_index_revision:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Content index revision changed.")
        dead = current_dead_job_for_payload(
            db,
            kind="media_content_reindex_job",
            expected_payload_match={"media_id": str(media_id), "revision": revision},
        )
        if dead is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "No dead current index execution."
            )
        fragments = db.execute(
            text("""
            SELECT idx, html_sanitized FROM fragments
            WHERE media_id = :media_id ORDER BY idx
        """),
            {"media_id": media_id},
        ).all()
        if not any(
            add_heading_anchors(str(row.html_sanitized), fragment_idx=int(row.idx))
            != row.html_sanitized
            for row in fragments
        ):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED, "Headings are already normalized."
            )
        generation = normalize_stored_web_publication(
            db,
            media_id=media_id,
            expected_generation=expected_generation,
            expected_index_revision=expected_index_revision,
        )
        intent = request_media_content_reindex(
            db,
            media_id=media_id,
            reason="operator_heading_normalization",
            request_id=None,
        )
        receipt: dict[str, object] = {
            "media_id": str(media_id),
            "generation": generation,
            "index_revision": intent.revision,
            "job_id": str(intent.background_job_id),
        }
        record_replay(
            db,
            viewer_id=creator_id,
            scope=scope,
            client_mutation_id=mutation_id,
            request_bytes=request_bytes,
            response_json=receipt,
        )
        db.commit()
        return receipt

    return admit_serializable(db, "normalize_web", admit)


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
    correct = commands.add_parser("correct-source-type")
    correct.add_argument("media_id", type=UUID)
    correct.add_argument("expected_attempt_id", type=UUID)
    correct.add_argument("expected_source_type")
    correct.add_argument("mutation_id")
    normalize = commands.add_parser("normalize-web")
    normalize.add_argument("media_id", type=UUID)
    normalize.add_argument("expected_generation", type=int)
    normalize.add_argument("expected_index_revision", type=int)
    normalize.add_argument("mutation_id")
    args = parser.parse_args()
    with get_session_factory()() as db:
        if args.command == "reprocess-source":
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
        elif args.command == "correct-source-type":
            result = correct_source_type(
                db,
                media_id=args.media_id,
                expected_attempt_id=args.expected_attempt_id,
                expected_source_type=args.expected_source_type,
                mutation_id=args.mutation_id,
            ).model_dump(mode="json")
        else:
            result = normalize_web(
                db,
                media_id=args.media_id,
                expected_generation=args.expected_generation,
                expected_index_revision=args.expected_index_revision,
                mutation_id=args.mutation_id,
            )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
