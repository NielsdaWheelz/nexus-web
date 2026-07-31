#!/usr/bin/env python
"""Seed and clean the disposable real-stack Canonical Find journey."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from html import escape
from uuid import UUID, uuid4

from sqlalchemy import text

from nexus.db.models import (
    ArtifactBuild,
    ArtifactRevision,
    Fragment,
    Media,
    ProcessingStatus,
    SynthesisArtifact,
)
from nexus.db.retries import retry_serializable
from nexus.db.session import create_session_factory
from nexus.jobs.worker import JobWorker
from nexus.services import library_entries, media_intelligence, reader_apparatus
from nexus.services.artifacts import engine as artifact_engine
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption_service
from nexus.services.content_indexing import (
    IndexOwner,
    delete_content_index,
    request_media_content_reindex,
)
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.resource_graph.citations import record_citation
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import publish_source_transcript

WEB_QUERY = "web return beacon"
TRANSCRIPT_QUERY = "orchid lattice"
TRANSCRIPT_ZERO_QUERY = "complete ocean"
ARTIFACT_QUERY = "artifact return beacon"


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def web_fragment(
    *,
    prefix: str,
    count: int,
    query_ordinals: frozenset[int],
) -> tuple[str, str]:
    lines = [
        (
            f"{prefix} paragraph {ordinal:03d} contains {WEB_QUERY}."
            if ordinal in query_ordinals
            else f"{prefix} paragraph {ordinal:03d} is deterministic reading filler."
        )
        for ordinal in range(1, count + 1)
    ]
    return (
        "\n".join(lines),
        "".join(f"<p>{escape(line)}</p>" for line in lines),
    )


def request_and_drain_web_reindex(session_factory, *, media_id: UUID) -> None:
    with session_factory() as db:

        def request() -> None:
            request_media_content_reindex(
                db,
                media_id=media_id,
                reason="source_success",
                request_id="canonical-find-e2e-seed",
            )
            db.commit()

        retry_serializable(db, "canonical_find_e2e_media_reindex", request)

    worker = JobWorker(
        session_factory=session_factory,
        worker_id="canonical-find-e2e-seed",
        allowed_kinds=("media_content_reindex_job",),
    )
    while worker.run_once():
        pass


def seed() -> dict[str, str]:
    owner_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    session_factory = create_session_factory()
    now = datetime.now(UTC)
    web_media_id = uuid4()
    transcript_media_id = uuid4()
    artifact_id = uuid4()
    build_id = uuid4()
    revision_id = uuid4()

    first_text, first_html = web_fragment(
        prefix="Find journey opening",
        count=48,
        query_ordinals=frozenset({42}),
    )
    second_text, second_html = web_fragment(
        prefix="Find journey continuation",
        count=52,
        query_ordinals=frozenset({7, 47}),
    )
    transcript_segments = normalize_transcript_segments(
        [
            {
                "text": (
                    f"The {TRANSCRIPT_QUERY} appears here, and another "
                    f"{TRANSCRIPT_QUERY} remains available."
                ),
                "speaker_label": "Host",
                "t_start_ms": 4_000,
                "t_end_ms": 9_000,
            },
            {
                "text": (f"A later {TRANSCRIPT_QUERY} confirms only partial coverage."),
                "speaker_label": "Guest",
                "t_start_ms": 12_000,
                "t_end_ms": 18_000,
            },
        ]
    )
    if len(transcript_segments) != 2:
        raise RuntimeError("Canonical Find transcript fixture did not normalize")

    artifact_filler = "".join(
        f"<p>Artifact reading filler paragraph {ordinal:03d}.</p>"
        for ordinal in range(1, 46)
    )
    artifact_html = (
        '<article><section id="orientation">'
        "<h2>Artifact orientation</h2>"
        f"{artifact_filler}"
        '</section><section id="target">'
        "<h2>Artifact target section</h2>"
        f"<p>The first {ARTIFACT_QUERY} is a deterministic match.</p>"
        f"<p>The second {ARTIFACT_QUERY} verifies stepping and Return"
        '<button type="button" class="dossier-citation" '
        'data-nexus-citation="1" aria-label="Open citation 1">'
        "<sup>1</sup></button>.</p>"
        "</section></article>"
    )
    artifact_text = "\n".join(
        [
            "Artifact orientation",
            *[
                f"Artifact reading filler paragraph {ordinal:03d}."
                for ordinal in range(1, 46)
            ],
            "Artifact target section",
            f"The first {ARTIFACT_QUERY} is a deterministic match.",
            f"The second {ARTIFACT_QUERY} verifies stepping and Return .",
        ]
    )

    with session_factory() as db:
        default_library_id = ensure_user_and_default_library(db, owner_id)
        db.add_all(
            [
                Media(
                    id=web_media_id,
                    kind="web_article",
                    title="E2E Canonical Find web article",
                    canonical_source_url="https://example.invalid/e2e-canonical-find-web",
                    canonical_url="https://example.invalid/e2e-canonical-find-web",
                    created_by_user_id=owner_id,
                    processing_status=ProcessingStatus.ready_for_reading,
                    processing_started_at=now,
                    processing_completed_at=now,
                ),
                Media(
                    id=transcript_media_id,
                    kind="video",
                    title="E2E Canonical Find partial transcript",
                    canonical_source_url=(
                        "https://www.youtube.com/watch?v=findE2E0001"
                    ),
                    canonical_url="https://www.youtube.com/watch?v=findE2E0001",
                    external_playback_url=(
                        "https://www.youtube.com/watch?v=findE2E0001"
                    ),
                    provider="youtube",
                    provider_id="findE2E0001",
                    created_by_user_id=owner_id,
                    processing_status=ProcessingStatus.ready_for_reading,
                    processing_started_at=now,
                    processing_completed_at=now,
                ),
            ]
        )
        db.flush()
        db.add_all(
            [
                Fragment(
                    media_id=web_media_id,
                    idx=0,
                    canonical_text=first_text,
                    html_sanitized=first_html,
                ),
                Fragment(
                    media_id=web_media_id,
                    idx=1,
                    canonical_text=second_text,
                    html_sanitized=second_html,
                ),
            ]
        )
        reader_apparatus.replace_media_apparatus(
            db,
            media_id=web_media_id,
            media_kind="web_article",
            source_fingerprint_value=reader_apparatus.source_fingerprint(
                "canonical-find-e2e",
                web_media_id,
            ),
            status="empty",
        )
        library_entries.ensure_entry(
            db,
            default_library_id,
            library_entries.media_target(web_media_id),
        )
        library_entries.ensure_entry(
            db,
            default_library_id,
            library_entries.media_target(transcript_media_id),
        )
        publish_source_transcript(
            db,
            media_id=transcript_media_id,
            request_reason="episode_open",
            transcript_origin="Imported",
            transcript_coverage="partial",
            transcript_segments=transcript_segments,
            now=now,
        )
        db.flush()

        artifact = SynthesisArtifact(
            id=artifact_id,
            subject_scheme="media",
            subject_id=web_media_id,
            audience_scheme="user",
            audience_id=str(owner_id),
        )
        db.add(artifact)
        db.flush()
        build = ArtifactBuild(
            id=build_id,
            artifact_id=artifact_id,
            requester_user_id=owner_id,
            instruction="Canonical Find acceptance fixture",
            idempotency_key=f"e2e-canonical-find-{build_id}",
        )
        db.add(build)
        db.flush()
        revision = ArtifactRevision(
            id=revision_id,
            build_id=build_id,
            content_html=artifact_html,
            content_text=artifact_text,
            input_manifest={
                "version": "v1",
                "kind": "media",
                "media_ref": f"media:{web_media_id}",
                "content_fingerprint": (
                    media_intelligence.current_content_fingerprint(
                        db,
                        media_id=web_media_id,
                    )
                ),
                "offered_claim_count": 0,
                "omitted_evidence": [],
            },
            citation_owner_user_id=owner_id,
            creator_user_id=owner_id,
            promoted_at=now,
        )
        db.add(revision)
        db.flush()
        record_citation(
            db,
            viewer_id=owner_id,
            source=ResourceRef(scheme="artifact_revision", id=revision_id),
            target=ResourceRef(scheme="media", id=transcript_media_id),
            ordinal=1,
            kind="supports",
            snapshot=CitationSnapshot(
                title="E2E Canonical Find partial transcript",
                excerpt="Deterministic evidence for the Canonical Find journey.",
                result_type="media",
                deep_link=f"/media/{transcript_media_id}",
            ),
        )
        artifact.current_revision_id = revision_id
        db.commit()

    request_and_drain_web_reindex(session_factory, media_id=web_media_id)

    return {
        "web_media_id": str(web_media_id),
        "transcript_media_id": str(transcript_media_id),
        "artifact_ref": f"artifact:{artifact_id}",
        "revision_ref": f"artifact_revision:{revision_id}",
        "web_query": WEB_QUERY,
        "transcript_query": TRANSCRIPT_QUERY,
        "transcript_zero_query": TRANSCRIPT_ZERO_QUERY,
        "artifact_query": ARTIFACT_QUERY,
    }


def cleanup(fixture: dict[str, str]) -> None:
    owner_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    web_media_id = UUID(fixture["web_media_id"])
    transcript_media_id = UUID(fixture["transcript_media_id"])
    session_factory = create_session_factory()

    with session_factory() as db:
        default_library_id = db.execute(
            text(
                "SELECT id FROM libraries WHERE owner_user_id = :owner_id AND is_default = true"
            ),
            {"owner_id": owner_id},
        ).scalar_one()
        for media_id in (web_media_id, transcript_media_id):
            library_entries.delete_entry(
                db,
                default_library_id,
                library_entries.media_target(media_id),
            )
        library_entries.normalize_positions(db, default_library_id)

        storage_paths = delete_document_media_if_unreferenced(db, web_media_id)
        if storage_paths is None:
            raise RuntimeError("Canonical Find Web fixture was not deleted")

        fragment_ids = db.execute(
            text("SELECT id FROM fragments WHERE media_id = :media_id"),
            {"media_id": transcript_media_id},
        ).scalars()
        for fragment_id in fragment_ids:
            delete_edges_for_deleted_resource(
                db,
                ref=ResourceRef(scheme="fragment", id=fragment_id),
            )
        delete_edges_for_deleted_resource(
            db,
            ref=ResourceRef(scheme="media", id=transcript_media_id),
        )
        artifact_engine.on_subject_deleted(
            db,
            ResourceRef(scheme="media", id=transcript_media_id),
        )
        delete_content_index(
            db,
            owner=IndexOwner("media", transcript_media_id),
        )
        consumption_service.delete_media_consumption_state_in_txn(
            db,
            media_id=transcript_media_id,
        )
        db.execute(
            text(
                "DELETE FROM fragment_blocks WHERE fragment_id IN "
                "(SELECT id FROM fragments WHERE media_id = :media_id)"
            ),
            {"media_id": transcript_media_id},
        )
        db.execute(
            text("DELETE FROM media_transcript_states WHERE media_id = :media_id"),
            {"media_id": transcript_media_id},
        )
        db.execute(
            text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
            {"media_id": transcript_media_id},
        )
        db.execute(
            text("DELETE FROM user_media_deletions WHERE media_id = :media_id"),
            {"media_id": transcript_media_id},
        )
        db.execute(
            text("DELETE FROM fragments WHERE media_id = :media_id"),
            {"media_id": transcript_media_id},
        )
        deleted_id = db.execute(
            text("DELETE FROM media WHERE id = :media_id RETURNING id"),
            {"media_id": transcript_media_id},
        ).scalar_one_or_none()
        if deleted_id != transcript_media_id:
            raise RuntimeError("Canonical Find transcript fixture was not deleted")
        db.commit()


def main() -> None:
    mode = require_env("NEXUS_E2E_CANONICAL_FIND_MODE")
    if mode == "seed":
        print(json.dumps(seed(), sort_keys=True))
        return
    if mode == "cleanup":
        fixture = json.loads(require_env("NEXUS_E2E_CANONICAL_FIND_FIXTURE"))
        cleanup(fixture)
        print(json.dumps({"cleaned": True}))
        return
    raise RuntimeError(f"Unknown mode: {mode}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
